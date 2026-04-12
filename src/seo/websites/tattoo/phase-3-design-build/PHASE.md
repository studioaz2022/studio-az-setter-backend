# Phase 3 — Design & Build

**Goal:** Build the tattoo shop website using /frontend-design skill for UI and Phase 2 SEO blueprint for content structure. Every page is SEO-optimized from the first line of code.

**Inputs:** Phase 2 SEO blueprint (page-blueprint.md, schema-markup.md, etc.) + content-intake.md answers
**Outputs:** Complete Next.js site ready for deployment

**Approval required:** Yes — design direction approval before building pages, then page-by-page review.

**Status:** COMPLETE — All 10 pages built and SEO-verified. Pending final approval before Phase 4.

---

## Completed Work

### Design System
- [x] Dark theme with deep purple accent + warm cream text
- [x] "Tech meets tattoo" aesthetic — geometric line art, stipple textures, needle-thin dividers
- [x] Typography: DM Sans (body), Instrument Serif (headings), JetBrains Mono (labels)
- [x] Hero video component with R2-hosted desktop/mobile versions + poster frame
- [x] Reusable components: Button, NeedleLine, RevealOnScroll, Breadcrumbs, JsonLd, ArtistCard, FaqAccordion, GalleryGrid

### Pages Built (10/10)
- [x] Home (`/`) — Hero video, 6 H2 sections, ~1,700 words, reviews, Spanish section
- [x] Services (`/services`) — 4 services with pricing, Spanish section
- [x] Artists (`/artists`) — 2-artist index with bios and portfolio previews
- [x] Joan (`/artists/joan`) — Full bio, specialties, portfolio grid
- [x] Andrew (`/artists/andrew`) — Full bio, specialties, portfolio grid
- [x] Gallery (`/gallery`) — Filterable portfolio grid
- [x] Aftercare (`/aftercare`) — Day-by-day healing timeline with HowTo schema
- [x] Parking (`/parking`) — Location details, parking options, skyway directions
- [x] FAQ (`/faq`) — 15+ questions with FAQPage schema, Spanish section
- [x] Contact (`/contact`) — NAP, hours, map buttons, Spanish section
- [x] 404 (`/not-found`) — Custom error page with internal links

### SEO Verification (4-Pass Audit Complete)
- [x] **Pass 1:** Title tags + H1s + meta descriptions — all 10 pages match blueprint
- [x] **Pass 2:** Internal links + authority links — all pages have homepage backlink, authority links per H2
- [x] **Pass 3:** Content depth + H2 restructuring + keyword density — word count targets met
- [x] **Pass 4:** Schema fixes + final verification — all schema correct, FAQ JSX bug fixed

### Technical SEO
- [x] robots.ts — allows all crawlers including AI bots
- [x] sitemap.ts — all 10 pages with priorities
- [x] llms.txt — full business entity data for AI crawlers
- [x] Security headers in next.config.ts
- [x] Canonical URLs on every page
- [x] next/image optimization with priority loading on heroes
- [x] React Server Components by default, "use client" only where needed

### Media Assets on Cloudflare R2
- [x] Hero desktop video (1080p, 4.7MB): `tattoo-website/hero-desktop.mp4`
- [x] Hero mobile video (480p, 1.0MB): `tattoo-website/hero-mobile.mp4`
- [x] Hero poster frame (58KB): `tattoo-website/hero-poster.webp`

---

## Remaining Before Phase 4

- [ ] Final visual QA on mobile (375px, 390px, 428px breakpoints)
- [ ] Lighthouse audit (target 95+ mobile/desktop)
- [ ] Owner final review and approval
- [ ] Consultation widget integration (GHL embed on artist pages)

## Tech Stack

- Next.js 15+ (App Router, SSR/SSG)
- TypeScript
- Tailwind CSS 4
- Vercel deployment target
- Cloudflare R2 for media (existing CDN bucket)

## Site Location

Code lives at: `/Users/studioaz/Documents/Studio AZ Tattoo App/tattoo-website/`
