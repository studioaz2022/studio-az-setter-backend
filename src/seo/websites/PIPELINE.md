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

### Phase verification + summary (REQUIRED before each approval gate)

As of May 27, 2026, every phase ends with two mandatory steps before user approval can be requested:

1. **Verification checklist** — concrete, machine-or-eye verifiable checks that prove the phase was done RIGHT (not just "done"). Lives at the bottom of each phase's `PHASE.md` under `## Verification`. If any check fails, the phase is NOT ready for approval — either fix the gap, or explicitly punt with written justification in the summary.
2. **End-of-phase summary** — `phase-{N}-summary.md` written into the phase folder. Captures WHY decisions were made, what got punted, what surprised us, and what the next phase should start with. The tattoo site phases don't have these (they were built before this convention) — for barbershop and every future site, they're required.

Together these give you (the user) a clear audit trail: PIPELINE.md tells you which phase you're on, the per-phase `PHASE.md` Verification section tells you what's still pending in this phase, and `phase-{N}-summary.md` tells you why we chose what we chose.

**The approval ritual:**
1. Claude completes deliverables
2. Claude runs Verification checklist — reports green or flags gaps
3. Claude writes `phase-{N}-summary.md`
4. Claude requests user approval
5. User approves (or sends back for fixes)
6. Claude updates PIPELINE.md status + Approved column

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
| **Phase 1: Research** | COMPLETE | keyword-map.md, competitor-teardown.md, content-gaps.md, baseline-audit.md, local-falcon-baseline.md, phase-1-summary.md | **Yes** (May 28, 2026) |
| **Phase 2: Architecture** | COMPLETE | page-blueprint.md, schema-markup.md, internal-linking.md, image-strategy.md, technical-seo.md, geo-ai-readiness.md, content-intake.md, phase-2-summary.md | **Yes** (June 4, 2026 — operator-validated; multiple amendments through June 5 for Gallery-as-CMS architecture + design system) |
| **Phase 3: Design/Build** | COMPLETE | Stages A–G all shipped. 25 routes live (homepage, 4 craft pillars, /barbers + per-barber bios, /gallery, /book native widget, /careers, /about, /north-loop, /faq, /reviews, /services, /contact + non-indexed /sunday-appointments, /parking-directions, /confirmation, /home, /friends-family). Live Google reviews (Places + GBP), gallery-as-CMS, deposit flow via Square, funnel analytics (12 typed event helpers). | **Yes** (implicit — launched) |
| **Phase 4: Deploy/Verify** | COMPLETE | Vercel deploy ✓, favicon/icon/apple-icon/manifest/OG ✓, GA4 `G-KCBLNWT8MF` ✓, @vercel/analytics + speed-insights ✓, **DNS cutover 2026-09-15** ✓, Search Console property verified ✓, GBP website URL correct ✓ | **Yes** (Sept 15, 2026) |
| **Phase 5: Post-Launch Ops** | IN PROGRESS | GBP API ✓ (business.manage), Cloudflare API ✓, Local Falcon ✓, review-generation SMS ✓ (already running, 540+ reviews), citations ✓ (TBR submitted, Barberhead live). REMAINING: sitemap submission to GSC (needs write scope — token is read-only), SerpAPI post-launch baseline, weekly tracking crons. | — |

**Current step:** **LAUNCHED.** DNS cut over 2026-09-15 — `minneapolisbarbershop.com` A → `216.198.79.1` + `64.29.17.1`, `www` CNAME → `d8ffb56fd2fc4be9.vercel-dns-017.com`, both grey-cloud, TTL 300. Old GHL values for rollback: A `162.159.140.166`, www CNAME `sites.ludicrous.cloud`.

**Cutover gotcha worth remembering:** Vercel would not issue the TLS cert for ~25 min after DNS was correct — `openssl s_client` returned `no peer certificate available` while `misconfigured: false` and `acceptedChallenges: ['http-01']`. The fix was to CYCLE the project-domain attachment (DELETE + re-POST via `/v9/projects/{id}/domains`); the cert issued within 40s of the cycle, for both apex and www. The apex could not be deleted until `www`'s redirect to it was cleared first (`domain_is_redirect` 409) — so the order is: clear www redirect → cycle apex → restore www redirect. Port 80 served correctly the whole time, which is how we knew the edge was healthy and it was purely cert issuance.

Post-cutover verified: all 17 key pages 200 on the live domain; canonical/sitemap/robots/JSON-LD all say `minneapolisbarbershop.com`; `www` → 308 → root; legacy redirects green (`/parking` → `/north-loop`, `/confirmation-page` + `/confirmationpage-mnstudioaz` → `/confirmation` with query preserved, `/choose-haircut-specialty` → `/haircuts`, `/family--friends` → `/friends-family`). GHL trigger link `pPYoJcATUSzjUoy71L4w` ("Confirmation Menu") re-pointed to `/confirmation` — verified end-to-end against a REAL already-sent SMS short link, which now lands on the new page with the appointment rendered (GHL sends the date as "September 17, 2026", not ISO — the parser's `Date.parse` fallback handles it). Apple Pay domain registered with Square: `VERIFIED`, production. Re-run `barbershop-website/scripts/verify-cutover.sh` any time.

**Still open:** (1) one real booking on **Gilberto's** calendar to exercise the SMS → trigger-link → /confirmation hop on a barber calendar — **tell Gilberto first**, it sends him a real notification; (2) the DEPOSIT path (Lionel's calendar only) has never run end-to-end — `backend/scripts/check-deposit-booking.js` reads the 5 signals from the first real deposit booking and reports which landed; (3) GSC sitemap submission needs a write-scoped token; (4) `book.studioaz.us` → Vercel deferred until after launch is proven (it is a separate CNAME the cutover never touched; moving it breaks `book.studioaz.us/` and `/haircuts` unless redirects are added first).

Phase 3 design system locked: editorial-archive register ("field journal at the barber chair"); bone (`#F2EBDD`) + ink (`#1A1A18`) + oxidized brass (`#8B7355`) — 3 colors only; **Inter Tight + Fraunces (variable, opsz axis) + JetBrains Mono** — free Google Fonts trio (4 webfont files); 9-section homepage composition with editorial chrome wrapping conversion-optimized above-fold; card-flip gallery as signature motion; in-frame portfolio captions (ORTAHAUS treatment) + LEKKER-format bio captions on barber pages; deadpan-humor voice register; cross-property cohesion via logo + voice + hero-video editing only (independent design systems otherwise — barbershop is bone/ink/brass daytime/archive, tattoo is dark/cream/purple basement/altar).

Major architectural decision logged 2026-06-05 (Gallery-as-CMS): /gallery becomes a dynamic barber-portfolio discovery + booking funnel, sourced from GHL Media Storage (assets) + Supabase portfolio_images (tag + analytics joins). Tag vocabulary is Lionel-curated dropdown only — see memory: gallery_as_cms_architecture.md. iOS app gets a barber-side upload flow as a parallel workstream. Section 9 (image inventory) + Q2.X.11 in content-intake.md formally deferred to barber-self-upload via iOS, with seed-set populated by Lionel via temp admin path.

Phase 2 locked (carried forward): 14-page rebuild plan; 11 schema types deployed (vs 1 on current GHL site); hub-spoke architecture with 7 nav-level spokes; homepage title tag = "Studio AZ Barbershop · Highest-Rated in Minneapolis (5★, 528 Reviews)"; 4 craft pillars (fades / men's long hair / scissor work / beard work); voice softened (luxury contextual not primary); Walk-In Availability Checker custom component; English-only + `knowsLanguage` Spanish filter on barber Person schema; AI crawler allowlist (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot); CWV targets LCP <2.0s mobile / TBT <200ms.

**Domain:** minneapolisbarbershop.com (**LIVE on Vercel since 2026-09-15**)
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
Each phase has a `PHASE.md` with deliverable checkboxes AT THE TOP and a `## Verification` checklist + `## End-of-Phase Summary` spec AT THE BOTTOM. Work through deliverables, then run the verification checklist, then write the `phase-{N}-summary.md` file, then request user approval. Don't skip the verification step — it's the quality gate that catches "done but wrong."

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
