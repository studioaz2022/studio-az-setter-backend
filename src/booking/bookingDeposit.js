// ─── Booking deposit: charge, rollback, ledger ───
//
// Phase 2 of BOOKING_DEPOSIT_PLAN.md. Lionel only, 50%, Square.
//
// Order is book → charge, because GHL's slot validation is what serialises the
// race and because the failure that's left over is cheap: an unpaid appointment
// can be deleted for free, whereas a charge with no appointment costs a refund
// and days of settlement.
//
// The rollback is NOT a plain delete. Verified live (plan §"The rollback"):
// deleting an appointment does NOT pull the contact out of the confirmation
// workflow — the text still went out 14s AFTER the delete. Marking the
// appointment `invalid` DOES (Lionel wired a status-trigger workflow for it),
// and also frees the slot immediately. So: invalid → settle → delete.

const { createClient } = require("@supabase/supabase-js");
const { ghlBarber } = require("../clients/ghlMultiLocationSdk");
const {
  createDepositLinkForContact,
  processCheckoutPayment,
  refundPayment,
} = require("../payments/squareClient");
const { formatCents } = require("./depositConfig");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID;

// The confirmation workflow fires at ~34s (measured, not assumed). Bound the
// charge well inside that so a rollback still beats the text out the door.
const CHARGE_TIMEOUT_MS = 25_000;
// Give Lionel's invalid-status workflow time to pull the contact before the
// delete removes the record it triggers on.
const INVALID_SETTLE_MS = 4_000;

/** Square decline codes → our taxonomy. Anything unrecognised stays generic. */
const SQUARE_ERROR_MAP = {
  CARD_DECLINED: "card_declined",
  GENERIC_DECLINE: "card_declined",
  CARD_DECLINED_CALL_ISSUER: "card_declined",
  CARD_DECLINED_VERIFICATION_REQUIRED: "card_declined",
  INSUFFICIENT_FUNDS: "insufficient_funds",
  EXPIRED_CARD: "card_expired",
  CVV_FAILURE: "cvv_failure",
  ADDRESS_VERIFICATION_FAILURE: "postal_failure",
  INVALID_CARD: "card_declined",
  INVALID_CARD_DATA: "card_declined",
  CARD_EXPIRED: "card_expired",
  PAN_FAILURE: "card_declined",
};

/**
 * Pull a usable reason out of a Square axios error. Square nests its real code
 * at response.data.errors[].code; everything else is noise.
 */
function mapSquareError(err) {
  const errors = err?.response?.data?.errors || [];
  for (const e of errors) {
    const mapped = SQUARE_ERROR_MAP[e.code];
    if (mapped) return { code: mapped, squareCode: e.code, detail: e.detail || e.code };
  }
  if (err?.__timeout) return { code: "payment_timeout", squareCode: null, detail: "charge exceeded guard" };
  const first = errors[0];
  return {
    code: "payment_failed",
    squareCode: first?.code || null,
    detail: first?.detail || err?.message || "unknown Square error",
  };
}

/** Reject after ms, tagging the error so mapSquareError can tell it apart. */
function withTimeout(promise, ms) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`timed out after ${ms}ms`);
      e.__timeout = true;
      reject(e);
    }, ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * Create the Square order (carrying the metadata the rent tracker and the
 * Earnings tab attribute on) and charge the customer's token against it.
 *
 * Throws with `.bookingError` set to a taxonomy code. On timeout the charge may
 * still have landed at Square, so the caller MUST reconcile rather than assume
 * nothing happened.
 */
async function chargeDeposit({
  contactId,
  contactName,
  email,
  amountCents,
  serviceLabel,
  barberName,
  artistUserId,
  sourceId,
}) {
  // 1. order + checkout session — metadata is what keeps barbershop money
  //    distinguishable from tattoo money in one shared Square account
  const session = await createDepositLinkForContact({
    contactId,
    contactName,
    amountCents,
    description: `${serviceLabel} with ${barberName} — 50% deposit`,
    business: "barbershop",
    paymentType: "deposit",
    artistId: artistUserId,
    artistName: barberName,
  });

  // createDepositLinkForContact returns { url, paymentLinkId, orderId } —
  // paymentLinkId IS the checkout-session id processCheckoutPayment expects.
  const sessionId = session.paymentLinkId;
  if (!sessionId) {
    const e = new Error("Square session was created without an id");
    e.bookingError = "payment_failed";
    throw e;
  }

  // 2. charge the Web Payments SDK token against that order
  try {
    const paid = await withTimeout(
      processCheckoutPayment(sessionId, sourceId, email),
      CHARGE_TIMEOUT_MS
    );
    return {
      sessionId,
      paymentId: paid.paymentId,
      orderId: session.orderId || null,
      receiptUrl: paid.receiptUrl || null,
    };
  } catch (err) {
    const mapped = mapSquareError(err);
    const e = new Error(mapped.detail);
    e.bookingError = mapped.code;
    e.squareCode = mapped.squareCode;
    e.sessionId = sessionId;
    e.timedOut = !!err.__timeout;
    throw e;
  }
}

/**
 * Undo an appointment we created but couldn't charge for.
 *
 * `invalid` is the load-bearing step: it stops the confirmation text AND frees
 * the slot. The delete is cosmetic tidying, so a failure there is logged and
 * swallowed — the customer is already whole either way.
 *
 * round_robin calendars reject an edit that omits calendarId/assignedUserId,
 * so both are always sent (see the ghl-edit-appointment-not-partial note).
 */
async function rollbackAppointment({ appointmentId, calendarId, assignedUserId }) {
  const result = { markedInvalid: false, deleted: false, error: null };
  try {
    await ghlBarber.calendars.editAppointment(
      { eventId: appointmentId },
      {
        calendarId,
        assignedUserId,
        locationId: LOCATION_ID,
        appointmentStatus: "invalid",
        toNotify: false,
      }
    );
    result.markedInvalid = true;
  } catch (err) {
    result.error = `invalid-mark failed: ${err?.response?.data?.message || err?.message}`;
    console.error(`[deposit] ROLLBACK could not mark ${appointmentId} invalid —`, result.error);
    return result; // no point deleting: that would leave the text un-cancelled
  }

  await new Promise((r) => setTimeout(r, INVALID_SETTLE_MS));

  try {
    await ghlBarber.calendars.deleteEvent({ eventId: appointmentId });
    result.deleted = true;
  } catch (err) {
    // Harmless: `invalid` already freed the slot and killed the text.
    console.warn(
      `[deposit] appointment ${appointmentId} marked invalid but not deleted —`,
      err?.response?.data?.message || err?.message
    );
  }
  return result;
}

/**
 * A charge that timed out may still have succeeded. Refund it if it did, so we
 * never hold money for an appointment that was rolled back.
 */
async function refundOrphanedCharge({ sessionId, amountCents, reason }) {
  try {
    const { data } = await supabase
      .from("checkout_sessions")
      .select("square_payment_id,status")
      .eq("id", sessionId)
      .maybeSingle();
    if (!data?.square_payment_id) return { refunded: false, reason: "no payment landed" };

    const refund = await refundPayment({
      paymentId: data.square_payment_id,
      amountCents,
      idempotencyKey: `bk-rb-${sessionId}`.slice(0, 45),
      reason: reason || "Booking could not be completed",
    });
    console.log(`[deposit] refunded orphaned charge ${data.square_payment_id} → ${refund.status}`);
    return { refunded: true, refundId: refund.refundId, paymentId: data.square_payment_id };
  } catch (err) {
    console.error("[deposit] REFUND FAILED — needs manual attention:", err?.message);
    return { refunded: false, error: err?.message };
  }
}

/**
 * Write the deposit into `transactions`.
 *
 * This does not happen by itself: squareTransactionSync polls each barber's OWN
 * Square account, and this money is in the SHOP's, which that sync never reads.
 * Without this row the deposit is invisible to both the rent tracker and the
 * iOS Earnings tab.
 *
 * `service_price` is the DEPOSIT amount, never the full service price — the
 * Earnings endpoint sums service_price across every row, so the balance paid in
 * the chair supplies the other half. Putting $80 here would report $120 of
 * revenue on an $80 haircut. tip_amount is 0: nobody tips a deposit.
 */
async function recordDepositTransaction({
  contactId,
  contactName,
  appointmentId,
  calendarId,
  artistUserId,
  amountCents,
  squarePaymentId,
  squareOrderId,
  serviceLabel,
  slotISO,
}) {
  const amount = amountCents / 100;
  const row = {
    contact_id: contactId,
    contact_name: contactName || "Website booking",
    appointment_id: appointmentId,
    artist_ghl_id: artistUserId,
    transaction_type: "deposit", // keeps it out of session-payment sums
    payment_method: "square",
    payment_recipient: "shop", // money sits in the shop's Square balance
    gross_amount: amount,
    service_price: amount, // the deposit paid, NOT the full service price
    tip_amount: 0,
    shop_percentage: 0, // booth renter keeps all of it
    artist_percentage: 100,
    shop_amount: 0,
    artist_amount: amount,
    settlement_status: "pending", // shop owes Lionel until settled
    square_payment_id: squarePaymentId,
    square_order_id: squareOrderId,
    calendar_id: calendarId,
    location_id: LOCATION_ID,
    session_date: slotISO ? slotISO.slice(0, 10) : null,
    notes: `Website deposit — ${serviceLabel} (${formatCents(amountCents)})`,
    environment: "production",
  };

  const { data, error } = await supabase
    .from("transactions")
    .insert(row)
    .select("id")
    .maybeSingle();

  if (error) {
    // The booking and the charge both succeeded; a missing ledger row is a
    // reporting problem, not a customer problem. Loud, but never fatal.
    console.error("[deposit] FAILED to write transactions row —", error.message, {
      squarePaymentId,
      appointmentId,
    });
    return { recorded: false, error: error.message };
  }
  return { recorded: true, transactionId: data?.id || null };
}

module.exports = {
  CHARGE_TIMEOUT_MS,
  chargeDeposit,
  rollbackAppointment,
  refundOrphanedCharge,
  recordDepositTransaction,
  mapSquareError,
};
