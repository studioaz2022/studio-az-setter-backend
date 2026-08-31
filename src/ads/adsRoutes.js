// adsRoutes.js — Ads Transparency API. Mounted at /api/ads in app.js.
//
// GET /api/ads/artist/:ghlUserId/insights   — one artist's lane (self or owner)
// GET /api/ads/overview                     — every lane (owner / internal only)
//
// Lane isolation is enforced HERE, server-side: artists can only read their own
// ad metrics; only the owner (Lionel) or the internal key sees everything.

const express = require("express");
const router = express.Router();
const { resolveRequester, canSeeAllLanes, canSeeLane } = require("./adsAuth");
const {
  getActiveMapping,
  getAllActiveMappings,
  getInsightsForMapping,
  mappingSummary,
} = require("./adsService");

// GET /api/ads/artist/:ghlUserId/insights?preset=last_30d | since=&until= [&force=true]
router.get("/artist/:ghlUserId/insights", async (req, res) => {
  try {
    const requester = await resolveRequester(req);
    if (!requester) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const { ghlUserId } = req.params;
    if (!canSeeLane(requester, ghlUserId)) {
      return res.status(403).json({ success: false, error: "Forbidden — not your lane" });
    }

    const mapping = await getActiveMapping(ghlUserId);
    if (!mapping) {
      return res.status(404).json({ success: false, error: "No active ad mapping for this artist" });
    }

    const { preset, since, until, force } = req.query;
    const { metrics, cached, fetchedAt } = await getInsightsForMapping(mapping, {
      preset,
      since,
      until,
      force: force === "true",
    });

    return res.json({
      success: true,
      artist: mappingSummary(mapping),
      metrics,
      cached,
      fetchedAt,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status === 500) console.error("❌ GET /api/ads/artist insights error:", err.message || err);
    return res.status(status).json({ success: false, error: err.message });
  }
});

// GET /api/ads/overview?preset=last_30d — owner / internal only
router.get("/overview", async (req, res) => {
  try {
    const requester = await resolveRequester(req);
    if (!requester) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    if (!canSeeAllLanes(requester)) {
      return res.status(403).json({ success: false, error: "Owner only" });
    }

    const mappings = await getAllActiveMappings();
    const { preset, since, until, force } = req.query;

    const lanes = await Promise.all(
      mappings.map(async (mapping) => {
        try {
          const { metrics, cached, fetchedAt } = await getInsightsForMapping(mapping, {
            preset,
            since,
            until,
            force: force === "true",
          });
          return { ...mappingSummary(mapping), metrics, cached, fetchedAt };
        } catch (err) {
          return { ...mappingSummary(mapping), error: err.message };
        }
      })
    );

    return res.json({ success: true, count: lanes.length, lanes });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status === 500) console.error("❌ GET /api/ads/overview error:", err.message || err);
    return res.status(status).json({ success: false, error: err.message });
  }
});

// ─── Ledger (Phase 4) ───────────────────────────────────────────────────────

const { getLedger, postCredit, accrueForPeriod } = require("./ledgerService");

// GET /api/ads/artist/:ghlUserId/ledger — statement + balance (self or owner)
router.get("/artist/:ghlUserId/ledger", async (req, res) => {
  try {
    const requester = await resolveRequester(req);
    if (!requester) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    const { ghlUserId } = req.params;
    if (!canSeeLane(requester, ghlUserId)) {
      return res.status(403).json({ success: false, error: "Forbidden — not your lane" });
    }
    const ledger = await getLedger(ghlUserId);
    return res.json({ success: true, ghlUserId, ...ledger });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status === 500) console.error("❌ GET /api/ads ledger error:", err.message || err);
    return res.status(status).json({ success: false, error: err.message });
  }
});

// POST /api/ads/artist/:ghlUserId/ledger/credit — owner/internal only.
// Body: { amount, source?, externalRef?, note? }. Artists cannot credit themselves.
router.post("/artist/:ghlUserId/ledger/credit", async (req, res) => {
  try {
    const requester = await resolveRequester(req);
    if (!requester) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    if (!canSeeAllLanes(requester)) {
      return res.status(403).json({ success: false, error: "Owner only" });
    }
    const entry = await postCredit(req.params.ghlUserId, req.body || {});
    return res.json({ success: true, entry });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status === 500) console.error("❌ POST /api/ads credit error:", err.message || err);
    return res.status(status).json({ success: false, error: err.message });
  }
});

// POST /api/ads/accrue — owner/internal only. Body: { since, until } (YYYY-MM-DD).
// Pulls real Meta spend for the period and writes idempotent debits per lane.
router.post("/accrue", async (req, res) => {
  try {
    const requester = await resolveRequester(req);
    if (!requester) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    if (!canSeeAllLanes(requester)) {
      return res.status(403).json({ success: false, error: "Owner only" });
    }
    const { since, until } = req.body || {};
    const outcome = await accrueForPeriod({ since, until });
    return res.json({ success: true, ...outcome });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status === 500) console.error("❌ POST /api/ads/accrue error:", err.message || err);
    return res.status(status).json({ success: false, error: err.message });
  }
});

module.exports = router;
