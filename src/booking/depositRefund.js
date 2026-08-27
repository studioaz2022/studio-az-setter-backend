// ─── Deposit refund approval — Lionel, barbershop ───
//
// A client cancels on Lionel's regular calendar. We work out what they're owed,
// queue it, and push Lionel. He approves or declines from the iOS Tools tab.
// NOTHING in this file refunds on its own — approval is always an explicit act.
//
// See BARBER_REFUND_APPROVAL_PLAN.md for the decisions behind the bands.

const { createClient } = require("@supabase/supabase-js");
const {
  refundPayment,
  getPayment,
} = require("../payments/squareClient");
const { recordTransaction } = require("../clients/financialTracking");
const { sendPushToGhlUser } = require("../services/paymentNotifications");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/** Lionel's REGULAR haircut calendar. Friends & Family (9a66xeZi2pEJWQpxiMjy)
 *  takes no deposits at all, so it can never reach this code. */
const REFUNDABLE_CALENDAR_ID = "Bsv9ngkRgsbLzgtN3Vpq";

/** Lionel, barbershop location. Both the payee and the approver. */
const OWNER_GHL_USER_ID = "1kFG5FWdUDhXLUX46snG";

const SHOP_TZ = "America/Chicago";

const OVER_24H_MINUTES = 24 * 60;
const UNDER_12H_MINUTES = 12 * 60;

/** Square's published API rate for this account, verified 2026-08-27 against a
 *  real settled transaction ($40.00 → $1.46 fee → $38.54 net). Only ever used
 *  when Square hasn't settled the payment yet and can't tell us the real fee. */
const FEE_RATE = 0.029;
const FEE_FIXED_CENTS = 30;

// ── band math ───────────────────────────────────────────────────────────────

/**
 * Which refund band a cancellation falls into, from the notice the client gave.
 *
 * Negative notice (cancelled after the appointment should have started) lands in
 * under_12h, which is correct: they gave less than no warning.
 */
function computeBand(noticeMinutes) {
  if (noticeMinutes >= OVER_24H_MINUTES) return "over_24h";
  if (noticeMinutes >= UNDER_12H_MINUTES) return "12_to_24h";
  return "under_12h";
}

/** Square's fee had it settled: 2.9% + 30¢, rounded to whole cents. */
function estimateFeeCents(amountCents) {
  return Math.round(amountCents * FEE_RATE) + FEE_FIXED_CENTS;
}

/**
 * What this band says to refund.
 *
 * The 12–24h band nets the processing fee off, so the client absorbs Square's
 * cut rather than Lionel. Guarded at zero — a fee larger than the deposit would
 * otherwise produce a negative refund.
 */
function recommendedCents({ band, depositCents, feeCents }) {
  if (band === "over_24h") return depositCents;
  if (band === "under_12h") return 0;
  return Math.max(0, depositCents - (feeCents || 0));
}

/**
 * The real fee from Square, or an estimate when the payment hasn't settled.
 *
 * Also reports whether Square already shows a refund against this payment —
 * the authoritative answer to "did we already give this money back", which the
 * local ledger can't supply (refund rows key on the REFUND id, not the payment).
 */
async function resolveFeeAndRefundState(paymentId, depositCents) {
  const payment = await getPayment(paymentId);
  if (!payment) {
    return {
      feeCents: estimateFeeCents(depositCents),
      feeIsEstimate: true,
      alreadyRefundedCents: 0,
      paymentReadable: false,
    };
  }
  return {
    feeCents: payment.feeCents != null ? payment.feeCents : estimateFeeCents(depositCents),
    feeIsEstimate: payment.feeCents == null,
    alreadyRefundedCents: payment.refundedCents || 0,
    paymentReadable: true,
  };
}

// ── formatting ──────────────────────────────────────────────────────────────

function formatMoney(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatShopDateTime(iso) {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", timeZone: SHOP_TZ,
  });
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: SHOP_TZ,
  });
  return `${date} ${time}`;
}

/** "12 days 20 hours" / "3 hours" / "45 minutes" — for the push and the screen. */
function formatNotice(noticeMinutes) {
  if (noticeMinutes < 0) return "after the appointment time";
  const days = Math.floor(noticeMinutes / 1440);
  const hours = Math.floor((noticeMinutes % 1440) / 60);
  const mins = noticeMinutes % 60;
  if (days > 0) {
    return hours > 0
      ? `${days} day${days === 1 ? "" : "s"} ${hours} hour${hours === 1 ? "" : "s"}`
      : `${days} day${days === 1 ? "" : "s"}`;
  }
  if (hours > 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${mins} minute${mins === 1 ? "" : "s"}`;
}

// ── request creation (Phase 1) ──────────────────────────────────────────────

/**
 * Queue a refund decision for a cancelled appointment, if one is warranted.
 *
 * Returns a `{ skipped: reason }` shape for every no-op path rather than
 * throwing. Cancellations are overwhelmingly NOT deposit bookings, so the
 * common case here is a quiet skip and it must stay cheap and silent.
 *
 * `cancelledAt` is the moment we learned of the cancellation. It is stored, and
 * the derived notice is stored with it, so the band can never drift as the
 * request sits in the queue waiting for Lionel.
 */
async function createRequestForCancellation({
  appointmentId,
  calendarId,
  contactId,
  contactName,
  appointmentStart,
  serviceLabel,
  cancelledAt = new Date(),
}) {
  if (!appointmentId) return { skipped: "no-appointment-id" };
  if (calendarId !== REFUNDABLE_CALENDAR_ID) return { skipped: "not-deposit-calendar" };
  if (!appointmentStart) return { skipped: "no-appointment-start" };

  // The deposit row is the whole reason a refund exists. No row → nothing was
  // ever charged (phone/walk-in/manual booking) → silent no-op, by decision.
  const { data: deposit, error: depositErr } = await supabase
    .from("transactions")
    .select("id, contact_id, contact_name, artist_ghl_id, gross_amount, shop_amount, artist_amount, shop_percentage, artist_percentage, location_id, square_payment_id, notes")
    .eq("appointment_id", appointmentId)
    .eq("transaction_type", "deposit")
    .is("superseded_by", null)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();

  if (depositErr) {
    console.error(`[depositRefund] deposit lookup failed for ${appointmentId}: ${depositErr.message}`);
    return { skipped: "deposit-lookup-failed" };
  }
  if (!deposit || !deposit.square_payment_id) return { skipped: "no-deposit" };

  const depositCents = Math.round(Number(deposit.gross_amount) * 100);
  if (!(depositCents > 0)) return { skipped: "zero-deposit" };

  const start = new Date(appointmentStart);
  const cancelled = new Date(cancelledAt);
  const noticeMinutes = Math.round((start - cancelled) / 60000);
  const band = computeBand(noticeMinutes);

  const { feeCents, feeIsEstimate, alreadyRefundedCents } =
    await resolveFeeAndRefundState(deposit.square_payment_id, depositCents);

  // Square is the authority on whether this money already went back. Skip
  // rather than queueing a request that could double-refund on approval.
  if (alreadyRefundedCents >= depositCents) {
    console.log(`[depositRefund] ${appointmentId}: already refunded at Square — skipping`);
    return { skipped: "already-refunded" };
  }

  const recommended = recommendedCents({ band, depositCents, feeCents });

  const row = {
    appointment_id: appointmentId,
    contact_id: contactId || deposit.contact_id,
    contact_name: contactName || deposit.contact_name || "Unknown",
    calendar_id: calendarId,
    service_label: serviceLabel || null,
    transaction_id: deposit.id,
    square_payment_id: deposit.square_payment_id,
    deposit_cents: depositCents,
    appointment_start: start.toISOString(),
    cancelled_at: cancelled.toISOString(),
    notice_minutes: noticeMinutes,
    band,
    recommended_cents: recommended,
    fee_cents: feeCents,
    fee_is_estimate: feeIsEstimate,
    status: "pending",
  };

  const { data: inserted, error: insertErr } = await supabase
    .from("deposit_refund_requests")
    .insert(row)
    .select()
    .maybeSingle();

  if (insertErr) {
    // 23505 = the unique index doing its job on a replayed webhook. GHL retries
    // freely, so this is an expected outcome, not a fault.
    if (insertErr.code === "23505") return { skipped: "already-queued" };
    console.error(`[depositRefund] insert failed for ${appointmentId}: ${insertErr.message}`);
    return { skipped: "insert-failed", error: insertErr.message };
  }

  console.log(
    `[depositRefund] queued ${inserted.id} — ${row.contact_name}, ${band}, ` +
    `${formatMoney(recommended)} of ${formatMoney(depositCents)}`
  );

  // Push is a nudge, never the record. A failed push must not lose the request.
  await notifyOwner(inserted).catch((err) =>
    console.error(`[depositRefund] push failed (non-fatal): ${err.message}`)
  );

  return { created: true, request: inserted };
}

/**
 * Push Lionel. Fires for every band including under_12h — an open chair is worth
 * knowing about even when no money moves (plan decision #8).
 */
async function notifyOwner(request) {
  const isRefundable = request.recommended_cents > 0;
  const when = formatShopDateTime(request.appointment_start);
  const notice = formatNotice(request.notice_minutes);

  const body = isRefundable
    ? `${when} · ${notice} notice · ${formatMoney(request.recommended_cents)} refund pending`
    : `${when} · ${notice} notice · deposit kept, no action needed`;

  return sendPushToGhlUser(OWNER_GHL_USER_ID, {
    type: "deposit_refund_request",
    title: `${request.contact_name} canceled`,
    body,
    contactId: request.contact_id,
    appointmentId: request.appointment_id,
    // Drives the brand switch when tapped from tattoo mode.
    locationId: process.env.GHL_BARBER_LOCATION_ID || "GLRkNAxfPtWTqTiN83xj",
    data: { requestId: request.id },
  });
}

// ── approval (Phase 2) ──────────────────────────────────────────────────────

/** Shape one row for the app. Money stays in cents; the client formats it. */
function serializeRequest(r) {
  return {
    id: r.id,
    contactId: r.contact_id,
    contactName: r.contact_name,
    appointmentId: r.appointment_id,
    serviceLabel: r.service_label,
    appointmentStart: r.appointment_start,
    cancelledAt: r.cancelled_at,
    noticeMinutes: r.notice_minutes,
    noticeLabel: formatNotice(r.notice_minutes),
    band: r.band,
    depositCents: r.deposit_cents,
    feeCents: r.fee_cents,
    feeIsEstimate: r.fee_is_estimate,
    recommendedCents: r.recommended_cents,
    // Every amount the server will accept, so the app never has to do this math
    // and can render all three options with the right one pre-selected.
    options: {
      full: r.deposit_cents,
      minusFee: Math.max(0, r.deposit_cents - (r.fee_cents || 0)),
      none: 0,
    },
    status: r.status,
    approvedCents: r.approved_cents,
    approvedAt: r.approved_at,
    declinedAt: r.declined_at,
    squareRefundId: r.square_refund_id,
    error: r.error,
    createdAt: r.created_at,
  };
}

async function listRequests({ status, limit = 50 } = {}) {
  let q = supabase
    .from("deposit_refund_requests")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (status) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) throw new Error(`listRequests failed: ${error.message}`);

  const rows = (data || []).map(serializeRequest);
  // Pending first — that's the work. Everything else is history.
  rows.sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1));
  return rows;
}

async function getRequest(id) {
  const { data, error } = await supabase
    .from("deposit_refund_requests")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getRequest failed: ${error.message}`);
  return data ? serializeRequest(data) : null;
}

/**
 * Issue the refund Lionel approved.
 *
 * The order here matters and is not negotiable: CLAIM the row first (pending →
 * processing, conditionally), and only call Square if the claim actually took.
 * Charging first and recording after is how you get a double refund when two
 * taps race — the same failure mode that has bitten alert sends in this codebase.
 *
 * @param {string} requestId
 * @param {number} amountCents  Must be one of the three amounts the server offers.
 */
async function approveRequest({ requestId, amountCents }) {
  const { data: row, error: readErr } = await supabase
    .from("deposit_refund_requests")
    .select("*")
    .eq("id", requestId)
    .maybeSingle();

  if (readErr) throw new Error(`approve read failed: ${readErr.message}`);
  if (!row) return { ok: false, code: "not_found" };
  if (row.status === "refunded") return { ok: false, code: "already_refunded" };
  if (row.status === "processing") return { ok: false, code: "in_flight" };
  if (row.status === "declined") return { ok: false, code: "declined" };

  // Never trust a client-supplied amount. Only the three amounts this request
  // actually offers are acceptable — a tampered call can't refund more than the
  // client ever paid, or turn a no-refund band into a payout by guessing a number.
  const allowed = new Set([
    row.deposit_cents,
    Math.max(0, row.deposit_cents - (row.fee_cents || 0)),
    0,
  ]);
  const amount = Number(amountCents);
  if (!Number.isInteger(amount) || !allowed.has(amount)) {
    return { ok: false, code: "invalid_amount", allowed: [...allowed].sort((a, b) => b - a) };
  }

  // Approving $0 is a decline that went through the refund button.
  if (amount === 0) return declineRequest({ requestId });

  // ── the claim ──
  const { data: claimed, error: claimErr } = await supabase
    .from("deposit_refund_requests")
    .update({ status: "processing", updated_at: new Date().toISOString() })
    .eq("id", requestId)
    .in("status", ["pending", "failed"])
    .select()
    .maybeSingle();

  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);
  if (!claimed) return { ok: false, code: "in_flight" };

  let refund;
  try {
    refund = await refundPayment({
      paymentId: row.square_payment_id,
      amountCents: amount,
      // Deterministic per request, so a retry of the SAME request can never
      // produce a second refund at Square even if our row got confused.
      idempotencyKey: `bkrf-${requestId}`.slice(0, 45),
      reason: "Barbershop deposit refund — client canceled",
    });
  } catch (err) {
    await supabase
      .from("deposit_refund_requests")
      .update({ status: "failed", error: err.message, updated_at: new Date().toISOString() })
      .eq("id", requestId);
    console.error(`[depositRefund] Square refund failed for ${requestId}: ${err.message}`);
    return { ok: false, code: "square_failed", error: err.message };
  }

  // Money has moved. Everything below is bookkeeping — it must never throw in a
  // way that makes the caller think the refund didn't happen.
  const ledger = await postRefundLedgerRow({ request: row, refund, amountCents: amount });
  await mirrorRefundToRentTracker({ request: row, refund, amountCents: amount });

  const { data: finalRow } = await supabase
    .from("deposit_refund_requests")
    .update({
      status: "refunded",
      approved_cents: amount,
      approved_at: new Date().toISOString(),
      square_refund_id: refund.refundId,
      refund_transaction_id: ledger?.id || null,
      error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId)
    .select()
    .maybeSingle();

  console.log(
    `[depositRefund] REFUNDED ${formatMoney(amount)} to ${row.contact_name} — ` +
    `refund=${refund.refundId} status=${refund.status}`
  );

  return {
    ok: true,
    refundId: refund.refundId,
    squareStatus: refund.status,
    amountCents: amount,
    ledgerRecorded: !!ledger,
    request: finalRow ? serializeRequest(finalRow) : null,
  };
}

async function declineRequest({ requestId }) {
  const { data, error } = await supabase
    .from("deposit_refund_requests")
    .update({
      status: "declined",
      approved_cents: 0,
      declined_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId)
    .in("status", ["pending", "failed"])
    .select()
    .maybeSingle();

  if (error) throw new Error(`decline failed: ${error.message}`);
  if (!data) return { ok: false, code: "not_pending" };
  return { ok: true, request: serializeRequest(data) };
}

// ── ledger mirrors ──────────────────────────────────────────────────────────

/**
 * Post the refund as a NEW positive-gross `refund` row.
 *
 * Two constraints, both learned the hard way:
 *   - gross_amount has a CHECK (>= 0), so refunds store POSITIVE and the math
 *     engine flips the sign off transaction_type.
 *   - square_payment_id must be the REFUND id, not the payment id — the unique
 *     index on (square_payment_id, location_id) collides otherwise.
 *
 * The split is scaled from the deposit's PERCENTAGES rather than copying its
 * amounts, because a 12–24h refund is partial: copying $40 of artist_amount
 * onto a $38.54 refund would leave $1.46 of phantom debt on the books forever.
 */
async function postRefundLedgerRow({ request, refund, amountCents }) {
  try {
    const { data: deposit } = await supabase
      .from("transactions")
      .select("contact_id, contact_name, artist_ghl_id, shop_percentage, artist_percentage, location_id")
      .eq("id", request.transaction_id)
      .maybeSingle();

    if (!deposit) {
      console.error(`[depositRefund] original deposit ${request.transaction_id} vanished — ledger row skipped`);
      return null;
    }

    const dollars = amountCents / 100;
    const shopPct = Number(deposit.shop_percentage) || 0;
    const artistPct = Number(deposit.artist_percentage) || 0;

    return await recordTransaction({
      contactId: deposit.contact_id,
      contactName: request.contact_name || deposit.contact_name || "Unknown",
      appointmentId: request.appointment_id,
      artistId: deposit.artist_ghl_id,
      transactionType: "refund",
      paymentMethod: "square",
      paymentRecipient: "shop",
      grossAmount: dollars,
      squarePaymentId: refund.refundId,
      locationId: deposit.location_id,
      sessionDate: new Date().toISOString(),
      notes: `Refund ${refund.refundId} for deposit payment ${request.square_payment_id} — booking cancellation (${request.band})`,
      shopPercentageOverride: shopPct,
      artistPercentageOverride: artistPct,
      shopAmountOverride: Math.round(dollars * shopPct) / 100,
      artistAmountOverride: Math.round(dollars * artistPct) / 100,
    });
  } catch (err) {
    console.error(`[depositRefund] ledger row failed for ${refund.refundId}: ${err.message}`);
    return null;
  }
}

/**
 * Mirror into the rent tracker as a negative row so the weekly tile nets out.
 *
 * `location: "barbershop"` — the tattoo refund flow hardcodes "tattoo" here,
 * which would file Lionel's barbershop money under the wrong business.
 */
async function mirrorRefundToRentTracker({ request, refund, amountCents }) {
  try {
    const { writeServiceIncome } = require("../rentTracker/serviceIncomeWriter");
    return await writeServiceIncome({
      senderName: request.contact_name || "Unknown",
      amount: -(amountCents / 100),
      method: "square",
      type: "refund",
      paidAt: new Date(),
      notes: `Refund ${refund.refundId} for booking deposit ${request.square_payment_id}`,
      // Dedup on the REFUND id so a retry can't double-write.
      squarePaymentId: refund.refundId,
      location: "barbershop",
      barberGhlId: OWNER_GHL_USER_ID,
    });
  } catch (err) {
    console.warn(`[depositRefund] rent-tracker mirror failed for ${refund.refundId}: ${err.message}`);
    return { skipped: "error", error: err.message };
  }
}

module.exports = {
  REFUNDABLE_CALENDAR_ID,
  OWNER_GHL_USER_ID,
  computeBand,
  estimateFeeCents,
  recommendedCents,
  formatNotice,
  createRequestForCancellation,
  listRequests,
  getRequest,
  approveRequest,
  declineRequest,
};
