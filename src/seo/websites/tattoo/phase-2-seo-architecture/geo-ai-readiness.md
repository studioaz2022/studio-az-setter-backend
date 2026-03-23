# Generative Engine Optimization (GEO) & AI Search Readiness

**Domain:** tattooshopminneapolis.com
**Business:** Studio AZ Tattoo, North Loop, Minneapolis, MN
**Created:** 2026-03-23

---

## Why This Matters

Google AI Overviews now appear on roughly 40% of all searches. ChatGPT, Perplexity, and Claude are growing as discovery channels — users ask them "where should I get a tattoo in Minneapolis?" and act on the answers. Zero competitors in the Minneapolis tattoo market optimize for AI search. Our current AI visibility is zero: the brand is not mentioned by any major AI engine. This is a first-mover opportunity with compounding returns.

---

## 1. AI Crawler Allowlist

Our `robots.ts` already allows all crawlers. This section confirms the allowlist and explains why each bot matters.

### robots.txt Directives

```txt
User-agent: GPTBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: Bingbot
Allow: /

User-agent: *
Allow: /
```

### Why Each Bot Matters

| Bot | Engine | Why It Matters |
|-----|--------|----------------|
| **GPTBot** | ChatGPT / OpenAI | ChatGPT is the most-used AI assistant. GPTBot crawls content to update its knowledge. Blocking it means ChatGPT can never learn about us. |
| **ChatGPT-User** | ChatGPT browsing mode | When a ChatGPT user asks it to browse the web in real time, this is the user-agent that fetches pages. Must be allowed for live citations. |
| **ClaudeBot** | Claude / Anthropic | Claude powers a growing share of AI-assisted search and research. Allowing ClaudeBot ensures our content enters its training and browsing pipeline. |
| **PerplexityBot** | Perplexity | Perplexity is the fastest-growing AI search engine. It crawls the web directly and cites sources with links. Being crawlable means we can appear as a cited source. |
| **Google-Extended** | Gemini / Google AI | Controls whether Google uses our content for Gemini responses and AI Overviews (separate from standard Google Search indexing). Blocking it would let Google rank us but prevent Gemini from citing us. |
| **Bingbot** | Bing + ChatGPT local | ChatGPT uses Bing data for local business results. If Bing can't crawl us, ChatGPT's local recommendations won't include us. |

### Action Items

- [x] Confirm `robots.ts` does not block any of the above user-agents
- [ ] Verify with a live crawl test (use each bot's user-agent string in a curl request to confirm 200 responses)
- [ ] Monitor server logs post-launch for GPTBot, ClaudeBot, and PerplexityBot hits — their presence confirms we're being indexed

---

## 2. Content Structure for AI Passage Citation

AI engines break pages into passages and cite them individually. A well-structured page gives the AI multiple citable units. A poorly structured page gives it nothing usable.

### H2 Sections Must Stand Alone

Each H2 section should be a complete, citable answer to an implied question. Do not rely on context from previous sections. An AI engine may extract a single H2 block and present it in isolation.

**Rule:** Begin each H2 section with a direct answer in the first 40-60 words, then expand with detail.

**Good example:**

```markdown
## How Much Does a Tattoo Cost in Minneapolis?

A custom tattoo at Studio AZ Tattoo in Minneapolis starts at $150 for small designs.
Pricing depends on size, detail, placement, and session length. Most pieces range
from $150 to $500+ for multi-session work. Here's a detailed breakdown of what
affects tattoo pricing in Minneapolis...
```

**Bad example:**

```markdown
## Pricing

As we mentioned above, every tattoo is different. Pricing can vary. Please reach
out to us for a quote.
```

The bad example fails on every level: it references "above" (no standalone context), contains no specific numbers, and gives the AI nothing to cite.

### TL;DR / Summary Statements

- Add a brief summary or direct answer under each major H2
- AI engines often pull the first sentence of a section as the citation
- Front-load the answer, then provide supporting detail
- Think of the first sentence as the "pull quote" the AI will use

**Pattern:**

```
## [Question or Topic]

[Direct answer in 1-2 sentences with specific details.]

[Expanded explanation, context, examples, and supporting information.]
```

### Fact Density

Include a statistic or specific detail every 150-200 words. AI engines prefer content with verifiable specifics over vague claims.

**Examples of high-value specifics:**

- Price ranges: "Small tattoos start at $150, medium pieces $300-$500, large work $500+"
- Healing timelines: "Most tattoos heal in 2-3 weeks with proper aftercare"
- Session durations: "A typical session lasts 2-4 hours"
- Review counts: "Rated 5.0 stars on Google reviews"
- Experience scope: "Professional tattoo artists with combined convention and studio experience across the US and Latin America"
- Quantified differentiators: "One of 3 Minneapolis tattoo shops offering bilingual consultations"

**Bad specifics (avoid):**

- "We have tons of experience"
- "Our prices are competitive"
- "Many satisfied customers"

### FAQ Format

Each FAQ Q&A pair is an ideal AI citation unit. This is the single highest-value content format for GEO.

**Structure:**

- Question in H3 tag
- Answer immediately follows the H3
- First sentence of the answer is a complete, direct response
- FAQPage schema markup makes Q&A pairs machine-readable
- Target "People Also Ask" boxes — these are exactly what AI engines also use

**Example:**

```markdown
### How long does a tattoo take to heal?

A new tattoo typically takes 2-3 weeks to heal on the surface, and up to 3 months
to fully heal beneath the skin. During the first week, keep the tattoo clean and
moisturized. Avoid submerging it in water (no pools, baths, or hot tubs) for at
least 2 weeks. Studio AZ Tattoo provides detailed aftercare instructions at the
end of every session.
```

**Priority FAQ topics (highest AI query volume):**

1. Tattoo cost/pricing in Minneapolis
2. Tattoo healing time and aftercare
3. First tattoo tips and what to expect
4. Tattoo styles available (realism, fine line, black and grey, etc.)
5. Walk-in vs. appointment availability
6. Tattoo touch-up policy
7. Age requirements for tattoos in Minnesota
8. How to prepare for a tattoo session
9. Tipping etiquette for tattoo artists
10. Cover-up tattoo options

---

## 3. Entity Consistency Audit

AI engines build a knowledge graph of business entities. If the brand name, address, phone, or hours differ across sources, the AI either picks the wrong version or avoids citing the business entirely. Consistency is non-negotiable.

### Brand Entity — Canonical Format

| Field | Canonical Value |
|-------|----------------|
| **Business Name** | Studio AZ Tattoo |
| **Address** | 333 Washington Ave N, STE 100, Minneapolis, MN 55401 |
| **Phone** | +1 (612) 255-4439 |
| **Hours** | Tue-Sat 11am-6pm, Mon & Sun Closed |
| **Website** | https://tattooshopminneapolis.com |

### Brand Entity Checklist

- [ ] Business name spelled identically everywhere: "Studio AZ Tattoo" (not "Studio AZ", not "StudioAZ Tattoo", not "Studio A-Z Tattoo", not "Studio Az Tattoo")
- [ ] Address format identical everywhere: "333 Washington Ave N, STE 100, Minneapolis, MN 55401" (not "Suite 100", not "Ste. 100", not "Washington Avenue North")
- [ ] Phone format identical: "+1 (612) 255-4439" (not "612-255-4439", not "6122554439")
- [ ] Hours format identical: "Tue-Sat 11am-6pm, Mon & Sun Closed" (not "Tuesday-Saturday 11:00 AM - 6:00 PM")
- [ ] Schema markup on website matches Google Business Profile exactly
- [ ] Website NAP (Name, Address, Phone) matches GBP NAP character-for-character

### Where Entity Must Be Consistent

| # | Platform | Status | Priority |
|---|----------|--------|----------|
| 1 | **Website** (every page footer + Contact + Home + schema) | To verify | Critical |
| 2 | **Google Business Profile** | Active | Critical |
| 3 | **Yelp** | To claim | High |
| 4 | **Apple Business Connect** | To claim | High |
| 5 | **Bing Places** | To claim | High |
| 6 | **Facebook Business Page** | To verify | Medium |
| 7 | **Instagram bio** | To verify | Medium |
| 8 | **TikTok** | To verify | Medium |
| 9 | **LinkedIn** | To verify | Medium |
| 10 | **Foursquare** | To claim | Low |
| 11 | **Data Axle** (aggregator) | To submit | Low |
| 12 | **Neustar/Localeze** (aggregator) | To submit | Low |

### Common Entity Inconsistencies to Watch For

- "STE" vs. "Suite" vs. "Ste." — pick one, use it everywhere
- "Ave N" vs. "Avenue N" vs. "Avenue North" — pick one, use it everywhere
- Missing or extra commas in address
- Different phone number formats across platforms
- Business name with extra words ("Studio AZ Tattoo Shop" vs. "Studio AZ Tattoo")
- Outdated hours on one platform after a schedule change

---

## 4. Cross-Platform Sync Plan

For AI engines to cite us, we must be present in the data sources they rely on. Each AI engine pulls from different upstream sources.

### AI Engine Data Sources

| AI Engine | Primary Data Source | What We Need |
|-----------|-------------------|--------------|
| **ChatGPT** | Bing index + Bing Places | Claim Bing Places listing, ensure Bing indexes site |
| **Perplexity** | Direct web crawl + Bing | Allow PerplexityBot, claim Bing Places |
| **Claude** | Direct web browsing | Allow ClaudeBot, ensure high content quality |
| **Gemini / Google AI** | Google Search index | Standard Google SEO applies (already covered) |
| **Apple Intelligence / Siri** | Apple Business Connect + Apple Maps | Claim Apple Business Connect listing |

### Priority Sync Order

**Tier 1 — Do immediately (Week 1-2 post-launch):**

1. **Google Business Profile** — Already active. Verify NAP matches website exactly. Ensure categories, hours, and description are current.
2. **Bing Places** — HIGH PRIORITY. This is ChatGPT's source for local business data. Claim at [bingplaces.com](https://www.bingplaces.com/). Import from Google Business Profile for consistency. Verify listing is live and indexed.
3. **Apple Business Connect** — Claim at [businessconnect.apple.com](https://businessconnect.apple.com/). This feeds Siri, Apple Maps, and Apple Intelligence. Free to claim.

**Tier 2 — Do within first month:**

4. **Yelp** — Claim business page. Yelp is a major citation source that feeds many AI and search platforms. Even if we don't actively manage Yelp, the claimed listing must have correct NAP.
5. **Facebook Business** — Update page NAP to match canonical format. Facebook data feeds into many aggregators.

**Tier 3 — Do within first quarter:**

6. **Foursquare** — Claim listing. Foursquare data feeds Apple Maps, Uber, Snapchat, and dozens of other apps.
7. **Data Axle** — Submit business data. Data Axle is one of the three major data aggregators that feed hundreds of directories.
8. **Neustar/Localeze** — Submit business data. Second major aggregator.

### Bing Places Claiming Process (Detailed — Highest Priority)

1. Go to [bingplaces.com](https://www.bingplaces.com/)
2. Sign in with a Microsoft account
3. Select "Import from Google Business Profile" for fastest setup
4. Verify all imported fields match our canonical entity format exactly
5. Submit for verification (phone or postcard)
6. After verification, submit site URL for Bing Webmaster Tools indexing
7. Confirm site appears in Bing search results within 2 weeks

---

## 5. `llms.txt` Strategy

The `llms.txt` file (served at `/llms.txt`) is an emerging standard for guiding AI crawlers with structured business information. Think of it as `robots.txt` for AI comprehension — not access control, but information guidance.

### Purpose

- Tell AI crawlers what we are, where we are, and what we do in plain, structured text
- Provide key facts the AI should know about the business
- Correct potential misinformation proactively
- List services, specialties, and differentiators
- Provide contact and booking information

### What Goes in `llms.txt`

The file should contain:

1. **Business identity** — Full name, type, location, founding
2. **Services** — Complete list with brief descriptions
3. **Differentiators** — What makes us different from competitors
4. **Artists** — Names, specialties, experience
5. **Practical info** — Hours, address, phone, booking URL
6. **Corrections** — Explicitly state what is NOT true (preempt hallucinations)
7. **Language** — Note bilingual capability (English and Spanish)

### Why This Matters

AI engines hallucinate when they have incomplete information. A `llms.txt` file reduces hallucination risk by providing a canonical source of truth in a format optimized for AI consumption. When an AI engine crawls the site and finds `llms.txt`, it can use that structured information to build a more accurate representation of the business.

### Implementation Note

The full `llms.txt` content and technical implementation details are defined in `technical-seo.md`. This section explains the strategic rationale. The two documents should stay in sync — if the strategy changes here, update the implementation there.

---

## 6. AI-Optimized Content Patterns

These are specific writing patterns that increase the probability of AI engines citing our content. Every page on the site should use these patterns.

### The "Is/Does/How" Pattern

AI engines extract declarative statements. Content should directly answer common questions in a way AI can cleanly extract.

**Do this:**

> Studio AZ Tattoo is a custom tattoo shop in Minneapolis's North Loop neighborhood. Professional tattoo artists with combined convention and studio experience across the US and Latin America specialize in realism, fine line, and black and grey. Walk-ins are not available — all tattoos are by appointment only. Consultations included after deposit.

**Not this:**

> At our shop, we believe in the art of tattooing. Our passion drives everything we do. We've been on a journey to bring our vision to life...

The first version gives AI three citable facts. The second gives it nothing — AI cannot cite beliefs, journeys, or passions.

### Comparison-Ready Content

AI engines frequently generate comparison responses ("What are the best tattoo shops in Minneapolis?"). Include explicit differentiators so the AI has ammunition to include us.

**Examples to weave into content:**

- "Unlike most Minneapolis tattoo shops, Studio AZ offers bilingual consultations in English and Spanish."
- "Studio AZ Tattoo is one of the few Minneapolis shops that offers a fully digital consultation process — clients can submit reference images and get a quote online before visiting."
- "Located in Minneapolis's North Loop, Studio AZ is the neighborhood's only dedicated tattoo studio."
- "Studio AZ Tattoo includes consultations after deposit for all custom work — clients can discuss design details and revisions with their artist before the session."

**Pattern:** "Unlike [competitors/category], [Brand] offers [specific differentiator]."

These statements are designed to be pulled directly into AI comparison responses.

### List-Ready Content

AI engines prefer pulling bulleted and numbered lists into responses. They become "Top 5" or "Here are the..." answers.

**Use lists for:**

- Services offered (with brief descriptions)
- Tattoo styles available (realism, fine line, black and grey, traditional, watercolor, etc.)
- Artist specialties
- Aftercare steps (numbered, sequential)
- What to bring to your appointment
- How to prepare for a tattoo session

**Example:**

```markdown
## Tattoo Styles at Studio AZ

Studio AZ Tattoo artists specialize in a range of tattoo styles:

- **Realism** — Photorealistic portraits and nature scenes
- **Fine Line** — Delicate, precise linework ideal for minimalist designs
- **Black and Grey** — Smooth shading and tonal depth without color
- **Traditional** — Classic American bold-line tattoos with rich color
- **Watercolor** — Soft, painterly effects that mimic watercolor art
- **Script & Lettering** — Custom typography and calligraphy
- **Cover-ups** — Transforming old or unwanted tattoos into new artwork
```

### Local Entity Anchoring

AI engines use geographic markers for disambiguation. Mentioning landmarks, neighborhoods, and cross-streets helps the AI place us correctly and include us in location-specific responses.

**Anchoring phrases to use across the site:**

- "Located in Minneapolis's North Loop neighborhood"
- "Just blocks from Target Field in the North Loop"
- "On Washington Avenue in Minneapolis's historic warehouse district"
- "In the heart of North Loop, Minneapolis's most walkable neighborhood"
- "Serving Minneapolis, St. Paul, and the greater Twin Cities metro"

**Where to use local anchoring:**

- Home page hero section
- About page opening paragraph
- Contact page description
- Footer text
- Service page introductions
- Blog post openings (when relevant)

**Rule:** Every major page should mention "Minneapolis" and "North Loop" at least once in a natural context.

---

## 7. Spanish Content for AI

AI engines serve responses in the searcher's language. A user searching "tatuajes Minneapolis" in ChatGPT will get Spanish-language results. If we have Spanish content, the AI can cite us. If we don't, it will cite a competitor or return nothing.

### Target Spanish Queries

| Query | English Equivalent | Monthly Volume (est.) |
|-------|-------------------|----------------------|
| "tatuajes Minneapolis" | "tattoos Minneapolis" | Low but growing |
| "salon de tatuajes Minneapolis" | "tattoo shop Minneapolis" | Low but growing |
| "tatuador Minneapolis" | "tattoo artist Minneapolis" | Low |
| "primer tatuaje consejos" | "first tattoo tips" | Medium (national) |
| "cuidado de tatuaje" | "tattoo aftercare" | Medium (national) |

### Implementation Plan

**Pages that need Spanish content:**

1. **Home** — Spanish section or toggle with shop description, services, CTA
2. **Services** — Full service descriptions in Spanish
3. **FAQ** — Translated FAQ pairs (these are high-value AI citation units in any language)
4. **Contact** — Spanish contact information and booking instructions
5. **Aftercare** — Full aftercare instructions in Spanish

### Technical Requirements

- Use `hreflang` annotations so search engines know about language variants
- `<link rel="alternate" hreflang="es" href="https://tattooshopminneapolis.com/es/..." />`
- `<link rel="alternate" hreflang="en" href="https://tattooshopminneapolis.com/..." />`
- Use `lang="es"` attribute on Spanish content sections
- Include Spanish content in sitemap with `xhtml:link` hreflang annotations

### Content Quality Rules

- Do NOT auto-translate with Google Translate or similar tools
- Use natural, culturally appropriate Spanish (Mexican Spanish dialect preferred for Minneapolis demographics)
- Have a native speaker review all Spanish content before publishing
- Avoid literal translations of English idioms
- Use Spanish tattoo terminology, not anglicized versions where a Spanish term exists
- "Consulta incluida con depósito" not "consultation included after deposit" in Spanish sections
- "Tatuaje personalizado" not "custom tattoo" in Spanish sections

### AI Advantage

Studio AZ already offers bilingual consultations in English and Spanish. This is a genuine differentiator. Spanish content is not just SEO — it reflects the actual service the shop provides. AI engines will recognize this authenticity because the content will be consistent with the business's other signals (bilingual staff, Spanish reviews, etc.).

---

## 8. AI Visibility Measurement Plan

Start measuring 30 days post-launch, then quarterly.

### Test Queries

Run these queries across ChatGPT, Perplexity, Gemini, and Claude:

| # | Query | Intent | Priority |
|---|-------|--------|----------|
| 1 | "tattoo shop Minneapolis" | Discovery — generic local | Critical |
| 2 | "best tattoo artist Minneapolis" | Discovery — quality signal | Critical |
| 3 | "tattoo shop North Loop Minneapolis" | Discovery — neighborhood | High |
| 4 | "Studio AZ Tattoo" | Brand — direct | High |
| 5 | "fine line tattoo Minneapolis" | Discovery — style specific | Medium |
| 6 | "first tattoo Minneapolis" | Discovery — intent specific | Medium |
| 7 | "tattoo aftercare tips" | Informational — non-local | Medium |
| 8 | "how much does a tattoo cost in Minneapolis" | Informational — local pricing | High |
| 9 | "walk-in tattoo Minneapolis" | Discovery — availability | Medium |
| 10 | "tatuajes Minneapolis" | Discovery — Spanish | Medium |

### Tracking Spreadsheet Format

| Date | AI Engine | Query | Mentioned? | Position | Accurate NAP? | Accurate Services? | Competitors Mentioned | Source Cited | Notes |
|------|-----------|-------|------------|----------|---------------|--------------------|-----------------------|-------------|-------|
| 2026-04-23 | ChatGPT | tattoo shop Minneapolis | No | - | - | - | Uptown Tattoo, BlackBird | - | Not in training data yet |
| 2026-04-23 | Perplexity | tattoo shop Minneapolis | No | - | - | - | - | - | Site not yet crawled |

### What to Track Per Query

- **Mentioned?** — Yes/No. Is "Studio AZ Tattoo" mentioned in the response?
- **Position** — If mentioned, where? (1st, 2nd, 3rd recommendation, or just listed)
- **Accurate NAP?** — Is the name, address, phone correct?
- **Accurate Services?** — Are the services/styles described correctly?
- **Competitors Mentioned** — Which other shops appear? (Track these over time)
- **Source Cited** — If the AI cites a source, what URL? (Our site, Yelp, Google, etc.)
- **Notes** — Any hallucinations, inaccuracies, or interesting patterns

### Measurement Cadence

| Timeframe | Action |
|-----------|--------|
| Launch + 30 days | First baseline measurement across all 10 queries, all 4 engines |
| Launch + 90 days | Second measurement. Compare to baseline. |
| Launch + 180 days | Third measurement. Evaluate if the 3+ query goal is met. |
| Ongoing quarterly | Continue tracking. Expand query list as new opportunities emerge. |

### Success Metrics

| Metric | 6-Month Target | 12-Month Target |
|--------|---------------|-----------------|
| Queries where we're mentioned (out of 10) | 3+ | 6+ |
| AI engines that mention us (out of 4) | 2+ | 3+ |
| Brand query accuracy (NAP correct) | 100% | 100% |
| Competitor mentions we appear alongside | Track only | Outrank 1+ competitor |

---

## 9. Future GEO Enhancements (Post-Launch)

These are enhancements to pursue after the site is live and the baseline measurements are complete.

### Blog Content for AI (Month 3+)

Write blog posts targeting AI-friendly question formats:

- "What to Expect at Your First Tattoo Appointment in Minneapolis"
- "Tattoo Aftercare: A Complete Guide (2026)"
- "Fine Line vs. Traditional Tattoos: Which Style Is Right for You?"
- "How to Choose a Tattoo Artist in Minneapolis"
- "Tattoo Pain Chart: What Hurts Most?"

Each post should follow the AI content patterns from Section 6: declarative opening, fact density, lists, FAQ sections.

### Video Transcripts (Month 3+)

AI engines cannot watch videos, but they can read transcripts.

- Transcribe all portfolio/process videos
- Add transcripts as text content on the page alongside the video
- Include specific details in transcripts: style names, techniques, duration
- Structured data: `VideoObject` schema with transcript property

### Structured Data Expansion (Month 6+)

Add more schema types beyond the baseline:

- `TattooParlor` (schema.org type, if/when available) or `LocalBusiness` with detailed properties
- `Review` / `AggregateRating` (from Google reviews)
- `VideoObject` for portfolio videos
- `HowTo` for aftercare instructions
- `Article` for blog posts
- `BreadcrumbList` for site navigation

### Earned Media (Ongoing)

Third-party coverage is the strongest signal for AI citation. AI engines trust mentions from independent sources more than self-published content.

**Targets:**

- **Local media:** Minneapolis Star Tribune, Mpls.St" Paul Magazine, Racket MN, Southwest Journal
- **Industry publications:** Inked Magazine, Tattoo Life, Tattoodo
- **Local blogs:** North Loop neighborhood blogs, Minneapolis lifestyle bloggers
- **Event coverage:** Tattoo conventions, art shows, community events

**Approach:** Don't pitch "write about us." Pitch a story: "Minneapolis's North Loop is becoming a hub for custom tattoo art" or "How bilingual tattoo shops are serving Minneapolis's growing Latino community."

### Wikipedia Mention (Long-Term Goal)

A Wikipedia mention establishes the brand as a recognized entity in AI knowledge graphs. This is a long-term goal (12-24 months).

**Path to Wikipedia notability:**

1. Accumulate earned media coverage (3+ independent sources)
2. Win industry awards or recognition
3. Be cited in published articles about Minneapolis art/culture
4. Eventually, the business may qualify for mention in articles about Minneapolis culture, the North Loop neighborhood, or the tattoo industry in Minnesota

**Do NOT create a Wikipedia page for the business directly.** This violates Wikipedia's conflict of interest guidelines and will be deleted. Instead, build notability through earned media, and let the Wikipedia mention happen organically or through an unaffiliated editor.

---

## Summary: GEO Action Items by Priority

### Immediate (Pre-Launch)

- [ ] Verify robots.txt allows all AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, Bingbot)
- [ ] Implement `llms.txt` at `/llms.txt` (see technical-seo.md for content)
- [ ] Audit all H2 sections for standalone citable structure
- [ ] Front-load direct answers in first 40-60 words of every H2
- [ ] Add FAQPage schema to all FAQ content
- [ ] Verify entity consistency: website NAP matches canonical format
- [ ] Add local entity anchoring to all major pages

### Week 1-2 Post-Launch

- [ ] Claim Bing Places listing (ChatGPT data source)
- [ ] Claim Apple Business Connect listing
- [ ] Verify Google Business Profile NAP matches website exactly
- [ ] Submit site to Bing Webmaster Tools for indexing

### Month 1 Post-Launch

- [ ] Claim Yelp business page
- [ ] Update Facebook business page NAP
- [ ] Run first AI visibility baseline measurement
- [ ] Add Spanish content to Home, Services, FAQ, Contact pages
- [ ] Implement hreflang annotations for Spanish content

### Month 3+ Post-Launch

- [ ] Second AI visibility measurement — compare to baseline
- [ ] Begin blog content targeting AI-friendly question formats
- [ ] Claim Foursquare listing
- [ ] Submit to Data Axle and Neustar/Localeze aggregators
- [ ] Add video transcripts to portfolio content

### Month 6+ Post-Launch

- [ ] Third AI visibility measurement — evaluate 3+ query goal
- [ ] Expand structured data (VideoObject, HowTo, Article)
- [ ] Begin earned media outreach
- [ ] Expand Spanish content based on query data
- [ ] Evaluate new AI platforms and add to measurement plan
