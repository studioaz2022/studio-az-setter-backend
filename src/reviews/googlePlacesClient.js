// ─── Google Places API (New) — Reviews client ───
// Wraps the Places API v1 endpoint with a small in-memory cache (24h)
// to stay well under the 10K/month free tier.
//
// Endpoint: GET /v1/places/{place_id}?fields=...
// Field mask is required — pricing depends on which fields you request.
// We use only "reviews" SKU fields which are in the free tier.
//
// Docs: https://developers.google.com/maps/documentation/places/web-service/place-details

const FIELD_MASK = "displayName,rating,userRatingCount,reviews";
const PLACES_BASE = "https://places.googleapis.com/v1/places";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const cache = new Map(); // placeId → { fetchedAt, data }

function isFresh(entry) {
  return entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

/**
 * Fetch place details + reviews from Google. Cached per-placeId for 24h.
 * Throws on network / auth errors so the route can return a clean 500.
 */
async function fetchPlaceDetails(placeId) {
  const cached = cache.get(placeId);
  if (isFresh(cached)) {
    return { ...cached.data, fromCache: true };
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_PLACES_API_KEY is not set");
  }

  const url = `${PLACES_BASE}/${encodeURIComponent(placeId)}`;
  const res = await fetch(url, {
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Places API ${res.status}: ${body}`);
  }

  const raw = await res.json();
  const data = normalize(raw);
  cache.set(placeId, { fetchedAt: Date.now(), data });
  return { ...data, fromCache: false };
}

function normalize(raw) {
  return {
    name: raw.displayName?.text || null,
    rating: typeof raw.rating === "number" ? raw.rating : null,
    reviewCount: raw.userRatingCount || 0,
    reviews: (raw.reviews || []).map((r) => ({
      id: r.name, // Google's review name acts as stable id
      author: r.authorAttribution?.displayName || "Anonymous",
      authorPhotoUrl: r.authorAttribution?.photoUri || null,
      authorProfileUrl: r.authorAttribution?.uri || null,
      rating: r.rating || null,
      text: r.text?.text || r.originalText?.text || "",
      languageCode: r.text?.languageCode || "en",
      publishedAt: r.publishTime || null,
      relativeTime: r.relativePublishTimeDescription || null,
      googleMapsUrl: r.googleMapsUri || null,
    })),
  };
}

module.exports = { fetchPlaceDetails };
