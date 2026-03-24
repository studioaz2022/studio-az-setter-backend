# Session 1 Prompt — Design System + Homepage

Copy everything below the line into a new Claude Code chat.

---

## Context

We're building the website for Studio AZ Tattoo (tattooshopminneapolis.com). An initial attempt built all 10 pages at once and the result was generic and rushed. We're starting over with a **page-by-page approach** where each session focuses on 1-2 pages with full design craft.

**This is Session 1 of 6.** This session builds ONLY:
1. The design system (colors, typography, components, layout patterns)
2. The root layout (nav, footer)
3. The homepage

Nothing else. Do not build any other pages in this session.

**There is already a Next.js project at `/Users/studioaz/Documents/Studio AZ Tattoo App/tattoo-website/` with a bad initial build. We are gutting the visual design and rebuilding from scratch, but you can keep the technical foundation (next.config.ts, robots.ts, sitemap.ts, package.json) if it's solid. Read the existing code first to understand what's there before deciding what to keep vs replace.**

## SEO Architecture Files (READ ALL OF THESE FIRST)

These files at `/Users/studioaz/AZ Setter Cursor/studio-az-setter-backend/src/seo/websites/` contain the approved SEO specs. Every design and content decision must align with these:

**Must read:**
- `tattoo/phase-2-seo-architecture/page-blueprint.md` — Section 1 (Home Page): title tag, H1, H2/H3 outline, keywords, CTAs, word count (1500-2000), authority links, content hook. Also read the "Domain Advantage Reminder" and "Anchor Text Ratio" sections at the top.
- `tattoo/phase-2-seo-architecture/schema-markup.md` — Section 1 (Home): TattooParlor + Organization + BreadcrumbList JSON-LD
- `tattoo/phase-2-seo-architecture/internal-linking.md` — Homepage link map (which pages it links to, anchor text, types)
- `tattoo/phase-2-seo-architecture/technical-seo.md` — robots.ts, sitemap.ts, metadata strategy, llms.txt, Core Web Vitals targets, security headers, 404 page
- `tattoo/phase-2-seo-architecture/image-strategy.md` — File naming, alt text patterns, loading strategy
- `tattoo/phase-2-seo-architecture/content-intake.md` — Business owner's answers: pricing, policies, artist bios, process, parking, FAQ answers, image URLs with SEO filenames
- `tattoo/phase-3-design-build/DESIGN_BRIEF.md` — Full creative direction

**Reference (don't need to read fully, but available):**
- `SEO_PLAYBOOK.md` — Universal SEO rules
- `tattoo/SEO_OVERRIDES.md` — NAP, hours, socials, domain advantage
- `tattoo/SITEMAP.md` — All 10 pages, site architecture diagram, booking flow

## Design Direction

**Core concept:** "Tech meets tattoo" — clean geometric tech-company web design colliding with tattoo culture elements.

**Palette:**
- Dark base (near-black backgrounds)
- Deep/dark purple accent (plum range, not vibrant/electric)
- Secondary: explore warm cream vs cool teal — pick what works best, or use both in different contexts
- High-contrast text on dark backgrounds

**Typography:**
- Brand logo uses Helvetica Light — don't clash with it
- Clean geometric sans-serif for body/UI
- No blackletter or tattoo-style display fonts
- Consider a subtle serif for headings to add warmth

**Tattoo DNA (inject through visual design, NOT typography):**
- Geometric line art (thin, precise, flash-sheet-inspired but rendered geometrically)
- Stipple/dot shading (halftone-style overlays)
- Needle-thin 1px rule lines as section dividers
- Ink-on-skin grain texture (very subtle)
- Flash sheet layout moments in portfolio sections

**Layout:**
- Tech-company grid with generous whitespace
- Organic breaks where portfolio images bleed or overlap the grid
- Mobile-first (48px touch targets, 16px body text min)

**Brand personality:**
- "You want a tattoo shop that doesn't feel like you just walked into the back room of a biker bar?"
- Calm, modern, clean, communal
- Approachable but premium
- Copy can have personality and edge

## Hero Video Assets (on Cloudflare R2)

- Desktop (1080p, 4.7MB): `https://pub-cff80c98b5724c89876a2f32058755fe.r2.dev/tattoo-website/hero-desktop.mp4`
- Mobile (480p, 1.0MB): `https://pub-cff80c98b5724c89876a2f32058755fe.r2.dev/tattoo-website/hero-mobile.mp4`
- Poster (58KB): `https://pub-cff80c98b5724c89876a2f32058755fe.r2.dev/tattoo-website/hero-poster.webp`
- Muted autoplay loop. Poster loads first. Serve desktop/mobile by viewport width.

## Brand Assets

- White logo: `https://assets.cdn.filesafe.space/GLRkNAxfPtWTqTiN83xj/media/69a5f238618c8d1afd552d67.png`
- Black logo: `https://assets.cdn.filesafe.space/GLRkNAxfPtWTqTiN83xj/media/69a5f238320ef4ff2cd71f70.png`

## Available Image Assets (from content intake, Section 10)

**Studio Photos:**
- Interior workstation: `https://assets.cdn.filesafe.space/mUemx2jG4wly4kJWBkI4/media/96def9f4-6485-4816-93bf-4c69b4087e26.webp`
- Front desk: `https://assets.cdn.filesafe.space/mUemx2jG4wly4kJWBkI4/media/fceb8008-743d-474f-94f5-c3bd4fcef266.webp`
- Storefront exterior: `https://assets.cdn.filesafe.space/mUemx2jG4wly4kJWBkI4/media/1338c00d-8c46-4923-ace8-83ccc24d5d0c.webp`

**Joan's Portfolio (for homepage preview):**
- `https://assets.cdn.filesafe.space/mUemx2jG4wly4kJWBkI4/media/82f297a1-0fe7-41fb-a444-057bb6352841.webp` — fine line amor floral forearm
- `https://assets.cdn.filesafe.space/mUemx2jG4wly4kJWBkI4/media/a5cde104-7583-4c3e-8c1d-a5e814681ea5.webp` — realism chicana portrait
- `https://assets.cdn.filesafe.space/mUemx2jG4wly4kJWBkI4/media/f89bf82e-dc00-4e66-9add-4140679c676a.webp` — black and grey polynesian half sleeve
- `https://assets.cdn.filesafe.space/mUemx2jG4wly4kJWBkI4/media/99d3ecb7-bef0-4c42-b8cf-307fd3382798.webp` — realism religious lion cross half sleeve

**Andrew's Portfolio (for homepage preview):**
- `https://assets.cdn.filesafe.space/mUemx2jG4wly4kJWBkI4/media/59db435b-bc97-4579-bf6f-e54ed6249e45.webp` — realism jesus christ forearm
- `https://assets.cdn.filesafe.space/mUemx2jG4wly4kJWBkI4/media/03c0ce8f-cf22-4073-b93a-6ea6966b6b4d.webp` — realism tiger mountain crow sleeve
- `https://assets.cdn.filesafe.space/mUemx2jG4wly4kJWBkI4/media/948755ca-fe07-4f48-99b9-8cbb4a96458e.webp` — realism angel dove sleeve

## Key Business Facts

- **Name:** Studio AZ Tattoo
- **Address:** 333 Washington Ave N, STE 100, Minneapolis, MN 55401
- **Phone:** +1 (612) 255-4439
- **Email:** support@studioaz.us
- **Hours:** Tue-Sat 11am-6pm, Mon & Sun Closed
- **Instagram:** @studioaz.us
- **TikTok:** @studio.az.tattoo
- **Facebook:** https://www.facebook.com/studioaz.us/
- **No walk-ins** — appointment only, 100% custom work
- **Deposits:** $50 small/fine line, $100 medium-large (fully refundable, applied to cost)
- **Pricing:** Fine line from $100, small from $200, medium $400-$800, charged by project
- **Payment:** Zelle, Cash, Venmo preferred. Credit accepted. Payment plans available.
- **Founded:** 2025 (tattoo) / 2022 (barbershop) by Lionel Chavez
- **Location:** North Loop, Minneapolis — inside Union Plaza Building, basement level
- **Artists:** Joan Martinez (5yr, self-taught, Nicaragua, @joan_martinez_tattoo) and Andrew Fernandez (4yr, convention circuit, Tlaxcala Mexico, @andrefernan_tattoo)
- **Both artists** do the same styles: realism, fine line, black & grey, custom. Differentiation is personal story, not style.
- **Both speak Spanish** primarily. Shop offers translators for consultations.
- **Vibe:** Calm, modern, clean, communal. Barbershop above has 10 barbers creating energy.
- **Google:** 5.0 rating, 9 reviews

## What To Build in This Session

### Part 1: Invoke `/frontend-design`

Invoke the `/frontend-design` skill with this specific scope:
- Design system: color tokens, typography scale, spacing system, animation/motion language
- Component patterns: Button, Card, SectionWrapper, NeedleLine/dividers, Navigation, Footer
- Homepage composition: hero video section, services preview, artist preview, portfolio teaser, process steps, reviews, Spanish section, location/hours, final CTA
- How the "tech meets tattoo" collision manifests in each section

Wait for the design skill output before writing any code.

### Part 2: Build the Foundation

After the design skill returns, implement:

**1. Design system files:**
- `src/styles/globals.css` — CSS custom properties for all color tokens, typography, spacing
- Tailwind config integrated with the design tokens

**2. SEO config (centralized):**
- `src/lib/seo.ts` — All 10 pages' metadata, schema types, breadcrumb paths, and canonical URLs defined in one place. Each page imports its own data from here. This ensures cross-page SEO coherence as pages are built in later sessions.
- `src/lib/config.ts` — NAP, hours, social links, booking URL

**3. Root layout (`src/app/layout.tsx`):**
- Font loading (next/font)
- Navigation component (all 10 page links, even though only homepage exists)
- Footer component (NAP, hours, social links, secondary nav, review CTA)
- Schema.org Organization markup
- Security headers in next.config.ts

**4. Reusable components:**
- `Button` — primary/secondary/ghost variants
- `SectionWrapper` — consistent section padding, max-width, optional background
- `NeedleLine` or equivalent tattoo-DNA decorative element
- `RevealOnScroll` — scroll-triggered entrance animations
- `JsonLd` — schema injection component
- `Breadcrumbs` — for inner pages (not used on homepage, but built now)

### Part 3: Build the Homepage

Implement the homepage following the page blueprint EXACTLY:

**Title tag:** `Tattoo Shop Minneapolis | Studio AZ Tattoo — North Loop`
**H1:** `Minneapolis's Top-Rated Custom Tattoo Shop`

**H2 sections (from page-blueprint.md):**
1. Hero — Video background, H1 overlay, primary CTA
2. "Why Studio AZ Is Minneapolis's Top-Rated Tattoo Shop" — 5.0 rating, 100% custom, bilingual, North Loop
3. "Our Tattoo Services" — Custom Design, Cover-Ups, Consultations (3 cards linking to /services)
4. "Meet Our Artists" — Joan and Andrew previews with portfolio thumbnails (linking to /artists/joan, /artists/andrew)
5. "What Our Clients Say" — Google review highlights
6. "Tatuajes en Minneapolis — Hablamos Español" — Spanish section
7. "Visit Us in the North Loop" — Address, hours, embedded map, parking link

**Internal links (from internal-linking.md):**
| Link To | Anchor Text | Type |
|---------|-------------|------|
| /services | "custom tattoo services" | Target |
| /artists | "meet our tattoo artists" | Target |
| /gallery | "view our portfolio" | Generic |
| /aftercare | "tattoo aftercare guide" | Target |
| /faq | "frequently asked questions" | Generic |
| /contact | "Studio AZ Tattoo" | Brand |
| /parking | "parking and directions" | Generic |

**CTA strategy (mid-stage):**
- Primary: "View Our Portfolio" → /gallery
- Secondary: "Meet Our Artists" → /artists
- Tertiary: "Book a Consultation" → /artists

**Content requirements:**
- 1,500-2,000 words total
- Primary keyword "tattoo shop Minneapolis" exact match 2-3x
- Secondary keywords each used 1-3x per the density targets
- Authority links to Wikipedia (Minneapolis, Tattoo, North Loop), MN Dept of Health, Minneapolis Chamber of Commerce
- Content hook: Knowledge bomb — open with a surprising fact about the exact-match domain or the 5.0 rating

**Spanish section:**
- H2: "Tatuajes en Minneapolis — Hablamos Español"
- Brief Spanish summary of services, consultation process, how to book
- Use `lang="es"` attribute on the section

**Schema markup (from schema-markup.md Section 1):**
- Full TattooParlor entity with NAP, hours (Tue-Sat 11:00-18:00), geo coordinates, services
- Organization with sameAs (Instagram, TikTok, Facebook, LinkedIn, Google Maps)
- BreadcrumbList (just Home)
- AggregateRating commented out (activate when 10+ reviews)

## Important Rules

1. **Read the SEO architecture files before writing code.** The page-blueprint.md is the source of truth for what content goes where.
2. **Use the real content from content-intake.md.** Don't write placeholder "Lorem ipsum" text — write the actual SEO-optimized page content using the business owner's answers.
3. **Follow the image-strategy.md for all images** — keyword-rich alt text, descriptive filenames, priority loading for hero, lazy loading for below-fold.
4. **The homepage should feel like a $10,000 website**, not a template. Every section should have intentional spatial composition, considered typography hierarchy, and purposeful motion.
5. **Mobile-first.** Design for 375px width first, then scale up.
6. **Performance targets:** LCP < 1.5s, INP < 100ms, CLS < 0.05. React Server Components by default. "use client" only for: hero video, mobile menu, scroll animations.
7. **Do NOT build any page other than the homepage.** Links to other pages should work (point to correct slugs) but those pages will be built in later sessions.
8. **After building, tell me to check localhost and give feedback.** Do not move on to other pages.
