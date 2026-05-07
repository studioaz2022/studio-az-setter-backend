# Studio AZ Tattoo — Improvement Journal

> **What this is:** The long-term log of every change made to tattooshopminneapolis.com, the analytics signals around each change, and what worked vs what didn't. This is the source of truth for "what compounds for THIS site."
>
> **Append-only.** Never edit or delete past entries. If a past entry is wrong or superseded, add a new dated entry that explains why — don't rewrite history. Patterns only emerge if we can see how our understanding evolved over time.
>
> **How to read this file:**
> - **Snapshots** = point-in-time data captures. Use them as anchors when comparing periods.
> - **Experiments** = a change we made + its measured outcome.
> - **What's Working / What's Not Working / Inconclusive** = running tally appended to over time. Each row is dated.

---

## Quick Reference

- **Site launched:** April 15, 2026
- **Domain:** tattooshopminneapolis.com
- **GA4 property:** `properties/511557077` (`G-XYEDL03XZR`)
- **GBP location:** `locations/13377765707428643781` (Place ID `ChIJt_vZnAAzs1IR5e7h5BUE0O0`)
- **Search Console property:** `sc-domain:tattooshopminneapolis.com`
- **Pipeline state doc:** [`PIPELINE.md`](../../PIPELINE.md)
- **Insight loop pattern:** [insight_loop_pattern.md](../../../../../.claude/projects/-Users-studioaz-Documents-Studio-AZ-Tattoo-App/memory/insight_loop_pattern.md)

---

## Entry Format Template

When adding a new entry, copy this template into the appropriate section:

```markdown
### {YYYY-MM-DD} — {short title}

**Type:** snapshot | experiment | observation
**Sources:** GA4 / GBP Performance / Search Console / Vercel / Cloudflare / Local Falcon
**Time window covered:** e.g. "30d ending 2026-05-04"

**Context / what we did:** What was true going in. If experiment: what change shipped + commit hash.

**Data:** the actual numbers. Prefer tables. Include the API query if it's reproducible.

**Verdict:** works | doesn't work | inconclusive — {one sentence why}.

**Links:** to commits, deploys, deeper analyses (e.g. `phase-5-post-launch-ops/insights/...`).
```

---

# 📊 SNAPSHOTS — Point-in-time data captures

Each snapshot is a frozen "here's what the numbers said on this date." Use them as comparison anchors.

### 2026-05-06 — Quick checks: GBP WoW, schema audit, near-ranking keywords

**Sources:** GBP Performance API, live HTML scraping, Search Console, PageSpeed API
**Time window:** Multiple — see below per check

#### GBP Performance — week-over-week

| Metric | Prior 7d (Apr 22-28) | Recent 7d (Apr 29-May 5) | Change |
|---|---|---|---|
| Mobile Maps impressions | 53 | 28 | **−47%** |
| Mobile Search impressions | 30 | 22 | −27% |
| Desktop Search impressions | 28 | 17 | −39% |
| Desktop Maps impressions | 5 | 13 | **+160%** |
| **Total impressions** | 116 | 80 | **−31%** |
| Direction requests | 4 | 11 | **+175%** |
| Website clicks | 6 | 9 | +50% |
| Phone calls | 0 | 1 | +1 |

**Interpretation:** Total impressions dropped 31% week-over-week, BUT high-intent actions (directions, website clicks, calls) all climbed. Fewer eyeballs, higher quality eyeballs — could be a category/services optimization effect (cleaned up bloat May 4) routing better-fit traffic. Could also just be a small-sample noise blip — the volumes are too low (80-116 impressions/wk) to draw strong conclusions yet.

**Verdict:** ⚠️ inconclusive — quality up, quantity down. Watch next week to see if quality holds while quantity rebuilds.

#### Schema validation — every page has JSON-LD EXCEPT /consultation

| Page | Schema entities | Status |
|---|---|---|
| / | TattooParlor, WebSite, BreadcrumbList | ✓ |
| /services | 4 × Service, BreadcrumbList | ✓ |
| /artists | ItemList, BreadcrumbList | ✓ |
| /artists/joan | Person, ImageGallery, BreadcrumbList | ✓ |
| /artists/andrew | Person, ImageGallery, BreadcrumbList | ✓ |
| /gallery | ImageGallery, BreadcrumbList | ✓ |
| /aftercare | Article, HowTo, BreadcrumbList | ✓ |
| /parking | Article, BreadcrumbList | ✓ |
| /faq | FAQPage, BreadcrumbList | ✓ |
| /contact | TattooParlor, BreadcrumbList | ✓ |
| **/consultation** | **NONE** | **⚠️ MISSING** |

**Verdict:** 10 pages perfect, 1 gap. /consultation should have at least a `BreadcrumbList` + maybe `FAQPage` or `WebPage` schema. Worth fixing — the page is the conversion endpoint, so search rich-results would help.

#### Search Console — near-ranking keywords (last 30d)

**Position 6-10 (close to top 5 — high leverage):** 28 keywords with 5+ impressions. **The brutal finding:** ~20 of the 28 are AAD-aftercare research queries that go to /aftercare and convert at 0%. Real buyer keywords in this band:
- **`tattoo shops near me`** — pos 18.8, 24 impressions, **3 clicks** (12.5% CTR — strong) → /
- **`studio az`** — pos 8.4, 13 impressions → /contact
- **`az studio minneapolis`** — pos 6.2, 10 impressions → /
- **`studio a tattoo`** — pos 9.3, 6 impressions → /

**Position 11-20 (page 2 — promotion candidates):** Only **2** — and one is more AAD junk. The single buyer keyword on page 2 is `tattoo shops near me` at 18.8.

**Verdict:** The "easy promotion" pool is shallow. AAD researcher traffic dominates the impression list. The brand-name keywords (`studio az`, `az studio minneapolis`, `studio a tattoo`) are already at acceptable positions for low-volume brand queries. The biggest opportunity is `tattoo shops near me` — if we can move it from position 18.8 to top 5, the CTR could 4-5×.

#### PageSpeed re-run

**Verdict:** ⚠️ blocked — PageSpeed Insights API quota exhausted on project 578174142047. Run manually at https://pagespeed.web.dev/analysis/https-tattooshopminneapolis-com/?form_factor=mobile and add results to a follow-up entry.

**Links:**
- Schema gap: needs a small fix at `tattoo-website/src/app/(site)/consultation/page.tsx`
- Near-ranking opportunity: target `tattoo shops near me` with content + internal links to /

---

### 2026-05-06 — First custom-event data populated

**Sources:** GA4
**Time window:** 2 days ending 2026-05-06 (one day after wiring CTA + funnel events)

**Site traffic:**
| Metric | Value |
|---|---|
| Sessions | 22 |
| Users | 17 |
| Page views | 69 |

**Custom events firing correctly:**
| Event | Events | Users |
|---|---|---|
| consultation_step_complete | 12 | 1 |
| consultation_started | 2 | 1 |
| cta_click | 1 | 1 |

**Notable:** 1 visitor went all the way through the consultation form (10 step events including the optional secondary questions). 1 cta_click from the new tracking system on `artist_detail_joan_cta`. InquiryForm tracking still 0 events because no `/joan` or `/andrew` Meta ad traffic in the period.

**Verdict:** Tracking infrastructure validated end-to-end.

**Links:** Loop iteration #1 → [`phase-5-post-launch-ops/insights/2026-05-06-consultation-form-start-dropoff.md`](phase-5-post-launch-ops/insights/2026-05-06-consultation-form-start-dropoff.md)

---

### 2026-05-04 — Cross-source data baseline (after all 5 sources connected)

**Sources:** GA4, GBP Performance, Search Console, Vercel, Cloudflare
**Time window:** Varied per source (28-34d for most; 7d for Cloudflare; just-enabled for Vercel)

**Headline numbers** (full breakdown at [`data-baseline-2026-05-04.md`](phase-5-post-launch-ops/data-baseline-2026-05-04.md)):

| Source | Metric | Value |
|---|---|---|
| GA4 (30d) | Sessions / Users / Page views | 321 / 236 / 784 |
| GA4 (30d) | Engagement rate | 54.5% |
| GA4 (30d) | Mobile share | 75% |
| GA4 (30d) | In-region users (Twin Cities) | 46% |
| GA4 (30d) | Form starts → submits | 13 / 1 = 7.7% |
| Search Console (28d) | Total impressions | 5,607 |
| Search Console (28d) | Total clicks | 30 |
| Search Console (28d) | CTR (mobile only) | 2.28% |
| Search Console (28d) | /aftercare impressions | 3,721 (zero clicks — AAD researcher queries) |
| GBP Performance (34d) | Total impressions | 497 |
| GBP Performance (34d) | Website clicks | 34 |
| GBP Performance (34d) | Direction requests | 57 |
| GBP Performance (34d) | Phone calls | 2 |
| GBP Performance (34d) | Engagement rate | 18.7% (well above local-business 4-6% avg) |
| Reviews | Count / Rating | 14 / 5.0 |

**Top traffic sources (GA4):**
| Channel | Sessions |
|---|---|
| Direct | 154 |
| Organic Search | 76 |
| Organic Social (Instagram 65, Facebook 2) | 67 |
| Referral | 18 |
| ChatGPT | 6 ← `llms.txt` working |

**Top pages (GA4 30d):**
1. Homepage — 239 views / 135 users
2. /andrew (Meta ad landing) — 97 / 65
3. /artists — 92 / 53
4. /consultation — 79 / 38
5. /artists/joan — 49 / 26

**Verdict:** Solid early baseline. Mobile-first decisions validated. ChatGPT traffic appearing is a positive signal. Form completion rate identified as biggest leak.

**Links:** [`data-baseline-2026-05-04.md`](phase-5-post-launch-ops/data-baseline-2026-05-04.md)

---

### 2026-05-04 — Local Falcon Map Pack rescan

**Sources:** Local Falcon (manual scan)
**Time window:** Single point-in-time scan
**Compared to:** March 23, 2026 baseline (which was the OLD GHL site at peak authority)

**Map Pack visibility (5 baseline keywords):**
| Keyword | Mar 23 ARP | May 4 ARP | Center rank held? |
|---|---|---|---|
| tattoo shop minneapolis | 3.00 | 11.00 | Yes (#3 at center) |
| tattoo shop near me | 4.00 | 11.50 | Yes (#4 at center) |
| tattoo artist minneapolis | 8.00 | 13.00 | Yes (#8 at center) |
| best tattoo shop minneapolis | 21.00 | 21.00 | Still invisible |
| custom tattoo minneapolis | 21.00 | 21.00 | Still invisible |

**Critical context:** March baseline = old GHL site with months of accumulated authority. May 4 = new Vercel site, only 19 days old. Migrations usually cost 5-10 ranking positions for 30-90 days. Holding center ranks through migration is a positive outcome, not a regression.

**Verdict:** **Site migration survived without ranking damage.** The "ARP went up" headline is misleading — it's because adjacent grid cells expanded from "20+" to actual numbers, mathematically inflating averages.

**SoLV (top-3 share):** Still 0.83 — only top-3 at our exact location. Need much more authority (read: reviews + citations) to expand.

**Links:** [`phase-5-post-launch-ops/local-falcon-rescan-2026-05-04.md`](phase-5-post-launch-ops/local-falcon-rescan-2026-05-04.md)

---

### 2026-04-15 — Site launch (true Day 0)

**Sources:** Vercel deployment + DNS cutover
**Time window:** N/A — single event

**What launched:**
- 10+ pages: home, services, artists, gallery, aftercare, parking, faq, contact + artist detail pages + artist Meta ad landing pages
- 12-step bilingual consultation form at `/consultation`
- 1200x630 OG image, all favicon sizes, web manifest
- GA4 (`G-XYEDL03XZR`) + Vercel Analytics
- Schema markup: TattooParlor, Service, Person, FAQPage, BreadcrumbList, ImageGallery
- Hero LCP fix (raw `<img>` + preload + fetchPriority)

**Pre-launch state:** Old GHL single-page funnel at the same domain.

**Verdict:** Migration completed cleanly. SSL via Vercel, DNS via Cloudflare (proxy off / DNS only).

**Links:** [`PIPELINE.md`](../../PIPELINE.md) shows phase-by-phase completion.

---

# 🧪 EXPERIMENTS — Changes we shipped + their results

Each experiment is a deliberate change with a measurable hypothesis. Verdict appears once enough time has passed to verify.

### 2026-05-07 — Target "tattoo shops near me" on homepage + FAQ

**Type:** experiment
**Hypothesis:** This keyword sits at position 18.8 with 24 impressions and a 12.5% CTR (3 clicks) over the last 30 days. CTR is already strong for that position. Adding the exact phrase to high-authority pages (homepage 2×, FAQ 1× with internal link to home) should nudge the ranking onto page 1 (positions 1-10), potentially 4-5×ing the volume.

**Change shipped:** Commit on 2026-05-07.
- Homepage: added "tattoo shops near me" exact phrase to two existing paragraphs — the "what you're searching for" hook in the artists intro section (1×) and the final CTA copy (1×). Both naturally placed, no awkward keyword stuffing.
- FAQ: added a contextual link `<Link href="/">tattoo shops near me</Link>` inside the "Where is Studio AZ located?" answer. This is the highest-authority internal link on the site (FAQ is linked by every page) pointing to / with the target anchor text.

**Verification window:** 2-3 weeks. Search Console position takes time to update.

**Success criteria:** Position moves from 18.8 → top 10 on /. Anything still > 15 means we need bigger levers (backlinks).

**Verdict:** ⏳ pending verification

**Why this might work:** Combination of (a) exact-match keyword frequency on the target page with (b) internal anchor text from a high-authority page is one of the strongest on-page signals. We have no backlink strategy yet, so on-page is our biggest available lever.

**Why this might NOT work:** "tattoo shops near me" is a hyper-competitive query dominated by Google's Local Pack — the organic position 18.8 might be capped by sheer competition no matter what we do on-page. If position doesn't move, we'd need to invest in citations + reviews (Map Pack signals) instead of trying to win the organic listing.

---

### 2026-05-07 — Add JSON-LD schema to /consultation page

**Type:** experiment (technical SEO fix)

**Hypothesis:** The /consultation page had ZERO schema in the live HTML — the `<JsonLd>` was rendered inside a client component wrapped in Suspense, so the script tag only appeared after JS loaded (too late for crawlers). Moving schema to the server-rendered `layout.tsx` adds it to the initial HTML response, so Google sees it.

**Change shipped:** Commit on 2026-05-07.
- Moved `JsonLd` from `consultation/page.tsx` (client) to `consultation/layout.tsx` (server)
- Upgraded the schema while moving: was just `BreadcrumbList`; now also `WebPage` with `inLanguage: ["en", "es"]`, `potentialAction: ReserveAction`, and proper `@graph` linkage to the existing site WebSite + Organization entities.

**Verification:** Live HTML now shows 2 entities: WebPage + BreadcrumbList ✓

**Verdict:** ✅ technical fix landed. Ranking impact (if any) is hard to measure — schema's effect is gradual, mostly improves rich-result eligibility.

**Lesson learned:** Any future client component wrapped in Suspense (e.g. for `useSearchParams`) needs its schema rendered in the parent server-side layout/page, NOT inside the client component itself. **Adding this gotcha to the Phase 3 SEO Fix Pass 4 (schema verification) instructions** so future site audits catch this on first pass.

---

### 2026-05-06 — Add above-the-fold framing to /consultation language picker

**Type:** experiment
**Hypothesis:** The 5.3% form-start rate on /consultation is caused by visitors not understanding that the language flags ARE the form start. Adding a headline + step indicator above the picker should signal "click below to start."

**Change shipped:** [Future commit hash — TBD when shipped from prompt the user takes to a fresh chat]

**Pre-experiment data (7d ending 2026-05-06):**
- 19 visitors to /consultation
- 1 fired `consultation_started` event (5.3%)
- Industry benchmark: 15-25%

**Verification window:** Re-pull funnel data on 2026-05-13.

**Success criteria:** Form-start rate climbs to ≥15%. Anything <10% means the fix didn't address the root cause and we re-investigate.

**Verdict:** ⏳ pending verification

**Links:** [`phase-5-post-launch-ops/insights/2026-05-06-consultation-form-start-dropoff.md`](phase-5-post-launch-ops/insights/2026-05-06-consultation-form-start-dropoff.md)

---

### 2026-05-05 — CTA tracking wired across all 16 site-wide CTAs + InquiryForm tracking

**Type:** experiment (instrumentation, not UX)
**Hypothesis:** Knowing which CTA placements convert best will let us double down on top performers and retire low performers.

**Change shipped:** Multiple commits May 5 (`87cbe1d`, etc.) — extended `Button` component with `trackingLocation` prop, wired all 12 Button instances across 9 pages, plus 4 raw `<a>`/`<Link>` tags in nav/footer/hero. Also added 6 new event helpers for the artist landing page InquiryForm. Registered 5 more GA4 custom dimensions and `inquiry_submitted` as a conversion event.

**Verification window:** ~14 days of cta_click data needed before placement-vs-placement comparisons are meaningful.

**Verdict:** ⏳ tracking validated (events firing) — placement-comparison verdict pending in ~2 weeks

**Links:** Memory at [conversion_funnel_tracking.md](../../../../../.claude/projects/-Users-studioaz-Documents-Studio-AZ-Tattoo-App/memory/conversion_funnel_tracking.md)

---

### 2026-05-05 — 12-step consultation form custom event tracking shipped

**Type:** experiment (instrumentation)
**Hypothesis:** Step-level event tracking will reveal which step has the highest drop-off.

**Change shipped:** Commits May 5 (`16e2157`) — built `src/lib/analytics.ts` with 6 typed helpers, wired into the form, registered 17 custom dimensions + 2 conversion events via API.

**First data within 24h:** 1 user completed all 9 primary + 2 secondary steps successfully. Confirmed events fire correctly. Bigger insight surfaced — only 1 of 19 page-viewers actually started the form (separate experiment, see above).

**Verdict:** ✅ tracking infrastructure works as designed. Surfaced a previously-invisible bottleneck.

**Links:** Memory at [ga4_data_api.md](../../../../../.claude/projects/-Users-studioaz-Documents-Studio-AZ-Tattoo-App/memory/ga4_data_api.md)

---

### 2026-05-04 — GBP services bloat cleanup

**Type:** experiment
**Hypothesis:** GBP listing showing 43 auto-suggested services (body waxing, ear piercing, tooth gems, etc.) dilutes topical relevance. Listing only services we actually offer should improve ranking signal for tattoo-specific queries.

**Change shipped:** Removed irrelevant services. Final 6 services: Fine Line Tattoos, Tattoo Design, Realism Tattoos, Black and Grey Tattoos, Abstract Tattoos, generic Tattoo. Plus added descriptions for each (300-char limit).

**Note on color:** Removed "Color Ink Tattoos" because artists currently focus on black & grey — accuracy over breadth.

**Verification window:** 30-60 days for Map Pack movement.

**Verdict:** ⏳ pending. Will know after June 4 Local Falcon re-scan.

---

### 2026-04-15 → 2026-05-04 — Initial GBP optimization push

**Type:** experiment (multi-change bundle — compounding improvements)
**Bundled changes:** Updated GBP website URL to new domain, set primary category Tattoo shop + secondary Tattoo artist, fixed website URL discrepancies, cleaned services list.

**Reviews:** Grew 9 → 14 (+5) over 6 weeks. Pace ~1 review/week.

**GBP Performance (34d):** 497 impressions, 18.7% engagement rate (vs 4-6% local-business avg).

**Verdict:** ✅ healthy engagement rate. Reviews need to grow faster — see "What's Not Working Yet" below.

---

# ✅ WHAT'S WORKING — keep doubling down

Append a new dated row each time data confirms something is working. Don't delete past rows even if a "stop" verdict appears later — that's how the trail of evidence stays intact.

| Date | What | Evidence |
|---|---|---|
| 2026-05-04 | **Mobile-first design priorities** | 75% of GA4 sessions are mobile. Mobile CTR (2.28%) is industry-normal; desktop traffic is mostly noise. |
| 2026-05-04 | **Bilingual content** | Spanish landing pages (`/joan-martinez`, `/estacionamiento-y-direcciones`) and Spanish reviews indicate strong demand. Reviews from `Jany Escoto`, `Andris Aponte`, `Estefany Colmenarez` confirm Spanish market. |
| 2026-05-04 | **`llms.txt` for AI crawlers** | 6 sessions from `chatgpt.com` in 30 days. AI search is now sending real traffic. Continue investing. |
| 2026-05-04 | **Andrew's Meta ad landing page** | `/andrew` is the #2 most-visited page (97 views, 65 users). Meta ads working for him. |
| 2026-05-04 | **Hero LCP optimization** | Site migration didn't cause a ranking dip in Local Falcon — partially because performance was improved during migration. |
| 2026-05-06 | **GBP high-intent actions climbing WoW** | Direction requests +175% (4→11), website clicks +50% (6→9), calls +1 even as total impressions dropped 31%. Quality up, quantity down. |
| 2026-05-06 | **`tattoo shops near me` at pos 18.8 with 12.5% CTR** | 24 impressions / 3 clicks in 30 days — already converting better than industry average for that position. If we can push to page 1, this becomes a major source. |
| 2026-04-15 | **Domain migration approach** | Held center ranks for tattoo shop minneapolis (#3), tattoo shop near me (#4), tattoo artist minneapolis (#8) through DNS cutover. Most migrations cost 5-10 positions. |

---

# ❌ WHAT'S NOT WORKING (yet) — pause or fix

Append a new dated row each time data shows something isn't working. The "yet" matters — sometimes things just need more time. Use the `Action` column to make it clear what we're doing about it.

| Date | What | Evidence | Action |
|---|---|---|---|
| 2026-05-06 | **/consultation form-start rate (5.3%)** | Only 1 of 19 visitors starts the form despite 80% non-bounce rate and 2:43 avg session duration. People treat the page as info content. | Shipping above-the-fold framing fix on 2026-05-06. Verify 2026-05-13. |
| 2026-05-06 | **/consultation missing JSON-LD schema** | All 10 other pages have schema; /consultation has NONE. Page is the primary conversion endpoint — should at least have BreadcrumbList + WebPage schema. | Add schema in next commit. Low effort, high value. |
| 2026-05-06 | **GBP impressions down 31% WoW** | Mobile Maps impressions dropped 53→28, total impressions 116→80. Could be sample noise (low volume) or post-services-cleanup effect. | Monitor next 2 weeks. If sustained drop, re-investigate. |
| 2026-05-04 | **Aftercare CTR (0% on 3,721 impressions)** | Page ranks well (#7.3 avg position) for AAD aftercare research queries — but those people are researchers, not buyers. Not your audience. | Don't optimize. Treat as vanity impressions. Skip in future analyses. |
| 2026-05-04 | **High-intent commercial keywords** | "best tattoo shop minneapolis" + "custom tattoo minneapolis" still invisible (rank 21+) | Need authority — primarily reviews. Pace of 1/week is too slow to compete. |
| 2026-05-04 | **Phone-call CTAs** | Only 2 clicks in 34 days on GBP phone-call action. People don't want to call. | De-prioritize "Call us" CTAs in favor of text/form CTAs. |
| 2026-05-04 | **Review velocity** | 9 → 14 in 6 weeks (~1/week). Competitors at 100-1,200 reviews. To reach Map Pack contention need ~75-100 reviews maintaining 5.0 rating. | At current pace = 9-12 month timeline. Need text-after-tattoo automation to hit 10-15/month. **Highest-leverage open task on the board.** |

---

# 🤷 INCONCLUSIVE — needs more time/data

| Date | What | Why inconclusive |
|---|---|---|
| 2026-05-06 | **CTA placement rankings** | Only 1 day of cta_click data + 1 event total. Need ~14 days of multi-CTA traffic. |
| 2026-05-06 | **Inquiry form (artist landing pages)** | Zero events because no Meta ad traffic in the window. Will populate when ads run again. |
| 2026-05-06 | **GBP post impact** | Only 1 GBP post created (May 4). Need 4-6 weekly posts before we can say if posting cadence affects Map Pack. |
| 2026-05-06 | **PageSpeed score after May 4 LCP fix** | API quota exhausted; needs manual run at pagespeed.web.dev. Compare to last test (Performance 76, LCP 5.0s). Expected: Performance 85+, LCP < 3s. |
| 2026-05-04 | **Ranking trends** | Sites typically need 60-90 days for ranking patterns to stabilize. We're at ~22 days. Anything we infer now is noise. |
| 2026-05-04 | **Vercel real-world Core Web Vitals** | Just enabled May 4. Need 14+ days of real-visitor LCP/CLS distributions. |

---

# 🎯 OPEN HYPOTHESES — testing later

Things worth investigating once we have more data.

- **Does GBP weekly posting actually improve Map Pack rank?** — needs 8+ weekly posts shipped to test
- **Does the Andrew Meta ad landing page convert at a higher rate than the consultation widget?** — wait for inquiry form data + run ads to compare
- **Which CTA placement converts best on this site specifically?** — placeholder for the 14-day verdict on `cta_location` data
- **Do reviews actually unlock Map Pack?** — natural experiment as review count grows; correlate review count milestones with Local Falcon SoLV
- **Did the May 4 GBP services cleanup cause the WoW impression drop?** — first noticed 2026-05-06. Cleaning bloat services should make us LESS findable for irrelevant queries. If true, we'd expect quantity ↓ + quality ↑ — which is exactly what we saw. Monitor 2-3 more weeks to confirm.
- **Can we push `tattoo shops near me` from page 2 to page 1?** — currently pos 18.8 on /. Already converts at 12.5% CTR. Hypothesis: adding "tattoo shops near me" as an exact phrase 1-2× on / + an internal link from a high-authority page could nudge it. Test fix after consultation framing experiment is verified.

---

## How To Use This File Going Forward

**Weekly (every Monday) — when running the Insight Loop:**
1. Add a new SNAPSHOT entry at the top of that section with the week's data
2. If a fix shipped, add an EXPERIMENT entry with the change + hypothesis (verdict pending)
3. If a previous experiment's verification window has elapsed, find that entry and add a `**Verdict update {date}:**` line at the bottom of it (don't edit the original verdict line — append)
4. Append rows to "Working / Not Working / Inconclusive" tables when evidence shifts

**Monthly:**
- Read the last 4 snapshots side-by-side. Are trends consistent or noisy?
- Look at the Working table. Are we still doing what works?
- Look at the Not Working table. Did anything graduate to Working? If so, add a Working row dated today and note "graduated from Not Working" with the original date.

**Never:**
- Edit historical entries (data changes over time, but we keep the record of what we knew when)
- Delete entries (even ones we now know were wrong — they're learning)
- Compress old months (the audit trail is the value)
