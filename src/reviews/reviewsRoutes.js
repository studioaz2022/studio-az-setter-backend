// ─── Reviews routes ───
// GET /api/reviews/barbershop — public endpoint, returns filtered 5-star reviews
//                               and aggregate stats for minneapolisbarbershop.com
//
// Implementation:
//   - Uses BARBERSHOP_PLACE_ID env var to select the place
//   - Filters reviews to 5-star only (matches positioning)
//   - Caches at the client layer (24h) — see googlePlacesClient.js
//   - Sets a CDN Cache-Control header so Vercel ISR can layer on top

const { fetchPlaceDetails } = require("./googlePlacesClient");
const { listReviews, STAR_TO_NUMBER } = require("../seo/gbpClient");

// GBP v4 ids for the barbershop listing (same account as tattoo; location
// discovered 2026-07-17 via listLocations). Used by the /mentions endpoint,
// which needs the FULL review history — Places API only ever returns 5.
const BARBERSHOP_GBP_ACCOUNT = "accounts/107017428683340496769";
const BARBERSHOP_GBP_LOCATION = "locations/3193954697909267343";

// 24h in-memory cache per mentioned name (500-review pull is expensive).
const mentionsCache = new Map(); // name -> { at, payload }
const MENTIONS_TTL_MS = 24 * 60 * 60 * 1000;

function registerReviewsRoutes(app) {
  app.get("/api/reviews/barbershop", async (req, res) => {
    const placeId = process.env.BARBERSHOP_PLACE_ID;
    if (!placeId) {
      return res.status(500).json({
        error: "BARBERSHOP_PLACE_ID env var is not set",
      });
    }

    try {
      const data = await fetchPlaceDetails(placeId);
      const fiveStarReviews = data.reviews.filter((r) => r.rating === 5);

      // 24-hour CDN cache (matches our internal cache TTL).
      // stale-while-revalidate lets Vercel serve a stale value while it
      // refreshes in the background.
      res.set(
        "Cache-Control",
        "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400"
      );

      return res.json({
        name: data.name,
        rating: data.rating,
        ratingDisplay: data.rating ? data.rating.toFixed(1) : "5.0",
        reviewCount: data.reviewCount,
        reviews: fiveStarReviews,
        fetchedFromCache: data.fromCache,
        lastUpdated: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[reviews] places fetch failed:", err.message);
      return res.status(502).json({
        error: "Failed to fetch reviews from Google Places API",
        detail: err.message,
      });
    }
  });

  // GET /api/reviews/barbershop/mentions?name=gilberto
  // Every published review whose text mentions the given name — the
  // per-barber proof feed for landing pages. Name-agnostic so every barber's
  // page can reuse it. Full history via GBP v4 (Places caps at 5 reviews).
  app.get("/api/reviews/barbershop/mentions", async (req, res) => {
    const name = String(req.query.name || "").trim().toLowerCase();
    if (!name || name.length < 3 || !/^[a-z\s'-]+$/.test(name)) {
      return res.status(400).json({ error: "name must be at least 3 letters" });
    }

    const cached = mentionsCache.get(name);
    if (cached && Date.now() - cached.at < MENTIONS_TTL_MS) {
      res.set("Cache-Control", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400");
      return res.json({ ...cached.payload, fetchedFromCache: true });
    }

    try {
      const { reviews, totalReviewCount, averageRating } = await listReviews(
        BARBERSHOP_GBP_ACCOUNT,
        BARBERSHOP_GBP_LOCATION
      );
      const matches = reviews
        .filter((r) => (r.comment || "").toLowerCase().includes(name))
        .map((r) => ({
          author: r.reviewer?.displayName || "Google user",
          rating: STAR_TO_NUMBER[r.starRating] ?? null,
          text: r.comment || "",
          publishedAt: r.createTime || null,
        }))
        .sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));

      const payload = {
        name: req.query.name,
        matches,
        matchCount: matches.length,
        shopRating: averageRating ?? null,
        shopReviewCount: totalReviewCount ?? null,
        lastUpdated: new Date().toISOString(),
      };
      mentionsCache.set(name, { at: Date.now(), payload });

      res.set("Cache-Control", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400");
      return res.json({ ...payload, fetchedFromCache: false });
    } catch (err) {
      console.error("[reviews] mentions fetch failed:", err.message);
      return res.status(502).json({ error: "GBP reviews fetch failed", detail: err.message });
    }
  });
}

module.exports = { registerReviewsRoutes };
