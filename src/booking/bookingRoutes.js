// ─── Booking widget routes (barbershop website) ───
//
// READ side (this file):
//   GET /api/booking/barbershop/services
//   GET /api/availability/barbershop/:barberSlug/slots?service=<slug>
//
// WRITE side (registered from bookingCreate.js):
//   POST /api/booking/barbershop/create
//
// See BOOKING_WIDGET_PLAN.md. GHL is the source of truth; these endpoints are
// a thin, cache-fronted proxy over ghlBarber.calendars.getSlots(). All 9
// calendars are round_robin — availability ONLY via getSlots, never openHours.
//
// Public endpoints (the website calls them from the browser) — no INTERNAL_API_KEY.
//
// 60-DAY HORIZON (2026-07-16): getSlots hard-rejects any single query range
// > 31 days ("Date range cannot be more than 31 days"), so we paginate into two
// 30-day windows and merge. Each calendar self-limits by its own allowBookingFor
// (Lionel = 31 days → his 2nd window comes back empty; everyone else = 61 days →
// fills through ~60). No per-barber code needed. The month-calendar frontend
// fetches this 60-day map ONCE and slices it into months client-side.

const { ghlBarber } = require("../clients/ghlMultiLocationSdk");
const {
  SERVICES,
  SERVICE_ORDER,
  getBarber,
  serviceOffered,
  eligibleBarbers,
  durationMinutes,
  serviceNote,
} = require("./barberDirectory");

const SHOP_TZ = "America/Chicago";
const SLOTS_CACHE_TTL_MS = 60 * 1000; // time-picker needs fresher data than the 15-min "Next:" tiles
const HORIZON_DAYS = 60; // how far out the widget shows
const CHUNK_DAYS = 30; // per getSlots call — MUST stay ≤ 31 (GHL hard cap)
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 700; // 700 / 1400 / 2800
const WINDOW_GAP_MS = 250; // small stagger between the paginated windows

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRateLimitError(err) {
  if (!err) return false;
  const status = err.status || err.response?.status;
  if (status === 429) return true;
  return /too many requests|rate limit|429/i.test(String(err.message || ""));
}

// ── getSlots with retry ──────────────────────────────────────────────

async function getSlotsWithRetry(calendarId, startMs, endMs) {
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await ghlBarber.calendars.getSlots({
        calendarId,
        startDate: startMs,
        endDate: endMs,
      });
    } catch (err) {
      lastErr = err;
      if (isRateLimitError(err) && attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

/**
 * Fetch the full HORIZON_DAYS window for one calendar, paginated into
 * CHUNK_DAYS-sized getSlots calls (GHL caps a single query at 31 days).
 * Windows are sequential + slightly staggered to stay under the rate limit.
 * Returns the list of raw getSlots responses.
 */
async function getSlotsHorizon(calendarId, nowMs) {
  const raws = [];
  for (let offset = 0; offset < HORIZON_DAYS; offset += CHUNK_DAYS) {
    const startMs = nowMs + offset * 24 * 60 * 60 * 1000;
    const span = Math.min(CHUNK_DAYS, HORIZON_DAYS - offset);
    const endMs = startMs + span * 24 * 60 * 60 * 1000;
    raws.push(await getSlotsWithRetry(calendarId, startMs, endMs));
    if (offset + CHUNK_DAYS < HORIZON_DAYS) await sleep(WINDOW_GAP_MS);
  }
  return raws;
}

// ── slot post-processing ─────────────────────────────────────────────

/**
 * Merge the paginated getSlots responses into { [dateKey]: [iso, ...] },
 * dropping traceId, past slots, and boundary-day duplicates (the two windows
 * share their boundary day).
 */
function mergeSlotWindows(raws, nowMs) {
  const byDay = {}; // dateKey → Set<iso>
  for (const raw of raws) {
    for (const [dateKey, dateData] of Object.entries(raw || {})) {
      if (dateKey === "traceId") continue;
      for (const iso of dateData?.slots || []) {
        const ms = Date.parse(iso);
        if (!Number.isFinite(ms) || ms <= nowMs) continue;
        (byDay[dateKey] ||= new Set()).add(iso);
      }
    }
  }
  const days = {};
  for (const [dateKey, set] of Object.entries(byDay)) {
    days[dateKey] = [...set].sort((a, b) => Date.parse(a) - Date.parse(b));
  }
  return days;
}

/**
 * For a service LONGER than the barber's native slot (the combo), keep only
 * slots with enough contiguous free room: the next K grid slots must also be
 * bookable, where K*interval covers the extra minutes. getSlots only proves
 * native-duration room; this proves combo room. (Verified in the Phase 0
 * spike: an explicit longer endTime really blocks the adjacent slots, so the
 * inverse — adjacent slots present — proves the room is free.)
 */
function filterForDuration(days, barber, serviceMins) {
  const native = barber.slotDurationMinutes;
  if (serviceMins <= native) return days;
  const intervalMs = barber.slotIntervalMinutes * 60 * 1000;
  const extraSteps = Math.ceil((serviceMins - native) / barber.slotIntervalMinutes);

  const filtered = {};
  for (const [dateKey, slots] of Object.entries(days)) {
    const set = new Set(slots.map((iso) => Date.parse(iso)));
    const ok = slots.filter((iso) => {
      const start = Date.parse(iso);
      for (let k = 1; k <= extraSteps; k++) {
        if (!set.has(start + k * intervalMs)) return false;
      }
      return true;
    });
    if (ok.length) filtered[dateKey] = ok;
  }
  return filtered;
}

/** Earliest future slot ISO across the day map, or null. */
function earliestSlot(days) {
  let earliest = null;
  let earliestMs = Infinity;
  for (const slots of Object.values(days)) {
    for (const iso of slots) {
      const ms = Date.parse(iso);
      if (ms < earliestMs) {
        earliestMs = ms;
        earliest = iso;
      }
    }
  }
  return earliest;
}

// ── per-(barber × service) cache with last-known-good ────────────────

const slotsCache = new Map(); // key → { fetchedAt, days }
const slotsLKG = new Map(); // key → { fetchedAt, days }
const inFlight = new Map(); // key → Promise — stampede guard: concurrent cache
// misses for the same barber×service share ONE fetch instead of hammering GHL.

function stripPastFromDays(days, nowMs) {
  const out = {};
  for (const [dateKey, slots] of Object.entries(days)) {
    const future = slots.filter((iso) => Date.parse(iso) > nowMs);
    if (future.length) out[dateKey] = future;
  }
  return out;
}

/**
 * Fetch (or serve cached) the full 60-day slot map for one barber × service.
 * Returns { days, stale } — days values are arrays of ISO strings.
 */
async function slotsForBarberService(barberSlug, serviceSlug) {
  const barber = getBarber(barberSlug);
  const serviceMins = durationMinutes(barberSlug, serviceSlug);
  const key = `${barberSlug}:${serviceSlug}`;
  const nowMs = Date.now();

  const cached = slotsCache.get(key);
  if (cached && nowMs - cached.fetchedAt < SLOTS_CACHE_TTL_MS) {
    return { days: stripPastFromDays(cached.days, nowMs), stale: false };
  }

  if (inFlight.has(key)) return inFlight.get(key);

  const fetchPromise = (async () => {
    try {
      const raws = await getSlotsHorizon(barber.calendarId, nowMs);
      let days = mergeSlotWindows(raws, nowMs);
      days = filterForDuration(days, barber, serviceMins);
      slotsCache.set(key, { fetchedAt: nowMs, days });
      slotsLKG.set(key, { fetchedAt: nowMs, days });
      return { days, stale: false };
    } catch (err) {
      const lkg = slotsLKG.get(key);
      if (lkg) {
        console.warn(
          `[booking] getSlots failed for ${barberSlug}/${serviceSlug}, serving last-known-good (${err?.message})`
        );
        return { days: stripPastFromDays(lkg.days, nowMs), stale: true };
      }
      throw err;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, fetchPromise);
  return fetchPromise;
}

// ── services catalog ─────────────────────────────────────────────────

function servicesCatalog() {
  return SERVICE_ORDER.map((slug) => {
    const s = SERVICES[slug];
    return {
      slug,
      label: s.label,
      barbers: eligibleBarbers(slug).map((b) => ({
        slug: b.slug,
        name: b.name,
        price: b.prices[slug], // null = "Varies"
        durationMinutes: durationMinutes(b.slug, slug),
        note: serviceNote(b.slug, slug), // per-barber caveat, or null
      })),
    };
  });
}

// ── routes ───────────────────────────────────────────────────────────

function registerBookingRoutes(app) {
  // write side (POST /api/booking/barbershop/create) — see bookingCreate.js
  require("./bookingCreate").registerBookingCreateRoute(app);

  app.get("/api/booking/barbershop/services", (req, res) => {
    res.set("Cache-Control", "public, max-age=3600, s-maxage=86400");
    return res.json({ services: servicesCatalog(), tz: SHOP_TZ });
  });

  app.get("/api/availability/barbershop/:barberSlug/slots", async (req, res) => {
    if (!ghlBarber) {
      return res.status(500).json({ error: "ghlBarber SDK not initialized" });
    }

    const { barberSlug } = req.params;
    const serviceSlug = String(req.query.service || "haircut");

    if (!SERVICES[serviceSlug]) {
      return res.status(400).json({ error: `Unknown service: ${serviceSlug}` });
    }
    if (!getBarber(barberSlug)) {
      return res.status(404).json({ error: `Unknown barber: ${barberSlug}` });
    }
    if (!serviceOffered(barberSlug, serviceSlug)) {
      return res
        .status(400)
        .json({ error: `${barberSlug} does not offer ${serviceSlug}` });
    }

    try {
      const { days, stale } = await slotsForBarberService(barberSlug, serviceSlug);
      // entries are { t, barber } for a uniform shape the widget can render
      const shaped = {};
      for (const [dateKey, slots] of Object.entries(days)) {
        shaped[dateKey] = slots.map((iso) => ({ t: iso, barber: barberSlug }));
      }
      res.set("Cache-Control", "public, max-age=30, s-maxage=60");
      return res.json({
        barber: barberSlug,
        service: serviceSlug,
        tz: SHOP_TZ,
        horizonDays: HORIZON_DAYS,
        nextAvailable: earliestSlot(days), // ISO or null — powers the gap callout
        days: shaped,
        fetchedAt: new Date().toISOString(),
        ...(stale ? { stale: true } : {}),
      });
    } catch (err) {
      console.error(
        `[booking] slots fetch failed for ${barberSlug}/${serviceSlug}:`,
        err?.message
      );
      return res
        .status(502)
        .json({ error: "Failed to fetch availability", detail: err?.message });
    }
  });
}

module.exports = { registerBookingRoutes, slotsForBarberService };
