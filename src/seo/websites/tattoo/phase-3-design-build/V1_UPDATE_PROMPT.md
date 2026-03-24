# V1 Homepage Update Prompt

Copy everything below the line into a new Claude Code chat.

---

We're updating the existing tattoo website homepage at `/Users/studioaz/Documents/Studio AZ Tattoo App/tattoo-website/`. This is running on localhost:3001. Do NOT touch the v2 site at `tattoo-website-v2/`.

Read all the files mentioned below before making any changes.

## SEO Architecture (read these for context)

- `/Users/studioaz/AZ Setter Cursor/studio-az-setter-backend/src/seo/websites/tattoo/phase-2-seo-architecture/page-blueprint.md` — Section 1 (Home Page): the approved SEO spec
- `/Users/studioaz/AZ Setter Cursor/studio-az-setter-backend/src/seo/websites/tattoo/phase-2-seo-architecture/schema-markup.md` — Section 1: JSON-LD
- `/Users/studioaz/AZ Setter Cursor/studio-az-setter-backend/src/seo/websites/tattoo/phase-2-seo-architecture/internal-linking.md` — Homepage links
- `/Users/studioaz/AZ Setter Cursor/studio-az-setter-backend/src/seo/websites/tattoo/phase-2-seo-architecture/content-intake.md` — Business answers

## Current v1 Files to Read

Read these files to understand the current state:
- `src/app/page.tsx` — Current homepage
- `src/app/globals.css` — Current design system
- `src/app/layout.tsx` — Current root layout
- `src/components/HeroVideo.tsx` — Hero component
- `src/components/Navigation.tsx` — Nav
- `src/components/Footer.tsx` — Footer
- `src/components/NeedleLine.tsx` — Decorative element
- `src/components/RevealOnScroll.tsx` — Scroll animations
- `src/components/Button.tsx` — Buttons
- `src/lib/config.ts` — Site config
- `src/lib/artists.ts` — Artist data

## V2 Files to Read (for sections we're pulling from)

Read these files from the v2 build to understand the sections we want to bring over:
- `/Users/studioaz/Documents/Studio AZ Tattoo App/tattoo-website-v2/src/app/page.tsx` — V2 homepage (we need specific sections from here)
- `/Users/studioaz/Documents/Studio AZ Tattoo App/tattoo-website-v2/src/app/globals.css` — V2 design system (for font references)
- `/Users/studioaz/Documents/Studio AZ Tattoo App/tattoo-website-v2/src/app/layout.tsx` — V2 layout (for font setup)
- `/Users/studioaz/Documents/Studio AZ Tattoo App/tattoo-website-v2/src/components/Footer.tsx` — V2 footer
- `/Users/studioaz/Documents/Studio AZ Tattoo App/tattoo-website-v2/src/lib/seo.ts` — V2 seo config (if it exists)

## Changes to Make

### 1. SECTION CHANGES ON HOMEPAGE (src/app/page.tsx)

**KEEP as-is (do NOT change these v1 sections):**
- Hero section
- "Not Your Average Tattoo Shop" intro section
- Services Preview section
- Artists Preview section
- Portfolio Teaser section
- Process "From Idea to Ink in 4 Steps" section
- "The Studio — Our North Loop Minneapolis Studio" section (the 3 studio photos)

**REPLACE the Spanish section:**
- Keep the v1 UI structure/layout (the `bg-bg-elevated border-l-4 border-purple-primary rounded-r-xl` card style)
- But replace the copy with the v2 Spanish copy. The v2 version has a 2-column grid layout with "Nicaragua · México" label, and better copy: "Nuestros artistas, Joan Martínez y Andrew Fernández, hablan español como idioma principal..." and the second paragraph about "diseños 100% personalizados" with the Minneapolis Chamber of Commerce authority link. Use this copy inside the v1 card layout.

**REPLACE "Visit Us in the North Loop" section:**
- Use the v2 version of this section (the grid with address, hours, contact, map buttons, parking link, and the building entry description)
- But REMOVE the two photos from the v2 version (storefront and front desk images) — those photos already appear in "The Studio" section above, so showing them again is redundant
- Keep the v2's clean info-only layout for this section (address block, hours grid, phone/email, Google Maps + Apple Maps buttons, parking link, entry directions text)

**REPLACE the Final CTA section:**
- Use the v2 version: "Ready to start your next piece?" with the `btn-primary` "Book a Consultation" and `btn-secondary` "View Our Portfolio" buttons
- But ADD this text between the heading and the buttons: "Deposits start at $50 and are fully refundable. Every consultation is free with your deposit. No pressure, no commitment until you're ready."

### 2. SEO FIXES ON HOMEPAGE

These are critical fixes. Read `page-blueprint.md` Section 1 carefully.

**Fix the H1:**
- Current (WRONG): "Custom Tattoos in Minneapolis" (in HeroVideo.tsx)
- Correct: "Minneapolis's Top-Rated Custom Tattoo Shop"
- The H1 must contain "tattoo shop" — it's the #1 keyword

**Add the missing "Why Studio AZ" H2 section:**
- The page-blueprint.md specifies this as the first H2 after the hero: "Why Studio AZ Is Minneapolis's Top-Rated Tattoo Shop"
- This section should cover: 5.0 Google rating, 100% custom work, bilingual artists, North Loop location
- Include authority link to Wikipedia (Minneapolis)
- The current "Not Your Average Tattoo Shop" section partially covers this, but it's missing the H2 tag with the keyword and missing specific stats
- Either rename/restructure the existing intro section to match the blueprint, OR add a new section between the hero and the current intro. The H2 heading text must be exactly: "Why Studio AZ Is Minneapolis's Top-Rated Tattoo Shop"

**Add the missing "What Our Clients Say" reviews section:**
- The v2 has this section already (Section 5 in v2's page.tsx) — port it to v1
- Use the v2's content (the two blockquote reviews with the decorative quote marks and star dots)
- Style it to match v1's design system (v1 color tokens, v1 fonts)
- Place it after the Portfolio Teaser section and before the Process section
- This section targets the "What Our Clients Say" H2 from the blueprint

**Increase word count to 1,500-2,000 words:**
- Current content is ~800-900 words. The SEO blueprint requires 1,500-2,000.
- Add more descriptive content to existing sections to hit the target:
  - Expand the "Why Studio AZ" section with more about the consultation process, the bilingual advantage, the North Loop neighborhood
  - Add more detail to the services preview descriptions
  - Add a brief paragraph to the Process section about what makes each step unique
  - The reviews section itself adds ~150 words
  - The Spanish section copy swap adds more words
- Primary keyword "tattoo shop Minneapolis" should appear as an exact string 2-3x total on the page
- Don't artificially stuff — write naturally but ensure the density targets from page-blueprint.md are met

**Complete the authority links:**
- The blueprint calls for 1+ authority link per H2 to DA/DR 80+ sites
- Current: has Wikipedia (Minneapolis, North Loop, Tattoo) — good
- Missing: Minnesota Department of Health (should be in Services section), Minneapolis Chamber of Commerce (should be in Spanish section)
- Add these where the blueprint specifies

### 3. FOOTER FONT UPDATE

- Keep the v1 footer STRUCTURE and LAYOUT (4-column grid with Logo/NAP, Navigation, Hours, CTA/Social)
- But switch the fonts to match v2's typeface system:
  - V2 uses: **Geist Sans** (body), **Geist Mono** (mono/labels), **DM Serif Display** (serif headings)
  - V1 currently uses: DM Sans, JetBrains Mono, Instrument Serif
- This means updating `src/app/layout.tsx` to load the v2 fonts (Geist Sans, Geist Mono, DM Serif Display) instead of the v1 fonts
- Update `src/app/globals.css` font variable references to match
- This font change will affect the ENTIRE site (not just footer), which is fine — it's a global typography upgrade

### 4. DO NOT CHANGE

- Any other pages (services, artists, gallery, etc.)
- The hero video component (except fixing the H1 text)
- Navigation component
- NeedleLine, RevealOnScroll, Button components (unless font changes require minor class updates)
- Schema markup structure (though make sure it's complete per schema-markup.md)
- robots.ts, sitemap.ts, llms.txt

## After Making Changes

1. Make sure the dev server is running on port 3001
2. Tell me to check localhost:3001 and describe what changed
3. Wait for my feedback before making any further changes
