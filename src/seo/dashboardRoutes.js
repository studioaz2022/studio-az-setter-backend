// dashboardRoutes.js
// Backend endpoints for the stats-dashboard Vercel web app.
//
// All routes are internal-only (x-internal-key header gated by middleware in
// seoRoutes.js). They shape upstream data into the dashboard's exact contract,
// so the Next.js side stays thin and the dashboard never needs to call GHL or
// GA4 directly with credentials.

const express = require("express");
const axios = require("axios");
const {
  consultationStepCompletions,
  siteTotals,
  consultationEventCounts,
} = require("./ga4DataClient");
const {
  generateInsights,
  listInsights,
  updateCardStatus,
} = require("./insightEngine");
const {
  getTopKeywords,
  getTopPages,
  getDeviceBreakdown,
} = require("./searchConsoleClient");
const {
  getPerformanceSummary,
  getSearchKeywords: gbpSearchKeywords,
  listReviews,
  STAR_TO_NUMBER,
} = require("./gbpClient");

const router = express.Router();

// ──────────────────────────────────────
// GET /api/seo/dashboard/abandoners/:site
// (mounted as /abandoners/:site by parent router under /api/seo/dashboard)
// ──────────────────────────────────────
//
// Returns the list of consultation-form leads who landed on the form but never
// submitted (= GHL contact with source="AI Tattoo Widget" but no tattoo_title
// custom field set). Used by the AbandonedLeads widget.
//
// Heuristic for "completed": the tattoo_title custom field (8JqgdVJraABsqgUeqJ3a)
// is only written on full form submission. If it's empty/missing, the lead
// bailed.

const SITE_LOCATIONS = {
  tattoo: "mUemx2jG4wly4kJWBkI4",
};

const TATTOO_TITLE_FIELD_ID = "8JqgdVJraABsqgUeqJ3a";

router.get("/abandoners/:site", async (req, res) => {
  const { site } = req.params;
  const locationId = SITE_LOCATIONS[site];
  if (!locationId) {
    return res.status(400).json({ error: `Unknown site: ${site}` });
  }

  const pit = process.env.GHL_FILE_UPLOAD_TOKEN;
  if (!pit) {
    return res.status(503).json({ error: "GHL_FILE_UPLOAD_TOKEN not configured" });
  }

  try {
    const resp = await axios.post(
      "https://services.leadconnectorhq.com/contacts/search",
      {
        locationId,
        pageLimit: 100,
        filters: [
          { field: "source", operator: "contains", value: "AI Tattoo Widget" },
        ],
        sort: [{ field: "dateAdded", direction: "desc" }],
      },
      {
        headers: {
          Authorization: `Bearer ${pit}`,
          Version: "2021-07-28",
          "Content-Type": "application/json",
        },
        timeout: 15_000,
      }
    );

    const contacts = resp.data?.contacts || [];
    const total = resp.data?.total ?? contacts.length;

    const completed = [];
    const abandoned = [];

    for (const c of contacts) {
      const cfs = c.customFields || [];
      const titleField = cfs.find((cf) => cf.id === TATTOO_TITLE_FIELD_ID);
      const hasTitle = titleField && titleField.value;
      const out = {
        id: c.id,
        firstName: c.firstName || null,
        lastName: c.lastName || null,
        email: c.email || null,
        dateAdded: c.dateAdded,
        // Future enhancement: infer last step from GA4. For v1, null.
        lastStep: null,
      };
      if (hasTitle) {
        completed.push(out);
      } else {
        abandoned.push(out);
      }
    }

    res.json({
      total,
      completed: completed.length,
      abandoned: abandoned.length,
      leads: abandoned,
    });
  } catch (err) {
    console.error("[dashboard/abandoners] error:", err.response?.data || err.message);
    res.status(500).json({
      error: err.response?.data?.message || err.message || "GHL search failed",
    });
  }
});

// ──────────────────────────────────────
// GET /api/seo/dashboard/ga4-step-dropoff/:site
// (mounted as /ga4-step-dropoff/:site by parent router under /api/seo/dashboard)
// ──────────────────────────────────────
//
// Returns consultation form step completion counts in order, plus the largest
// single drop ("the cliff"). Shape:
//   { window, steps: [{ stepIndex, stepName, users, dropFromPrev }], cliff }
//
// dropFromPrev is the signed fractional change vs. the previous (unique)
// step's user count. First step has dropFromPrev=null.

router.get("/ga4-step-dropoff/:site", async (req, res) => {
  const { site } = req.params;
  const days = Math.max(1, Math.min(parseInt(req.query.days, 10) || 30, 365));

  try {
    const ga4 = await consultationStepCompletions(site, days);
    const raw = (ga4.rows || []).map((r) => ({
      stepIndex: Number(r.dimensionValues[0]?.value ?? -1),
      stepName: r.dimensionValues[1]?.value ?? "(unknown)",
      users: Number(r.metricValues?.[0]?.value ?? 0),
    }));

    // Collapse to one row per step_index by taking the row with the highest
    // user count (the primary flow). This handles the EN/ES split at the same
    // step_index (e.g. q_timeline_en + q_timeline_es both at index 1) by
    // surfacing the dominant language path. The minority-flow rows still feed
    // the total funnel count below.
    const byIndex = new Map();
    const indexTotals = new Map();
    for (const row of raw) {
      indexTotals.set(row.stepIndex, (indexTotals.get(row.stepIndex) || 0) + row.users);
      const existing = byIndex.get(row.stepIndex);
      if (!existing || row.users > existing.users) {
        byIndex.set(row.stepIndex, row);
      }
    }

    const collapsed = [...byIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([idx, row]) => ({
        stepIndex: idx,
        stepName: row.stepName,
        users: indexTotals.get(idx), // total at that step, across language splits
      }));

    // Compute drop from previous step (signed fractional change).
    let cliff = null;
    let cliffMag = 0;
    const steps = collapsed.map((s, i) => {
      const prev = i > 0 ? collapsed[i - 1].users : null;
      const dropFromPrev =
        prev != null && prev > 0 ? (s.users - prev) / prev : null;
      if (dropFromPrev != null && dropFromPrev < 0) {
        const mag = Math.abs(dropFromPrev);
        if (mag > cliffMag) {
          cliffMag = mag;
          cliff = {
            stepIndex: s.stepIndex,
            stepName: s.stepName,
            dropFromPrev,
          };
        }
      }
      return { ...s, dropFromPrev };
    });

    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    res.json({
      window: {
        startDate: startDate.toISOString(),
        endDate: new Date().toISOString(),
      },
      steps,
      cliff,
    });
  } catch (err) {
    console.error("[dashboard/ga4-step-dropoff] error:", err.response?.data || err.message);
    res.status(500).json({
      error: err.response?.data?.error?.message || err.message || "GA4 query failed",
    });
  }
});

// ──────────────────────────────────────
// GET /api/seo/dashboard/today-headline/:site
// (mounted as /today-headline/:site under /api/seo/dashboard)
// ──────────────────────────────────────
//
// Returns headline metrics for the Today landing page: sessions, totalUsers,
// consultation_started, consultation_submitted. Each metric has a `current`
// count (last 7d), a `prior` count (the 7d before that), and a `delta` (signed
// fractional change vs. prior). Also returns a 30d total for the secondary
// "30d total" line on each card.
//
// The 30d total comes from a single GA4 call rather than three separate ones —
// less rate-limit pressure and faster.

const METRIC_KEYS = ["sessions", "users", "consultation_started", "consultation_submitted"];

router.get("/today-headline/:site", async (req, res) => {
  const { site } = req.params;

  try {
    // Three GA4 calls in parallel: 7d totals (with comparison), 7d events
    // (with comparison), and a 30d total for the "30d" sublabel.
    const [totals7, events7, totals30, events30] = await Promise.all([
      siteTotals(site, 7),
      consultationEventCounts(site, 7),
      siteTotals(site, 30),
      consultationEventCounts(site, 30),
    ]);

    // Helper: pluck current+comparison values from a GA4 multi-dateRange
    // response. When dateRanges has 2+ entries, GA4 appends "date_range_0" /
    // "date_range_1" as the LAST dimensionValues entry on each row — it's
    // an implicit dimension. For siteTotals (no requested dimensions), that
    // implicit dimension is the only entry.
    function readByRange(report, metricIndex) {
      const out = { current: 0, comparison: 0 };
      for (const row of report.rows || []) {
        const dvs = row.dimensionValues || [];
        const range = dvs[dvs.length - 1]?.value;
        const v = Number(row.metricValues?.[metricIndex]?.value ?? 0);
        if (range === "date_range_0") out.current = v;
        else if (range === "date_range_1") out.comparison = v;
      }
      return out;
    }

    // Helper: events report has eventName as its only requested dimension,
    // plus the implicit dateRange dimension appended last.
    function readEventByRange(report, eventName) {
      const out = { current: 0, comparison: 0 };
      for (const row of report.rows || []) {
        const dvs = row.dimensionValues || [];
        const name = dvs[0]?.value;
        const range = dvs[dvs.length - 1]?.value;
        if (name !== eventName) continue;
        const v = Number(row.metricValues?.[0]?.value ?? 0);
        if (range === "date_range_0") out.current = v;
        else if (range === "date_range_1") out.comparison = v;
      }
      return out;
    }

    function signedDelta(current, prior) {
      if (prior === 0) {
        if (current === 0) return 0;
        return null; // can't compute % when prior is zero and current is not — render "—"
      }
      return (current - prior) / prior;
    }

    function packMetric(key, label, sevenD, thirtyDCurrent) {
      return {
        key,
        label,
        current_7d: sevenD.current,
        prior_7d: sevenD.comparison,
        delta_7d: signedDelta(sevenD.current, sevenD.comparison),
        total_30d: thirtyDCurrent,
      };
    }

    const sessions7  = readByRange(totals7, 0);
    const sessions30 = readByRange(totals30, 0);
    const users7     = readByRange(totals7, 1);
    const users30    = readByRange(totals30, 1);

    const started7   = readEventByRange(events7, "consultation_started");
    const started30  = readEventByRange(events30, "consultation_started");
    const submit7    = readEventByRange(events7, "consultation_submitted");
    const submit30   = readEventByRange(events30, "consultation_submitted");

    res.json({
      window: {
        current_7d: { days: 7 },
        prior_7d: { days: 7 },
        total_30d: { days: 30 },
      },
      metrics: [
        packMetric("sessions", "SESSIONS", sessions7, sessions30.current),
        packMetric("users", "USERS", users7, users30.current),
        packMetric(
          "consultation_started",
          "CONSULTATION STARTS",
          started7,
          started30.current
        ),
        packMetric(
          "consultation_submitted",
          "CONSULTATION SUBMITS",
          submit7,
          submit30.current
        ),
      ],
    });
  } catch (err) {
    console.error("[dashboard/today-headline] error:", err.response?.data || err.message);
    res.status(500).json({
      error: err.response?.data?.error?.message || err.message || "GA4 query failed",
    });
  }
});

// ──────────────────────────────────────
// Insight cards (Insights page)
// ──────────────────────────────────────
//
// GET    /api/seo/dashboard/insights/:site         — list active + history
// POST   /api/seo/dashboard/insights/:site/generate — run the pipeline once
// PATCH  /api/seo/dashboard/insights/card/:id      — update workflow status
//
// The site URL segment is validated against the Insight engine's known sites
// (v1: tattoo only). The /generate endpoint is also reachable from the weekly
// Render cron job — it's the same handler.

router.get("/insights/:site", async (req, res) => {
  const { site } = req.params;
  try {
    const { active, history } = await listInsights(site);
    res.json({ site, active, history });
  } catch (err) {
    console.error("[dashboard/insights GET] error:", err.message);
    res.status(500).json({ error: err.message || "List failed" });
  }
});

router.post("/insights/:site/generate", async (req, res) => {
  const { site } = req.params;
  try {
    const summary = await generateInsights(site);
    res.json({ site, ...summary });
  } catch (err) {
    console.error("[dashboard/insights POST] error:", err.message);
    res.status(500).json({ error: err.message || "Generation failed" });
  }
});

router.patch("/insights/card/:id", async (req, res) => {
  const { id } = req.params;
  const { status, notes } = req.body || {};
  if (!status) {
    return res.status(400).json({ error: "status is required" });
  }
  try {
    const card = await updateCardStatus(id, status, notes);
    res.json({ card });
  } catch (err) {
    console.error("[dashboard/insights PATCH] error:", err.message);
    res.status(500).json({ error: err.message || "Status update failed" });
  }
});

// ──────────────────────────────────────
// GET /api/seo/dashboard/search-console/:site
// (mounted as /search-console/:site under /api/seo/dashboard)
// ──────────────────────────────────────
//
// Returns everything the dashboard's Search Console page needs in one call:
//   - topQueries:  top 25 by clicks over a 28d window
//   - topPages:    top 25 by clicks over the same window
//   - device:      mobile/desktop/tablet breakdown over the same window
//   - newKeywords: keywords that appeared in the last 7d but not in the prior
//                  21d — surfaces fresh content opportunities
//
// Single 28d window keeps the comparison consistent across widgets. Search
// Console data lags 2-3 days; shorter windows often return empty.

function ymd(d) {
  return d.toISOString().split("T")[0];
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return ymd(d);
}

router.get("/search-console/:site", async (req, res) => {
  const { site } = req.params;
  if (site !== "tattoo" && site !== "barbershop") {
    return res.status(400).json({ error: `Unknown site: ${site}` });
  }

  // 28d window (28 → 1 days ago, since Search Console data has a 1-2d lag).
  const startDate = daysAgo(28);
  const endDate = daysAgo(1);

  // For "new keywords": last 7d vs prior 21d.
  const last7Start = daysAgo(7);
  const last7End = endDate;
  const prior21Start = daysAgo(28);
  const prior21End = daysAgo(8);

  try {
    const [topQueries, topPages, device, recent, baseline] = await Promise.all([
      getTopKeywords(site, { startDate, endDate, limit: 25 }),
      getTopPages(site, { startDate, endDate, limit: 25 }),
      getDeviceBreakdown(site, { startDate, endDate }),
      // For new-keywords diff. We pull more than 25 so the dedup window has
      // room to find queries that appeared this week but were below the
      // top-25 cutoff in the prior window.
      getTopKeywords(site, { startDate: last7Start, endDate: last7End, limit: 200 }),
      getTopKeywords(site, { startDate: prior21Start, endDate: prior21End, limit: 200 }),
    ]);

    // Diff: keywords present in `recent` but NOT in `baseline`. Compare
    // case-insensitively to avoid noise from query normalization variants.
    const baselineSet = new Set(
      baseline.map((k) => (k.keyword || "").toLowerCase())
    );
    const newKeywords = recent
      .filter((k) => !baselineSet.has((k.keyword || "").toLowerCase()))
      .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
      .slice(0, 15);

    res.json({
      window: { startDate, endDate, days: 28 },
      topQueries: topQueries.slice(0, 10),
      topPages: topPages.slice(0, 10),
      device,
      newKeywords,
    });
  } catch (err) {
    console.error("[dashboard/search-console] error:", err.response?.data || err.message);
    res.status(500).json({
      error: err.response?.data?.error?.message || err.message || "Search Console fetch failed",
    });
  }
});

// ──────────────────────────────────────
// GET /api/seo/dashboard/map-pack/:site
// (mounted as /map-pack/:site under /api/seo/dashboard)
// ──────────────────────────────────────
//
// Returns GBP performance + keyword data for the Map Pack page:
//   - impressions: 4 surface counts (Maps mobile, Maps desktop, Search mobile,
//                  Search desktop) for current 28d + prior 28d + signed delta
//   - actions:     4 action counts (directions, calls, website clicks,
//                  bookings) same shape
//   - keywords:    top search queries that triggered the GBP listing in the
//                  current 28d window (with impression counts)
//
// GBP location IDs per memory/gbp_api_access.md:
//   tattoo: locations/13377765707428643781
//   (no barbershop GBP API access wired yet)

const GBP_LOCATIONS = {
  tattoo: "locations/13377765707428643781",
};

router.get("/map-pack/:site", async (req, res) => {
  const { site } = req.params;
  const locationName = GBP_LOCATIONS[site];
  if (!locationName) {
    return res.status(400).json({ error: `No GBP location wired for: ${site}` });
  }

  const endDate = daysAgo(1);
  const startDate = daysAgo(28);
  const priorEnd = daysAgo(29);
  const priorStart = daysAgo(56);

  try {
    // 3 calls in parallel. Keywords pull only the current window — week-over-
    // week keyword diffs would need their own endpoint, not worth the lift
    // for v1.
    const [current, prior, keywordsRaw] = await Promise.all([
      getPerformanceSummary(locationName, { startDate, endDate }),
      getPerformanceSummary(locationName, {
        startDate: priorStart,
        endDate: priorEnd,
      }),
      gbpSearchKeywords(locationName, { startDate, endDate }).catch((err) => {
        console.warn("[map-pack] keywords failed:", err.response?.data || err.message);
        return [];
      }),
    ]);

    // Build a flat metric list with current/prior/delta. Keeps the dashboard
    // side dumb — just renders what we hand it.
    function pack(label, key, currentVal, priorVal, group) {
      const delta =
        priorVal === 0
          ? currentVal > 0
            ? null  // can't compute % when prior was 0
            : 0
          : (currentVal - priorVal) / priorVal;
      return {
        key,
        label,
        group,
        current_28d: currentVal,
        prior_28d: priorVal,
        delta_28d: delta,
      };
    }

    const impressions = [
      pack("MAPS · MOBILE", "maps_mobile",
        current.impressions.mobileMaps, prior.impressions.mobileMaps, "impressions"),
      pack("MAPS · DESKTOP", "maps_desktop",
        current.impressions.desktopMaps, prior.impressions.desktopMaps, "impressions"),
      pack("SEARCH · MOBILE", "search_mobile",
        current.impressions.mobileSearch, prior.impressions.mobileSearch, "impressions"),
      pack("SEARCH · DESKTOP", "search_desktop",
        current.impressions.desktopSearch, prior.impressions.desktopSearch, "impressions"),
    ];

    const actions = [
      pack("DIRECTION REQUESTS", "directions",
        current.actions.directionRequests, prior.actions.directionRequests, "actions"),
      pack("CALLS", "calls",
        current.actions.callClicks, prior.actions.callClicks, "actions"),
      pack("WEBSITE CLICKS", "website_clicks",
        current.actions.websiteClicks, prior.actions.websiteClicks, "actions"),
      pack("BOOKINGS", "bookings",
        current.actions.bookings, prior.actions.bookings, "actions"),
    ];

    // GBP keyword rows look like:
    //   { searchKeyword: "tattoo shop minneapolis",
    //     insightsValue: { value: "42" } }
    // Sometimes the value is reported as "threshold" with no number (small N).
    // Normalize both to { keyword, impressions } and sort.
    const keywords = (keywordsRaw || [])
      .map((row) => {
        const v = row?.insightsValue?.value;
        const t = row?.insightsValue?.threshold;
        const impressions = v != null ? Number(v) : null;
        return {
          keyword: row?.searchKeyword || "(unknown)",
          impressions,
          threshold: t || null, // e.g. "1-10" if below GBP's reporting cutoff
        };
      })
      .sort((a, b) => (b.impressions || 0) - (a.impressions || 0))
      .slice(0, 25);

    res.json({
      window: {
        current: { startDate, endDate, days: 28 },
        prior: { startDate: priorStart, endDate: priorEnd, days: 28 },
      },
      impressions,
      actions,
      keywords,
    });
  } catch (err) {
    console.error("[dashboard/map-pack] error:", err.response?.data || err.message);
    res.status(500).json({
      error: err.response?.data?.error?.message || err.message || "GBP fetch failed",
    });
  }
});

// ──────────────────────────────────────
// GET /api/seo/dashboard/reviews/:site
// (mounted as /reviews/:site under /api/seo/dashboard)
// ──────────────────────────────────────
//
// Returns reviews + summary stats + monthly histogram for the Reviews page.
//
// GBP v4 account + location IDs per memory/gbp_api_access.md:
//   tattoo: accounts/107017428683340496769 / locations/13377765707428643781

const GBP_ACCOUNTS = {
  tattoo: "accounts/107017428683340496769",
};

router.get("/reviews/:site", async (req, res) => {
  const { site } = req.params;
  const account = GBP_ACCOUNTS[site];
  const location = GBP_LOCATIONS[site];
  if (!account || !location) {
    return res.status(400).json({ error: `No GBP account/location wired for: ${site}` });
  }

  try {
    const { reviews, totalReviewCount, averageRating } = await listReviews(
      account,
      location
    );

    // Summary stats:
    //   total       — all reviews on file
    //   avgRating   — 1.0–5.0
    //   responseRate — % of reviews that have a reviewReply
    const replied = reviews.filter((r) => r.reviewReply != null).length;
    const responseRate = totalReviewCount > 0 ? replied / totalReviewCount : 0;

    // Monthly histogram for the last 18 months. One bucket per YYYY-MM.
    // Empty months are included so the chart has continuous bars (gaps would
    // mislead — looks like "no review activity" vs "no time at all").
    const monthly = buildMonthlyBuckets(reviews, 18);

    // Map reviews to the dashboard's shape — strip unused fields, normalize
    // starRating to 1–5, ensure deterministic ordering (newest first).
    const sorted = [...reviews].sort(
      (a, b) => new Date(b.createTime) - new Date(a.createTime)
    );
    const list = sorted.map((r) => ({
      id: r.reviewId,
      reviewer: r.reviewer?.displayName || "Anonymous",
      profilePhotoUrl: r.reviewer?.profilePhotoUrl || null,
      rating: STAR_TO_NUMBER[r.starRating] || 0,
      comment: r.comment || null,
      createTime: r.createTime,
      updateTime: r.updateTime,
      reply: r.reviewReply
        ? {
            comment: r.reviewReply.comment,
            updateTime: r.reviewReply.updateTime,
          }
        : null,
    }));

    res.json({
      summary: {
        total: totalReviewCount,
        replied,
        averageRating,
        responseRate,
      },
      monthly,
      reviews: list,
    });
  } catch (err) {
    console.error("[dashboard/reviews] error:", err.response?.data || err.message);
    res.status(500).json({
      error: err.response?.data?.error?.message || err.message || "Reviews fetch failed",
    });
  }
});

/**
 * Build a 1-bucket-per-month histogram of {count, avgRating} for the last
 * `monthCount` months. Newest month is last so the chart reads left-to-right
 * as time progressing.
 */
function buildMonthlyBuckets(reviews, monthCount) {
  // Initialize buckets keyed by YYYY-MM in chronological order.
  const buckets = [];
  const now = new Date();
  for (let i = monthCount - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    buckets.push({ month: key, count: 0, ratingSum: 0, ratingN: 0 });
  }
  const indexByKey = new Map(buckets.map((b, i) => [b.month, i]));

  for (const r of reviews) {
    const d = new Date(r.createTime);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const i = indexByKey.get(key);
    if (i == null) continue; // outside our window
    buckets[i].count += 1;
    const rating = STAR_TO_NUMBER[r.starRating];
    if (rating != null) {
      buckets[i].ratingSum += rating;
      buckets[i].ratingN += 1;
    }
  }

  return buckets.map((b) => ({
    month: b.month,
    count: b.count,
    avgRating: b.ratingN > 0 ? Math.round((b.ratingSum / b.ratingN) * 10) / 10 : null,
  }));
}

// ───────────────────────────────────────────────────────────────────────────
// Operations → Refunds & Lost (Refund Request Form §13.3 / Phase 8)
// ───────────────────────────────────────────────────────────────────────────
//
// GET /operations/refunds/:site?days=
//
// Aggregates the refund_requests table (Phase 1 schema + Phase 5 writes) into
// three orthogonal slices — last_stage_before_lost (the WHEN), lost_reason
// (the WHY), refund_type (the MONEY OUTCOME) — plus headline totals and the
// manual-review / failed counts.
//
// site: 'tattoo' returns the live aggregates. 'barbershop' is supported with
// zeroes (refund form is tattoo-only today; the page should still render).
//
// All slices anchor on submitted_at (the row was actually completed), not
// created_at (when the link was minted), so the dashboard reflects refunds
// the team actually processed.
router.get("/operations/refunds/:site", async (req, res) => {
  const site = req.params.site;
  if (site !== "tattoo" && site !== "barbershop") {
    return res.status(400).json({ error: "unknown site" });
  }

  const days = Math.max(1, Math.min(90, Number(req.query.days) || 7));

  // Empty barbershop response — refund form is tattoo-only for now.
  if (site === "barbershop") {
    return res.json(emptyRefundResponse(site, days));
  }

  try {
    const { supabase } = require("../clients/supabaseClient");

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const currentStart = new Date(now - days * day).toISOString();
    const priorStart = new Date(now - 2 * days * day).toISOString();
    const thirtyStart = new Date(now - 30 * day).toISOString();

    // One read pulls the full 30d window — we slice in memory rather than
    // round-trip three times. The table is small (one row per refund request);
    // 30 days of traffic is trivially under a paged response.
    const { data: rows, error } = await supabase
      .from("refund_requests")
      .select(
        "id, status, refund_status, refund_type, lost_reason, last_stage_before_lost, refund_amount_cents, drop_off_stage, multi_or_missing_deposit, submitted_at, created_at"
      )
      .gte("created_at", thirtyStart)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[dashboard refunds] supabase error:", error.message);
      return res.status(500).json({ error: error.message });
    }

    const all = rows || [];
    const completed = all.filter((r) => r.status === "completed" && r.submitted_at);

    function inWindow(row, startIso, endIso) {
      const ts = row.submitted_at;
      if (!ts) return false;
      if (ts < startIso) return false;
      if (endIso && ts >= endIso) return false;
      return true;
    }

    const current7 = completed.filter((r) => inWindow(r, currentStart, null));
    const prior7 = completed.filter((r) => inWindow(r, priorStart, currentStart));
    const total30 = completed; // 30d window matches the SQL filter

    function aggregate(window) {
      const byStage = {};
      const byReason = {};
      const byType = {};
      let dollarsRefunded = 0;
      let refundedCount = 0;
      let manualReviewCount = 0;
      let failedCount = 0;

      for (const r of window) {
        if (r.last_stage_before_lost) {
          byStage[r.last_stage_before_lost] =
            (byStage[r.last_stage_before_lost] || 0) + 1;
        }
        if (r.lost_reason) {
          byReason[r.lost_reason] = (byReason[r.lost_reason] || 0) + 1;
        }
        if (r.refund_type) {
          byType[r.refund_type] = (byType[r.refund_type] || 0) + 1;
        }
        if (r.refund_status === "refunded") {
          refundedCount += 1;
          if (typeof r.refund_amount_cents === "number") {
            dollarsRefunded += r.refund_amount_cents / 100;
          }
        }
        if (r.refund_status === "manual_review") manualReviewCount += 1;
        if (r.refund_status === "failed") failedCount += 1;
      }

      return {
        total: window.length,
        refundedCount,
        manualReviewCount,
        failedCount,
        dollarsRefunded: Math.round(dollarsRefunded * 100) / 100,
        byStage,
        byReason,
        byType,
      };
    }

    return res.json({
      site,
      windowDays: days,
      generatedAt: new Date().toISOString(),
      current7d: aggregate(current7),
      prior7d: aggregate(prior7),
      total30d: aggregate(total30),
    });
  } catch (err) {
    console.error("[dashboard refunds] unexpected:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

function emptyRefundResponse(site, days) {
  const zero = {
    total: 0,
    refundedCount: 0,
    manualReviewCount: 0,
    failedCount: 0,
    dollarsRefunded: 0,
    byStage: {},
    byReason: {},
    byType: {},
  };
  return {
    site,
    windowDays: days,
    generatedAt: new Date().toISOString(),
    current7d: zero,
    prior7d: zero,
    total30d: zero,
  };
}

module.exports = router;
