# Phase 3 — Design & Build

**Goal:** Build the website using `/frontend-design` skill for UI and Phase 2 SEO blueprint for content structure. Every page is SEO-optimized from the first line of code.

**Inputs:** Phase 2 SEO blueprint (page-blueprint.md, schema-markup.md, etc.)
**Outputs:** Complete Next.js site ready for deployment + post-build SEO audit complete

**Approval required:** Yes — design direction approval before building pages, then page-by-page review, then SEO Fix Passes review.

---

## Process

### Stage A — Design System & First Page (One Session)
1. **Invoke `/frontend-design` skill** with brand identity + SEO requirements + content intake answers
2. **Wait for design output** before writing any code
3. **Implement design system files:** `globals.css` with color tokens, `tailwind.config`, `lib/seo.ts` (centralized metadata for all pages), `lib/config.ts` (NAP, hours, social)
4. **Build root layout:** font loading, navigation, footer, schema.org Organization markup, security headers in `next.config.ts`
5. **Build reusable components:** Button, SectionWrapper, decorative dividers, RevealOnScroll, JsonLd, Breadcrumbs
6. **Build the homepage** following the page blueprint EXACTLY — title tag, H1, H2 sections, internal links, schema, content all per `phase-2/page-blueprint.md`
7. **Stop and review.** Do NOT build other pages until the homepage is approved.

### Stage B — Inner Pages (Multiple Sessions)
- Build pages individually OR in 2-3 page batches per session
- Always reference page-blueprint.md for the EXACT title tag, H1, H2 outline, keywords, word count, authority links
- Always reference schema-markup.md for the EXACT JSON-LD per page
- Always reference internal-linking.md for the EXACT anchor text per page

### Stage C — SEO Fix Passes (4 passes, each in its own session)
After all pages are built, run these 4 hardening passes — each fixes one SEO layer across ALL pages at once for consistency. Each is run in its own Claude conversation to keep context tight.

#### Pass 1 — Title Tags + H1s + Meta Descriptions
- Read `phase-2/page-blueprint.md` for the exact specs
- For each page, verify title tag, H1, and meta description match the blueprint exactly
- Fix any deviations

#### Pass 2 — Internal Links + Authority Links
- Read `phase-2/internal-linking.md` and `phase-2/page-blueprint.md` (authority links per H2 section)
- Anchor text ratios: 50% target keyword anchors, 25% generic, 25% brand
- Add missing internal links contextually (NOT in a generic link block)
- Add authority links (DA 80+ sites) — Wikipedia, government sites, industry associations — natural fits in body content

#### Pass 3 — Content Depth + H2 Restructuring + Keyword Density
- Read `phase-2/page-blueprint.md` for keyword targets and word count targets
- Read `phase-2/content-intake.md` for business owner's actual answers to use as content
- Expand thin pages to hit word count targets
- Restructure H2s if needed (e.g. FAQ pages — questions should be H2s for featured snippet targeting, not category labels)
- Verify primary keyword exact-match appears 2-3x per page

#### Pass 4 — Schema Fixes + Final Verification
- Read `phase-2/schema-markup.md`
- Verify every page has the right JSON-LD types (TattooParlor/HairSalon, Service, Person, FAQPage, HowTo, ImageGallery, BreadcrumbList)
- Add missing fields like `knowsAbout`, `knowsLanguage`, `sameAs` arrays
- Run a 12-point verification on every page (title, H1, meta, canonical, breadcrumb, page schema, authority link, target anchor link, internal links present, word count, primary keyword count, locale section if bilingual)

### Stage D — Post-Audit Fixes
After Pass 4 produces a punch list of remaining issues, fix them in a single batch session.

---

## Tech Stack

- Next.js 15 or 16 (App Router, SSR/SSG, Turbopack)
- TypeScript
- Tailwind CSS 4
- ShadCN UI components (only as needed — don't bring in heavy)
- Vercel deployment
- Cloudflare R2 for media (existing `education-videos` bucket: `pub-cff80c98b5724c89876a2f32058755fe.r2.dev`)
- next/font for Google Fonts (with `display: swap`)
- next/image for portfolio/below-the-fold images (NOT for the hero — see Phase 4 LCP notes)

## Site Location

Code lives at: `[define path in workspace, e.g. /Users/studioaz/Documents/Studio AZ Tattoo App/<site-name>-website/]`

**IMPORTANT:** Add the new directory to the root `.gitignore` allowlist FIRST (before installing deps or running build). Tailwind v4 uses `.gitignore` to find source files — if the dir isn't allowlisted, Tailwind generates ZERO utility classes. See [feedback_gitignore_tailwind.md](../../../../memory/feedback_gitignore_tailwind.md).

## Files to Centralize

- **`src/lib/seo.ts`** — All page metadata (title, description, canonical, OG) defined in one place. Every page imports from here. Ensures cross-page SEO coherence.
- **`src/lib/config.ts`** — NAP, hours, social links, booking URL, branding asset URLs.
- **`src/lib/<entity>.ts`** — Domain data like artists, barbers, staff, services. Drives both UI rendering and JSON-LD schema.

## Hero Video / Image Setup

- Hero video on Cloudflare R2 (separate desktop + mobile MP4 files, plus a poster WebP)
- Hero image is the LCP element — use raw `<img>` tag, NOT `next/image` (Next.js Image proxy adds 700ms+ delay through `/_next/image`)
- Add `<link rel="preload" as="image">` for the hero poster in root layout `<head>`
- Add `fetchPriority="high"`, `loading="eager"`, `decoding="sync"` to the hero img

## Bilingual Content (if applicable)

- Use `lang="es"` attribute on Spanish sections within otherwise-English pages
- Add a "Hablamos Español" / Spanish-language section to every key page (Home, Services, FAQ, Contact)
- Mirror critical content into Spanish — don't just translate buttons
- For full bilingual sites, consider Next.js i18n routing instead

---

## Approval Gates

- After Stage A: design direction + homepage approval
- After Stage B: each page or batch approval
- After Stage C: each fix pass results review
- After Stage D: green-light Phase 4
