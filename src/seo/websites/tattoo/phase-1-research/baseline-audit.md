# Baseline Audit — Current tattooshopminneapolis.com

**Generated:** March 23, 2026
**Purpose:** "Before" snapshot to measure improvement after new site launch
**Data Sources:** SerpAPI Google Maps rankings, Local Falcon geo-grid scans, website crawl

---

## Current Site Overview

| Element | Status |
|---------|--------|
| **Platform** | GoHighLevel (GHL) page builder |
| **Domain** | tattooshopminneapolis.com |
| **SSL** | Yes (HTTPS) |
| **Mobile Responsive** | Yes (breakpoints at 480px) |
| **Word Count** | ~200-300 words |
| **Schema Markup** | None |
| **Sitemap.xml** | None detected |
| **Robots.txt** | None detected |
| **Image Alt Text** | None |
| **Blog** | No |
| **Individual Pages** | Single-page (GHL funnel) |

### Critical Issues
1. **GHL page builder** — not a real website. Renders as a single long page with no URL structure
2. **No schema markup** — no LocalBusiness, no Organization, nothing
3. **No sitemap.xml** — Google can't efficiently discover pages
4. **No robots.txt** — no crawl directives
5. **No image alt text** — all images invisible to search engines
6. **~200-300 words** — far below the minimum needed for ranking
7. **Multiple H1 tags** — violates single-H1 best practice
8. **No individual pages** — no /services, /artists, /aftercare URLs to rank
9. **Heavy CSS/JS** — GHL templates are bloated, hurting Core Web Vitals

---

## Current Google Maps Rankings (SerpAPI — March 23, 2026)

| Keyword | Maps Position | Found? | Notes |
|---------|--------------|--------|-------|
| tattoo shop Minneapolis | Not found | No | Top 5: Minneapolis Tattoo Shop, Uptown, Broken Hearts, Tiger Rose, Brass Knuckle |
| tattoo artist Minneapolis | Not found | No | Top 3: Uptown, Minneapolis Tattoo Shop, Timeless |
| best tattoo shop Minneapolis | Not found | No | Top 3: Minneapolis Tattoo Shop, Uptown, Tiger Rose |
| custom tattoo Minneapolis | Not found | No | Top 3: Stone Arch, Uptown, Citadel |
| tattoo shop near me | Not found | No | Top 3: Black Coffin, Uptown, Broken Hearts |
| fine line tattoo Minneapolis | Not found | No | Top 3: Fine Line Tattoo Kaya, Minneapolis Tattoo Shop, Leviticus |
| **tattoo shop North Loop Minneapolis** | **#7** | **Yes** | **Only keyword where we appear!** Top 3: Atomic, Thirty8 Caliber, Tiger Rose |
| Studio AZ Tattoo (brand) | Not found | No | 0 results returned — brand has no search presence |

**Summary:** Studio AZ appears in Google Maps results for exactly **1 of 8 keywords tested** — the hyper-local neighborhood query "tattoo shop North Loop Minneapolis" at position #7.

---

## Current Google Organic Rankings

Studio AZ Tattoo / tattooshopminneapolis.com does **not appear in organic results** for any tested keyword. The current GHL page is not indexed or ranked for any search terms.

---

## Local Falcon Geo-Grid Baseline (March 23, 2026)

Full data in [local-falcon-baseline.md](local-falcon-baseline.md). Summary:

| Keyword | ARP | SoLV | Grid Points Found | Center Position |
|---------|-----|------|-------------------|----------------|
| tattoo shop Minneapolis | 3.00 | 0.83 | 1/121 (0.83%) | #3 |
| tattoo shop near me | 4.00 | 0.00 | 1/121 (0.83%) | #4 |
| tattoo artist Minneapolis | 8.00 | 0.00 | 1/121 (0.83%) | #8 |
| best tattoo shop Minneapolis | 21.00 | 0.00 | 0/121 (0.00%) | 20+ |
| custom tattoo Minneapolis | 21.00 | 0.00 | 0/121 (0.00%) | 20+ |

**ARP** = Average Rank Position (lower = better, 21 = not found)
**SoLV** = Share of Local Voice (% of grid where we're in top 3)
**Baseline SoLV across all keywords: 0.17%** (effectively zero)

---

## GBP (Google Business Profile) Status

| Signal | Current | Market Leader Avg |
|--------|---------|-------------------|
| Reviews | 9 | ~350 |
| Rating | 5.0 | 4.7-4.9 |
| Photos | Unknown | — |
| Posts | None (per Local Falcon AI) | — |
| Products | Not used (per Local Falcon AI) | — |
| Categories | Tattoo Shop | Tattoo Shop + additional |
| Website URL | tattooshopminneapolis.com | Various |

### GBP Actions Needed (from Local Falcon AI recommendations)
1. Start consistent posting schedule (weekly posts)
2. Add services to Products feature
3. Aggressive review generation (target: 9 → 50 in 3 months)
4. Add more photos (studio, work, artists)
5. Ensure NAP consistency across all citations
6. Claim Yelp listing
7. Add secondary categories if applicable

---

## Technical SEO Baseline

### What the Current GHL Site Lacks (that the new Next.js site will have)
| Feature | GHL Site | New Site Target |
|---------|----------|----------------|
| Unique URLs per page | No (single page) | 10 unique pages |
| Title tags per page | 1 generic | 10 unique, keyword-optimized |
| Meta descriptions | None | 10 unique with CTAs |
| H1 tags | Multiple (broken) | 1 per page, keyword-rich |
| Schema markup | None | LocalBusiness, FAQPage, HowTo, Person, Service |
| Sitemap.xml | None | Auto-generated |
| Robots.txt | None | Configured |
| Image alt text | None | All images |
| Core Web Vitals | Unknown (GHL bloat) | LCP < 2.5s, CLS < 0.1, INP < 200ms |
| Page Speed | Likely 40-60 (GHL) | Target 90+ mobile/desktop |
| Internal linking | None | Silo structure per SEO_RULES.md |
| Content depth | ~200-300 words total | ~7,000-8,500 words total |
| Blog | None | Future phase |
| Bilingual | No | Spanish sections on key pages |

---

## Competitive Gap Summary

### Where Studio AZ Stands Today
- **Maps visibility:** 0.17% SoLV (essentially invisible)
- **Organic visibility:** Not indexed for any target keywords
- **Reviews:** 39x fewer than market leader average
- **Content:** 10-15x less content than the best competitor (Nokomis)
- **Technical SEO:** Zero optimization on current GHL page

### Where Studio AZ Can Realistically Be in 6 Months
- **Maps visibility:** 5-15% SoLV (with reviews + GBP optimization)
- **Organic visibility:** Page 1 for 3-5 Tier 2/3 keywords, Top 20 for Tier 1
- **Reviews:** 50-75 (with systematic review generation)
- **Content:** Most content-rich tattoo site in Minneapolis
- **Technical SEO:** Best-optimized tattoo site in Minneapolis

### What Drives the Biggest Impact
1. **Reviews (40% of improvement):** 9 → 50+ reviews unlocks map pack visibility
2. **Website (30%):** Proper on-page SEO + content depth for organic rankings
3. **GBP optimization (20%):** Posts, products, photos, categories
4. **Citations (10%):** Consistent NAP across Yelp, Facebook, Apple Maps, etc.

The new website handles #2. GBP optimization (#3) and citations (#4) can run in parallel. Reviews (#1) require operational changes (asking every client to review).

---

## Tracking Plan

After launch, we'll measure improvement using:
1. **Local Falcon** — Monthly geo-grid scans for the same 5 keywords (same grid: 11x11, 4.5mi)
2. **SerpAPI** — Weekly organic + maps position tracking for all target keywords
3. **Google Search Console** — Impressions, clicks, average position
4. **PageSpeed Insights** — Core Web Vitals scores
5. **Site audit** — Monthly crawl for technical issues

### Key Metrics to Track
| Metric | Baseline (March 2026) | 3-Month Target | 6-Month Target |
|--------|----------------------|----------------|----------------|
| Avg SoLV (5 keywords) | 0.17% | 3-5% | 10-15% |
| Google Reviews | 9 | 30 | 50+ |
| Organic Keywords Ranking | 0 | 5-10 | 15-25 |
| Page 1 Rankings | 0 | 2-3 | 5-8 |
| PageSpeed Mobile | ~40 (est.) | 90+ | 90+ |
| Indexed Pages | 1 | 10 | 10+ |
| Monthly Organic Clicks | 0 | 50-100 | 200-500 |
