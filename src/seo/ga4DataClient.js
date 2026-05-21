// ga4DataClient.js
// Thin wrapper around the GA4 Data API for the stats dashboard.
//
// Uses the same OAuth refresh-token pattern as searchConsoleClient (shared
// CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN env). Auth tokens are cached for the
// lifetime of the Express process.

require("dotenv").config({ quiet: true });
const axios = require("axios");

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_SEO_REFRESH_TOKEN;

// GA4 property IDs per memory/ga4_data_api.md
const PROPERTIES = {
  tattoo: "511557077",
  barbershop: "424855039",
};

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const resp = await axios.post("https://oauth2.googleapis.com/token", {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  cachedToken = resp.data.access_token;
  tokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000;
  return cachedToken;
}

/**
 * Run a GA4 `runReport` query against the configured property.
 * @param {"tattoo"|"barbershop"} siteKey
 * @param {object} body — runReport request body
 * @returns {Promise<object>} raw GA4 response
 */
async function runReport(siteKey, body) {
  const propertyId = PROPERTIES[siteKey];
  if (!propertyId) {
    throw new Error(`Unknown site for GA4: ${siteKey}`);
  }
  const token = await getAccessToken();
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`;
  const resp = await axios.post(url, body, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  return resp.data;
}

/**
 * Consultation form step completions over the last N days.
 *
 * Returns one row per (step_index, step_name) tuple, aggregated by eventCount.
 * The form fires `consultation_step_complete` with `step_index` + `step_name`
 * params on every step transition; we read both as custom dimensions.
 *
 * Multiple step_names can share the same step_index (e.g. step 1 has both
 * q_artist_selection and q_timeline_en in EN flow). Caller decides how to
 * collapse — we just return the raw rows in step-index order.
 */
async function consultationStepCompletions(siteKey, days = 30) {
  return runReport(siteKey, {
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
    dimensions: [
      { name: "customEvent:step_index" },
      { name: "customEvent:step_name" },
    ],
    metrics: [{ name: "totalUsers" }],
    dimensionFilter: {
      filter: {
        fieldName: "eventName",
        stringFilter: { value: "consultation_step_complete" },
      },
    },
    orderBys: [
      { dimension: { dimensionName: "customEvent:step_index" } },
    ],
  });
}

/**
 * Site-wide totals for the headline strip on the Today page.
 *
 * Returns sessions + totalUsers for two date ranges in a single GA4 call:
 *   - current:    last `days` days (inclusive of today)
 *   - comparison: the `days` days before that
 * Delta is computed client-side by the caller.
 */
async function siteTotals(siteKey, days = 7) {
  // GA4 date-range strings: "Ndays ago" → "today" for current; for comparison
  // we go back another `days` days. "today" is GA4's local-property today.
  return runReport(siteKey, {
    dateRanges: [
      { startDate: `${days - 1}daysAgo`, endDate: "today", name: "current" },
      {
        startDate: `${2 * days - 1}daysAgo`,
        endDate: `${days}daysAgo`,
        name: "comparison",
      },
    ],
    dimensions: [{ name: "dateRange" }],
    metrics: [
      { name: "sessions" },
      { name: "totalUsers" },
    ],
  });
}

/**
 * Consultation event counts (started + submitted) over two date ranges.
 * Used together with siteTotals() on the Today headline.
 */
async function consultationEventCounts(siteKey, days = 7) {
  return runReport(siteKey, {
    dateRanges: [
      { startDate: `${days - 1}daysAgo`, endDate: "today", name: "current" },
      {
        startDate: `${2 * days - 1}daysAgo`,
        endDate: `${days}daysAgo`,
        name: "comparison",
      },
    ],
    dimensions: [{ name: "dateRange" }, { name: "eventName" }],
    metrics: [{ name: "eventCount" }],
    dimensionFilter: {
      filter: {
        fieldName: "eventName",
        inListFilter: {
          values: ["consultation_started", "consultation_submitted"],
        },
      },
    },
  });
}

module.exports = {
  getAccessToken,
  runReport,
  consultationStepCompletions,
  siteTotals,
  consultationEventCounts,
  PROPERTIES,
};
