# Image Optimization Strategy — tattooshopminneapolis.com

> The domain itself is an exact-match for "tattoo shop Minneapolis." Every image on the site should reinforce topical authority without keyword-stuffing the domain phrase into filenames (the 3 Kings rule — the domain already handles that keyword).

---

## 1. File Naming Conventions

**Format:** `[style]-[subject]-[location]-[artist].webp`

- Lowercase only
- Hyphens between words — no underscores, no spaces
- Include location or artist name where relevant
- **NEVER** include "tattoo-shop-minneapolis" in the filename (already in the domain)

### Examples by page type

**Portfolio images:**
- `fine-line-butterfly-minneapolis-joan-martinez.webp`
- `black-and-grey-portrait-sleeve-joan-martinez.webp`
- `small-rose-wrist-andrew-fernandez.webp`
- `realism-lion-forearm-minneapolis-joan-martinez.webp`
- `minimalist-wave-ankle-andrew-fernandez.webp`

**Studio images:**
- `north-loop-studio-interior.webp`
- `studio-az-front-entrance.webp`
- `tattoo-station-setup-studio-az.webp`
- `waiting-area-north-loop.webp`

**Team images:**
- `joan-martinez-artist-portrait.webp`
- `andrew-fernandez-artist-portrait.webp`
- `studio-az-team-group-photo.webp`

**Aftercare images:**
- `day-one-healing-progress.webp`
- `proper-moisturizing-technique.webp`
- `healed-vs-fresh-comparison.webp`
- `what-not-to-do-peeling-stage.webp`

**Parking/location images:**
- `washington-ave-parking-map.webp`
- `north-loop-street-parking.webp`
- `building-entrance-directions.webp`
- `parking-lot-aerial-view-north-loop.webp`

---

## 2. Alt Text Patterns

Every image gets unique, descriptive alt text that naturally includes relevant keywords. No two images on the site should share the same alt text.

### Portfolio / Gallery Images

**Formula:** `[Style] tattoo [subject] by [Artist Name] at Studio AZ in Minneapolis`

Examples:
1. "Fine line butterfly tattoo by Joan Martinez at Studio AZ in Minneapolis"
2. "Black and grey portrait sleeve by Joan Martinez at Studio AZ in Minneapolis"
3. "Small first tattoo design by Andrew Fernandez in Minneapolis"
4. "Realistic lion forearm tattoo by Joan Martinez at Studio AZ in Minneapolis"
5. "Minimalist wave ankle tattoo by Andrew Fernandez at Studio AZ Minneapolis"

### Studio Photos

**Formula:** `[Description] of Studio AZ Tattoo in the North Loop, Minneapolis`

Examples:
1. "Interior of Studio AZ Tattoo in the North Loop, Minneapolis"
2. "Clean tattoo station setup at Studio AZ Tattoo in the North Loop, Minneapolis"
3. "Welcoming waiting area at Studio AZ Tattoo in the North Loop, Minneapolis"

### Artist Portraits

**Formula:** `[Artist Name], [specialty] tattoo artist at Studio AZ Minneapolis`

Examples:
1. "Joan Martinez, fine line and realism tattoo artist at Studio AZ Minneapolis"
2. "Andrew Fernandez, small tattoo specialist at Studio AZ Minneapolis"
3. "Joan Martinez working on a black and grey piece at Studio AZ Minneapolis"

### Aftercare Images

**Formula:** `[Description] — tattoo aftercare [stage]`

Examples:
1. "Fresh tattoo with protective wrap applied — tattoo aftercare day one"
2. "Proper moisturizing technique for healing tattoo — tattoo aftercare week one"
3. "Healed fine line tattoo after four weeks — tattoo aftercare final result"

### Parking / Location Images

**Formula:** `[Description] near Studio AZ Tattoo in North Loop Minneapolis`

Examples:
1. "Street parking map near Studio AZ Tattoo in North Loop Minneapolis"
2. "Building entrance and signage near Studio AZ Tattoo in North Loop Minneapolis"
3. "Free parking lot near Studio AZ Tattoo in North Loop Minneapolis"

### Alt Text Rules

- Every alt text must be **unique** across the entire site — no duplicates
- Include a relevant keyword naturally (style, location, artist name)
- Keep alt text under 125 characters
- Describe what is actually visible in the image
- Consider common misspellings people search for — use sparingly in alt text where it reads naturally (e.g., "tatoo" is a frequent Google search; one or two images across the site can include it: "Small tatoo ideas for first timers by Andrew Fernandez in Minneapolis")
- Do not stuff keywords — one keyword phrase per alt text is enough

---

## 3. Loading Strategy

### Above-the-fold (hero images)

Use the `priority` prop on the `next/image` component. This disables lazy loading and triggers a preload `<link>` in the document head.

```tsx
<Image src={heroImage} alt="..." priority />
```

### Below-the-fold

Default lazy loading with a blur placeholder generated at build time.

```tsx
<Image src={portfolioImage} alt="..." placeholder="blur" />
```

### Hero Images Per Page

| Page | Hero Image | Loading |
|------|-----------|---------|
| Home | Full-width studio or portfolio hero | `priority` |
| Services | Process overview / style showcase | `priority` |
| Artists | Team photo or side-by-side artist portraits | `priority` |
| Joan Martinez | Joan's artist portrait | `priority` — portfolio images below use lazy |
| Andrew Fernandez | Andrew's artist portrait | `priority` — portfolio images below use lazy |
| Gallery | First 4 images in the grid | `priority` — all remaining images lazy |
| Aftercare | Healing timeline graphic (if present) | `priority` |
| Parking | Parking map or directions graphic | `priority` |
| Contact | Storefront exterior or embedded map | `priority` |
| FAQ | Studio interior shot | `priority` (if above fold) |

### Gallery Page Specifics

- First 4 images: `priority` (visible on initial viewport)
- Images 5+: lazy load with `placeholder="blur"`
- Use a responsive grid (CSS grid or flexbox)
- Consider intersection observer for smooth load-in animation
- Filterable by artist and style — filtering should not re-trigger priority loads

### Artist Portfolio Sections

- Artist portrait: `priority`
- Portfolio pieces: lazy load with `placeholder="blur"`
- Load portfolio in batches if more than 10 images (infinite scroll or "Load More" button)

---

## 4. Image Formats & Sizing

### Format

- **Primary:** WebP — `next/image` converts automatically
- **Fallback:** JPEG — `next/image` serves JPEG to browsers without WebP support
- **Source files:** Keep original PNGs/JPEGs in a separate `_originals/` directory (not deployed)

### Quality Settings

| Image Type | Quality | Rationale |
|-----------|---------|-----------|
| Portfolio / gallery | 80 | High detail matters for tattoo work |
| Artist portraits | 80 | Professional appearance |
| Studio / interior | 75 | Good enough for environment shots |
| Decorative / background | 75 | Visual flair, detail less critical |
| Thumbnails | 75 | Small size, detail not visible |

### Responsive Sizes

**Hero images:**
- Desktop: 1920w
- Tablet: 768w
- Mobile: 480w

```tsx
<Image
  src={hero}
  alt="..."
  sizes="100vw"
  priority
/>
```

**Portfolio grid images:**
- Desktop: 600w
- Tablet: 400w
- Mobile: 300w

```tsx
<Image
  src={portfolioPiece}
  alt="..."
  sizes="(max-width: 640px) 300px, (max-width: 1024px) 400px, 600px"
  placeholder="blur"
/>
```

**Thumbnail images:**
- Desktop: 300w
- Mobile: 200w

```tsx
<Image
  src={thumb}
  alt="..."
  sizes="(max-width: 640px) 200px, 300px"
  placeholder="blur"
/>
```

**Artist portraits:**
- Desktop: 400w
- Mobile: 300w

```tsx
<Image
  src={portrait}
  alt="..."
  sizes="(max-width: 640px) 300px, 400px"
  priority
/>
```

### Maximum File Size Targets

| Image Type | Max File Size |
|-----------|--------------|
| Portfolio images | 200KB |
| Hero images | 250KB |
| Thumbnails | 100KB |
| Artist portraits | 150KB |
| Studio / interior | 150KB |
| Aftercare / informational | 100KB |

If an image exceeds its target after WebP conversion at the specified quality, reduce dimensions or quality incrementally until it fits.

---

## 5. Google Lens & Visual Search Optimization

### Real Photos Only

- **Zero stock images** anywhere on the site — Google Lens builds entity authority from real, original images
- Every portfolio image must be an actual tattoo done at Studio AZ
- Studio photos must be of the actual North Loop location
- Google increasingly uses visual search to connect images to businesses — original photos strengthen this connection

### Branded Images

- Add a subtle logo watermark to portfolio images (bottom corner, semi-transparent)
- Watermark should be small enough to not distract but visible enough for brand association
- This reinforces brand when images are shared, screenshotted, or indexed by Google Lens

### EXIF Data

- **Strip GPS/location data** for client privacy
- Preserve color profile metadata (sRGB) for accurate rendering
- Do not embed personal information in EXIF fields
- `next/image` strips most EXIF by default during optimization — this is fine

### Image Sitemap

Include all portfolio images in `sitemap.xml` using the `<image:image>` extension:

```xml
<url>
  <loc>https://tattooshopminneapolis.com/gallery</loc>
  <image:image>
    <image:loc>https://tattooshopminneapolis.com/images/portfolio/fine-line-butterfly-minneapolis-joan-martinez.webp</image:loc>
    <image:title>Fine line butterfly tattoo by Joan Martinez</image:title>
    <image:caption>Fine line butterfly tattoo by Joan Martinez at Studio AZ in Minneapolis</image:caption>
  </image:image>
  <image:image>
    <image:loc>https://tattooshopminneapolis.com/images/portfolio/black-and-grey-portrait-sleeve-joan-martinez.webp</image:loc>
    <image:title>Black and grey portrait sleeve by Joan Martinez</image:title>
    <image:caption>Black and grey portrait sleeve by Joan Martinez at Studio AZ in Minneapolis</image:caption>
  </image:image>
  <!-- ... all portfolio images ... -->
</url>
```

- Include images from all pages, not just the gallery
- Update the sitemap whenever new portfolio images are added
- Submit sitemap to Google Search Console after updates

---

## 6. GBP Photo Sync Strategy

Google Business Profile photos directly influence local pack rankings and click-through rates. Maintain a consistent upload cadence.

### Weekly Upload Schedule

| Day | Upload Type | Count | GBP Category |
|-----|-----------|-------|-------------|
| Monday | Completed tattoo work | 2-3 | At Work |
| Wednesday | Studio interior or detail shot | 1 | Interior |
| Friday | Completed tattoo work | 2-3 | At Work |
| 1st of month | Team photo or individual artist | 1 | Team |
| Quarterly | Exterior / storefront | 1 | Exterior |

### Photo Categories on GBP

- **Interior:** Clean station, waiting area, artwork on walls, studio vibe
- **Exterior:** Storefront, signage, building entrance, street view
- **At Work:** Completed tattoos (matching what is on the website), artist in action
- **Team:** Artist portraits, group photos, candid team moments

### Video Content

- **Studio tour:** 15-30 second walkthrough of the space
- **Tattoo timelapse:** Sped-up process video of a session (get client consent)
- **Artist intro:** 15-second clip of each artist introducing themselves
- Upload to GBP as "Videos" — these appear prominently on the listing

### Photo Quality Standards for GBP

- Minimum 720px on the shortest side (GBP requirement)
- Well-lit, in-focus, no heavy filters
- Show the actual Studio AZ space and work — never use photos from other locations
- Use the same photos that are on the website (consistency builds entity authority)

---

## 7. Image Count Targets Per Page

| Page | Image Count | Types |
|------|------------|-------|
| Home | 8-12 | Hero background, 2 artist preview portraits, 4-6 portfolio highlights, 1 studio shot, 1 embedded map or CTA image |
| Services | 4-6 | 1 process overview, 3-5 style examples (fine line, realism, black & grey, small tattoos) |
| Artists | 2-4 | 1 team group photo, 1-2 individual portraits, 1 studio environment shot |
| Joan Martinez | 8-12 | 1 portrait, 6-10 portfolio pieces showcasing fine line, realism, and black & grey |
| Andrew Fernandez | 8-12 | 1 portrait, 6-10 portfolio pieces showcasing small tattoos and first tattoo work |
| Gallery | 20-30 | Full portfolio grid, filterable by artist and style |
| Aftercare | 4-6 | 1-2 healing timeline images, 2-3 do's and don'ts visuals, 1 product recommendation photo |
| Parking | 3-5 | 1 parking map, 1 building entrance photo, 1-2 street-level direction photos, 1 transit info graphic |
| FAQ | 1-2 | 1 studio interior shot, 1 process or consultation image |
| Contact | 2-3 | 1 storefront exterior, 1 embedded map, 1 team or interior shot |

### Total Site Image Budget

- **Minimum:** ~55 unique images across all pages
- **Target:** ~80 unique images
- **Maximum:** ~100 (avoid bloat — every image should earn its place)

---

## 8. Image SEO Checklist (for Phase 3 Implementation)

Use this checklist during the build phase to verify every image on the site meets the strategy.

### Format & Delivery
- [ ] All images converted to WebP format with JPEG fallback (handled by `next/image`)
- [ ] Quality set to 80 for portfolio, 75 for decorative/background
- [ ] No image exceeds its file size target (200KB portfolio, 100KB thumbnails)
- [ ] Responsive `sizes` prop configured on every `next/image` instance

### Alt Text & File Names
- [ ] Every image has a unique, keyword-rich alt text (no duplicates site-wide)
- [ ] All file names are keyword-descriptive (no `IMG_001.jpg`, `DSC_4532.webp`, etc.)
- [ ] File names follow the `[style]-[subject]-[location]-[artist].webp` convention
- [ ] No file name contains "tattoo-shop-minneapolis" (domain already covers it)
- [ ] Alt text is under 125 characters per image
- [ ] 1-2 images across the site include the "tatoo" misspelling naturally in alt text

### Loading Performance
- [ ] Hero images on every page use the `priority` prop
- [ ] Below-fold images use default lazy loading with `placeholder="blur"`
- [ ] Gallery first 4 images use `priority`, remaining images lazy
- [ ] No layout shift from images loading (width/height or aspect-ratio set)

### Authenticity & Branding
- [ ] Zero stock images anywhere on the site
- [ ] Every portfolio image is real work done at Studio AZ
- [ ] Subtle logo watermark on portfolio images
- [ ] EXIF GPS data stripped for privacy

### Technical SEO
- [ ] Image sitemap includes all portfolio images with `<image:image>` tags
- [ ] Image sitemap submitted to Google Search Console
- [ ] Sitemap updated whenever new images are added

### GBP Sync
- [ ] GBP photo upload schedule established (weekly cadence)
- [ ] Interior, Exterior, At Work, and Team categories all populated
- [ ] At least one short video uploaded to GBP (studio tour or timelapse)
- [ ] GBP photos match website photos for entity consistency
