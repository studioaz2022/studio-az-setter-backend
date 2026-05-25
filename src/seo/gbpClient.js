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

// ──────────────────────────────────────
// v4 API (legacy) — needed for reviews + posts (no v1 equivalent)
// ──────────────────────────────────────

const V4_URL = "https://mybusiness.googleapis.com/v4";

/**
 * Fetch all reviews for a location via the v4 endpoint. Paginates through
 * pageToken until exhausted.
 *
 * Returns the raw review objects from Google. Shape per review:
 *   {
 *     name: "accounts/.../locations/.../reviews/<reviewId>",
 *     reviewId,
 *     reviewer: { profilePhotoUrl, displayName, isAnonymous },
 *     starRating: "ONE"|"TWO"|"THREE"|"FOUR"|"FIVE",
 *     comment: "..." (optional),
 *     createTime, updateTime,
 *     reviewReply?: { comment, updateTime }
 *   }
 *
 * @param {string} accountId  e.g. "accounts/107017428683340496769"
 * @param {string} locationId e.g. "locations/13377765707428643781"
 * @param {object} opts
 * @param {number} opts.maxPages  cap on pagination (default 10 = up to 500 reviews)
 */
async function listReviews(accountId, locationId, { maxPages = 10 } = {}) {
  const token = await getAccessToken();
  const out = [];
  let pageToken;
  let pages = 0;
  while (pages < maxPages) {
    const params = { pageSize: 50 };
    if (pageToken) params.pageToken = pageToken;
    const resp = await axios.get(
      `${V4_URL}/${accountId}/${locationId}/reviews`,
      { headers: headers(token), params }
    );
    const reviews = resp.data.reviews || [];
    out.push(...reviews);
    pageToken = resp.data.nextPageToken;
    pages += 1;
    if (!pageToken) break;
  }
  return {
    reviews: out,
    totalReviewCount: out.length,
    averageRating: computeAverageRating(out),
  };
}

const STAR_TO_NUMBER = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

function computeAverageRating(reviews) {
  if (!reviews.length) return 0;
  let sum = 0;
  let n = 0;
  for (const r of reviews) {
    const v = STAR_TO_NUMBER[r.starRating];
    if (v != null) { sum += v; n += 1; }
  }
  if (n === 0) return 0;
  return Math.round((sum / n) * 10) / 10;
}

module.exports = {
  listAccounts,
  listLocations,
  getDailyMetrics,
  getSearchKeywords,
  getPerformanceSummary,
  listReviews,
  STAR_TO_NUMBER,
};
