# V1 Homepage SEO Fix Prompt

Copy everything below the line into a new Claude Code chat.

---

We're fixing SEO issues on the existing tattoo website homepage at `/Users/studioaz/Documents/Studio AZ Tattoo App/tattoo-website/`. This is running on localhost:3001.

**IMPORTANT: Do NOT change any UI, layout, styling, fonts, or visual design. The UI is already finalized. Only fix the SEO structure and content.**

Read all the files mentioned below before making any changes.

## SEO Architecture (read these — they are the source of truth)

- `/Users/studioaz/AZ Setter Cursor/studio-az-setter-backend/src/seo/websites/tattoo/phase-2-seo-architecture/page-blueprint.md` — Section 1 (Home Page): the approved SEO spec with exact H1, H2s, keywords, word count targets, authority links, internal links
- `/Users/studioaz/AZ Setter Cursor/studio-az-setter-backend/src/seo/websites/tattoo/phase-2-seo-architecture/schema-markup.md` — Section 1: JSON-LD spec
- `/Users/studioaz/AZ Setter Cursor/studio-az-setter-backend/src/seo/websites/tattoo/phase-2-seo-architecture/internal-linking.md` — Homepage link map with anchor text
- `/Users/studioaz/AZ Setter Cursor/studio-az-setter-backend/src/seo/websites/tattoo/phase-2-seo-architecture/content-intake.md` — Business owner's real answers for content

## Current Files to Read

- `src/app/page.tsx` — Current homepage
- `src/components/HeroVideo.tsx` — Hero component (contains the H1)
- `src/lib/config.ts` — Site config
- `src/lib/artists.ts` — Artist data

## SEO Fixes to Make

### 1. Fix the H1 (in HeroVideo.tsx)

- Current (WRONG): whatever the H1 currently says — check it
- Correct: **"Minneapolis's Top-Rated Custom Tattoo Shop"**
- The H1 MUST contain "tattoo shop" — it's the #1 keyword per page-blueprint.md
- Only change the H1 text. Do not change any styling, layout, or other elements in HeroVideo.tsx.

### 2. Add the missing "Why Studio AZ" H2 section

The page-blueprint.md specifies this H2: **"Why Studio AZ Is Minneapolis's Top-Rated Tattoo Shop"**

Check the current homepage — there may be an intro section that partially covers this. Either:
- **Option A:** Rename/restructure the existing intro section's H2 heading to match the blueprint text exactly, and add the missing stats (5.0 rating, 100% custom, bilingual, North Loop)
- **Option B:** Add a new section after the hero with this H2

Include an authority link to [Wikipedia — Minneapolis](https://en.wikipedia.org/wiki/Minneapolis) in this section.

Match the existing visual style of surrounding sections. Do NOT introduce new design patterns.

### 3. Add the missing "What Our Clients Say" reviews section

The blueprint requires an H2: **"What Our Clients Say"**

Add a reviews/testimonials section with:
- 2 Google review quotes (write realistic 5-star reviews mentioning the artists by name, the studio vibe, and specific styles)
- Place it after the portfolio section and before the process section (or wherever it fits naturally in the current page flow)
- Match the existing visual style — use the same spacing, typography classes, and component patterns already on the page
- This is a social proof section — keep it clean and impactful

### 4. Increase word count to 1,500–2,000

Current content is approximately 800–900 words. The SEO blueprint requires 1,500–2,000.

Expand existing sections with more descriptive content:
- Add more detail to the "Why Studio AZ" section (consultation process, bilingual advantage, North Loop neighborhood context)
- Expand service descriptions slightly
- Add a brief paragraph to the process section about what makes each step unique at Studio AZ
- The new reviews section adds ~150 words

**Keyword density targets (from page-blueprint.md):**
- "tattoo shop Minneapolis" — exact string 2-3x on the page
- "tattoo studio Minneapolis" — exact string 2-3x
- "Minneapolis tattoo parlor" — exact string 2-3x
- "tattoo shop near me" — exact string 1x
- "best tattoo shop Minneapolis" — exact string 1x

Don't keyword-stuff. Write naturally but make sure these exact phrases appear the required number of times across the full page content.

### 5. Complete authority links

The blueprint calls for 1+ authority link per H2 section to DA/DR 80+ sites.

Check what's currently there, and add any that are missing:
- **Why Studio AZ section:** Wikipedia — Minneapolis
- **Services section:** Minnesota Department of Health (https://www.health.state.mn.us/)
- **Artists section:** Wikipedia — Tattoo (https://en.wikipedia.org/wiki/Tattoo)
- **Spanish section:** Minneapolis Chamber of Commerce (https://www.minneapolischamber.org/)
- **Visit Us section:** Wikipedia — North Loop, Minneapolis (https://en.wikipedia.org/wiki/North_Loop,_Minneapolis)

### 6. Verify internal links match the spec

Check that these internal links exist on the homepage with the correct anchor text (from internal-linking.md):

| Link To | Anchor Text | Type |
|---------|-------------|------|
| /services | "custom tattoo services" | Target |
| /artists | "meet our tattoo artists" | Target |
| /gallery | "view our portfolio" | Generic |
| /aftercare | "tattoo aftercare guide" | Target |
| /faq | "frequently asked questions" | Generic |
| /contact | "Studio AZ Tattoo" | Brand |
| /parking | "parking and directions" | Generic |

If any are missing or have wrong anchor text, fix them. Place them naturally in the content — not in a generic link block.

### 7. Verify schema markup

Compare the homepage's JSON-LD against schema-markup.md Section 1. Make sure:
- TattooParlor entity has correct hours (Tue-Sat 11:00-18:00)
- Organization sameAs includes all social profiles (Instagram, TikTok, Facebook, LinkedIn, Google Maps)
- BreadcrumbList is present
- AggregateRating is commented out (not enough reviews yet)

## DO NOT CHANGE

- Any visual design, styling, colors, fonts, or layout
- Any UI components or their appearance
- The hero video (except the H1 text)
- Navigation or footer
- Any other pages
- robots.ts, sitemap.ts, llms.txt

## After Making Changes

1. List every change you made with file and line references
2. Tell me the approximate word count of the page after changes
3. List every "tattoo shop Minneapolis" occurrence and confirm the count
4. Wait for my feedback
