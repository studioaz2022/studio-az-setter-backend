// ============================================================================
// consultReminderLoop — "your consultation starts in 30 minutes" push to the
// ASSIGNED ARTIST (not the client — client comms live in GHL workflows).
//
// Before this, artists had no heads-up at all: nothing in the backend pushed
// staff before a consultation, and the iOS app's 30-min local reminders fire
// on Command Center task due-times, not on appointments.
//
// Design (per the alert-loop rules this repo learned the hard way):
//  - Debounce is a DB column (appointments.consult_reminder_sent_at), never
//    memory — it must survive deploys.
//  - CLAIM BEFORE SEND: the sweep atomically stamps the column where it is
//    still NULL and only pushes rows it actually claimed. A crash between
//    claim and send costs one reminder (fail-closed), never a double-push.
//  - The sweep window (now .. now+35min) is wider than the tick (5min) so an
//    appointment can't fall between ticks; the claim makes the overlap safe.
//    Late claims still push while the reminder is useful — an appointment
//    only enters the window 35 minutes out, so a boot-after-outage can at
//    worst send a slightly-late "starting soon", never a stale one.
// ============================================================================

const { supabase } = require("../clients/supabaseClient");
const { sendPushToGhlUser } = require("./taskNotifications");
const {
  CALENDARS,
  IN_PERSON_CONSULTATION_CALENDARS,
} = require("../config/constants");

const TICK_MS = 5 * 60 * 1000; // 5 min
const WINDOW_MS = 35 * 60 * 1000; // look-ahead; reminder lands ~25-35 min out

// Online + in-person consultation calendars, id -> label for the push copy.
const CONSULT_CALENDARS = new Map([
  ...Object.values(CALENDARS).map((id) => [id, "online"]),
  ...Object.values(IN_PERSON_CONSULTATION_CALENDARS).map((id) => [id, "in_person"]),
]);

const DEAD_STATUSES = new Set(["cancelled", "canceled", "noshow", "no_show", "invalid"]);

async function sweepOnce(now = new Date()) {
  const windowEnd = new Date(now.getTime() + WINDOW_MS);

  const { data: upcoming, error } = await supabase
    .from("appointments")
    .select("id, title, contact_id, calendar_id, assigned_user_id, start_time, status")
    .is("consult_reminder_sent_at", null)
    .gte("start_time", now.toISOString())
    .lte("start_time", windowEnd.toISOString())
    .in("calendar_id", Array.from(CONSULT_CALENDARS.keys()));

  if (error) {
    console.error("❌ [CONSULT REMIND] query failed:", error.message);
    return;
  }

  for (const appt of upcoming || []) {
    if (DEAD_STATUSES.has(String(appt.status || "").toLowerCase())) continue;
    if (!appt.assigned_user_id) continue;

    // Atomic claim: stamp first, send only if WE stamped it. A second
    // instance (or overlapping tick) matches zero rows and sends nothing.
    const { data: claimed, error: claimErr } = await supabase
      .from("appointments")
      .update({ consult_reminder_sent_at: new Date().toISOString() })
      .eq("id", appt.id)
      .is("consult_reminder_sent_at", null)
      .select("id");

    if (claimErr || !claimed || claimed.length === 0) continue;

    const minutesOut = Math.max(1, Math.round((new Date(appt.start_time) - now) / 60000));
    const startLabel = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(appt.start_time));
    // " Consultation: Jane Doe" → "Jane Doe"
    const clientName = (appt.title || "").split(":").pop().trim() || "a client";
    const isOnline = CONSULT_CALENDARS.get(appt.calendar_id) === "online";

    try {
      const result = await sendPushToGhlUser(appt.assigned_user_id, (language) => {
        const isSpanish = language === "es";
        return {
          // 'appointment_update' — iOS already refreshes the calendar and
          // deep-links to the calendar tab for this type. No app update needed.
          type: "appointment_update",
          title: isSpanish
            ? `Consulta en ${minutesOut} min`
            : `Consultation in ${minutesOut} min`,
          body: isSpanish
            ? `${clientName} a las ${startLabel}${isOnline ? " (en línea)" : ""}`
            : `${clientName} at ${startLabel}${isOnline ? " (online)" : ""}`,
          contactId: appt.contact_id || null,
        };
      });
      console.log(
        `⏰ [CONSULT REMIND] ${appt.id} → ${appt.assigned_user_id}: ` +
          `sent=${result.sent} failed=${result.failed} (${clientName} @ ${startLabel})`
      );
    } catch (err) {
      // Claim already stamped — deliberate: fail-closed beats double-push.
      console.error(`❌ [CONSULT REMIND] push failed for ${appt.id}:`, err.message);
    }
  }
}

function startConsultReminderLoop() {
  console.log(
    `⏰ [CONSULT REMIND] loop started — tick ${TICK_MS / 60000}min, ` +
      `${CONSULT_CALENDARS.size} consult calendars watched`
  );
  sweepOnce().catch((err) => console.error("❌ [CONSULT REMIND] initial sweep:", err.message));
  setInterval(() => {
    sweepOnce().catch((err) => console.error("❌ [CONSULT REMIND] sweep:", err.message));
  }, TICK_MS);
}

module.exports = { startConsultReminderLoop, sweepOnce, CONSULT_CALENDARS };
