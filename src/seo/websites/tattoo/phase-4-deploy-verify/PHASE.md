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
- [ ] robots.txt configured correctly
- [ ] Canonical URLs set on all pages
- [ ] Open Graph + Twitter Card meta on all pages
- [ ] 404 page exists
- [ ] Favicon + web manifest
- [ ] Google Analytics / Tag Manager installed
- [ ] Core Web Vitals pass (LCP < 2.5s, CLS < 0.1, INP < 200ms)
- [ ] All images have alt text, are WebP, are lazy-loaded
- [ ] Internal links all resolve (no broken links)
- [ ] Consultation widget works on artist pages
- [ ] Mobile navigation works
- [ ] Page speed scores > 90 on both mobile and desktop
- [ ] llms.txt file for AI crawler optimization

### 2. Post-Launch Steps
- Submit sitemap to Google Search Console
- Request indexing for all pages
- Set up Vercel domain (temporary .vercel.app first)
- DNS cutover when ready (tattooshopminneapolis.com → Vercel)
- GHL redirect setup (if any old URLs need redirecting)
- Run our SEO audit tools against the live site (new baseline)
- Track keyword rankings weekly via SerpAPI
