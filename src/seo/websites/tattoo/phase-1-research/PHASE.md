# Phase 1 — Research & Data Collection

**Goal:** Gather all competitive intelligence, keyword data, and content gap analysis needed to make informed SEO architecture decisions in Phase 2.

**Inputs:** SITEMAP.md (page list + business info), SerpAPI data, Search Console data, competitor site teardowns
**Outputs:** 4 research documents (below) that Phase 2 will reference directly

**Approval required:** Yes — review all 4 deliverables before moving to Phase 2.

---

## Deliverables

### 1. `keyword-map.md` — Target Keywords Per Page
For each page in SITEMAP.md, identify:
- **Primary keyword** (1 per page — the main thing this page should rank for)
- **Secondary keywords** (2-5 per page — related terms and long-tail variations)
- **Search intent** (informational, navigational, transactional, local)
- **Estimated search volume** (from SerpAPI local pack + organic data)
- **Current ranking** (if we rank at all — from our existing SerpAPI data)
- **Difficulty signal** (how many strong competitors rank for this term)

Data sources:
- SerpAPI: `searchLocalPack()` and `searchGoogleMaps()` for each candidate keyword
- Search Console: `getTopKeywords("tattoo")` for any existing impressions/clicks
- Manual: industry knowledge of what tattoo clients search for

### 2. `competitor-teardown.md` — Top Competitor Site Analysis
Tear down the top 3-5 tattoo shop websites that rank well in Minneapolis:
- **Which pages they have** (and we don't)
- **Their title tags, meta descriptions, H1s** for key pages
- **Schema markup** they use (JSON-LD types)
- **Content depth** — word count, FAQ sections, blog presence
- **Internal linking patterns**
- **Page speed scores** (via our PageSpeed tool)
- **Review count and rating** (from SerpAPI data we already have)

Priority competitors (from our earlier analysis):
- Uptown Tattoo (4.8 rating, 165 reviews, avg position 2.2)
- Minneapolis Tattoo Shop (4.7, 464 reviews, avg position 3.6)
- Sailor Jerry's Tattoo (if ranking)
- Any shops appearing in top 5 for target keywords

### 3. `content-gaps.md` — What We Need That Competitors Have
Cross-reference competitor teardowns with our page list:
- **Pages competitors have that we don't** — do we need them?
- **Content types** they use (blog posts, style guides, artist spotlights, process explainers)
- **FAQ questions** they answer that we should too
- **Local content signals** (neighborhood mentions, Minneapolis landmarks, area guides)
- **Media types** (video tours, process videos, timelapse tattoo videos)
- **Trust signals** (certifications, health department compliance, awards)

### 4. `baseline-audit.md` — Current Site Scores & Issues
Run our existing SEO tools against the current tattooshopminneapolis.com:
- **Site audit** (via `auditPage("tattoo")`) — technical SEO issues
- **PageSpeed scores** (via `runFullAudit("tattoo")`) — mobile + desktop
- **Search Console data** — any keywords we currently get impressions for
- **Schema validation** — what structured data exists (if any)
- **Current ranking snapshot** — position for all target keywords

This becomes the "before" benchmark so we can measure improvement after launch.

---

## Research Process

1. **Automated data collection** — Run our SEO toolkit endpoints to gather SerpAPI, Search Console, and PageSpeed data
2. **Competitor site crawls** — Fetch and analyze competitor homepages, service pages, and artist pages
3. **Keyword expansion** — Start with obvious terms ("tattoo shop Minneapolis"), expand based on what competitors rank for and what Search Console shows
4. **Compile into documents** — Write findings into the 4 deliverables above
5. **Present for review** — All 4 docs ready for your approval before Phase 2

## Keyword Seed List (Starting Point)

These are the keywords we'll research first, then expand based on findings:

**High-intent local:**
- tattoo shop Minneapolis
- tattoo artist Minneapolis
- tattoo shop near me
- best tattoo shop Minneapolis
- tattoo studio Minneapolis
- Minneapolis tattoo parlor

**Style-specific:**
- fine line tattoo Minneapolis
- realism tattoo Minneapolis
- black and grey tattoo Minneapolis
- custom tattoo Minneapolis
- small tattoo Minneapolis

**Service-specific:**
- tattoo consultation Minneapolis
- tattoo deposit
- first tattoo Minneapolis
- tattoo touch up Minneapolis
- cover up tattoo Minneapolis

**Neighborhood/local:**
- tattoo shop North Loop
- tattoo near downtown Minneapolis
- tattoo shop warehouse district

**Informational (aftercare page):**
- tattoo aftercare
- tattoo healing process
- how to care for new tattoo
- tattoo aftercare tips

**Artist-specific:**
- Joan Martinez tattoo artist
- Andrew Fernandez tattoo artist

---

## SerpAPI Budget

We have 1,000 searches/month on the $25 plan. 14 used so far this month.
Estimated usage for Phase 1: ~80-120 searches (keyword research + competitor analysis).
Plenty of budget remaining.
