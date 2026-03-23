# Phase 2 — SEO Architecture

**Goal:** Using Phase 1 research and the SEO Playbook (SEO_RULES.md), define the exact SEO blueprint for every page — title tags, meta descriptions, H1s, keyword assignments, schema markup, internal linking strategy, image optimization, and AI search readiness.

**Inputs:** All 5 Phase 1 research documents + SEO_PLAYBOOK.md + SEO_OVERRIDES.md
**Outputs:** Page-by-page SEO blueprint that Phase 3 will implement literally + content intake questionnaire

**Approval required:** Yes — this is the most critical review. Every SEO decision gets locked here before any code is written.

**Status:** COMPLETE — 7 deliverables created. Pending approval.

---

## Planned Deliverables

### 1. `page-blueprint.md`
For each of the 10 pages:
- URL slug (3 Kings rule: 3-4 words max, no repeats)
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
- Home: `TattooParlor` (LocalBusiness subtype) + `Organization` + `BreadcrumbList` + `AggregateRating` (when 10+ reviews)
- Services: `Service` + `Offer` per service + `BreadcrumbList`
- Artists (index): `ItemList` of `Person` + `BreadcrumbList`
- Joan / Andrew: `Person` + `worksFor` + `knowsAbout` + `ImageGallery` + `BreadcrumbList`
- Gallery: `ImageGallery` + `ImageObject` per image + `BreadcrumbList`
- Aftercare: `Article` + `HowTo` (day-by-day healing) + `BreadcrumbList`
- Parking: `Article` + `BreadcrumbList`
- FAQ: `FAQPage` (every Q&A pair) + `BreadcrumbList`
- Contact: `TattooParlor` (NAP duplication) + `BreadcrumbList`

All schemas validated against Google Rich Results Test + Schema.org Validator.
`sameAs` links to all social profiles + Google Maps Place URL.
`openingHoursSpecification` matches GBP hours exactly.

### 3. `internal-linking.md`
- Link architecture diagram (hub-and-spoke from homepage)
- Per-page link map: which pages link to which, with anchor text
- Anchor text ratio enforcement: 50% target / 25% generic / 25% brand
- Breadcrumb structure with `BreadcrumbList` schema
- Cross-linking rules (related pages only — no topic confusion)
- Link density target: 3-5 internal links per 1,000 words
- Contextual placement rules (links in sentences, not lists)
- Footer link strategy (NAP, secondary nav, sitemap link)

### 4. `image-strategy.md`
- File naming conventions (keyword-descriptive, e.g., `fine-line-tattoo-minneapolis.webp`)
- Alt text patterns per page type (keyword + descriptive, unique per image)
- Lazy loading rules (above-fold = priority, below-fold = lazy)
- Image format: WebP primary, JPEG fallback
- Responsive sizing via `next/image` component
- Google Lens optimization: real photos only (no stock), branded where possible
- GBP photo sync strategy (upload same photos to GBP weekly)

### 5. `technical-seo.md` *(NEW)*
- `robots.ts` configuration (allow all crawlers including AI bots)
- `sitemap.ts` configuration (all 10 pages, `lastModified`, `changeFrequency`)
- Core Web Vitals targets: LCP < 1.5s, INP < 100ms, CLS < 0.05
- Next.js App Router metadata strategy (`generateMetadata` vs static `metadata`)
- `llms.txt` file for AI crawler guidance
- Canonical URL strategy
- 404 page with internal links
- Mobile-first design requirements (48px touch targets, 16px body text, no horizontal scroll)

### 6. `geo-ai-readiness.md` *(NEW)*
- AI crawler allowlist (GPTBot, ClaudeBot, PerplexityBot, Google-Extended)
- Content structure rules for AI passage citation (standalone H2 sections, direct answers in first 40-60 words)
- Fact density targets (statistic/specific every 150-200 words)
- FAQ optimization for AI Q&A extraction
- Entity consistency audit checklist (same brand name everywhere)
- Cross-platform sync plan (GBP → Bing Places → Apple Business Connect)
- AI visibility measurement plan (quarterly ChatGPT/Perplexity/Gemini checks)

### 7. `content-intake.md`
Business-specific questionnaire — the bridge between Phase 2 and Phase 3:
- Business identity confirmation (NAP, hours, socials)
- Artist details (bios, specialties, experience, philosophy, photos)
- Services & pricing (complete list with rates, minimums, hourly vs flat)
- Policies (deposits, cancellations, walk-ins, age, payment, touch-ups)
- The tattoo process (client journey, preparation, what to expect, what to avoid)
- Aftercare instructions (bandage, washing, moisturizing, healing timeline, products)
- Location & parking (entry, parking lots/ramps/meters, transit, landmarks)
- About the studio (founding, philosophy, differentiators, vibe)
- FAQ answers (plain-language answers to the 15-20 questions from page-blueprint.md)
- Image inventory (portfolio, artist portraits, studio, location photos)
- Spanish content plan (who translates, tone, specific messaging)

**The owner fills this in with plain-language answers. Claude converts them to SEO-optimized content during Phase 3.**
