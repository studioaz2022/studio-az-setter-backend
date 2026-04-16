# SEO Website Pipeline — Status Tracker

> This file tracks where each Studio AZ website is in the 4-phase SEO pipeline.
> Updated manually as phases are completed and approved.

---

## Pipeline Overview

```
Phase 1: Research        → Keyword map, competitor teardown, content gaps, baseline audit
Phase 2: SEO Architecture → Page blueprints, schema, internal linking, image strategy, technical SEO, GEO, content intake
Phase 3: Design & Build  → /frontend-design → Next.js implementation (using content intake answers)
Phase 4: Deploy & Verify → Launch checklist, Search Console submission, tracking setup
```

Each phase requires approval before moving to the next.

### Content Intake Workflow
Phase 2 produces a `content-intake.md` questionnaire customized to the site. The business owner fills it in with plain-language answers (pricing, policies, bios, parking details, FAQ answers, etc.). Claude then formats those answers into SEO-optimized page content during Phase 3, using the page blueprint and schema markup as formatting guides. This separates "SEO structure" (Claude) from "business knowledge" (owner) and makes the pipeline reusable across sites.

---

## Sites

### tattoo — tattooshopminneapolis.com

| Phase | Status | Deliverables | Approved |
|-------|--------|-------------|----------|
| **Phase 1: Research** | COMPLETE | keyword-map.md, competitor-teardown.md, content-gaps.md, baseline-audit.md, local-falcon-baseline.md | **Yes** (March 23, 2026) |
| **Phase 2: Architecture** | COMPLETE | page-blueprint.md, schema-markup.md, internal-linking.md, image-strategy.md, technical-seo.md, geo-ai-readiness.md, content-intake.md | **Yes** (March 23, 2026) |
| **Phase 3: Design/Build** | COMPLETE | Next.js site at `tattoo-website/` — 10+ pages built, SEO verified (4-pass audit + post-audit fixes), consultation form, financing, language framing audit | **Yes** (April 2026) |
| **Phase 4: Deploy/Verify** | COMPLETE | Deployed to Vercel, DNS cutover via Cloudflare, GA4 live (G-XYEDL03XZR), favicon + manifest, Search Console connected | **Yes** (April 15, 2026) |

**Status:** LIVE at tattooshopminneapolis.com (deployed April 15, 2026)
**Post-launch:** Submit sitemap in Search Console, request indexing for all pages, update GBP website URL, run PageSpeed audit, begin GBP optimization + review generation.

**Domain:** tattooshopminneapolis.com
**GBP Place ID:** ChIJt_vZnAAzs1IR5e7h5BUE0O0
**Stack:** Next.js 15 + TypeScript + Tailwind CSS 4 + ShadCN → Vercel
**Site code location:** `/Users/studioaz/Documents/Studio AZ Tattoo App/tattoo-website/`

---

### barbershop — minneapolisbarbershop.com

| Phase | Status | Deliverables | Approved |
|-------|--------|-------------|----------|
| **Phase 1: Research** | NOT STARTED | keyword-map.md, competitor-teardown.md, content-gaps.md, baseline-audit.md, local-falcon-baseline.md | — |
| **Phase 2: Architecture** | BLOCKED | page-blueprint.md, schema-markup.md, internal-linking.md, image-strategy.md, technical-seo.md, geo-ai-readiness.md | — |
| **Phase 3: Design/Build** | BLOCKED | Next.js site at `barbershop-website/` | — |
| **Phase 4: Deploy/Verify** | BLOCKED | launch-checklist.md | — |

**Current step:** Not started. Begin when tattoo site is live or when prioritized.

**Domain:** minneapolisbarbershop.com
**GBP Place ID:** ChIJ598OaS4zs1IR4YfeL8TGg3g
**Stack:** Next.js 15 + TypeScript + Tailwind CSS 4 + ShadCN → Vercel
**Site code location:** `/Users/studioaz/Documents/Studio AZ Tattoo App/barbershop-website/`

---

## Shared Resources

| Resource | Location | Purpose |
|----------|----------|---------|
| SEO Playbook | `src/seo/websites/SEO_PLAYBOOK.md` | Universal SEO rules (applies to all sites) |
| Phase Templates | `src/seo/websites/_template/` | Blank phase files — copy into new site folder |
| SerpAPI Client | `src/seo/serpApiClient.js` | Automated keyword + competitor research |
| Schema (Tattoo) | `src/seo/schema-tattoo.json` | JSON-LD for tattoo GBP |
| Schema (Barbershop) | `src/seo/schema-barbershop.json` | JSON-LD for barbershop GBP |
| SEO Toolkit Routes | `src/seo/seoRoutes.js` | Backend API endpoints for SEO tools |

---

## How to Start a New Site

1. Copy `_template/` folder into `websites/<site-name>/`
2. Fill out `SITEMAP.md` with business info, pages, and booking flow
3. Add site-specific overrides to `SEO_OVERRIDES.md` (anything that differs from the shared playbook)
4. Work through Phase 1 → 2 → 3 → 4 in order, getting approval at each gate
5. Update this PIPELINE.md as you go
