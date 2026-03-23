# Phase 4 — Deploy & Verify

**Goal:** Launch the site on Vercel, verify all SEO elements are working, submit to search engines, and establish ongoing ranking tracking.

**Inputs:** Complete site from Phase 3
**Outputs:** Live site + baseline ranking data for ongoing monitoring

**Approval required:** Yes — pre-launch checklist review before DNS cutover.

**Status:** Waiting for Phase 3 completion.

---

## Planned Deliverables

### 1. `launch-checklist.md`
Pre-launch verification:
- [ ] All pages render correctly (mobile + desktop)
- [ ] Every page has unique title tag, meta description, H1
- [ ] JSON-LD schema validates on every page (Google Rich Results Test)
- [ ] sitemap.xml generated and accessible
- [ ] robots.txt configured correctly (AI crawlers allowed)
- [ ] Canonical URLs set on all pages
- [ ] Open Graph + Twitter Card meta on all pages
- [ ] 404 page exists with internal links
- [ ] Favicon + web manifest
- [ ] Google Analytics / Tag Manager installed
- [ ] Core Web Vitals pass (LCP < 1.5s, CLS < 0.05, INP < 100ms)
- [ ] All images have alt text, are WebP, are lazy-loaded appropriately
- [ ] Internal links all resolve (no broken links)
- [ ] Conversion widget/form works
- [ ] Mobile navigation works
- [ ] Page speed scores > 90 on both mobile and desktop
- [ ] llms.txt file accessible
- [ ] NAP consistent with GBP and all citations

### 2. Post-Launch Steps
- Submit sitemap to Google Search Console
- Request indexing for all pages
- Set up Vercel domain (temporary .vercel.app first)
- DNS cutover when ready (domain → Vercel)
- Old site redirect setup (if any URLs need redirecting)
- Run SEO audit tools against the live site (new baseline)
- Track keyword rankings weekly via SerpAPI
- Claim/update Bing Places and Apple Business Connect
- Run first Local Falcon scan post-launch (compare to Phase 1 baseline)
