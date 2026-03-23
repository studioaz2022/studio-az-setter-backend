# Schema Markup — JSON-LD Structured Data

**Site:** tattooshopminneapolis.com
**Format:** JSON-LD (Google's preferred structured data format)
**Validation:** Test every block with [Google Rich Results Test](https://search.google.com/test/rich-results) + [Schema.org Validator](https://validator.schema.org/)

---

## Global Schema Rules

1. **Use `@graph` arrays** to combine multiple schema types on a single page.
2. **Use `@id` references** so entities cross-reference each other (e.g., `Person.worksFor` points to the `TattooParlor` `@id`).
3. **`openingHoursSpecification` must match GBP hours exactly** — any mismatch triggers Google trust penalties.
4. **Use the specific `@type: "TattooParlor"`** — this extends `HealthAndBeautyBusiness` which extends `LocalBusiness`. Never use generic `LocalBusiness`.
5. **`sameAs` links** point to all verified social profiles and the Google Maps URL.
6. **Every page gets a `BreadcrumbList`** for sitelinks in SERPs.
7. **Inject via `<script type="application/ld+json">`** in the `<head>` of each page.

---

## Shared Entity IDs

These `@id` values are used across pages for cross-referencing:

| Entity | @id |
|---|---|
| Business | `https://tattooshopminneapolis.com/#tattoo-parlor` |
| Organization | `https://tattooshopminneapolis.com/#organization` |
| Joan Martinez | `https://tattooshopminneapolis.com/artists/joan#person` |
| Andrew Fernandez | `https://tattooshopminneapolis.com/artists/andrew#person` |
| Website | `https://tattooshopminneapolis.com/#website` |

---

## 1. Home (`/`)

The homepage carries the heaviest schema — full business entity, organization, and breadcrumb.

```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TattooParlor",
      "@id": "https://tattooshopminneapolis.com/#tattoo-parlor",
      "name": "Studio AZ Tattoo",
      "url": "https://tattooshopminneapolis.com",
      "telephone": "+1-612-255-4439",
      "email": "support@studioaz.us",
      "description": "Custom tattoo studio in Minneapolis specializing in fine line, realism, black and grey, and cover-up tattoos. Bilingual artists (English & Spanish). Walk-ins welcome.",
      "image": "https://tattooshopminneapolis.com/images/studio-exterior.jpg",
      "logo": "https://assets.cdn.filesafe.space/GLRkNAxfPtWTqTiN83xj/media/69a5f238618c8d1afd552d67.png",
      "priceRange": "$$",
      "currenciesAccepted": "USD",
      "paymentAccepted": "Cash, Credit Card, Debit Card",
      "address": {
        "@type": "PostalAddress",
        "streetAddress": "333 Washington Ave N, STE 100",
        "addressLocality": "Minneapolis",
        "addressRegion": "MN",
        "postalCode": "55401",
        "addressCountry": "US"
      },
      "geo": {
        "@type": "GeoCoordinates",
        "latitude": 44.98445714702983,
        "longitude": -93.27393261534043
      },
      "openingHoursSpecification": [
        {
          "@type": "OpeningHoursSpecification",
          "dayOfWeek": "Monday",
          "opens": "10:00",
          "closes": "19:00"
        },
        {
          "@type": "OpeningHoursSpecification",
          "dayOfWeek": "Tuesday",
          "opens": "10:00",
          "closes": "19:00"
        },
        {
          "@type": "OpeningHoursSpecification",
          "dayOfWeek": "Wednesday",
          "opens": "10:00",
          "closes": "19:00"
        },
        {
          "@type": "OpeningHoursSpecification",
          "dayOfWeek": "Thursday",
          "opens": "10:00",
          "closes": "19:00"
        },
        {
          "@type": "OpeningHoursSpecification",
          "dayOfWeek": "Friday",
          "opens": "10:00",
          "closes": "19:00"
        },
        {
          "@type": "OpeningHoursSpecification",
          "dayOfWeek": "Saturday",
          "opens": "10:00",
          "closes": "17:00"
        }
      ],
      "areaServed": [
        {
          "@type": "City",
          "name": "Minneapolis",
          "sameAs": "https://en.wikipedia.org/wiki/Minneapolis"
        },
        {
          "@type": "City",
          "name": "Saint Paul",
          "sameAs": "https://en.wikipedia.org/wiki/Saint_Paul,_Minnesota"
        },
        {
          "@type": "State",
          "name": "Minnesota",
          "sameAs": "https://en.wikipedia.org/wiki/Minnesota"
        }
      ],
      "knowsLanguage": ["en", "es"],
      "hasOfferCatalog": {
        "@type": "OfferCatalog",
        "name": "Tattoo Services",
        "itemListElement": [
          {
            "@type": "OfferCatalog",
            "name": "Custom Tattoos",
            "itemListElement": [
              {
                "@type": "Offer",
                "itemOffered": {
                  "@type": "Service",
                  "name": "Custom Tattoo Design & Application"
                }
              }
            ]
          },
          {
            "@type": "OfferCatalog",
            "name": "Cover-Up Tattoos",
            "itemListElement": [
              {
                "@type": "Offer",
                "itemOffered": {
                  "@type": "Service",
                  "name": "Tattoo Cover-Up"
                }
              }
            ]
          },
          {
            "@type": "OfferCatalog",
            "name": "Consultations",
            "itemListElement": [
              {
                "@type": "Offer",
                "itemOffered": {
                  "@type": "Service",
                  "name": "Free Tattoo Consultation"
                }
              }
            ]
          }
        ]
      },
      "sameAs": [
        "https://www.instagram.com/studioaztattoo/",
        "https://www.google.com/maps/place/Studio+AZ+Tattoo/"
      ],
      "employee": [
        { "@id": "https://tattooshopminneapolis.com/artists/joan#person" },
        { "@id": "https://tattooshopminneapolis.com/artists/andrew#person" }
      ]
    },
    {
      "@type": "Organization",
      "@id": "https://tattooshopminneapolis.com/#organization",
      "name": "Studio AZ Tattoo",
      "url": "https://tattooshopminneapolis.com",
      "logo": {
        "@type": "ImageObject",
        "url": "https://assets.cdn.filesafe.space/GLRkNAxfPtWTqTiN83xj/media/69a5f238618c8d1afd552d67.png",
        "width": 600,
        "height": 600
      },
      "contactPoint": {
        "@type": "ContactPoint",
        "telephone": "+1-612-255-4439",
        "contactType": "customer service",
        "availableLanguage": ["English", "Spanish"],
        "areaServed": "US"
      },
      "sameAs": [
        "https://www.instagram.com/studioaztattoo/",
        "https://www.google.com/maps/place/Studio+AZ+Tattoo/"
      ]
    },
    {
      "@type": "WebSite",
      "@id": "https://tattooshopminneapolis.com/#website",
      "name": "Studio AZ Tattoo",
      "url": "https://tattooshopminneapolis.com",
      "publisher": {
        "@id": "https://tattooshopminneapolis.com/#organization"
      },
      "inLanguage": ["en", "es"]
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Home",
          "item": "https://tattooshopminneapolis.com"
        }
      ]
    }
  ]
}
```

<!--
  AGGREGATE RATING — ACTIVATE WHEN 10+ GOOGLE REVIEWS

  Currently at 5.0 stars with 9 reviews. Google may flag AggregateRating
  markup if the review count is low and doesn't match their index. Enable
  this block once reviews reach 10+ and the rating stabilizes.

  Add this object to the @graph array above:

  {
    "@type": "AggregateRating",
    "itemReviewed": {
      "@id": "https://tattooshopminneapolis.com/#tattoo-parlor"
    },
    "ratingValue": "5.0",
    "bestRating": "5",
    "worstRating": "1",
    "ratingCount": "9",
    "reviewCount": "9"
  }

  UPDATE ratingValue and ratingCount/reviewCount to match GBP exactly
  before enabling. Mismatched numbers = manual action risk.
-->

---

## 2. Services (`/services`)

```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Service",
      "name": "Custom Tattoos",
      "description": "Fully custom tattoo designs created by our artists based on your vision. We specialize in fine line, realism, black and grey, color, and illustrative styles.",
      "provider": {
        "@id": "https://tattooshopminneapolis.com/#tattoo-parlor"
      },
      "areaServed": {
        "@type": "City",
        "name": "Minneapolis"
      },
      "offers": {
        "@type": "Offer",
        "priceCurrency": "USD",
        "description": "Starting at $100. Final price depends on size, detail, and placement. Free consultation available.",
        "availability": "https://schema.org/InStock",
        "url": "https://tattooshopminneapolis.com/services"
      },
      "serviceType": "Custom Tattoo Design and Application"
    },
    {
      "@type": "Service",
      "name": "Cover-Up Tattoos",
      "description": "Expert cover-up tattoos to transform or conceal existing tattoos. Our artists assess your current tattoo and design a new piece that fully integrates or hides the original.",
      "provider": {
        "@id": "https://tattooshopminneapolis.com/#tattoo-parlor"
      },
      "areaServed": {
        "@type": "City",
        "name": "Minneapolis"
      },
      "offers": {
        "@type": "Offer",
        "priceCurrency": "USD",
        "description": "Starting at $150. Consultation required to assess the existing tattoo and plan the cover-up design.",
        "availability": "https://schema.org/InStock",
        "url": "https://tattooshopminneapolis.com/services"
      },
      "serviceType": "Tattoo Cover-Up"
    },
    {
      "@type": "Service",
      "name": "Tattoo Consultations",
      "description": "Free in-person or virtual consultations to discuss your tattoo idea, placement, sizing, and pricing. No obligation — just a conversation about your vision.",
      "provider": {
        "@id": "https://tattooshopminneapolis.com/#tattoo-parlor"
      },
      "areaServed": {
        "@type": "City",
        "name": "Minneapolis"
      },
      "offers": {
        "@type": "Offer",
        "priceCurrency": "USD",
        "price": "0",
        "description": "Free consultation — no deposit required until you're ready to book.",
        "availability": "https://schema.org/InStock",
        "url": "https://tattooshopminneapolis.com/services"
      },
      "serviceType": "Tattoo Consultation"
    },
    {
      "@type": "Service",
      "name": "Touch-Up Tattoos",
      "description": "Touch-up service for tattoos that need color refreshing, line sharpening, or minor corrections. Available for tattoos done at Studio AZ and other shops.",
      "provider": {
        "@id": "https://tattooshopminneapolis.com/#tattoo-parlor"
      },
      "areaServed": {
        "@type": "City",
        "name": "Minneapolis"
      },
      "offers": {
        "@type": "Offer",
        "priceCurrency": "USD",
        "description": "Free touch-ups within 3 months for Studio AZ tattoos. Outside touch-ups starting at $50.",
        "availability": "https://schema.org/InStock",
        "url": "https://tattooshopminneapolis.com/services"
      },
      "serviceType": "Tattoo Touch-Up"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Home",
          "item": "https://tattooshopminneapolis.com"
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "Services",
          "item": "https://tattooshopminneapolis.com/services"
        }
      ]
    }
  ]
}
```

---

## 3. Artists Index (`/artists`)

```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "ItemList",
      "name": "Tattoo Artists at Studio AZ",
      "description": "Meet the tattoo artists at Studio AZ Tattoo in Minneapolis.",
      "numberOfItems": 2,
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "item": {
            "@type": "Person",
            "@id": "https://tattooshopminneapolis.com/artists/joan#person",
            "name": "Joan Martinez",
            "jobTitle": "Tattoo Artist",
            "url": "https://tattooshopminneapolis.com/artists/joan",
            "image": "https://tattooshopminneapolis.com/images/artists/joan-martinez.jpg",
            "worksFor": {
              "@id": "https://tattooshopminneapolis.com/#tattoo-parlor"
            }
          }
        },
        {
          "@type": "ListItem",
          "position": 2,
          "item": {
            "@type": "Person",
            "@id": "https://tattooshopminneapolis.com/artists/andrew#person",
            "name": "Andrew Fernandez",
            "jobTitle": "Tattoo Artist",
            "url": "https://tattooshopminneapolis.com/artists/andrew",
            "image": "https://tattooshopminneapolis.com/images/artists/andrew-fernandez.jpg",
            "worksFor": {
              "@id": "https://tattooshopminneapolis.com/#tattoo-parlor"
            }
          }
        }
      ]
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Home",
          "item": "https://tattooshopminneapolis.com"
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "Artists",
          "item": "https://tattooshopminneapolis.com/artists"
        }
      ]
    }
  ]
}
```

---

## 4. Joan Martinez (`/artists/joan`)

```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Person",
      "@id": "https://tattooshopminneapolis.com/artists/joan#person",
      "name": "Joan Martinez",
      "jobTitle": "Tattoo Artist",
      "description": "Joan Martinez is a tattoo artist at Studio AZ Tattoo in Minneapolis specializing in fine line, realism, and black and grey tattoos.",
      "url": "https://tattooshopminneapolis.com/artists/joan",
      "image": "https://tattooshopminneapolis.com/images/artists/joan-martinez.jpg",
      "worksFor": {
        "@id": "https://tattooshopminneapolis.com/#tattoo-parlor"
      },
      "knowsAbout": [
        "Fine Line Tattoos",
        "Realism Tattoos",
        "Black and Grey Tattoos"
      ],
      "knowsLanguage": ["en", "es"],
      "sameAs": [
        "https://www.instagram.com/joanmartineztattoo/"
      ]
    },
    {
      "@type": "ImageGallery",
      "name": "Joan Martinez — Tattoo Portfolio",
      "description": "Portfolio of fine line, realism, and black and grey tattoos by Joan Martinez at Studio AZ Tattoo, Minneapolis.",
      "url": "https://tattooshopminneapolis.com/artists/joan",
      "creator": {
        "@id": "https://tattooshopminneapolis.com/artists/joan#person"
      },
      "image": [
        {
          "@type": "ImageObject",
          "name": "Fine Line Rose Tattoo by Joan Martinez",
          "description": "Delicate fine line rose tattoo on the forearm. Single needle work with soft shading.",
          "contentUrl": "https://tattooshopminneapolis.com/images/gallery/joan/fine-line-rose.jpg",
          "thumbnailUrl": "https://tattooshopminneapolis.com/images/gallery/joan/thumbs/fine-line-rose.jpg",
          "creator": {
            "@id": "https://tattooshopminneapolis.com/artists/joan#person"
          },
          "keywords": ["fine line tattoo", "rose tattoo", "forearm tattoo", "Minneapolis tattoo"]
        }
        /*
          IMPLEMENTATION NOTE: Duplicate this ImageObject template for each
          portfolio piece. Use descriptive names and alt-text-quality descriptions.
          Keywords should include: style + subject + body placement + "Minneapolis tattoo".
          Aim for 6-12 images per artist for initial launch.
        */
      ]
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Home",
          "item": "https://tattooshopminneapolis.com"
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "Artists",
          "item": "https://tattooshopminneapolis.com/artists"
        },
        {
          "@type": "ListItem",
          "position": 3,
          "name": "Joan Martinez",
          "item": "https://tattooshopminneapolis.com/artists/joan"
        }
      ]
    }
  ]
}
```

---

## 5. Andrew Fernandez (`/artists/andrew`)

```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Person",
      "@id": "https://tattooshopminneapolis.com/artists/andrew#person",
      "name": "Andrew Fernandez",
      "jobTitle": "Tattoo Artist",
      "description": "Andrew Fernandez is a tattoo artist at Studio AZ Tattoo in Minneapolis specializing in small tattoos, first tattoos, and custom designs.",
      "url": "https://tattooshopminneapolis.com/artists/andrew",
      "image": "https://tattooshopminneapolis.com/images/artists/andrew-fernandez.jpg",
      "worksFor": {
        "@id": "https://tattooshopminneapolis.com/#tattoo-parlor"
      },
      "knowsAbout": [
        "Small Tattoos",
        "First Tattoos",
        "Custom Designs"
      ],
      "knowsLanguage": ["en", "es"],
      "sameAs": [
        "https://www.instagram.com/andrewfernandeztattoo/"
      ]
    },
    {
      "@type": "ImageGallery",
      "name": "Andrew Fernandez — Tattoo Portfolio",
      "description": "Portfolio of small tattoos, first tattoos, and custom designs by Andrew Fernandez at Studio AZ Tattoo, Minneapolis.",
      "url": "https://tattooshopminneapolis.com/artists/andrew",
      "creator": {
        "@id": "https://tattooshopminneapolis.com/artists/andrew#person"
      },
      "image": [
        {
          "@type": "ImageObject",
          "name": "Minimalist Butterfly Tattoo by Andrew Fernandez",
          "description": "Small minimalist butterfly tattoo on the wrist. Clean lines with delicate detail — ideal first tattoo.",
          "contentUrl": "https://tattooshopminneapolis.com/images/gallery/andrew/minimalist-butterfly.jpg",
          "thumbnailUrl": "https://tattooshopminneapolis.com/images/gallery/andrew/thumbs/minimalist-butterfly.jpg",
          "creator": {
            "@id": "https://tattooshopminneapolis.com/artists/andrew#person"
          },
          "keywords": ["small tattoo", "butterfly tattoo", "wrist tattoo", "first tattoo", "Minneapolis tattoo"]
        }
        /*
          IMPLEMENTATION NOTE: Same template pattern as Joan's gallery.
          Duplicate for each portfolio image. Andrew's keywords should
          emphasize "small tattoo", "first tattoo", "beginner-friendly"
          to match his specialization and target search queries.
        */
      ]
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Home",
          "item": "https://tattooshopminneapolis.com"
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "Artists",
          "item": "https://tattooshopminneapolis.com/artists"
        },
        {
          "@type": "ListItem",
          "position": 3,
          "name": "Andrew Fernandez",
          "item": "https://tattooshopminneapolis.com/artists/andrew"
        }
      ]
    }
  ]
}
```

---

## 6. Gallery (`/gallery`)

```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "ImageGallery",
      "name": "Tattoo Gallery — Studio AZ Tattoo Minneapolis",
      "description": "Browse tattoo work from Studio AZ Tattoo artists in Minneapolis. Fine line, realism, black and grey, custom designs, cover-ups, and small tattoos.",
      "url": "https://tattooshopminneapolis.com/gallery",
      "creator": {
        "@id": "https://tattooshopminneapolis.com/#organization"
      },
      "image": [
        {
          "@type": "ImageObject",
          "name": "Black and Grey Portrait Tattoo",
          "description": "Photorealistic black and grey portrait tattoo on the upper arm by Joan Martinez at Studio AZ Tattoo.",
          "contentUrl": "https://tattooshopminneapolis.com/images/gallery/portrait-tattoo.jpg",
          "thumbnailUrl": "https://tattooshopminneapolis.com/images/gallery/thumbs/portrait-tattoo.jpg",
          "creator": {
            "@id": "https://tattooshopminneapolis.com/artists/joan#person"
          },
          "keywords": ["portrait tattoo", "black and grey", "realism tattoo", "upper arm tattoo", "Minneapolis tattoo artist"]
        },
        {
          "@type": "ImageObject",
          "name": "Small Floral Wrist Tattoo",
          "description": "Dainty floral tattoo on the inner wrist by Andrew Fernandez. Fine line work with minimal shading.",
          "contentUrl": "https://tattooshopminneapolis.com/images/gallery/floral-wrist.jpg",
          "thumbnailUrl": "https://tattooshopminneapolis.com/images/gallery/thumbs/floral-wrist.jpg",
          "creator": {
            "@id": "https://tattooshopminneapolis.com/artists/andrew#person"
          },
          "keywords": ["floral tattoo", "wrist tattoo", "small tattoo", "fine line", "Minneapolis tattoo"]
        }
        /*
          IMPLEMENTATION NOTE: Add one ImageObject per gallery image.
          Required fields per image:
            - name: Descriptive title (style + subject + placement)
            - description: 1-2 sentences, natural language, include artist name
            - contentUrl: Full-size image URL
            - thumbnailUrl: Thumbnail URL (for Google Image search)
            - creator: @id reference to the artist Person entity
            - keywords: Array of 4-6 terms matching target search queries

          For best Google Images performance:
            - Use descriptive filenames (not IMG_4532.jpg)
            - Serve WebP with JPG fallback
            - Include width/height attributes to avoid CLS
        */
      ]
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Home",
          "item": "https://tattooshopminneapolis.com"
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "Gallery",
          "item": "https://tattooshopminneapolis.com/gallery"
        }
      ]
    }
  ]
}
```

---

## 7. Aftercare (`/aftercare`)

```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Tattoo Aftercare Instructions — Studio AZ Tattoo Minneapolis",
      "description": "Complete tattoo aftercare guide from Studio AZ Tattoo. Day-by-day healing instructions for the first 30 days after getting your tattoo.",
      "author": {
        "@id": "https://tattooshopminneapolis.com/#organization"
      },
      "publisher": {
        "@id": "https://tattooshopminneapolis.com/#organization"
      },
      "datePublished": "2026-03-23",
      "dateModified": "2026-03-23",
      "mainEntityOfPage": "https://tattooshopminneapolis.com/aftercare",
      "url": "https://tattooshopminneapolis.com/aftercare",
      "image": "https://tattooshopminneapolis.com/images/aftercare-hero.jpg",
      "inLanguage": "en"
    },
    {
      "@type": "HowTo",
      "name": "How to Care for a New Tattoo",
      "description": "Step-by-step tattoo aftercare instructions for the first 30 days. Follow these steps to ensure your tattoo heals properly and retains its detail.",
      "totalTime": "P30D",
      "supply": [
        {
          "@type": "HowToSupply",
          "name": "Fragrance-free antibacterial soap"
        },
        {
          "@type": "HowToSupply",
          "name": "Fragrance-free moisturizer or tattoo-specific aftercare balm"
        },
        {
          "@type": "HowToSupply",
          "name": "Clean paper towels"
        }
      ],
      "step": [
        {
          "@type": "HowToStep",
          "name": "Days 1-3: Initial Healing",
          "position": 1,
          "text": "Remove the bandage after 2-4 hours (or as instructed by your artist). Gently wash the tattoo with lukewarm water and fragrance-free antibacterial soap. Pat dry with a clean paper towel — never rub. Apply a thin layer of fragrance-free moisturizer. Wash and moisturize 2-3 times daily. Expect redness, swelling, and some oozing — this is normal.",
          "url": "https://tattooshopminneapolis.com/aftercare#days-1-3"
        },
        {
          "@type": "HowToStep",
          "name": "Days 4-14: Peeling & Itching Phase",
          "position": 2,
          "text": "Your tattoo will begin to peel and flake — this is normal healing. DO NOT pick, scratch, or peel the flaking skin. Continue washing gently 2-3 times daily and applying thin layers of moisturizer. Itching is common — lightly slap the area instead of scratching. Avoid soaking (no baths, pools, or hot tubs). Avoid direct sunlight on the tattoo.",
          "url": "https://tattooshopminneapolis.com/aftercare#days-4-14"
        },
        {
          "@type": "HowToStep",
          "name": "Days 15-30: Final Healing",
          "position": 3,
          "text": "The outer skin has healed but deeper layers are still recovering. Continue moisturizing daily. The tattoo may look slightly cloudy or dull — this is normal and will clear as the skin fully heals. You can resume normal activities but continue avoiding prolonged sun exposure. Apply SPF 30+ sunscreen on the tattoo whenever it will be exposed to sun. If you notice any areas that need a touch-up, wait the full 30 days before scheduling one.",
          "url": "https://tattooshopminneapolis.com/aftercare#days-15-30"
        }
      ]
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Home",
          "item": "https://tattooshopminneapolis.com"
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "Aftercare",
          "item": "https://tattooshopminneapolis.com/aftercare"
        }
      ]
    }
  ]
}
```

> **Implementation note:** The `HowTo` schema is a featured snippet magnet for queries like "tattoo aftercare instructions" and "how to care for a new tattoo." Google may display the steps directly in search results.

---

## 8. Parking (`/parking`)

```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Parking & Directions — Studio AZ Tattoo Minneapolis",
      "description": "How to find Studio AZ Tattoo and where to park in the North Loop / Warehouse District area of Minneapolis. Parking lot, street parking, and public transit options.",
      "author": {
        "@id": "https://tattooshopminneapolis.com/#organization"
      },
      "publisher": {
        "@id": "https://tattooshopminneapolis.com/#organization"
      },
      "datePublished": "2026-03-23",
      "dateModified": "2026-03-23",
      "mainEntityOfPage": "https://tattooshopminneapolis.com/parking",
      "url": "https://tattooshopminneapolis.com/parking",
      "image": "https://tattooshopminneapolis.com/images/parking-map.jpg",
      "inLanguage": "en"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Home",
          "item": "https://tattooshopminneapolis.com"
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "Parking & Directions",
          "item": "https://tattooshopminneapolis.com/parking"
        }
      ]
    }
  ]
}
```

---

## 9. FAQ (`/faq`)

```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "How much does a tattoo cost at Studio AZ?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Tattoo pricing depends on size, detail, placement, and time. Small tattoos start around $100. Medium tattoos typically range from $200-$500. Large or highly detailed pieces are quoted during a free consultation. We don't charge by the hour — you'll get a flat price before we start."
          }
        },
        {
          "@type": "Question",
          "name": "Do you require a deposit to book a tattoo appointment?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes, we require a non-refundable deposit to secure your appointment. The deposit amount varies by project size and is applied toward the total cost of your tattoo. This protects both the artist's time spent designing your piece and your reserved time slot."
          }
        },
        {
          "@type": "Question",
          "name": "Do you accept walk-ins?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes, we welcome walk-ins when our artists have availability. For the best experience, we recommend booking a consultation or appointment in advance, especially for larger or custom pieces. Walk-ins are ideal for smaller, simpler designs."
          }
        },
        {
          "@type": "Question",
          "name": "What is the minimum age requirement for a tattoo?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "You must be 18 years or older with a valid government-issued photo ID. Minnesota law prohibits tattooing minors, even with parental consent. We check ID for every client, no exceptions."
          }
        },
        {
          "@type": "Question",
          "name": "How painful is getting a tattoo?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Pain varies by person and body placement. Bony areas (ribs, ankles, spine) tend to be more sensitive, while fleshier areas (upper arm, thigh, calf) are generally more comfortable. Most clients describe the sensation as a scratching or vibrating feeling. Our artists work at a comfortable pace and can take breaks as needed."
          }
        },
        {
          "@type": "Question",
          "name": "How should I prepare for my tattoo appointment?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Get a good night's sleep, eat a full meal before your appointment, and stay hydrated. Avoid alcohol and blood thinners for 24 hours before your session. Wear comfortable clothing that allows easy access to the tattoo area. Bring your ID and deposit confirmation."
          }
        },
        {
          "@type": "Question",
          "name": "How do I care for my new tattoo?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Keep the tattoo clean and moisturized for 30 days. Wash gently with fragrance-free soap 2-3 times daily, pat dry, and apply a thin layer of fragrance-free moisturizer. Don't pick at peeling skin, avoid soaking in water, and keep it out of direct sunlight. See our full aftercare guide at tattooshopminneapolis.com/aftercare."
          }
        },
        {
          "@type": "Question",
          "name": "What tattoo styles do your artists specialize in?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Joan Martinez specializes in fine line, realism, and black and grey tattoos. Andrew Fernandez specializes in small tattoos, first tattoos, and custom designs. Together we cover a wide range of styles including illustrative, geometric, lettering, floral, and portrait work."
          }
        },
        {
          "@type": "Question",
          "name": "How do I book a consultation?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "You can book a free consultation through our website, by calling us at (612) 255-4439, or by sending us a DM on Instagram @studioaztattoo. During the consultation we'll discuss your design idea, placement, sizing, and pricing with no obligation to book."
          }
        },
        {
          "@type": "Question",
          "name": "Where do I park when visiting Studio AZ Tattoo?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "We're located at 333 Washington Ave N in the North Loop / Warehouse District. Street parking is available on Washington Ave and surrounding blocks. There are also several paid parking lots and ramps within a short walk. See our parking page at tattooshopminneapolis.com/parking for a detailed guide."
          }
        },
        {
          "@type": "Question",
          "name": "Do you have Spanish-speaking tattoo artists?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes! Both of our artists — Joan Martinez and Andrew Fernandez — are fluent in English and Spanish. We're happy to conduct consultations and tattoo sessions entirely in Spanish. Hablamos espanol."
          }
        },
        {
          "@type": "Question",
          "name": "Do you offer free touch-ups?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes, we offer free touch-ups within 3 months of your tattoo session for work done at Studio AZ. This covers any areas where ink didn't take evenly during the healing process. Touch-ups for tattoos from other shops start at $50."
          }
        },
        {
          "@type": "Question",
          "name": "How does the custom tattoo design process work?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "After your consultation and deposit, your artist creates a custom design based on your ideas and reference images. You'll see the design before your appointment and can request revisions. On the day of your session, the artist places a stencil so you can approve the size and placement before any ink hits skin."
          }
        },
        {
          "@type": "Question",
          "name": "How long does a tattoo appointment take?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Small tattoos typically take 1-2 hours including prep and stencil placement. Medium pieces run 2-4 hours. Large or highly detailed tattoos may require multiple sessions of 3-5 hours each. Your artist will give you a time estimate during your consultation."
          }
        },
        {
          "@type": "Question",
          "name": "Can you cover up an old tattoo?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes, cover-ups are one of our specialties. During a consultation, your artist will assess the existing tattoo's size, color density, and placement to determine what cover-up options will work best. Some old tattoos may benefit from a laser lightening session first for the best results."
          }
        },
        {
          "@type": "Question",
          "name": "What forms of payment do you accept?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "We accept cash, all major credit cards, and debit cards. Deposits can be paid online via our secure payment link. Tips are appreciated and can be added to your card payment or given in cash."
          }
        },
        {
          "@type": "Question",
          "name": "Can I bring a friend to my tattoo appointment?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Absolutely. You're welcome to bring one friend or family member for support. We just ask that they're respectful of the studio space and other clients. For longer sessions, your guest should bring something to keep themselves occupied."
          }
        },
        {
          "@type": "Question",
          "name": "Do you do tattoos for people who have never been tattooed before?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes, we love working with first-timers! Andrew Fernandez specializes in first tattoos and will walk you through the entire process. We'll help you choose a design, placement, and size that's right for your first piece. There's no judgment — everyone starts somewhere."
          }
        }
      ]
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Home",
          "item": "https://tattooshopminneapolis.com"
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "FAQ",
          "item": "https://tattooshopminneapolis.com/faq"
        }
      ]
    }
  ]
}
```

> **Implementation note:** `FAQPage` schema is one of the highest-value rich result types. Google displays these as expandable Q&A dropdowns directly in search results, significantly increasing SERP real estate. These 17 questions target high-volume "tattoo shop" queries and long-tail informational intent.

---

## 10. Contact (`/contact`)

The Contact page intentionally duplicates the `TattooParlor` NAP from the homepage. This is standard local SEO practice — Google uses NAP consistency across multiple pages as a trust signal. Do not try to deduplicate this.

```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TattooParlor",
      "@id": "https://tattooshopminneapolis.com/#tattoo-parlor",
      "name": "Studio AZ Tattoo",
      "url": "https://tattooshopminneapolis.com",
      "telephone": "+1-612-255-4439",
      "email": "support@studioaz.us",
      "image": "https://tattooshopminneapolis.com/images/studio-exterior.jpg",
      "address": {
        "@type": "PostalAddress",
        "streetAddress": "333 Washington Ave N, STE 100",
        "addressLocality": "Minneapolis",
        "addressRegion": "MN",
        "postalCode": "55401",
        "addressCountry": "US"
      },
      "geo": {
        "@type": "GeoCoordinates",
        "latitude": 44.98445714702983,
        "longitude": -93.27393261534043
      },
      "openingHoursSpecification": [
        {
          "@type": "OpeningHoursSpecification",
          "dayOfWeek": "Monday",
          "opens": "10:00",
          "closes": "19:00"
        },
        {
          "@type": "OpeningHoursSpecification",
          "dayOfWeek": "Tuesday",
          "opens": "10:00",
          "closes": "19:00"
        },
        {
          "@type": "OpeningHoursSpecification",
          "dayOfWeek": "Wednesday",
          "opens": "10:00",
          "closes": "19:00"
        },
        {
          "@type": "OpeningHoursSpecification",
          "dayOfWeek": "Thursday",
          "opens": "10:00",
          "closes": "19:00"
        },
        {
          "@type": "OpeningHoursSpecification",
          "dayOfWeek": "Friday",
          "opens": "10:00",
          "closes": "19:00"
        },
        {
          "@type": "OpeningHoursSpecification",
          "dayOfWeek": "Saturday",
          "opens": "10:00",
          "closes": "17:00"
        }
      ],
      "sameAs": [
        "https://www.instagram.com/studioaztattoo/",
        "https://www.google.com/maps/place/Studio+AZ+Tattoo/"
      ]
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Home",
          "item": "https://tattooshopminneapolis.com"
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "Contact",
          "item": "https://tattooshopminneapolis.com/contact"
        }
      ]
    }
  ]
}
```

---

## Implementation Checklist

- [ ] Inject each JSON-LD block into `<script type="application/ld+json">` in the page's `<head>`
- [ ] Replace all placeholder image URLs with real production URLs
- [ ] Replace placeholder Instagram URLs for artists with real profile URLs
- [ ] Update `datePublished` / `dateModified` on Article schemas to match actual publish dates
- [ ] Validate every page with [Google Rich Results Test](https://search.google.com/test/rich-results)
- [ ] Validate every page with [Schema.org Validator](https://validator.schema.org/)
- [ ] Cross-check `openingHoursSpecification` against Google Business Profile — must match exactly
- [ ] Enable `AggregateRating` block on homepage once Google reviews reach 10+
- [ ] Populate gallery `ImageObject` entries with real portfolio images (6-12 per artist minimum)
- [ ] Test FAQ rich results appearance in Google Search Console after indexing
- [ ] Monitor Search Console for structured data errors/warnings weekly for the first month
