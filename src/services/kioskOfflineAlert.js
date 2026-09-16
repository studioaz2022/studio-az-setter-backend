// ═══ GHL-OWNED-SMS ═══
// Sends SMS to Lionel through the GHL barbershop conversations API, the
// same path as lostBookingAlerts and cacheReconcileLoop's staleness alert.
// The message body lives here in the repo, not in a GHL workflow.
//
// ── Check-in kiosk offline alert ───────────────────────────────────────
//
// The kiosk fails silently. On 2026-08-29 a client of Joshua's stood at
// the iPad for twenty minutes while it was off the network entirely; the
// gap was only found three days later, by reading logs. On 2026-09-11 the
// same iPad left the network at 16:02 and did not return until 09:56 the
// next morning — nearly eighteen hours, unnoticed, on a Friday.
//
// What makes this detectable at all is that the kiosk's OfflineGuard
// polls GET /api/kiosk/ping every 15 seconds whenever it is alive. So we
// do not need to watch the iPad's IP address, its MAC, or the shop LAN —
// we watch for a GAP in a heartbeat the kiosk already sends. That signal
// is immune to DHCP changes and to iOS rotating its Wi-Fi address, both of
// which have already fooled an IP-based monitor in this shop.
//
// The heartbeat is held in memory deliberately. Writing 5,760 rows a day
// to record "still fine" would cost more than it tells us, and a process
// restart SHOULD reset it — a freshly deployed instance has no idea
// whether the kiosk is healthy and must not claim it knows.
//
// Only alerts inside opening hours. A kiosk that is off the network at
// 3am is a screen nobody is standing at.
//
// Suppression is the slot-claim protocol (memory:
// feedback_slot_claim_alert_pattern) against `ops_alerts`: claiming the
// slot IS the write, it happens BEFORE the send, and every read/write
// error fails CLOSED. If Supabase is unreachable we send nothing — the
// SMS path shares that network, so trying would only spam.
//
// Env:
//   DISABLE_KIOSK_OFFLINE_ALERT=1   opt out entirely
//   KIOSK_ALERT_OPEN_HOUR / _CLOSE_HOUR   override the window (local time)

const { createClient } = require("@supabase/supabase-js");

// ── Tunables ──────────────────────────────────────────────────────────
const SWEEP_INTERVAL_MS = 2 * 60 * 1000;    // how often we look
const OFFLINE_AFTER_MS = 10 * 60 * 1000;    // 40 missed pings — unambiguous
const SUPPRESSION_MS = 2 * 60 * 60 * 1000;  // at most one text per 2h
const STARTUP_GRACE_MS = 5 * 60 * 1000;     // don't alert on a fresh boot
const SHOP_TZ = "America/Chicago";
const OPEN_HOUR = Number(process.env.KIOSK_ALERT_OPEN_HOUR ?? 9);
const CLOSE_HOUR = Number(process.env.KIOSK_ALERT_CLOSE_HOUR ?? 20);

const OWNER_ALERT_CONTACT_ID = "H3NamSlW7XAiF7WVUUo8"; // Lionel (barbershop)
const ALERT_KEY = "kiosk-checkin-offline";

// ── Heartbeat state (in memory, by design — see header) ───────────────
let lastPingAt = null;   // ms epoch of the most recent kiosk ping
let bootedAt = Date.now();
let recoveredPending = false; // we alerted; tell him when it comes back
let timerHandle = null;
let sweepInFlight = false;

/** Called by GET /api/kiosk/ping. Must stay trivial — it runs every 15s. */
function recordKioskPing() {
  const wasOffline = recoveredPending;
  lastPingAt = Date.now();
  return wasOffline;
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error("Supabase env not configured");
  return createClient(url, key);
}

/** Hour of day in the shop's timezone, independent of the server's. */
function shopHour(at = new Date()) {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: SHOP_TZ, hour: "2-digit", hour12: false,
  }).format(at);
  return Number(s);
}

function withinOpeningHours(at = new Date()) {
  const h = shopHour(at);
  return h >= OPEN_HOUR && h < CLOSE_HOUR;
}

/**
 * Claim the alert slot. Returns true ONLY if the write landed — that
 * write is the guard, not a preceding check. Fail-closed everywhere.
 */
async function claimAlertSlot(summary) {
  let supabase;
  try { supabase = getSupabase(); }
  catch { console.warn("[kioskOfflineAlert] 🔇 no Supabase client — not alerting"); return false; }

  try {
    const { data, error } = await supabase
      .from("ops_alerts")
      .select("last_alert_at")
      .eq("alert_key", ALERT_KEY)
      .maybeSingle();
    if (error) throw error;
    if (data?.last_alert_at) {
      const since = Date.now() - new Date(data.last_alert_at).getTime();
      if (since < SUPPRESSION_MS) {
        console.log(
          `[kioskOfflineAlert] 🔇 suppressed — alerted ${(since / 60000).toFixed(0)}m ago`
        );
        return false;
      }
    }
  } catch (err) {
    console.warn(
      `[kioskOfflineAlert] 🔇 suppression read failed (${err.message || err}) — fail-closed`
    );
    return false;
  }

  try {
    const { error } = await supabase.from("ops_alerts").upsert(
      {
        alert_key: ALERT_KEY,
        last_alert_at: new Date().toISOString(),
        alert_kind: "kiosk_offline",
        last_summary: String(summary || "").slice(0, 300),
      },
      { onConflict: "alert_key" }
    );
    if (error) throw error;
    return true;
  } catch (err) {
    console.warn(
      `[kioskOfflineAlert] 🔇 slot claim failed (${err.message || err}) — no SMS`
    );
    return false;
  }
}

async function sendSMS(message) {
  try {
    const { ghlBarber } = require("../clients/ghlMultiLocationSdk");
    if (!ghlBarber) {
      console.warn("[kioskOfflineAlert] ghlBarber SDK unavailable — can't send");
      return false;
    }
    await ghlBarber.conversations.sendANewMessage({
      type: "SMS",
      contactId: OWNER_ALERT_CONTACT_ID,
      message,
    });
    console.log(`[kioskOfflineAlert] 📱 sent: ${message.slice(0, 90)}…`);
    return true;
  } catch (err) {
    console.error("[kioskOfflineAlert] send failed:", err.message || err);
    return false;
  }
}

/** One pass. Exported so it can be run by hand without the timer. */
async function runSweep() {
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    // A fresh process knows nothing yet. Saying "the kiosk is down"
    // because we only just booted would be a lie every deploy.
    if (Date.now() - bootedAt < STARTUP_GRACE_MS) return;
    if (lastPingAt === null) return; // never seen it — nothing to compare

    const silentFor = Date.now() - lastPingAt;

    // Recovery notice, so a text is never left hanging without an ending.
    if (recoveredPending && silentFor < OFFLINE_AFTER_MS) {
      recoveredPending = false;
      await sendSMS("Check-in kiosk is back online.");
      return;
    }

    if (silentFor < OFFLINE_AFTER_MS) return;
    if (!withinOpeningHours()) return;
    if (recoveredPending) return; // already told him; wait for recovery

    const mins = Math.round(silentFor / 60000);
    const summary = `no kiosk ping for ${mins}m`;
    if (!(await claimAlertSlot(summary))) return;

    recoveredPending = true;
    await sendSMS(
      `Check-in kiosk offline — no contact for ${mins} minutes. ` +
      `Clients can't check themselves in. Worth a look at the iPad.`
    );
  } catch (err) {
    console.error("[kioskOfflineAlert] sweep error:", err.message || err);
  } finally {
    sweepInFlight = false;
  }
}

function startKioskOfflineAlertLoop() {
  if (timerHandle) return;
  bootedAt = Date.now();
  timerHandle = setInterval(runSweep, SWEEP_INTERVAL_MS);
  if (timerHandle.unref) timerHandle.unref();
  console.log(
    `[kioskOfflineAlert] ▶ watching kiosk heartbeat ` +
    `(offline after ${OFFLINE_AFTER_MS / 60000}m, ${OPEN_HOUR}:00-${CLOSE_HOUR}:00 ${SHOP_TZ}, ` +
    `suppression ${SUPPRESSION_MS / 3600000}h)`
  );
}

/** For diagnostics — how long since the kiosk last said hello. */
function kioskHeartbeatStatus() {
  return {
    lastPingAt: lastPingAt ? new Date(lastPingAt).toISOString() : null,
    silentForMs: lastPingAt ? Date.now() - lastPingAt : null,
    withinOpeningHours: withinOpeningHours(),
    alerted: recoveredPending,
  };
}

module.exports = {
  startKioskOfflineAlertLoop,
  recordKioskPing,
  kioskHeartbeatStatus,
  runSweep,
  withinOpeningHours,
};
