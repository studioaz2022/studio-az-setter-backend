# Studio AZ Tattoo — Site Map

**Domain:** tattooshopminneapolis.com
**Stack:** Next.js + TypeScript + Tailwind CSS + ShadCN | Hosted on Vercel
**Status:** Phase 0 complete — page list locked

## Pages

| Page | URL | Purpose | Buyer Stage |
|------|-----|---------|-------------|
| Home | `/` | Hero, value prop, services preview, portfolio highlights, reviews snippet, CTAs | Mid |
| Services | `/services` | Tattoo styles offered, pricing guidance, what to expect, process overview | Mid → Late |
| Artists (index) | `/artists` | Both artists side by side with bios, "not sure which artist?" general inquiry CTA | Mid |
| Joan Martinez | `/artists/joan` | Full bio, specialty, portfolio gallery, Instagram, consultation form embed | Late |
| Andrew Fernandez | `/artists/andrew` | Full bio, specialty, portfolio gallery, Instagram, consultation form embed | Late |
| Gallery | `/gallery` | Full portfolio — filterable by artist and/or style | Mid |
| Aftercare | `/aftercare` | Tattoo aftercare guide (SEO content page, snippet-targeted) | Early |
| Parking & Directions | `/parking` | Parking options with diagrams, Google/Apple Maps links, building entry, skyway | Late |
| FAQ | `/faq` | Pricing, deposits, walk-in policy, age requirements, touch-ups, consultation process | Early → Mid |
| Contact | `/contact` | Hours, address, phone, general inquiry form, embedded Google Map | Late |

## Content Targets

| Page | Word Count | Schema Types |
|------|-----------|--------------|
| Home | 1,500–2,000 | TattooParlor, Organization, BreadcrumbList |
| Services | 800–1,000 | Service, Offer, BreadcrumbList |
| Artists | 500–700 | ItemList, Person, BreadcrumbList |
| Joan | 400–500 + portfolio | Person, ImageGallery, BreadcrumbList |
| Andrew | 400–500 + portfolio | Person, ImageGallery, BreadcrumbList |
| Gallery | 200–300 + images | ImageGallery, ImageObject, BreadcrumbList |
| Aftercare | 1,000–1,500 | Article, HowTo, BreadcrumbList |
| Parking | 500–700 | Article, BreadcrumbList |
| FAQ | 1,500–2,000 | FAQPage, BreadcrumbList |
| Contact | 200–300 | TattooParlor, BreadcrumbList |
| **Total** | **~7,000–8,500** | |

## Booking Flow

```
Home → "Book Now" → /artists (choose artist or "not sure")
  → /artists/joan or /artists/andrew
    → Consultation widget (embedded multi-step form)
       1. Language (EN/ES)
       2. Timeline
       3. Size (with reference images)
       4. Coverage detail (if medium)
       5. Consultation method
       6. Name
       7. Contact info (phone, WhatsApp, email)
       8. Tattoo concept (name, summary, placement)
       9. Reference photo upload
       10. Style & color preference
       11. Submission → AI Setter Bot via GHL
       12. Optional: budget, first tattoo, notes
```

The consultation widget is bilingual (English/Spanish) and feeds into the GHL AI Setter pipeline.

## Site Architecture

```
Home (/)                          ← Hub page, all inner pages link back
├── Services (/services)          ← Links to: Artists, FAQ, Contact
├── Artists (/artists)            ← Links to: Joan, Andrew, Services, Gallery
│   ├── Joan (/artists/joan)      ← Links to: Artists, Gallery, Services, Contact
│   └── Andrew (/artists/andrew)  ← Links to: Artists, Gallery, Services, Contact
├── Gallery (/gallery)            ← Links to: Artists, Joan, Andrew, Services
├── Aftercare (/aftercare)        ← Links to: FAQ, Contact, Services
├── Parking (/parking)            ← Links to: Contact, Home
├── FAQ (/faq)                    ← Links to: Services, Artists, Aftercare, Contact
└── Contact (/contact)            ← Links to: Parking, Artists, Services
```

Every page reachable within 2 clicks. Primary nav: Home, Services, Artists, Gallery, Aftercare, FAQ, Contact (7 items). Parking accessible from footer and Contact page.

## Technical Files

| File | Path | Purpose |
|------|------|---------|
| robots.ts | `app/robots.ts` | Allow all crawlers including GPTBot, ClaudeBot, PerplexityBot |
| sitemap.ts | `app/sitemap.ts` | Dynamic sitemap with all 10 pages |
| llms.txt | `public/llms.txt` | AI crawler guidance (entity info, services, location) |
| manifest.json | `public/manifest.json` | PWA manifest for mobile |

## Artists

- **Joan Martinez** — tattooshopminneapolis.com/artists/joan
- **Andrew Fernandez** — tattooshopminneapolis.com/artists/andrew

## Business Info

- **Name:** Studio AZ Tattoo
- **Address:** 333 Washington Ave N, STE 100, Minneapolis, MN 55401
- **Phone:** +1 (612) 255-4439
- **Hours:** Mon–Fri 10am–7pm, Sat 10am–5pm
- **Neighborhood:** North Loop, Minneapolis
- **GPS:** 44.98445714702983, -93.27393261534043
- **Google Place ID:** ChIJt_vZnAAzs1IR5e7h5BUE0O0
- **Current Google Rating:** 5.0 (9 reviews)
- **Competitors to beat:** Uptown Tattoo (4.8, 165 reviews), Minneapolis Tattoo Shop (4.7, 464 reviews)

## Cross-Platform Presence (NAP Must Match Everywhere)

| Platform | Status | Priority |
|----------|--------|----------|
| Google Business Profile | Active | Critical |
| Website (this site) | Building | Critical |
| Yelp | Not claimed | High |
| Apple Business Connect | Not claimed | High |
| Bing Places | Not claimed | High (ChatGPT source) |
| Facebook Business | Active | Medium |
| Instagram | Active | Medium |
| Foursquare | Not claimed | Medium |
| BBB | Not listed | Low |
| Data Axle (aggregator) | Not submitted | Low |
| Neustar/Localeze (aggregator) | Not submitted | Low |
