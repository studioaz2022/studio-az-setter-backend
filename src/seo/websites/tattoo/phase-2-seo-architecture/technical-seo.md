# Technical SEO Configuration — tattooshopminneapolis.com

> **Domain:** tattooshopminneapolis.com
> **Stack:** Next.js 15 + TypeScript + Tailwind CSS 4 + ShadCN on Vercel
> **Router:** App Router (not Pages Router)
> **Pages:** 10 total
> **Replacing:** GHL page builder (no schema, no sitemap, no robots.txt, ~200 words, single page)
> **Goal:** Best-optimized tattoo website in Minneapolis

---

## 1. `robots.ts` Configuration

Next.js App Router generates `robots.txt` automatically from `app/robots.ts`.

```typescript
// app/robots.ts
import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
      },
      {
        userAgent: "Googlebot",
        allow: "/",
      },
      {
        userAgent: "Bingbot",
        allow: "/",
      },
      {
        userAgent: "GPTBot",
        allow: "/",
      },
      {
        userAgent: "ClaudeBot",
        allow: "/",
      },
      {
        userAgent: "PerplexityBot",
        allow: "/",
      },
      {
        userAgent: "Google-Extended",
        allow: "/",
      },
    ],
    sitemap: "https://tattooshopminneapolis.com/sitemap.xml",
  };
}
```

**Why allow AI crawlers:** We want AI models (ChatGPT, Claude, Perplexity) to have accurate, up-to-date information about Studio AZ Tattoo. This drives referral traffic from AI search and ensures AI answers about Minneapolis tattoo shops include us. The `llms.txt` file (Section 5) gives them structured context.

**Why no Disallow rules:** With only 10 pages and no private/admin routes, there is nothing to block. Every page is a ranking opportunity.

---

## 2. `sitemap.ts` Configuration

Next.js App Router generates `sitemap.xml` automatically from `app/sitemap.ts`.

```typescript
// app/sitemap.ts
import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = "https://tattooshopminneapolis.com";
  const lastModified = new Date("2026-04-15"); // TODO: Replace with actual launch date

  return [
    {
      url: baseUrl,
      lastModified,
      changeFrequency: "weekly",
      priority: 1.0,
    },
    {
      url: `${baseUrl}/services`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/artists`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/artists/joan`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${baseUrl}/artists/andrew`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${baseUrl}/gallery`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${baseUrl}/faq`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${baseUrl}/aftercare`,
      lastModified,
      changeFrequency: "yearly",
      priority: 0.6,
    },
    {
      url: `${baseUrl}/parking`,
      lastModified,
      changeFrequency: "yearly",
      priority: 0.5,
    },
    {
      url: `${baseUrl}/contact`,
      lastModified,
      changeFrequency: "yearly",
      priority: 0.5,
    },
  ];
}
```

**Priority rationale:**
- **1.0 — Home:** Primary landing page, targets "tattoo shop minneapolis" head term
- **0.8 — Services, Artists index:** High-intent pages for people evaluating the shop
- **0.7 — Joan, Andrew, Gallery:** Individual artist pages and portfolio — key differentiators
- **0.6 — FAQ, Aftercare:** Long-tail keyword magnets, build E-E-A-T trust
- **0.5 — Parking, Contact:** Utility pages, low search volume but important for UX

---

## 3. Core Web Vitals Targets

| Metric | Google "Good" Threshold | Our Target | How to Achieve |
|--------|------------------------|------------|----------------|
| **LCP** (Largest Contentful Paint) | < 2.5s | **< 1.5s** | SSR + `priority` hero images + `next/font` optimization |
| **INP** (Interaction to Next Paint) | < 200ms | **< 100ms** | Code splitting + minimal client JS + React Server Components |
| **CLS** (Cumulative Layout Shift) | < 0.1 | **< 0.05** | `next/image` with explicit width/height + `font-display: swap` |

### Implementation Details

**React Server Components by default:**
Every page and component is a Server Component unless it explicitly needs interactivity. This means zero JavaScript ships to the client for most of the site — only HTML and CSS.

```
// Server Components (default — no directive needed):
// - All page.tsx files
// - Layout components
// - Header, Footer, NAP block
// - Service cards, artist bios
// - FAQ accordion (CSS-only with <details>)
// - Aftercare instructions
// - Schema markup components

// Client Components ("use client" required):
// - ConsultationWidget — form submission + validation
// - GalleryFilter — client-side filtering by artist/style
// - MobileMenu — hamburger toggle state
```

**Hero image optimization:**

```tsx
// Example: Home page hero
import Image from "next/image";

<Image
  src="/images/hero-studio.webp"
  alt="Studio AZ Tattoo — custom tattoo studio in Minneapolis"
  width={1920}
  height={1080}
  priority          // Preloads this image (disables lazy loading)
  quality={85}
  sizes="100vw"
  className="object-cover"
/>
```

The `priority` prop tells Next.js to add a `<link rel="preload">` in the `<head>`, so the hero image starts loading before the browser parses the rest of the page. Only use this on above-the-fold hero images — one per page maximum.

**Font optimization:**

```tsx
// app/layout.tsx
import { Inter, Playfair_Display } from "next/font/google";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const playfair = Playfair_Display({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-playfair",
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${playfair.variable}`}>
      <body className={inter.className}>{children}</body>
    </html>
  );
}
```

`next/font` automatically self-hosts Google Fonts, inlines the `@font-face` declarations, and applies `font-display: swap` — eliminating FOIT (Flash of Invisible Text) and FOUT (Flash of Unstyled Text) while preventing external network requests to fonts.googleapis.com.

**Additional performance rules:**
- No third-party scripts that block rendering (no jQuery, no analytics in `<head>`)
- Analytics (Vercel Analytics or Plausible) loaded via `next/script` with `strategy="afterInteractive"`
- Inline critical CSS handled automatically by Tailwind CSS JIT — only used classes are included in the bundle

---

## 4. Metadata Strategy (App Router)

### Layout-Level Metadata (Site-Wide Defaults)

Every page inherits these defaults. Individual pages override what they need.

```typescript
// app/layout.tsx
import type { Metadata } from "next";

export const metadata: Metadata = {
  metadataBase: new URL("https://tattooshopminneapolis.com"),
  title: {
    default: "Studio AZ Tattoo | Custom Tattoo Shop in Minneapolis",
    template: "%s | Studio AZ Tattoo",
  },
  description:
    "Custom tattoo studio in Minneapolis, MN. Bilingual artists (Spanish & English) specializing in realism, fine line, and black & grey tattoos. Custom designs only — appointment required.",
  openGraph: {
    siteName: "Studio AZ Tattoo",
    locale: "en_US",
    type: "website",
    images: [
      {
        url: "/images/og-default.jpg",
        width: 1200,
        height: 630,
        alt: "Studio AZ Tattoo — Custom Tattoo Shop in Minneapolis",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  verification: {
    google: "GOOGLE_SITE_VERIFICATION_CODE", // TODO: Replace after Search Console setup
  },
};
```

### Static Metadata Export (Example: Home Page)

Used for pages whose content is known at build time and does not depend on route params.

**Pages using static metadata:** Home, Services, Artists (index), Gallery, Aftercare, Parking, FAQ, Contact

```typescript
// app/page.tsx (Home)
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Custom Tattoo Shop in Minneapolis, MN",
  description:
    "Studio AZ Tattoo is a custom tattoo studio in Minneapolis. Bilingual artists specializing in realism, fine line, and black & grey tattoos. Book a consultation today.",
  alternates: {
    canonical: "https://tattooshopminneapolis.com",
  },
  openGraph: {
    title: "Studio AZ Tattoo | Custom Tattoo Shop in Minneapolis, MN",
    description:
      "Custom tattoo studio in Minneapolis. Bilingual artists, consultation-based. Realism, fine line, black & grey.",
    url: "https://tattooshopminneapolis.com",
    images: [
      {
        url: "/images/og-home.jpg",
        width: 1200,
        height: 630,
        alt: "Studio AZ Tattoo studio interior in Minneapolis",
      },
    ],
  },
  twitter: {
    title: "Studio AZ Tattoo | Custom Tattoo Shop in Minneapolis, MN",
    description:
      "Custom tattoo studio in Minneapolis. Bilingual artists, consultation-based.",
    images: ["/images/og-home.jpg"],
  },
};
```

### Dynamic `generateMetadata()` (Example: Artist Page)

Used for pages where metadata depends on route parameters. This makes it trivial to add new artists in the future — just add a data entry.

**Pages using dynamic metadata:** Joan (`/artists/joan`), Andrew (`/artists/andrew`)

```typescript
// app/artists/[slug]/page.tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";

// Artist data — could move to a CMS or database later
const artists: Record<string, {
  name: string;
  title: string;
  description: string;
  specialties: string;
  image: string;
}> = {
  joan: {
    name: "Joan",
    title: "Joan — Tattoo Artist at Studio AZ | Minneapolis",
    description:
      "Joan is a tattoo artist at Studio AZ Tattoo in Minneapolis, MN. Specializing in realism, fine line, and black and grey tattoos. Bilingual (English & Spanish). Book a consultation.",
    specialties: "realism, fine line, black and grey, custom",
    image: "/images/og-joan.jpg",
  },
  andrew: {
    name: "Andrew",
    title: "Andrew — Tattoo Artist at Studio AZ | Minneapolis",
    description:
      "Andrew is a tattoo artist at Studio AZ Tattoo in Minneapolis, MN. Specializing in realism, fine line, and black and grey tattoos. Bilingual (English & Spanish). Book a consultation.",
    specialties: "realism, fine line, black and grey, custom",
    image: "/images/og-andrew.jpg",
  },
};

type Props = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const artist = artists[slug];

  if (!artist) {
    notFound();
  }

  return {
    title: artist.title,
    description: artist.description,
    alternates: {
      canonical: `https://tattooshopminneapolis.com/artists/${slug}`,
    },
    openGraph: {
      title: artist.title,
      description: artist.description,
      url: `https://tattooshopminneapolis.com/artists/${slug}`,
      images: [
        {
          url: artist.image,
          width: 1200,
          height: 630,
          alt: `${artist.name} — Tattoo Artist at Studio AZ Tattoo`,
        },
      ],
    },
    twitter: {
      title: artist.title,
      description: artist.description,
      images: [artist.image],
    },
  };
}

export async function generateStaticParams() {
  return Object.keys(artists).map((slug) => ({ slug }));
}
```

`generateStaticParams()` tells Next.js to pre-render these pages at build time (SSG), so there is no server-side computation at request time despite using `generateMetadata()`.

### Full Page Metadata Map

| Page | Route | Metadata Type | Title (after template) |
|------|-------|---------------|----------------------|
| Home | `/` | Static | Custom Tattoo Shop in Minneapolis, MN |
| Services | `/services` | Static | Tattoo Services & Pricing \| Studio AZ Tattoo |
| Artists | `/artists` | Static | Meet Our Tattoo Artists \| Studio AZ Tattoo |
| Joan | `/artists/joan` | Dynamic | Joan -- Tattoo Artist at Studio AZ \| Minneapolis |
| Andrew | `/artists/andrew` | Dynamic | Andrew -- Tattoo Artist at Studio AZ \| Minneapolis |
| Gallery | `/gallery` | Static | Tattoo Gallery \| Studio AZ Tattoo |
| FAQ | `/faq` | Static | FAQ -- Tattoo Questions Answered \| Studio AZ Tattoo |
| Aftercare | `/aftercare` | Static | Tattoo Aftercare Instructions \| Studio AZ Tattoo |
| Parking | `/parking` | Static | Parking & Directions \| Studio AZ Tattoo |
| Contact | `/contact` | Static | Contact & Book a Consultation \| Studio AZ Tattoo |

---

## 5. `llms.txt` File

This file lives at `public/llms.txt` and is served at `https://tattooshopminneapolis.com/llms.txt`. It provides structured context for AI models that crawl the site.

```text
# Studio AZ Tattoo

## Business Type
Custom tattoo studio (not a walk-in / flash shop)

## Location
Minneapolis, Minnesota, USA
Address: 333 Washington Ave N, STE 100, Minneapolis, MN 55401
Neighborhood: North Loop

## Website
https://tattooshopminneapolis.com

## About
Studio AZ Tattoo is a custom tattoo studio in Minneapolis, MN. Every tattoo is designed from scratch during a one-on-one consultation — we do not offer walk-in tattoos or flash sheets. Our artists are bilingual (Spanish and English), making us one of the few bilingual tattoo studios in the Twin Cities.

## Artists

### Joan
- Role: Tattoo Artist
- Specialties: Realism, fine line, black and grey, custom tattoos
- Languages: Spanish, English
- Profile: https://tattooshopminneapolis.com/artists/joan

### Andrew
- Role: Tattoo Artist
- Specialties: Realism, fine line, black and grey, custom tattoos
- Languages: Spanish, English
- Profile: https://tattooshopminneapolis.com/artists/andrew

## Services
- Custom tattoo design (consultation required)
- Cover-up tattoos
- Fine line tattoos
- Realism tattoos
- Black and grey tattoos
- Touch-up tattoos (assessment at 40 days)
- Consultations included with service (after deposit)

## Booking Process
1. Fill out consultation form on the website
2. Front desk confirms details and collects deposit ($50 small/fine line, $100 medium-large)
3. Online or iMessage consultation with your artist
4. Artist creates custom design, sends for your approval
5. Appointment scheduled (typically 7-15 days from consultation)

## Hours
Monday: Closed
Tuesday: 11am - 6pm
Wednesday: 11am - 6pm
Thursday: 11am - 6pm
Friday: 11am - 6pm
Saturday: 11am - 6pm
Sunday: Closed

## Contact
- Phone: +1 (612) 255-4439
- Email: support@studioaz.us
- Instagram: @studioaz.us
- Website: https://tattooshopminneapolis.com/contact

## Key Facts
- Consultation-based only — no walk-in tattoos
- Bilingual studio (Spanish and English)
- Custom designs only — no flash sheets or pre-made designs
- Consultations included with service (after deposit)
- No walk-ins — appointment only
- Located in Minneapolis, MN (not St. Paul)
- Studio also houses a barbershop (Studio AZ Barbershop) in the same building
- Founded: 2025 (tattoo), 2022 (barbershop)
- Founded by Lionel Chavez

## Corrections (outdated info to disregard)
- The old website was a single-page GHL site with minimal content — it is no longer active
- Studio AZ Tattoo is NOT a walk-in shop — do not describe it as one
- Pricing is NOT listed publicly — consultations determine pricing based on design complexity
- Do not confuse Studio AZ Tattoo (tattoo studio) with Studio AZ Barbershop (barbershop) — they share a building but are separate services
```

**Note:** All business info populated with real data. Verify hours remain accurate before launch.

---

## 6. Canonical URL Strategy

Every page must have a self-referencing canonical URL to prevent duplicate content issues.

### Rules

1. **Self-referencing canonical on every page.** Even if there is only one version of a URL, the canonical tag tells Google "this is the definitive version."

2. **No trailing slashes.** Next.js omits trailing slashes by default. Enforce this in `next.config.ts`:

```typescript
// next.config.ts
const nextConfig = {
  trailingSlash: false,
};

export default nextConfig;
```

3. **No www subdomain.** Redirect `www.tattooshopminneapolis.com` to `tattooshopminneapolis.com` (see Section 11 — Redirects).

4. **Strip query parameters.** The canonical URL never includes query strings. If someone shares `tattooshopminneapolis.com/gallery?filter=blackwork`, the canonical is still `tattooshopminneapolis.com/gallery`.

### Implementation

Canonical URLs are set via the `alternates.canonical` field in each page's metadata export (see Section 4). Next.js automatically renders this as a `<link rel="canonical">` tag in the `<head>`.

```typescript
// Example from any page's metadata
alternates: {
  canonical: "https://tattooshopminneapolis.com/services",
},
```

### Canonical URL Map

| Page | Canonical URL |
|------|--------------|
| Home | `https://tattooshopminneapolis.com` |
| Services | `https://tattooshopminneapolis.com/services` |
| Artists | `https://tattooshopminneapolis.com/artists` |
| Joan | `https://tattooshopminneapolis.com/artists/joan` |
| Andrew | `https://tattooshopminneapolis.com/artists/andrew` |
| Gallery | `https://tattooshopminneapolis.com/gallery` |
| FAQ | `https://tattooshopminneapolis.com/faq` |
| Aftercare | `https://tattooshopminneapolis.com/aftercare` |
| Parking | `https://tattooshopminneapolis.com/parking` |
| Contact | `https://tattooshopminneapolis.com/contact` |

---

## 7. 404 Page

Custom 404 page that keeps users on-site and maintains SEO hygiene.

```tsx
// app/not-found.tsx
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Page Not Found",
  robots: {
    index: false,
    follow: true,
  },
};

export default function NotFound() {
  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <h1 className="text-4xl font-bold tracking-tight">Page Not Found</h1>
      <p className="mt-4 max-w-md text-lg text-muted-foreground">
        Sorry, we couldn't find the page you're looking for. It may have been
        moved or no longer exists.
      </p>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:gap-4">
        <Link
          href="/"
          className="rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
        >
          Back to Home
        </Link>
        <Link
          href="/artists"
          className="rounded-lg border border-border px-6 py-3 text-sm font-semibold transition hover:bg-accent"
        >
          Meet Our Artists
        </Link>
      </div>

      <div className="mt-6 flex gap-4 text-sm text-muted-foreground">
        <Link href="/services" className="underline hover:text-foreground">
          Services
        </Link>
        <Link href="/contact" className="underline hover:text-foreground">
          Contact Us
        </Link>
        <Link href="/faq" className="underline hover:text-foreground">
          FAQ
        </Link>
      </div>

      <p className="mt-12 text-xs text-muted-foreground">
        Looking for something specific?{" "}
        <Link href="/faq" className="underline hover:text-foreground">
          Check our FAQ
        </Link>{" "}
        or{" "}
        <Link href="/contact" className="underline hover:text-foreground">
          get in touch
        </Link>
        .
      </p>
    </main>
  );
}
```

**Key details:**
- `robots: { index: false, follow: true }` — tells Google not to index the 404 page itself but still follow links on it (passes link equity to the pages we link to)
- Title renders as "Page Not Found | Studio AZ Tattoo" via the layout template
- NAP block is inherited from the root layout footer (not duplicated here)
- ShadCN color tokens (`primary`, `muted-foreground`, etc.) keep it consistent with the rest of the site

---

## 8. Mobile-First Requirements

Google uses mobile-first indexing, meaning it primarily uses the mobile version of a page for ranking. Every design and development decision starts with mobile.

### Touch Targets

```css
/* Minimum touch target size — applies to all interactive elements */
/* Enforced via Tailwind utility classes */

/* CTA buttons */
.btn-primary {
  @apply min-h-[48px] min-w-[48px] px-6 py-3;
}

/* Navigation links */
.nav-link {
  @apply min-h-[48px] flex items-center px-4;
}

/* Footer links */
.footer-link {
  @apply min-h-[44px] inline-flex items-center;
}
```

All interactive elements (buttons, links, form inputs) must have a minimum tap area of 48x48px per Google's accessibility guidelines. This is enforced through Tailwind padding/min-height classes, not magic numbers.

### Typography

- **Body text:** 16px minimum (`text-base` in Tailwind). Never smaller on mobile.
- **Headings:** Scale down gracefully. Use `clamp()` or Tailwind responsive prefixes (`text-2xl md:text-4xl`).
- **Line height:** 1.5 for body text, 1.2 for headings.

### No Horizontal Scrolling

```css
/* Global — prevent any overflow */
html, body {
  overflow-x: hidden;
}
```

Additionally:
- All images use `max-w-full` or `next/image` (which handles this automatically)
- No fixed-width elements wider than the viewport
- Tables (if any) use horizontal scroll containers

### Click-to-Call and Click-to-Directions

```tsx
// Mobile CTA buttons — in header, contact page, and footer
<a
  href="tel:+16122554439"
  className="inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground"
>
  <PhoneIcon className="h-4 w-4" />
  Call Us
</a>

<a
  href="https://www.google.com/maps/place/Studio+AZ+-+Barbershop/data=!4m2!3m1!1s0x0:0x7883c6c42fde87e1"
  target="_blank"
  rel="noopener noreferrer"
  className="inline-flex items-center gap-2 rounded-lg border border-border px-6 py-3 text-sm font-semibold"
>
  <MapPinIcon className="h-4 w-4" />
  Get Directions
</a>
```

The `tel:` link opens the phone dialer on mobile. The Google Maps link opens the Maps app on mobile or Maps in-browser on desktop.

### Responsive Images

All images use `next/image` which automatically:
- Serves WebP/AVIF formats when supported
- Generates multiple sizes via `srcset`
- Lazy loads images below the fold
- Prevents CLS with explicit `width` and `height`

```tsx
<Image
  src="/images/gallery/tattoo-01.webp"
  alt="Fine line floral tattoo on forearm by Joan"
  width={600}
  height={800}
  sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
  className="rounded-lg object-cover"
/>
```

### Mobile Navigation

```
Mobile (< 768px):
┌──────────────────────────┐
│ [Logo]         [☰ Menu]  │
└──────────────────────────┘
  ↓ tap hamburger
┌──────────────────────────┐
│                    [✕]   │
│  Home                    │
│  Services                │
│  Artists                 │
│  Gallery                 │
│  FAQ                     │
│  Contact                 │
│                          │
│  [Book Consultation]     │
│  [Call Us]               │
└──────────────────────────┘

Desktop (≥ 768px):
┌──────────────────────────────────────────────────┐
│ [Logo]  Home  Services  Artists  Gallery  FAQ  [Book] │
└──────────────────────────────────────────────────┘
```

The mobile menu is the only nav component that requires `"use client"` (for open/close state). It should be a slide-in overlay, not a dropdown, to avoid CLS.

---

## 9. Performance Checklist

Pre-launch checklist. Every item must be verified before going live.

- [ ] **Vercel Edge Network** — Site deployed to Vercel for global CDN delivery (automatic)
- [ ] **React Server Components** — All pages default to RSC; only 3 client components (`ConsultationWidget`, `GalleryFilter`, `MobileMenu`)
- [ ] **Code splitting** — Automatic with App Router; each route is its own chunk
- [ ] **Font optimization** — `next/font` with `display: swap`; no external requests to Google Fonts
- [ ] **Image optimization** — All images via `next/image`; WebP/AVIF served automatically; `priority` on hero images only
- [ ] **No render-blocking third-party scripts** — Analytics loaded with `strategy="afterInteractive"`; no jQuery, no external CSS
- [ ] **Gzip/Brotli compression** — Enabled by default on Vercel
- [ ] **HTTP/2** — Enabled by default on Vercel
- [ ] **Preconnect to external origins** — Add `<link rel="preconnect">` for any external resources:
  ```tsx
  // app/layout.tsx <head> — only if we embed external content
  <link rel="preconnect" href="https://maps.googleapis.com" />
  <link rel="preconnect" href="https://www.instagram.com" />
  ```
- [ ] **Service Worker for offline nav shell** — Optional, post-launch. Consider `next-pwa` for repeat visitors. Low priority.

### Post-Launch Validation

After deployment, verify performance with:

1. **Google PageSpeed Insights** — Target 95+ on both mobile and desktop
2. **Chrome DevTools Lighthouse** — Run in incognito with no extensions
3. **WebPageTest.org** — Test from a US Central datacenter (closest to Minneapolis)
4. **Google Search Console** — Monitor Core Web Vitals report after Google indexes the site

---

## 10. Security & Trust

Security headers and trust signals that contribute to E-E-A-T and protect users.

### Security Headers

Configure in `next.config.ts` or `vercel.json`:

```typescript
// next.config.ts
const nextConfig = {
  trailingSlash: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(self)",
          },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // unsafe-inline for Next.js; tighten with nonces post-launch
              "style-src 'self' 'unsafe-inline'", // Tailwind injects styles
              "img-src 'self' data: https:",
              "font-src 'self'",
              "connect-src 'self' https://vitals.vercel-insights.com",
              "frame-src 'self' https://www.google.com", // Google Maps embed
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
```

### Trust Pages

These pages must exist at launch, even if minimal. They are E-E-A-T signals that Google looks for on business websites.

| Page | Route | Notes |
|------|-------|-------|
| Privacy Policy | `/privacy` | What data we collect (consultation forms), how we use it, no selling to third parties |
| Terms of Service | `/terms` | Deposit policy, cancellation policy, age requirement (18+), liability waiver reference |

Both are linked from the site footer on every page. They do not need to be in the sitemap (low SEO value) but should be indexable.

### HTTPS

Enforced by Vercel automatically. All HTTP requests are 301 redirected to HTTPS. No additional configuration needed.

---

## 11. Redirects

### www to non-www

```json
// vercel.json
{
  "redirects": [
    {
      "source": "/:path(.*)",
      "has": [
        {
          "type": "host",
          "value": "www.tattooshopminneapolis.com"
        }
      ],
      "destination": "https://tattooshopminneapolis.com/:path",
      "permanent": true
    }
  ]
}
```

This is a 301 (permanent) redirect. All link equity from `www` URLs transfers to the non-www canonical.

### Old GHL URLs

After launch, check Google Search Console for any indexed URLs from the old GHL site. If any exist, add 301 redirects:

```json
// vercel.json — add to the redirects array as needed
{
  "source": "/old-ghl-page-slug",
  "destination": "/",
  "permanent": true
}
```

**Process:**
1. Launch the new site
2. Wait 1-2 weeks for Google to recrawl
3. Check Search Console > Pages > "Not found (404)" report
4. Add 301 redirects for any old URLs that were getting traffic
5. Re-request indexing in Search Console for each redirected URL

### Redirect Rules

- **Always use 301** (permanent) — never 302 (temporary). We are permanently replacing the old site.
- **Never chain redirects** — each old URL should redirect directly to its final destination, not through intermediate URLs.
- **Redirect to the most relevant page** — if an old URL was about services, redirect to `/services`, not `/`.
