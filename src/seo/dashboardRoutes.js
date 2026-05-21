// dashboardRoutes.js
// Backend endpoints for the stats-dashboard Vercel web app.
//
// All routes are internal-only (x-internal-key header gated by middleware in
// seoRoutes.js). They shape upstream data into the dashboard's exact contract,
// so the Next.js side stays thin and the dashboard never needs to call GHL or
// GA4 directly with credentials.

const express = require("express");
const axios = require("axios");
const { consultationStepCompletions } = require("./ga4DataClient");

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

module.exports = router;
