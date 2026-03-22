// pageSpeedClient.js
// Google PageSpeed Insights API client — no auth needed (free public API)

const axios = require("axios");

const API_URL = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

const SITES = {
  barbershop: "https://minneapolisbarbershop.com/",
  tattoo: "https://tattooshopminneapolis.com/",
};

/**
 * Run a PageSpeed Insights audit.
 *
 * @param {string} siteKey - "barbershop" or "tattoo", or a full URL
 * @param {string} strategy - "mobile" or "desktop" (default: "mobile")
 * @param {string[]} categories - e.g. ["performance","accessibility","seo","best-practices"]
 */
async function runPageSpeed(siteKey, strategy = "mobile", categories = ["performance", "accessibility", "seo", "best-practices"]) {
  const url = SITES[siteKey] || siteKey;

  const params = {
    url,
    strategy,
    category: categories,
  };

  const resp = await axios.get(API_URL, { params, timeout: 60000 });
  const result = resp.data;

  // Extract Lighthouse scores
  const lighthouseResult = result.lighthouseResult || {};
  const categoryResults = lighthouseResult.categories || {};

  const scores = {};
  for (const [key, val] of Object.entries(categoryResults)) {
    scores[key] = Math.round((val.score || 0) * 100);
  }

  // Extract Core Web Vitals from field data
  const loadingExperience = result.loadingExperience || {};
  const metrics = loadingExperience.metrics || {};

  const coreWebVitals = {};
  const vitalsMapping = {
    LARGEST_CONTENTFUL_PAINT_MS: "lcp",
    FIRST_INPUT_DELAY_MS: "fid",
    CUMULATIVE_LAYOUT_SHIFT_SCORE: "cls",
    INTERACTION_TO_NEXT_PAINT: "inp",
    FIRST_CONTENTFUL_PAINT_MS: "fcp",
    EXPERIMENTAL_TIME_TO_FIRST_BYTE: "ttfb",
  };

  for (const [apiKey, shortKey] of Object.entries(vitalsMapping)) {
    if (metrics[apiKey]) {
      coreWebVitals[shortKey] = {
        percentile: metrics[apiKey].percentile,
        category: metrics[apiKey].category, // FAST, AVERAGE, SLOW
      };
    }
  }

  // Extract key audit results
  const audits = lighthouseResult.audits || {};
  const keyAudits = [];
  const auditKeys = [
    "first-contentful-paint",
    "largest-contentful-paint",
    "total-blocking-time",
    "cumulative-layout-shift",
    "speed-index",
    "interactive",
    "server-response-time",
    "render-blocking-resources",
    "unused-css-rules",
    "unused-javascript",
    "modern-image-formats",
    "uses-optimized-images",
    "uses-text-compression",
    "meta-description",
    "document-title",
    "image-alt",
    "link-text",
    "crawlable-anchors",
    "is-crawlable",
    "robots-txt",
    "hreflang",
    "canonical",
    "structured-data",
  ];

  for (const key of auditKeys) {
    if (audits[key]) {
      keyAudits.push({
        id: key,
        title: audits[key].title,
        score: audits[key].score,
        displayValue: audits[key].displayValue || null,
        description: audits[key].description?.replace(/\[.*?\]\(.*?\)/g, "").trim().slice(0, 200),
      });
    }
  }

  return {
    url,
    strategy,
    scores,
    coreWebVitals,
    overallCategory: loadingExperience.overall_category || "N/A",
    audits: keyAudits,
    fetchTime: lighthouseResult.fetchTime,
  };
}

/**
 * Run both mobile and desktop audits for a site.
 */
async function runFullAudit(siteKey) {
  const [mobile, desktop] = await Promise.all([
    runPageSpeed(siteKey, "mobile"),
    runPageSpeed(siteKey, "desktop"),
  ]);

  return { mobile, desktop };
}

module.exports = {
  runPageSpeed,
  runFullAudit,
};
