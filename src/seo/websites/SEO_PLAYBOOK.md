# Studio AZ — SEO Playbook (Universal)

> Synthesized from The Affiliate Lab (Matt Diggity), 2026 local SEO research, GBP ranking studies, GEO best practices, and competitor analysis. This is the single source of truth for all SEO decisions across Studio AZ websites. Site-specific details (keywords, competitors, NAP, schema types) go in each site's `SEO_OVERRIDES.md`.

---

## Part 1: Google Map Pack & Local SEO (Drives ~70% of New Customers)

### 1.1 The Three Pillars of Map Pack Ranking

Google ranks local businesses on three core signals:

1. **Relevance** — Does your business match what the searcher is looking for? (Primary category, services, keywords in GBP and website)
2. **Distance** — How close is your business to the searcher? (Cannot be changed — compensate with prominence)
3. **Prominence** — How well-known and trusted is your business? (Reviews, citations, backlinks, website authority, brand demand)

**Biggest lever is Prominence.** Distance is fixed. Relevance is handled by proper category selection and on-page SEO. Prominence can be grown massively through reviews, content, citations, and GBP optimization.

### 1.2 Google Business Profile (GBP) Optimization

GBP signals account for ~32% of all map pack ranking factors. Single most impactful thing for local search.

**Foundation:**
- [ ] Business name matches real-world branding exactly — no keyword stuffing (August 2025 Spam Update penalizes this)
- [ ] Primary category matches core revenue service exactly (see site's `SEO_OVERRIDES.md`)
- [ ] Add secondary categories for additional services offered
- [ ] Address verified and accurate — must match website, schema, and all citations character-for-character
- [ ] Phone number consistent everywhere (no "St." vs "Street" variations, no formatting differences)
- [ ] Hours accurate and updated immediately for holidays/seasonal changes — Google hides closed businesses for immediate-need queries

**Content & Engagement:**
- [ ] Business description: natural language, clearly states what you do and where, services mentioned once, updated annually
- [ ] Every service added with human-readable descriptions (not keyword-stuffed)
- [ ] Services align with website service pages
- [ ] Publish 1-2 GBP posts per week — mix updates, FAQs, portfolio highlights, seasonal content
- [ ] Posts must include clear CTA (Book, Call, Visit)
- [ ] Pre-seed Q&A section with common customer questions and service/location-specific answers

**Visual Content:**
- [ ] Upload 1+ new photos weekly — real work only, no stock images
- [ ] Mix: interior, exterior, team, completed work, process shots
- [ ] Short video clips: studio tour, process footage, team intros
- [ ] Upload directly to GBP (not embedded links)
- [ ] Google Lens uses photos for visual search — branded/real images build entity authority, stock images do not

### 1.3 Review Strategy

Reviews are the #1 lever for Map Pack visibility.

**Critical thresholds:**
- Moving from 9 → 10 reviews shows a clear ranking boost (documented in research)
- 10 → 50 reviews: significant map pack visibility unlock
- 50 → 100 reviews: competitive positioning
- Target: 50+ reviews within 3 months, 100+ within 6 months

**Review velocity matters more than lifetime total:**
- Google weights last 90 days of reviews, not lifetime count
- 2-5 consistent monthly reviews beat 20 sporadic reviews
- Recent, positive reviews with service-specific keywords carry the most weight

**Getting keyword-rich reviews (without scripting):**
- Prompt clients to mention specific services naturally
- Customer mentions of specific services create "Review Justification" signals in Google
- Never script, buy, or incentivize reviews — algorithmic detection leads to profile suspension

**Review response strategy:**
- Respond to EVERY review (positive and negative)
- Responses should be helpful and unique, not templated
- Add service context naturally in responses
- Address negative feedback professionally and publicly

### 1.4 Citation Building & NAP Consistency

NAP consistency accounts for ~35% weight in map pack rankings. Google's January 2026 verification update checks citation consistency before GBP approval.

**Priority citation platforms (quality > quantity):**
1. Google Business Profile (primary)
2. Yelp
3. Apple Business Connect (drives iOS/Siri visibility)
4. Bing Places (ChatGPT relies on Bing for local data)
5. Facebook Business
6. Foursquare
7. BBB (Better Business Bureau)
8. Local Chamber of Commerce
9. Industry-specific directories (see site's `SEO_OVERRIDES.md`)

**Data aggregators** (distribute NAP to hundreds of directories automatically):
- Data Axle
- Neustar/Localeze
- Foursquare

**NAP must be IDENTICAL everywhere** — see each site's `SEO_OVERRIDES.md` for exact NAP.
- No abbreviation variations ("St." vs "Street", "Ste" vs "Suite")

### 1.5 Local Authority Signals

- Chamber of Commerce listing
- Local sponsorship pages (events, sports teams, community)
- Local news mentions and features
- Supplier/vendor mentions
- Neighborhood association pages

---

## Part 2: Website Architecture & On-Page SEO

### 2.1 The 3 Kings (Highest Impact On-Page Factors)

Most impactful onsite elements, in order:

1. **URL** — the domain + slug
2. **SEO Title Tag** `<title>` — what shows in Google results
3. **Page Title H1** — what users see on the page
4. Then: Subheadings [H2, H3...] → Content

**URL Optimization:**
- 3-4 words max in the slug
- Do not repeat words from the domain in the slug
- Get the frequently repeating SINGLE WORDS from top keywords into the slug
- Exact-match domains (keyword in domain) are a massive SEO asset

**SEO Title Tag Optimization:**
- Aim for 60-64 characters
- Keep top keyword phrases TOGETHER and towards the front
- Write naturally — what would a real person type?
- Do not repeat words across the title
- Don't make the title tag and H1 identical — scramble them

**H1 / Page Title Optimization:**
- Same rules as title tag but different phrasing
- One H1 per page — always
- Must contain primary keyword

### 2.2 Site Structure (Flat Hierarchy + Silo)

Every important page must be reachable within 2-3 clicks of the homepage.

**Navigation:** Primary nav should have 7±2 items (cognitive load research). Secondary items go in footer.

### 2.3 Internal Linking (Silo Mastery)

**Anchor text ratio:**
- Target Anchor (keyword-rich): 50%
- Generic ("read here," "click here"): 25%
- Brand/URL: 25%

**Rules:**
- Every page links back to homepage using Target Anchors
- If only 1 link on a page, make it a Target Anchor
- Use Target Anchor links for pages/keywords with highest search volume
- 3-5 internal links per 1,000 words of content
- Place links in contextual sentences, not generic "click here" blocks
- Use descriptive anchor text that explains the relationship between pages
- Never nofollow internal links (wastes link equity)

**Hub-and-spoke model:**
- Homepage = hub, inner pages = spokes
- Each inner page links to homepage (target anchor) and 2-3 related inner pages
- Cross-link related pages only — don't link unrelated topics
- Don't confuse Google's topic understanding

**Breadcrumbs:**
- BreadcrumbList schema on all non-homepage pages
- Helps both navigation and search engine crawling

### 2.4 Content Strategy

**Content length:**
- Look at competitors' pages and add 10-20% more words
- Determine word count targets per page during Phase 1 research

**Content optimization & keyword density:**
- Single word keyword density: 2-3% (or 10-15 mentions per 500 words)
- Everything on the page counts (nav, sidebar, footer, alt tags, file names)
- Plural = singular for keyword counting
- Top 1-3 keywords: use as exact string 2-3x
- Top 4-5 keywords: use as exact string 1x
- Remaining keywords: covered by single word optimization
- Put misspellings in alt tags (not visible text)
- Use Google synonyms to replace over-optimized keywords

**Avoid topic duplication:**
- Check for word overlap between pages
- Check for meaning overlap
- Use target anchor text to clarify subtopics
- Each page owns one primary keyword — no page cannibalizes another

### 2.5 Subheadings (H2, H3)

- Used to break up topics and sweep up keywords missed in the 3 Kings
- Don't optimize EVERY subheading — leave some without keywords (natural)
- H2s create section boundaries that AI engines use for passage-based citation
- Each H2 section should be able to stand alone as a cited passage

### 2.6 Meta Descriptions

- Include keywords (Google bolds them in SERP)
- Leverage capitalization on eye-catching words
- Leave cliffhangers to drive clicks
- 155 characters max
- Include a CTA appropriate to the page's buyer stage

### 2.7 Authority Links (Outbound)

Outbound authority links to high-DA sites help rank.

- Choose DA/DR 80+ sites
- Dofollow
- Cover the entire niche (e.g., link to Wikipedia for city, link to relevant authority for industry)
- 1+ authority link per H2 subtopic
- Use footnote/reference style to minimize outbound clicks
- Resources/references section at bottom of content pages

---

## Part 3: Technical SEO & Core Web Vitals

### 3.1 Core Web Vitals (Confirmed Ranking Factor)

All three must pass at the 75th percentile (p75) of real user data:

| Metric | What It Measures | Good Threshold | Our Target |
|--------|-----------------|----------------|------------|
| **LCP** (Largest Contentful Paint) | Loading speed | < 2.5 seconds | < 1.5s |
| **INP** (Interaction to Next Paint) | Responsiveness | < 200ms | < 100ms |
| **CLS** (Cumulative Layout Shift) | Visual stability | < 0.1 | < 0.05 |

Passing all three correlates with 24% lower bounce rates.

**Next.js advantages for CWV:**
- Server-side rendering (SSR) and React Server Components = fast LCP
- Automatic code splitting = lower INP
- next/image with automatic sizing = prevents CLS
- Built-in font optimization = prevents layout shift from web fonts

### 3.2 Next.js SEO Implementation (App Router)

**Metadata:**
- Use `generateMetadata()` for dynamic pages (team member pages, etc.)
- Export static `metadata` object for fixed pages
- Next.js automatically merges metadata across nested layouts

**Sitemap:**
- Generate via `app/sitemap.ts` — auto-generates at `/sitemap.xml`
- Include all pages with `lastModified` dates and `changeFrequency`

**Robots.txt:**
- Generate via `app/robots.ts`
- Allow all search engine crawlers
- Allow GPTBot, ClaudeBot, PerplexityBot (critical for GEO/AI citations)
- Reference sitemap URL

**Structured data (JSON-LD):**
- Inject via `<script type="application/ld+json">` in page components
- Use Next.js `<Script>` component or direct injection in layout/page files

### 3.3 Image Optimization

- All images in WebP format with JPEG fallbacks
- Use `next/image` for automatic responsive sizing and lazy loading
- File names: keyword-descriptive (e.g., `fade-haircut-minneapolis-barber-name.webp`)
- Alt text: descriptive, keyword-included, unique per image
- Above-the-fold hero images: priority loading (`priority` prop in next/image)
- Portfolio images: lazy loaded with blur placeholder

### 3.4 Mobile-First Design

- Google uses mobile-first indexing — mobile version IS the version Google evaluates
- Prominent click-to-call buttons on mobile
- Touch targets: minimum 48x48px
- No horizontal scrolling
- Text readable without zooming (16px minimum body text)
- Embedded Google Map on contact page (mobile-optimized)

---

## Part 4: Schema Markup (Structured Data)

Schema is no longer optional — it's a structural trust layer that helps Google, Maps, and AI systems understand your business.

**Common schema types for local business sites:**

| Page Type | Schema Types |
|-----------|-------------|
| Home | `LocalBusiness` subtype + `Organization` + `BreadcrumbList` |
| Services | `Service` + `Offer` (per service) + `BreadcrumbList` |
| Team (index) | `ItemList` of `Person` entities + `BreadcrumbList` |
| Team member | `Person` + `worksFor` + `knowsAbout` + `ImageGallery` + `BreadcrumbList` |
| Gallery/Portfolio | `ImageGallery` + `ImageObject` per image + `BreadcrumbList` |
| Info/Guide pages | `Article` + `HowTo` (if step-by-step) + `BreadcrumbList` |
| FAQ | `FAQPage` (every Q&A = featured snippet opportunity) + `BreadcrumbList` |
| Contact | `LocalBusiness` subtype (NAP duplication) + `BreadcrumbList` |

**Schema best practices:**
- JSON-LD format (Google's preferred)
- One schema block per page (can contain multiple types via `@graph`)
- Validate with Google Rich Results Test + Schema.org Validator
- Include `AggregateRating` on homepage once 10+ reviews
- `sameAs` links to all social profiles and Google Maps URL
- `openingHoursSpecification` must match GBP hours exactly
- Use specific `@type` subtypes (e.g., `TattooParlor`, `BarberShop`) not generic `LocalBusiness`

---

## Part 5: E-E-A-T (Experience, Expertise, Authoritativeness, Trustworthiness)

Google's quality raters evaluate all content through E-E-A-T. In 2026, this is the primary principle for content credibility assessment.

### 5.1 Experience (First-Hand Proof)
- Real portfolio images of completed work (not stock)
- Process documentation showing how services are delivered
- Team bios with years of experience, training, specialties
- Client testimonials with specific details
- Before/after gallery (where appropriate)

### 5.2 Expertise
- Team member pages with detailed specialization
- Guide/info pages written with accuracy and depth
- FAQ answers that demonstrate deep industry knowledge
- Link to relevant authority pages in your industry

### 5.3 Authoritativeness
- Google reviews (quantity + recency + keyword mentions)
- Citations across authoritative directories (Yelp, BBB, Chamber)
- Local press mentions and features
- Consistent brand mentions across the web
- Social media following and engagement as social proof

### 5.4 Trustworthiness
- HTTPS (mandatory)
- Clear NAP on every page (footer)
- Real photos of location, team, and work
- Privacy policy and terms of service
- Professional design and fast load times
- Embedded Google Map showing real location
- Transparent pricing guidance (no bait-and-switch)
- Review display with aggregate rating

---

## Part 6: GEO — Generative Engine Optimization (AI Search)

Google AI Overviews now appear on ~40% of all searches. ChatGPT, Perplexity, and Claude are growing as discovery channels. Optimizing for AI citation is now as important as traditional SEO.

### 6.1 Content Structure for AI Citation

AI engines break pages into passages. Each section must stand independently:

- Begin each H2 section with a direct answer before expanding
- Use clean heading hierarchies (H2 → H3) to signal topic boundaries
- Add TL;DR or summary statements under key headings
- FAQ sections are heavily relied on by AI engines for Q&A pair extraction
- Direct answers in the first 40-60 words of each section
- Fact density: include statistics/specifics every 150-200 words

### 6.2 Technical GEO Requirements

- Do NOT block AI crawlers in robots.txt:
  - Allow: GPTBot (ChatGPT)
  - Allow: ClaudeBot (Claude/Anthropic)
  - Allow: PerplexityBot
  - Allow: Google-Extended (Gemini)
- Consider adding `llms.txt` file to guide AI system interpretation
- Structured data (schema) is the "native language" for AI systems
- Keep "Last updated" timestamps visible on content pages

### 6.3 Entity Optimization

- Consistent brand name — same everywhere
- Detailed About page with team bios and business history
- Pursue third-party coverage: local blogs, city magazines, industry publications
- Brand demand (people searching your brand name directly) is a credibility signal
- AI engines favor earned media over brand-owned content for citations

### 6.4 Measuring AI Visibility

Track quarterly:
- AI citation frequency: how often ChatGPT/Perplexity/Gemini mention the business
- Share of voice vs competitors in AI answers
- AI-referred traffic in GA4
- Citation accuracy (is the AI saying correct things about us?)

---

## Part 7: Featured Snippets (Position Zero)

How to steal the featured snippet for question-based keywords:

1. Identify which target keywords have featured snippets in Google results
2. Match the structure of the current snippet — list, table, or paragraph
3. Precede the answer with an H2 that contains the query
4. Insert an optimized image near the snippet-targeted section
5. Use Google synonyms and related terms in the answer
6. Give a direct, concise answer immediately after the H2 — then expand with detail
7. NLP-friendly format: echo the question, give the answer, mention correct units/timeframes

Best pages for snippet targeting:
- FAQ page (every Q&A is a snippet opportunity)
- Guide/info pages (timelines, instructions)
- Services page (pricing questions, process questions)

---

## Part 8: NLP & Content Writing

### 8.1 NLP-Friendly Content

Make it easy for NLP algorithms and get vastly rewarded:
- Echo back the search query in the answer
- Give the answer directly
- Mention correct units, timeframes, measurements

### 8.2 TF*IDF (Term Frequency Inverse Document Frequency)

Niche-specific keyword density — what terms the top-ranking pages for your keyword all use that you might be missing.

- Run TF*IDF analysis against top 10 competitors for each target keyword
- Identify niche-specific terms that are missing
- Add missing terms naturally throughout content

---

## Part 9: CRO — Getting Visitors to Convert

### 9.1 The Glance Test
- Load page, look away, glance for 1 second — did you know what the page is about?
- Use featured images, clear headlines, and prominent branding
- Pages with featured images increase engagement by ~11%

### 9.2 Above the Fold (in order)
1. Make visitor feel they're in the right place (hero image + keyword-rich H1)
2. Build trust (professional design, credibility indicators, review count)
3. Hook them to keep reading (compelling first paragraph)

### 9.3 The Hook (First Paragraph)
Three approaches:
- **Knowledge bomb:** Hit with a surprising fact
- **The entertainer:** Relatable, conversational voice
- **Fear factor:** Create urgency

### 9.4 Keeping Visitors Reading
- Short paragraphs (1-3 sentences max)
- Never a full screen of text without a visual break
- Subheadings let skimmers jump to their section
- Formatted content: tables, lists, callout boxes
- Bucket brigades: "more on this below," "here's where it gets interesting"

### 9.5 Sale Cycle — Match Content to Buyer Stage
- **Early stage** (informational): educate, don't pitch. Soft CTAs moving toward consideration
- **Mid stage** (consideration): show proof, reviews, portfolio. CTA toward team/service pages
- **Late stage** (ready to act): team/service pages → direct CTA: "Book a Consultation"
- Don't push late-stage CTA on early-stage visitors

### 9.6 CTA Best Practices
- "Book a Free Consultation" beats "Learn More"
- CTA color contrasts with site color scheme
- CTA at the bottom of every page (matched to buyer stage)
- Late-stage pages: 2-3 inline CTAs throughout
- Early-stage pages: softer CTAs moving to next stage

### 9.7 Behavioral Signals That Affect Rankings
Google tracks post-click behavior as ranking signals:
- **Direction requests** from GBP (highest intent signal)
- **Calls from mobile search**
- **Website clicks** from GBP
- **Dwell time** (time on site confirms relevance)
- **Pogo-sticking** (bouncing back to search = negative signal)

Good CRO → longer dwell time → better behavioral signals → higher rankings. It's a flywheel.

---

## Part 10: Trust Factors

- Domain-verified YouTube channel
- `<link rel="publisher">` for all social channels
- Author/team schema and bio at bottom of every content page
- Link bios to About page + social profiles
- Organizational schema on Home, About, Contact
- Real company details on About and Contact pages
- "Meet the team" content with real photos
- Embedded Google Map
- Transparent pricing guidance
- SSL/HTTPS
- Privacy policy + terms of service

---

## Part 11: Website Maintenance (Post-Launch)

### 11.1 Fresh Content Algorithm
Google rewards sites with continuous updates.

**Monthly (bare minimum):**
1. Add at least 1 new page or blog post
2. Update 1 existing piece of content (add sentence, swap image, add video, update testimonial)
3. Link new content to relevant existing pages
4. Syndicate to social profiles (Instagram, Facebook)
5. Watch for topic duplication

### 11.2 GBP Maintenance Schedule

| Frequency | Tasks |
|-----------|-------|
| **Weekly** | 1-2 GBP posts, respond to all reviews, upload 1+ photo |
| **Monthly** | Acquire new reviews, monitor Q&A, check for new competitor activity |
| **Quarterly** | Review categories vs competitors, audit services listing, check citation accuracy, compare rankings |
| **Annually** | Refresh business description, clean up old photos, recalibrate overall strategy, update schema |

### 11.3 Quarterly Keyword Audit
- Export rankings from SerpAPI + Search Console, compare to previous quarter
- Stagnant or dropped keywords = content refresh candidates
- Look for accidental rankings we haven't optimized for
- Three types of keyword finds:
  1. Keywords we rank for but don't have a page for → create a new page
  2. Keywords we rank for but the word isn't in our content → add it
  3. Keywords we rank for but the word isn't mentioned enough → increase frequency

### 11.4 Content Refresh Checklist
For stagnant or dropping pages:
- [ ] Is the content still accurate and up to date?
- [ ] Is word count still competitive? (check top 3 competitors, add 10-20%)
- [ ] Re-run TF*IDF — are niche keyword densities still optimal?
- [ ] Are there new subtopics that competitors cover that we don't?
- [ ] Add "Last updated: [date]" timestamp (freshness signal for both Google and AI engines)
- [ ] Updating content triggers Google to retest the page at a higher position

### 11.5 Quarterly AI Visibility Check
- Search for primary keywords on ChatGPT, Perplexity, and Gemini
- Are we being cited? What are they saying?
- Are competitors being cited more? Why?
- Is our NAP/info being reported accurately by AI?

---

## Part 12: Cross-Platform SEO (Beyond Google)

### 12.1 Apple Business Connect
- Critical for iOS users (Maps, Siri, Wallet, Mail)
- Sync NAP, hours, and services from GBP
- Use "Showcases" feature for engagement signals
- Photos and updates visible in Apple Maps

### 12.2 Bing Places
- ChatGPT relies on Bing for local business data
- Claim and verify Bing Places listing
- NAP must match GBP exactly
- Sync categories and services

### 12.3 Social Signals
- Primary social platform for the industry (Instagram for visual, Facebook for local)
- Google Maps link from social bios
- Facebook Business page with NAP
- Link all social profiles in schema `sameAs` array

---

## Quick Reference: Impact Ranking

What moves the needle most for a local service business, in order:

1. **Reviews** (40%) — Getting to 50+ unlocks map pack visibility
2. **Website** (30%) — Proper on-page SEO + content depth for organic rankings
3. **GBP Optimization** (20%) — Posts, products, photos, categories, Q&A
4. **Citations** (10%) — Consistent NAP across platforms + data aggregators
