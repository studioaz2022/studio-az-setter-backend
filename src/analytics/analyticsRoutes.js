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
const { runNightlySnapshot, computeShopAverages } = require("./snapshotCron");
const { runMonthlyRollup, getMonthlyTrends } = require("./monthlyRollup");
const {
  requestCoaching,
  getLatestCoachingSession,
} = require("./coachingService");

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

    console.log(`[Analytics] Coaching request for barber ${barberGhlId}`);

    const result = await requestCoaching(barberGhlId, locationId);

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
