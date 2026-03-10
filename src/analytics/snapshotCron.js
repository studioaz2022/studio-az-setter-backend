// snapshotCron.js
// Nightly cron job that computes all Tier 1 + Tier 2 metrics for each barber
// and writes daily snapshots to barber_analytics_snapshots.
// Also computes shop averages for the 6 peer-benchmarking metrics.

const { supabase } = require("../clients/supabaseClient");
const { BARBER_DATA, BARBER_LOCATION_ID } = require("../config/kioskConfig");
const {
  getRebookingRate,
  getFirstVisitRebookingRate,
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

// Default period for flex-window metrics in the nightly snapshot
const SNAPSHOT_PERIOD_DAYS = 30;

/**
 * Compute all metrics for a single barber and return a snapshot row.
 */
async function computeBarberSnapshot(barberGhlId, locationId) {
  const [
    rebooking,
    firstVisitRebooking,
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
    getRebookingRate(barberGhlId, locationId),
    getFirstVisitRebookingRate(barberGhlId, locationId),
    getActiveClientCount(barberGhlId, locationId),
    getRegularsCount(barberGhlId, locationId),
    getAvgRevenuePerVisit(barberGhlId, locationId, SNAPSHOT_PERIOD_DAYS),
    getAvgTipPercentage(barberGhlId, locationId, SNAPSHOT_PERIOD_DAYS),
    getNoShowRate(barberGhlId, locationId, SNAPSHOT_PERIOD_DAYS),
    getCancellationRate(barberGhlId, locationId, SNAPSHOT_PERIOD_DAYS),
    getAttritionRate(barberGhlId, locationId),
    getNewClientTrend(barberGhlId, locationId, 1), // just current week count
    getChairUtilization(barberGhlId, locationId, SNAPSHOT_PERIOD_DAYS),
  ]);

  return {
    barber_ghl_id: barberGhlId,
    location_id: locationId,
    snapshot_date: new Date().toISOString().split("T")[0],

    // Tier 1
    rebooking_rate_strict: rebooking.strict,
    rebooking_rate_forgiving: rebooking.forgiving,
    first_visit_rebooking_strict: firstVisitRebooking.strict,
    first_visit_rebooking_forgiving: firstVisitRebooking.forgiving,
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

  return results;
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
    .select("rebooking_rate_forgiving, first_visit_rebooking_forgiving, no_show_rate, cancellation_rate, avg_tip_percentage, chair_utilization")
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
    firstVisitRebooking: avg(snapshots.map(s => s.first_visit_rebooking_forgiving)),
    noShowRate: avg(snapshots.map(s => s.no_show_rate)),
    cancellationRate: avg(snapshots.map(s => s.cancellation_rate)),
    avgTipPercentage: avg(snapshots.map(s => s.avg_tip_percentage)),
    chairUtilization: avg(snapshots.map(s => s.chair_utilization)),
  };
}

/**
 * Start the nightly cron schedule.
 * Runs at 2:00 AM Central time every day.
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
  console.log("[Snapshot Cron] Nightly snapshot cron initialized (2:00 AM Central)");
}

module.exports = {
  runNightlySnapshot,
  computeShopAverages,
  startSnapshotCron,
  computeBarberSnapshot,
};
