# Phase 2 — SEO Architecture

**Goal:** Using Phase 1 research and the shared SEO Playbook (`../SEO_PLAYBOOK.md`), define the exact SEO blueprint for every page — title tags, meta descriptions, H1s, keyword assignments, schema markup, internal linking strategy, image optimization, and AI search readiness.

**Inputs:** All Phase 1 research documents + SEO_PLAYBOOK.md + SEO_OVERRIDES.md
**Outputs:** Page-by-page SEO blueprint that Phase 3 will implement literally

**Approval required:** Yes — this is the most critical review. Every SEO decision gets locked here before any code is written.

**Status:** Waiting for Phase 1 completion and approval.

---

## Planned Deliverables

### 1. `page-blueprint.md`
For each page:
- URL slug (3 Kings rule: 3-4 words max, no repeats from domain)
- Title tag (< 60 chars, primary keyword front-loaded, different from H1)
- Meta description (< 155 chars, includes keywords + CTA matched to buyer stage)
- H1 heading (primary keyword, scrambled from title tag)
- H2/H3 subheadings outline (keyword sweep + snippet-targeted Q&A sections)
- Primary + secondary keywords (from keyword-map.md)
- Internal links to/from other pages (with anchor text type: target/generic/brand)
- CTA strategy (matched to sale cycle stage: early/mid/late)
- Word count target (10-20% more than best competitor)
- Authority links (1+ per H2, DA/DR 80+ sites)
- Content hook style (knowledge bomb / entertainer / fear factor)

### 2. `schema-markup.md`
JSON-LD structured data per page type:
- Specific `@type` for each page (from SEO_OVERRIDES.md)
- BreadcrumbList on all non-homepage pages
- AggregateRating when 10+ reviews
- Validated against Google Rich Results Test + Schema.org Validator

### 3. `internal-linking.md`
- Link architecture diagram (hub-and-spoke from homepage)
- Per-page link map: which pages link to which, with anchor text
- Anchor text ratio enforcement: 50% target / 25% generic / 25% brand
- Breadcrumb structure with BreadcrumbList schema
- Link density target: 3-5 internal links per 1,000 words
- Footer link strategy

### 4. `image-strategy.md`
- File naming conventions (keyword-descriptive)
- Alt text patterns per page type
- Lazy loading rules (above-fold = priority, below-fold = lazy)
- Image format: WebP primary, JPEG fallback
- Responsive sizing via `next/image`
- GBP photo sync strategy

### 5. `technical-seo.md`
- `robots.ts` configuration (allow all crawlers including AI bots)
- `sitemap.ts` configuration (all pages, lastModified, changeFrequency)
- Core Web Vitals targets: LCP < 1.5s, INP < 100ms, CLS < 0.05
- Next.js App Router metadata strategy
- `llms.txt` file for AI crawler guidance
- Canonical URL strategy
- 404 page with internal links
- Mobile-first requirements

### 6. `geo-ai-readiness.md`
- AI crawler allowlist (GPTBot, ClaudeBot, PerplexityBot, Google-Extended)
- Content structure rules for AI passage citation
- Fact density targets
- FAQ optimization for AI Q&A extraction
- Entity consistency audit checklist
- Cross-platform sync plan (GBP → Bing Places → Apple Business Connect)
- AI visibility measurement plan
