# Full-Stack Data Baseline — May 4, 2026

**Site age at this snapshot:** 19 days post-launch (live April 15, 2026)
**Reviews:** 14 (5.0 rating)

This is the first comprehensive cross-platform data pull. All data sources are now wired up. Future snapshots will compare against this baseline.

---

## 1. Google Search Console (28 days)

**Total: 5,607 impressions, 30 clicks, 0.5% CTR, avg position 9.3**

### By device
| Device | Impressions | Clicks | CTR | Position |
|--------|-------------|--------|-----|----------|
| Mobile | 963 | 22 | 2.28% | 9.4 |
| Desktop | 4,497 | 8 | 0.18% | 9.3 |
| Tablet | 3 | 0 | 0% | 6.3 |

**Insight:** Desktop is dragging down the apparent CTR. The ratio is 4,497:963 for desktop:mobile — that's wildly skewed. Most local-business sites are mobile-dominant. The desktop impressions are heavily inflated by the "AAD aftercare" research traffic on the aftercare page.

### By page (top 10)
| Page | Impressions | Clicks | Position |
|------|-------------|--------|----------|
| /aftercare | 3,721 | 0 | 7.3 |
| / (homepage) | 1,582 | 28 | 13.5 |
| /faq | 74 | 1 | 14.1 |
| /contact | 63 | 0 | 15.4 |
| /parking | 62 | 0 | 10.6 |
| /gallery | 25 | 0 | 19.4 |
| /artists | 16 | 1 | 10.4 |
| /apply-now | 16 | 0 | 6.4 |
| /artists/andrew | 12 | 0 | 12 |
| /artists/joan | 12 | 0 | 7.5 |

**Insights:**
- Homepage is the workhorse — 28 of 30 total clicks come from `/`
- Aftercare CTR problem confirmed (3,721 impressions, 0 clicks)
- Most pages are getting indexed but tiny impression volumes

### Geographic
**99 countries showing impressions. USA dominates with 4,504 impressions / 33 clicks.** The other 98 countries are noise — international researchers, scrapers, AAD-related queries. Real signal is the US-only number.

### Index status (URL Inspection API)
- Homepage: **Submitted and indexed**, last crawled April 27, crawled as MOBILE
- All other pages: similar status

---

## 2. Google Business Profile Performance (34 days, Apr 1–May 4)

| Metric | Value | Notes |
|--------|-------|-------|
| Total impressions | **497** | All sources combined |
| Mobile Maps impressions | 198 | 40% of total |
| Mobile Search impressions | 147 | 30% of total |
| Desktop Search impressions | 107 | 21% of total |
| Desktop Maps impressions | 45 | 9% of total |
| **Website clicks** | 34 | Conversion to your site |
| **Direction requests** | 57 | Highest-intent action |
| **Phone call clicks** | 2 | Low — most leads probably text |
| GBP bookings | 0 | Not using GBP booking feature |

**Engagement rate: 93 actions / 497 impressions = 18.7%** — well above local business average of 4-6%.

**Insights:**
- 70% of GBP discovery is mobile — mobile-first design is correct
- Direction requests outnumber website clicks — people want to come visit, less interested in browsing the site first
- Phone calls are very low — lean into text/booking form as primary conversion paths

---

## 3. Cloudflare Analytics (7 days, Apr 27–May 4)

**415 total requests, 52 unique visitors**

| Date | Requests | Uniques | Threats |
|------|----------|---------|---------|
| 2026-04-27 | 22 | 6 | 0 |
| 2026-04-29 | 145 | 13 | 0 |
| 2026-04-30 | 17 | 9 | 0 |
| 2026-05-01 | 95 | 8 | 0 |
| 2026-05-02 | 100 | 3 | 10 |
| 2026-05-03 | 27 | 6 | 0 |
| 2026-05-04 | 9 | 7 | 0 |
| **TOTAL** | **415** | **52** | **10** |

**Note:** Cloudflare proxy is OFF (DNS-only) for Vercel SSL. So this only counts requests that hit Cloudflare's edge before being forwarded — mostly DNS lookups and a sliver of caching. The actual traffic numbers live in Vercel/GA4. Use Cloudflare for: threat blocking, DNS health, future plans if you enable proxying.

---

## 4. Vercel Analytics (just enabled — no historical data)

Just deployed — `@vercel/analytics` and `@vercel/speed-insights` are live as of May 4, 2026. Data will start flowing immediately. View at:
- https://vercel.com/studioaz2022s-projects/tattoo-website/analytics
- https://vercel.com/studioaz2022s-projects/tattoo-website/speed-insights

**What this tracks:**
- Real visitor counts (de-duplicated)
- Top routes by traffic
- Top referrers
- Top countries
- Real-world Core Web Vitals (LCP, CLS, INP, FCP, TTFB) from actual visitors — not lab data
- Per-page performance breakdown

This is the most accurate visitor measurement we have. Check back in 7 days for first meaningful sample.

---

## 5. GA4 (collecting, but Data API not connected)

GA4 is collecting traffic via `G-XYEDL03XZR` since April 15. Data is visible in the GA4 dashboard but not yet pullable via API.

**Reason:** The OAuth refresh token only has `webmasters.readonly` and `business.manage` scopes. GA4 needs `analytics.readonly`.

**To enable:** Re-run `node src/seo/generateRefreshToken.js` (script already updated to include the new scope) and replace `GOOGLE_SEO_REFRESH_TOKEN` in `.env`. After that:
- GA4 Admin API → list properties
- GA4 Data API → query metrics (sessions, users, events, conversions, traffic sources)

Once connected we'll have:
- Sessions, users, page views, bounce rate
- Real source/medium attribution (organic / direct / social / paid / referral)
- Events (form submissions, button clicks, scroll depth)
- Geographic breakdown of visitors
- Device + browser data
- Real-time visitor count

---

## Cross-Source Reconciliation

Different sources will disagree because they measure different things:

| Source | Measures | What it's good for |
|--------|----------|--------------------|
| **Search Console** | Google search appearances + clicks | Keyword performance, indexing |
| **GBP Performance** | Map Pack + Knowledge Panel views | Local intent, direction/call actions |
| **GA4** | All site visitors with JS enabled | True visitor behavior, conversions |
| **Vercel Analytics** | Server-side visitor count | Most accurate de-duplicated visitor count |
| **Cloudflare** | Edge requests | Bot/threat traffic, DNS health |

For the **monthly health check**, prioritize this order:
1. GBP Performance (the primary growth lever for local SEO)
2. Search Console (organic search visibility)
3. GA4 (post-click behavior)
4. Vercel Analytics (real Core Web Vitals)
5. Cloudflare (operational health, not growth)

---

## Next Snapshot

**Schedule:** First Sunday of each month
**Next:** June 1, 2026

Build a backend cron job that pulls all 5 data sources weekly and writes to `phase-5-post-launch-ops/weekly-data/{YYYY-MM-DD}.md`. Compare month-over-month deltas to identify which channels are growing.

---

## Action Items From This Baseline

1. **Re-run OAuth token script with `analytics.readonly` scope** to unlock GA4 Data API
2. **Investigate the 3,721-impression aftercare page** — these are AAD researcher queries, not buyer intent. Either accept the noise or block AAD-pattern queries from GSC reports somehow
3. **Mobile clicks are the real signal** — the 22 mobile clicks on 963 mobile impressions is a 2.28% CTR (normal). Future copy/title optimization should focus on what converts on mobile
4. **GBP direction requests outpace website clicks 57 vs 34** — high physical intent. Lean into "visit us" / "directions" CTAs on the GBP profile. Maybe add an offer post inviting walk-by intros
5. **Phone calls are 2 over 34 days** — drop "Call us" CTAs lower in priority. Lead with "Text us" or "Submit consultation form"
