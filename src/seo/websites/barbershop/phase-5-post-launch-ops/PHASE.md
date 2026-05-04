# Phase 5 — Post-Launch Operations & Automation

**Goal:** Connect the live site to all ranking-influence systems (GBP API, SerpAPI, Search Console, Cloudflare, GA4) and establish ongoing automation so the site keeps gaining authority without manual intervention.

**Inputs:** Live site from Phase 4
**Outputs:** Fully instrumented site with API access to every ranking lever, automated weekly content + tracking, baseline metrics for ongoing optimization

**Approval required:** No — these are connect/configure tasks. Do them in sequence.

---

## Why this phase exists

A live website is only step one. Real ranking growth comes from:
1. **Fresh content signals** (GBP posts, blog updates, photo uploads)
2. **Engagement signals** (review responses, GBP Q&A, social posts)
3. **Authority signals** (citations, backlinks, brand mentions)
4. **Tracking infrastructure** (knowing what's moving so you can double down)

This phase wires up programmatic access to all of these so the work scales — same effort whether you have 1 site or 10.

---

## Deliverables

### 1. `gbp-api-setup.md`
Wire up Google Business Profile API for full read/write access:
- [ ] Enable **Business Information API v1** on Google Cloud project
- [ ] Enable **My Business API v4** (legacy — needed for posts, reviews, photos)
- [ ] Apply for "Basic API access" via [GBP support form](https://support.google.com/business/contact/api_default) — get project number allowlisted
- [ ] Generate OAuth refresh token with scopes: `https://www.googleapis.com/auth/business.manage`
- [ ] Add to backend `.env`: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_SEO_REFRESH_TOKEN`
- [ ] Test read access: `GET /v1/locations/{locationId}?readMask=categories,websiteUri`
- [ ] Test write access: `PATCH /v1/locations/{locationId}?updateMask=serviceItems`
- [ ] Test v4 read: `GET /v4/accounts/{accountId}/locations/{locationId}/reviews`
- [ ] Test v4 write: `POST /v4/accounts/{accountId}/locations/{locationId}/localPosts`
- [ ] Document location ID, account ID, place ID in `SEO_OVERRIDES.md`

**Auto-write a memory file** (`gbp_api_access.md`) so future Claude conversations know API state without re-discovering.

### 2. `serpapi-setup.md`
Automated keyword + competitor tracking:
- [ ] Sign up for SerpAPI account ($25/mo, 1000 searches/month is plenty for one site)
- [ ] Add `SERPAPI_KEY` to backend `.env` AND Render env vars (production uses Render)
- [ ] Verify backend `serpApiClient.js` has the right GPS coordinates set for the business location
- [ ] Test with: `GET /api/seo/maps/local-pack?q=<primary keyword>`
- [ ] Run all Tier 1-3 keywords from `phase-1-research/keyword-map.md` to establish post-launch baseline
- [ ] Save baseline to `phase-5-post-launch-ops/serp-baseline-{date}.md`

### 3. `search-console-setup.md`
Verify domain in Search Console + connect to API:
- [ ] Add domain property in [Search Console](https://search.google.com/search-console) (DNS TXT verification via Cloudflare)
- [ ] Submit `sitemap.xml` URL
- [ ] Request indexing for top 10 priority pages (homepage + service pages + artist/staff pages)
- [ ] Add property to backend `searchConsoleClient.js` `SITES` map
- [ ] Test API access: `GET /api/seo/search-console/keywords/{site}`
- [ ] Set up weekly cron to pull keyword performance into `phase-5-post-launch-ops/search-console-weekly/`

### 4. `cloudflare-setup.md`
DNS, redirect, and zone management via API:
- [ ] Generate Cloudflare Global API Key OR scoped Zone:Edit token
- [ ] Add to backend `.env`: `CLOUDFLARE_EMAIL`, `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_<DOMAIN>`
- [ ] Document the zone ID per domain in this file
- [ ] If migrating from old site, set up redirect rules via API (don't use Page Rules — use the new Rules engine)
- [ ] Verify DNS records: A/CNAME → Vercel, www → root domain redirect, MX/TXT records intact
- [ ] Add memory file `cloudflare_credentials.md` with the API curl examples and existing redirect rules

### 5. `ga4-setup.md`
Google Analytics 4 + conversion tracking:
- [ ] Create GA4 property at [analytics.google.com](https://analytics.google.com)
- [ ] Get Measurement ID (`G-XXXXXXXXXX`)
- [ ] Wire into root `layout.tsx` via `next/script` with `strategy="afterInteractive"`
- [ ] Define key events: form submission, "book consultation" click, phone tap
- [ ] Connect GA4 to Search Console for unified reporting
- [ ] Verify data flowing within 48 hours

### 6. `automation-cron-jobs.md`
Set-and-forget weekly tasks:
- [ ] **Weekly GBP post** — backend cron Mon 9am, posts rotating content via v4 API
- [ ] **Weekly keyword pull** — Sunday night, pulls Search Console + SerpAPI data, writes to `phase-5-post-launch-ops/weekly-reports/`
- [ ] **New review alert** — daily check for new reviews via v4 API, sends notification (Slack/email/iOS push)
- [ ] **Auto-reply to new reviews** — optional: draft Spanish/English reply via Claude API, post via v4
- [ ] **Monthly content refresh reminder** — first of month, identifies the oldest page and prompts for update
- [ ] **Monthly Local Falcon re-scan** — manual scan upload comparing month-over-month Map Pack changes

### 7. `review-generation-system.md`
The #1 ranking lever for local SEO:
- [ ] Identify the workflow that triggers a review request (post-appointment, post-purchase, post-service)
- [ ] Write Spanish + English review request templates
- [ ] Wire the trigger to send via SMS/email 24-48hrs after the trigger event
- [ ] Include the direct GBP review link from `metadata.newReviewUri` (visible in v1 location response)
- [ ] Set goal: minimum 10 new reviews per month
- [ ] Track review velocity in `phase-5-post-launch-ops/review-tracker.md`

### 8. `bing-apple-citations.md`
Other map services + key citations:
- [ ] Claim Bing Places (export from GBP for fast setup)
- [ ] Set up Apple Business Connect listing
- [ ] Submit to Yelp (auto-claim if listing exists)
- [ ] Verify NAP consistency on top 10 industry-relevant directories
- [ ] Document citation list in `phase-5-post-launch-ops/citation-tracker.md`

---

## Memory Files to Create / Update

After Phase 5 setup, write these to `~/.claude/projects/-Users-studioaz-Documents-Studio-AZ-Tattoo-App/memory/`:

1. **`gbp_api_access.md`** — API state, location IDs, working endpoints, payload examples
2. **`serpapi_setup.md`** — key location, baseline keywords, GPS coordinates
3. **`search_console_access.md`** — verified domain, sitemap URL, OAuth refresh token location
4. **`cloudflare_credentials.md`** — env vars, zone ID, existing redirect rules
5. Update **`MEMORY.md`** index with one-line pointers to each new memory file

This makes Phase 5 self-documenting — future Claude conversations can immediately understand the full operational state of any site.

---

## Why "automation" matters

Without Phase 5, you ship the site and rely on manual GBP posting + manual review begging + manual ranking checks. That's how 90% of local businesses fail at SEO — they don't keep up the operational tempo.

With Phase 5 wired up:
- **GBP gets a fresh post every week** (Google rewards activity)
- **You see ranking changes within hours** (so you can react fast)
- **Every review gets a thoughtful reply** (engagement signal)
- **Citations stay accurate** (NAP consistency = ranking)
- **You spend 30 min/week reviewing data**, not 30 hours/week creating it

This is the difference between a site that ranks once and a site that compounds authority every month.
