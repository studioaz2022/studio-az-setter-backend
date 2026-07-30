# Phase 4 — Deploy & Verify

**Goal:** Launch the site on Vercel with full instrumentation (GA4, favicons, OG images, schema, performance fixes), verify SEO elements, and submit to search engines.

**Inputs:** Complete site from Phase 3
**Outputs:** Live, indexed, performance-validated site at the production domain

**Approval required:** Yes — pre-launch checklist review before DNS cutover.

---

## Order of Operations

1. **Vercel deployment** (preview first, then production)
2. **Asset wiring** (favicon, OG image, manifest, GA4)
3. **Performance optimization** (LCP fix for hero, preconnects)
4. **DNS cutover** (Cloudflare)
5. **Post-cutover verification** (PageSpeed, schema, search results)
6. **Search Console submission**

Phase 5 (post-launch ops + automation) begins after this phase is approved.

---

## Deliverables

### 1. `vercel-deploy.md`
Initial deployment + project setup:
- [ ] `vercel` CLI logged in (check with `vercel whoami`)
- [ ] First deploy via `vercel --yes` (creates the project)
- [ ] Build succeeds with no errors
- [ ] Verify the preview URL renders properly
- [ ] Promote to production: `vercel --prod --yes`
- [ ] Note the production URL (e.g. `<project>.vercel.app`)

### 2. `assets-checklist.md`

**Favicon (all sizes — generate from a single ≥512px square source):**
- [ ] Source image at least 512x512, ideally larger and square
- [ ] Generate via `sips`:
  ```bash
  sips -z 16 16 source.png --out public/favicon-16x16.png
  sips -z 32 32 source.png --out public/favicon-32x32.png
  sips -z 48 48 source.png --out public/favicon.ico
  sips -z 180 180 source.png --out public/apple-touch-icon.png
  sips -z 192 192 source.png --out public/icon-192x192.png
  sips -z 512 512 source.png --out public/icon-512x512.png
  ```
- [ ] Wire into `src/app/layout.tsx` `metadata.icons` block

**Web manifest (`public/site.webmanifest`):**
- [ ] Reference both 192px and 512px icons
- [ ] Set `theme_color` to brand primary
- [ ] Set `background_color` to dark base (or white if light theme)

**Open Graph link preview (`public/og-image.jpg`):**
- [ ] Composed at exactly **1200x630** in design tool (NOT cropped from a square — center subjects in the wide frame)
- [ ] iMessage crops the top/bottom — keep important content in the middle 60% vertically
- [ ] Reference in `src/app/(site)/layout.tsx` `metadata.openGraph.images`
- [ ] Test in Facebook Sharing Debugger after deploy
- [ ] Test by sending the URL in iMessage to yourself

### 3. `google-analytics.md`
- [ ] Create GA4 property at [analytics.google.com](https://analytics.google.com)
- [ ] Get Measurement ID (`G-XXXXXXXXXX`)
- [ ] Add to root `layout.tsx` (not site layout) via `next/script`:
  ```tsx
  <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`} strategy="afterInteractive" />
  <Script id="ga4-init" strategy="afterInteractive">
    {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA_ID}');`}
  </Script>
  ```
- [ ] Verify in GA4 Realtime within 60 seconds of deploy
- [ ] Note the GA4 **Property ID** (numeric — different from Measurement ID — found in GA4 Admin → Property settings) — needed in Phase 5 for the Data API

### 3b. `vercel-analytics.md`
Free real-visitor + Core Web Vitals data, served from the same Vercel deploy:
- [ ] `npm install @vercel/analytics @vercel/speed-insights`
- [ ] In root `src/app/layout.tsx`, add the imports:
  ```tsx
  import { Analytics } from "@vercel/analytics/next";
  import { SpeedInsights } from "@vercel/speed-insights/next";
  ```
- [ ] Render them inside `<body>` right before `</body>`:
  ```tsx
  {children}
  <Analytics />
  <SpeedInsights />
  ```
- [ ] Deploy — data starts flowing immediately
- [ ] View at: `vercel.com/<team>/<project>/analytics` and `/speed-insights`
- [ ] Speed Insights = real-world Core Web Vitals from actual visitors (more honest than PageSpeed lab data)

### 4. `pre-cutover-checklist.md`
Run through every check on the Vercel preview URL **before** changing DNS:

- [ ] All routes render (test mobile + desktop)
- [ ] Every page has unique title tag, meta description, H1 (compare to `phase-2/page-blueprint.md`)
- [ ] JSON-LD schema validates on every page ([Google Rich Results Test](https://search.google.com/test/rich-results))
- [ ] `/sitemap.xml` accessible and includes all pages
- [ ] `/robots.txt` correct (AI crawlers explicitly allowed if desired)
- [ ] Canonical URLs set on all pages and point to PRODUCTION domain (not the .vercel.app)
- [ ] Open Graph + Twitter Card meta on all pages
- [ ] 404 page exists with helpful internal links
- [ ] Favicon shows in browser tab
- [ ] Web manifest accessible at `/site.webmanifest`
- [ ] GA4 firing (check Realtime)
- [ ] All images have alt text, are WebP/AVIF, and use `next/image` (with priority on hero)
- [ ] Internal links all resolve (no 404s)
- [ ] Conversion form works end-to-end (test a real submission)
- [ ] Mobile navigation works
- [ ] `/llms.txt` accessible (for AI crawlers)
- [ ] NAP exactly matches GBP listing

### 5. `dns-cutover.md`
DNS migration via Cloudflare (assumes Cloudflare is already managing the domain):

- [ ] In Vercel: Settings → Domains → Add the production domain (root + www)
- [ ] Vercel will provide CNAME values (usually `cname.vercel-dns.com` OR a project-specific `<id>.vercel-dns-XXX.com`)
- [ ] In Cloudflare DNS:
  - Root (`@`): change A record to CNAME → Vercel value (Cloudflare flattens automatically)
  - `www`: CNAME → Vercel value
  - **Set proxy to OFF (grey cloud)** — Vercel handles SSL itself
- [ ] DNS propagation: 1-5 min via Cloudflare
- [ ] Verify both root and www serve via SSL
- [ ] Decide: root primary (recommended) or www primary
  - For root primary: in Vercel domains, set root as primary so www 308-redirects to root
  - This matches canonical URLs in your code

### 6. `performance-optimization.md`
Hit the Core Web Vitals thresholds. Test at [pagespeed.web.dev](https://pagespeed.web.dev) **after** DNS cutover (live domain only):

**Targets:** LCP < 2.5s, CLS < 0.1, INP < 200ms, PageSpeed mobile score > 85

**LCP fixes (most common bottleneck for hero-image sites):**
- [ ] Hero image: use raw `<img>` tag (NOT `next/image`) for the LCP element so it bypasses the `/_next/image` proxy delay
- [ ] Add `fetchPriority="high"` and `loading="eager"` to hero image
- [ ] Add `decoding="sync"` to force synchronous decode
- [ ] Add `<link rel="preload" as="image" type="image/webp" href="<hero-poster-url>" />` in root layout `<head>`
- [ ] Source the hero image from a CDN (R2, Cloudfront, etc.) — preconnect to it in root layout
- [ ] Remove unused preconnects (PageSpeed flags these)
- [ ] Hero image dimensions: serve at the actual displayed size (e.g. 1280×720 for desktop hero, smaller for mobile) — don't ship a 1080×1080 image to display in 1280×720
- **Measured result on tattoo site (April 2026):** these fixes moved Performance 76 → 91 and LCP 5.0s → 3.2s. Expect similar magnitude on any site that started with Next.js `Image` for the hero element.

**CSS render-blocking:**
- [ ] Tailwind v4 chunks should be inlined where possible (Next.js handles this automatically)
- [ ] Remove unused fonts; preload only the fonts used above-the-fold
- [ ] Use `display: "swap"` on next/font

**JS bundle:**
- [ ] Audit unused JS via PageSpeed report
- [ ] Use `dynamic()` imports for components below the fold
- [ ] GA4 should use `strategy="afterInteractive"` (already covered above)

### 7. `search-console-submit.md`
- [ ] Add domain property in [Search Console](https://search.google.com/search-console) — choose "Domain" type, verify via DNS TXT in Cloudflare
- [ ] Submit sitemap: `https://yourdomain.com/sitemap.xml`
- [ ] In the web UI, run URL Inspection → Request Indexing on the homepage + top priority pages (UI-only; there is NO API for this on general web pages — the Indexing API is restricted to JobPosting/BroadcastEvent, so do not attempt to script it)
- [ ] **Run the index sweep** to get a baseline of what Google has actually indexed: `node src/seo/runIndexCheck.js <sitekey>` — records indexed vs. not-indexed per URL, with the coverageState reason for each miss. Save output to `phase-4-deploy-verify/index-baseline-{date}.md`
- [ ] Verify property is collecting impression data within 48 hours

### 8. `gbp-website-update.md`
- [ ] Log into [business.google.com](https://business.google.com)
- [ ] Edit Profile → Website → change URL to new production domain
- [ ] Save (takes effect immediately for new searches, may take 24h to fully propagate)

---

## Verification (run before requesting approval — i.e. before declaring "site is live")

All boxes must be true on the LIVE production domain (not the preview URL) before Phase 4 is complete.

**Domain + DNS:**
- [ ] Production domain serves the site over HTTPS without browser warnings
- [ ] Both root and www resolve, with the correct primary (redirect chain matches canonical strategy)
- [ ] Cloudflare proxy is OFF (grey cloud) for the records pointing at Vercel
- [ ] SSL certificate issued by Vercel (check via browser cert inspector)
- [ ] DNS TTL is reasonable (300-3600s — not 86400 in case we need to roll back)

**Assets:**
- [ ] Favicon visible in browser tab on Chrome + Safari + Firefox + mobile Safari
- [ ] `/site.webmanifest` returns 200 with valid JSON
- [ ] OG image (`/og-image.jpg`) returns 200, is exactly 1200x630, and renders in [Facebook Sharing Debugger](https://developers.facebook.com/tools/debug/) without errors
- [ ] Tested by sending the URL via iMessage to a personal device — preview shows correctly
- [ ] GA4 firing — confirmed via Realtime within 60s of the verification visit
- [ ] Vercel Analytics + Speed Insights packages installed and rendering (check `vercel.com/<team>/<project>/analytics`)

**SEO state (run for at least homepage + 3 inner pages):**
- [ ] `curl -s <url> | grep "<title>"` returns the blueprint title tag
- [ ] `curl -s <url> | grep "application/ld+json"` returns schema (NOT empty)
- [ ] Canonical URL in the rendered HTML points to the production domain
- [ ] `/sitemap.xml` returns 200 and lists every page
- [ ] `/robots.txt` returns 200 and allows the AI bots per Phase 2 spec
- [ ] [Google Rich Results Test](https://search.google.com/test/rich-results) passes on the homepage + one service page

**Performance (lab data via [pagespeed.web.dev](https://pagespeed.web.dev) on the live URL):**
- [ ] Mobile Performance ≥ 85
- [ ] LCP < 2.5s on mobile (target < 1.5s)
- [ ] CLS < 0.1
- [ ] INP < 200ms (use field data if available, lab estimate otherwise)
- [ ] No render-blocking resources flagged that are easily fixable

**Search engine submission:**
- [ ] Search Console domain property verified (DNS TXT)
- [ ] `sitemap.xml` submitted in Search Console
- [ ] URL Inspection → Request Indexing run on homepage + top 5 priority pages (web UI only)
- [ ] `node src/seo/runIndexCheck.js <sitekey>` run and index-baseline saved — no unexpected "unknown to Google" pages (an orphaned/unlinked page will show this; fix by adding an internal link, not by re-submitting the sitemap)
- [ ] GBP profile updated with the new domain URL

**Functional smoke test:**
- [ ] Submitted a real form on the live site (use a test contact you can delete from GHL afterward) — confirmed it landed in the CRM
- [ ] Every nav link works
- [ ] Every CTA leads where it should
- [ ] Mobile viewport works at 375px width (no horizontal scroll, no overlapping text)

## End-of-Phase Summary

Write `phase-4-summary.md` in this folder before declaring the launch complete.

Required sections:
1. **Live URL + DNS state** — final domain, primary vs www, Cloudflare proxy state
2. **Launch date + time** — for the project timeline
3. **PageSpeed scores at launch** — mobile + desktop Performance, LCP, CLS, INP
4. **GA4 Measurement ID + Property ID** — both needed for Phase 5
5. **Search Console verification method + verification date**
6. **What broke during deploy** — anything that surprised us (log for the next site)
7. **Any deviations from the pre-cutover checklist** — what we shipped despite a failed check, with justification
8. **Open issues for Phase 5** — perf wins still possible, schema gaps, missing OG variants
9. **Punted items** — anything verification skipped, with justification
10. **Recommended Phase 5 starting point** — usually "GBP API setup since rankings + reviews drive next 30 days"

---

## Things that broke during the tattoo site launch (don't repeat)

- **iMessage crops OG images aggressively** — if your OG source was nearly square, iMessage will cut off the top/bottom. Compose the OG image at exactly 1200x630 from the start, with subjects centered vertically.
- **Next.js `<Image>` for hero adds 700ms+ render delay** — the `/_next/image` proxy is great for portfolio images but kills LCP for the hero. Use raw `<img>` for the hero element specifically.
- **Cloudflare proxy ON breaks Vercel SSL** — must be DNS-only (grey cloud) for Vercel to issue its own cert. If you see SSL errors after DNS cutover, this is the cause 95% of the time.
- **Vercel sets www as primary by default** — if your canonical URLs use the root domain, manually swap so root is primary or your canonicals will all redirect.
- **PageSpeed API has a daily quota** — if you hit it, run the audit manually at pagespeed.web.dev instead of via API.
