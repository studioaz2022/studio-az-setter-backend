# SEO Fix Passes — 9 Inner Pages

**STATUS: ALL 4 PASSES COMPLETE + 6 REMAINING ISSUES FIXED (April 10, 2026)**

4 passes, each run in a separate chat. Each fixes one SEO layer across ALL pages at once for consistency.

### Completion Summary
- **Pass 1** (Title Tags + H1s + Meta Descriptions): DONE
- **Pass 2** (Internal Links + Authority Links): DONE
- **Pass 3** (Content Depth + H2 Restructuring + Keywords): DONE
- **Pass 4** (Schema Fixes + Final Verification): DONE
- **Post-audit fixes** (6 remaining issues): DONE
  1. Home title tag → fixed to blueprint spec
  2. Home meta description → fixed to blueprint spec (152 chars)
  3. FAQ schema JSX bug → plain-text schemaAnswers lookup map
  4. Services keyword density → "custom tattoo Minneapolis" added 2x
  5. Aftercare disallowed /artists link → changed to /contact brand anchor
  6. Artist meta descriptions → trimmed to ~130 chars

---

## Pass 1 — Title Tags + H1s + Meta Descriptions

Copy everything below into a new Claude Code chat.

```
We're fixing title tags, H1s, and meta descriptions across 9 pages of the tattoo website at `/Users/studioaz/Documents/Studio AZ Tattoo App/tattoo-website/`.

**IMPORTANT: Do NOT change any UI, layout, styling, or visual design. Only change title tags, H1 text, and meta descriptions.**

Read the SEO spec first:
- `/Users/studioaz/AZ Setter Cursor/studio-az-setter-backend/src/seo/websites/tattoo/phase-2-seo-architecture/page-blueprint.md` — Contains the EXACT title tag, H1, and meta description for every page

Then read each page file and make these exact changes:

### Services (`src/app/services/page.tsx`)
- Title: Change `"Tattoo Services & Pricing"` → `"Custom Tattoo Services Minneapolis | Free Consultation"`
- H1: Already correct (`Custom Tattoo Services in Minneapolis`) — no change
- Meta description: Change to `"100% custom tattoo designs — no flash, no templates. Fine line, realism, black & grey, cover-ups. Free consultation with bilingual artists in North Loop."`

### Artists (`src/app/artists/page.tsx`)
- Title: Change `"Meet Our Tattoo Artists"` → `"Tattoo Artists Minneapolis | Joan Martinez & Andrew Fernandez"`
- H1: Change `"Minneapolis Tattoo Artists"` → `"Meet Our Minneapolis Tattoo Artists"`
- Meta description: Change to `"Meet Studio AZ's tattoo artists. Joan Martinez and Andrew Fernandez — bilingual artists specializing in realism, fine line, black & grey, and custom tattoos."`

### Joan (`src/app/artists/[slug]/page.tsx`)
This is a dynamic route. The title and description come from `generateMetadata()`.
- Title template: Change from `"${artist.name} — Tattoo Artist"` → `"${artist.name} — Tattoo Artist Minneapolis | Studio AZ"`
- H1: Change from just `{artist.name}` → `{artist.name} — Tattoo Artist at Studio AZ Minneapolis`
- Meta description template: Update to include "Minneapolis" and "Studio AZ" and all styles

### Gallery (`src/app/gallery/page.tsx`)
- Title: Change `"Tattoo Gallery"` → `"Minneapolis Tattoo Portfolio | Studio AZ Custom Designs"`
- H1: Change `"Tattoo Gallery"` → `"Custom Tattoo Portfolio — Studio AZ Minneapolis"`
- Meta description: Change to `"Browse Studio AZ's custom tattoo portfolio — fine line, realism, black & grey, small tattoos. Every piece is 100% original. Find your inspiration here."`

### Aftercare (`src/app/aftercare/page.tsx`)
- Title: Change `"Tattoo Aftercare Guide"` → `"Tattoo Aftercare Guide | Healing Tips from Studio AZ"`
- H1: Change `"Tattoo Aftercare Guide"` → `"How to Care for Your New Tattoo — Aftercare Guide"`
- Meta description: Change to `"Complete tattoo aftercare guide: day-by-day healing timeline, what to avoid, signs of infection, and long-term care tips. From Studio AZ Tattoo Minneapolis."`

### Parking (`src/app/parking/page.tsx`)
- Title: Change `"Parking & Directions"` → `"Parking & Directions | Studio AZ Tattoo — North Loop"`
- H1: Change `"Parking & Directions"` → `"Tattoo Shop in North Loop Minneapolis — Parking & Directions"`
- Meta description: Already good — no change needed

### FAQ (`src/app/faq/page.tsx`)
- Title: Change `"Frequently Asked Questions"` → `"Tattoo FAQ Minneapolis | Pricing, Pain, Prep & More"`
- H1: Change `"Frequently Asked Questions"` → `"Tattoo FAQ — Minneapolis Pricing, Pain, Prep & More"`
- Meta description: Change to `"Get answers about tattoo cost in Minneapolis, pain levels, what to wear, how to prepare, deposits, and booking policy. Studio AZ Tattoo — North Loop."`

### Contact (`src/app/contact/page.tsx`)
- Title: Change `"Contact Us"` → `"Contact Studio AZ Tattoo | Minneapolis, MN"`
- H1: Change `"Contact Studio AZ Tattoo"` → `"Get in Touch with Studio AZ Tattoo"`
- Meta description: Change to `"Contact Studio AZ Tattoo — 333 Washington Ave N, North Loop, Minneapolis. Call (612) 255-4439 or book a consultation online. Tue-Sat 11am-6pm."`

After making all changes, list every file modified and the before/after for each title, H1, and meta description so I can verify.
```

---

## Pass 2 — Internal Links + Authority Links

```
We're adding missing internal links and authority links across 9 pages of the tattoo website at `/Users/studioaz/Documents/Studio AZ Tattoo App/tattoo-website/`.

**IMPORTANT: Do NOT change any UI, layout, or styling. Only add links within existing text content, or add short natural sentences containing the links where needed. Preserve all existing content and structure.**

Read these specs first:
- `/Users/studioaz/AZ Setter Cursor/studio-az-setter-backend/src/seo/websites/tattoo/phase-2-seo-architecture/internal-linking.md` — Exact link map per page with anchor text
- `/Users/studioaz/AZ Setter Cursor/studio-az-setter-backend/src/seo/websites/tattoo/phase-2-seo-architecture/page-blueprint.md` — Authority links per H2 section

Then read each page and add the missing links.

### INTERNAL LINKS — What's Missing Per Page

**Anchor text rules:** 50% target anchor (keyword-rich), 25% generic, 25% brand. Place links in contextual sentences — never in a generic link block.

**Services** (`src/app/services/page.tsx`):
- MISSING: Link to `/` with anchor "tattoo shop Minneapolis" (target) — add in intro text
- MISSING: Link to `/gallery` with anchor "see our work" or "view our portfolio" (generic)
- MISSING: Link to `/contact` with anchor "get in touch" (generic)
- MISSING: Link to `/aftercare` with anchor "tattoo aftercare guide" (target) — natural fit in the touch-ups section
- HAS: /artists, /faq — keep these

**Artists index** (`src/app/artists/page.tsx`):
- MISSING: Link to `/` with anchor "tattoo shop Minneapolis" (target)
- MISSING: Link to `/services` with anchor "our tattoo services" or "custom tattoo services" (target)
- MISSING: Link to `/gallery` with anchor "full portfolio" (generic)
- HAS: /artists/joan, /artists/andrew — keep these

**Joan** (`src/app/artists/[slug]/page.tsx`):
- MISSING: Link to `/` with anchor "tattoo shop Minneapolis" (target)
- MISSING: Link to `/gallery` with anchor "full studio portfolio" (generic)
- MISSING: Link to `/services` with anchor "custom tattoo services" (target)
- MISSING: Link to `/contact` with anchor "Studio AZ Tattoo" (brand)
- HAS: /artists (back), other artist — keep these

**Gallery** (`src/app/gallery/page.tsx`):
- MISSING: Link to `/` with anchor "tattoo shop Minneapolis" (target)
- MISSING: Link to `/artists` with anchor "our tattoo artists" (target)
- MISSING: Link to `/services` with anchor "our services" (generic)
- HAS: /artists/joan, /artists/andrew — keep these

**Aftercare** (`src/app/aftercare/page.tsx`):
- MISSING: Link to `/` with anchor "tattoo shop Minneapolis" (target)
- MISSING: Link to `/services` with anchor "tattoo touch-up service" (target)
- MISSING: Link to `/artists` with anchor "our artists" (generic)
- HAS: /faq, /contact — keep these

**Parking** (`src/app/parking/page.tsx`):
- MISSING: Link to `/` with anchor "tattoo shop Minneapolis" (target)
- MISSING: Link to `/contact` with anchor "contact us" (generic)
- MISSING: Link to `/artists` with anchor "book with our artists" (generic)
- Has NO contextual body links currently — all links are just nav buttons

**FAQ** (`src/app/faq/page.tsx`):
- MISSING: Link to `/` with anchor "tattoo shop Minneapolis" (target)
- MISSING: Link to `/services` with anchor "our tattoo services" (target) — fit in pricing answer
- MISSING: Link to `/services` with anchor "cover-up tattoos" (target) — fit in cover-up answer
- MISSING: Link to `/artists` with anchor "our tattoo artists" (target)
- MISSING: Link to `/artists/joan` with anchor "Joan Martinez" (brand)
- MISSING: Link to `/artists/andrew` with anchor "Andrew Fernandez" (brand)
- MISSING: Link to `/aftercare` with anchor "aftercare guide" (generic) — fit in aftercare answer
- MISSING: Link to `/parking` with anchor "parking and directions" (generic) — fit in location answer
- MISSING: Link to `/gallery` with anchor "explore our portfolio" (generic)
- HAS: /contact — keep this

**Contact** (`src/app/contact/page.tsx`):
- MISSING: Link to `/` with anchor "tattoo shop Minneapolis" (target)
- MISSING: Link to `/artists` with anchor "choose your artist" (generic)
- HAS: /parking, /faq, /services — keep these

### AUTHORITY LINKS — What's Missing Per Page

Add these as natural links in existing content or in short additional sentences. Format: linked text → URL. All should be `target="_blank" rel="noopener noreferrer"`.

**Services**: Add MN Dept of Health (https://www.health.state.mn.us/) — mention licensing in the intro or consultation section. Add Wikipedia Tattoo (https://en.wikipedia.org/wiki/Tattoo) somewhere natural.

**Artists index**: Add Wikipedia Tattoo artist (https://en.wikipedia.org/wiki/Tattoo_artist) and Wikipedia Minneapolis (https://en.wikipedia.org/wiki/Minneapolis).

**Joan**: Add Wikipedia Tattoo (https://en.wikipedia.org/wiki/Tattoo), AAD.org (https://www.aad.org/public/everyday-care/skin-care-secrets/tattoos), MN Dept of Health (https://www.health.state.mn.us/).

**Andrew**: Same as Joan.

**Gallery**: Add Wikipedia Tattoo (https://en.wikipedia.org/wiki/Tattoo).

**Aftercare**: Already has AAD.org. Add Wikipedia Tattoo (https://en.wikipedia.org/wiki/Tattoo) in the "What to Avoid" section. Add MN Dept of Health in the long-term care section.

**Parking**: Add Wikipedia Warehouse District (https://en.wikipedia.org/wiki/Warehouse_District,_Minneapolis). Add Minneapolis Chamber of Commerce (https://www.minneapolischamber.org/).

**FAQ**: Add Wikipedia Tattoo (https://en.wikipedia.org/wiki/Tattoo) in the cover-up or styles answer. Add AAD.org in the pain or aftercare answer. Add MN Dept of Health in the age requirement answer. Add Minneapolis Chamber of Commerce in the Spanish answer. Add Wikipedia North Loop (https://en.wikipedia.org/wiki/North_Loop,_Minneapolis) in the location answer.

**Contact**: Add Wikipedia North Loop (https://en.wikipedia.org/wiki/North_Loop,_Minneapolis). Add Minneapolis Chamber of Commerce (https://www.minneapolischamber.org/).

After making changes, list:
1. Every internal link added (page, anchor text, target URL)
2. Every authority link added (page, linked text, URL)
```

---

## Pass 3 — Content Depth + H2 Restructuring + Keywords

```
We're expanding content and fixing H2 structure on pages that are thin or structurally misaligned with the SEO blueprint. The tattoo website is at `/Users/studioaz/Documents/Studio AZ Tattoo App/tattoo-website/`.

**IMPORTANT: Do NOT change any UI, layout, or styling. Add content within existing section structures. Match the existing typography classes and patterns. Only change H2/H3 heading text and add body copy.**

Read the spec first:
- `/Users/studioaz/AZ Setter Cursor/studio-az-setter-backend/src/seo/websites/tattoo/phase-2-seo-architecture/page-blueprint.md` — H2/H3 outlines, keyword targets, word count targets
- `/Users/studioaz/AZ Setter Cursor/studio-az-setter-backend/src/seo/websites/tattoo/phase-2-seo-architecture/content-intake.md` — Business owner's real answers for content

### Page 1: Artists Index (`src/app/artists/page.tsx`)
**Current: ~200 words. Target: 500-700 words.**

Add:
- More descriptive intro paragraph about the two-artist studio concept
- Under each artist card, expand the bio text (use content-intake.md Q2.7 for Joan, Q2.16 for Andrew)
- Add an "H2: Not Sure Which Artist? We'll Help You Decide" section with a brief paragraph and CTA to submit a general inquiry
- Keyword: "tattoo artist Minneapolis" exact string 2-3x

### Page 2: Joan (`src/app/artists/[slug]/page.tsx`)
**Current: ~150 words text. Target: 400-500 words.**

The dynamic route generates both Joan and Andrew pages. Add more content in the template:
- Add an "About" section (H2) before the portfolio with 2-3 paragraphs covering background, training/self-taught, origin story, philosophy (from content-intake.md)
- Add a "Specialties" section (H2) with H3s for: Realism & Portraits, Fine Line, Black and Grey, Custom Designs — brief paragraph per H3
- Keywords for Joan: "Joan Martinez tattoo artist" 2-3x, "fine line tattoo Minneapolis" 2-3x, "realism tattoo Minneapolis" 2-3x, "black and grey tattoo Minneapolis" 1x
- Keywords for Andrew: "Andrew Fernandez tattoo artist" 2-3x, "realism tattoo Minneapolis" 2-3x, "custom tattoo Minneapolis" 2-3x, "fine line tattoo Minneapolis" 1x, "black and grey tattoo Minneapolis" 1x

Note: Since this is a dynamic template, the content needs to come from the artist data in `src/lib/artists.ts`. Add fields to the artist data model for: extended bio paragraphs, specialties descriptions. Then render them in the template.

### Page 3: Gallery (`src/app/gallery/page.tsx`)
**Current: ~50 words. Target: 200-300 words.**

Add:
- A paragraph after the H1 reinforcing "custom tattoo designs Minneapolis" and "100% original"
- Add H2: "Browse Our Work" above the gallery grid
- Add H2: "Every Design Is One of a Kind" below the gallery with a brief reinforcement paragraph
- Keyword: "Minneapolis tattoo portfolio" 2-3x, "tattoo ideas Minneapolis" 1x, "custom tattoo designs Minneapolis" 1x

### Page 4: Parking (`src/app/parking/page.tsx`)
**Primary keyword "tattoo shop North Loop Minneapolis" currently appears 0 times. Needs 2-3x.**

Add the exact phrase "tattoo shop North Loop Minneapolis" naturally into:
- The intro paragraph
- The North Loop neighborhood section
- Near the CTA

Also add "tattoo near downtown Minneapolis" 2-3x and "tattoo shop warehouse district" 1x.

### Page 5: FAQ (`src/app/faq/page.tsx`)
**STRUCTURAL FIX: H2s should be individual questions, not category labels.**

Currently the H2s are "Pricing & Deposits", "Booking & Process", etc. (category labels in mono text). The blueprint says each QUESTION should be an H2 for featured snippet targeting.

Options:
- **Option A (preferred):** Change the category labels from H2 to a styled `<p>` or `<h3>`, and change each question inside the accordion to render as an `<h2>` tag. This way Google sees the questions as H2s.
- **Option B:** Keep the accordion UI but ensure the question text renders as `<h2>` elements within the accordion trigger.

The FAQPage schema already has all Q&A pairs correctly structured — this is just about the HTML heading hierarchy.

Also add keywords:
- "tattoo FAQ Minneapolis" 2-3x
- "how much does a tattoo cost Minneapolis" 2-3x (already in a question, but make sure the exact phrase appears)

After making changes, report:
1. Word count per page (before → after)
2. H2 changes per page
3. Keyword counts for primary keywords per page
```

---

## Pass 4 — Schema Fixes + Final Verification

```
Final SEO verification pass on the tattoo website at `/Users/studioaz/Documents/Studio AZ Tattoo App/tattoo-website/`.

Read the schema spec:
- `/Users/studioaz/AZ Setter Cursor/studio-az-setter-backend/src/seo/websites/tattoo/phase-2-seo-architecture/schema-markup.md`

### Schema Fixes

**Joan & Andrew pages** (`src/app/artists/[slug]/page.tsx`):
- Add `knowsAbout` to the Person schema:
```json
"knowsAbout": ["Realism Tattoos", "Fine Line Tattoos", "Black and Grey Tattoos", "Custom Tattoos"]
```

**Gallery page** (`src/app/gallery/page.tsx`):
- Add `ImageObject` entries to the ImageGallery schema with `contentUrl`, `description`, `creator` for each image (or at least a template showing the pattern)

**Contact page** (`src/app/contact/page.tsx`):
- Verify `sameAs` array includes: Instagram, TikTok, Facebook, LinkedIn, Google Maps
- If missing any, add them

### Full Verification Checklist

After schema fixes, run through every page and verify:

For EACH of the 10 pages (including homepage):
1. ✅ Title tag matches page-blueprint.md exactly
2. ✅ H1 matches page-blueprint.md exactly
3. ✅ Meta description present and under 155 chars
4. ✅ Canonical URL set via `alternates.canonical`
5. ✅ BreadcrumbList schema present
6. ✅ Page-specific schema present (Service, Person, FAQPage, etc.)
7. ✅ At least 1 authority link (DA 80+) per major H2 section
8. ✅ Link back to homepage with "tattoo shop Minneapolis" target anchor
9. ✅ All internal links from internal-linking.md are present
10. ✅ Word count meets target from page-blueprint.md
11. ✅ Primary keyword appears exact-match 2-3x
12. ✅ Spanish section present (Home, Services, FAQ, Contact)

Output: A table with all 10 pages × 12 checks showing pass/fail. List any remaining issues.
```
