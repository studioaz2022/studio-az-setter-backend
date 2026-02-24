// squareTransactionSync.js
// Pulls a barber's Square payments and attempts to match them to GHL contacts.
// Matching strategy: email/phone lookup → appointment proximity → manual review.
// Unmatched payments are returned for the barber to manually review in the app.

const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const { getBarberToken } = require("./squareOAuth");
const { lookupContactIdByEmailOrPhone, getContact } = require("../clients/ghlClient");
const { fetchAppointmentsForDateRange } = require("../clients/ghlCalendarClient");
const { ghlBarber } = require("../clients/ghlMultiLocationSdk");
const { lookupServicePrice, lookupDepositPercentage } = require("../config/barberServicePrices");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const IS_PROD = process.env.SQUARE_ENVIRONMENT === "production";
const SQUARE_BASE_URL = IS_PROD
  ? "https://connect.squareup.com"
  : "https://connect.squareupsandbox.com";

const BARBER_LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID;

/**
 * Sync a barber's Square payments into our transactions table.
 *
 * @param {string} barberGhlId   - The barber's GHL user ID
 * @param {object} options
 * @param {string} [options.startDate]  - ISO date string (default: 30 days ago)
 * @param {string} [options.endDate]    - ISO date string (default: now)
 * @param {boolean} [options.incremental] - Use stored cursor for incremental sync
 *
 * @returns {{ synced: number, matched: number, autoMatched: AutoMatchDetail[], unmatched: PaymentSummary[] }}
 */
async function syncBarberTransactions(barberGhlId, options = {}) {
  const tokenRow = await getBarberToken(barberGhlId);
  if (!tokenRow) {
    throw new Error(`No Square account connected for barber ${barberGhlId}`);
  }

  const { access_token, square_location_id, last_sync_cursor } = tokenRow;

  // Default to last 30 days if no date range provided
  const endDate = options.endDate
    ? new Date(options.endDate)
    : new Date();
  const startDate = options.startDate
    ? new Date(options.startDate)
    : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

  console.log(`[SquareSync] Syncing barber ${barberGhlId} from ${startDate.toISOString()} to ${endDate.toISOString()}`);

  // Fetch payments from Square
  const payments = await fetchSquarePayments(access_token, square_location_id, {
    startDate,
    endDate,
    cursor: options.incremental ? last_sync_cursor : null,
  });

  if (!payments.length) {
    console.log(`[SquareSync] No payments found for barber ${barberGhlId}`);
    await updateLastSynced(barberGhlId, null);
    return { synced: 0, matched: 0, autoMatched: [], unmatched: [] };
  }

  console.log(`[SquareSync] Found ${payments.length} payments for barber ${barberGhlId}`);

  // Pre-fetch GHL appointments for the date range (for proximity matching)
  let appointmentsForRange = [];
  try {
    if (ghlBarber) {
      appointmentsForRange = await fetchAppointmentsForDateRange({
        locationId: BARBER_LOCATION_ID,
        startTime: startDate.toISOString(),
        endTime: endDate.toISOString(),
        userId: barberGhlId,
        sdkInstance: ghlBarber,
      });
      // Filter to active appointments only (confirmed, showed, or new)
      appointmentsForRange = appointmentsForRange.filter(
        (apt) => ["confirmed", "showed", "new"].includes(apt.appointmentStatus)
      );
      console.log(`[SquareSync] Pre-fetched ${appointmentsForRange.length} active appointments for proximity matching`);
    } else {
      console.warn("[SquareSync] ghlBarber SDK not available — skipping appointment proximity matching");
    }
  } catch (err) {
    console.warn(`[SquareSync] Failed to fetch appointments for proximity matching: ${err.message}`);
    // Continue without appointment matching — graceful degradation
  }

  // Attempt to match each payment to a GHL contact
  const results = await Promise.all(
    payments.map((p) => matchAndRecordPayment(p, barberGhlId, access_token, appointmentsForRange))
  );

  const synced = results.length;
  const matched = results.filter((r) => r.matched).length;
  const autoMatched = results
    .filter((r) => r.matched && r.autoMatchDetail)
    .map((r) => r.autoMatchDetail);
  const unmatched = results.filter((r) => !r.matched).map((r) => r.payment);

  // Update last_synced_at on the token row
  await updateLastSynced(barberGhlId, null);

  console.log(`[SquareSync] Barber ${barberGhlId}: ${matched} matched (${autoMatched.length} with details), ${unmatched.length} unmatched of ${synced} total`);

  return { synced, matched, autoMatched, unmatched };
}

/**
 * Fetch payments from Square /v2/payments with pagination.
 */
async function fetchSquarePayments(accessToken, locationId, { startDate, endDate, cursor }) {
  const payments = [];
  let nextCursor = cursor || null;

  do {
    const params = {
      location_id: locationId,
      begin_time: startDate.toISOString(),
      end_time: endDate.toISOString(),
      sort_order: "DESC",
      limit: 100,
    };
    if (nextCursor) params.cursor = nextCursor;

    const res = await axios.get(`${SQUARE_BASE_URL}/v2/payments`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params,
    });

    const page = res.data?.payments || [];
    payments.push(...page);
    nextCursor = res.data?.cursor || null;

    // Safety cap at 500 payments per sync to avoid runaway requests
    if (payments.length >= 500) break;
  } while (nextCursor);

  // Only include completed payments (not failed, cancelled, etc.)
  return payments.filter((p) => p.status === "COMPLETED");
}

/**
 * Attempt to match a Square payment to a GHL contact, then record the transaction.
 *
 * Matching strategy (in order):
 *   1. Square customer email → GHL contact lookup
 *   2. Square customer phone → GHL contact lookup
 *   3. Appointment proximity — payment falls between apt start and apt end + 30min
 *   4. No match → return as unmatched for manual review
 */
async function matchAndRecordPayment(squarePayment, barberGhlId, accessToken, appointments = []) {
  const paymentId = squarePayment.id;
  const amountCents = squarePayment.amount_money?.amount || 0;
  const currency = squarePayment.amount_money?.currency || "USD";
  const createdAt = squarePayment.created_at;

  // Check if we've already recorded this payment to avoid duplicates
  const { data: existing } = await supabase
    .from("transactions")
    .select("id")
    .eq("square_payment_id", paymentId)
    .single();

  if (existing) {
    return { matched: true, payment: null, autoMatchDetail: null }; // Already synced
  }

  // Build a normalized payment summary for unmatched queue
  const paymentSummary = {
    squarePaymentId: paymentId,
    squareOrderId: squarePayment.order_id || null,
    amountCents,
    currency,
    createdAt,
    cardBrand: squarePayment.card_details?.card?.card_brand || null,
    last4: squarePayment.card_details?.card?.last_4 || null,
    customerEmail: squarePayment.buyer_email_address || null,
    customerPhone: null, // Square doesn't expose phone on payment; comes from customer lookup
    note: squarePayment.note || null,
    squareTipCents: squarePayment.tip_money?.amount || null,
  };

  // Try to match via buyer email
  let contactId = null;
  let matchMethod = null;
  if (squarePayment.buyer_email_address) {
    contactId = await lookupGhlContactByEmail(squarePayment.buyer_email_address);
    if (contactId) matchMethod = "email";
  }

  // Try customer record if available and no email match yet
  if (!contactId && squarePayment.customer_id) {
    const customerDetails = await fetchSquareCustomer(
      accessToken,
      squarePayment.customer_id,
      barberGhlId
    );
    if (customerDetails?.email_address) {
      paymentSummary.customerEmail = customerDetails.email_address;
      contactId = await lookupGhlContactByEmail(customerDetails.email_address);
      if (contactId) matchMethod = "email";
    }
    if (!contactId && customerDetails?.phone_number) {
      paymentSummary.customerPhone = customerDetails.phone_number;
      contactId = await lookupGhlContactByPhone(customerDetails.phone_number);
      if (contactId) matchMethod = "phone";
    }
  }

  // Appointment proximity matching (if email/phone failed)
  let matchedAppointment = null;
  if (!contactId && appointments.length > 0) {
    const paymentTime = new Date(createdAt);
    const THIRTY_MIN_MS = 30 * 60 * 1000;

    const proximityMatches = appointments.filter((apt) => {
      const aptStart = new Date(apt.startTime);
      const aptEnd = new Date(apt.endTime);
      // Payment must fall between appointment start and 30min after end
      return paymentTime >= aptStart && paymentTime <= new Date(aptEnd.getTime() + THIRTY_MIN_MS);
    });

    if (proximityMatches.length === 1 && proximityMatches[0].contactId) {
      matchedAppointment = proximityMatches[0];
      contactId = matchedAppointment.contactId;
      matchMethod = "appointment_proximity";
      console.log(`[SquareSync] Proximity match: payment ${paymentId} → appointment ${matchedAppointment.id} (contact ${contactId})`);
    } else if (proximityMatches.length > 1) {
      console.log(`[SquareSync] Ambiguous proximity: payment ${paymentId} matched ${proximityMatches.length} appointments — skipping auto-match`);
    }
  }

  if (!contactId) {
    // No match — return for manual review
    return { matched: false, payment: paymentSummary, autoMatchDetail: null };
  }

  // Fetch Order discount info if the payment has an order_id
  const { totalDiscountCents, discountName } = await fetchSquareOrderDiscount(
    accessToken,
    squarePayment.order_id
  );

  // Record as a transaction in Supabase
  await recordTransaction({
    contactId,
    barberGhlId,
    squarePayment,
    amountCents,
    createdAt,
    appointmentId: matchedAppointment?.id || null,
    calendarId: matchedAppointment?.calendarId || null,
    squareTipCents: squarePayment.tip_money?.amount || null,
    discountCents: totalDiscountCents,
  });

  // Build auto-match detail for the response
  let contactName = "";
  try {
    const contact = await getContact(contactId);
    contactName = contact?.contactName || contact?.name || `${contact?.firstName || ""} ${contact?.lastName || ""}`.trim();
  } catch { /* ignore — name is nice-to-have */ }

  const autoMatchDetail = {
    squarePaymentId: paymentId,
    contactId,
    contactName,
    appointmentId: matchedAppointment?.id || null,
    appointmentTitle: matchedAppointment?.title || null,
    appointmentStartTime: matchedAppointment?.startTime || null,
    calendarId: matchedAppointment?.calendarId || null,
    amountCents,
    createdAt,
    matchMethod,
    squareTipCents: squarePayment.tip_money?.amount || null,
  };

  return { matched: true, payment: null, autoMatchDetail };
}

/**
 * Look up a GHL contact by email via the existing GHL client.
 * Returns contactId string or null.
 */
async function lookupGhlContactByEmail(email) {
  try {
    return await lookupContactIdByEmailOrPhone({ email, locationId: BARBER_LOCATION_ID });
  } catch {
    return null;
  }
}

/**
 * Look up a GHL contact by phone number.
 */
async function lookupGhlContactByPhone(phone) {
  try {
    return await lookupContactIdByEmailOrPhone({ phone, locationId: BARBER_LOCATION_ID });
  } catch {
    return null;
  }
}

/**
 * Fetch a Square Order to get discount details.
 * @param {string} accessToken - The barber's Square access token
 * @param {string} orderId - The Square order ID from the payment
 * @returns {{ totalDiscountCents: number|null, discountName: string|null }}
 */
async function fetchSquareOrderDiscount(accessToken, orderId) {
  if (!orderId || !accessToken) return { totalDiscountCents: null, discountName: null };
  try {
    const res = await axios.get(`${SQUARE_BASE_URL}/v2/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const order = res.data?.order;
    if (!order) return { totalDiscountCents: null, discountName: null };

    const totalDiscountCents = order.total_discount_money?.amount || null;
    // Get the first discount name for display (e.g., "$10 Off")
    const discountName = order.discounts?.[0]?.name || null;

    if (totalDiscountCents) {
      console.log(`[SquareSync] Order ${orderId}: discount ${discountName || "unnamed"} = $${totalDiscountCents / 100}`);
    }
    return { totalDiscountCents, discountName };
  } catch (err) {
    console.warn(`[SquareSync] Failed to fetch order ${orderId}: ${err.message}`);
    return { totalDiscountCents: null, discountName: null };
  }
}

/**
 * Fetch a Square customer record to get email/phone for matching.
 * Requires the barber's access token.
 */
async function fetchSquareCustomer(accessToken, customerId, barberGhlId) {
  if (!customerId) return null;
  try {
    // Re-fetch access token if not passed
    if (!accessToken) {
      const tokenRow = await getBarberToken(barberGhlId);
      accessToken = tokenRow?.access_token;
    }
    if (!accessToken) return null;

    const res = await axios.get(`${SQUARE_BASE_URL}/v2/customers/${customerId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.data?.customer || null;
  } catch {
    return null;
  }
}

/**
 * Insert a matched transaction into the transactions table.
 * Barbers at the barbershop are 100% artist (no shop commission split).
 * If calendarId is provided, looks up service price, calculates tip,
 * and detects whether the payment is a deposit or remaining balance.
 *
 * Deposit detection (for calendars with deposit_percentage):
 *   - amount_money ≈ service_price × deposit% AND no tip → 'deposit'
 *   - otherwise → 'session_payment' (remaining balance or full payment)
 */
async function recordTransaction({ contactId, barberGhlId, squarePayment, amountCents, createdAt, appointmentId, calendarId, squareTipCents, discountCents }) {
  const grossAmount = amountCents / 100;
  const discountAmount = discountCents ? discountCents / 100 : null;

  // Look up deposit config for this calendar
  const depositPct = calendarId ? await lookupDepositPercentage(calendarId) : null;
  const listedPrice = calendarId ? await lookupServicePrice(calendarId) : null;

  // Determine transaction type: deposit vs session_payment
  let transactionType = "session_payment";
  if (depositPct && listedPrice) {
    const expectedDeposit = listedPrice * (depositPct / 100);
    const hasTip = squareTipCents != null && squareTipCents > 0;
    // Deposit = exact deposit amount with no tip (allow $1 tolerance for rounding)
    if (!hasTip && Math.abs(grossAmount - expectedDeposit) <= 1) {
      transactionType = "deposit";
      console.log(`[SquareSync] Deposit detected: $${grossAmount} matches ${depositPct}% of $${listedPrice} for calendar ${calendarId}`);
    }
  }

  // Tip & service price calculation
  let servicePrice = null;
  let tipAmount = null;

  if (transactionType === "deposit") {
    // Deposits are pure service revenue, no tip
    servicePrice = grossAmount;
    tipAmount = 0;
  } else if (squareTipCents != null && squareTipCents > 0) {
    // Square reported an explicit tip — amount_money is already after discounts
    tipAmount = squareTipCents / 100;
    servicePrice = grossAmount - tipAmount;
    if (servicePrice < 0) { servicePrice = 0; tipAmount = grossAmount; }
  } else if (calendarId) {
    // Fall back to service price lookup
    servicePrice = await lookupServicePrice(calendarId);
    if (servicePrice != null) {
      tipAmount = Math.max(0, grossAmount - servicePrice);
      if (grossAmount < servicePrice) {
        servicePrice = grossAmount;
        tipAmount = 0;
      }
    }
  }

  // Build notes with discount info if present
  let notes = squarePayment.note || null;
  if (discountAmount && transactionType !== "deposit") {
    const discountNote = `Square discount: -$${discountAmount.toFixed(2)}`;
    notes = notes ? `${notes} | ${discountNote}` : discountNote;
  }

  const { error } = await supabase.from("transactions").insert({
    contact_id: contactId,
    contact_name: "", // Enriched on display from GHL contact
    appointment_id: appointmentId || null,
    artist_ghl_id: barberGhlId,
    transaction_type: transactionType,
    payment_method: "square",
    payment_recipient: "artist_direct", // Booth renters keep all their money
    gross_amount: grossAmount,
    shop_percentage: 0,
    artist_percentage: 100,
    shop_amount: 0,
    artist_amount: grossAmount,
    settlement_status: "settled", // Already paid directly to barber
    square_payment_id: squarePayment.id,
    square_order_id: squarePayment.order_id || null,
    session_date: createdAt,
    location_id: BARBER_LOCATION_ID,
    notes,
    calendar_id: calendarId || null,
    service_price: servicePrice,
    tip_amount: tipAmount,
    discount_amount: discountAmount,
  });

  if (error) {
    console.error(`[SquareSync] Failed to record transaction ${squarePayment.id}: code=${error.code} msg=${error.message} details=${error.details} hint=${error.hint}`);
    throw new Error(`Supabase insert failed: ${error.message} (${error.code})`);
  }
}

/**
 * Update the last_synced_at timestamp on the barber's token row.
 */
async function updateLastSynced(barberGhlId, cursor) {
  const update = { last_synced_at: new Date().toISOString() };
  if (cursor) update.last_sync_cursor = cursor;

  await supabase
    .from("barber_square_tokens")
    .update(update)
    .eq("barber_ghl_id", barberGhlId);
}

/**
 * Manually assign an unmatched payment to a contact (called from iOS review UI).
 */
async function assignUnmatchedPayment({ barberGhlId, squarePaymentId, contactId, amountCents, createdAt, note, appointmentId, calendarId, squareTipCents }) {
  // Check not already recorded
  const { data: existing } = await supabase
    .from("transactions")
    .select("id")
    .eq("square_payment_id", squarePaymentId)
    .single();

  if (existing) return { alreadyRecorded: true };

  const grossAmount = amountCents / 100;

  // Deposit detection for calendars with deposit_percentage
  const depositPct = calendarId ? await lookupDepositPercentage(calendarId) : null;
  const listedPrice = calendarId ? await lookupServicePrice(calendarId) : null;

  let transactionType = "session_payment";
  if (depositPct && listedPrice) {
    const expectedDeposit = listedPrice * (depositPct / 100);
    const hasTip = squareTipCents != null && squareTipCents > 0;
    if (!hasTip && Math.abs(grossAmount - expectedDeposit) <= 1) {
      transactionType = "deposit";
    }
  }

  // Tip calculation
  let servicePrice = null;
  let tipAmount = null;

  if (transactionType === "deposit") {
    servicePrice = grossAmount;
    tipAmount = 0;
  } else if (squareTipCents != null && squareTipCents > 0) {
    tipAmount = squareTipCents / 100;
    servicePrice = grossAmount - tipAmount;
    if (servicePrice < 0) { servicePrice = 0; tipAmount = grossAmount; }
  } else if (calendarId) {
    servicePrice = await lookupServicePrice(calendarId);
    if (servicePrice != null) {
      tipAmount = Math.max(0, grossAmount - servicePrice);
      if (grossAmount < servicePrice) {
        servicePrice = grossAmount;
        tipAmount = 0;
      }
    }
  }

  const { error } = await supabase.from("transactions").insert({
    contact_id: contactId,
    contact_name: "",
    appointment_id: appointmentId || null,
    artist_ghl_id: barberGhlId,
    transaction_type: transactionType,
    payment_method: "square",
    payment_recipient: "artist_direct",
    gross_amount: grossAmount,
    shop_percentage: 0,
    artist_percentage: 100,
    shop_amount: 0,
    artist_amount: grossAmount,
    settlement_status: "settled",
    square_payment_id: squarePaymentId,
    session_date: createdAt,
    location_id: BARBER_LOCATION_ID,
    notes: note || null,
    calendar_id: calendarId || null,
    service_price: servicePrice,
    tip_amount: tipAmount,
  });

  if (error) throw new Error(`Failed to record assigned payment: ${error.message}`);
  return { recorded: true };
}

/**
 * Reverse an auto-matched transaction.
 * Deletes the transaction record from Supabase by squarePaymentId.
 * Called when a user "unmatches" an auto-matched payment in the review UI.
 */
async function unmatchPayment({ barberGhlId, squarePaymentId }) {
  const { data, error } = await supabase
    .from("transactions")
    .delete()
    .eq("square_payment_id", squarePaymentId)
    .eq("artist_ghl_id", barberGhlId)
    .select("id");

  if (error) throw new Error(`Failed to unmatch payment: ${error.message}`);

  return { deleted: (data?.length || 0) > 0 };
}

/**
 * Record a payment as a walk-in (no GHL contact or appointment).
 * The payment still counts toward earnings.
 */
async function recordWalkIn({ barberGhlId, squarePaymentId, amountCents, createdAt }) {
  // Check not already recorded
  const { data: existing } = await supabase
    .from("transactions")
    .select("id")
    .eq("square_payment_id", squarePaymentId)
    .single();

  if (existing) return { alreadyRecorded: true };

  const grossAmount = amountCents / 100;

  const { error } = await supabase.from("transactions").insert({
    contact_id: "walk_in",
    contact_name: "Walk-in",
    appointment_id: null,
    artist_ghl_id: barberGhlId,
    transaction_type: "session_payment",
    payment_method: "square",
    payment_recipient: "artist_direct",
    gross_amount: grossAmount,
    shop_percentage: 0,
    artist_percentage: 100,
    shop_amount: 0,
    artist_amount: grossAmount,
    settlement_status: "settled",
    square_payment_id: squarePaymentId,
    session_date: createdAt,
    location_id: BARBER_LOCATION_ID,
    notes: "Walk-in customer",
  });

  if (error) throw new Error(`Failed to record walk-in payment: ${error.message}`);
  return { recorded: true };
}

module.exports = {
  syncBarberTransactions,
  assignUnmatchedPayment,
  unmatchPayment,
  recordWalkIn,
};
