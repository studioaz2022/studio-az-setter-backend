// searchConsoleClient.js
// Google Search Console API client for SEO toolkit

require("dotenv").config({ quiet: true });
const axios = require("axios");

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_SEO_REFRESH_TOKEN;

const SITES = {
  barbershop: "sc-domain:minneapolisbarbershop.com",
  tattoo: "sc-domain:tattooshopminneapolis.com",
  hub: "sc-domain:studioaz.us",
};

// Also try URL-prefix format if sc-domain doesn't work
const SITES_URL_PREFIX = {
  barbershop: "https://minneapolisbarbershop.com/",
  tattoo: "https://tattooshopminneapolis.com/",
  hub: "https://www.studioaz.us/",
};

const BASE_URL = "https://searchconsole.googleapis.com/webmasters/v3";

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
 * Resolve which site URL format works for a given site key.
 * Search Console properties can be either domain or URL-prefix.
 */
async function resolveSiteUrl(siteKey) {
  const token = await getAccessToken();
  // Try domain property first
  const domainUrl = SITES[siteKey];
  if (domainUrl) {
    try {
      await axios.get(`${BASE_URL}/sites/${encodeURIComponent(domainUrl)}`, { headers: headers(token) });
      return domainUrl;
    } catch (_) {
      // Fall through to URL-prefix
    }
  }
  // Try URL-prefix
  const prefixUrl = SITES_URL_PREFIX[siteKey];
  if (prefixUrl) {
    try {
      await axios.get(`${BASE_URL}/sites/${encodeURIComponent(prefixUrl)}`, { headers: headers(token) });
      return prefixUrl;
    } catch (_) {
      // Fall through
    }
  }
  throw new Error(`Search Console property not found for "${siteKey}". Verify the site is added in Search Console.`);
}

/**
 * List all Search Console properties accessible to this account.
 */
async function listSites() {
  const token = await getAccessToken();
  const resp = await axios.get(`${BASE_URL}/sites`, { headers: headers(token) });
  return resp.data.siteEntry || [];
}

/**
 * Get search performance data (keywords, pages, clicks, impressions, CTR, position).
 *
 * @param {string} siteKey - "barbershop" or "tattoo"
 * @param {object} options
 * @param {string} options.startDate - YYYY-MM-DD (default: 28 days ago)
 * @param {string} options.endDate - YYYY-MM-DD (default: today)
 * @param {string[]} options.dimensions - e.g. ["query"], ["page"], ["query","page"]
 * @param {number} options.rowLimit - max rows (default: 25, max: 25000)
 * @param {string} options.type - "web", "image", "video" (default: "web")
 */
async function getSearchPerformance(siteKey, options = {}) {
  const token = await getAccessToken();
  const siteUrl = await resolveSiteUrl(siteKey);

  const now = new Date();
  const defaultStart = new Date(now);
  defaultStart.setDate(defaultStart.getDate() - 28);

  const body = {
    startDate: options.startDate || defaultStart.toISOString().split("T")[0],
    endDate: options.endDate || now.toISOString().split("T")[0],
    dimensions: options.dimensions || ["query"],
    rowLimit: options.rowLimit || 25,
    type: options.type || "web",
  };

  const url = `${BASE_URL}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const resp = await axios.post(url, body, { headers: headers(token) });
  return resp.data;
}

/**
 * Get top keywords with clicks, impressions, CTR, and average position.
 */
async function getTopKeywords(siteKey, { startDate, endDate, limit = 25 } = {}) {
  const data = await getSearchPerformance(siteKey, {
    startDate,
    endDate,
    dimensions: ["query"],
    rowLimit: limit,
  });

  return (data.rows || []).map((row) => ({
    keyword: row.keys[0],
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: Math.round(row.ctr * 10000) / 100, // percentage
    position: Math.round(row.position * 10) / 10,
  }));
}

/**
 * Get top pages by clicks.
 */
async function getTopPages(siteKey, { startDate, endDate, limit = 25 } = {}) {
  const data = await getSearchPerformance(siteKey, {
    startDate,
    endDate,
    dimensions: ["page"],
    rowLimit: limit,
  });

  return (data.rows || []).map((row) => ({
    page: row.keys[0],
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: Math.round(row.ctr * 10000) / 100,
    position: Math.round(row.position * 10) / 10,
  }));
}

/**
 * Get keyword + page combinations (which keywords drive traffic to which pages).
 */
async function getKeywordsByPage(siteKey, { startDate, endDate, limit = 50 } = {}) {
  const data = await getSearchPerformance(siteKey, {
    startDate,
    endDate,
    dimensions: ["query", "page"],
    rowLimit: limit,
  });

  return (data.rows || []).map((row) => ({
    keyword: row.keys[0],
    page: row.keys[1],
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: Math.round(row.ctr * 10000) / 100,
    position: Math.round(row.position * 10) / 10,
  }));
}

/**
 * Get performance by device (desktop, mobile, tablet).
 */
async function getDeviceBreakdown(siteKey, { startDate, endDate } = {}) {
  const data = await getSearchPerformance(siteKey, {
    startDate,
    endDate,
    dimensions: ["device"],
    rowLimit: 10,
  });

  return (data.rows || []).map((row) => ({
    device: row.keys[0],
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: Math.round(row.ctr * 10000) / 100,
    position: Math.round(row.position * 10) / 10,
  }));
}

module.exports = {
  listSites,
  getSearchPerformance,
  getTopKeywords,
  getTopPages,
  getKeywordsByPage,
  getDeviceBreakdown,
};
