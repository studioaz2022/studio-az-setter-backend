// ─── Availability routes ───
// GET /api/availability/barbershop
//
// Returns per-barber "next available slot" for the barbershop website.
// Powers the "Next:" line rendered on each barber tile / card / page.
//
// Strategy: query all 9 barber calendars in parallel via GHL's getSlots,
// pick the earliest future slot from each, format for editorial display,
// cache 15 minutes.
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
 * Fetch the next slot for a single barber's calendar.
 * Returns { slug, name, nextSlot: ISO string | null } — null if none in window.
 */
async function fetchNextSlotForBarber(barber, startMs, endMs) {
  try {
    const data = await ghlBarber.calendars.getSlots({
      calendarId: barber.calendarId,
      startDate: startMs,
      endDate: endMs,
    });

    // Response format: { "2026-07-14": { slots: ["2026-07-14T10:00:00-05:00", ...] }, ... }
    // Pick the earliest slot across all date buckets.
    let earliest = null;
    for (const [dateKey, dateData] of Object.entries(data || {})) {
      if (dateKey === "traceId") continue;
      const slots = dateData?.slots || [];
      for (const slotIso of slots) {
        if (!earliest || slotIso < earliest) earliest = slotIso;
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

async function fetchAllBarberAvailability() {
  if (isFresh(cache)) {
    return { ...cache.data, fromCache: true };
  }

  const startMs = Date.now();
  const endMs = startMs + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000;

  // Query all 9 in parallel.
  const results = await Promise.all(
    BARBER_CALENDARS.map((b) => fetchNextSlotForBarber(b, startMs, endMs))
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

      // 15-min CDN cache (matches internal TTL). Vercel ISR layers on top.
      res.set(
        "Cache-Control",
        "public, max-age=300, s-maxage=900, stale-while-revalidate=900"
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
