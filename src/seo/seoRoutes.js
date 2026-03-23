// seoRoutes.js
// API routes for SEO toolkit

const express = require("express");
const { listSites, getTopKeywords, getTopPages, getKeywordsByPage, getDeviceBreakdown } = require("./searchConsoleClient");
const { listAccounts, listLocations, getDailyMetrics, getSearchKeywords, getPerformanceSummary } = require("./gbpClient");
const { auditPage } = require("./siteAuditor");
const { runPageSpeed, runFullAudit } = require("./pageSpeedClient");
const { analyzeData } = require("./seoAnalyzer");
const {
  searchGoogleMaps,
  searchLocalPack,
  getReviews,
  findRankingPosition,
  trackKeywordRankings,
  competitorAnalysis,
} = require("./serpApiClient");

const router = express.Router();

// ──────────────────────────────────────
// Search Console endpoints
// ──────────────────────────────────────

/**
 * GET /api/seo/search-console/sites
 * List all Search Console properties accessible to this account.
 */
router.get("/search-console/sites", async (req, res) => {
  try {
    const sites = await listSites();
    res.json({ success: true, sites });
  } catch (err) {
    console.error("[SEO] listSites error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/seo/search-console/keywords/:site
 * Get top keywords for a site ("barbershop" or "tattoo").
 * Query params: startDate, endDate, limit
 */
router.get("/search-console/keywords/:site", async (req, res) => {
  try {
    const { site } = req.params;
    const { startDate, endDate, limit } = req.query;
    const keywords = await getTopKeywords(site, {
      startDate,
      endDate,
      limit: limit ? parseInt(limit, 10) : 25,
    });
    res.json({ success: true, site, keywords });
  } catch (err) {
    console.error("[SEO] getTopKeywords error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/seo/search-console/pages/:site
 * Get top pages by clicks for a site.
 * Query params: startDate, endDate, limit
 */
router.get("/search-console/pages/:site", async (req, res) => {
  try {
    const { site } = req.params;
    const { startDate, endDate, limit } = req.query;
    const pages = await getTopPages(site, {
      startDate,
      endDate,
      limit: limit ? parseInt(limit, 10) : 25,
    });
    res.json({ success: true, site, pages });
  } catch (err) {
    console.error("[SEO] getTopPages error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/seo/search-console/keywords-by-page/:site
 * Get keyword + page combinations.
 */
router.get("/search-console/keywords-by-page/:site", async (req, res) => {
  try {
    const { site } = req.params;
    const { startDate, endDate, limit } = req.query;
    const data = await getKeywordsByPage(site, {
      startDate,
      endDate,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    res.json({ success: true, site, data });
  } catch (err) {
    console.error("[SEO] getKeywordsByPage error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/seo/search-console/devices/:site
 * Get performance breakdown by device type.
 */
router.get("/search-console/devices/:site", async (req, res) => {
  try {
    const { site } = req.params;
    const { startDate, endDate } = req.query;
    const devices = await getDeviceBreakdown(site, { startDate, endDate });
    res.json({ success: true, site, devices });
  } catch (err) {
    console.error("[SEO] getDeviceBreakdown error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────────
// Google Business Profile endpoints
// ──────────────────────────────────────

/**
 * GET /api/seo/gbp/accounts
 * List all GBP accounts.
 */
router.get("/gbp/accounts", async (req, res) => {
  try {
    const accounts = await listAccounts();
    res.json({ success: true, accounts });
  } catch (err) {
    console.error("[SEO] listAccounts error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/seo/gbp/locations/:accountId
 * List locations for a GBP account.
 */
router.get("/gbp/locations/:accountId", async (req, res) => {
  try {
    const locations = await listLocations(`accounts/${req.params.accountId}`);
    res.json({ success: true, locations });
  } catch (err) {
    console.error("[SEO] listLocations error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/seo/gbp/performance/:locationId
 * Get GBP performance summary for a location.
 * Query params: startDate, endDate
 */
router.get("/gbp/performance/:locationId", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const summary = await getPerformanceSummary(`locations/${req.params.locationId}`, {
      startDate,
      endDate,
    });
    res.json({ success: true, ...summary });
  } catch (err) {
    console.error("[SEO] getPerformanceSummary error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/seo/gbp/keywords/:locationId
 * Get search keywords that triggered a GBP listing.
 * Query params: startDate, endDate
 */
router.get("/gbp/keywords/:locationId", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const keywords = await getSearchKeywords(`locations/${req.params.locationId}`, {
      startDate,
      endDate,
    });
    res.json({ success: true, keywords });
  } catch (err) {
    console.error("[SEO] getSearchKeywords error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────────
// Site Audit endpoints
// ──────────────────────────────────────

/**
 * GET /api/seo/audit/:site
 * Run a technical SEO audit on a site ("barbershop" or "tattoo").
 */
router.get("/audit/:site", async (req, res) => {
  try {
    const audit = await auditPage(req.params.site);
    res.json({ success: true, ...audit });
  } catch (err) {
    console.error("[SEO] auditPage error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────────
// PageSpeed Insights endpoints
// ──────────────────────────────────────

/**
 * GET /api/seo/pagespeed/:site
 * Run PageSpeed Insights for a site.
 * Query params: strategy (mobile|desktop), full (true = both strategies)
 */
router.get("/pagespeed/:site", async (req, res) => {
  try {
    const { strategy, full } = req.query;
    let result;
    if (full === "true") {
      result = await runFullAudit(req.params.site);
    } else {
      result = await runPageSpeed(req.params.site, strategy || "mobile");
    }
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("[SEO] pageSpeed error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────────
// AI Analysis endpoint
// ──────────────────────────────────────

/**
 * POST /api/seo/analyze
 * Run Claude-powered SEO analysis on collected data.
 *
 * Body: {
 *   site: "barbershop" | "tattoo" | "both",
 *   includeSearchConsole: true,
 *   includeGbp: true,
 *   includeAudit: true,
 *   includePageSpeed: true,
 *   gbpLocationId: "123456789",
 *   customQuestion: "optional specific question"
 * }
 */
router.post("/analyze", async (req, res) => {
  try {
    const {
      site = "both",
      includeSearchConsole = true,
      includeAudit = true,
      includePageSpeed = true,
      includeGbp = false,
      gbpLocationId,
      customQuestion,
    } = req.body;

    const collectedData = { site };
    const sites = site === "both" ? ["barbershop", "tattoo"] : [site];

    // Gather data in parallel
    const promises = [];

    if (includeSearchConsole) {
      for (const s of sites) {
        promises.push(
          getTopKeywords(s, { limit: 15 })
            .then((kw) => { collectedData[`searchConsole_${s}`] = kw; })
            .catch((err) => { collectedData[`searchConsole_${s}`] = { error: err.message }; })
        );
      }
    }

    if (includeAudit) {
      for (const s of sites) {
        promises.push(
          auditPage(s)
            .then((audit) => { collectedData[`audit_${s}`] = audit; })
            .catch((err) => { collectedData[`audit_${s}`] = { error: err.message }; })
        );
      }
    }

    if (includePageSpeed) {
      for (const s of sites) {
        promises.push(
          runPageSpeed(s, "mobile")
            .then((ps) => { collectedData[`pageSpeed_${s}`] = ps; })
            .catch((err) => { collectedData[`pageSpeed_${s}`] = { error: err.message }; })
        );
      }
    }

    if (includeGbp && gbpLocationId) {
      promises.push(
        getPerformanceSummary(`locations/${gbpLocationId}`)
          .then((gbp) => { collectedData.gbpInsights = gbp; })
          .catch((err) => { collectedData.gbpInsights = { error: err.message }; })
      );
    }

    await Promise.all(promises);

    // Add custom question
    if (customQuestion) collectedData.customQuestion = customQuestion;

    // Run AI analysis
    const analysis = await analyzeData(collectedData);

    res.json({ success: true, ...analysis, data: collectedData });
  } catch (err) {
    console.error("[SEO] analyze error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────────
// Dashboard — combined overview
// ──────────────────────────────────────

/**
 * GET /api/seo/dashboard/:site
 * Get a combined overview: audit + pagespeed + top keywords.
 */
router.get("/dashboard/:site", async (req, res) => {
  try {
    const site = req.params.site;

    const [audit, pageSpeed, keywords] = await Promise.allSettled([
      auditPage(site),
      runPageSpeed(site, "mobile"),
      getTopKeywords(site, { limit: 10 }).catch(() => null),
    ]);

    res.json({
      success: true,
      site,
      audit: audit.status === "fulfilled" ? audit.value : { error: audit.reason?.message },
      pageSpeed: pageSpeed.status === "fulfilled" ? pageSpeed.value : { error: pageSpeed.reason?.message },
      keywords: keywords.status === "fulfilled" ? keywords.value : null,
    });
  } catch (err) {
    console.error("[SEO] dashboard error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────────
// SerpAPI — Google Maps Rankings & Reviews
// ──────────────────────────────────────

/**
 * GET /api/seo/maps/search
 * Search Google Maps for a keyword in Minneapolis.
 * Query params: q (keyword), lat, lng, zoom
 */
router.get("/maps/search", async (req, res) => {
  try {
    const { q, lat, lng, zoom } = req.query;
    if (!q) return res.status(400).json({ success: false, error: "Missing q parameter" });
    const location = lat && lng ? `@${lat},${lng},${zoom || 14}z` : undefined;
    const results = await searchGoogleMaps(q, { location });
    res.json({ success: true, keyword: q, results });
  } catch (err) {
    console.error("[SEO] maps search error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/seo/maps/local-pack
 * Search Google and extract Local Pack results.
 * Query params: q (keyword)
 */
router.get("/maps/local-pack", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ success: false, error: "Missing q parameter" });
    const results = await searchLocalPack(q);
    res.json({ success: true, keyword: q, ...results });
  } catch (err) {
    console.error("[SEO] local-pack error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/seo/maps/ranking/:site
 * Find Studio AZ's ranking position for a keyword.
 * Query params: q (keyword)
 */
router.get("/maps/ranking/:site", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ success: false, error: "Missing q parameter" });
    const ranking = await findRankingPosition(q, req.params.site);
    res.json({ success: true, ...ranking });
  } catch (err) {
    console.error("[SEO] ranking error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/seo/maps/track-rankings/:site
 * Track rankings for multiple keywords.
 * Body: { keywords: ["barbershop near me", "fade haircut Minneapolis", ...] }
 */
router.post("/maps/track-rankings/:site", async (req, res) => {
  try {
    const { keywords } = req.body;
    if (!keywords?.length) return res.status(400).json({ success: false, error: "Missing keywords array" });
    const rankings = await trackKeywordRankings(keywords, req.params.site);
    res.json({ success: true, site: req.params.site, rankings, searchesUsed: keywords.length });
  } catch (err) {
    console.error("[SEO] track-rankings error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/seo/maps/competitors/:site
 * Run a full competitor analysis across multiple keywords.
 * Body: { keywords: ["barbershop near me", ...] }
 */
router.post("/maps/competitors/:site", async (req, res) => {
  try {
    const { keywords } = req.body;
    if (!keywords?.length) return res.status(400).json({ success: false, error: "Missing keywords array" });
    const analysis = await competitorAnalysis(req.params.site, keywords);
    res.json({ success: true, ...analysis });
  } catch (err) {
    console.error("[SEO] competitors error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/seo/maps/reviews/:placeId
 * Get Google reviews for a business by place_id.
 */
router.get("/maps/reviews/:placeId", async (req, res) => {
  try {
    const reviews = await getReviews(req.params.placeId);
    res.json({ success: true, ...reviews });
  } catch (err) {
    console.error("[SEO] reviews error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
