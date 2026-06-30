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
}

module.exports = { registerReviewsRoutes };
