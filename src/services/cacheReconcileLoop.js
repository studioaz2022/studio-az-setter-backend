/**
 * Cache Reconcile Loop — periodic safety sweep + webhook staleness alert.
 *
 * Background to this module (2026-06-24 incident):
 *   - GHL workflow that posts appointment events to our backend silently
 *     turned off ~2026-06-20 23:47 UTC. Nothing on our side caused it.
 *   - The front-desk cache went 4 days without a single GHL appointment
 *     event landing, so the dashboard was missing every new booking +
 *     every reschedule across both locations.
 *   - User caught it visually (Liam's column showed 4 of 8 appointments).
 *
 * Two countermeasures live here:
 *
 *   1. setInterval every 15 min calls reconcileAllLocations to pull GHL
 *      truth + upsert any cache row that's missing or differs. Safe to
 *      run alongside live webhooks (the reconciler is additive — never
 *      deletes, idempotent shape).
 *
 *   2. Webhook freshness watchdog. Each landing of either appointment-
 *      webhook handler bumps `lastAppointmentWebhookAt`. On every sweep
 *      we compute gap = now - lastAppointmentWebhookAt. If gap > 2h AND
 *      that same sweep caught events the webhook missed (ins/upd > 0) we
 *      SMS the owner once (Lionel = H3NamSlW7XAiF7WVUUo8 on barbershop).
 *      Re-arms when a fresh webhook lands.
 *
 *      The ins/upd gate was added 2026-07-07 after the 2h-timer version
 *      false-alarmed at 2:27am / 5:41am Central — the shop was closed, so
 *      no bookings meant no webhooks, which the raw timer misread as an
 *      outage. Silence alone is not an outage; silence WHILE the sweep is
 *      importing changes the webhook should have delivered is. That also
 *      makes a real outage fire faster: within one sweep of the first
 *      missed booking, not on a blind 2h clock.
 *
 * No persistence — the timestamps reset on deploy. Practically fine
 * because a deploy is also "proof of life" and either the webhook fires
 * within minutes of restart (booking traffic) or the next sweep starts
 * a fresh observation window.
 */

const { reconcileAllLocations } = require("../clients/appointmentReconciler");

// ── Tunables ──────────────────────────────────────────────────────
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;        // 15 minutes
const STARTUP_GRACE_MS = 60 * 1000;              // wait 60s after boot
const PAST_DAYS = 1;                              // ~yesterday → +14d
const FUTURE_DAYS = 14;
const WEBHOOK_STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
const OWNER_ALERT_CONTACT_ID = "H3NamSlW7XAiF7WVUUo8"; // Lionel (barbershop)

// ── In-memory state ───────────────────────────────────────────────
let lastAppointmentWebhookAt = Date.now(); // assume healthy at boot
let lastStaleAlertSentAt = 0;
let sweepInFlight = false;
let timerHandle = null;

/**
 * Called from BOTH appointment-webhook routes whenever GHL hits us.
 * Bumps the freshness clock and clears the "I already alerted" flag so
 * future outages will alert again.
 */
function markAppointmentWebhookReceived() {
  lastAppointmentWebhookAt = Date.now();
  lastStaleAlertSentAt = 0;
}

/**
 * Send the staleness SMS to Lionel via GHL barbershop SDK. Best-effort:
 * any send error is logged and swallowed so the sweep keeps running.
 */
async function sendStaleAlertSMS(gapMs) {
  try {
    const { ghlBarber } = require("../clients/ghlMultiLocationSdk");
    if (!ghlBarber) {
      console.warn("[cacheReconcileLoop] ghlBarber SDK unavailable — can't send alert");
      return false;
    }
    const hours = Math.round(gapMs / (60 * 60 * 1000) * 10) / 10;
    const message =
      `⚠️ Studio AZ alert: no GHL appointment webhooks received in ` +
      `${hours}h. Check your GHL workflow webhook actions — they may ` +
      `have been disabled (same bug as 2026-06-20). Catch-up sweep is ` +
      `still running, so the cache will stay correct in the meantime.`;
    await ghlBarber.conversations.sendANewMessage({
      type: "SMS",
      contactId: OWNER_ALERT_CONTACT_ID,
      message,
    });
    console.log(
      `[cacheReconcileLoop] 📱 Stale-webhook alert SMS sent — gap=${hours}h`
    );
    return true;
  } catch (err) {
    console.error(
      "[cacheReconcileLoop] alert SMS failed:",
      err.message || err
    );
    return false;
  }
}

/**
 * Run one reconcile sweep + the staleness check. Guarded against
 * overlap (if the previous sweep is still running for any reason, skip
 * this tick — don't pile on).
 */
async function runSweep() {
  if (sweepInFlight) {
    console.log("[cacheReconcileLoop] sweep already in flight, skipping");
    return;
  }
  sweepInFlight = true;
  const startMs = Date.now();
  try {
    const agg = await reconcileAllLocations({
      pastDays: PAST_DAYS,
      futureDays: FUTURE_DAYS,
      dryRun: false,
    });
    const dt = ((Date.now() - startMs) / 1000).toFixed(1);
    const totalIns =
      (agg.barbershop?.inserted || 0) + (agg.tattoo?.inserted || 0);
    const totalUpd =
      (agg.barbershop?.updated || 0) + (agg.tattoo?.updated || 0);
    const totalErr =
      (agg.barbershop?.errors || 0) + (agg.tattoo?.errors || 0);
    console.log(
      `[cacheReconcileLoop] sweep done in ${dt}s — ins=${totalIns} upd=${totalUpd} err=${totalErr}`
    );

    // Webhook staleness check — only AFTER a successful sweep so we
    // don't false-alarm during deploy/restart noise.
    //
    // Gate on evidence, not just silence. A quiet stretch (overnight,
    // shop closed) legitimately produces zero webhooks for hours — that
    // used to trip a 2:27am false alarm. The reconciler already holds
    // GHL truth, so we only alarm when THIS sweep actually caught events
    // the webhook should have delivered but didn't (ins/upd > 0). That
    // combination — webhook silent past threshold AND the sweep is
    // pulling in changes the webhook missed — is the real outage
    // signature, and it fires within one sweep of the day's first missed
    // booking instead of on a fixed 2h timer regardless of activity.
    const gapMs = Date.now() - lastAppointmentWebhookAt;
    const sweepCaughtMissedEvents = totalIns + totalUpd > 0;
    if (gapMs > WEBHOOK_STALE_THRESHOLD_MS && sweepCaughtMissedEvents) {
      // Don't spam: only one SMS per outage. Cleared the moment a
      // real webhook lands again (markAppointmentWebhookReceived).
      if (lastStaleAlertSentAt === 0) {
        const sent = await sendStaleAlertSMS(gapMs);
        if (sent) lastStaleAlertSentAt = Date.now();
      } else {
        const hoursSinceAlert =
          ((Date.now() - lastStaleAlertSentAt) / (60 * 60 * 1000)).toFixed(1);
        console.log(
          `[cacheReconcileLoop] webhook still stale (gap=${(gapMs / 3600000).toFixed(1)}h) — alert already sent ${hoursSinceAlert}h ago, skipping`
        );
      }
    }
  } catch (err) {
    console.error("[cacheReconcileLoop] sweep failed:", err.message || err);
  } finally {
    sweepInFlight = false;
  }
}

/**
 * Start the loop. Idempotent — repeat calls are no-ops. First sweep
 * fires after STARTUP_GRACE_MS so it never collides with deploy boot.
 */
function startCacheReconcileLoop() {
  if (timerHandle) return; // already running
  console.log(
    `[cacheReconcileLoop] starting — first sweep in ${STARTUP_GRACE_MS / 1000}s, then every ${SWEEP_INTERVAL_MS / 60000}min`
  );
  setTimeout(() => {
    runSweep().catch(() => {});
    timerHandle = setInterval(() => {
      runSweep().catch(() => {});
    }, SWEEP_INTERVAL_MS);
  }, STARTUP_GRACE_MS);
}

module.exports = {
  startCacheReconcileLoop,
  markAppointmentWebhookReceived,
  // Exported for testing / observability — read-only.
  _state: () => ({
    lastAppointmentWebhookAt,
    lastStaleAlertSentAt,
    sweepInFlight,
  }),
};
