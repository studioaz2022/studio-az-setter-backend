// analyticsRoutes.js
// API routes for barber analytics

const express = require("express");
const {
  getHealthCheck,
  getDiagnostics,
  getRevenueProjection,
  getCohortAnalysis,
  parsePeriod,
} = require("./analyticsQueries");
const { runNightlySnapshot, computeShopAverages, backfillSnapshots, runMondayRitual } = require("./snapshotCron");
const { runMonthlyRollup, getMonthlyTrends } = require("./monthlyRollup");
const {
  requestCoaching,
  getLatestCoachingSession,
} = require("./coachingService");
const { computeFullScorecard } = require("./moneyLeakEngine");
const { backfillAppointments } = require("./appointmentBackfill");

const router = express.Router();

// Default barbershop location ID
const BARBER_LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID || "GLRkNAxfPtWTqTiN83xj";

// ──────────────────────────────────────
// Static routes (MUST come before :barberGhlId param routes)
// ──────────────────────────────────────

/**
 * GET /api/barbers/analytics/shop-averages
 *
 * Returns shop averages for the 6 peer-benchmarking metrics.
 * Computed from today's (or specified date's) snapshots.
 */
router.get("/analytics/shop-averages", async (req, res) => {
  try {
    const locationId = req.query.locationId || BARBER_LOCATION_ID;
    const date = req.query.date || new Date().toISOString().split("T")[0];

    console.log(`[Analytics] Shop averages for ${locationId} on ${date}`);

    const averages = await computeShopAverages(locationId, date);

    res.json({
      success: true,
      date,
      averages: averages || {},
      available: averages !== null,
    });
  } catch (error) {
    console.error("[Analytics] Shop averages error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/barbers/analytics/monthly-rollup
 *
 * Manually trigger the monthly rollup (for testing or backfilling).
 * Optional query param: ?month=2026-03-01 to target a specific month.
 */
router.post("/analytics/monthly-rollup", async (req, res) => {
  try {
    const targetMonth = req.query.month || undefined;
    console.log(`[Analytics] Manual monthly rollup triggered${targetMonth ? ` for ${targetMonth}` : ""}`);
    const results = await runMonthlyRollup(targetMonth);

    res.json({
      success: true,
      ...results,
    });
  } catch (error) {
    console.error("[Analytics] Manual monthly rollup error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/barbers/analytics/snapshot
 *
 * Manually trigger the nightly snapshot (for testing or on-demand).
 */
router.post("/analytics/snapshot", async (req, res) => {
  try {
    console.log("[Analytics] Manual snapshot triggered");
    const results = await runNightlySnapshot();

    res.json({
      success: true,
      ...results,
    });
  } catch (error) {
    console.error("[Analytics] Manual snapshot error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/barbers/analytics/monday-ritual
 *
 * Manually trigger the Monday ritual (for testing or on-demand).
 * Computes scorecards for all barbers, saves to DB, and sends push notifications.
 */
router.post("/analytics/monday-ritual", async (req, res) => {
  try {
    console.log("[Analytics] Manual Monday ritual triggered");
    const results = await runMondayRitual();

    res.json({
      success: true,
      ...results,
    });
  } catch (error) {
    console.error("[Analytics] Manual Monday ritual error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/barbers/analytics/backfill
 *
 * Backfill daily snapshots for a date range.
 * Query params:
 *   ?start=2025-09-01  — start date (inclusive, required)
 *   ?end=2026-03-10    — end date (inclusive, defaults to today)
 *
 * WARNING: Long-running operation. Call in monthly chunks to avoid timeout.
 */
router.post("/analytics/backfill", async (req, res) => {
  try {
    const start = req.query.start;
    const end = req.query.end || new Date().toISOString().split("T")[0];

    if (!start) {
      return res.status(400).json({ success: false, error: "Missing required ?start= parameter (YYYY-MM-DD)" });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return res.status(400).json({ success: false, error: "Dates must be in YYYY-MM-DD format" });
    }

    console.log(`[Analytics] Backfill triggered: ${start} → ${end}`);

    const results = await backfillSnapshots(start, end);

    res.json({
      success: true,
      ...results,
    });
  } catch (error) {
    console.error("[Analytics] Backfill error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/barbers/analytics/backfill-appointments
 *
 * Backfill GHL appointments into Supabase for a date range.
 * Fetches from GHL API day-by-day and upserts to appointments table.
 * Existing rows (from webhooks) are preserved — only new rows inserted.
 *
 * Query params:
 *   ?start=2025-09-01  — start date (inclusive, required)
 *   ?end=2026-03-10    — end date (inclusive, defaults to today)
 *
 * Run this BEFORE the analytics snapshot backfill, since snapshot metrics
 * depend on the appointments table being populated.
 *
 * For ranges > 45 days, runs async and responds immediately (check server logs).
 */
router.post("/analytics/backfill-appointments", async (req, res) => {
  try {
    const start = req.query.start;
    const end = req.query.end || new Date().toISOString().split("T")[0];

    if (!start) {
      return res.status(400).json({
        success: false,
        error: "Missing required ?start= parameter (YYYY-MM-DD)",
      });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return res.status(400).json({
        success: false,
        error: "Dates must be in YYYY-MM-DD format",
      });
    }

    const startMs = new Date(start + "T00:00:00Z").getTime();
    const endMs = new Date(end + "T23:59:59Z").getTime();
    const dayCount = Math.ceil((endMs - startMs) / (1000 * 60 * 60 * 24));

    const barberGhlId = req.query.barberGhlId || null;
    console.log(`[Analytics] Appointment backfill triggered: ${start} → ${end} (${dayCount} days)${barberGhlId ? ` for barber ${barberGhlId}` : ""}`);

    // For large ranges, run async to avoid Render's request timeout (~30-60s)
    if (dayCount > 45) {
      backfillAppointments(start, end, barberGhlId)
        .then((results) => {
          console.log("[Analytics] Async appointment backfill complete:", JSON.stringify(results));
        })
        .catch((err) => {
          console.error("[Analytics] Async appointment backfill failed:", err.message);
        });

      return res.json({
        success: true,
        async: true,
        days: dayCount,
        message: `Backfill started for ${dayCount} days (${start} → ${end}). Check server logs for progress.`,
      });
    }

    // For smaller ranges, run synchronously and return results
    const results = await backfillAppointments(start, end, barberGhlId);

    res.json({
      success: true,
      ...results,
    });
  } catch (error) {
    console.error("[Analytics] Appointment backfill error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ──────────────────────────────────────
// Parameterized routes (per-barber)
// ──────────────────────────────────────

/**
 * GET /api/barbers/:barberGhlId/analytics/health-check
 *
 * Returns all 8 Tier 1 metrics in one response.
 * Supports ?period= for flex-window metrics (7d, 30d, 90d, ytd).
 */
router.get("/:barberGhlId/analytics/health-check", async (req, res) => {
  try {
    const { barberGhlId } = req.params;
    const periodDays = parsePeriod(req.query.period);
    const locationId = req.query.locationId || BARBER_LOCATION_ID;

    console.log(`[Analytics] Health check for barber ${barberGhlId}, period=${req.query.period || "30d"}`);

    const metrics = await getHealthCheck(barberGhlId, locationId, periodDays);

    res.json({
      success: true,
      barberGhlId,
      period: req.query.period || "30d",
      metrics,
    });
  } catch (error) {
    console.error(`[Analytics] Health check error for ${req.params.barberGhlId}:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/barbers/:barberGhlId/analytics/diagnostics
 *
 * Returns all 4 Tier 2 diagnostic metrics.
 * Supports ?period= for chair utilization (7d, 30d, 90d, ytd).
 */
router.get("/:barberGhlId/analytics/diagnostics", async (req, res) => {
  try {
    const { barberGhlId } = req.params;
    const periodDays = parsePeriod(req.query.period);
    const locationId = req.query.locationId || BARBER_LOCATION_ID;

    console.log(`[Analytics] Diagnostics for barber ${barberGhlId}, period=${req.query.period || "30d"}`);

    const metrics = await getDiagnostics(barberGhlId, locationId, periodDays);

    res.json({
      success: true,
      barberGhlId,
      period: req.query.period || "30d",
      metrics,
    });
  } catch (error) {
    console.error(`[Analytics] Diagnostics error for ${req.params.barberGhlId}:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/barbers/:barberGhlId/analytics/trends
 *
 * Returns monthly trend data for a barber (line chart data).
 * Query params:
 *   ?months=6  — number of months of history (default 6)
 *   ?includeShopAvg=true — also return SHOP_AVERAGE trends for peer comparison
 */
router.get("/:barberGhlId/analytics/trends", async (req, res) => {
  try {
    const { barberGhlId } = req.params;
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 1), 24);
    const includeShopAvg = req.query.includeShopAvg === "true";
    const locationId = req.query.locationId || BARBER_LOCATION_ID;

    console.log(`[Analytics] Trends for barber ${barberGhlId}, months=${months}, shopAvg=${includeShopAvg}`);

    // Compute the current month's rollup on-demand so trends are always fresh
    try {
      await runMonthlyRollup();
    } catch (rollupErr) {
      console.warn("[Analytics] On-demand rollup failed (returning cached data):", rollupErr.message);
    }

    const barberTrends = await getMonthlyTrends(barberGhlId, locationId, months);

    const response = {
      success: true,
      barberGhlId,
      months,
      trends: barberTrends,
    };

    if (includeShopAvg) {
      const shopTrends = await getMonthlyTrends("SHOP_AVERAGE", locationId, months);
      response.shopAverageTrends = shopTrends;
    }

    res.json(response);
  } catch (error) {
    console.error(`[Analytics] Trends error for ${req.params.barberGhlId}:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/barbers/:barberGhlId/analytics/scorecard
 *
 * Returns the full Money Leak Scorecard: money on the floor, rebook rate,
 * rebook attempt proxy, weekly goal vs pace.
 */
router.get("/:barberGhlId/analytics/scorecard", async (req, res) => {
  try {
    const { barberGhlId } = req.params;
    const locationId = req.query.locationId || BARBER_LOCATION_ID;

    console.log(`[Analytics] Scorecard for barber ${barberGhlId}`);

    const scorecard = await computeFullScorecard(barberGhlId, locationId);

    res.json({
      success: true,
      barberGhlId,
      ...scorecard,
    });
  } catch (error) {
    console.error(`[Analytics] Scorecard error for ${req.params.barberGhlId}:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/barbers/:barberGhlId/analytics/coaching
 *
 * Request a new AI coaching session. Gathers current metrics + 6-month trends,
 * sends to Claude with Bossio Standard context, saves and returns the response.
 * Enforces a 2-week cooldown between requests.
 */
router.post("/:barberGhlId/analytics/coaching", async (req, res) => {
  try {
    const { barberGhlId } = req.params;
    const locationId = req.query.locationId || BARBER_LOCATION_ID;

    const focusMetric = req.body?.focusMetric || null;
    const scorecardContext = req.body?.scorecardContext || null;

    console.log(`[Analytics] Coaching request for barber ${barberGhlId}${focusMetric ? ` [focus: ${focusMetric}]` : ""}`);

    const result = await requestCoaching(barberGhlId, locationId, focusMetric, scorecardContext);

    if (!result.success && result.error === "cooldown_active") {
      return res.status(429).json(result);
    }

    res.json(result);
  } catch (error) {
    console.error(`[Analytics] Coaching error for ${req.params.barberGhlId}:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/barbers/:barberGhlId/analytics/projection
 *
 * Revenue projection based on regulars × visit frequency × avg revenue.
 * Includes what-if scenario (rebooking +10%).
 */
router.get("/:barberGhlId/analytics/projection", async (req, res) => {
  try {
    const { barberGhlId } = req.params;
    const locationId = req.query.locationId || BARBER_LOCATION_ID;

    console.log(`[Analytics] Revenue projection for barber ${barberGhlId}`);

    const projection = await getRevenueProjection(barberGhlId, locationId);

    res.json({
      success: true,
      barberGhlId,
      ...projection,
    });
  } catch (error) {
    console.error(`[Analytics] Projection error for ${req.params.barberGhlId}:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/barbers/:barberGhlId/analytics/cohorts
 *
 * Client cohort retention analysis.
 * Groups clients by month of first visit, tracks retention over time.
 */
router.get("/:barberGhlId/analytics/cohorts", async (req, res) => {
  try {
    const { barberGhlId } = req.params;
    const locationId = req.query.locationId || BARBER_LOCATION_ID;

    console.log(`[Analytics] Cohort analysis for barber ${barberGhlId}`);

    const cohorts = await getCohortAnalysis(barberGhlId, locationId);

    res.json({
      success: true,
      barberGhlId,
      ...cohorts,
    });
  } catch (error) {
    console.error(`[Analytics] Cohort analysis error for ${req.params.barberGhlId}:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/barbers/:barberGhlId/analytics/coaching/latest
 *
 * Fetch the most recent coaching session for a barber.
 * Returns the coaching response, detected stage, cooldown status, and the metrics snapshot
 * that was used at the time of the request.
 */
router.get("/:barberGhlId/analytics/coaching/latest", async (req, res) => {
  try {
    const { barberGhlId } = req.params;

    console.log(`[Analytics] Latest coaching for barber ${barberGhlId}`);

    const session = await getLatestCoachingSession(barberGhlId);

    if (!session) {
      return res.json({
        success: true,
        session: null,
        message: "No coaching sessions found. Tap 'Explain My Stats' to get personalized coaching.",
      });
    }

    res.json({
      success: true,
      session,
    });
  } catch (error) {
    console.error(`[Analytics] Latest coaching error for ${req.params.barberGhlId}:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
