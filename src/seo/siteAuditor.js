// siteAuditor.js
// Crawl and audit a website for technical SEO issues

const axios = require("axios");

const SITES = {
  barbershop: "https://minneapolisbarbershop.com/",
  tattoo: "https://tattooshopminneapolis.com/",
};

/**
 * Fetch a page and extract SEO-relevant elements.
 */
async function auditPage(siteKey) {
  const url = SITES[siteKey] || siteKey;

  const resp = await axios.get(url, {
    timeout: 30000,
    headers: {
      "User-Agent": "StudioAZ-SEO-Auditor/1.0",
      Accept: "text/html",
    },
  });

  const html = resp.data;
  const issues = [];
  const info = {};

  // Title tag
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
  info.title = titleMatch ? titleMatch[1].trim() : null;
  if (!info.title) issues.push({ severity: "critical", issue: "Missing title tag" });
  else if (info.title.length > 60) issues.push({ severity: "warning", issue: `Title tag too long (${info.title.length} chars, ideal: ≤60)` });

  // Meta description
  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["'](.*?)["']/is);
  info.metaDescription = descMatch ? descMatch[1].trim() : null;
  if (!info.metaDescription) issues.push({ severity: "critical", issue: "Missing meta description" });
  else if (info.metaDescription.length > 160) issues.push({ severity: "warning", issue: `Meta description too long (${info.metaDescription.length} chars, ideal: ≤160)` });

  // Canonical tag
  const canonicalMatch = html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["'](.*?)["']/is);
  info.canonical = canonicalMatch ? canonicalMatch[1] : null;
  if (!info.canonical) issues.push({ severity: "high", issue: "Missing canonical tag — risk of duplicate content" });

  // H1 tags
  const h1Matches = html.match(/<h1[^>]*>(.*?)<\/h1>/gis) || [];
  info.h1Count = h1Matches.length;
  info.h1Tags = h1Matches.map((h) => h.replace(/<[^>]+>/g, "").trim()).filter(Boolean);
  if (info.h1Count === 0) issues.push({ severity: "critical", issue: "No H1 tag found" });
  else if (info.h1Count > 1) issues.push({ severity: "high", issue: `Multiple H1 tags (${info.h1Count}) — should be exactly 1` });

  // H2 tags
  const h2Matches = html.match(/<h2[^>]*>(.*?)<\/h2>/gis) || [];
  info.h2Count = h2Matches.length;
  info.h2Tags = h2Matches.map((h) => h.replace(/<[^>]+>/g, "").trim()).filter(Boolean).slice(0, 10);

  // Images without alt text
  const imgMatches = html.match(/<img[^>]*>/gis) || [];
  const imagesWithoutAlt = imgMatches.filter((img) => {
    const altMatch = img.match(/alt=["'](.*?)["']/is);
    return !altMatch || altMatch[1].trim() === "";
  });
  info.totalImages = imgMatches.length;
  info.imagesWithoutAlt = imagesWithoutAlt.length;
  if (imagesWithoutAlt.length > 0) {
    issues.push({
      severity: "high",
      issue: `${imagesWithoutAlt.length} of ${imgMatches.length} images missing alt text`,
    });
  }

  // Open Graph tags
  const ogTags = {};
  const ogMatches = html.matchAll(/<meta[^>]*property=["'](og:[^"']+)["'][^>]*content=["'](.*?)["']/gis);
  for (const match of ogMatches) ogTags[match[1]] = match[2];
  info.openGraph = ogTags;
  if (!ogTags["og:title"]) issues.push({ severity: "medium", issue: "Missing og:title" });
  if (!ogTags["og:description"]) issues.push({ severity: "medium", issue: "Missing og:description" });
  if (!ogTags["og:image"]) issues.push({ severity: "medium", issue: "Missing og:image" });
  if (!ogTags["og:url"]) issues.push({ severity: "medium", issue: "Missing og:url" });

  // Twitter Card tags
  const twitterCard = html.match(/<meta[^>]*name=["']twitter:card["']/is);
  if (!twitterCard) issues.push({ severity: "low", issue: "Missing Twitter Card tags" });

  // JSON-LD structured data
  const jsonLdMatches = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/gis) || [];
  info.structuredData = [];
  for (const match of jsonLdMatches) {
    const jsonStr = match.replace(/<script[^>]*>/i, "").replace(/<\/script>/i, "").trim();
    try {
      const parsed = JSON.parse(jsonStr);
      info.structuredData.push(parsed);
    } catch (_) {
      info.structuredData.push({ raw: jsonStr.slice(0, 200), parseError: true });
    }
  }

  const hasLocalBusiness = info.structuredData.some(
    (sd) => sd["@type"] && /barber|salon|hair|tattoo|local\s*business/i.test(sd["@type"])
  );
  if (!hasLocalBusiness) {
    issues.push({
      severity: "critical",
      issue: "No LocalBusiness/BarberShop/TattooParlor structured data — essential for local SEO",
    });
  }

  // Robots meta
  const robotsMatch = html.match(/<meta[^>]*name=["']robots["'][^>]*content=["'](.*?)["']/is);
  info.robotsMeta = robotsMatch ? robotsMatch[1] : null;

  // Viewport
  const viewportMatch = html.match(/<meta[^>]*name=["']viewport["']/is);
  if (!viewportMatch) issues.push({ severity: "high", issue: "Missing viewport meta tag — bad for mobile" });

  // HTTPS check
  info.isHttps = url.startsWith("https://");
  if (!info.isHttps) issues.push({ severity: "critical", issue: "Site not served over HTTPS" });

  // Language
  const langMatch = html.match(/<html[^>]*lang=["'](.*?)["']/is);
  info.language = langMatch ? langMatch[1] : null;
  if (!info.language) issues.push({ severity: "low", issue: "Missing lang attribute on <html>" });

  // Sort issues by severity
  const severityOrder = { critical: 0, high: 1, medium: 2, warning: 3, low: 4 };
  issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return {
    url,
    auditDate: new Date().toISOString(),
    info,
    issues,
    issueCount: {
      critical: issues.filter((i) => i.severity === "critical").length,
      high: issues.filter((i) => i.severity === "high").length,
      medium: issues.filter((i) => i.severity === "medium").length,
      warning: issues.filter((i) => i.severity === "warning").length,
      low: issues.filter((i) => i.severity === "low").length,
    },
  };
}

module.exports = {
  auditPage,
};
