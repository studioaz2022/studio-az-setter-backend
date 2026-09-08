// cashOut.js
//
// One day, one shape: everything the Cash Out screen needs in a single object,
// assembled from the DATABASE.
//
// The screen it replaces built its payment list from `syncResult` — the live
// Square sync response — rather than from our own rows. That is why a payment
// which already had a transaction row could never appear as assignable: the sync
// dedups on square_payment_id, so a stored payment is skipped and never reaches
// the client. Measured 2026-09-08: the API returned 15 Venmo payments, the app
// logged "9 payments in scope" and "9 unconfirmed payments remain", and ZERO
// rendered. Unmatched appointments had no payment anywhere to match against.
//
// So the rule here is simple and absolute: **the database is the source of
// truth for what happened on a day.** The Square sync's job is to get rows into
// the database; it is not a view model.
//
// Shape (see REVIEW_WINDOW_REBUILD_PLAN.md §12.1):
//   visits[]    — the day's appointments, time-ordered, each with its payments
//   orphans[]   — money on this day that no visit on this day claims
//   cancelled[] — context, collapsed in the UI, cannot take a payment
//   totals      — counts, including the one definition of "open"

const { supabase } = require("../clients/supabaseClient");

const BARBER_TZ = "America/Chicago";

/** Local (shop-timezone) YYYY-MM-DD for an instant. */
function localDay(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BARBER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date instanceof Date ? date : new Date(date));
}

/** Shift a YYYY-MM-DD string by n days without tripping over DST. */
function shiftDay(dayStr, n) {
  const [y, m, d] = dayStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

const BLOCKED_TITLES = ["break", "block", "blocked", "lunch", "personal", "off"];
const isBlockedTitle = (t) => BLOCKED_TITLES.includes((t || "").toLowerCase().trim());

/**
 * A payment that was hidden as "not the barbershop's".
 *
 * Lionel runs ONE Square account taking both his own haircut money and tattoo
 * deposits collected for the tattoo shop. fetchSquareOrderDetails() already
 * skips the obvious tattoo tickets; anything that slips through gets hidden here
 * permanently rather than nagging forever. Reversible in one statement:
 *   update transactions set reviewed_at = null
 *   where reviewed_by = 'hidden:not_barbershop';
 */
const HIDDEN_BY = "hidden:not_barbershop";

/**
 * Everything the Cash Out screen shows for one barber on one local day.
 *
 * @param {string} barberGhlId
 * @param {string} day  YYYY-MM-DD, shop-local
 */
async function getCashOutDay(barberGhlId, day) {
  // Appointments: pull a wide UTC window and narrow by LOCAL day, because a
  // shop-local day is not a UTC day and an evening appointment would otherwise
  // fall out.
  const windowStart = new Date(`${shiftDay(day, -1)}T00:00:00Z`).toISOString();
  const windowEnd = new Date(`${shiftDay(day, 2)}T00:00:00Z`).toISOString();

  const [apptRes, txRes] = await Promise.all([
    supabase
      .from("appointments")
      .select("id, title, contact_id, calendar_id, start_time, end_time, status, payment_resolution, payment_resolved_at, payment_resolved_by, payment_covered_by")
      .eq("assigned_user_id", barberGhlId)
      .gte("start_time", windowStart)
      .lt("start_time", windowEnd),
    supabase
      .from("transactions")
      .select("id, appointment_id, contact_id, contact_name, gross_amount, service_price, tip_amount, payment_method, transaction_type, session_date, square_payment_time, created_at, square_payment_id, venmo_transaction_id, service_item_count, order_line_items, reviewed_at, reviewed_by, notes")
      .eq("artist_ghl_id", barberGhlId)
      .eq("session_date", day)
      .is("deleted_at", null)
      .is("superseded_by", null),
  ]);

  if (apptRes.error) throw new Error(`Appointment load failed: ${apptRes.error.message}`);
  if (txRes.error) throw new Error(`Transaction load failed: ${txRes.error.message}`);

  const allAppts = (apptRes.data || []).filter(
    (a) => localDay(a.start_time) === day && !isBlockedTitle(a.title)
  );
  const allTx = txRes.data || [];

  // "new" is excluded from visits for the same reason it was removed from the
  // Square matcher: over Jun-Sep 2026, 185 past appointments sat at "new" and
  // exactly ONE ever received a payment. They are bookings that never happened.
  const visitAppts = allAppts
    .filter((a) => ["confirmed", "showed"].includes(a.status))
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time));

  const cancelledAppts = allAppts.filter((a) => ["cancelled", "noshow"].includes(a.status));

  // Index payments by the appointment they claim.
  const byAppt = new Map();
  for (const t of allTx) {
    if (!t.appointment_id) continue;
    if (!byAppt.has(t.appointment_id)) byAppt.set(t.appointment_id, []);
    byAppt.get(t.appointment_id).push(t);
  }

  const shapePayment = (t) => ({
    transactionId: t.id,
    amount: Number(t.gross_amount) || 0,
    servicePrice: t.service_price != null ? Number(t.service_price) : null,
    tip: t.tip_amount != null ? Number(t.tip_amount) : null,
    method: t.payment_method,
    type: t.transaction_type,
    paidAt: t.square_payment_time || t.created_at,
    payerName: t.contact_name || null,
    contactId: t.contact_id || null,
    coversServices: t.service_item_count || null,
    lineItems: t.order_line_items || null,
    notes: t.notes || null,
    // The day the money actually landed, when we genuinely know it.
    //
    // ONLY set when there is a real payment timestamp. Cash and other manual
    // entries have no square_payment_time, so created_at is when the barber
    // typed it in — a Sep 2 cash payment recorded on Sep 7 would otherwise be
    // labelled "arrived Sep 7", which is a lie about the client rather than a
    // fact about the money. Null means "we only know the session date".
    arrivedOn: t.square_payment_time ? localDay(t.square_payment_time) : null,
  });

  // Index every payment on the day by its own id, so a visit that was covered
  // by another ticket can name the ticket instead of gesturing at it. A covered
  // visit is reconciled — the money exists, it just sits on a sibling — and the
  // app can only say so if it knows which sibling.
  const txById = new Map(allTx.map((t) => [t.id, t]));

  const visits = visitAppts.map((a) => {
    const payments = (byAppt.get(a.id) || []).map(shapePayment);
    const paid = payments.filter((p) => p.type !== "refund");

    let status;
    if (a.payment_resolution) status = "resolved";
    else if (paid.length === 0) status = "no_payment";
    else if (paid.length > 1) status = "multi_payment";
    else status = "settled";

    return {
      appointmentId: a.id,
      clientName: clientNameFromTitle(a.title),
      serviceName: serviceFromTitle(a.title),
      rawTitle: a.title,
      contactId: a.contact_id,
      calendarId: a.calendar_id,
      startTime: a.start_time,
      endTime: a.end_time,
      status,
      resolution: a.payment_resolution || null,
      resolvedBy: a.payment_resolved_by || null,
      coveredByTransactionId: a.payment_covered_by || null,
      // Null when the covering ticket is not on this day — rare, and the app
      // falls back to "another ticket" rather than inventing one.
      coveredBy:
        a.payment_resolution === "covered" && a.payment_covered_by && txById.has(a.payment_covered_by)
          ? shapePayment(txById.get(a.payment_covered_by))
          : null,
      payments,
      total: Math.round(paid.reduce((s, p) => s + p.amount, 0) * 100) / 100,
      // Open = still wants a human decision. A resolved appointment does not.
      isOpen: status === "no_payment" && !a.payment_resolution,
    };
  });

  // Orphans: money on this day that no visit on this day claims.
  const visitApptIds = new Set(visitAppts.map((a) => a.id));
  const orphans = allTx
    .filter((t) => !t.appointment_id || !visitApptIds.has(t.appointment_id))
    .filter((t) => t.reviewed_by !== HIDDEN_BY)
    .map((t) => {
      const p = shapePayment(t);

      // A product sale or a deposit for a future booking is not incomplete —
      // it legitimately has no visit today. Showing it keeps the day's money
      // complete (this is a cash-out, the drawer should add up) while
      // needsAttention keeps it out of the work pile.
      let reason;
      let needsAttention;
      if (t.transaction_type === "product_sale") {
        reason = "Product sale — no appointment by nature";
        needsAttention = false;
      } else if (t.transaction_type === "deposit") {
        reason = t.appointment_id
          ? "Deposit for a booking on another day"
          : "Deposit — no booking linked yet";
        needsAttention = !t.appointment_id;
      } else if (t.appointment_id) {
        reason = "Belongs to a visit on another day";
        needsAttention = false;
      } else if (t.contact_id === "walk_in") {
        reason = "Walk-in — no appointment";
        needsAttention = false;
      } else if (!t.contact_id || t.contact_id === "venmo_unmatched") {
        reason = "No client on this payment";
        needsAttention = true;
      } else {
        reason = "Not assigned to a visit";
        needsAttention = true;
      }

      // An answered question is not an open one. Once a barber has said what a
      // payment is — a walk-in, or simply "yes, I know" — it keeps its place in
      // the day's money but stops asking. Without this the same orphan is
      // raised on every sweep forever, which is exactly how the old Venmo queue
      // accumulated 32 payments going back to February.
      if (t.reviewed_at) needsAttention = false;

      return { ...p, reason, needsAttention, linkedAppointmentId: t.appointment_id || null };
    })
    .sort((a, b) => new Date(a.paidAt) - new Date(b.paidAt));

  const openVisits = visits.filter((v) => v.isOpen).length;
  const openOrphans = orphans.filter((o) => o.needsAttention).length;

  return {
    date: day,
    visits,
    orphans,
    cancelled: cancelledAppts.map((a) => ({
      appointmentId: a.id,
      clientName: clientNameFromTitle(a.title),
      startTime: a.start_time,
      status: a.status,
    })),
    totals: {
      visits: visits.length,
      payments: allTx.length,
      collected: Math.round(allTx.filter((t) => t.transaction_type !== "refund")
        .reduce((s, t) => s + (Number(t.gross_amount) || 0), 0) * 100) / 100,
      openVisits,
      openOrphans,
      // THE definition of "open" for this day. The week strip, the Earnings
      // ledger line and this screen must all use this number and no other.
      openItems: openVisits + openOrphans,
      settled: openVisits + openOrphans === 0,
    },
  };
}

/**
 * Per-day marks for the week strip. Same "open" definition as getCashOutDay —
 * deliberately the same code path rather than a parallel count, because two
 * definitions of "open" is how the old screen ended up saying "No payments"
 * next to seven payment cards.
 */
async function getCashOutWeek(barberGhlId, startDay) {
  const days = Array.from({ length: 7 }, (_, i) => shiftDay(startDay, i));
  const today = localDay(new Date());

  const results = await Promise.all(
    days.map(async (d) => {
      if (d > today) {
        return { date: d, isFuture: true, hasActivity: false, openItems: 0, settled: false };
      }
      const day = await getCashOutDay(barberGhlId, d);
      return {
        date: d,
        isFuture: false,
        hasActivity: day.totals.visits > 0 || day.totals.payments > 0,
        openItems: day.totals.openItems,
        settled: day.totals.settled && (day.totals.visits > 0 || day.totals.payments > 0),
        collected: day.totals.collected,
      };
    })
  );

  return { start: startDay, days: results };
}

/**
 * Plain-English label for a payment landing on a different day than its visit.
 *
 * "the night before" beats "2026-09-03" for someone standing at a chair, and it
 * is the actual shape of the problem: Venmo regulars here pay at 03:01, 03:45,
 * 01:24 — technically the next day, obviously the same night.
 */
function adjacentLabel(fromDay, toDay) {
  const diff = Math.round(
    (new Date(`${toDay}T12:00:00Z`) - new Date(`${fromDay}T12:00:00Z`)) / 86400000
  );
  if (diff === 0) return "same day";
  if (diff === -1) return "the day before";
  if (diff === 1) return "the next day";
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", weekday: "long",
  }).format(new Date(`${toDay}T12:00:00Z`));
  return weekday;
}

// ── Title parsing ───────────────────────────────────────────────────────────
// GHL titles arrive as " Haircut: Sam Stevens", "Sam Stevens ", or
// "Haircut (F&F): Matthew Murphy". The person is what matters on a row.

function clientNameFromTitle(title) {
  const raw = (title || "").trim();
  if (!raw) return "Client";
  const colon = raw.indexOf(":");
  if (colon !== -1) {
    const after = raw.slice(colon + 1).trim();
    if (after) return after;
  }
  const dash = raw.indexOf(" - ");
  if (dash !== -1) return raw.slice(0, dash).trim();
  return raw;
}

function serviceFromTitle(title) {
  const raw = (title || "").trim();
  const colon = raw.indexOf(":");
  if (colon === -1) return null;
  const before = raw.slice(0, colon).trim();
  return before || null;
}

module.exports = {
  getCashOutDay,
  getCashOutWeek,
  localDay,
  shiftDay,
  clientNameFromTitle,
  serviceFromTitle,
  adjacentLabel,
  HIDDEN_BY,
};
