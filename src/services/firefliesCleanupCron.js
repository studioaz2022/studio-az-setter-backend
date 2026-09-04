// firefliesCleanupCron.js
// Weekly sweep that keeps Fireflies storage under its cap.
//
// The endpoint this drives has existed since the integration shipped, carrying
// a comment that said "call weekly via cron or manually". Nothing ever called
// it, and five months later storage hit 100% — at which point new meetings may
// stop being retrievable and consults silently stop reaching GHL. This file is
// the missing half. Wiring the schedule in the same change as the endpoint is
// the lesson: an uninvoked retention policy is not a retention policy.
//
// Ticks daily rather than weekly. The work is idempotent and usually a no-op
// (nothing newly crosses the 60-day line most days), and a daily tick means a
// deploy or restart cannot skip a whole week the way a 7-day timer can.

const { runCleanupSweep } = require("./firefliesCleanup");

const TICK_MS = 24 * 60 * 60 * 1000; // 1 day — well under the setInterval 24.8-day clamp
const WARMUP_MS = 5 * 60 * 1000; // let the process boot before the first pass

let inFlight = false;

async function tick() {
  if (inFlight) {
    console.log("⏳ [Fireflies Cleanup] Previous sweep still running, skipping this tick");
    return;
  }
  inFlight = true;
  try {
    const result = await runCleanupSweep();
    // Surface a stalled backfill rather than letting the sweep quietly do less
    // each week: these are meetings past the retention window that we cannot
    // delete because we do not hold a copy of them.
    if (result.skippedUnarchived > 0) {
      console.warn(
        `⚠️ [Fireflies Cleanup] ${result.skippedUnarchived} transcript(s) past retention are NOT archived — ` +
          `run POST /api/fireflies/backfill before they are lost.`
      );
    }
  } catch (err) {
    console.error("❌ [Fireflies Cleanup] Cron tick failed:", err.message);
  } finally {
    inFlight = false;
  }
}

function startFirefliesCleanupCron() {
  console.log("🧹 Fireflies cleanup cron: daily sweep armed (60-day retention, archived-only)");
  setTimeout(tick, WARMUP_MS);
  setInterval(tick, TICK_MS);
}

module.exports = { startFirefliesCleanupCron };
