# Tattoo Site — SEO Overrides

> Site-specific overrides for tattooshopminneapolis.com.
> All universal rules are in the shared `../SEO_PLAYBOOK.md` — this file only contains what differs.

---

## Business Identity

- **Brand Name:** Studio AZ Tattoo
- **Domain:** tattooshopminneapolis.com
- **GBP Primary Category:** Tattoo Shop
- **GBP Secondary Categories:** TBD
- **Schema @type:** `TattooParlor` (extends `HealthAndBeautyBusiness` → `LocalBusiness`)

## NAP (Must Be Identical Everywhere)

- **Name:** Studio AZ Tattoo
- **Address:** 333 Washington Ave N, STE 100, Minneapolis, MN 55401
- **Phone:** +1 (612) 255-4439
- **Hours:** Mon–Fri 10am–7pm, Sat 10am–5pm

## Location & Map

- **Neighborhood:** North Loop, Minneapolis
- **GPS:** 44.98445714702983, -93.27393261534043
- **Google Place ID:** ChIJt_vZnAAzs1IR5e7h5BUE0O0

## Competitive Landscape

- **Current Google Rating:** 5.0 (9 reviews)
- **Review gap:** Market leader avg ~350 reviews (39x gap)
- **SEO bar in market:** Very low — only Nokomis Tattoo has proper on-page SEO
- **Biggest advantage:** Exact-match domain (`tattooshopminneapolis.com` = #1 keyword)

## Domain Advantage (3 Kings Rule)

The domain literally IS the #1 keyword "tattoo shop Minneapolis." No competitor has this. This means:
- Do NOT repeat "tattoo" in URL slugs (already in domain)
- Every page automatically inherits keyword signal from the domain
- Combined with proper on-page SEO, this alone can push us past 6 of 8 competitors

## Industry-Specific Citation Directories

Beyond the universal list in SEO_PLAYBOOK.md:
- TattooCloud
- Tattoodo
- TattooNOW

## Content Specifics

- **Bilingual:** Spanish sections on key pages (Home, Services, FAQ, Contact) — zero competitors do this
- **Word count target:** 7,000–8,500 total across 10 pages
- **Aftercare page:** Day-by-day healing timeline with HowTo schema
- **FAQ page:** 15-20 questions targeting featured snippets

## Schema Per Page

| Page | Schema Types |
|------|-------------|
| Home | `TattooParlor`, `Organization`, `BreadcrumbList` |
| Services | `Service` + `Offer`, `BreadcrumbList` |
| Artists (index) | `ItemList` of `Person`, `BreadcrumbList` |
| Joan / Andrew | `Person` + `worksFor` + `knowsAbout` + `ImageGallery`, `BreadcrumbList` |
| Gallery | `ImageGallery` + `ImageObject`, `BreadcrumbList` |
| Aftercare | `Article` + `HowTo`, `BreadcrumbList` |
| Parking | `Article`, `BreadcrumbList` |
| FAQ | `FAQPage`, `BreadcrumbList` |
| Contact | `TattooParlor`, `BreadcrumbList` |

## Authority Link Targets

- AAD.org (American Academy of Dermatology) — aftercare science
- Wikipedia: Minneapolis, North Loop, Tattoo
- Minneapolis Chamber of Commerce
- Minnesota Department of Health (tattoo licensing)

## Social Profiles (for schema `sameAs`)

- Instagram: https://www.instagram.com/studioaztattoo/
- Google Maps: https://www.google.com/maps/place/Studio+AZ+Tattoo/

## AI Visibility Check Keywords

Quarterly check these on ChatGPT, Perplexity, Gemini:
- "tattoo shop Minneapolis"
- "best tattoo artist Minneapolis"
- "tattoo shop North Loop Minneapolis"
- "Studio AZ Tattoo"
