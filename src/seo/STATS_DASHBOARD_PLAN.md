# Studio AZ Stats Dashboard — Plan

> **Purpose:** A separate web app that surfaces SEO + conversion analytics for every Studio AZ website (tattoo, barbershop, future) in one beautiful UI. Replaces the need to log into GA4 / Search Console / GBP separately. **Anchored around the Insight Loop**, not just charts.

**Status:** Not yet started. Captured here so the build knows what to aim for.
**Workspace:** Lives in its own Next.js project (TBD location, likely `stats-dashboard/` inside the Studio AZ Tattoo App workspace).

---

## What Makes This Different

**Most SEO dashboards are just charts.** That's not what we want. The 5 data sources we've connected (GA4, GBP Performance, Search Console, Vercel Analytics, Cloudflare) all have web dashboards already — Lionel doesn't need a sixth chart viewer.

**What he DOES need:** the analyze→hypothesize→investigate→fix→verify loop captured as a UI flow. The dashboard's job is to surface what's worth paying attention to, propose explanations, and close the loop after a fix ships. See [insight_loop_pattern.md](../../../.claude/projects/-Users-studioaz-Documents-Studio-AZ-Tattoo-App/memory/insight_loop_pattern.md) for the loop in detail.

---

## Pages / Sections

### 1. **Today** — landing page
A single-page snapshot per site showing:
- Headline numbers: organic sessions (last 7 / 30 days), conversions, conversion rate
- Funnel viz (live data from `runFunnelReport`)
- Top 3 wins this week (e.g. "Joan's page +40% sessions" — green)
- Top 3 concerns this week (e.g. "/consultation form-start dropped to 5%" — yellow)
- Site selector at top (Tattoo / Barbershop / future sites)

### 2. **Insights** — the heart of the product
The Insight Loop made visual. Each "Insight Card" is a discovered anomaly with:
- **The anomaly** — one-line summary with the gap quantified
- **Hypotheses** — 3-5 ranked possible causes
- **Investigation panel** — Claude has already pulled the supporting data; user can drill in
- **Recommended action** — one specific fix with a "Send to Claude" button (opens a fresh conversation pre-loaded with the context to ship the fix)
- **Status** — "open" / "in progress" / "shipped X days ago" / "verified +42% lift" / "no measurable change"

A new card auto-generates roughly weekly based on the previous week's data deltas. Old cards stay viewable in a history list — they become the site's improvement story over time.

### 3. **Funnels** — every form/flow on every site
- Pick a site → pick a form (consultation widget, artist inquiry, contact, future)
- Live `runFunnelReport` query renders as a horizontal funnel viz
- Click any step to see drop-off detail (which exit page, which device, which entry source)
- Compare time periods (this 7d vs prior 7d, this month vs last month)

### 4. **Map Pack** — Local Falcon results + GBP performance
- Geo-grid heatmap from Local Falcon (most recent scan + history slider)
- GBP Performance daily metrics: impressions, direction requests, calls, website clicks
- GBP search keywords (the queries people type to find you)
- Reviews ticker — new reviews + response status
- One-click "Post to GBP" via the v4 API

### 5. **Search Console** — organic visibility
- Top queries, top pages, position trends
- New keywords appearing in last 7d (for content opportunities)
- Index health via URL Inspection API
- Country/device/page filters

### 6. **Site Health** — performance + technical
- Vercel Speed Insights real-world Core Web Vitals per route
- Cloudflare threats blocked + DNS health
- Broken link / schema / metadata audits
- 404 trends

### 7. **Reviews** — read + reply via API
- All reviews across the GBP locations (read v4 API)
- One-click reply with Claude-drafted Spanish/English response
- Track response rate + reply latency

### 8. **CTA Performance** — which placements convert
- All `cta_click` events grouped by `cta_location`
- Conversion rate per location (clicks → form_started → submitted)
- "Top performer" / "Worst performer" calls-to-action across the site
- Helps decide which placements to keep, retire, or duplicate

---

## Data Sources Surfaced

| Source | What we pull | API |
|--------|--------------|-----|
| **GA4 Data API** | Sessions, users, pages, sources, events, conversions, value-weighted | `/runReport`, `/runFunnelReport` (v1alpha) |
| **GA4 Admin API** | Property metadata, custom dimensions, conversion events | `/customDimensions`, `/conversionEvents` |
| **Search Console** | Keywords, pages, devices, countries, URL Inspection | `/searchAnalytics/query`, `/urlInspection/index:inspect` |
| **GBP Business Info v1** | Categories, services, hours, NAP | `/locations/{id}` |
| **GBP Performance v1** | Daily impressions, direction requests, calls, website clicks | `/locations/{id}:fetchMultiDailyMetricsTimeSeries` |
| **GBP v4** | Posts (read + create), reviews (read + reply), photos | `/v4/accounts/{a}/locations/{l}/...` |
| **Vercel Analytics + Speed Insights** | Real visitor counts, real-world LCP/CLS/INP | Vercel API |
| **Cloudflare GraphQL** | Edge requests, threats, bot traffic | `/client/v4/graphql` |
| **Local Falcon** | Geo-grid Map Pack rank scans | Manual scan upload (no API yet) |
| **Anthropic API** | Generate insights + reply drafts | Claude API |

---

## Architecture Sketch

**Frontend:** Next.js (App Router), TypeScript, Tailwind, ShadCN. Dark theme matching the tattoo site's visual language. Hosted on Vercel.

**Backend:** Reuse the existing `studio-az-setter-backend` (Render). Add new SEO routes:
- `GET /api/seo/dashboard/today/:site` — aggregate today/this-week numbers from all sources
- `GET /api/seo/dashboard/funnel/:site/:formName?days=30` — wraps `runFunnelReport`
- `GET /api/seo/dashboard/cta-performance/:site?days=30` — groups `cta_click` events by location
- `GET /api/seo/dashboard/insights/:site` — returns auto-generated insight cards (cached, weekly)
- `POST /api/seo/dashboard/insights/:site/generate` — manually trigger insight generation
- `POST /api/seo/dashboard/posts/:site` — create a GBP post via v4 API
- `POST /api/seo/dashboard/reviews/:reviewId/reply` — reply to a review with Claude-drafted text

**Insight generation pipeline (cron):**
1. Weekly cron pulls last 7d data from all sources
2. Compares against prior 7d (week-over-week deltas)
3. Flags anomalies (z-score > 2 standard deviations OR % change above threshold)
4. Sends anomaly + supporting data to Claude API
5. Claude returns: hypotheses ranked, investigations completed, recommended fix
6. Stored as an Insight Card in DB
7. Lionel reviews on Monday morning, ships fixes, dashboard tracks them

**Auth:** Magic link or Google OAuth — single user (Lionel) for now. Don't over-engineer multi-tenant until there's a second user.

**DB:** Probably Supabase (already in stack) for storing insight cards, fix history, scan metadata. Or InstantDB if real-time updates feel valuable.

---

## Minimum Viable Dashboard (MVP — first build)

Don't try to build everything. First build:
1. **Today** page (single site selector, headline numbers, funnel viz)
2. **Funnels** page (consultation widget funnel + artist inquiry funnel for tattoo site)
3. **Insights** page with manually-generated cards (cron generation comes later)

That's enough to be useful day one. Everything else gets built once the foundation works.

---

## When to Start

Start when:
- Tattoo site has 30+ days of GA4 data flowing (we're at ~22 days as of May 6, 2026 — close)
- Tattoo site has had at least 2-3 Insight Loop iterations done manually (so we know what cards should look like)
- Barbershop site is at least mid-Phase 3 (so we have 2 sites' worth of data shapes to design around)

Estimated build: **3-4 weeks** for MVP, plus ongoing.

---

## Backend Endpoints To Build First (Phase 5 deliverable #13)

When the dashboard build starts, these endpoints are the priority:

1. `GET /api/seo/dashboard/today/:site` — aggregate top numbers
2. `GET /api/seo/dashboard/funnel/:site/:formName?days=30` — wraps `runFunnelReport` with the schema fix (`eventParameterName` not `parameterName`)
3. `GET /api/seo/dashboard/cta-performance/:site?days=30` — groups CTA clicks
4. `GET /api/seo/dashboard/insights/:site` — return cached insight cards from DB

These are the foundation. Once they exist, the dashboard frontend can be built in parallel.

---

## Why This Plan Matters

Right now, every site we build accumulates analytics data — but that data is locked behind 5 separate dashboards that Lionel has to log into. The website pipeline ends at "events are flowing" and never closes the loop on "we found something, fixed it, verified the lift."

The dashboard is what makes Phase 5 truly compound. Without it, Phase 5 is half-finished forever — we'd always be relying on Claude conversations to do the analysis. With the dashboard, the analysis runs automatically, the anomalies surface to Lionel, fixes ship faster, and the improvement story becomes visible over months/years.

This is the difference between owning websites and operating a portfolio of compounding assets.