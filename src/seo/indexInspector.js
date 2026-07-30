// indexInspector.js
// Google Search Console URL Inspection API — diagnoses why pages are (or aren't)
// indexed. Reuses the SEO toolkit's OAuth (GOOGLE_SEO_REFRESH_TOKEN); the
// webmasters.readonly scope is sufficient for inspection.
//
// IMPORTANT — what this can and cannot do:
//   • It CANNOT force/request indexing. Google's Indexing API is restricted to
//     JobPosting + BroadcastEvent content only; there is no API to submit a
//     general web page for indexing. The web UI "Request Indexing" button has
//     no API equivalent.
//   • It CAN tell you, per URL, whether Google has indexed it and WHY not —
//     which is the actual actionable signal (fix canonicals, internal links,
//     robots blocks, thin content, etc.).
//
// Rate limits: the Inspection API throttles aggressively (~600/min, 2000/day
// per property). We inspect serially with a small delay; fine for a normal
// sitemap (tens of URLs), not for thousands without batching.

require("dotenv").config({ quiet: true });
const axios = require("axios");

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_SEO_REFRESH_TOKEN;

const INSPECT_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

// Search Console property (siteUrl) per site. Inspection requires the exact
// property that owns the URL; domain properties use the sc-domain: form.
const SITE_PROPERTY = {
  tattoo: "sc-domain:tattooshopminneapolis.com",
  barbershop: "sc-domain:minneapolisbarbershop.com",
};

const SITEMAP = {
  tattoo: "https://tattooshopminneapolis.com/sitemap.xml",
  barbershop: "https://minneapolisbarbershop.com/sitemap.xml",
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Inspect a single URL against a site's Search Console property.
 * Returns a flattened, human-readable result.
 */
async function inspectUrl(siteKey, url) {
  const siteUrl = SITE_PROPERTY[siteKey] || siteKey;
  const token = await getAccessToken();

  const resp = await axios.post(
    INSPECT_URL,
    { inspectionUrl: url, siteUrl },
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
  );

  const idx = resp.data.inspectionResult?.indexStatusResult || {};
  return {
    url,
    verdict: idx.verdict || "UNKNOWN",            // PASS / NEUTRAL / FAIL
    coverageState: idx.coverageState || "unknown", // e.g. "Submitted and indexed", "Crawled - currently not indexed"
    indexed: idx.verdict === "PASS",
    robotsTxtState: idx.robotsTxtState || null,
    googleCanonical: idx.googleCanonical || null,
    userCanonical: idx.userCanonical || null,
    lastCrawlTime: idx.lastCrawlTime || null,
    pageFetchState: idx.pageFetchState || null,
  };
}

/**
 * Fetch a sitemap and return its <loc> URLs.
 */
async function getSitemapUrls(siteKey) {
  const sitemapUrl = SITEMAP[siteKey];
  if (!sitemapUrl) throw new Error(`No sitemap configured for "${siteKey}"`);
  const resp = await axios.get(sitemapUrl, { timeout: 20000 });
  const locs = [...resp.data.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  return [...new Set(locs)];
}

/**
 * Inspect every URL in a site's sitemap and group the results by index status.
 * @param {number} delayMs - pause between inspections (default 250ms) to stay
 *   under the API's per-minute throttle.
 */
async function sweepSitemap(siteKey, { delayMs = 250 } = {}) {
  const urls = await getSitemapUrls(siteKey);
  const indexed = [];
  const notIndexed = [];
  const errors = [];

  for (const url of urls) {
    try {
      const r = await inspectUrl(siteKey, url);
      (r.indexed ? indexed : notIndexed).push(r);
    } catch (e) {
      errors.push({ url, error: e.response?.status || e.message });
    }
    await sleep(delayMs);
  }

  return {
    siteKey,
    total: urls.length,
    indexedCount: indexed.length,
    notIndexedCount: notIndexed.length,
    errorCount: errors.length,
    indexed,
    notIndexed,  // each carries coverageState = the reason to act on
    errors,
  };
}

module.exports = { inspectUrl, sweepSitemap, getSitemapUrls, getAccessToken };
