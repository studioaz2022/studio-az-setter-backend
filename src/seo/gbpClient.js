// gbpClient.js
// Google Business Profile API client for SEO toolkit

require("dotenv").config({ quiet: true });
const axios = require("axios");

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_SEO_REFRESH_TOKEN;

const BIZ_INFO_URL = "https://mybusinessbusinessinformation.googleapis.com/v1";
const PERFORMANCE_URL = "https://businessprofileperformance.googleapis.com/v1";

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

function headers(token) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

/**
 * List all GBP accounts accessible to this OAuth user.
 */
async function listAccounts() {
  const token = await getAccessToken();
  const resp = await axios.get("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", {
    headers: headers(token),
  });
  return resp.data.accounts || [];
}

/**
 * List all locations for a given GBP account.
 * @param {string} accountId - e.g. "accounts/123456789"
 */
async function listLocations(accountId) {
  const token = await getAccessToken();
  const resp = await axios.get(`${BIZ_INFO_URL}/${accountId}/locations`, {
    headers: headers(token),
    params: { readMask: "name,title,storefrontAddress,phoneNumbers,websiteUri,regularHours,metadata" },
  });
  return resp.data.locations || [];
}

/**
 * Get performance metrics for a location.
 *
 * @param {string} locationName - e.g. "locations/123456789"
 * @param {object} options
 * @param {string} options.startDate - YYYY-MM-DD
 * @param {string} options.endDate - YYYY-MM-DD
 */
async function getDailyMetrics(locationName, options = {}) {
  const token = await getAccessToken();

  const now = new Date();
  const defaultStart = new Date(now);
  defaultStart.setDate(defaultStart.getDate() - 28);

  const startDate = options.startDate || defaultStart.toISOString().split("T")[0];
  const endDate = options.endDate || now.toISOString().split("T")[0];

  const [startYear, startMonth, startDay] = startDate.split("-").map(Number);
  const [endYear, endMonth, endDay] = endDate.split("-").map(Number);

  // Metrics to fetch
  const metrics = [
    "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
    "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
    "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
    "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
    "BUSINESS_DIRECTION_REQUESTS",
    "CALL_CLICKS",
    "WEBSITE_CLICKS",
    "BUSINESS_BOOKINGS",
  ];

  // GBP's fetchMultiDailyMetricsTimeSeries wants the metrics as REPEATED
  // dailyMetrics query params (plural, repeated), NOT comma-joined.
  // URLSearchParams handles repetition cleanly when passed an array per key.
  const params = new URLSearchParams();
  for (const m of metrics) params.append("dailyMetrics", m);
  params.append("dailyRange.startDate.year", String(startYear));
  params.append("dailyRange.startDate.month", String(startMonth));
  params.append("dailyRange.startDate.day", String(startDay));
  params.append("dailyRange.endDate.year", String(endYear));
  params.append("dailyRange.endDate.month", String(endMonth));
  params.append("dailyRange.endDate.day", String(endDay));

  const resp = await axios.get(
    `${PERFORMANCE_URL}/${locationName}:fetchMultiDailyMetricsTimeSeries?${params.toString()}`,
    { headers: headers(token) }
  );

  return resp.data;
}

/**
 * Get search keywords that triggered your GBP listing.
 *
 * @param {string} locationName - e.g. "locations/123456789"
 * @param {object} options
 * @param {string} options.startDate - YYYY-MM-DD
 * @param {string} options.endDate - YYYY-MM-DD
 */
async function getSearchKeywords(locationName, options = {}) {
  const token = await getAccessToken();

  const now = new Date();
  const defaultStart = new Date(now);
  defaultStart.setDate(defaultStart.getDate() - 28);

  const startDate = options.startDate || defaultStart.toISOString().split("T")[0];
  const endDate = options.endDate || now.toISOString().split("T")[0];

  const [startYear, startMonth, startDay] = startDate.split("-").map(Number);
  const [endYear, endMonth, endDay] = endDate.split("-").map(Number);

  const resp = await axios.get(
    `${PERFORMANCE_URL}/${locationName}/searchkeywords/impressions/monthly`,
    {
      headers: headers(token),
      params: {
        "monthlyRange.startMonth.year": startYear,
        "monthlyRange.startMonth.month": startMonth,
        "monthlyRange.endMonth.year": endYear,
        "monthlyRange.endMonth.month": endMonth,
      },
    }
  );

  return resp.data.searchKeywordsCounts || [];
}

/**
 * Get a summary of GBP performance (aggregated totals).
 *
 * The fetchMultiDailyMetricsTimeSeries response shape is:
 *   { multiDailyMetricTimeSeries: [
 *       { dailyMetricTimeSeries: [
 *           { dailyMetric, timeSeries: { datedValues: [{ date, value }] } }
 *         ]
 *       }
 *     ]
 *   }
 * We flatten that and sum each metric's daily values.
 */
async function getPerformanceSummary(locationName, options = {}) {
  const raw = await getDailyMetrics(locationName, options);

  const summary = {};
  for (const outer of raw.multiDailyMetricTimeSeries || []) {
    for (const series of outer.dailyMetricTimeSeries || []) {
      const metric = series.dailyMetric;
      let total = 0;
      for (const ts of series.timeSeries?.datedValues || []) {
        total += parseInt(ts.value || "0", 10);
      }
      summary[metric] = (summary[metric] || 0) + total;
    }
  }

  return {
    period: {
      start: options.startDate || "last 28 days",
      end: options.endDate || "today",
    },
    impressions: {
      desktopMaps: summary.BUSINESS_IMPRESSIONS_DESKTOP_MAPS || 0,
      desktopSearch: summary.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH || 0,
      mobileMaps: summary.BUSINESS_IMPRESSIONS_MOBILE_MAPS || 0,
      mobileSearch: summary.BUSINESS_IMPRESSIONS_MOBILE_SEARCH || 0,
      total:
        (summary.BUSINESS_IMPRESSIONS_DESKTOP_MAPS || 0) +
        (summary.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH || 0) +
        (summary.BUSINESS_IMPRESSIONS_MOBILE_MAPS || 0) +
        (summary.BUSINESS_IMPRESSIONS_MOBILE_SEARCH || 0),
    },
    actions: {
      directionRequests: summary.BUSINESS_DIRECTION_REQUESTS || 0,
      callClicks: summary.CALL_CLICKS || 0,
      websiteClicks: summary.WEBSITE_CLICKS || 0,
      bookings: summary.BUSINESS_BOOKINGS || 0,
    },
  };
}

module.exports = {
  listAccounts,
  listLocations,
  getDailyMetrics,
  getSearchKeywords,
  getPerformanceSummary,
};
