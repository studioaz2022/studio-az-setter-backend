// dailyReconcile.js
// Decide, per barber per past day, whether anything actually needs a human.
//
// The point is to make silence the normal outcome. Measured over Jun 1 - Sep 5
// 2026 across both connected barbers (120 barber-days), splitting the residue
// into "money" and "attendance" is what does the work:
//
//   money exceptions       0.23 per barber-day, 80% of days completely silent
//   attendance exceptions  0.86 per barber-day
//
// They are different questions and they do not belong in the same queue. A
// surplus payment is a money question — real revenue whose owner is unclear. An
// appointment with no payment is an attendance question: cash, comp, or a
// no-show never marked. Mixing them is what made Review Payments feel endless.
//
// WHAT THIS DELIBERATELY DOES NOT DO — check amounts.
// Lionel gives the Friends & Family rate in person, at the chair, so the amount
// paid legitimately differs from the calendar's list price. Clients also book
// "Haircut" and get "Haircut + Beard" and vice versa, so the calendar does not
// reliably imply the service delivered. On top of that only 7 of 11 calendars
// receiving payments have a price row at all. An amount test would fire
// constantly on correct data. Amounts are reported for context, never used to
// confirm or reject.
//
// The one thing it will resolve on its own is a FORCED day: exactly one unpaid
// appointment and exactly one surplus payment. There is then only one
// assignment that balances the day, so taking it is arithmetic rather than a
// guess. Anything with two or more on either side stays for a human — that is
// where "a dad paid for himself and two sons" lives, and there is no honest way
// to split it automatically.

const { supabase } = require("../clients/supabaseClient");

const BARBER_TZ = "America/Chicago";
const BARBER_LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID || "GLRkNAxfPtWTqTiN83xj";

const BLOCKED_TITLES = ["break", "block", "blocked", "lunch", "personal", "off"];

// Writing is off unless explicitly armed. The forced-balance link is reversible,
// but it still edits a money row, and the whole design deserves a stretch of
// running in logs against real days before it starts changing anything.
const AUTO_RESOLVE_ENABLED = process.env.RECONCILE_AUTO_RESOLVE === "true";

function localDay(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BARBER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function isBlockedTitle(title) {
  return BLOCKED_TITLES.includes((title || "").toLowerCase().trim());
}

/**
 * Reconcile one barber over a window of past days.
 *
 * @param {string} barberGhlId
 * @param {object} [options]
 * @param {number} [options.days=7]   How many past days to inspect (today excluded).
 * @param {boolean} [options.apply]   Override the env flag for forced resolution.
 * @returns {{ days: Array, totals: object }}
 */
async function reconcileBarber(barberGhlId, options = {}) {
  const lookbackDays = options.days || 7;
  const apply = options.apply !== undefined ? options.apply : AUTO_RESOLVE_ENABLED;

  // Today is excluded on purpose: a day still in progress has appointments that
  // have not happened yet, and every one of them would read as "unpaid".
  const now = new Date();
  const endExclusive = new Date(now.getTime());
  endExclusive.setUTCHours(0, 0, 0, 0);
  const start = new Date(endExclusive.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const { data: appts, error: apptErr } = await supabase
    .from("appointments")
    .select("id, title, contact_id, calendar_id, start_time, status")
    .eq("assigned_user_id", barberGhlId)
    .eq("status", "confirmed")
    .gte("start_time", start.toISOString())
    .lt("start_time", endExclusive.toISOString());
  if (apptErr) throw new Error(`Appointment load failed: ${apptErr.message}`);

  const { data: pays, error: payErr } = await supabase
    .from("transactions")
    .select("id, appointment_id, contact_id, contact_name, gross_amount, session_date, payment_method, reviewed_at")
    .eq("artist_ghl_id", barberGhlId)
    .eq("transaction_type", "session_payment")
    .is("deleted_at", null)
    .is("superseded_by", null)
    .gte("session_date", localDay(start))
    .lt("session_date", localDay(endExclusive));
  if (payErr) throw new Error(`Payment load failed: ${payErr.message}`);

  // Bucket both sides by local day.
  const byDay = new Map();
  const dayOf = (k) => {
    if (!byDay.has(k)) byDay.set(k, { day: k, appts: [], pays: [] });
    return byDay.get(k);
  };

  for (const a of appts || []) {
    if (isBlockedTitle(a.title)) continue;
    dayOf(localDay(new Date(a.start_time))).appts.push(a);
  }
  for (const p of pays || []) {
    dayOf(p.session_date).pays.push(p);
  }

  const results = [];
  const totals = {
    days: 0,
    clean: 0,
    moneyExceptions: 0,
    attendanceExceptions: 0,
    forcedResolved: 0,
    forcedAvailable: 0,
  };

  for (const day of [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))) {
    const paysByAppt = new Map();
    const unlinked = [];
    for (const p of day.pays) {
      if (!p.appointment_id) unlinked.push(p);
      else {
        if (!paysByAppt.has(p.appointment_id)) paysByAppt.set(p.appointment_id, []);
        paysByAppt.get(p.appointment_id).push(p);
      }
    }

    const unpaidAppts = day.appts.filter((a) => !paysByAppt.has(a.id));

    // Surplus = money on the day that no appointment needs: fully unlinked
    // payments, plus the 2nd and later payment on any one appointment.
    const surplus = [...unlinked];
    for (const [, list] of paysByAppt) {
      if (list.length > 1) surplus.push(...list.slice(1));
    }

    const forced = unpaidAppts.length === 1 && surplus.length === 1;
    let resolved = false;

    if (forced) {
      totals.forcedAvailable++;
      if (apply) {
        const target = unpaidAppts[0];
        const payment = surplus[0];
        const { error } = await supabase
          .from("transactions")
          .update({
            appointment_id: target.id,
            calendar_id: target.calendar_id || null,
            reviewed_at: new Date().toISOString(),
            reviewed_by: "auto:forced_day_balance",
            review_note: `Only assignment that balances ${day.day}: one unpaid appointment, one surplus payment.`,
          })
          .eq("id", payment.id);
        if (error) {
          console.warn(`[Reconcile] Forced link failed for payment ${payment.id}: ${error.message}`);
        } else {
          resolved = true;
          totals.forcedResolved++;
          console.log(`[Reconcile] ${barberGhlId} ${day.day}: linked surplus payment $${payment.gross_amount} → "${target.title}" (only balancing assignment)`);
        }
      }
    }

    const moneyOpen = resolved ? 0 : surplus.length;
    const attendanceOpen = resolved ? 0 : unpaidAppts.length;

    totals.days++;
    if (moneyOpen === 0 && attendanceOpen === 0) totals.clean++;
    totals.moneyExceptions += moneyOpen;
    totals.attendanceExceptions += attendanceOpen;

    results.push({
      day: day.day,
      appointments: day.appts.length,
      payments: day.pays.length,
      // Money side — real revenue whose owner is unclear.
      surplusPayments: moneyOpen,
      surplusDetail: resolved ? [] : surplus.map((p) => ({
        id: p.id,
        amount: p.gross_amount,
        method: p.payment_method,
        contactName: p.contact_name,
      })),
      // Attendance side — cash, comp, or an unmarked no-show. Not a payments question.
      unpaidAppointments: attendanceOpen,
      unpaidDetail: resolved ? [] : unpaidAppts.map((a) => ({
        id: a.id,
        title: a.title,
        contactId: a.contact_id,
        startTime: a.start_time,
      })),
      forcedResolution: forced ? (resolved ? "applied" : "available") : null,
      verdict: moneyOpen === 0 && attendanceOpen === 0 ? "clean"
             : moneyOpen > 0 ? "money_exception" : "attendance_only",
    });
  }

  return { barberGhlId, applied: apply, days: results, totals };
}

/**
 * Reconcile every barber with a Square connection.
 */
async function reconcileAllBarbers(options = {}) {
  const { data: rows, error } = await supabase
    .from("barber_square_tokens")
    .select("barber_ghl_id")
    .eq("location_id", BARBER_LOCATION_ID);
  if (error) throw new Error(`Could not list barbers: ${error.message}`);

  const out = [];
  for (const row of rows || []) {
    try {
      out.push(await reconcileBarber(row.barber_ghl_id, options));
    } catch (err) {
      console.error(`[Reconcile] Failed for ${row.barber_ghl_id}: ${err.message}`);
    }
  }
  return out;
}

module.exports = { reconcileBarber, reconcileAllBarbers, AUTO_RESOLVE_ENABLED };
