# Local Falcon Re-Scan — May 4, 2026

**Compared to baseline:** March 23, 2026 (43 days earlier — but a fundamentally different site)
**Grid:** Same as baseline — 11x11, 4.5mi radius, 121 data points
**Center:** 44.9842902, -93.2738897 (Studio AZ location)
**Business state:** 5.0 rating, 14 reviews (up from 9 reviews in baseline)
**Site state:** New website live since April 15, 2026 (19 days old at scan time)

---

## CRITICAL CONTEXT — The March 23 Baseline Is Not Apples-to-Apples

**On March 23, the website was the old GHL site** that had been live for many months and had accumulated:
- Crawl history with Google
- Authority signals tied to specific old URL paths
- Whatever links/citations pointed to the old site
- Algorithmic trust from sustained age + stability

**On May 4, the website was the new Vercel site, only 19 days old.** Google was still re-evaluating domain authority following DNS cutover. New sites typically suffer a 30-90 day re-evaluation dip during migrations.

**This means the May 4 scan reflects a different scenario entirely.** We're not measuring "did GBP/SEO improvements help" — we're measuring "did the new site survive the migration without losing ground."

---

## The Real Headline: We Held Ground After a Major Migration

| Keyword | Mar 23 (old site) | May 4 (new site, 19d old) | What Actually Happened |
|---------|-------------------|---------------------------|------------------------|
| **tattoo shop minneapolis** | Center rank #3, SoLV 0.83 | Center rank #3, SoLV 0.83 | **Held #3 at center through migration** + 1 adjacent cell now showing #19 |
| **tattoo shop near me** | Center rank #4, SoLV 0.00 | Center rank #4, SoLV 0.00 | **Held #4 at center through migration** + 1 adjacent cell now showing #19 |
| **tattoo artist minneapolis** | Center rank #8, SoLV 0.00 | Center rank #8, SoLV 0.00 | **Held #8 at center through migration** + 1 adjacent cell now showing #18 |
| **best tattoo shop minneapolis** | Invisible (21+) | Invisible (21+) | No movement — too competitive without more reviews |
| **custom tattoo minneapolis** | Invisible (21+) | Invisible (21+) | No movement — too competitive without more reviews |
| tattoo near me (bonus) | not in baseline | Center rank #4, adjacent cell #15 | New visibility data point |

### Why the ARP "increase" is actually positive

Local Falcon's ARP went UP for the 3 visible keywords (3 → 11, 4 → 11.5, 8 → 13). At first glance this looks like ranks got worse. **It's the opposite.**

- A grid cell showing "20+" means you're not in the top 20 there (counted as 21 in math)
- A grid cell showing "19" means you ARE in the top 20 there
- When a 20+ cell becomes a 19, it lowers your visibility "out-of-view" count but raises your AVERAGE rank because more cells now have actual numbers in the calculation

Translation: **you started showing up at a few new locations** outside your immediate center point. The averages shift to reflect that expansion.

### Definitions
- **ARP** (Average Rank Position) — average rank across grid points where you appear (lower is better)
- **ATRP** (Average Total Rank Position) — average rank across ALL 121 grid points, treating "20+" as 21
- **SoLV** (Share of Local Voice) — % of grid points where you rank in top 3 (higher is better)

---

## What This Tells Us About the Migration

For a brand-new 19-day-old site to **hold the same center ranks** as the established old site is a **strong outcome**. Most site migrations cause:
- 30-90 day ranking dip while Google re-evaluates
- Loss of position 5-10 spots typically
- Sometimes complete loss of certain rankings

The fact that we held position suggests:
- The domain age stayed intact (we kept the same domain)
- The new site's technical SEO is at least as good as the old one
- The GBP improvements (services list, +5 reviews, first GBP post) softened any migration impact

**This is genuinely good news** — we successfully replaced the old site with a vastly better one without paying a ranking penalty.

---

## What Hasn't Changed Yet

- **SoLV is still 0.83 across the board** — we're top-3 only at our exact location, nowhere else on the grid
- **High-intent commercial keywords** ("best", "custom") are still completely invisible — those need authority we haven't built yet
- **Visibility radius is small** — outside ~1 cell from center, we don't appear

These are all expected at 19 days post-launch with only 14 reviews vs competitors at 100-1,200.

---

## Competitive Reality

For "tattoo shop minneapolis" the consistent top-3 across the grid is:
- Leviticus Tattoo (1,200 reviews, 4.7⭐)
- Steady Tattoo (540 reviews, 4.7⭐)
- Timeless Tattoo (101 reviews, 5.0⭐)

The most beatable is **Timeless Tattoo (101 reviews)**. To realistically challenge them you need 75-100 reviews while maintaining 5.0 rating.
- At current pace (~5 reviews per 6 weeks): **9-12 month timeline**
- With review automation (10-15/month): **5-7 month timeline**

---

## The New Baseline

**May 4, 2026 is the new baseline.** The March 23 numbers tracked a different website. Going forward:
- Compare every future scan against May 4
- Real signal of new site performance starts now
- Next scan: **June 4, 2026** — measures the first true 30-day delta on the new site

---

## Action Items (Phase 5 Roadmap)

The new site survived migration. Now it needs aggressive signal-building to grow beyond the old site's ceiling:

1. **Review automation** (HIGHEST IMPACT) — text after every tattoo, goal 10-15 reviews/month
2. **Weekly GBP posts** — already have first post live via API, need cron to automate
3. **Local citations** — Yelp, Bing Places, Apple Business Connect, North Loop Neighborhood Association
4. **Backlinks** — get listed on Mpls.St.Paul Magazine, City Pages, Minneapolis Chamber of Commerce
5. **Fresh content** — first blog post or new page (per SEO_RULES.md monthly cadence)
6. **Re-scan June 4** — measure first true 30-day delta on the new site

---

## Methodology Note for Future Re-Scans

When the new site has 90+ days of crawl history (post-July 15, 2026), the comparison math becomes simpler — we'll be comparing the new site to itself over time. Until then, treat any baseline-vs-current numbers with the migration caveat.

For new sites going forward (e.g. barbershop), the Phase 1 baseline scan should ideally happen AFTER the new site is live and has 30 days of crawl history, not before. That gives a more honest "starting point" to measure improvements against.
