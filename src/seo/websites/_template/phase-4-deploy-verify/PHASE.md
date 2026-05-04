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
- [ ] Use URL Inspection → Request Indexing on top 10 priority pages
- [ ] Verify property is collecting impression data within 48 hours

### 8. `gbp-website-update.md`
- [ ] Log into [business.google.com](https://business.google.com)
- [ ] Edit Profile → Website → change URL to new production domain
- [ ] Save (takes effect immediately for new searches, may take 24h to fully propagate)

---

## Things that broke during the tattoo site launch (don't repeat)

- **iMessage crops OG images aggressively** — if your OG source was nearly square, iMessage will cut off the top/bottom. Compose the OG image at exactly 1200x630 from the start, with subjects centered vertically.
- **Next.js `<Image>` for hero adds 700ms+ render delay** — the `/_next/image` proxy is great for portfolio images but kills LCP for the hero. Use raw `<img>` for the hero element specifically.
- **Cloudflare proxy ON breaks Vercel SSL** — must be DNS-only (grey cloud) for Vercel to issue its own cert. If you see SSL errors after DNS cutover, this is the cause 95% of the time.
- **Vercel sets www as primary by default** — if your canonical URLs use the root domain, manually swap so root is primary or your canonicals will all redirect.
- **PageSpeed API has a daily quota** — if you hit it, run the audit manually at pagespeed.web.dev instead of via API.
