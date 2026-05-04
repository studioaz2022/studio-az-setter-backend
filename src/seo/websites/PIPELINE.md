# SEO Website Pipeline — Status Tracker

> This file tracks where each Studio AZ website is in the 5-phase SEO pipeline.
> Updated manually as phases are completed and approved.

---

## Pipeline Overview

```
Phase 1: Research              → Keyword map, competitor teardown, content gaps, baseline audit, Local Falcon baseline
Phase 2: SEO Architecture      → Page blueprints, schema, internal linking, image strategy, technical SEO, GEO, content intake
Phase 3: Design & Build        → /frontend-design → Next.js implementation + 4-pass SEO audit
Phase 4: Deploy & Verify       → Vercel deploy, favicon/OG/manifest, GA4, performance fixes, DNS cutover, Search Console
Phase 5: Post-Launch Ops       → GBP API, SerpAPI, Cloudflare API, automated weekly tracking, review generation, citations
```

Each phase requires approval before moving to the next.

### Why 5 phases (not 4)
Phase 5 was added in May 2026 because launching the site is only step one. Real ranking growth comes from operational tempo: weekly GBP posts, monthly content updates, automated review tracking, and continuous Map Pack monitoring. Phase 5 wires up programmatic access to all of these so the work scales — same effort whether you have 1 site or 10.

### Content Intake Workflow
Phase 2 produces a `content-intake.md` questionnaire customized to the site. The business owner fills it in with plain-language answers (pricing, policies, bios, parking details, FAQ answers, etc.). Claude then formats those answers into SEO-optimized page content during Phase 3, using the page blueprint and schema markup as formatting guides. This separates "SEO structure" (Claude) from "business knowledge" (owner) and makes the pipeline reusable across sites.

---

## Sites

### tattoo — tattooshopminneapolis.com

| Phase | Status | Deliverables | Approved |
|-------|--------|-------------|----------|
| **Phase 1: Research** | COMPLETE | keyword-map.md, competitor-teardown.md, content-gaps.md, baseline-audit.md, local-falcon-baseline.md | **Yes** (March 23, 2026) |
| **Phase 2: Architecture** | COMPLETE | page-blueprint.md, schema-markup.md, internal-linking.md, image-strategy.md, technical-seo.md, geo-ai-readiness.md, content-intake.md | **Yes** (March 23, 2026) |
| **Phase 3: Design/Build** | COMPLETE | Next.js site at `tattoo-website/` — 10+ pages, 4-pass SEO audit, consultation form, financing, language framing audit | **Yes** (April 2026) |
| **Phase 4: Deploy/Verify** | COMPLETE | Vercel deploy, DNS via Cloudflare, GA4 (G-XYEDL03XZR), favicon, OG image (1200x630), hero LCP fix, Search Console verified | **Yes** (April 15, 2026) |
| **Phase 5: Post-Launch Ops** | IN PROGRESS | GBP API (v1 + v4 enabled), SerpAPI live, Cloudflare API live, GBP services configured, first GBP post created via API. Pending: review automation, weekly cron jobs | — |

**Current step:** Phase 5 — finishing automation setup. 14 reviews/5.0 rating (up from 9). First GBP post live. Need: review automation, weekly post cron, Local Falcon re-scan.

**Domain:** tattooshopminneapolis.com
**GBP Place ID:** ChIJt_vZnAAzs1IR5e7h5BUE0O0
**GBP Location ID (API):** locations/13377765707428643781
**GBP Account ID (API):** accounts/107017428683340496769
**Stack:** Next.js 16 + TypeScript + Tailwind CSS 4 + ShadCN → Vercel
**Site code location:** `/Users/studioaz/Documents/Studio AZ Tattoo App/tattoo-website/`

---

### barbershop — minneapolisbarbershop.com

| Phase | Status | Deliverables | Approved |
|-------|--------|-------------|----------|
| **Phase 1: Research** | NOT STARTED | keyword-map.md, competitor-teardown.md, content-gaps.md, baseline-audit.md, local-falcon-baseline.md | — |
| **Phase 2: Architecture** | BLOCKED | page-blueprint.md, schema-markup.md, internal-linking.md, image-strategy.md, technical-seo.md, geo-ai-readiness.md, content-intake.md | — |
| **Phase 3: Design/Build** | BLOCKED | Next.js site at `barbershop-website/` | — |
| **Phase 4: Deploy/Verify** | BLOCKED | Vercel deploy, DNS, GA4, performance, Search Console | — |
| **Phase 5: Post-Launch Ops** | BLOCKED | GBP API, SerpAPI, Cloudflare, automation, reviews, citations | — |

**Current step:** Not started. Begin when tattoo site Phase 5 is wrapped or when prioritized.

**Domain:** minneapolisbarbershop.com
**GBP Place ID:** ChIJ598OaS4zs1IR4YfeL8TGg3g
**GBP Location ID (API):** locations/3193954697909267343
**GBP Account ID (API):** accounts/107017428683340496769 (shared with tattoo)
**Stack:** Next.js 16 + TypeScript + Tailwind CSS 4 + ShadCN → Vercel
**Site code location:** `/Users/studioaz/Documents/Studio AZ Tattoo App/barbershop-website/`

---

## Shared Resources

| Resource | Location | Purpose |
|----------|----------|---------|
| SEO Playbook | `src/seo/websites/SEO_PLAYBOOK.md` | Universal SEO rules (applies to all sites) |
| Phase Templates | `src/seo/websites/_template/` | Blank phase files — copy into new site folder |
| SerpAPI Client | `src/seo/serpApiClient.js` | Automated keyword + competitor research (key in Render env: `SERPAPI_KEY`) |
| GBP Client | `src/seo/gbpClient.js` | Google Business Profile API wrapper (v1 reads). For v4 (posts/reviews) call directly — see [gbp_api_access.md](../../../.claude/projects/-Users-studioaz-Documents-Studio-AZ-Tattoo-App/memory/gbp_api_access.md) |
| Search Console Client | `src/seo/searchConsoleClient.js` | Pull keyword + page performance |
| Cloudflare API | env vars in backend `.env` | DNS, redirects, zone management — see [cloudflare_credentials.md](../../../.claude/projects/-Users-studioaz-Documents-Studio-AZ-Tattoo-App/memory/cloudflare_credentials.md) |
| Schema templates | `src/seo/schema-{site}.json` | Per-site JSON-LD for GBP |
| SEO Toolkit Routes | `src/seo/seoRoutes.js` | Backend API endpoints at `/api/seo/*` |

---

## How to Start a New Site

The full process is now systematized. Follow this sequence:

### Step 0 — Prep
1. Add new directory to root `.gitignore` allowlist (BEFORE installing deps — Tailwind v4 requires this)
2. Decide the production domain and confirm Cloudflare manages it
3. Confirm GBP location exists and you have owner access

### Step 1 — Copy template
```bash
cp -R "src/seo/websites/_template" "src/seo/websites/<site-name>"
```

### Step 2 — Site-level setup
1. Fill out `<site-name>/SITEMAP.md` with NAP, hours, pages, booking flow, GBP IDs, social URLs
2. Fill out `<site-name>/SEO_OVERRIDES.md` with anything that differs from the shared playbook (NAP variations, brand voice, target audience specifics)

### Step 3 — Work through phases in order
Each phase has a `PHASE.md` with checkboxes. Work through them, get user approval at each gate, then advance.

- **Phase 1** (1-3 sessions): Research takes the longest — running SerpAPI keyword scans, crawling competitors, auditing the existing site. Output: 5 markdown deliverables.
- **Phase 2** (1-2 sessions): Architecture is mostly synthesis — turning Phase 1 data into page blueprints and schema specs. Output: 7 markdown deliverables.
- **Phase 3** (5-8 sessions): Design + build is the most time-intensive. One session per stage (design system + homepage, then page batches, then 4 SEO fix passes, then post-audit fixes).
- **Phase 4** (1-2 sessions): Deploy is fast if Phase 3 was clean. Just wiring assets + DNS + verification.
- **Phase 5** (2-4 sessions): Post-launch ops setup. Automation can be built incrementally over the first few weeks post-launch.

### Step 4 — Update this PIPELINE.md as you go
Mark each phase status (NOT STARTED → IN PROGRESS → COMPLETE) and approval state. Add a "Current step" note at the bottom of each site block so future Claude conversations can immediately see where to pick up.

### Step 5 — Write memory files
At the end of Phase 5, ensure these memory files exist (or are updated for the new site):
- `gbp_api_access.md` — GBP API state per location
- `cloudflare_credentials.md` — Cloudflare zone IDs per domain
- Site-specific entries in `MEMORY.md` index

---

## Estimated Time Per Site

With the full system in place, a new local-business site takes **~30-40 hours** of Claude collaboration time spread across 2-4 weeks:

| Phase | Sessions | Hours |
|-------|----------|-------|
| Phase 1 — Research | 1-3 | 4-6 |
| Phase 2 — Architecture | 1-2 | 3-5 |
| Phase 3 — Design/Build | 5-8 | 15-20 |
| Phase 4 — Deploy/Verify | 1-2 | 2-4 |
| Phase 5 — Post-Launch Ops | 2-4 | 4-6 |
| **Total** | **10-19** | **28-41** |

Subsequent sites get faster as the templates mature and the operator (you) learns the rhythm.
