#!/usr/bin/env node
// runIndexCheck.js — CLI wrapper for the URL Inspection sweep.
//
// Usage:
//   node src/seo/runIndexCheck.js tattoo
//   node src/seo/runIndexCheck.js barbershop
//   node src/seo/runIndexCheck.js https://example.com/some/page   (single URL)
//
// Prints, per sitemap URL, whether Google has indexed it and — for the ones it
// hasn't — the coverageState reason to act on. Does NOT and cannot force
// indexing (Google offers no such API for general web pages); this is a
// diagnosis tool. See indexInspector.js header for the full explanation.

require("dotenv").config({ quiet: true });
const { sweepSitemap, inspectUrl } = require("./indexInspector");

const KNOWN_SITES = ["tattoo", "barbershop"];

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: node src/seo/runIndexCheck.js <tattoo|barbershop|full-url>");
    process.exit(1);
  }

  // Single-URL mode: an argument that looks like a URL.
  if (/^https?:\/\//.test(arg)) {
    // Infer which property owns it from the hostname.
    const siteKey = arg.includes("tattooshopminneapolis") ? "tattoo"
      : arg.includes("minneapolisbarbershop") ? "barbershop"
      : null;
    if (!siteKey) {
      console.error("Could not map that URL to a known Search Console property.");
      process.exit(1);
    }
    const r = await inspectUrl(siteKey, arg);
    console.log(`\n${r.indexed ? "✓ INDEXED" : "✗ NOT INDEXED"}  ${r.url}`);
    console.log(`  coverage: ${r.coverageState}`);
    console.log(`  lastCrawl: ${r.lastCrawlTime || "never"}`);
    const strip = (u) => (u || "").replace(/\/+$/, "");
    if (r.userCanonical && r.googleCanonical && strip(r.userCanonical) !== strip(r.googleCanonical)) {
      console.log(`  ⚠ canonical mismatch — you: ${r.userCanonical}  google: ${r.googleCanonical}`);
    }
    return;
  }

  if (!KNOWN_SITES.includes(arg)) {
    console.error(`Unknown site "${arg}". Known: ${KNOWN_SITES.join(", ")}, or pass a full URL.`);
    process.exit(1);
  }

  console.log(`\nSweeping sitemap for "${arg}" — inspecting each URL against Search Console...\n`);
  const r = await sweepSitemap(arg);

  console.log(`${arg.toUpperCase()} — ${r.total} URLs: ${r.indexedCount} indexed, ${r.notIndexedCount} not indexed, ${r.errorCount} errors\n`);

  if (r.notIndexed.length) {
    console.log("NOT INDEXED (fix the reason, not the sitemap):");
    for (const p of r.notIndexed) console.log(`  • ${p.url}\n      → ${p.coverageState}`);
    console.log("");
  }
  if (r.indexed.length) {
    console.log("INDEXED:");
    for (const p of r.indexed) console.log(`  ✓ ${p.url}`);
    console.log("");
  }
  // Flag canonical duplication across the indexed set (Google picked a
  // different canonical than the page declares). Normalize trailing slashes
  // first — ".../" vs "..." is the same URL, not a real mismatch.
  const normCanon = (u) => (u || "").replace(/\/+$/, "");
  const canonicalIssues = r.indexed.filter(
    (p) => p.userCanonical && p.googleCanonical && normCanon(p.userCanonical) !== normCanon(p.googleCanonical)
  );
  if (canonicalIssues.length) {
    console.log("⚠ CANONICAL MISMATCHES (Google chose a different canonical):");
    for (const p of canonicalIssues) console.log(`  • ${p.url}\n      you: ${p.userCanonical}\n      google: ${p.googleCanonical}`);
    console.log("");
  }
  if (r.errors.length) {
    console.log("ERRORS:");
    for (const e of r.errors) console.log(`  ✗ ${e.url} — ${e.error}`);
  }
}

main().catch((e) => {
  console.error("Index check failed:", e.response?.status || "", e.response?.data?.error?.message || e.message);
  process.exit(1);
});
