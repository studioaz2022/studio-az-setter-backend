# Internal Linking Strategy — tattooshopminneapolis.com

Complete internal linking architecture for all 10 pages. Every page reachable within 2 clicks from the homepage.

---

## 1. Link Architecture Overview

### Hub-and-Spoke Model

```
                              ┌─────────────┐
                              │   Home (/)   │
                              │  Hub Page    │
                              └──────┬───────┘
           ┌──────────┬──────────┬───┴───┬──────────┬──────────┬──────────┐
           ▼          ▼          ▼       ▼          ▼          ▼          ▼
      ┌─────────┐ ┌────────┐ ┌───────┐ ┌───────┐ ┌─────────┐ ┌─────┐ ┌────────┐
      │Services │ │Artists │ │Gallery│ │After- │ │Parking  │ │ FAQ │ │Contact │
      │/services│ │/artists│ │/gal.. │ │ care  │ │/parking │ │/faq │ │/contact│
      └─────────┘ └───┬────┘ └───────┘ └───────┘ └─────────┘ └─────┘ └────────┘
                      │
              ┌───────┴───────┐
              ▼               ▼
        ┌───────────┐  ┌───────────────┐
        │   Joan    │  │    Andrew     │
        │/artists/  │  │/artists/     │
        │  joan     │  │  andrew      │
        └───────────┘  └───────────────┘
```

### Core Principles

- **Every page links back to the homepage** via the primary nav logo or breadcrumb. The homepage is the authority hub.
- **Cross-links connect related pages only.** Services, Artists, and Gallery form a topic cluster. Aftercare and FAQ form a separate cluster. Don't create unrelated cross-links (e.g., Parking to Gallery) that confuse Google's topic understanding.
- **Max click depth: 2.** Artist sub-pages (Joan, Andrew) are the deepest at 2 clicks from Home. All other pages are 1 click.
- **Link density target: 3-5 internal links per 1,000 words.** More links on long-form pages (Home, FAQ, Aftercare), fewer on short pages (Gallery, Contact).

---

## 2. Anchor Text Ratio

| Anchor Type | Target Ratio | When to Use | Example |
|---|---|---|---|
| **Target Anchor** (keyword-rich) | 50% | Highest search volume keywords. Use the page's primary keyword as the anchor. | "custom tattoo Minneapolis", "tattoo aftercare guide" |
| **Generic** | 25% | Supporting links, secondary mentions, CTAs. | "learn more", "read the full guide", "see details", "find out here" |
| **Brand/URL** | 25% | Brand mentions, trust signals, footer links. | "Studio AZ Tattoo", "tattooshopminneapolis.com" |

### Anchor Text Rules

1. If a section has **only 1 link**, make it a Target Anchor.
2. Place links inside **contextual sentences**, not in generic "Related Links" blocks.
3. **Never use the same exact anchor text** for two different destination pages.
4. **Vary anchor text** across pages linking to the same destination (e.g., link to Services as "custom tattoo Minneapolis" from one page and "tattoo services" from another).
5. First mention of a keyword on a page gets the link. Don't link every occurrence.

---

## 3. Per-Page Link Map

### 3.1 Home (`/`)

**Word count:** 1,500-2,000 | **Target link count:** 5-10 internal links

#### Links FROM Home

| # | Destination | Anchor Text | Anchor Type | Placement |
|---|---|---|---|---|
| 1 | /services | "custom tattoo Minneapolis" | Target | Hero section CTA or intro paragraph |
| 2 | /artists | "tattoo artists" | Target | "Meet our tattoo artists" section |
| 3 | /artists/joan | "Joan Martinez" | Target | Artist preview card |
| 4 | /artists/andrew | "Andrew Fernandez" | Target | Artist preview card |
| 5 | /gallery | "tattoo portfolio" | Target | Gallery preview section |
| 6 | /aftercare | "read our aftercare guide" | Generic | Body copy about the tattoo experience |
| 7 | /faq | "frequently asked questions" | Target | FAQ preview or body copy |
| 8 | /contact | "book a consultation" | Target | Primary CTA button |
| 9 | /parking | "parking and directions" | Target | Location section near bottom |

#### Links TO Home (from other pages)

Every page links to Home via:
- Primary nav logo click
- Breadcrumb first item ("Home")
- Footer brand name link

No additional in-body links to Home are needed; nav and breadcrumb handle it.

---

### 3.2 Services (`/services`)

**Word count:** 800-1,000 | **Target link count:** 3-5 internal links

#### Links FROM Services

| # | Destination | Anchor Text | Anchor Type | Placement |
|---|---|---|---|---|
| 1 | /artists | "our artists" | Target | "Our artists specialize in..." sentence |
| 2 | /faq | "see our FAQ" | Generic | Pricing section or bottom of page |
| 3 | /contact | "book a consultation" | Target | CTA at bottom of page |
| 4 | /gallery | "browse our portfolio" | Generic | After describing styles offered |

#### Links TO Services

| From Page | Anchor Text | Anchor Type |
|---|---|---|
| Home | "custom tattoo Minneapolis" | Target |
| Artists | "tattoo services" | Target |
| Joan | "tattoo services" | Target |
| Andrew | "custom tattoo Minneapolis" | Target |
| Gallery | "our services" | Generic |
| Aftercare | "tattoo services" | Target |
| FAQ | "services page" | Generic |
| Contact | "tattoo services" | Target |

---

### 3.3 Artists (`/artists`)

**Word count:** 500-700 | **Target link count:** 2-4 internal links

#### Links FROM Artists

| # | Destination | Anchor Text | Anchor Type | Placement |
|---|---|---|---|---|
| 1 | /artists/joan | "Joan Martinez" | Target | Joan's artist card |
| 2 | /artists/andrew | "Andrew Fernandez" | Target | Andrew's artist card |
| 3 | /services | "tattoo services" | Target | Intro paragraph about what they offer |
| 4 | /gallery | "tattoo portfolio" | Target | "See their work in our tattoo portfolio" |

#### Links TO Artists

| From Page | Anchor Text | Anchor Type |
|---|---|---|
| Home | "tattoo artists" | Target |
| Services | "our artists" | Target |
| Gallery | "tattoo artists" | Target |
| FAQ | "our artists" | Target |
| Contact | "our artists" | Generic |
| Joan | "all artists" | Generic |
| Andrew | "all artists" | Generic |

---

### 3.4 Joan (`/artists/joan`)

**Word count:** 400-500 | **Target link count:** 2-3 internal links

#### Links FROM Joan

| # | Destination | Anchor Text | Anchor Type | Placement |
|---|---|---|---|---|
| 1 | /artists | "all artists" | Generic | Breadcrumb or "Back to all artists" |
| 2 | /gallery | "Minneapolis tattoo portfolio" | Target | "See more of Joan's work in our Minneapolis tattoo portfolio" |
| 3 | /services | "tattoo services" | Target | Mention of services she offers |
| 4 | /contact | "book a consultation" | Target | CTA at bottom of bio |
| 5 | /artists/andrew | "Andrew Fernandez" | Target | "Also meet Andrew Fernandez" cross-link |

#### Links TO Joan

| From Page | Anchor Text | Anchor Type |
|---|---|---|
| Home | "Joan Martinez" | Target |
| Artists | "Joan Martinez" | Target |
| Gallery | "fine line tattoo Minneapolis" | Target |
| Andrew | "Joan Martinez" | Target |

---

### 3.5 Andrew (`/artists/andrew`)

**Word count:** 400-500 | **Target link count:** 2-3 internal links

#### Links FROM Andrew

| # | Destination | Anchor Text | Anchor Type | Placement |
|---|---|---|---|---|
| 1 | /artists | "all artists" | Generic | Breadcrumb or "Back to all artists" |
| 2 | /gallery | "tattoo portfolio" | Target | "View more work in our tattoo portfolio" |
| 3 | /services | "custom tattoo Minneapolis" | Target | Mention of services he offers |
| 4 | /contact | "contact us" | Target | CTA at bottom of bio |
| 5 | /artists/joan | "Joan Martinez" | Target | "Also meet Joan Martinez" cross-link |

#### Links TO Andrew

| From Page | Anchor Text | Anchor Type |
|---|---|---|
| Home | "Andrew Fernandez" | Target |
| Artists | "Andrew Fernandez" | Target |
| Gallery | "first tattoo Minneapolis" | Target |
| Joan | "Andrew Fernandez" | Target |

---

### 3.6 Gallery (`/gallery`)

**Word count:** 200-300 | **Target link count:** 1-2 text links + image links to artist pages

#### Links FROM Gallery

| # | Destination | Anchor Text | Anchor Type | Placement |
|---|---|---|---|---|
| 1 | /artists | "tattoo artists" | Target | Intro sentence |
| 2 | /services | "our services" | Generic | Brief mention of styles available |
| 3 | /artists/joan | "fine line tattoo Minneapolis" | Target | Image caption or filter label for Joan's work |
| 4 | /artists/andrew | "first tattoo Minneapolis" | Target | Image caption or filter label for Andrew's work |

**Image links:** Each gallery image attributed to an artist should link to that artist's page via the artist name below the image (e.g., "By Joan Martinez" links to `/artists/joan`).

#### Links TO Gallery

| From Page | Anchor Text | Anchor Type |
|---|---|---|
| Home | "tattoo portfolio" | Target |
| Artists | "tattoo portfolio" | Target |
| Joan | "Minneapolis tattoo portfolio" | Target |
| Andrew | "tattoo portfolio" | Target |
| Services | "browse our portfolio" | Generic |

---

### 3.7 Aftercare (`/aftercare`)

**Word count:** 1,000-1,500 | **Target link count:** 3-8 internal links

#### Links FROM Aftercare

| # | Destination | Anchor Text | Anchor Type | Placement |
|---|---|---|---|---|
| 1 | /faq | "tattoo FAQ" | Target | "Have more questions? Visit our tattoo FAQ" |
| 2 | /contact | "contact us" | Target | "If you notice signs of infection, contact us immediately" |
| 3 | /services | "tattoo services" | Target | Intro paragraph referencing what they offer |
| 4 | /faq | "learn more about our process" | Generic | Different section linking to FAQ for process questions |
| 5 | /contact | "reach out to your artist" | Generic | Touch-up section near bottom |

#### Links TO Aftercare

| From Page | Anchor Text | Anchor Type |
|---|---|---|
| Home | "read our aftercare guide" | Generic |
| FAQ | "tattoo aftercare guide" | Target |
| Services | — | (no direct link; optional addition) |

---

### 3.8 Parking (`/parking`)

**Word count:** 500-700 | **Target link count:** 2-4 internal links

#### Links FROM Parking

| # | Destination | Anchor Text | Anchor Type | Placement |
|---|---|---|---|---|
| 1 | /contact | "contact us" | Target | "Questions? Contact us for help finding us" |
| 2 | / | "Studio AZ Tattoo" | Brand | Reference to the shop in body copy |
| 3 | /contact | "book a consultation" | Target | CTA at bottom |

#### Links TO Parking

| From Page | Anchor Text | Anchor Type |
|---|---|---|
| Home | "parking and directions" | Target |
| Contact | "parking and directions" | Target |
| Footer (all pages) | "Parking" | Generic |

---

### 3.9 FAQ (`/faq`)

**Word count:** 1,500-2,000 | **Target link count:** 5-10 internal links

FAQ answers should link to the relevant page that answers the question in depth.

#### Links FROM FAQ

| # | Destination | Anchor Text | Anchor Type | Context |
|---|---|---|---|---|
| 1 | /services | "tattoo services" | Target | Pricing/services question |
| 2 | /services | "learn more about our services" | Generic | Different services question |
| 3 | /artists | "our artists" | Target | "Who will do my tattoo?" question |
| 4 | /aftercare | "tattoo aftercare guide" | Target | "How do I care for my new tattoo?" question |
| 5 | /aftercare | "read the full guide" | Generic | Different aftercare-related question |
| 6 | /contact | "book a consultation" | Target | "How do I book?" question |
| 7 | /parking | "parking and directions" | Target | "Where are you located?" / "Where do I park?" question |
| 8 | /gallery | "tattoo portfolio" | Target | "Can I see examples of your work?" question |
| 9 | /artists/joan | "Joan Martinez" | Target | Question about specific styles Joan does |
| 10 | /artists/andrew | "Andrew Fernandez" | Target | Question about styles Andrew does |

#### Links TO FAQ

| From Page | Anchor Text | Anchor Type |
|---|---|---|
| Home | "frequently asked questions" | Target |
| Services | "see our FAQ" | Generic |
| Aftercare | "tattoo FAQ" | Target |

---

### 3.10 Contact (`/contact`)

**Word count:** 200-300 | **Target link count:** 1-2 internal links

#### Links FROM Contact

| # | Destination | Anchor Text | Anchor Type | Placement |
|---|---|---|---|---|
| 1 | /parking | "parking and directions" | Target | "Find parking and directions to our North Loop studio" |
| 2 | /artists | "our artists" | Generic | "Not sure who to book with? Meet our artists" |
| 3 | /services | "tattoo services" | Target | Brief mention of what to expect |

#### Links TO Contact

| From Page | Anchor Text | Anchor Type |
|---|---|---|
| Home | "book a consultation" | Target |
| Services | "book a consultation" | Target |
| Joan | "book a consultation" | Target |
| Andrew | "contact us" | Target |
| Aftercare | "contact us" | Target |
| Aftercare | "reach out to your artist" | Generic |
| Parking | "contact us" | Target |
| FAQ | "book a consultation" | Target |

---

## 4. Breadcrumb Structure

Every non-homepage page includes a `BreadcrumbList` JSON-LD schema and visible breadcrumb navigation.

### Breadcrumb Paths

| Page | Breadcrumb Trail |
|---|---|
| Services | Home > Services |
| Artists | Home > Artists |
| Joan | Home > Artists > Joan Martinez |
| Andrew | Home > Artists > Andrew Fernandez |
| Gallery | Home > Gallery |
| Aftercare | Home > Aftercare |
| Parking | Home > Parking & Directions |
| FAQ | Home > FAQ |
| Contact | Home > Contact |

### JSON-LD Example (Joan's Page)

```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    {
      "@type": "ListItem",
      "position": 1,
      "name": "Home",
      "item": "https://tattooshopminneapolis.com/"
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
```

### Breadcrumb Rules

- "Home" always links to `/`.
- Each intermediate item is a clickable link.
- The final item (current page) is **not** a link — it is plain text.
- Breadcrumbs appear below the primary nav, above the page `<h1>`.

---

## 5. Navigation Structure

### Primary Navigation (7 items)

Visible on every page in the top nav bar. Order reflects user intent priority.

| Position | Label | URL | Notes |
|---|---|---|---|
| 1 | Home | `/` | Logo click also returns to Home |
| 2 | Services | `/services` | |
| 3 | Artists | `/artists` | Dropdown on desktop: Joan, Andrew |
| 4 | Gallery | `/gallery` | |
| 5 | Aftercare | `/aftercare` | |
| 6 | FAQ | `/faq` | |
| 7 | Contact | `/contact` | Styled as CTA button |

### Artists Dropdown (Desktop Only)

When hovering/clicking "Artists" in the nav:

```
Artists
├── All Artists (/artists)
├── Joan Martinez (/artists/joan)
└── Andrew Fernandez (/artists/andrew)
```

### Mobile Navigation

- Hamburger menu icon (top right).
- Same 7 items as desktop primary nav.
- Artists sub-items shown inline (indented) or as an expandable accordion.
- "Contact" item styled as CTA button at the bottom of the menu.

### Footer Navigation

See Section 7 for full footer link strategy.

---

## 6. Cross-Linking Rules

### Topic Clusters

Internal links should reinforce topic clusters. Link pages within the same cluster freely. Cross-cluster links should be intentional and contextual.

**Cluster 1 — Services & Artists (core offering)**
```
Services ↔ Artists ↔ Gallery
               ↕
         Joan ↔ Andrew
```

**Cluster 2 — Support & Information**
```
Aftercare ↔ FAQ
```

**Cluster 3 — Location & Contact**
```
Parking ↔ Contact
```

### Allowed Cross-Links

| Link | Rationale |
|---|---|
| Services → FAQ | Pricing questions answered in FAQ |
| FAQ → Services | FAQ answers reference service details |
| FAQ → Aftercare | Aftercare questions link to full guide |
| Aftercare → FAQ | "More questions?" CTA |
| FAQ → Parking | Location questions link to directions |
| Contact → Parking | Visitor needs directions before arriving |
| Aftercare → Contact | "Contact us if concerned about healing" |
| FAQ → Artists | "Who will tattoo me?" links to artist page |
| FAQ → Gallery | "Can I see examples?" links to portfolio |

### Disallowed Cross-Links

| Link | Reason |
|---|---|
| Parking → Gallery | Unrelated topics. Confuses topical relevance. |
| Parking → Aftercare | No contextual reason to connect directions with healing. |
| Gallery → Aftercare | Portfolio viewing has no aftercare context. |
| Gallery → Parking | No relevance. |
| Aftercare → Artists | Aftercare is procedural, not about choosing an artist. |
| Aftercare → Gallery | No contextual connection. |

### Artist Cross-Linking

- Joan's page includes: "Also meet Andrew Fernandez, who specializes in bold traditional and first tattoos."
- Andrew's page includes: "Also meet Joan Martinez, known for fine line and delicate work."
- These cross-links keep users exploring the Artists cluster and distribute link equity between artist pages.

---

## 7. Footer Link Strategy

The footer appears identically on all 10 pages. It serves four purposes: secondary navigation, NAP consistency, social proof, and review generation.

### Footer Layout

```
┌─────────────────────────────────────────────────────────────────┐
│                        STUDIO AZ TATTOO                         │
│                                                                 │
│  Navigate              Info                 Visit Us            │
│  ─────────             ─────                ─────────           │
│  Home                  Aftercare            123 N Washington Ave│
│  Services              FAQ                  Minneapolis, MN     │
│  Artists               Parking              55401               │
│  Gallery               Privacy Policy       (612) 555-0123      │
│  Contact               Terms of Service                         │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  [Instagram Icon] @studioaztattoo                               │
│                                                                 │
│  ★★★★★ Love your tattoo? Leave us a Google Review →            │
│                                                                 │
│  © 2026 Studio AZ Tattoo  •  Sitemap                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Footer Links Table

| Link Text | URL | Notes |
|---|---|---|
| Home | `/` | |
| Services | `/services` | |
| Artists | `/artists` | |
| Gallery | `/gallery` | |
| Contact | `/contact` | |
| Aftercare | `/aftercare` | |
| FAQ | `/faq` | |
| Parking | `/parking` | Secondary placement (not in primary nav) |
| Privacy Policy | `/privacy` | Legal requirement |
| Terms of Service | `/terms` | Legal requirement |
| Sitemap | `/sitemap.xml` | Crawlability signal |
| @studioaztattoo | `https://instagram.com/studioaztattoo` | `rel="noopener noreferrer"`, opens new tab |
| Leave us a Google Review | Google review URL | `rel="noopener noreferrer"`, opens new tab |

### NAP Block (Name, Address, Phone)

Present in the footer on every page for local SEO consistency:

```
Studio AZ Tattoo
123 N Washington Ave
Minneapolis, MN 55401
(612) 555-0123
```

- Address and phone number must be **identical** across all pages, Google Business Profile, and any citation sites.
- Phone number is a clickable `tel:` link on mobile.
- Address links to Google Maps directions (opens new tab).

### Review Generation CTA

- Text: "Love your tattoo? Leave us a Google Review"
- Links to the Google Business Profile review form URL.
- Opens in a new tab with `rel="noopener noreferrer"`.
- Styled subtly (not aggressive) to encourage organic reviews.

### Social Links

- Instagram only (primary platform for tattoo shops).
- Icon + handle displayed.
- `rel="noopener noreferrer"` and `target="_blank"`.
- No `rel="nofollow"` needed for social profiles (they are legitimate references).

---

## Summary: Link Count Per Page

| Page | Word Count | Target Links | Actual Outbound Links | Inbound Links (body) | Inbound Links (nav/footer) |
|---|---|---|---|---|---|
| Home `/` | 1,500-2,000 | 5-10 | 9 | 0 (hub) | All pages (nav + breadcrumb) |
| Services `/services` | 800-1,000 | 3-5 | 4 | 8 | All pages (nav) |
| Artists `/artists` | 500-700 | 2-4 | 4 | 7 | All pages (nav) |
| Joan `/artists/joan` | 400-500 | 2-3 | 5 | 4 | All pages (nav dropdown) |
| Andrew `/artists/andrew` | 400-500 | 2-3 | 5 | 4 | All pages (nav dropdown) |
| Gallery `/gallery` | 200-300 | 1-2 | 4 (+image links) | 5 | All pages (nav) |
| Aftercare `/aftercare` | 1,000-1,500 | 3-8 | 5 | 2 | All pages (nav) |
| Parking `/parking` | 500-700 | 2-4 | 3 | 3 | All pages (footer) |
| FAQ `/faq` | 1,500-2,000 | 5-10 | 10 | 3 | All pages (nav) |
| Contact `/contact` | 200-300 | 1-2 | 3 | 8 | All pages (nav) |

**Total unique internal links (body copy):** ~52 contextual links across 10 pages, plus nav, footer, and breadcrumb links on every page.
