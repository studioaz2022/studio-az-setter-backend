// ─── POST /api/booking/barbershop/create ───
//
// The booking widget's public write endpoint. Pipeline (every failure gets an
// audit row + a clean status code):
//   1. IP rate limit (5 attempts / 10 min)
//   2. Body validation
//   3. Cloudflare Turnstile server-side verify
//   4. ghlBarber.contacts.upsertContact (dedup by phone/email per location setting)
//   5. Combo room re-check (fresh getSlots) for services longer than native slot
//   6. ghlBarber.calendars.createAppointment — ignoreFreeSlotValidation: FALSE
//      (double-booking protection; do NOT copy the tattoo client's true default)
//   7. Slot-taken → 409 + 3 nearest alternates
//
// toNotify: true → GHL workflow sends the confirmation SMS (verified Phase 0:
// exactly once, includes modify/cancel link). The widget sends NO SMS itself.

const { ghlBarber } = require("../clients/ghlMultiLocationSdk");
const {
  SERVICES,
  getBarber,
  serviceOffered,
  durationMinutes,
} = require("./barberDirectory");
const { logBookingAttempt } = require("./bookingAudit");

const LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID;
const SHOP_ADDRESS = "333 Washington Ave N, Suite 100";
const MAX_BOOKAHEAD_DAYS = 31; // matches GHL calendar allowBookingFor

// ── IP rate limit: 5 attempts / 10 min (in-memory; single Render instance) ──
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const attemptsByIp = new Map(); // ip → [timestamps]

function rateLimited(ip) {
  const now = Date.now();
  const list = (attemptsByIp.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_LIMIT) {
    attemptsByIp.set(ip, list);
    return true;
  }
  list.push(now);
  attemptsByIp.set(ip, list);
  // opportunistic cleanup so the map doesn't grow unbounded
  if (attemptsByIp.size > 5000) {
    for (const [k, v] of attemptsByIp) {
      if (!v.some((t) => now - t < RATE_WINDOW_MS)) attemptsByIp.delete(k);
    }
  }
  return false;
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || "unknown";
}

// ── validation helpers ───────────────────────────────────────────────

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function validateBody(body) {
  const errors = [];
  const barberSlug = String(body.barberSlug || "");
  const service = String(body.service || "");
  const firstName = String(body.firstName || "").trim();
  const lastName = String(body.lastName || "").trim();
  const email = String(body.email || "").trim();
  const note = String(body.note || "").trim().slice(0, 500);
  const phone = normalizePhone(body.phone);
  const slotISO = String(body.slotISO || "");
  const slotMs = Date.parse(slotISO);

  if (!getBarber(barberSlug)) errors.push("unknown barber");
  else if (!serviceOffered(barberSlug, service)) errors.push("barber does not offer that service");
  if (!SERVICES[service]) errors.push("unknown service");
  if (!firstName || firstName.length > 60) errors.push("first name required");
  if (!lastName || lastName.length > 60) errors.push("last name required");
  if (!phone) errors.push("valid US phone required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) errors.push("valid email required");
  if (!Number.isFinite(slotMs)) errors.push("invalid slot time");
  else {
    if (slotMs <= Date.now()) errors.push("slot is in the past");
    if (slotMs > Date.now() + MAX_BOOKAHEAD_DAYS * 24 * 3600 * 1000) errors.push("slot too far out");
  }
  if (!body.turnstileToken) errors.push("missing captcha token");

  return {
    errors,
    clean: { barberSlug, service, firstName, lastName, email, phone, note, slotISO, slotMs },
  };
}

// ── Turnstile ────────────────────────────────────────────────────────

async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.error("[booking] TURNSTILE_SECRET_KEY unset — failing closed");
    return false;
  }
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
    });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error("[booking] turnstile verify errored:", err?.message);
    return false;
  }
}

// ── slot helpers ─────────────────────────────────────────────────────

function isSlotTakenError(err) {
  const msg =
    err?.response?.data?.message || err?.message || "";
  return /no longer available|slot.*not available|not available.*slot/i.test(String(msg));
}

/**
 * Fresh (uncached) getSlots to re-verify room at write time. Returns the
 * day's future slot start times in ms, or null if the read fails (in which
 * case we let GHL's own validation be the arbiter).
 */
async function freshDaySlots(calendarId, slotMs) {
  try {
    const dayStart = slotMs - 24 * 3600 * 1000;
    const dayEnd = slotMs + 24 * 3600 * 1000;
    const raw = await ghlBarber.calendars.getSlots({
      calendarId,
      startDate: dayStart,
      endDate: dayEnd,
    });
    const all = [];
    for (const [k, v] of Object.entries(raw || {})) {
      if (k === "traceId") continue;
      for (const iso of v?.slots || []) {
        const ms = Date.parse(iso);
        if (Number.isFinite(ms)) all.push(ms);
      }
    }
    return all.sort((a, b) => a - b);
  } catch (err) {
    console.warn("[booking] fresh slot re-check failed (proceeding, GHL validates):", err?.message);
    return null;
  }
}

/** 3 nearest future alternates to a requested (now unavailable) slot. */
function nearestAlternates(allSlotsMs, requestedMs) {
  return allSlotsMs
    .filter((ms) => ms !== requestedMs && ms > Date.now())
    .sort((a, b) => Math.abs(a - requestedMs) - Math.abs(b - requestedMs))
    .slice(0, 3)
    .sort((a, b) => a - b)
    .map((ms) => new Date(ms).toISOString());
}

// ── route ────────────────────────────────────────────────────────────

function registerBookingCreateRoute(app) {
  app.post("/api/booking/barbershop/create", async (req, res) => {
    const ip = clientIp(req);
    const body = req.body || {};
    const audit = {
      barberSlug: body.barberSlug,
      service: body.service,
      slotISO: body.slotISO,
      ip,
    };

    if (!ghlBarber || !LOCATION_ID) {
      await logBookingAttempt({
        ...audit, success: false, stepReached: "received",
        summary: "FAILED: backend GHL not configured",
      });
      return res.status(500).json({ error: "booking_unavailable" });
    }

    // 1. rate limit
    if (rateLimited(ip)) {
      await logBookingAttempt({
        ...audit, success: false, stepReached: "rate_limited",
        summary: "FAILED: IP rate limited",
      });
      return res.status(429).json({ error: "rate_limited" });
    }

    // 2. validation
    const { errors, clean } = validateBody(body);
    if (errors.length) {
      await logBookingAttempt({
        ...audit, success: false, stepReached: "validation",
        summary: `FAILED validation: ${errors.join("; ")}`,
      });
      return res.status(400).json({ error: "validation", details: errors });
    }
    const barber = getBarber(clean.barberSlug);
    const serviceDef = SERVICES[clean.service];
    const mins = durationMinutes(clean.barberSlug, clean.service);
    const slotLabel = `${serviceDef.label} with ${barber.name}, ${clean.slotISO}`;

    // 3. Turnstile
    const humanOk = await verifyTurnstile(body.turnstileToken, ip);
    if (!humanOk) {
      await logBookingAttempt({
        ...audit, success: false, stepReached: "turnstile", turnstileOk: false,
        summary: `FAILED turnstile: ${slotLabel}`,
      });
      return res.status(403).json({ error: "captcha_failed" });
    }

    // 4. upsert contact (GHL dedups per location "Allow Duplicate Contact" setting)
    let contactId = null;
    try {
      const up = await ghlBarber.contacts.upsertContact({
        locationId: LOCATION_ID,
        firstName: clean.firstName,
        lastName: clean.lastName,
        email: clean.email,
        phone: clean.phone,
        source: "website:booking-widget",
        tags: ["website-booking"],
      });
      contactId = up?.contact?.id || up?.id || null;
      if (!contactId) throw new Error("upsert returned no contact id");
    } catch (err) {
      const ghlError = err?.response?.data?.message || err?.message;
      await logBookingAttempt({
        ...audit, success: false, stepReached: "upsert_contact", turnstileOk: true,
        ghlError: String(ghlError),
        summary: `FAILED at upsertContact: ${ghlError} — ${slotLabel}`,
      });
      return res.status(502).json({ error: "contact_failed" });
    }

    // 5. combo room re-check: getSlots only proves native-duration room, so for
    //    longer services verify the follow-on grid slots are still free RIGHT NOW
    //    (the 60s read cache can be stale; this read is uncached).
    if (mins > barber.slotDurationMinutes) {
      const fresh = await freshDaySlots(barber.calendarId, clean.slotMs);
      if (fresh) {
        const intervalMs = barber.slotIntervalMinutes * 60 * 1000;
        const extraSteps = Math.ceil(
          (mins - barber.slotDurationMinutes) / barber.slotIntervalMinutes
        );
        const set = new Set(fresh);
        let roomOk = set.has(clean.slotMs);
        for (let k = 1; roomOk && k <= extraSteps; k++) {
          if (!set.has(clean.slotMs + k * intervalMs)) roomOk = false;
        }
        if (!roomOk) {
          await logBookingAttempt({
            ...audit, contactId, success: false, stepReached: "create_appointment",
            turnstileOk: true, ghlError: "combo room gone (fresh re-check)",
            summary: `FAILED: combo slot taken — ${slotLabel}`,
          });
          return res.status(409).json({
            error: "slot_taken",
            nextSlots: nearestAlternates(fresh, clean.slotMs),
          });
        }
      }
    }

    // 6. create appointment — GHL validates the slot (ignoreFreeSlotValidation: false)
    const endISO = new Date(clean.slotMs + mins * 60 * 1000).toISOString();
    let appt;
    try {
      appt = await ghlBarber.calendars.createAppointment({
        calendarId: barber.calendarId,
        locationId: LOCATION_ID,
        contactId,
        startTime: clean.slotISO,
        endTime: endISO,
        title: `${serviceDef.label} — ${barber.name}${clean.note ? " (see notes)" : ""}`,
        description: clean.note
          ? `Booked via website widget.\nCustomer note: ${clean.note}`
          : "Booked via website widget.",
        appointmentStatus: "confirmed",
        ignoreDateRange: false,
        ignoreFreeSlotValidation: false,
        toNotify: true,
        address: SHOP_ADDRESS,
      });
    } catch (err) {
      const ghlError = err?.response?.data?.message || err?.message;
      if (isSlotTakenError(err)) {
        const fresh = await freshDaySlots(barber.calendarId, clean.slotMs);
        await logBookingAttempt({
          ...audit, contactId, success: false, stepReached: "create_appointment",
          turnstileOk: true, ghlError: String(ghlError),
          summary: `FAILED: slot taken — ${slotLabel}`,
        });
        return res.status(409).json({
          error: "slot_taken",
          nextSlots: fresh ? nearestAlternates(fresh, clean.slotMs) : [],
        });
      }
      await logBookingAttempt({
        ...audit, contactId, success: false, stepReached: "create_appointment",
        turnstileOk: true, ghlError: String(ghlError),
        summary: `FAILED at createAppointment: ${ghlError} — ${slotLabel}`,
      });
      return res.status(502).json({ error: "booking_failed" });
    }

    // 7. success
    const appointmentId = appt?.id || null;
    await logBookingAttempt({
      ...audit, contactId, appointmentId, success: true,
      stepReached: "done", turnstileOk: true,
      summary: `Booked ${slotLabel} (${mins}min)`,
    });
    return res.status(201).json({ appointmentId, contactId });
  });
}

module.exports = { registerBookingCreateRoute };
