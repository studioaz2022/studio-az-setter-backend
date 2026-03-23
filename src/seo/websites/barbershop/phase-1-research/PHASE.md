# Phase 1 — Research & Data Collection

**Goal:** Gather all competitive intelligence, keyword data, and content gap analysis needed to make informed SEO architecture decisions in Phase 2.

**Inputs:** SITEMAP.md (page list + business info), SerpAPI data, Search Console data, competitor site teardowns
**Outputs:** 5 research documents (below) that Phase 2 will reference directly

**Approval required:** Yes — review all deliverables before moving to Phase 2.

**Status:** Not started.

---

## Deliverables

### 1. `keyword-map.md` — Target Keywords Per Page
For each page in SITEMAP.md, identify:
- **Primary keyword** (1 per page — the main thing this page should rank for)
- **Secondary keywords** (2-5 per page — related terms and long-tail variations)
- **Search intent** (informational, navigational, transactional, local)
- **Estimated search volume** (from SerpAPI local pack + organic data)
- **Current ranking** (if we rank at all)
- **Difficulty signal** (how many strong competitors rank for this term)

Data sources:
- SerpAPI: `searchLocalPack()` and `searchGoogleMaps()` for each candidate keyword
- Search Console: existing impressions/clicks
- Manual: industry knowledge

### 2. `competitor-teardown.md` — Top Competitor Site Analysis
Tear down the top 3-5 competitor websites that rank well locally:
- **Which pages they have** (and we don't)
- **Their title tags, meta descriptions, H1s** for key pages
- **Schema markup** they use (JSON-LD types)
- **Content depth** — word count, FAQ sections, blog presence
- **Internal linking patterns**
- **Page speed scores**
- **Review count and rating** (from SerpAPI data)

### 3. `content-gaps.md` — What We Need That Competitors Have
Cross-reference competitor teardowns with our page list:
- **Pages competitors have that we don't** — do we need them?
- **Content types** they use (blogs, guides, spotlights, process explainers)
- **FAQ questions** they answer that we should too
- **Local content signals** (neighborhood mentions, landmarks, area guides)
- **Media types** (video tours, process videos)
- **Trust signals** (certifications, compliance, awards)

### 4. `baseline-audit.md` — Current Site Scores & Issues
Run SEO tools against the current site:
- **Site audit** — technical SEO issues
- **PageSpeed scores** — mobile + desktop
- **Search Console data** — any keywords with current impressions
- **Schema validation** — what structured data exists (if any)
- **Current ranking snapshot** — position for all target keywords

This becomes the "before" benchmark to measure improvement after launch.

### 5. `local-falcon-baseline.md` — Geo-Grid Rank Tracking
Run Local Falcon scans for primary keywords:
- 11x11 grid, 4.5mi radius centered on business location
- Record ARP (Average Rank Position) and SoLV (Share of Local Voice)
- Identify top competitors per keyword
- Identify vulnerable competitors (beatable ranking + review count)

---

## Research Process

1. **Automated data collection** — Run SerpAPI searches for keyword candidates
2. **Competitor site crawls** — Fetch and analyze competitor homepages, service pages, team pages
3. **Keyword expansion** — Start with obvious terms, expand based on competitor rankings and Search Console
4. **Compile into documents** — Write findings into the deliverables above
5. **Present for review** — All docs ready for approval before Phase 2

## SerpAPI Budget

1,000 searches/month on the $25 plan.
Estimated usage for Phase 1: ~80-120 searches.
