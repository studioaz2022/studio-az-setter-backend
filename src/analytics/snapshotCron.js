// snapshotCron.js
// Nightly cron job that computes all Tier 1 + Tier 2 metrics for each barber
// and writes daily snapshots to barber_analytics_snapshots.
// Also computes shop averages for the 6 peer-benchmarking metrics.
// Includes startup backfill for missed snapshots.

const { supabase } = require("../clients/supabaseClient");
const { BARBER_DATA, BARBER_LOCATION_ID } = require("../config/kioskConfig");
const {
  getRebookingRate,
  getActiveClientCount,
  getRegularsCount,
  getAvgRevenuePerVisit,
  getAvgTipPercentage,
  getNoShowRate,
  getCancellationRate,
  getAttritionRate,
  getNewClientTrend,
  getChairUtilization,
} = require("./analyticsQueries");
const { runMonthlyRollup } = require("./monthlyRollup");

// Default period for flex-window metrics in the nightly snapshot
const SNAPSHOT_PERIOD_DAYS = 30;

/**
 * Compute all metrics for a single barber and return a snapshot row.
 */
async function computeBarberSnapshot(barberGhlId, locationId, asOfDate = null) {
  const snapshotDate = asOfDate || new Date().toISOString().split("T")[0];

  // Compute explicit start date for flex-window metrics
  const periodStartDate = (() => {
    const d = asOfDate ? new Date(asOfDate + "T12:00:00Z") : new Date();
    d.setDate(d.getDate() - SNAPSHOT_PERIOD_DAYS);
    return d.toISOString().split("T")[0];
  })();

  // Category B functions use lt() (strictly less than) for endDate,
  // so pass the day AFTER the snapshot date to include it
  const endDateForQuery = (() => {
    const d = new Date(snapshotDate + "T12:00:00Z");
    d.setDate(d.getDate() + 1);
    return d.toISOString().split("T")[0];
  })();

  const [
    rebooking,
    activeClients,
    regulars,
    avgRevenue,
    avgTip,
    noShow,
    cancellation,
    attrition,
    newClientTrend,
    chairUtil,
  ] = await Promise.all([
    getRebookingRate(barberGhlId, locationId, asOfDate),
    getActiveClientCount(barberGhlId, locationId, asOfDate),
    getRegularsCount(barberGhlId, locationId, asOfDate),
    getAvgRevenuePerVisit(barberGhlId, locationId, SNAPSHOT_PERIOD_DAYS, endDateForQuery, periodStartDate),
    getAvgTipPercentage(barberGhlId, locationId, SNAPSHOT_PERIOD_DAYS, endDateForQuery, periodStartDate),
    getNoShowRate(barberGhlId, locationId, SNAPSHOT_PERIOD_DAYS, endDateForQuery, periodStartDate),
    getCancellationRate(barberGhlId, locationId, SNAPSHOT_PERIOD_DAYS, endDateForQuery, periodStartDate),
    getAttritionRate(barberGhlId, locationId, asOfDate),
    getNewClientTrend(barberGhlId, locationId, 1, asOfDate),
    getChairUtilization(barberGhlId, locationId, SNAPSHOT_PERIOD_DAYS, asOfDate),
  ]);

  return {
    barber_ghl_id: barberGhlId,
    location_id: locationId,
    snapshot_date: snapshotDate,

    // Tier 1
    rebooking_rate_strict: rebooking.strict,
    rebooking_rate_forgiving: rebooking.forgiving,
    first_visit_rebooking_strict: null,
    first_visit_rebooking_forgiving: null,
    active_client_count: activeClients.total,
    active_new_count: activeClients.newClients,
    active_returning_count: activeClients.returningClients,
    regulars_count: regulars.count,
    avg_revenue_per_visit: avgRevenue.avgRevenue,
    avg_tip_percentage: avgTip.avgTipPercentage,
    no_show_rate: noShow.rate,
    cancellation_rate: cancellation.rate,

    // Tier 2
    attrition_rate_strict: attrition.strict,
    attrition_rate_forgiving: attrition.forgiving,
    new_clients_count: newClientTrend.total,
    chair_utilization: chairUtil.utilization,

    computed_at: new Date().toISOString(),
  };
}

/**
 * Run the nightly snapshot for all barbers.
 * Writes one row per barber to barber_analytics_snapshots (upserts on unique constraint).
 */
async function runNightlySnapshot() {
  const startTime = Date.now();
  console.log("[Snapshot Cron] Starting nightly analytics snapshot...");

  const results = { success: 0, failed: 0, errors: [] };

  for (const barber of BARBER_DATA) {
    try {
      const snapshot = await computeBarberSnapshot(barber.ghlUserId, BARBER_LOCATION_ID);

      const { error } = await supabase
        .from("barber_analytics_snapshots")
        .upsert(snapshot, {
          onConflict: "barber_ghl_id,location_id,snapshot_date",
        });

      if (error) {
        throw new Error(`Supabase upsert failed: ${error.message}`);
      }

      results.success++;
      console.log(`[Snapshot Cron] ✅ ${barber.name} snapshot written`);
    } catch (err) {
      results.failed++;
      results.errors.push({ barber: barber.name, error: err.message });
      console.error(`[Snapshot Cron] ❌ ${barber.name} failed:`, err.message);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Snapshot Cron] Completed in ${elapsed}s — ${results.success} success, ${results.failed} failed`);

  // Run monthly rollup for the current month after snapshots are written
  try {
    console.log("[Snapshot Cron] Running monthly rollup for current month...");
    const rollupResults = await runMonthlyRollup();
    console.log(`[Snapshot Cron] Monthly rollup done — ${rollupResults.success} barbers, shop avg: ${rollupResults.shopAverage}`);
  } catch (err) {
    console.error("[Snapshot Cron] Monthly rollup failed:", err.message);
  }

  return results;
}

/**
 * Check if today's snapshot is missing and backfill if so.
 * Runs once on startup (delayed 30 seconds to let the server boot).
 * Only backfills today — historical gaps can be filled via the manual endpoint.
 */
async function checkAndBackfill() {
  const today = new Date().toISOString().split("T")[0];

  try {
    const { data: existing, error } = await supabase
      .from("barber_analytics_snapshots")
      .select("barber_ghl_id")
      .eq("location_id", BARBER_LOCATION_ID)
      .eq("snapshot_date", today)
      .limit(1);

    if (error) {
      console.error("[Snapshot Cron] Backfill check failed:", error.message);
      return;
    }

    if (!existing || existing.length === 0) {
      console.log(`[Snapshot Cron] No snapshot found for ${today} — running backfill...`);
      await runNightlySnapshot();
    } else {
      console.log(`[Snapshot Cron] Snapshot for ${today} already exists — no backfill needed`);
    }
  } catch (err) {
    console.error("[Snapshot Cron] Backfill error:", err.message);
  }
}

/**
 * Compute shop averages for the 6 peer-benchmarking metrics from today's snapshots.
 * Only includes averages when 3+ barbers have data for a metric.
 *
 * Returns: { rebookingForgiving, firstVisitRebooking, noShowRate, cancellationRate, avgTipPercentage, chairUtilization }
 */
async function computeShopAverages(locationId, snapshotDate) {
  const { data: snapshots, error } = await supabase
    .from("barber_analytics_snapshots")
    .select("rebooking_rate_forgiving, no_show_rate, cancellation_rate, avg_tip_percentage, chair_utilization")
    .eq("location_id", locationId)
    .eq("snapshot_date", snapshotDate);

  if (error) {
    console.error("[Snapshot Cron] Failed to fetch snapshots for shop averages:", error.message);
    return null;
  }

  if (!snapshots || snapshots.length < 3) {
    console.log(`[Snapshot Cron] Only ${snapshots?.length || 0} snapshots — skipping shop averages (need 3+)`);
    return null;
  }

  function avg(values) {
    const valid = values.filter(v => v !== null && v !== undefined);
    if (valid.length < 3) return null;
    return Math.round((valid.reduce((s, v) => s + parseFloat(v), 0) / valid.length) * 10) / 10;
  }

  return {
    rebookingForgiving: avg(snapshots.map(s => s.rebooking_rate_forgiving)),
    noShowRate: avg(snapshots.map(s => s.no_show_rate)),
    cancellationRate: avg(snapshots.map(s => s.cancellation_rate)),
    avgTipPercentage: avg(snapshots.map(s => s.avg_tip_percentage)),
    chairUtilization: avg(snapshots.map(s => s.chair_utilization)),
  };
}

/**
 * Start the nightly cron schedule.
 * Runs at 2:00 AM Central time every day.
 * On startup, checks for missed snapshots and backfills if needed.
 */
function startSnapshotCron() {
  // Calculate ms until next 2:00 AM Central
  function scheduleNext() {
    const now = new Date();

    // Get current Central time using Intl
    const centralFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = centralFormatter.formatToParts(now);
    const getPart = (type) => parts.find(p => p.type === type)?.value;
    const centralHour = parseInt(getPart("hour"), 10);
    const centralMinute = parseInt(getPart("minute"), 10);

    // Calculate minutes until 2:00 AM Central
    let minutesUntil2AM;
    const currentMinutes = centralHour * 60 + centralMinute;
    const target = 2 * 60; // 2:00 AM

    if (currentMinutes < target) {
      minutesUntil2AM = target - currentMinutes;
    } else {
      minutesUntil2AM = (24 * 60 - currentMinutes) + target;
    }

    const msUntilNext = minutesUntil2AM * 60 * 1000;
    console.log(`[Snapshot Cron] Next run in ${(msUntilNext / 3600000).toFixed(1)} hours (2:00 AM Central)`);

    setTimeout(async () => {
      try {
        await runNightlySnapshot();
      } catch (err) {
        console.error("[Snapshot Cron] Unhandled error:", err.message);
      }
      // Schedule next run
      scheduleNext();
    }, msUntilNext);
  }

  scheduleNext();

  // Backfill check: run 30s after startup to let the server finish booting
  setTimeout(() => {
    checkAndBackfill().catch(err => {
      console.error("[Snapshot Cron] Startup backfill check failed:", err.message);
    });
  }, 30 * 1000);

  console.log("[Snapshot Cron] Nightly snapshot cron initialized (2:00 AM Central, startup backfill enabled)");
}

/**
 * Backfill daily snapshots for a date range, then run monthly rollups.
 *
 * @param {string} startDate - YYYY-MM-DD start (inclusive)
 * @param {string} endDate   - YYYY-MM-DD end (inclusive)
 * @returns {object} - { snapshotsCreated, datesProcessed, monthsRolled, errors }
 */
async function backfillSnapshots(startDate, endDate) {
  const start = new Date(startDate + "T12:00:00Z");
  const end = new Date(endDate + "T12:00:00Z");
  const results = { snapshotsCreated: 0, errors: [], datesProcessed: 0 };

  // Phase 1: Generate daily snapshots
  const currentDate = new Date(start);
  while (currentDate <= end) {
    const dateStr = currentDate.toISOString().split("T")[0];
    console.log(`[Backfill] Processing ${dateStr} (${results.datesProcessed + 1})...`);

    for (const barber of BARBER_DATA) {
      try {
        const snapshot = await computeBarberSnapshot(barber.ghlUserId, BARBER_LOCATION_ID, dateStr);

        if (snapshot) {
          const { error: upsertError } = await supabase
            .from("barber_analytics_snapshots")
            .upsert(snapshot, {
              onConflict: "barber_ghl_id,location_id,snapshot_date",
            });

          if (upsertError) {
            results.errors.push({ date: dateStr, barber: barber.name, error: upsertError.message });
          } else {
            results.snapshotsCreated++;
          }
        }
      } catch (err) {
        results.errors.push({ date: dateStr, barber: barber.name, error: err.message });
        console.error(`[Backfill] Error for ${barber.name} on ${dateStr}:`, err.message);
      }
    }

    results.datesProcessed++;
    currentDate.setDate(currentDate.getDate() + 1);
  }

  // Phase 2: Run monthly rollups for each month in the range
  const monthsToRollup = new Set();
  const d = new Date(start);
  while (d <= end) {
    monthsToRollup.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`);
    d.setMonth(d.getMonth() + 1);
  }

  results.monthsRolled = [];
  for (const month of monthsToRollup) {
    try {
      console.log(`[Backfill] Running monthly rollup for ${month}...`);
      const rollupResult = await runMonthlyRollup(month);
      results.monthsRolled.push({ month, ...rollupResult });
    } catch (err) {
      results.errors.push({ month, error: err.message });
    }
  }

  console.log(`[Backfill] Complete: ${results.snapshotsCreated} snapshots, ${results.monthsRolled.length} months rolled, ${results.errors.length} errors`);
  return results;
}

module.exports = {
  runNightlySnapshot,
  computeShopAverages,
  startSnapshotCron,
  computeBarberSnapshot,
  checkAndBackfill,
  backfillSnapshots,
};
