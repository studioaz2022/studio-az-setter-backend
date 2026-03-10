// monthlyRollup.js
// Aggregates daily snapshots from barber_analytics_snapshots into barber_monthly_trends.
// Different aggregation methods per metric type:
//   - AVG for rates (rebooking, tip %, no-show, cancellation, utilization, revenue/visit)
//   - End-of-month snapshot for counts (active clients, regulars, attrition rates)
//   - SUM for event counts (new clients)
// Also persists shop-wide averages as SHOP_AVERAGE sentinel rows.

const { supabase } = require("../clients/supabaseClient");
const { BARBER_DATA, BARBER_LOCATION_ID } = require("../config/kioskConfig");

// Minimum barbers needed to compute a shop average
const MIN_BARBERS_FOR_SHOP_AVG = 3;

// The 6 peer-benchmarking metrics that get shop averages
const SHOP_AVG_METRICS = [
  "rebooking_rate_forgiving",
  "first_visit_rebooking_forgiving",
  "no_show_rate",
  "cancellation_rate",
  "avg_tip_percentage",
  "chair_utilization",
];

/**
 * Compute the monthly rollup for a single barber for a given month.
 *
 * @param {string} barberGhlId
 * @param {string} locationId
 * @param {string} monthStart - First day of month, e.g. '2026-03-01'
 * @param {string} monthEnd - Last day of month, e.g. '2026-03-31'
 * @returns {object|null} - Monthly trend row, or null if no snapshots
 */
async function computeBarberMonthlyRollup(barberGhlId, locationId, monthStart, monthEnd) {
  // Fetch all daily snapshots for this barber in the given month
  const { data: snapshots, error } = await supabase
    .from("barber_analytics_snapshots")
    .select("*")
    .eq("barber_ghl_id", barberGhlId)
    .eq("location_id", locationId)
    .gte("snapshot_date", monthStart)
    .lte("snapshot_date", monthEnd)
    .order("snapshot_date", { ascending: true });

  if (error) {
    console.error(`[Monthly Rollup] Failed to fetch snapshots for ${barberGhlId}:`, error.message);
    return null;
  }

  if (!snapshots || snapshots.length === 0) {
    return null;
  }

  // Helper: average of non-null values
  function avg(field) {
    const values = snapshots.map(s => s[field]).filter(v => v !== null && v !== undefined);
    if (values.length === 0) return null;
    return Math.round((values.reduce((sum, v) => sum + parseFloat(v), 0) / values.length) * 100) / 100;
  }

  // Helper: last snapshot value (end-of-month)
  function last(field) {
    const lastSnapshot = snapshots[snapshots.length - 1];
    return lastSnapshot[field] ?? null;
  }

  // Helper: sum of non-null values
  function sum(field) {
    const values = snapshots.map(s => s[field]).filter(v => v !== null && v !== undefined);
    if (values.length === 0) return null;
    return values.reduce((total, v) => total + parseInt(v, 10), 0);
  }

  return {
    barber_ghl_id: barberGhlId,
    location_id: locationId,
    month: monthStart,

    // Rates — AVG of daily snapshots
    rebooking_rate_strict: avg("rebooking_rate_strict"),
    rebooking_rate_forgiving: avg("rebooking_rate_forgiving"),
    first_visit_rebooking_strict: avg("first_visit_rebooking_strict"),
    first_visit_rebooking_forgiving: avg("first_visit_rebooking_forgiving"),
    avg_revenue_per_visit: avg("avg_revenue_per_visit"),
    avg_tip_percentage: avg("avg_tip_percentage"),
    no_show_rate: avg("no_show_rate"),
    cancellation_rate: avg("cancellation_rate"),
    chair_utilization: avg("chair_utilization"),

    // Counts — end-of-month snapshot
    active_client_count: last("active_client_count"),
    regulars_count: last("regulars_count"),
    attrition_rate_strict: last("attrition_rate_strict"),
    attrition_rate_forgiving: last("attrition_rate_forgiving"),

    // Totals — SUM across the month
    new_clients_total: sum("new_clients_count"),

    computed_at: new Date().toISOString(),
  };
}

/**
 * Compute shop-wide average monthly trends for the 6 peer-benchmarking metrics.
 * Averages the individual barber monthly rollups (not daily snapshots).
 *
 * @param {Array} barberRollups - Array of individual barber monthly trend rows
 * @param {string} locationId
 * @param {string} monthStart
 * @returns {object|null} - Shop average row with SHOP_AVERAGE sentinel, or null
 */
function computeShopAverageMonthly(barberRollups, locationId, monthStart) {
  // Filter to rollups that have data
  const validRollups = barberRollups.filter(r => r !== null);

  if (validRollups.length < MIN_BARBERS_FOR_SHOP_AVG) {
    console.log(`[Monthly Rollup] Only ${validRollups.length} barber rollups — skipping shop average (need ${MIN_BARBERS_FOR_SHOP_AVG}+)`);
    return null;
  }

  function avgMetric(field) {
    const values = validRollups.map(r => r[field]).filter(v => v !== null && v !== undefined);
    if (values.length < MIN_BARBERS_FOR_SHOP_AVG) return null;
    return Math.round((values.reduce((sum, v) => sum + parseFloat(v), 0) / values.length) * 100) / 100;
  }

  return {
    barber_ghl_id: "SHOP_AVERAGE",
    location_id: locationId,
    month: monthStart,

    // Only the 6 peer-benchmarking metrics
    rebooking_rate_strict: null,
    rebooking_rate_forgiving: avgMetric("rebooking_rate_forgiving"),
    first_visit_rebooking_strict: null,
    first_visit_rebooking_forgiving: avgMetric("first_visit_rebooking_forgiving"),
    avg_revenue_per_visit: null,
    avg_tip_percentage: avgMetric("avg_tip_percentage"),
    no_show_rate: avgMetric("no_show_rate"),
    cancellation_rate: avgMetric("cancellation_rate"),
    chair_utilization: avgMetric("chair_utilization"),

    // Not applicable for shop average
    active_client_count: null,
    regulars_count: null,
    attrition_rate_strict: null,
    attrition_rate_forgiving: null,
    new_clients_total: null,

    computed_at: new Date().toISOString(),
  };
}

/**
 * Get the first and last day of a month.
 * @param {Date|string} date - Any date within the target month
 * @returns {{ monthStart: string, monthEnd: string }}
 */
function getMonthBounds(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth();

  const monthStart = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month + 1, 0).getDate();
  const monthEnd = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  return { monthStart, monthEnd };
}

/**
 * Run the monthly rollup for a given month.
 * Computes individual barber rollups + shop average, upserts to barber_monthly_trends.
 *
 * @param {string} [targetMonth] - Optional: any date string within the target month.
 *                                  Defaults to current month.
 * @returns {{ success: number, failed: number, shopAverage: boolean }}
 */
async function runMonthlyRollup(targetMonth) {
  const { monthStart, monthEnd } = getMonthBounds(targetMonth || new Date());
  console.log(`[Monthly Rollup] Running rollup for ${monthStart} to ${monthEnd}`);

  const results = { success: 0, failed: 0, shopAverage: false };
  const barberRollups = [];

  for (const barber of BARBER_DATA) {
    try {
      const rollup = await computeBarberMonthlyRollup(
        barber.ghlUserId,
        BARBER_LOCATION_ID,
        monthStart,
        monthEnd,
      );

      barberRollups.push(rollup);

      if (!rollup) {
        console.log(`[Monthly Rollup] No snapshots for ${barber.name} — skipping`);
        continue;
      }

      const { error } = await supabase
        .from("barber_monthly_trends")
        .upsert(rollup, { onConflict: "barber_ghl_id,location_id,month" });

      if (error) {
        throw new Error(`Upsert failed: ${error.message}`);
      }

      results.success++;
      console.log(`[Monthly Rollup] ✅ ${barber.name} rollup written`);
    } catch (err) {
      results.failed++;
      console.error(`[Monthly Rollup] ❌ ${barber.name} failed:`, err.message);
    }
  }

  // Compute and persist shop average
  try {
    const shopAvg = computeShopAverageMonthly(barberRollups, BARBER_LOCATION_ID, monthStart);

    if (shopAvg) {
      const { error } = await supabase
        .from("barber_monthly_trends")
        .upsert(shopAvg, { onConflict: "barber_ghl_id,location_id,month" });

      if (error) {
        throw new Error(`Shop average upsert failed: ${error.message}`);
      }

      results.shopAverage = true;
      console.log("[Monthly Rollup] ✅ SHOP_AVERAGE rollup written");
    }
  } catch (err) {
    console.error("[Monthly Rollup] ❌ Shop average failed:", err.message);
  }

  console.log(`[Monthly Rollup] Complete — ${results.success} barbers, ${results.failed} failed, shop avg: ${results.shopAverage}`);
  return results;
}

/**
 * Get monthly trend data for a barber (or SHOP_AVERAGE).
 *
 * @param {string} barberGhlId - Barber ID or 'SHOP_AVERAGE'
 * @param {string} locationId
 * @param {number} months - How many months of history to return
 * @returns {Array} - Monthly trend rows, oldest first
 */
async function getMonthlyTrends(barberGhlId, locationId, months = 6) {
  // Calculate the start date (N months ago, first of that month)
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months + 1);
  const startMonth = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-01`;

  const { data, error } = await supabase
    .from("barber_monthly_trends")
    .select("*")
    .eq("barber_ghl_id", barberGhlId)
    .eq("location_id", locationId)
    .gte("month", startMonth)
    .order("month", { ascending: true });

  if (error) {
    console.error(`[Monthly Rollup] Failed to fetch trends for ${barberGhlId}:`, error.message);
    throw error;
  }

  return data || [];
}

module.exports = {
  runMonthlyRollup,
  getMonthlyTrends,
  computeBarberMonthlyRollup,
  computeShopAverageMonthly,
  getMonthBounds,
};
