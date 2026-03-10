// analyticsRoutes.js
// API routes for barber analytics

const express = require("express");
const {
  getHealthCheck,
  getRebookingRate,
  getFirstVisitRebookingRate,
  getActiveClientCount,
  getRegularsCount,
  getAvgRevenuePerVisit,
  getAvgTipPercentage,
  getNoShowRate,
  getCancellationRate,
  parsePeriod,
} = require("./analyticsQueries");

const router = express.Router();

// Default barbershop location ID
const BARBER_LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID || "GLRkNAxfPtWTqTiN83xj";

/**
 * GET /api/barbers/:barberGhlId/analytics/health-check
 *
 * Returns all 8 Tier 1 metrics in one response.
 * Supports ?period= for flex-window metrics (7d, 30d, 90d, ytd).
 *
 * Response shape:
 * {
 *   success: true,
 *   barberGhlId: "...",
 *   period: "30d",
 *   metrics: {
 *     rebookingRate: { strict, forgiving, total, rebooked, pending, notRebooked },
 *     firstVisitRebookingRate: { strict, forgiving, total, rebooked, pending, notRebooked },
 *     activeClients: { total, newClients, returningClients },
 *     regulars: { count, totalBookings, regularBookingPercentage },
 *     avgRevenuePerVisit: { avgRevenue, totalRevenue, appointmentCount },
 *     avgTipPercentage: { avgTipPercentage, tippedCount, totalCount },
 *     noShowRate: { rate, noShowCount, totalBooked, repeatOffenders },
 *     cancellationRate: { rate, cancelledCount, totalBooked, repeatOffenders },
 *   }
 * }
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

module.exports = router;
