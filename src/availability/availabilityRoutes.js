// ─── Availability routes ───
// GET /api/availability/barbershop
//
// Returns per-barber "next available slot" for the barbershop website.
// Powers the "Next:" line rendered on each barber tile / card / page.
//
// Strategy:
//   - Query 9 barber calendars, but STAGGERED (batches of 3 with a 250ms gap)
//     to avoid GHL rate-limit 429s
//   - Retry each barber up to 3 times with backoff on 429
//   - Per-barber last-known-good cache: if a request ultimately fails,
//     serve the barber's previous good value instead of null (silent recovery)
//   - Aggregate 15-min in-memory cache with past-slot re-filter on serve
//   - CDN Cache-Control: s-maxage=300 (5 min)
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

// Rate-limit tuning. GHL's per-second cap makes 9 concurrent calls unreliable.
const BATCH_SIZE = 3;         // 3 requests per burst
const BATCH_GAP_MS = 300;      // 300ms between bursts
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 700;    // 700ms, 1400ms, 2800ms

let cache = null; // { fetchedAt, data }

// Per-barber last-known-good slot. Survives rate-limit blips so a barber
// doesn't blink to null on transient errors. Only overwritten by successful
// FETCHES (not by cache hits).
const lastKnownGood = new Map(); // slug → { nextSlot, fetchedAt }

function isFresh(entry) {
  return entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRateLimitError(err) {
  if (!err) return false;
  const status = err.status || err.response?.status;
  if (status === 429) return true;
  const msg = String(err.message || "");
  return /too many requests|rate limit|429/i.test(msg);
}

/**
 * Fetch the next FUTURE slot for a single barber, with retry on 429.
 */
async function fetchNextSlotForBarberWithRetry(barber, startMs, endMs, nowMs) {
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const data = await ghlBarber.calendars.getSlots({
        calendarId: barber.calendarId,
        startDate: startMs,
        endDate: endMs,
      });

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

      // Success — update last-known-good.
      lastKnownGood.set(barber.slug, {
        nextSlot: earliest,
        fetchedAt: Date.now(),
      });
      return { slug: barber.slug, name: barber.name, nextSlot: earliest };
    } catch (err) {
      lastErr = err;
      if (isRateLimitError(err) && attempt < MAX_RETRIES - 1) {
        const wait = RETRY_BASE_MS * Math.pow(2, attempt);
        console.warn(
          `[availability] 429 for ${barber.name}, retry ${attempt + 1} in ${wait}ms`
        );
        await sleep(wait);
        continue;
      }
      break;
    }
  }

  // All retries failed — fall back to last-known-good if we have one.
  const fallback = lastKnownGood.get(barber.slug);
  if (fallback && fallback.nextSlot) {
    // But only if that slot is still in the future.
    const slotMs = Date.parse(fallback.nextSlot);
    if (Number.isFinite(slotMs) && slotMs > nowMs) {
      console.warn(
        `[availability] using last-known-good for ${barber.name} (${lastErr?.message})`
      );
      return {
        slug: barber.slug,
        name: barber.name,
        nextSlot: fallback.nextSlot,
        stale: true,
      };
    }
  }

  console.warn(
    `[availability] getSlots failed for ${barber.name} (${barber.calendarId}):`,
    lastErr?.message
  );
  return {
    slug: barber.slug,
    name: barber.name,
    nextSlot: null,
    error: lastErr?.message,
  };
}

/**
 * Query all 9 barbers in staggered batches to stay under GHL's per-second
 * rate limit while still finishing in ~1s total.
 */
async function fetchAllBarbersStaggered(startMs, endMs, nowMs) {
  const results = [];
  for (let i = 0; i < BARBER_CALENDARS.length; i += BATCH_SIZE) {
    const batch = BARBER_CALENDARS.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((b) => fetchNextSlotForBarberWithRetry(b, startMs, endMs, nowMs))
    );
    results.push(...batchResults);
    if (i + BATCH_SIZE < BARBER_CALENDARS.length) {
      await sleep(BATCH_GAP_MS);
    }
  }
  return results;
}

/**
 * Serve the cached payload but strip any slots that have gone stale since
 * we cached. If ANY cached slot is now in the past, invalidate cache entirely.
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
  if (sawPast) return null;
  return { ...cached.data, barbers: filtered, fromCache: true };
}

async function fetchAllBarberAvailability() {
  const nowMs = Date.now();

  if (isFresh(cache)) {
    const cachedResponse = filterCachedForPastSlots(cache, nowMs);
    if (cachedResponse) return cachedResponse;
    cache = null;
  }

  const endMs = nowMs + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000;
  const results = await fetchAllBarbersStaggered(nowMs, endMs, nowMs);

  const byBarber = {};
  for (const r of results) {
    byBarber[r.slug] = {
      name: r.name,
      nextSlot: r.nextSlot,
      ...(r.error ? { error: r.error } : {}),
      ...(r.stale ? { stale: true } : {}),
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
