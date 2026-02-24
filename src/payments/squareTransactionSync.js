// squareTransactionSync.js
// Pulls a barber's Square payments and attempts to match them to GHL contacts.
// Unmatched payments are returned for the barber to manually review in the app.

const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const { getBarberToken } = require("./squareOAuth");
const { lookupContactIdByEmailOrPhone } = require("../clients/ghlClient");

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
 * @returns {{ synced: number, matched: number, unmatched: SyncedPayment[] }}
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
    return { synced: 0, matched: 0, unmatched: [] };
  }

  console.log(`[SquareSync] Found ${payments.length} payments for barber ${barberGhlId}`);

  // Attempt to match each payment to a GHL contact
  const results = await Promise.all(
    payments.map((p) => matchAndRecordPayment(p, barberGhlId, access_token))
  );

  const synced = results.length;
  const matched = results.filter((r) => r.matched).length;
  const unmatched = results.filter((r) => !r.matched).map((r) => r.payment);

  // Update last_synced_at on the token row
  await updateLastSynced(barberGhlId, null);

  console.log(`[SquareSync] Barber ${barberGhlId}: ${matched} matched, ${unmatched.length} unmatched of ${synced} total`);

  return { synced, matched, unmatched };
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
 *   3. No match → return as unmatched for manual review
 */
async function matchAndRecordPayment(squarePayment, barberGhlId, accessToken) {
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
    return { matched: true, payment: null }; // Already synced
  }

  // Build a normalized payment summary for unmatched queue
  const paymentSummary = {
    squarePaymentId: paymentId,
    amountCents,
    currency,
    createdAt,
    cardBrand: squarePayment.card_details?.card?.card_brand || null,
    last4: squarePayment.card_details?.card?.last_4 || null,
    customerEmail: squarePayment.buyer_email_address || null,
    customerPhone: null, // Square doesn't expose phone on payment; comes from customer lookup
    note: squarePayment.note || null,
  };

  // Try to match via buyer email
  let contactId = null;
  if (squarePayment.buyer_email_address) {
    contactId = await lookupGhlContactByEmail(squarePayment.buyer_email_address);
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
    }
    if (!contactId && customerDetails?.phone_number) {
      paymentSummary.customerPhone = customerDetails.phone_number;
      contactId = await lookupGhlContactByPhone(customerDetails.phone_number);
    }
  }

  if (!contactId) {
    // No match — return for manual review
    return { matched: false, payment: paymentSummary };
  }

  // Record as a transaction in Supabase
  await recordTransaction({
    contactId,
    barberGhlId,
    squarePayment,
    amountCents,
    createdAt,
  });

  return { matched: true, payment: null };
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
 */
async function recordTransaction({ contactId, barberGhlId, squarePayment, amountCents, createdAt }) {
  const grossAmount = amountCents / 100;

  const { error } = await supabase.from("transactions").insert({
    contact_id: contactId,
    contact_name: "", // Enriched on display from GHL contact
    appointment_id: null, // Could be matched later via calendar proximity
    artist_ghl_id: barberGhlId,
    transaction_type: "session_payment",
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
    notes: squarePayment.note || null,
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
 * Manually assign an unmatched payment to a contact (called from iOS "needs review" UI).
 */
async function assignUnmatchedPayment({ barberGhlId, squarePaymentId, contactId, amountCents, createdAt, note }) {
  // Check not already recorded
  const { data: existing } = await supabase
    .from("transactions")
    .select("id")
    .eq("square_payment_id", squarePaymentId)
    .single();

  if (existing) return { alreadyRecorded: true };

  const grossAmount = amountCents / 100;

  const { error } = await supabase.from("transactions").insert({
    contact_id: contactId,
    contact_name: "",
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
    notes: note || null,
  });

  if (error) throw new Error(`Failed to record assigned payment: ${error.message}`);
  return { recorded: true };
}

module.exports = {
  syncBarberTransactions,
  assignUnmatchedPayment,
};
