// squareTransactionSync.js
// Pulls a barber's Square payments and attempts to match them to GHL contacts.
// Matching strategy:
//   1. Email/phone lookup via Square customer → GHL contact
//   2. ContactId-based appointment linking (same-day or name fallback)
//   3. Deposit detection → future appointment linking via Supabase (auto-saved)
//   4. Batch sequential matching: remaining unmatched payments paired with unclaimed
//      appointments in chronological order (Nth payment → Nth appointment)
//   5. Manual review for anything still unmatched
//
// IMPORTANT: Only deposits are auto-saved during sync. All other matched payments
// are returned as "suggested matches" — they are NOT saved to Supabase until the
// barber explicitly confirms them in the Review Payments screen.

const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const { getBarberToken } = require("./squareOAuth");
const { getContact } = require("../clients/ghlClient");
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

// Barbershop timezone (America/Chicago — CST/CDT)
const BARBER_TZ = "America/Chicago";

// Rate-limit helpers for GHL API (≤5 req/sec to stay under limits)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry a function on 429 (Too Many Requests) errors with exponential backoff.
 * @param {Function} fn - Async function to call
 * @param {number} maxRetries - Maximum retry attempts (default: 3)
 */
async function withRetry(fn, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is429 = err?.statusCode === 429 || err?.response?.statusCode === 429 || err?.status === 429;
      if (is429 && attempt < maxRetries) {
        const delayMs = 1000 * (attempt + 1); // 1s, 2s, 3s
        console.warn(`[SquareSync] GHL 429 — retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Process items in small batches with a delay between batches.
 * Prevents overwhelming external APIs with concurrent requests.
 * @param {Array} items - Items to process
 * @param {Function} fn - Async function to call for each item
 * @param {number} batchSize - Concurrent items per batch (default: 3)
 * @param {number} delayMs - Pause between batches in ms (default: 300)
 */
async function throttledMap(items, fn, batchSize = 3, delayMs = 300) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (i + batchSize < items.length) {
      await sleep(delayMs);
    }
  }
  return results;
}

/**
 * Convert a UTC ISO string to a local YYYY-MM-DD date string.
 * Uses Intl.DateTimeFormat to handle CST/CDT automatically.
 */
function toLocalDate(utcIsoString) {
  const dt = new Date(utcIsoString);
  // Format as YYYY-MM-DD in the barbershop timezone
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BARBER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(dt);
  return parts; // "en-CA" locale gives "YYYY-MM-DD" format
}

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
      // Also exclude break/block/personal events — these are calendar holds, not real appointments
      const blockedTitles = ["break", "block", "blocked", "lunch", "personal", "off"];
      appointmentsForRange = appointmentsForRange.filter((apt) => {
        if (!["confirmed", "showed", "new"].includes(apt.appointmentStatus)) return false;
        const title = (apt.title || "").toLowerCase().trim();
        return !blockedTitles.includes(title);
      });
      console.log(`[SquareSync] Pre-fetched ${appointmentsForRange.length} active appointments for proximity matching`);
    } else {
      console.warn("[SquareSync] ghlBarber SDK not available — skipping appointment proximity matching");
    }
  } catch (err) {
    console.warn(`[SquareSync] Failed to fetch appointments for proximity matching: ${err.message}`);
    // Continue without appointment matching — graceful degradation
  }

  // Attempt to match each payment to a GHL contact
  // Process payments in throttled batches (3 concurrent, 300ms between batches)
  // to avoid 429 rate limits on GHL API during backfill
  const results = await throttledMap(
    payments,
    (p) => matchAndRecordPayment(p, barberGhlId, access_token, appointmentsForRange),
    3,
    300
  );

  const synced = results.length;
  let autoMatched = results
    .filter((r) => r.matched && r.autoMatchDetail)
    .map((r) => r.autoMatchDetail);
  let unmatchedResults = results.filter((r) => !r.matched);

  // Batch proximity matching: pair unmatched non-product payments with appointments by day order
  // Exclude appointments already claimed by email/phone matching
  if (unmatchedResults.length > 0 && appointmentsForRange.length > 0) {
    const claimedAptIds = new Set(autoMatched.map((m) => m.appointmentId).filter(Boolean));
    const availableAppts = appointmentsForRange.filter((apt) => !claimedAptIds.has(apt.id));
    const batchMatches = await batchProximityMatch(unmatchedResults, availableAppts, barberGhlId, access_token);
    if (batchMatches.length > 0) {
      const matchedIndices = new Set(batchMatches.map((m) => m.idx));
      autoMatched = autoMatched.concat(batchMatches.map((m) => m.autoMatchDetail));
      unmatchedResults = unmatchedResults.filter((_, i) => !matchedIndices.has(i));
      console.log(`[SquareSync] Batch proximity matched ${batchMatches.length} additional payments`);
    }
  }

  // Auto-record unmatched product sales (they won't appear in Review Payments)
  const productSales = unmatchedResults.filter((r) => r.payment?.isProductSale);
  for (const ps of productSales) {
    try {
      await recordTransaction({
        contactId: "walk_in",
        contactName: "Walk-in",
        barberGhlId,
        squarePayment: { id: ps.payment.squarePaymentId, order_id: ps.payment.squareOrderId, tip_money: { amount: ps.payment.squareTipCents || 0 }, note: ps.payment.note },
        totalCents: ps.payment.amountCents,
        serviceCents: ps.payment.serviceCents || ps.payment.amountCents,
        createdAt: ps.payment.createdAt,
        appointmentId: null,
        calendarId: null,
        squareTipCents: ps.payment.squareTipCents || null,
        discountCents: ps.payment.discountCents,
        orderDetails: { itemType: ps.payment.itemType, lineItemName: ps.payment.lineItemName, isProductSale: true, basePriceCents: ps.payment.basePriceCents, totalTaxCents: null },
      });
      console.log(`[SquareSync] Auto-recorded product sale: ${ps.payment.squarePaymentId} ($${(ps.payment.basePriceCents || ps.payment.amountCents) / 100})`);
    } catch (err) {
      console.warn(`[SquareSync] Failed to auto-record product sale ${ps.payment.squarePaymentId}: ${err.message}`);
    }
  }
  // Remove auto-recorded products from unmatched list
  unmatchedResults = unmatchedResults.filter((r) => !r.payment?.isProductSale);

  // Safety net: strip any product sales from autoMatched (they should be auto-saved, not shown in Review)
  const productInAutoMatched = autoMatched.filter((m) => m.isProductSale);
  if (productInAutoMatched.length > 0) {
    console.log(`[SquareSync] Stripping ${productInAutoMatched.length} product sales from autoMatched (safety net)`);
    // Auto-save these product sales that slipped through
    for (const prod of productInAutoMatched) {
      try {
        await recordTransaction({
          contactId: prod.contactId || "walk_in",
          contactName: prod.contactName || "Walk-in",
          barberGhlId,
          squarePayment: { id: prod.squarePaymentId, order_id: prod.squareOrderId, tip_money: { amount: prod.squareTipCents || 0 }, note: prod.note },
          totalCents: prod.amountCents,
          serviceCents: prod.serviceCents || prod.amountCents,
          createdAt: prod.createdAt,
          appointmentId: prod.appointmentId || null,
          calendarId: prod.calendarId || null,
          squareTipCents: prod.squareTipCents || null,
          discountCents: prod.discountCents,
          orderDetails: { itemType: prod.itemType, lineItemName: null, isProductSale: true, basePriceCents: prod.basePriceCents, totalTaxCents: prod.totalTaxCents },
        });
        console.log(`[SquareSync] Safety-net auto-recorded product sale: ${prod.squarePaymentId}`);
      } catch (err) {
        console.warn(`[SquareSync] Safety-net product save failed: ${err.message}`);
      }
    }
  }
  autoMatched = autoMatched.filter((m) => !m.isProductSale);

  const matched = synced - unmatchedResults.length;
  const unmatched = unmatchedResults.map((r) => r.payment);

  // Update last_synced_at on the token row
  await updateLastSynced(barberGhlId, null);

  console.log(`[SquareSync] Barber ${barberGhlId}: ${synced - unmatched.length} matched (${autoMatched.length} with details), ${unmatched.length} unmatched of ${synced} total`);

  return { synced, matched, autoMatched, unmatched };
}

/**
 * Backfill a barber's Square transactions over a wide date range.
 * Processes in monthly chunks to stay under the 500-payment safety cap
 * per call to syncBarberTransactions().
 *
 * @param {string} barberGhlId
 * @param {object} options
 * @param {string} [options.startDate] - ISO date string (default: "2026-01-01")
 * @param {string} [options.endDate]   - ISO date string (default: now)
 * @returns {{ synced, matched, autoMatched, unmatched, chunksProcessed }}
 */
async function backfillBarberTransactions(barberGhlId, options = {}) {
  const endDate = options.endDate ? new Date(options.endDate) : new Date();
  const startDate = options.startDate
    ? new Date(options.startDate)
    : new Date("2026-01-01T00:00:00Z");

  // Build monthly chunks: [Jan 1 → Feb 1], [Feb 1 → Mar 1], …
  const chunks = [];
  let chunkStart = new Date(startDate);
  while (chunkStart < endDate) {
    const chunkEnd = new Date(chunkStart);
    chunkEnd.setUTCMonth(chunkEnd.getUTCMonth() + 1);
    if (chunkEnd > endDate) chunkEnd.setTime(endDate.getTime());
    chunks.push({ startDate: new Date(chunkStart), endDate: new Date(chunkEnd) });
    chunkStart = new Date(chunkEnd);
  }

  const totals = {
    synced: 0,
    matched: 0,
    autoMatched: [],
    unmatched: [],
    chunksProcessed: 0,
  };

  // Process chunks sequentially to respect API rate limits
  for (const chunk of chunks) {
    console.log(
      `[Backfill] Processing chunk ${chunk.startDate.toISOString()} → ${chunk.endDate.toISOString()}`
    );
    const result = await syncBarberTransactions(barberGhlId, {
      startDate: chunk.startDate.toISOString(),
      endDate: chunk.endDate.toISOString(),
      incremental: false,
    });
    totals.synced += result.synced;
    totals.matched += result.matched;
    totals.autoMatched.push(...result.autoMatched);
    totals.unmatched.push(...result.unmatched);
    totals.chunksProcessed++;
  }

  console.log(
    `[Backfill] Complete: ${totals.synced} synced, ${totals.matched} matched, ` +
      `${totals.unmatched.length} unmatched across ${totals.chunksProcessed} chunks`
  );
  return totals;
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
  const totalCents = squarePayment.total_money?.amount || squarePayment.amount_money?.amount || 0;
  const serviceCents = squarePayment.amount_money?.amount || 0;
  const currency = squarePayment.amount_money?.currency || "USD";
  const createdAt = squarePayment.created_at;

  // Check if we've already recorded this payment to avoid duplicates
  // Use maybeSingle() — .single() throws when 0 rows match, bypassing the check
  const { data: existing } = await supabase
    .from("transactions")
    .select("id")
    .eq("square_payment_id", paymentId)
    .maybeSingle();

  if (existing) {
    return { matched: true, payment: null, autoMatchDetail: null }; // Already synced
  }

  // Build a normalized payment summary for unmatched queue
  const paymentSummary = {
    squarePaymentId: paymentId,
    squareOrderId: squarePayment.order_id || null,
    amountCents: totalCents, // total_money (service + tip) — what the client actually paid
    serviceCents, // amount_money (base charge before tip)
    currency,
    createdAt,
    cardBrand: squarePayment.card_details?.card?.card_brand || null,
    last4: squarePayment.card_details?.card?.last_4 || null,
    customerEmail: squarePayment.buyer_email_address || null,
    customerPhone: null, // Square doesn't expose phone on payment; comes from customer lookup
    note: squarePayment.note || null,
    squareTipCents: squarePayment.tip_money?.amount || null,
  };

  // Fetch Order details early — needed for product sale detection before proximity matching
  const orderDetails = await fetchSquareOrderDetails(accessToken, squarePayment.order_id);
  paymentSummary.itemType = orderDetails.itemType;
  paymentSummary.lineItemName = orderDetails.lineItemName;
  paymentSummary.isProductSale = orderDetails.isProductSale;
  paymentSummary.discountCents = orderDetails.totalDiscountCents;
  paymentSummary.discountName = orderDetails.discountName;

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

  // If contact was found via email/phone, try to find their appointment
  let matchedAppointment = null;
  // so we can link the transaction to the correct appointment_id and calendar_id
  if (contactId && !matchedAppointment && appointments.length > 0) {
    const paymentTime = new Date(createdAt);
    const THIRTY_MIN_MS = 30 * 60 * 1000;

    // Find this contact's appointments within the valid window, pick closest start time
    const contactAppts = appointments
      .filter((apt) => {
        if (apt.contactId !== contactId) return false;
        const aptStart = new Date(apt.startTime);
        const aptEnd = new Date(apt.endTime);
        return paymentTime >= aptStart && paymentTime <= new Date(aptEnd.getTime() + THIRTY_MIN_MS);
      })
      .sort((a, b) => new Date(a.startTime) - new Date(b.startTime)); // earliest first

    if (contactAppts.length > 0) {
      matchedAppointment = contactAppts[0];
      console.log(`[SquareSync] Linked email/phone-matched contact ${contactId} to appointment ${matchedAppointment.id}`);
    } else {
      // Broaden: find any appointment for this contact on the same local day
      const paymentDay = toLocalDate(paymentTime.toISOString());
      const sameDayAppts = appointments.filter((apt) => {
        if (apt.contactId !== contactId) return false;
        return toLocalDate(apt.startTime) === paymentDay;
      });
      if (sameDayAppts.length === 1) {
        matchedAppointment = sameDayAppts[0];
        console.log(`[SquareSync] Linked contact ${contactId} to same-day appointment ${matchedAppointment.id}`);
      }
    }
  }

  // Fallback: if contactId-based matching failed (common with duplicate GHL contacts),
  // try matching by contact name in appointment titles on the same day
  if (contactId && !matchedAppointment && appointments.length > 0) {
    // We'll resolve the name first for this fallback
    let tempName = "";
    try {
      let contact;
      if (ghlBarber) {
        const data = await withRetry(() => ghlBarber.contacts.getContact({ contactId }));
        contact = data?.contact || data;
      } else {
        contact = await withRetry(() => getContact(contactId));
      }
      tempName = (contact?.contactName || contact?.name || `${contact?.firstName || ""} ${contact?.lastName || ""}`.trim()).toLowerCase();
    } catch { /* ignore */ }

    if (tempName) {
      const paymentDay = toLocalDate(createdAt);
      const nameAppts = appointments.filter((apt) => {
        if (toLocalDate(apt.startTime) !== paymentDay) return false;
        const aptTitle = (apt.title || "").toLowerCase();
        // GHL title format: "Service: Contact Name" or "Contact Name - Service"
        const colonIdx = aptTitle.indexOf(":");
        const aptName = colonIdx !== -1 ? aptTitle.slice(colonIdx + 1).trim() : aptTitle.split(" - ")[0]?.trim();
        return aptName && (aptName.includes(tempName) || tempName.includes(aptName));
      });
      if (nameAppts.length === 1) {
        matchedAppointment = nameAppts[0];
        console.log(`[SquareSync] Linked by name "${tempName}" to appointment ${matchedAppointment.id} (contactId mismatch: apt=${matchedAppointment.contactId}, lookup=${contactId})`);
      }
    }
  }

  // If contact matched but no same-day appointment, check if this is a deposit
  // by querying the Supabase appointments table for the contact's future appointment.
  // GHL appointment webhooks already persist appointments to Supabase in real time,
  // so we can look up future appointments without calling the GHL API.
  if (contactId && !matchedAppointment && !orderDetails.isProductSale) {
    const hasTip = squarePayment.tip_money?.amount > 0;
    const isCustomAmount = orderDetails.itemType === "CUSTOM_AMOUNT" || orderDetails.itemType === null;
    // Dynamically check all known deposit amounts from the price config
    let isLikelyDeposit = false;
    if (!hasTip && isCustomAmount) {
      const { getServicePriceMap } = require("../config/barberServicePrices");
      const priceMap = await getServicePriceMap();
      const knownDepositAmounts = new Set();
      for (const [calId, price] of priceMap) {
        const pct = await lookupDepositPercentage(calId);
        if (pct) knownDepositAmounts.add(Math.round(price * (pct / 100)));
      }
      isLikelyDeposit = knownDepositAmounts.has(serviceCents / 100);
      // Also check if the line item name mentions "tattoo" or "deposit"
      if (!isLikelyDeposit) {
        const lineItemLower = (orderDetails?.lineItemName || "").toLowerCase();
        if (lineItemLower.includes("tattoo") || lineItemLower.includes("deposit")) {
          isLikelyDeposit = true;
        }
      }
    }

    if (isLikelyDeposit) {
      try {
        const { data: futureAppts } = await supabase
          .from("appointments")
          .select("id, calendar_id, start_time, contact_id")
          .eq("contact_id", contactId)
          .gt("start_time", createdAt)
          .in("status", ["confirmed", "showed", "new"])
          .order("start_time", { ascending: true })
          .limit(1);

        if (futureAppts && futureAppts.length > 0) {
          const apt = futureAppts[0];
          matchedAppointment = {
            id: apt.id,
            calendarId: apt.calendar_id,
            startTime: apt.start_time,
            contactId: apt.contact_id,
          };
          console.log(`[SquareSync] Deposit linked to future appointment ${apt.id} on ${toLocalDate(apt.start_time)} (payment on ${toLocalDate(createdAt)})`);
        }
      } catch (err) {
        console.warn(`[SquareSync] Failed to find future appointment for deposit: ${err.message}`);
      }
    }
  }

  if (!contactId) {
    // No match — return for manual review (order details already on paymentSummary)
    // Include squarePayment + orderDetails so batch proximity matching can record if it finds a match
    return { matched: false, payment: paymentSummary, autoMatchDetail: null, squarePayment, orderDetails };
  }

  // Fetch contact name for storage and response (use barber SDK for barbershop contacts)
  let contactName = "";
  try {
    let contact;
    if (ghlBarber) {
      const data = await withRetry(() => ghlBarber.contacts.getContact({ contactId }));
      contact = data?.contact || data;
    } else {
      contact = await withRetry(() => getContact(contactId));
    }
    contactName = contact?.contactName || contact?.name || `${contact?.firstName || ""} ${contact?.lastName || ""}`.trim();
  } catch { /* ignore — name is nice-to-have */ }

  // Classify the payment to decide whether to auto-save or defer
  const transactionType = await classifyTransactionType({
    serviceCents,
    squareTipCents: squarePayment.tip_money?.amount || null,
    calendarId: matchedAppointment?.calendarId || null,
    orderDetails,
  });

  // Deposits are auto-saved to Supabase immediately (excluded from Review Payments screen).
  // All other types are deferred — returned as suggested matches for barber confirmation.
  if (transactionType === "deposit") {
    await recordTransaction({
      contactId,
      contactName,
      barberGhlId,
      squarePayment,
      totalCents,
      serviceCents,
      createdAt,
      appointmentId: matchedAppointment?.id || null,
      calendarId: matchedAppointment?.calendarId || null,
      squareTipCents: squarePayment.tip_money?.amount || null,
      discountCents: orderDetails.totalDiscountCents,
      orderDetails,
    });
    return { matched: true, payment: null, autoMatchDetail: null };
  }

  // Product sales are auto-saved (not shown in Review Payments)
  if (transactionType === "product_sale") {
    await recordTransaction({
      contactId,
      contactName,
      barberGhlId,
      squarePayment,
      totalCents,
      serviceCents,
      createdAt,
      appointmentId: matchedAppointment?.id || null,
      calendarId: matchedAppointment?.calendarId || null,
      squareTipCents: squarePayment.tip_money?.amount || null,
      discountCents: orderDetails.totalDiscountCents,
      orderDetails,
    });
    console.log(`[SquareSync] Auto-recorded product sale (contact-matched): ${paymentId}`);
    return { matched: true, payment: null, autoMatchDetail: null };
  }

  // Non-deposit, non-product: return as suggested match (NOT saved to Supabase yet)
  const autoMatchDetail = {
    squarePaymentId: paymentId,
    contactId,
    contactName,
    appointmentId: matchedAppointment?.id || null,
    appointmentTitle: matchedAppointment?.title || null,
    appointmentStartTime: matchedAppointment?.startTime || null,
    calendarId: matchedAppointment?.calendarId || null,
    amountCents: totalCents, // total_money (service + tip)
    serviceCents,
    createdAt,
    matchMethod,
    squareTipCents: squarePayment.tip_money?.amount || null,
    // Extended fields for deferred confirmation
    squareOrderId: squarePayment.order_id || null,
    cardBrand: squarePayment.card_details?.card?.card_brand || null,
    last4: squarePayment.card_details?.card?.last_4 || null,
    itemType: orderDetails?.itemType || null,
    isProductSale: orderDetails?.isProductSale || false,
    basePriceCents: orderDetails?.basePriceCents || null,
    totalTaxCents: orderDetails?.totalTaxCents || null,
    discountCents: orderDetails?.totalDiscountCents || null,
    note: squarePayment.note || null,
  };

  return { matched: true, payment: null, autoMatchDetail };
}

/**
 * Batch per-day sequential matching.
 * Groups unmatched non-product payments by day, sorts them chronologically,
 * and pairs them with unclaimed appointments in chronological order.
 *
 * Algorithm: for each day, sort payments by time and appointments by start time,
 * then pair the Nth payment with the Nth unclaimed appointment. This is more
 * reliable than time-window matching because payments naturally come in the same
 * order as appointments (1st client pays first, 2nd client pays second, etc.).
 */
async function batchProximityMatch(unmatchedResults, appointments, barberGhlId, accessToken) {
  const newlyMatched = [];

  // Filter to non-product unmatched payments that have timestamps
  const candidates = unmatchedResults
    .map((r, idx) => ({ ...r, _idx: idx }))
    .filter((r) => r.payment && r.payment.createdAt && !r.payment.isProductSale);

  if (candidates.length === 0 || appointments.length === 0) return newlyMatched;

  // Group candidates by local date (barbershop timezone)
  const byDay = {};
  for (const c of candidates) {
    const day = toLocalDate(c.payment.createdAt);
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(c);
  }

  // Group appointments by local date
  const aptsByDay = {};
  for (const apt of appointments) {
    const day = toLocalDate(apt.startTime);
    if (!aptsByDay[day]) aptsByDay[day] = [];
    aptsByDay[day].push(apt);
  }

  for (const day of Object.keys(byDay)) {
    const dayPayments = byDay[day].sort(
      (a, b) => new Date(a.payment.createdAt) - new Date(b.payment.createdAt)
    );
    const blockedTitles = ["break", "block", "blocked", "lunch", "personal", "off"];
    const dayAppts = (aptsByDay[day] || [])
      .slice()
      .filter((apt) => {
        if (!apt.contactId) return false;
        const title = (apt.title || "").toLowerCase().trim();
        return !blockedTitles.includes(title);
      })
      .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

    if (dayAppts.length === 0) continue;

    // Time-aware matching: for each unmatched payment, find the best unclaimed
    // appointment. Barbers often run behind, so payments come after the appointment ends.
    //
    // Scoring: prefer appointments that already ended before the payment was made.
    // Among those, pick the one whose end time is closest to the payment time
    // (most recently ended = most likely match). If no ended appointment fits,
    // fall back to appointments currently in progress at payment time.
    //
    // Window: payment must be within 15 min before apt start → 60 min after apt end.
    const claimedAptIndices = new Set();
    for (const candidate of dayPayments) {
      const paymentTime = new Date(candidate.payment.createdAt);

      let bestIdx = -1;
      let bestScore = Infinity; // lower = better
      for (let i = 0; i < dayAppts.length; i++) {
        if (claimedAptIndices.has(i)) continue;
        const aptStart = new Date(dayAppts[i].startTime);
        const aptEnd = dayAppts[i].endTime ? new Date(dayAppts[i].endTime) : new Date(aptStart.getTime() + 60 * 60 * 1000);
        const BEFORE_MS = 15 * 60 * 1000;
        const AFTER_MS = 60 * 60 * 1000;
        if (paymentTime < new Date(aptStart.getTime() - BEFORE_MS) ||
            paymentTime > new Date(aptEnd.getTime() + AFTER_MS)) continue;

        // Prefer appointments that ended before the payment (natural "pay after service")
        // Score: time since apt ended (lower = better). Appointments not yet ended get a penalty.
        let score;
        if (paymentTime >= aptEnd) {
          // Appointment already ended — ideal match. Score = minutes since end.
          score = (paymentTime - aptEnd) / 60000;
        } else {
          // Appointment still in progress or hasn't started — unlikely match.
          // Penalty: 1000 + minutes until end (so ended apts always win).
          score = 1000 + (aptEnd - paymentTime) / 60000;
        }

        if (score < bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }

      if (bestIdx === -1) continue;
      claimedAptIndices.add(bestIdx);
      const match = dayAppts[bestIdx];

      const contactId = match.contactId;
      const sp = candidate.squarePayment;
      const totalCents = sp.total_money?.amount || sp.amount_money?.amount || 0;
      const serviceCents = sp.amount_money?.amount || 0;

      // Classify before deciding — deposits are auto-saved, everything else is suggested
      const transactionType = await classifyTransactionType({
        serviceCents,
        squareTipCents: sp.tip_money?.amount || null,
        calendarId: match.calendarId || null,
        orderDetails: candidate.orderDetails,
      });

      // Auto-save deposits (they don't appear in Review Payments)
      if (transactionType === "deposit") {
        // Fetch contact name for the deposit record
        let depositContactName = "";
        try {
          let contact;
          if (ghlBarber) {
            const data = await withRetry(() => ghlBarber.contacts.getContact({ contactId }));
            contact = data?.contact || data;
          } else {
            contact = await withRetry(() => getContact(contactId));
          }
          depositContactName = contact?.contactName || contact?.name || `${contact?.firstName || ""} ${contact?.lastName || ""}`.trim();
        } catch { /* ignore */ }

        await recordTransaction({
          contactId,
          contactName: depositContactName,
          barberGhlId,
          squarePayment: sp,
          totalCents,
          serviceCents,
          createdAt: sp.created_at,
          appointmentId: match.id,
          calendarId: match.calendarId || null,
          squareTipCents: sp.tip_money?.amount || null,
          discountCents: candidate.orderDetails?.totalDiscountCents || null,
          orderDetails: candidate.orderDetails,
        });
        continue;
      }

      // Fetch contact name for the suggested match detail
      let contactName = "";
      try {
        let contact;
        if (ghlBarber) {
          const data = await withRetry(() => ghlBarber.contacts.getContact({ contactId }));
          contact = data?.contact || data;
        } else {
          contact = await withRetry(() => getContact(contactId));
        }
        contactName = contact?.contactName || contact?.name || `${contact?.firstName || ""} ${contact?.lastName || ""}`.trim();
      } catch { /* ignore */ }

      // Return as suggested match (NOT saved to Supabase — deferred to user confirmation)
      const autoMatchDetail = {
        squarePaymentId: sp.id,
        contactId,
        contactName,
        appointmentId: match.id,
        appointmentTitle: match.title || null,
        appointmentStartTime: match.startTime || null,
        calendarId: match.calendarId || null,
        amountCents: totalCents,
        serviceCents,
        createdAt: sp.created_at,
        matchMethod: "batch_sequential",
        squareTipCents: sp.tip_money?.amount || null,
        // Extended fields for deferred confirmation
        squareOrderId: sp.order_id || null,
        cardBrand: sp.card_details?.card?.card_brand || null,
        last4: sp.card_details?.card?.last_4 || null,
        itemType: candidate.orderDetails?.itemType || null,
        isProductSale: candidate.orderDetails?.isProductSale || false,
        basePriceCents: candidate.orderDetails?.basePriceCents || null,
        totalTaxCents: candidate.orderDetails?.totalTaxCents || null,
        discountCents: candidate.orderDetails?.totalDiscountCents || null,
        note: sp.note || null,
      };

      console.log(`[SquareSync] Sequential match (suggested): payment ${sp.id} ($${totalCents / 100}) → appointment ${match.id} (${contactName})`);
      newlyMatched.push({ idx: candidate._idx, autoMatchDetail });
    }
  }

  return newlyMatched;
}

/**
 * Look up a GHL contact by email in the barbershop location.
 * Uses ghlBarber SDK directly since lookupContactIdByEmailOrPhone uses tattoo shop SDK.
 * Returns contactId string or null.
 */
async function lookupGhlContactByEmail(email) {
  if (!email || !ghlBarber) return null;
  try {
    const cleanEmail = email.replace(/\s+/g, "").trim();
    const data = await withRetry(() =>
      ghlBarber.contacts.getDuplicateContact({
        locationId: BARBER_LOCATION_ID,
        email: cleanEmail,
      })
    );
    return data?.contact?.id || data?.contact?._id || data?.id || data?._id || null;
  } catch (err) {
    console.warn(`[SquareSync] Email lookup failed for ${email}: ${err.message}`);
    return null;
  }
}

/**
 * Look up a GHL contact by phone in the barbershop location.
 * Uses ghlBarber SDK directly.
 */
async function lookupGhlContactByPhone(phone) {
  if (!phone || !ghlBarber) return null;
  try {
    const data = await withRetry(() =>
      ghlBarber.contacts.getDuplicateContact({
        locationId: BARBER_LOCATION_ID,
        number: phone,
      })
    );
    return data?.contact?.id || data?.contact?._id || data?.id || data?._id || null;
  } catch (err) {
    console.warn(`[SquareSync] Phone lookup failed for ${phone}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch a Square Order to get line item details and discounts.
 * Returns itemType (CUSTOM_AMOUNT vs ITEM), line item names, and discount info.
 * This is critical for deposit detection:
 *   - Deposits are keyed as CUSTOM_AMOUNT (no catalog item)
 *   - Services/products are ITEM with a catalogObjectId
 *
 * @param {string} accessToken - The barber's Square access token
 * @param {string} orderId - The Square order ID from the payment
 * @returns {{ totalDiscountCents: number|null, discountName: string|null, itemType: string|null, lineItemName: string|null, isProductSale: boolean }}
 */
async function fetchSquareOrderDetails(accessToken, orderId) {
  const empty = { totalDiscountCents: null, discountName: null, itemType: null, lineItemName: null, isProductSale: false, basePriceCents: null, totalTaxCents: null };
  if (!orderId || !accessToken) return empty;
  try {
    const res = await axios.get(`${SQUARE_BASE_URL}/v2/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const order = res.data?.order;
    if (!order) return empty;

    const totalDiscountCents = order.total_discount_money?.amount || null;
    const discountName = order.discounts?.[0]?.name || null;

    // Extract line item info from the first (primary) line item
    const lineItem = order.line_items?.[0];
    const itemType = lineItem?.item_type || null;
    const lineItemName = lineItem?.name || null;
    const hasCatalogId = !!lineItem?.catalog_object_id;

    // Product sale = ITEM type with a catalog ID and NOT a known service name
    // Known service names: "Haircut", "Haircut + Beard", etc.
    const knownServiceNames = ["haircut", "haircut + beard", "beard"];
    const isKnownService = lineItemName && knownServiceNames.some(
      (sn) => lineItemName.toLowerCase().includes(sn)
    );
    const isProductSale = itemType === "ITEM" && hasCatalogId && !isKnownService;

    // Extract base price (listing price before tax) and tax for product sales
    const basePriceCents = lineItem?.base_price_money?.amount || null;
    const totalTaxCents = order.total_tax_money?.amount || null;

    if (totalDiscountCents) {
      console.log(`[SquareSync] Order ${orderId}: discount ${discountName || "unnamed"} = $${totalDiscountCents / 100}`);
    }
    if (isProductSale) {
      console.log(`[SquareSync] Order ${orderId}: product sale detected — "${lineItemName}" (${itemType}), base $${(basePriceCents || 0) / 100}, tax $${(totalTaxCents || 0) / 100}`);
    }

    return { totalDiscountCents, discountName, itemType, lineItemName, isProductSale, basePriceCents, totalTaxCents };
  } catch (err) {
    console.warn(`[SquareSync] Failed to fetch order ${orderId}: ${err.message}`);
    return empty;
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
 * Classify a payment as deposit, session_payment, or product_sale
 * WITHOUT saving anything to the database.
 * Used by matchAndRecordPayment() and batchProximityMatch() to detect deposits
 * before deciding whether to auto-save or defer to user confirmation.
 */
async function classifyTransactionType({ serviceCents, squareTipCents, calendarId, orderDetails }) {
  const serviceAmount = serviceCents / 100;
  const itemType = orderDetails?.itemType || null;
  const isProductSale = orderDetails?.isProductSale || false;

  if (isProductSale) return "product_sale";

  const depositPct = calendarId ? await lookupDepositPercentage(calendarId) : null;
  const listedPrice = calendarId ? await lookupServicePrice(calendarId) : null;

  if (depositPct && listedPrice) {
    const expectedDeposit = listedPrice * (depositPct / 100);
    const hasTip = squareTipCents != null && squareTipCents > 0;
    const amountMatches = Math.abs(serviceAmount - expectedDeposit) <= 1;
    const isCustomAmount = itemType === "CUSTOM_AMOUNT" || itemType === null;
    if (!hasTip && amountMatches && isCustomAmount) return "deposit";
  } else if (!calendarId && !isProductSale) {
    const hasTip = squareTipCents != null && squareTipCents > 0;
    const isCustomAmount = itemType === "CUSTOM_AMOUNT" || itemType === null;
    if (!hasTip && isCustomAmount) {
      // Dynamically compute all known deposit amounts from the price config
      const { getServicePriceMap } = require("../config/barberServicePrices");
      const priceMap = await getServicePriceMap();
      const knownDepositAmounts = new Set();
      for (const [calId, price] of priceMap) {
        const pct = await lookupDepositPercentage(calId);
        if (pct) knownDepositAmounts.add(Math.round(price * (pct / 100)));
      }
      const isKnownDepositAmount = knownDepositAmounts.has(serviceAmount);
      if (isKnownDepositAmount) return "deposit";

      // If the line item name mentions "tattoo" or "deposit", classify as deposit
      // (handles tattoo deposits processed through the same Square location)
      const lineItemLower = (orderDetails?.lineItemName || "").toLowerCase();
      if (lineItemLower.includes("tattoo") || lineItemLower.includes("deposit")) {
        console.log(`[SquareSync] Deposit detected (line item name): $${serviceAmount} — "${orderDetails.lineItemName}" (itemType=${itemType})`);
        return "deposit";
      }
    }
  }

  return "session_payment";
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
async function recordTransaction({ contactId, contactName, barberGhlId, squarePayment, totalCents, serviceCents, createdAt, appointmentId, calendarId, squareTipCents, discountCents, orderDetails }) {
  // grossAmount = total_money (what the client actually paid, including tip)
  // serviceAmount = amount_money (base charge before tip)
  const grossAmount = totalCents / 100;
  const serviceAmount = serviceCents / 100;
  const discountAmount = discountCents ? discountCents / 100 : null;
  const itemType = orderDetails?.itemType || null;
  const isProductSale = orderDetails?.isProductSale || false;

  // Determine transaction type using shared classifier
  const transactionType = await classifyTransactionType({ serviceCents, squareTipCents, calendarId, orderDetails });

  // For product sales, use the listing price (before tax) as the revenue amount
  if (transactionType === "product_sale" && orderDetails?.basePriceCents) {
    const listingPrice = orderDetails.basePriceCents / 100;
    const taxAmount = orderDetails.totalTaxCents ? orderDetails.totalTaxCents / 100 : 0;
    console.log(`[SquareSync] Product sale: $${listingPrice} listing + $${taxAmount} tax = $${grossAmount} total — "${orderDetails?.lineItemName}"`);
  } else if (transactionType === "deposit") {
    const depositPct = calendarId ? await lookupDepositPercentage(calendarId) : null;
    const listedPrice = calendarId ? await lookupServicePrice(calendarId) : null;
    if (depositPct && listedPrice) {
      console.log(`[SquareSync] Deposit detected: $${serviceAmount} matches ${depositPct}% of $${listedPrice} (itemType=${itemType}) for calendar ${calendarId}`);
    } else {
      console.log(`[SquareSync] Deposit detected (no calendar): $${serviceAmount} is a known deposit amount (itemType=${itemType})`);
    }
  }

  // Tip & service price calculation
  // Square gives us explicit tip_money and amount_money, so we use those directly
  let servicePrice = null;
  let tipAmount = null;

  if (transactionType === "product_sale") {
    // Product sales: use listing price (before tax) as revenue
    servicePrice = orderDetails?.basePriceCents ? orderDetails.basePriceCents / 100 : serviceAmount;
    tipAmount = 0;
  } else if (transactionType === "deposit") {
    servicePrice = serviceAmount;
    tipAmount = 0;
  } else if (squareTipCents != null && squareTipCents > 0) {
    // Square reported an explicit tip
    // servicePrice = amount_money (base charge), tipAmount = tip_money
    tipAmount = squareTipCents / 100;
    servicePrice = serviceAmount;
  } else {
    // No tip — the full amount is service revenue
    servicePrice = serviceAmount;
    tipAmount = 0;
  }

  // Build notes with product name / discount info
  let notes = squarePayment.note || null;
  if (transactionType === "product_sale" && orderDetails?.lineItemName) {
    notes = `Product: ${orderDetails.lineItemName}`;
  }
  if (discountAmount && transactionType !== "deposit") {
    const discountNote = `Square discount: -$${discountAmount.toFixed(2)}`;
    notes = notes ? `${notes} | ${discountNote}` : discountNote;
  }

  // For product sales, record listing price as gross_amount (exclude sales tax)
  const recordedGross = (transactionType === "product_sale" && orderDetails?.basePriceCents)
    ? orderDetails.basePriceCents / 100
    : grossAmount;

  const { error } = await supabase.from("transactions").insert({
    contact_id: contactId,
    contact_name: contactName || "",
    appointment_id: appointmentId || null,
    artist_ghl_id: barberGhlId,
    transaction_type: transactionType,
    payment_method: "square",
    payment_recipient: "artist_direct", // Booth renters keep all their money
    gross_amount: recordedGross,
    shop_percentage: 0,
    artist_percentage: 100,
    shop_amount: 0,
    artist_amount: recordedGross,
    settlement_status: "settled", // Already paid directly to barber
    square_payment_id: squarePayment.id,
    square_order_id: squarePayment.order_id || null,
    session_date: toLocalDate(createdAt),
    square_payment_time: createdAt,
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

  // Mirror to InstantDB for rent tracker income view (non-fatal)
  try {
    const { writeServiceIncome } = require("../rentTracker/serviceIncomeWriter");
    await writeServiceIncome({
      senderName: contactName || "Walk-in",
      amount: recordedGross,
      method: "square",
      type: transactionType === "session_payment" ? "service" : transactionType,
      paidAt: new Date(createdAt),
      notes,
      squarePaymentId: squarePayment.id,
      weekOf: require("../rentTracker/tenantMatcher").weekOfDate(new Date(createdAt)),
      location: "barbershop",
      tipAmount: tipAmount || 0,
      servicePriceAmount: servicePrice,
      barberGhlId,
    });
  } catch (err) {
    console.warn(`[SquareSync] InstantDB write failed (non-fatal): ${err.message}`);
  }

  return { transactionType };
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
async function assignUnmatchedPayment({ barberGhlId, squarePaymentId, contactId, contactName, amountCents, serviceCents, createdAt, note, appointmentId, calendarId, squareTipCents, itemType, isProductSale, basePriceCents }) {
  // Check if already recorded — if so, update instead of insert (handles re-assignment)
  const { data: existing } = await supabase
    .from("transactions")
    .select("id")
    .eq("square_payment_id", squarePaymentId)
    .maybeSingle();

  // Resolve contact name if not provided (use barber SDK for barbershop contacts)
  let resolvedName = contactName || "";
  if (!resolvedName && contactId) {
    try {
      let contact;
      if (ghlBarber) {
        const data = await withRetry(() => ghlBarber.contacts.getContact({ contactId }));
        contact = data?.contact || data;
      } else {
        contact = await withRetry(() => getContact(contactId));
      }
      resolvedName = contact?.contactName || contact?.name || `${contact?.firstName || ""} ${contact?.lastName || ""}`.trim();
    } catch { /* ignore */ }
  }

  // If transaction already exists, update it (re-assignment from review UI)
  if (existing) {
    const { error: updateErr } = await supabase
      .from("transactions")
      .update({
        contact_id: contactId,
        contact_name: resolvedName || undefined,
        appointment_id: appointmentId || null,
        calendar_id: calendarId || null,
        notes: note || null,
      })
      .eq("id", existing.id);

    if (updateErr) throw new Error(`Failed to reassign payment: ${updateErr.message}`);
    console.log(`[SquareSync] Reassigned existing payment ${squarePaymentId} to contact ${contactId}, appointment ${appointmentId || "none"}`);
    return { reassigned: true };
  }

  // amountCents = total_money (service + tip), serviceCents = amount_money (base charge)
  // For backwards compat: if serviceCents not provided, derive from amountCents - tip
  const grossAmount = amountCents / 100;
  const tipCentsDerived = squareTipCents || 0;
  const serviceAmount = serviceCents ? serviceCents / 100 : (amountCents - tipCentsDerived) / 100;

  // Deposit detection uses serviceAmount (base charge)
  const depositPct = calendarId ? await lookupDepositPercentage(calendarId) : null;
  const listedPrice = calendarId ? await lookupServicePrice(calendarId) : null;

  let transactionType = "session_payment";

  if (isProductSale) {
    transactionType = "product_sale";
  } else if (depositPct && listedPrice) {
    const expectedDeposit = listedPrice * (depositPct / 100);
    const hasTip = squareTipCents != null && squareTipCents > 0;
    const amountMatches = Math.abs(serviceAmount - expectedDeposit) <= 1;
    const isCustomAmount = itemType === "CUSTOM_AMOUNT" || itemType === null;
    if (!hasTip && amountMatches && isCustomAmount) {
      transactionType = "deposit";
    }
  } else if (!calendarId && !isProductSale) {
    // Fallback deposit detection without calendarId
    const hasTip = squareTipCents != null && squareTipCents > 0;
    const isCustomAmount = itemType === "CUSTOM_AMOUNT" || itemType === null;
    const isKnownDepositAmount = serviceAmount === 40 || serviceAmount === 50;
    if (!hasTip && isCustomAmount && isKnownDepositAmount) {
      transactionType = "deposit";
    }
  }

  // Tip calculation — use Square's explicit values
  let servicePrice = null;
  let tipAmount = null;

  if (transactionType === "product_sale") {
    // Use listing price (before tax) if available
    servicePrice = basePriceCents ? basePriceCents / 100 : serviceAmount;
    tipAmount = 0;
  } else if (transactionType === "deposit") {
    servicePrice = serviceAmount;
    tipAmount = 0;
  } else if (squareTipCents != null && squareTipCents > 0) {
    tipAmount = squareTipCents / 100;
    servicePrice = serviceAmount;
  } else {
    servicePrice = serviceAmount;
    tipAmount = 0;
  }

  // For product sales, record listing price as gross_amount (exclude sales tax)
  const recordedGross = (transactionType === "product_sale" && basePriceCents)
    ? basePriceCents / 100
    : grossAmount;

  const { error } = await supabase.from("transactions").insert({
    contact_id: contactId,
    contact_name: resolvedName,
    appointment_id: appointmentId || null,
    artist_ghl_id: barberGhlId,
    transaction_type: transactionType,
    payment_method: "square",
    payment_recipient: "artist_direct",
    gross_amount: recordedGross,
    shop_percentage: 0,
    artist_percentage: 100,
    shop_amount: 0,
    artist_amount: recordedGross,
    settlement_status: "settled",
    square_payment_id: squarePaymentId,
    session_date: toLocalDate(createdAt),
    square_payment_time: createdAt,
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
  // Check not already recorded (maybeSingle to avoid throw on 0 rows)
  const { data: existing } = await supabase
    .from("transactions")
    .select("id")
    .eq("square_payment_id", squarePaymentId)
    .maybeSingle();

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
    session_date: toLocalDate(createdAt),
    square_payment_time: createdAt,
    location_id: BARBER_LOCATION_ID,
    notes: "Walk-in customer",
  });

  if (error) throw new Error(`Failed to record walk-in payment: ${error.message}`);
  return { recorded: true };
}

module.exports = {
  syncBarberTransactions,
  backfillBarberTransactions,
  assignUnmatchedPayment,
  unmatchPayment,
  recordWalkIn,
  toLocalDate,
};
