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

// Word-boundary match, not substring.
//
// `.includes(name)` read as obviously correct and was quietly
// catastrophic: "elle" lives inside "exc-elle-nt", so Elle's feed filled
// with reviews praising Joshua, David, Drew and Logan. Publishing those
// under her name would be inventing attribution. Same trap waits in
// "anna" inside "Hannah"/"Savannah" and "drew" inside "Andrew".
//
// Lookarounds rather than \b so a trailing possessive still counts —
// "Elle's chair" and "Drews chill" are both real mentions — while a
// letter on either side is not. \p{L} (with the u flag) keeps accented
// names from reading as word boundaries.
function mentionRegex(name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}])${esc}(?:['\u2019]s|s)?(?![\\p{L}])`, "iu");
}

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
    // Comma-separated aliases: a barber is named in reviews by whichever
    // name clients actually use, and that isn't always the first one.
    // Lionel Chavez is written as "Chavez" in 75 reviews and "Lionel" in 5 —
    // querying the first name alone hid 93% of his own proof.
    const raw = String(req.query.name || "").trim().toLowerCase();
    const names = [...new Set(raw.split(",").map((n) => n.trim()).filter(Boolean))];
    const valid =
      names.length > 0 &&
      names.length <= 4 &&
      names.every((n) => n.length >= 3 && /^[a-z\s'-]+$/.test(n));
    if (!valid) {
      return res.status(400).json({ error: "name must be 1-4 aliases of 3+ letters each" });
    }
    const name = names.join(",");

    const cached = mentionsCache.get(name);
    if (cached && Date.now() - cached.at < MENTIONS_TTL_MS) {
      res.set("Cache-Control", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400");
      return res.json({ ...cached.payload, fetchedFromCache: true });
    }

    try {
      // GBP for the full review history, Places for the true totals.
      // listReviews reports `totalReviewCount: out.length`, which is a
      // pagination artifact — it caps at 10 pages x 50 and so reports 500
      // however many reviews the shop actually has. Places is authoritative
      // and already 24h-cached, so it costs nothing here.
      const [{ reviews, totalReviewCount, averageRating }, place] =
        await Promise.all([
          listReviews(BARBERSHOP_GBP_ACCOUNT, BARBERSHOP_GBP_LOCATION),
          process.env.BARBERSHOP_PLACE_ID
            ? fetchPlaceDetails(process.env.BARBERSHOP_PLACE_ID).catch(() => null)
            : Promise.resolve(null),
        ]);

      // One review naming both "Lionel" and "Chavez" is still one review,
      // so match against the alias set rather than concatenating per-alias
      // result lists.
      const res_ = names.map(mentionRegex);
      const matches = reviews
        .filter((r) => res_.some((re) => re.test(r.comment || "")))
        .map((r) => ({
          author: r.reviewer?.displayName || "Google user",
          authorPhotoUrl: r.reviewer?.profilePhotoUrl || null,
          rating: STAR_TO_NUMBER[r.starRating] ?? null,
          text: r.comment || "",
          publishedAt: r.createTime || null,
        }))
        .sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));

      const payload = {
        name: req.query.name,
        matches,
        matchCount: matches.length,
        shopRating: place?.rating ?? averageRating ?? null,
        shopReviewCount: place?.reviewCount ?? totalReviewCount ?? null,
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
