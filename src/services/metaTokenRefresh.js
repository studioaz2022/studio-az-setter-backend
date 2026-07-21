/**
 * Meta Token Refresh Loop — keep long-lived Instagram-native (IGA...) tokens
 * fresh forever.
 *
 * Why this exists:
 *   Instagram-native long-lived access tokens (obtained via the "Instagram
 *   Login" flow — start with "IGA...") expire 60 days after issue. Manually
 *   regenerating every 55-60 days is easy to forget and silently breaks the
 *   IG feed on the barbershop website. This service refreshes them via
 *   Meta's `ig_refresh_token` grant type so the token effectively never
 *   expires. Refresh works so long as the current token has >24h life left.
 *
 * Design (mirrors src/services/cacheReconcileLoop.js):
 *   - setInterval every 30 days. First run 60s after boot.
 *   - Refreshes every row in Supabase table `integration_tokens` whose
 *     metadata.type === "ig_native".
 *   - Writes the new token + new expires_at back to the same row atomically.
 *   - On failure: logs, writes `last_refresh_error` to the row, and SMS-
 *     alerts Lionel (via the same GHL SDK path as cacheReconcileLoop).
 *   - Idempotent. Repeat calls are no-ops. Safe to run alongside deploys.
 *
 * The refresh endpoint (per Meta docs):
 *   GET https://graph.instagram.com/refresh_access_token
 *     ?grant_type=ig_refresh_token
 *     &access_token=<current_token>
 *   Returns { access_token, token_type, expires_in }.
 *   No App Secret required — the token authenticates the refresh itself.
 */

const { createClient } = require("@supabase/supabase-js");

// ── Tunables ──────────────────────────────────────────────────────
//
// The tick cadence is intentionally SHORT (6h) rather than 30d. Two reasons:
//   1. Node's setInterval silently clamps ms values > 2^31-1 (~24.8 days)
//      and fires every 1ms instead. A 30-day interval literally can't work.
//   2. Ticking often + gating on expires_at is a self-healing pattern —
//      a deploy that lands close to expiry catches up on the next tick
//      without needing to know exactly when the previous refresh happened.
// Actual refresh work only happens when a row is within REFRESH_WINDOW_DAYS
// of expiry, so the API is called at most ~once per (60 - window) days per
// token.
const TICK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_GRACE_MS = 60 * 1000;          // 60s after boot
const REFRESH_WINDOW_DAYS = 14;              // refresh when <14d left
const REFRESH_URGENCY_DAYS = 7;              // extra-loud log when <7d left
const OWNER_ALERT_CONTACT_ID = "H3NamSlW7XAiF7WVUUo8"; // Lionel (barbershop)
const REFRESH_ENDPOINT =
  "https://graph.instagram.com/refresh_access_token";

// ── In-memory state ───────────────────────────────────────────────
let refreshInFlight = false;
let timerHandle = null;

/**
 * Lazy Supabase client — created on first use so app.js can load this
 * module before env vars are guaranteed present.
 */
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
 * Send failure SMS to Lionel via the barbershop GHL SDK. Best-effort:
 * any send error is logged and swallowed so the loop keeps running.
 */
async function sendRefreshFailureSMS(provider, errMessage) {
  try {
    const { ghlBarber } = require("../clients/ghlMultiLocationSdk");
    if (!ghlBarber) {
      console.warn(
        "[metaTokenRefresh] ghlBarber SDK unavailable — can't send failure alert"
      );
      return false;
    }
    const message =
      `⚠️ Studio AZ alert: Meta token refresh FAILED for ` +
      `${provider}. Error: ${errMessage}. IG feed will break within ~7d ` +
      `if not manually rotated. Check Render logs + Meta Business Suite.`;
    await ghlBarber.conversations.sendANewMessage({
      type: "SMS",
      contactId: OWNER_ALERT_CONTACT_ID,
      message,
    });
    console.log(
      `[metaTokenRefresh] 📱 Refresh-failure SMS sent for ${provider}`
    );
    return true;
  } catch (err) {
    console.error(
      "[metaTokenRefresh] failure SMS itself failed:",
      err.message || err
    );
    return false;
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
    const { error: writeErr } = await supabase
      .from("integration_tokens")
      .update({
        access_token: body.access_token,
        expires_at: newExpiresAt,
        refreshed_at: new Date().toISOString(),
        last_refresh_error: null,
        last_refresh_error_at: null,
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

    // Only refresh rows within REFRESH_WINDOW_DAYS of expiry. Everything
    // else is silently skipped — cheap and self-healing.
    const due = rows.filter((row) => {
      if (!row.expires_at) return true; // unknown → play safe, refresh
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

        // Persist the error to the row for observability
        try {
          await getSupabase()
            .from("integration_tokens")
            .update({
              last_refresh_error: result.error,
              last_refresh_error_at: new Date().toISOString(),
            })
            .eq("provider", row.provider);
        } catch (persistErr) {
          console.error(
            `[metaTokenRefresh]   (also failed to persist error: ${persistErr.message})`
          );
        }

        await sendRefreshFailureSMS(row.provider, result.error);
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
    `[metaTokenRefresh] starting — first run in ${STARTUP_GRACE_MS / 1000}s, then every ${TICK_INTERVAL_MS / (60 * 60 * 1000)}h (refresh only when <${REFRESH_WINDOW_DAYS}d of life left)`
  );
  // Assign timerHandle FIRST (guarded against re-entry), then arm the
  // startup delay. Reason: previous shape assigned timerHandle inside the
  // setTimeout callback, so any startMetaTokenRefreshLoop() call in the
  // 60s window would re-enter and schedule extra timers. Belt-and-braces.
  timerHandle = setTimeout(() => {
    runRefresh().catch((err) =>
      console.error("[metaTokenRefresh] runRefresh threw:", err)
    );
    // Now switch to interval mode. This overwrites the setTimeout handle
    // which is fine — the timeout already fired.
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
