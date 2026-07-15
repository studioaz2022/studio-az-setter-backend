// ─── Booking widget routes (barbershop website) ───
//
// READ side (this file, Phase 1):
//   GET /api/booking/barbershop/services
//   GET /api/availability/barbershop/:barberSlug/slots?service=<slug>&days=7
//
// WRITE side (Phase 2, registered from bookingCreate.js):
//   POST /api/booking/barbershop/create
//
// See BOOKING_WIDGET_PLAN.md. GHL is the source of truth; these endpoints are
// a thin, cache-fronted proxy over ghlBarber.calendars.getSlots(). All 9
// calendars are round_robin — availability ONLY via getSlots, never openHours.
//
// Public endpoints (the website calls them from the browser) — no INTERNAL_API_KEY.

const { ghlBarber } = require("../clients/ghlMultiLocationSdk");
const {
  SERVICES,
  SERVICE_ORDER,
  getBarber,
  serviceOffered,
  eligibleBarbers,
  durationMinutes,
} = require("./barberDirectory");

const SHOP_TZ = "America/Chicago";
const SLOTS_CACHE_TTL_MS = 60 * 1000; // time-picker needs fresher data than the 15-min "Next:" tiles
const MAX_DAYS = 14;
const DEFAULT_DAYS = 7;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 700; // 700 / 1400 / 2800
const BATCH_SIZE = 3; // first-available fan-out, same stagger as availabilityRoutes
const BATCH_GAP_MS = 300;

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

// ── slot post-processing ─────────────────────────────────────────────

/**
 * Flatten a getSlots response into { [dateKey]: [iso, ...] }, dropping traceId
 * and any slots already in the past.
 */
function normalizeSlotsResponse(raw, nowMs) {
  const days = {};
  for (const [dateKey, dateData] of Object.entries(raw || {})) {
    if (dateKey === "traceId") continue;
    const slots = (dateData?.slots || []).filter((iso) => {
      const ms = Date.parse(iso);
      return Number.isFinite(ms) && ms > nowMs;
    });
    if (slots.length) days[dateKey] = slots;
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

// ── per-(barber × service × days) cache with last-known-good ─────────

const slotsCache = new Map(); // key → { fetchedAt, days }
const slotsLKG = new Map(); // key → { fetchedAt, days }
const inFlight = new Map(); // key → Promise — stampede guard: concurrent cache
// misses for the same barber×service share ONE getSlots call instead of
// hammering GHL with N parallel identical reads.

function stripPastFromDays(days, nowMs) {
  const out = {};
  for (const [dateKey, slots] of Object.entries(days)) {
    const future = slots.filter((iso) => Date.parse(iso) > nowMs);
    if (future.length) out[dateKey] = future;
  }
  return out;
}

/**
 * Fetch (or serve cached) slots for one barber × service.
 * Returns { days, stale } — days values are arrays of ISO strings.
 */
async function slotsForBarberService(barberSlug, serviceSlug, numDays) {
  const barber = getBarber(barberSlug);
  const serviceMins = durationMinutes(barberSlug, serviceSlug);
  const key = `${barberSlug}:${serviceSlug}:${numDays}`;
  const nowMs = Date.now();

  const cached = slotsCache.get(key);
  if (cached && nowMs - cached.fetchedAt < SLOTS_CACHE_TTL_MS) {
    return { days: stripPastFromDays(cached.days, nowMs), stale: false };
  }

  if (inFlight.has(key)) return inFlight.get(key);

  const fetchPromise = (async () => {
    try {
      const endMs = nowMs + numDays * 24 * 60 * 60 * 1000;
      const raw = await getSlotsWithRetry(barber.calendarId, nowMs, endMs);
      let days = normalizeSlotsResponse(raw, nowMs);
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

// ── first-available: merge across eligible barbers ───────────────────

/**
 * Staggered slots fetch across every barber offering the service. Returns
 * merged days where each entry is { t, barber } sorted by time, so the widget
 * can show who the slot belongs to. Barbers whose fetch fails (post-LKG) are
 * skipped rather than failing the whole merge.
 */
async function slotsFirstAvailable(serviceSlug, numDays) {
  const eligible = eligibleBarbers(serviceSlug);
  const results = [];
  let anyStale = false;

  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const batch = eligible.slice(i, i + BATCH_SIZE);
    const settled = await Promise.all(
      batch.map(async (b) => {
        try {
          const r = await slotsForBarberService(b.slug, serviceSlug, numDays);
          return { slug: b.slug, ...r };
        } catch (err) {
          console.warn(`[booking] first-available: skipping ${b.name} (${err?.message})`);
          return null;
        }
      })
    );
    results.push(...settled.filter(Boolean));
    if (i + BATCH_SIZE < eligible.length) await sleep(BATCH_GAP_MS);
  }

  const merged = {};
  for (const r of results) {
    if (r.stale) anyStale = true;
    for (const [dateKey, slots] of Object.entries(r.days)) {
      if (!merged[dateKey]) merged[dateKey] = [];
      for (const iso of slots) merged[dateKey].push({ t: iso, barber: r.slug });
    }
  }
  for (const dateKey of Object.keys(merged)) {
    merged[dateKey].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  }
  return { days: merged, stale: anyStale };
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
    const numDays = Math.min(
      Math.max(parseInt(req.query.days, 10) || DEFAULT_DAYS, 1),
      MAX_DAYS
    );

    if (!SERVICES[serviceSlug]) {
      return res.status(400).json({ error: `Unknown service: ${serviceSlug}` });
    }

    try {
      if (barberSlug === "first-available") {
        if (!eligibleBarbers(serviceSlug).length) {
          return res.status(400).json({ error: `No barbers offer ${serviceSlug}` });
        }
        const { days, stale } = await slotsFirstAvailable(serviceSlug, numDays);
        res.set("Cache-Control", "public, max-age=30, s-maxage=60");
        return res.json({
          barber: "first-available",
          service: serviceSlug,
          tz: SHOP_TZ,
          days,
          fetchedAt: new Date().toISOString(),
          ...(stale ? { stale: true } : {}),
        });
      }

      if (!getBarber(barberSlug)) {
        return res.status(404).json({ error: `Unknown barber: ${barberSlug}` });
      }
      if (!serviceOffered(barberSlug, serviceSlug)) {
        return res
          .status(400)
          .json({ error: `${barberSlug} does not offer ${serviceSlug}` });
      }

      const { days, stale } = await slotsForBarberService(
        barberSlug,
        serviceSlug,
        numDays
      );
      // uniform shape with first-available: entries are { t, barber }
      const shaped = {};
      for (const [dateKey, slots] of Object.entries(days)) {
        shaped[dateKey] = slots.map((iso) => ({ t: iso, barber: barberSlug }));
      }
      res.set("Cache-Control", "public, max-age=30, s-maxage=60");
      return res.json({
        barber: barberSlug,
        service: serviceSlug,
        tz: SHOP_TZ,
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
