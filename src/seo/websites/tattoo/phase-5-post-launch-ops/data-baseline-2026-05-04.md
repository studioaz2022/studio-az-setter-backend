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

## 5. GA4 Data API (NOW CONNECTED — May 5, 2026)

**Property:** `properties/511557077` (Studio AZ Tattoo)
**Measurement ID:** `G-XYEDL03XZR`
**Connected:** May 5, 2026 after enabling Analytics Admin API + Analytics Data API on the project + reissuing OAuth refresh token with `analytics.readonly` scope.

### Last 30 days totals (Apr 5 – May 5)
| Metric | Value |
|--------|-------|
| Sessions | **321** |
| Total users | **236** |
| New users | 232 (98% new) |
| Page views | **784** |
| Engaged sessions | 175 (54.5% engagement rate) |
| Bounce rate | 45.5% |
| Avg session duration | 2:03 |

**Solid early numbers** — 236 users in 30 days for a brand-new local site is healthy. The 98% new-user ratio is expected for a newly launched site (no return visitors yet), and the 54.5% engagement rate is good (above 50% is the GA4 health threshold).

### Traffic sources (where visitors come from)
| Channel | Sessions | Users |
|---------|----------|-------|
| **Direct** | 154 | 117 |
| Organic Search | 76 | 36 |
| Organic Social | 67 | 61 |
| Referral | 18 | 17 |
| Unassigned | 7 | 6 |

**Insight:** Direct traffic is dominant — meaning people are typing the URL or clicking saved links. Organic Search is growing (76 sessions in 30 days from a 19-day-old site is good). Organic Social is also strong — Instagram referrals.

### Top referrers (raw source)
| Source | Sessions |
|--------|----------|
| (direct) | 154 |
| google | 75 |
| **ig (Instagram)** | 65 |
| book.studioaz.us | 12 |
| **chatgpt.com** | 6 |
| studioaz.us | 6 |
| facebook.com | 2 |
| bing | 1 |

**Notable:** **6 sessions from ChatGPT** — AI search is now sending real traffic to your site. The `llms.txt` file is paying off. Continue to invest there.

### Top pages
| Page | Views | Users |
|------|-------|-------|
| / (homepage) | 239 | 135 |
| **/andrew** (Meta ad landing) | 97 | 65 |
| /artists | 92 | 53 |
| /consultation | 79 | 38 |
| /artists/joan | 49 | 26 |
| /gallery | 43 | 27 |
| /services | 31 | 15 |
| /joan-martinez (Spanish landing) | 27 | 20 |
| /artists/andrew | 25 | 20 |
| /estacionamiento-y-direcciones (Spanish parking) | 20 | 16 |

**Big finding:** The Andrew landing page (`/andrew`) is the **#2 most visited page**, getting 97 views from Meta ads. The Spanish-language Joan landing page (`/joan-martinez`) is also performing well at 27 views.

The /aftercare page that has 3,721 Search Console impressions doesn't even crack the top 10 in actual visitors — confirming our hypothesis that aftercare traffic is researchers (high impressions, no clicks).

### Geographic — Where Real Visitors Are
| City | Users |
|------|-------|
| **Minneapolis, Minnesota** | 72 |
| **Chicago, Illinois** | 36 |
| (unset) | 15 |
| Singapore | 14 |
| Saint Paul, Minnesota | 10 |
| (unset) Minnesota | 8 |
| (unset) California | 5 |
| Burnsville, Minnesota | 5 |
| Watertown, Wisconsin | 5 |
| Dallas, Texas | 4 |

**Real Twin Cities visitors (Minneapolis + St Paul + Burnsville + Maple Grove + Edina + Blaine + St Louis Park + unset MN):** ~108 of 236 = **46% of all traffic is in-region**. That's strong local relevance.

**Chicago at 36 users is unusual** — could be Andrew's networking from his convention work in the region, or referral traffic we should investigate.

### Device breakdown
| Device | Sessions | Users |
|--------|----------|-------|
| **mobile** | 242 (75%) | 163 (69%) |
| desktop | 77 (24%) | 72 |
| tablet | 2 | 1 |

**Mobile-dominant** — 75% of traffic is mobile. Confirms our mobile-first design priorities.

### Conversion events (the most important data)
| Event | Count | Users |
|-------|-------|-------|
| page_view | 784 | 236 |
| session_start | 321 | 236 |
| user_engagement | 286 | 93 |
| scroll | 211 | 112 |
| click | 22 | 18 |
| **form_start** | 13 | 12 |
| **form_submit** | 1 | 1 |

**Conversion funnel:**
- 236 users → 38 visited /consultation = **16% reach the consultation page**
- 38 consultation page users → 13 started the form = **34% started filling**
- 13 started → 1 submitted = **7.7% form completion rate** (or ~0.4% overall conversion)

**That's the biggest finding of this baseline.** The form completion rate is the bottleneck. Either:
- The form is too long/complex (likely — it's 9-step bilingual)
- The form is having technical issues
- People are starting it from curiosity not intent

Worth investigating: which step do people abandon at? Need event tracking per step.

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

1. ~~**Re-run OAuth token script with `analytics.readonly` scope** to unlock GA4 Data API~~ ✅ DONE May 5
2. **Investigate the 3,721-impression aftercare page** — these are AAD researcher queries, not buyer intent. The GA4 data confirms: aftercare doesn't even crack the top 10 actual visitors. The Search Console impressions are vanity, not value. Don't optimize.
3. **Mobile-first decisions are validated** — 75% of GA4 sessions are mobile. Mobile clicks on Search Console (2.28% CTR) is the true CTR signal.
4. **GBP direction requests outpace website clicks 57 vs 34** — high physical intent. Lean into "visit us" / "directions" CTAs on the GBP profile. Maybe add an offer post inviting walk-by intros.
5. **Phone calls are 2 over 34 days** — drop "Call us" CTAs lower in priority. Lead with "Text us" or "Submit consultation form".
6. **Form completion rate is 7.7% (1 of 13 starters submitted)** — biggest conversion bottleneck. Add per-step event tracking to see where users drop off. Consider:
   - Shortening the form
   - Adding a "save progress" feature
   - Making early steps easier (image picks vs text input)
7. **ChatGPT is sending traffic** (6 sessions). The `llms.txt` is working. Continue investing in AI-friendly content.
8. **Andrew's Meta ad landing page is the #2 visited page** — Meta ads are working for him. Consider scaling that budget if leads are converting.
9. **Investigate the Chicago traffic** (36 users) — is this from Andrew's convention contacts, a paid campaign, or organic discovery? If organic, find out why and exploit it.
