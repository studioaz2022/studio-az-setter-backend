// squareSyncCron.js
// Keeps every barber's Square connection alive and their transactions flowing
// without anyone opening the iOS app.
//
// Two failures this exists to end:
//
//   1. TOKEN DEATH. refreshAllExpiringTokens() shipped with a docblock saying
//      "call this from a daily cron job". Nothing ever called it. Square access
//      tokens last 30 days, so a barber who did not trigger a sync for a month
//      came back to a dead connection and was told to redo OAuth — when the
//      stored refresh token would have worked the entire time. Gilberto's token
//      expired 2026-09-04; on 2026-09-07 it refreshed on the first try with the
//      credential already on file. Nobody ever needed to reconnect.
//
//   2. SYNC ONLY ON APP OPEN. The only caller of syncBarberTransactions() was
//      the iOS Earnings tab. Close the app for a week and a week of Square
//      payments never entered the system. The tab was both the reader and the
//      only writer, which is why "I didn't open it" and "my money is missing"
//      were the same sentence.
//
// Ordering matters: refresh first, then sync. A sync on an expired token throws
// SquareReauthRequiredError, and we do not want to raise a reconnect alarm for
// a token we were about to renew anyway.

const {
  refreshAllExpiringTokens,
  getAllBarberConnectionStatuses,
} = require("../payments/squareOAuth");
const {
  syncBarberTransactions,
  SquareReauthRequiredError,
} = require("../payments/squareTransactionSync");
const { supabase } = require("../clients/supabaseClient");
const { sendPushToGhlUser } = require("./taskNotifications");

const TICK_MS = 6 * 60 * 60 * 1000; // 6 hours — well under the setInterval 24.8-day clamp
const WARMUP_MS = 3 * 60 * 1000; // let the process boot before the first pass

// How far back each scheduled sync looks. Longer than the gap between ticks so
// a missed tick, a deploy, or a Render restart cannot leave a hole, and long
// enough to pick up a payment whose GHL contact only became matchable later.
const SYNC_LOOKBACK_DAYS = 10;

// A barber only gets told to reconnect once a day, no matter how many ticks
// fail. Suppression is persisted on the token row, not held in module memory,
// so a restart does not reset it into a notification loop.
const REAUTH_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const OWNER_GHL_USER_ID = "1kFG5FWdUDhXLUX46snG"; // Lionel
const BARBER_LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID || "GLRkNAxfPtWTqTiN83xj";

let inFlight = false;

/**
 * Tell a barber (and the owner) that Square genuinely needs reconnecting.
 *
 * Claim-then-send: last_reauth_alert_at is written BEFORE the push goes out, so
 * a crash between the two suppresses the next alert rather than repeating it.
 * Failing closed on an alert is the correct direction — a missed notification
 * costs one day, a notification loop costs trust in every notification.
 */
async function alertReauthNeeded(barberGhlId, reason) {
  const { data: row } = await supabase
    .from("barber_square_tokens")
    .select("last_reauth_alert_at, square_merchant_name")
    .eq("barber_ghl_id", barberGhlId)
    .single();

  const lastAlert = row?.last_reauth_alert_at ? new Date(row.last_reauth_alert_at) : null;
  if (lastAlert && Date.now() - lastAlert.getTime() < REAUTH_ALERT_COOLDOWN_MS) {
    console.log(`[SquareCron] Reconnect alert for ${barberGhlId} suppressed (sent ${lastAlert.toISOString()})`);
    return;
  }

  // Claim the slot first — see the note above.
  await supabase
    .from("barber_square_tokens")
    .update({ last_reauth_alert_at: new Date().toISOString() })
    .eq("barber_ghl_id", barberGhlId);

  console.warn(`[SquareCron] Square reconnect REQUIRED for barber ${barberGhlId}: ${reason}`);

  await sendPushToGhlUser(barberGhlId, {
    type: "square_reauth_required",
    title: "Square disconnected",
    body: "Your Square account needs reconnecting — earnings stopped updating. Open Growth → Earnings to fix it.",
    locationId: BARBER_LOCATION_ID,
  }).catch((err) => console.warn(`[SquareCron] Barber push failed: ${err.message}`));

  if (barberGhlId !== OWNER_GHL_USER_ID) {
    await sendPushToGhlUser(OWNER_GHL_USER_ID, {
      type: "square_reauth_required",
      title: "A barber's Square is disconnected",
      body: `${row?.square_merchant_name || barberGhlId} stopped syncing and needs to reconnect Square.`,
      locationId: BARBER_LOCATION_ID,
    }).catch((err) => console.warn(`[SquareCron] Owner push failed: ${err.message}`));
  }
}

async function recordCronResult(barberGhlId, errorMessage) {
  await supabase
    .from("barber_square_tokens")
    .update({
      last_cron_sync_at: new Date().toISOString(),
      last_cron_error: errorMessage || null,
    })
    .eq("barber_ghl_id", barberGhlId);
}

async function tick() {
  if (inFlight) {
    console.log("⏳ [SquareCron] Previous sweep still running, skipping this tick");
    return;
  }
  inFlight = true;

  try {
    // 1. Renew anything close to expiry, before it can strand a barber.
    try {
      const refresh = await refreshAllExpiringTokens();
      if (refresh.refreshed > 0 || refresh.failed > 0) {
        console.log(`🔑 [SquareCron] Token refresh: ${refresh.refreshed} refreshed, ${refresh.failed} failed`);
      }
    } catch (err) {
      console.error(`❌ [SquareCron] Token refresh pass failed: ${err.message}`);
      // Keep going — a barber whose token is still valid should still sync.
    }

    // 2. Sync every connected barber over the trailing window.
    const connections = await getAllBarberConnectionStatuses();
    if (!connections.length) {
      console.log("[SquareCron] No connected barbers — nothing to sync");
      return;
    }

    const startDate = new Date(Date.now() - SYNC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const totals = { barbers: 0, synced: 0, autoRecorded: 0, pending: 0, unmatched: 0, failed: 0 };

    for (const conn of connections) {
      const barberGhlId = conn.barber_ghl_id;
      try {
        const result = await syncBarberTransactions(barberGhlId, {
          startDate: startDate.toISOString(),
          endDate: new Date().toISOString(),
          incremental: false,
        });

        totals.barbers++;
        totals.synced += result.synced;
        totals.autoRecorded += result.autoRecorded || 0;
        totals.pending += result.autoMatched.length;
        totals.unmatched += result.unmatched.length;

        await recordCronResult(barberGhlId, null);

        // Clear a stale reconnect alarm now that this barber is demonstrably fine.
        if (result.synced >= 0) {
          await supabase
            .from("barber_square_tokens")
            .update({ last_reauth_alert_at: null })
            .eq("barber_ghl_id", barberGhlId)
            .not("last_reauth_alert_at", "is", null);
        }

        // Payments with no identifiable contact still need a human. They are not
        // lost — they sit in Review Payments — but nobody should have to guess
        // that they are there.
        if (result.unmatched.length > 0) {
          console.log(
            `[SquareCron] Barber ${barberGhlId} has ${result.unmatched.length} unmatched payment(s) awaiting attribution`
          );
        }
      } catch (err) {
        totals.failed++;
        await recordCronResult(barberGhlId, err.message);

        if (err instanceof SquareReauthRequiredError) {
          await alertReauthNeeded(barberGhlId, err.message);
        } else {
          console.error(`❌ [SquareCron] Sync failed for barber ${barberGhlId}: ${err.message}`);
        }
      }
    }

    console.log(
      `💈 [SquareCron] Sweep complete — ${totals.barbers} barber(s), ${totals.synced} payment(s) seen, ` +
        `${totals.autoRecorded} recorded, ${totals.pending} awaiting confirmation, ` +
        `${totals.unmatched} unmatched, ${totals.failed} failed`
    );
  } catch (err) {
    console.error("❌ [SquareCron] Sweep failed:", err.message);
  } finally {
    inFlight = false;
  }
}

function startSquareSyncCron() {
  console.log(
    `💈 Square sync cron: armed — token refresh + ${SYNC_LOOKBACK_DAYS}-day sync every 6h ` +
      `(no longer depends on anyone opening the Earnings tab)`
  );
  setTimeout(tick, WARMUP_MS);
  setInterval(tick, TICK_MS);
}

// `runSquareSyncNow` backs the manual-trigger endpoint; it shares the in-flight
// guard with the scheduled tick, so a manual run during a sweep is a no-op.
module.exports = { startSquareSyncCron, runSquareSyncNow: tick };
