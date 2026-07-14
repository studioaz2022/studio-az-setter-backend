// ─── Availability routes ───
// GET /api/availability/barbershop
//
// Returns per-barber "next available slot" for the barbershop website.
// Powers the "Next:" line rendered on each barber tile / card / page.
//
// Strategy: query all 9 barber calendars in parallel via GHL's getSlots,
// pick the earliest FUTURE slot from each, cache 15 minutes.
//
// Past-slot filtering (added 2026-07-13):
//   - fetchNextSlotForBarber() drops any slot <= now (nowMs comparison, TZ-safe)
//   - cache re-filter on serve: even if we cached "Liam at 6:45pm" 3 hours ago
//     and it's now 8pm, drop that stale slot before returning
//
// Auth: uses ghlBarber SDK instance (barbershop location, PIT token).

const { ghlBarber } = require("../clients/ghlMultiLocationSdk");

// Map: barber slug → { name, ghlCalendarId }.
// IMPORTANT: Lionel uses the REGULAR haircut calendar (Bsv9ngkRgsbLzgtN3Vpq),
// NOT the friends & family calendar. Per Lionel directive 2026-07-13.
const BARBER_CALENDARS = [
  { slug: "gilberto", name: "Gilberto Castro",  calendarId: "38Uhu6i5W4L5yGJbE0My" },
  { slug: "liam",     name: "Liam Meagher",     calendarId: "kiGx7ec1vj9e62U33ZhU" },
  { slug: "david",    name: "David Mackflin",   calendarId: "qvcPzTqyaQOxsijIQqAN" },
  { slug: "logan",    name: "Logan Jensen",     calendarId: "o1fvyti3GnoFGKZN5Hwr" },
  { slug: "drew",     name: "Drew Smith",       calendarId: "AzIK0eW09u4V1jJTXQ0x" },
  { slug: "elle",     name: "Elle Gibeau",      calendarId: "Bcqa2hqjUX7xhNu37cL1" },
  { slug: "joshua",   name: "Joshua Flores",    calendarId: "X1xINoRML65yAOVUsAGa" },
  { slug: "chavez",   name: "Lionel Chavez",    calendarId: "Bsv9ngkRgsbLzgtN3Vpq" },
  { slug: "anna",     name: "Anna Kinkead",     calendarId: "WWduImUIgEoEx8mBTkmp" },
];

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const LOOKAHEAD_DAYS = 30;

let cache = null; // { fetchedAt, data }

function isFresh(entry) {
  return entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

/**
 * Fetch the next FUTURE slot for a single barber's calendar. Any slot at
 * or before nowMs is filtered out — using ms-since-epoch comparison, which
 * is timezone-agnostic. Returns null if the barber has no future slots
 * inside the lookahead window.
 */
async function fetchNextSlotForBarber(barber, startMs, endMs, nowMs) {
  try {
    const data = await ghlBarber.calendars.getSlots({
      calendarId: barber.calendarId,
      startDate: startMs,
      endDate: endMs,
    });

    // Response format: { "2026-07-14": { slots: ["2026-07-14T10:00:00-05:00", ...] }, ... }
    let earliest = null;
    let earliestMs = Infinity;
    for (const [dateKey, dateData] of Object.entries(data || {})) {
      if (dateKey === "traceId") continue;
      const slots = dateData?.slots || [];
      for (const slotIso of slots) {
        const slotMs = Date.parse(slotIso);
        if (Number.isNaN(slotMs)) continue;
        if (slotMs <= nowMs) continue; // past — skip
        if (slotMs < earliestMs) {
          earliestMs = slotMs;
          earliest = slotIso;
        }
      }
    }

    return { slug: barber.slug, name: barber.name, nextSlot: earliest };
  } catch (err) {
    console.warn(
      `[availability] getSlots failed for ${barber.name} (${barber.calendarId}):`,
      err.message
    );
    return { slug: barber.slug, name: barber.name, nextSlot: null, error: err.message };
  }
}

/**
 * Serve the cached payload but strip any slots that have gone stale since
 * we cached. If ANY cached slot is now in the past, invalidate the cache
 * entirely and re-query — the cached data is unreliable.
 */
function filterCachedForPastSlots(cached, nowMs) {
  const filtered = {};
  let sawPast = false;
  for (const [slug, entry] of Object.entries(cached.data.barbers)) {
    if (!entry.nextSlot) {
      filtered[slug] = entry;
      continue;
    }
    const slotMs = Date.parse(entry.nextSlot);
    if (Number.isFinite(slotMs) && slotMs > nowMs) {
      filtered[slug] = entry;
    } else {
      sawPast = true;
      break;
    }
  }
  if (sawPast) return null; // signal: force refresh
  return { ...cached.data, barbers: filtered, fromCache: true };
}

async function fetchAllBarberAvailability() {
  const nowMs = Date.now();

  if (isFresh(cache)) {
    const cachedResponse = filterCachedForPastSlots(cache, nowMs);
    if (cachedResponse) return cachedResponse;
    // Cache had past slots — invalidate and fall through to refresh.
    cache = null;
  }

  const endMs = nowMs + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000;

  const results = await Promise.all(
    BARBER_CALENDARS.map((b) => fetchNextSlotForBarber(b, nowMs, endMs, nowMs))
  );

  const byBarber = {};
  for (const r of results) {
    byBarber[r.slug] = {
      name: r.name,
      nextSlot: r.nextSlot,
      ...(r.error ? { error: r.error } : {}),
    };
  }

  const data = {
    barbers: byBarber,
    lookaheadDays: LOOKAHEAD_DAYS,
    fetchedAt: new Date().toISOString(),
  };

  cache = { fetchedAt: Date.now(), data };
  return { ...data, fromCache: false };
}

function registerAvailabilityRoutes(app) {
  app.get("/api/availability/barbershop", async (req, res) => {
    if (!ghlBarber) {
      return res.status(500).json({
        error:
          "ghlBarber SDK not initialized — check GHL_BARBER_SHOP_TOKEN env var",
      });
    }

    try {
      const data = await fetchAllBarberAvailability();

      // Shorter CDN cache (5 min instead of 15) — availability moves faster
      // than reviews, and stale-while-revalidate lets us serve fresh values
      // without forcing users to wait.
      res.set(
        "Cache-Control",
        "public, max-age=120, s-maxage=300, stale-while-revalidate=300"
      );
      return res.json(data);
    } catch (err) {
      console.error("[availability] fetch failed:", err.message);
      return res.status(502).json({
        error: "Failed to fetch availability",
        detail: err.message,
      });
    }
  });
}

module.exports = { registerAvailabilityRoutes };
