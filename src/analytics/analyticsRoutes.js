// analyticsRoutes.js
// API routes for barber analytics

const express = require("express");
const {
  getHealthCheck,
  getDiagnostics,
  parsePeriod,
} = require("./analyticsQueries");
const { runNightlySnapshot, computeShopAverages } = require("./snapshotCron");

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

module.exports = router;
