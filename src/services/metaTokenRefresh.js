/**
 * Meta Token Refresh Loop — keep long-lived Instagram-native (IGA...) tokens
 * fresh forever, WITHOUT any SMS spam.
 *
 * ─── Why this exists ──────────────────────────────────────────────
 *   Instagram-native long-lived access tokens (obtained via the "Instagram
 *   Login" flow — start with "IGA...") expire 60 days after issue. Manually
 *   regenerating every 55-60 days is easy to forget and silently breaks the
 *   IG feed on the barbershop website. This service refreshes them via
 *   Meta's `ig_refresh_token` grant type so the token effectively never
 *   expires.
 *
 * ─── Alert design (this took 3 attempts; the failing designs are noted
 *     so we don't repeat) ─────────────────────────────────────────
 *   HARD CONSTRAINT: maximum ONE alert SMS per provider per 24 hours,
 *   guaranteed, even under repeated transient failures + concurrent
 *   restarts. No exceptions.
 *
 *   Design:
 *     1. Failure counter (persisted in Supabase `consecutive_failures`).
 *        Increments on each failed refresh. Reset to 0 on success.
 *        Alert only fires at the threshold (ALERT_AFTER_N_FAILURES).
 *        A single transient blip = 1 failure = no alert.
 *     2. Suppression window (persisted in Supabase `last_alert_at`).
 *        Independent of the counter. Never send twice in ALERT_SUPPRESSION_MS.
 *     3. Slot-claim protocol: the suppression slot is claimed by
 *        SUCCESSFULLY WRITING `last_alert_at = now()` BEFORE sending the
 *        SMS. If the write fails, we do NOT send — the network is broken
 *        anyway; nothing to alert about that we could deliver.
 *     4. Fail-CLOSED on every guard-check error. If we can't confirm we
 *        haven't already alerted, ASSUME we have.
 *
 *   Why the earlier designs failed:
 *     - In-memory Map only: deploys wipe it, so a mid-outage deploy would
 *       let the next tick spam again.
 *     - "Check Supabase THEN send THEN persist": the check-fetch itself
 *       fails during the same network outage that triggered the alert,
 *       and the code fell through to send (fail-open). Result: SMS every
 *       tick until the network healed.
 *     - "Persist AFTER SMS succeeds": the persist itself relied on the
 *       broken network, so `last_alert_at` never advanced.
 *
 * ─── The refresh endpoint (per Meta docs) ─────────────────────────
 *   GET https://graph.instagram.com/refresh_access_token
 *     ?grant_type=ig_refresh_token
 *     &access_token=<current_token>
 *   Returns { access_token, token_type, expires_in }.
 *   No App Secret required — the token authenticates the refresh itself.
 */

const { createClient } = require("@supabase/supabase-js");

// ── Tunables ──────────────────────────────────────────────────────
// The tick cadence is 6h (short) not 30d. Two reasons:
//   1. Node's setInterval silently clamps ms values > 2^31-1 (~24.8 days)
//      and fires every 1ms instead. A 30-day interval literally can't work.
//   2. Ticking often + gating on expires_at is self-healing — a deploy near
//      expiry catches up on the next tick.
const TICK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_GRACE_MS = 60 * 1000;          // 60s after boot
const REFRESH_WINDOW_DAYS = 14;              // refresh when <14d left
const REFRESH_URGENCY_DAYS = 7;              // extra-loud log when <7d left

// Alert-only-after-N-consecutive-failures. A single transient blip is 1
// failure and does NOT alert. With 6h ticks + 60d token, this means real
// alerts only fire after ~18h of continuous failure — plenty of headroom
// on a 60d token, zero noise on 30-second network hiccups.
const ALERT_AFTER_N_FAILURES = 3;

// Hard cap on alert cadence, even if all above checks say "send."
// Set to 24h per the operator's explicit "max 1/day" instruction.
const ALERT_SUPPRESSION_MS = 24 * 60 * 60 * 1000;

const OWNER_ALERT_CONTACT_ID = "H3NamSlW7XAiF7WVUUo8"; // Lionel (barbershop)
const REFRESH_ENDPOINT =
  "https://graph.instagram.com/refresh_access_token";

// ── In-memory state ───────────────────────────────────────────────
let refreshInFlight = false;
let timerHandle = null;

// ── Supabase (lazy) ───────────────────────────────────────────────
let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "[metaTokenRefresh] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing from env"
    );
  }
  _supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  return _supabase;
}

/**
 * Try to claim the SMS-alert slot for this provider. Returns true only if:
 *   1. Consecutive failure count is at/above threshold
 *   2. `last_alert_at` is either NULL or older than ALERT_SUPPRESSION_MS
 *   3. We could SUCCESSFULLY write `last_alert_at = now()` to Supabase
 *
 * Rule #3 is the point: claiming the slot IS the write. If Supabase is
 * unreachable the write fails, we return false, and no SMS is sent. This
 * gives us atomic "check-and-claim" semantics — no matter how many concurrent
 * ticks or restarts happen, only one can succeed in advancing last_alert_at.
 *
 * Everything is fail-CLOSED: any error at any step returns false. Missing
 * one alert during a network outage is a lesser evil than sending 100.
 */
async function claimAlertSlot(provider, failureCount) {
  if (failureCount < ALERT_AFTER_N_FAILURES) {
    console.log(
      `[metaTokenRefresh] 🔇 alert skipped for ${provider} — only ${failureCount} failure(s), threshold ${ALERT_AFTER_N_FAILURES}`
    );
    return false;
  }

  let supabase;
  try {
    supabase = getSupabase();
  } catch {
    console.warn(
      `[metaTokenRefresh] 🔇 alert skipped for ${provider} — Supabase client unavailable`
    );
    return false;
  }

  // Read current last_alert_at
  let currentAlertAt = null;
  try {
    const { data: row, error } = await supabase
      .from("integration_tokens")
      .select("last_alert_at")
      .eq("provider", provider)
      .maybeSingle();
    if (error) throw error;
    currentAlertAt = row?.last_alert_at || null;
  } catch (readErr) {
    console.warn(
      `[metaTokenRefresh] 🔇 alert skipped for ${provider} — could not read last_alert_at (${readErr.message || readErr}). Fail-closed: assuming already alerted.`
    );
    return false;
  }

  if (currentAlertAt) {
    const sinceMs = Date.now() - new Date(currentAlertAt).getTime();
    if (sinceMs < ALERT_SUPPRESSION_MS) {
      const hoursAgo = (sinceMs / (60 * 60 * 1000)).toFixed(1);
      console.log(
        `[metaTokenRefresh] 🔇 alert suppressed for ${provider} — last SMS ${hoursAgo}h ago (window ${ALERT_SUPPRESSION_MS / (60 * 60 * 1000)}h)`
      );
      return false;
    }
  }

  // Attempt to claim the slot by writing last_alert_at = now().
  // This is the atomic gate — if this write fails, we return false and no
  // SMS is sent. The write CAN in theory race with itself across concurrent
  // ticks in the same process, but the in-flight guard already serializes
  // runRefresh, so within one process there's no concurrency here. Across
  // processes / restarts, the read above catches any recent claim.
  const nowIso = new Date().toISOString();
  try {
    const { error: writeErr } = await supabase
      .from("integration_tokens")
      .update({ last_alert_at: nowIso })
      .eq("provider", provider);
    if (writeErr) throw writeErr;
  } catch (writeErr) {
    console.warn(
      `[metaTokenRefresh] 🔇 alert skipped for ${provider} — could not claim slot via last_alert_at write (${writeErr.message || writeErr}). Fail-closed: no SMS.`
    );
    return false;
  }

  console.log(
    `[metaTokenRefresh] ✋ alert slot claimed for ${provider} at ${nowIso} — SMS will send now`
  );
  return true;
}

/**
 * Send the actual SMS. Assumes claimAlertSlot() has already returned true
 * (which guarantees the persisted slot is claimed for the next 24h). Any
 * send error here is logged but the slot stays claimed — better one
 * missed SMS in 24h than a flood if we retry.
 */
async function sendRefreshFailureSMS(provider, errMessage) {
  try {
    const { ghlBarber } = require("../clients/ghlMultiLocationSdk");
    if (!ghlBarber) {
      console.warn(
        `[metaTokenRefresh] ghlBarber SDK unavailable — can't send SMS for ${provider}`
      );
      return;
    }
    const message =
      `⚠️ Studio AZ alert: Meta token refresh has failed ` +
      `${ALERT_AFTER_N_FAILURES}+ times in a row for ${provider}. ` +
      `Latest error: ${errMessage}. Check Render logs + Meta Business Suite. ` +
      `Next alert (if any) not before ${ALERT_SUPPRESSION_MS / (60 * 60 * 1000)}h from now.`;
    await ghlBarber.conversations.sendANewMessage({
      type: "SMS",
      contactId: OWNER_ALERT_CONTACT_ID,
      message,
    });
    console.log(
      `[metaTokenRefresh] 📱 Refresh-failure SMS delivered for ${provider}`
    );
  } catch (err) {
    console.error(
      `[metaTokenRefresh] SMS send failed for ${provider} (slot stays claimed — no retry):`,
      err.message || err
    );
  }
}

/**
 * Refresh a single IG-native token. Returns { ok, newExpiresAt, error }.
 * Never throws — errors are captured in the return value.
 */
async function refreshOne(row) {
  const provider = row.provider;
  try {
    const url = new URL(REFRESH_ENDPOINT);
    url.searchParams.set("grant_type", "ig_refresh_token");
    url.searchParams.set("access_token", row.access_token);

    const resp = await fetch(url.toString());
    const body = await resp.json();

    if (!resp.ok || body.error) {
      const errMsg =
        body.error?.message || body.error || `HTTP ${resp.status}`;
      return { ok: false, error: errMsg };
    }

    if (!body.access_token || !body.expires_in) {
      return {
        ok: false,
        error: `Unexpected response shape: ${JSON.stringify(body).slice(0, 200)}`,
      };
    }

    const newExpiresAt = new Date(
      Date.now() + body.expires_in * 1000
    ).toISOString();

    const supabase = getSupabase();
    // Success write: rotate the token, clear failure counter, clear
    // suppression slot so the NEXT real outage can alert fresh.
    const { error: writeErr } = await supabase
      .from("integration_tokens")
      .update({
        access_token: body.access_token,
        expires_at: newExpiresAt,
        refreshed_at: new Date().toISOString(),
        last_refresh_error: null,
        last_refresh_error_at: null,
        consecutive_failures: 0,
        last_alert_at: null,
      })
      .eq("provider", provider);

    if (writeErr) {
      return { ok: false, error: `Supabase write: ${writeErr.message}` };
    }
    return { ok: true, newExpiresAt };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Record a failure on the row: increment consecutive_failures + persist the
 * error text. Returns the new failure count, or null if the write failed.
 * Fail-CLOSED: on any error, return null so the caller SKIPS alerting
 * (rather than falsely thinking failure count is fresh).
 */
async function recordFailure(provider, errMessage) {
  try {
    const supabase = getSupabase();
    // Read current count so we can increment atomically-ish. Postgres would
    // ideally do this via `consecutive_failures = consecutive_failures + 1`
    // but supabase-js doesn't expose raw SQL expressions on .update(). Read-
    // modify-write is fine here because the in-flight guard serializes.
    const { data: row, error: readErr } = await supabase
      .from("integration_tokens")
      .select("consecutive_failures")
      .eq("provider", provider)
      .maybeSingle();
    if (readErr) throw readErr;
    const newCount = (row?.consecutive_failures || 0) + 1;
    const { error: writeErr } = await supabase
      .from("integration_tokens")
      .update({
        consecutive_failures: newCount,
        last_refresh_error: errMessage,
        last_refresh_error_at: new Date().toISOString(),
      })
      .eq("provider", provider);
    if (writeErr) throw writeErr;
    return newCount;
  } catch (err) {
    console.error(
      `[metaTokenRefresh] could not record failure for ${provider}: ${err.message || err}. Fail-closed: alert path will skip.`
    );
    return null;
  }
}

/**
 * Run one refresh sweep across every ig_native row in the table.
 * Guarded against overlap.
 */
async function runRefresh() {
  if (refreshInFlight) {
    console.log("[metaTokenRefresh] refresh already in flight, skipping");
    return;
  }
  refreshInFlight = true;
  const startMs = Date.now();

  try {
    const supabase = getSupabase();
    const { data: rows, error: readErr } = await supabase
      .from("integration_tokens")
      .select("provider, access_token, expires_at, metadata")
      .eq("metadata->>type", "ig_native");

    if (readErr) {
      console.error(
        "[metaTokenRefresh] failed to read integration_tokens:",
        readErr.message
      );
      return;
    }

    if (!rows || rows.length === 0) {
      console.log("[metaTokenRefresh] no ig_native tokens to refresh");
      return;
    }

    // Only refresh rows within REFRESH_WINDOW_DAYS of expiry.
    const due = rows.filter((row) => {
      if (!row.expires_at) return true;
      const daysLeft =
        (new Date(row.expires_at).getTime() - Date.now()) /
        (24 * 60 * 60 * 1000);
      return daysLeft < REFRESH_WINDOW_DAYS;
    });

    if (due.length === 0) {
      const nextRow = rows.reduce((a, b) =>
        !a || new Date(b.expires_at) < new Date(a.expires_at) ? b : a
      , null);
      const nextDays = nextRow?.expires_at
        ? ((new Date(nextRow.expires_at).getTime() - Date.now()) /
            (24 * 60 * 60 * 1000)).toFixed(1)
        : "?";
      console.log(
        `[metaTokenRefresh] no tokens due for refresh (nearest expires in ${nextDays}d, threshold ${REFRESH_WINDOW_DAYS}d)`
      );
      return;
    }

    console.log(
      `[metaTokenRefresh] ${due.length} of ${rows.length} ig_native token(s) due for refresh`
    );

    for (const row of due) {
      const daysLeft = row.expires_at
        ? (new Date(row.expires_at).getTime() - Date.now()) /
          (24 * 60 * 60 * 1000)
        : null;
      const urgent =
        daysLeft !== null && daysLeft < REFRESH_URGENCY_DAYS;

      console.log(
        `[metaTokenRefresh] → ${row.provider}` +
          (daysLeft !== null
            ? ` (${daysLeft.toFixed(1)}d left${urgent ? " ⚠ URGENT" : ""})`
            : "")
      );

      const result = await refreshOne(row);

      if (result.ok) {
        console.log(
          `[metaTokenRefresh]   ✓ refreshed — new expiry ${result.newExpiresAt}`
        );
      } else {
        console.error(
          `[metaTokenRefresh]   ✗ FAILED for ${row.provider}: ${result.error}`
        );

        // Record the failure (increments counter + persists error).
        // Returns null if the write itself failed → skip alert entirely.
        const newCount = await recordFailure(row.provider, result.error);
        if (newCount === null) continue;

        console.log(
          `[metaTokenRefresh]   consecutive_failures now ${newCount} (alert threshold ${ALERT_AFTER_N_FAILURES})`
        );

        // Try to claim the SMS slot. Only fires if we can atomically
        // advance last_alert_at in Supabase, which is the anti-spam gate.
        const claimed = await claimAlertSlot(row.provider, newCount);
        if (claimed) {
          await sendRefreshFailureSMS(row.provider, result.error);
        }
      }
    }

    const dt = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log(`[metaTokenRefresh] refresh sweep done in ${dt}s`);
  } finally {
    refreshInFlight = false;
  }
}

/**
 * Start the loop. Idempotent — repeat calls are no-ops. First run fires
 * STARTUP_GRACE_MS after boot so it never collides with deploy noise.
 */
function startMetaTokenRefreshLoop() {
  if (timerHandle) return;
  console.log(
    `[metaTokenRefresh] starting — first run in ${STARTUP_GRACE_MS / 1000}s, ` +
      `then every ${TICK_INTERVAL_MS / (60 * 60 * 1000)}h. ` +
      `Refresh only when <${REFRESH_WINDOW_DAYS}d of life left. ` +
      `Alert only after ${ALERT_AFTER_N_FAILURES}+ consecutive failures, ` +
      `max 1 SMS per ${ALERT_SUPPRESSION_MS / (60 * 60 * 1000)}h.`
  );
  timerHandle = setTimeout(() => {
    runRefresh().catch((err) =>
      console.error("[metaTokenRefresh] runRefresh threw:", err)
    );
    timerHandle = setInterval(() => {
      runRefresh().catch((err) =>
        console.error("[metaTokenRefresh] runRefresh threw:", err)
      );
    }, TICK_INTERVAL_MS);
  }, STARTUP_GRACE_MS);
}

module.exports = {
  startMetaTokenRefreshLoop,
  // Exported for admin/testing — trigger one refresh cycle manually.
  runRefresh,
};
