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

### 9. `analytics-data-sources.md`
Wire up ALL the data sources that exist for the site so we can track growth comprehensively. There are 5 to set up — each tells us something different:

#### 9a. GA4 Data API
Reads visitor behavior data programmatically.
- [ ] Create GA4 property (covered in Phase 4) with Measurement ID `G-XXXXXXXXXX`
- [ ] Note the GA4 **property ID** (numeric, found in GA4 Admin → Property settings) — different from Measurement ID
- [ ] **Enable two Google Cloud APIs** on the project:
  - **Analytics Admin API** at https://console.developers.google.com/apis/api/analyticsadmin.googleapis.com/overview?project={PROJECT_NUMBER}
  - **Analytics Data API** at https://console.developers.google.com/apis/api/analyticsdata.googleapis.com/overview?project={PROJECT_NUMBER}
  - Both are required (Admin = list properties, Data = query metrics). OAuth scope alone is not enough — you'll get `SERVICE_DISABLED` errors otherwise.
- [ ] **OAuth refresh token already covers GA4** if a previous Studio AZ site has been through Phase 5 — the script `src/seo/generateRefreshToken.js` requests all 4 scopes (`webmasters.readonly`, `business.manage`, `analytics.readonly`, `analytics.edit`). One refresh token works for all properties owned by the same Google account.
- [ ] **Only re-issue the token if** (a) this is a brand-new Google account/project, (b) you need to add a new scope, or (c) the token was revoked. To re-issue: `node src/seo/generateRefreshToken.js`, copy output to `.env` AND Render env vars.
- [ ] Test API: `GET https://analyticsadmin.googleapis.com/v1beta/accountSummaries` — returns property IDs
- [ ] Build wrapper in `src/seo/ga4Client.js` for common queries (sessions, users, conversions, top pages, top sources)
- [ ] **CRITICAL curl gotcha:** GA4 Data API endpoints use `:runReport`, `:runFunnelReport`, `:batchRunReports` syntax. The `:` gets eaten by curl URL parsing. Use the `--url-query ""` workaround: `curl -X POST "https://...:runReport" --url-query "" -d '...'` — without the workaround you'll get a 404 with mangled URL like `/properties/123unReport`.

#### 9b. Cloudflare Analytics (GraphQL)
Edge-level visitor + threat data.
- [ ] Confirm Cloudflare credentials exist in `.env` (`CLOUDFLARE_EMAIL`, `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ZONE_<DOMAIN>`)
- [ ] Use GraphQL endpoint `https://api.cloudflare.com/client/v4/graphql` (the legacy `/zones/{id}/analytics/dashboard` REST endpoint was sunset)
- [ ] Note: if Cloudflare proxy is OFF (DNS-only for Vercel SSL), only DNS-level data flows here. That's fine — use it for threat blocking + DNS health, not page-view counts. Real visitor data lives in GA4/Vercel.

#### 9c. Vercel Analytics + Speed Insights
Server-side visitor count + real-world Core Web Vitals.
- [ ] `npm install @vercel/analytics @vercel/speed-insights`
- [ ] Add `<Analytics />` and `<SpeedInsights />` components from each package to the root `layout.tsx` (right before closing `</body>`)
- [ ] Deploy — data starts flowing immediately
- [ ] Free tier handles small-business traffic comfortably
- [ ] View at: `vercel.com/<team>/<project>/analytics` and `/speed-insights`

#### 9d. Search Console URL Inspection API
Per-URL indexing health checks.
- [ ] Already covered by existing `webmasters.readonly` scope — no new auth needed
- [ ] Endpoint: `POST https://searchconsole.googleapis.com/v1/urlInspection/index:inspect` with `{inspectionUrl, siteUrl}`
- [ ] Useful for: confirming a page is indexed, last crawl date, mobile usability, AMP/HTTPS status
- [ ] Add a `urlInspect()` helper to `searchConsoleClient.js`

#### 9e. GBP Performance Daily Metrics
Per-day GBP impression + action counts (we already wired the location/keywords endpoints — this is the daily timeseries).
- [ ] Endpoint: `GET https://businessprofileperformance.googleapis.com/v1/locations/{locationId}:fetchMultiDailyMetricsTimeSeries`
- [ ] Required params: `dailyMetrics=BUSINESS_IMPRESSIONS_DESKTOP_MAPS,BUSINESS_IMPRESSIONS_MOBILE_MAPS,BUSINESS_IMPRESSIONS_DESKTOP_SEARCH,BUSINESS_IMPRESSIONS_MOBILE_SEARCH,BUSINESS_DIRECTION_REQUESTS,CALL_CLICKS,WEBSITE_CLICKS,BUSINESS_BOOKINGS` (all flat, repeated)
- [ ] Required params: `dailyRange.startDate.{year,month,day}` and `dailyRange.endDate.{year,month,day}` (NOT a single ISO date)
- [ ] Add wrapper in `src/seo/gbpClient.js` to fix the existing 400 error on the performance endpoint

### 10. `data-baseline-{date}.md`
Generate a single document combining all data sources at the moment of post-launch instrumentation:
- [ ] Pull current Search Console data (28-day default)
- [ ] Pull GBP Performance daily metrics (last 30 days)
- [ ] Pull Cloudflare GraphQL analytics (last 7 days)
- [ ] Note Vercel Analytics + GA4 status (data won't be useful immediately — flag "check back in 7 days")
- [ ] Cross-reference all sources for sanity check (different sources count differently — explain the discrepancies)
- [ ] Save as `data-baseline-{YYYY-MM-DD}.md` — this is the snapshot future months compare against

### 11. `monthly-data-snapshot.md`
Build a recurring backend job that pulls and saves all data sources monthly:
- [ ] Cron: 1st of each month at 6 AM
- [ ] Pulls all 5 data sources programmatically
- [ ] Writes to `phase-5-post-launch-ops/monthly-snapshots/{YYYY-MM}.md`
- [ ] Includes month-over-month delta tables for key metrics
- [ ] Optional: send a summary email/Slack notification with the headline numbers

---

## Memory Files to Create / Update

After Phase 5 setup, write these to `~/.claude/projects/-Users-studioaz-Documents-Studio-AZ-Tattoo-App/memory/`:

1. **`gbp_api_access.md`** — API state, location IDs, working endpoints, payload examples (already exists for tattoo, must include both v1 + v4 status, plus performance API daily-metrics quirk)
2. **`serpapi_setup.md`** — key location, baseline keywords, GPS coordinates
3. **`search_console_access.md`** — verified domain, sitemap URL, OAuth refresh token location, working endpoints (search analytics + URL inspection)
4. **`cloudflare_credentials.md`** — env vars, zone ID per domain, existing redirect rules, GraphQL Analytics example query
### 12. `ga4-conversion-events.md`
Configure GA4 to recognize the custom funnel events as conversions. **Use the GA4 Admin API — don't click through the dashboard.** Custom dimensions and conversion events are both API-creatable. Only Funnel Explorations remain a manual UI step (Google has never exposed Explore reports as a write API).

**Prerequisite:** OAuth refresh token must include `https://www.googleapis.com/auth/analytics.edit` scope (in addition to `analytics.readonly`). Re-issue via `node src/seo/generateRefreshToken.js`.

#### Step 1 — Custom Dimensions (via API)
Endpoint: `POST https://analyticsadmin.googleapis.com/v1beta/properties/{PROPERTY_ID}/customDimensions`

Payload per dimension:
```json
{
  "parameterName": "form_name",
  "displayName": "Form Name",
  "description": "Which form (consultation_widget, artist_inquiry, contact)",
  "scope": "EVENT"
}
```

Standard custom dimensions to register for any site with a form/funnel (17 total):

| Parameter | Display Name | Used in events |
|-----------|--------------|----------------|
| `form_name` | Form Name | All form events |
| `step_name` | Step Name | Step events |
| `step_index` | Step Index | Step events |
| `step_total` | Step Total | Step events |
| `language` | Language | All form events |
| `artist` (or service-equivalent) | Artist | All form events |
| `entry_source` | Entry Source | Started events |
| `tattoo_size` (or service-specific equivalent) | Tattoo Size | Submit events |
| `timeline` | Timeline | Submit events |
| `has_photos` | Has Photos | Submit events |
| `cta_text` | CTA Text | CTA click events |
| `cta_location` | CTA Location | CTA click events |
| `destination` | CTA Destination | CTA click events |
| `selected_value` | Selected Value | Step events |
| `from_step` | From Step | Back events |
| `to_step` | To Step | Back events |
| `last_step` | Last Step | Abandoned events |

(Adjust service-specific names per site — e.g. for a barbershop, `tattoo_size` becomes `service_type`, `artist` becomes `barber`, etc.)

GA4 free tier allows 50 event-scoped custom dimensions per property — plenty.

#### Step 2 — Conversion Events (via API)
Endpoint: `POST https://analyticsadmin.googleapis.com/v1beta/properties/{PROPERTY_ID}/conversionEvents`

Payload per event:
```json
{ "eventName": "consultation_submitted" }
```

Mark these as conversions:
- `{form_name}_submitted` — primary conversion (value-weighted via the `value` parameter)
- `{form_name}_lead_captured` — soft conversion (mid-funnel)

Don't mark `cta_click` as a conversion — too noisy, defeats the purpose of conversion tracking.

#### Step 3 — Verify event flow (only manual step left)
- [ ] Visit the live site → trigger the form → check GA4 Realtime within 30s to confirm events fire
- [ ] No need to build a Funnel Exploration in the GA4 UI — see deliverable #13 below

#### Note: Funnel reports run on demand via API
The GA4 Data API exposes `runFunnelReport` at `https://analyticsdata.googleapis.com/v1alpha/properties/{id}:runFunnelReport`. We never need to save a Funnel Exploration in the GA4 UI — we can POST a funnel definition + date range + filters and get back step-by-step `activeUsers`, `funnelStepCompletionRate`, `funnelStepAbandonments`, `funnelStepAbandonmentRate` for any time period.

That makes deliverable #13 (the funnel report backend endpoint) the right place to define funnels — they live as code, not as click-trail-saved Explorations.

### 13. `funnel-report-api.md`
Build a backend endpoint that returns the funnel data programmatically (for the future stats dashboard). **Funnel reports run on demand via the GA4 Data API — no saved Funnel Exploration in the GA4 UI is needed.**

**API endpoint:** `POST https://analyticsdata.googleapis.com/v1alpha/properties/{PROPERTY_ID}:runFunnelReport`

**Sample payload (the actual funnel for the consultation widget):**
```json
{
  "dateRanges":[{"startDate":"30daysAgo","endDate":"today"}],
  "funnel":{
    "steps":[
      {"name":"Started","filterExpression":{"funnelEventFilter":{"eventName":"consultation_started"}}},
      {"name":"Step 0 — Language","filterExpression":{"funnelEventFilter":{"eventName":"consultation_step_complete","funnelParameterFilterExpression":{"funnelParameterFilter":{"eventParameterName":"step_index","numericFilter":{"operation":"EQUAL","value":{"int64Value":"0"}}}}}}},
      {"name":"Step 1 — Timeline","filterExpression":{"funnelEventFilter":{"eventName":"consultation_step_complete","funnelParameterFilterExpression":{"funnelParameterFilter":{"eventParameterName":"step_index","numericFilter":{"operation":"EQUAL","value":{"int64Value":"1"}}}}}}},
      {"name":"Submitted","filterExpression":{"funnelEventFilter":{"eventName":"consultation_submitted"}}}
    ]
  }
}
```

**Schema gotcha:** Use `eventParameterName` (NOT `parameterName`) for parameter filters in `runFunnelReport`. The `runReport` endpoint uses `parameterName` for custom dimension filters; `runFunnelReport` uses `eventParameterName`. Same filter type, different field name. Easy to miss.

**Response includes per-step:** `activeUsers`, `funnelStepCompletionRate`, `funnelStepAbandonments`, `funnelStepAbandonmentRate`. Both as `funnelTable` and `funnelVisualization` blocks.

**Build:**
- [ ] Add `src/seo/ga4FunnelClient.js` with helper functions to compose funnel definitions from a simple step list (e.g. `buildFunnel(siteKey, formName, stepNames)` returns the full payload)
- [ ] Endpoint: `GET /api/seo/funnel/:site/:formName?days=30`
- [ ] Funnel definitions stored as code in `src/seo/funnelDefinitions.js` (one definition per form per site) — easy to version, share, and iterate
- [ ] Returns JSON: `{ steps: [{name, users, drop_off_pct, abandonment_count}, ...], total_conversions, conversion_rate, conversion_value }`
- [ ] This is the data source for the future stats dashboard's funnel visualization

**Why no UI funnel exploration needed:**
- The `:runFunnelReport` endpoint runs ad-hoc — no saved Exploration required
- Funnel definitions live in code (versionable, comparable, automatable)
- The future stats dashboard pulls live data on demand; doesn't query a stale saved report

---

5. **`ga4_data_api.md`** — GA4 property ID per site, OAuth scope (`analytics.readonly`), example queries
6. **`vercel_analytics.md`** — which sites have it enabled, where to view dashboards
7. **`data-sources-summary.md`** — cross-source reconciliation guide (which source measures what, why they disagree, which to prioritize for which question)
8. Update **`MEMORY.md`** index with one-line pointers to each new memory file

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
