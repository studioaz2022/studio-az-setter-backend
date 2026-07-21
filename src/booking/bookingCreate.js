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
const {
  FIELDS,
  ADD_ONS,
  offersAddOn,
  normalizeAddOnSelection,
  isHttpUrl,
  buildCustomFields,
} = require("./bookingFields");

const LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID;
const SHOP_ADDRESS = "333 Washington Ave N, Suite 100";
const MAX_BOOKAHEAD_DAYS = 31; // matches GHL calendar allowBookingFor

// The hairstyle photo rides along as a data URL in the JSON body. The widget
// downscales before sending; this is the backstop, not the expected size.
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const ALLOWED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"];

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

/**
 * Decode the widget's `hairstylePhoto` data URL into { buffer, mimeType, filename }.
 * Returns null when absent, or { error } when present but unusable — a bad photo
 * must never sink an otherwise valid booking, so callers treat errors as "skip
 * the photo", not "reject the request".
 */
function parsePhoto(raw) {
  if (!raw) return null;
  const m = /^data:([a-z/+.-]+);base64,(.+)$/i.exec(String(raw));
  if (!m) return { error: "photo is not a data URL" };
  const mimeType = m[1].toLowerCase();
  if (!ALLOWED_PHOTO_TYPES.includes(mimeType)) {
    return { error: `unsupported photo type ${mimeType}` };
  }
  let buffer;
  try {
    buffer = Buffer.from(m[2], "base64");
  } catch {
    return { error: "photo is not valid base64" };
  }
  if (!buffer.length) return { error: "photo is empty" };
  if (buffer.length > MAX_PHOTO_BYTES) {
    return { error: `photo too large (${Math.round(buffer.length / 1024)}KB)` };
  }
  const ext = mimeType.split("/")[1].replace("jpeg", "jpg");
  return { buffer, mimeType, filename: `desired-hairstyle.${ext}` };
}

/**
 * Push the photo into the FILE_UPLOAD custom field. This endpoint (not the
 * contact PUT) is the ONLY safe way to populate a FILE_UPLOAD field — see the
 * warning at the top of bookingFields.js. Resolves to true/false; never throws,
 * because the appointment already exists by the time this runs.
 */
async function uploadHairstylePhoto(contactId, photo) {
  const token = process.env.GHL_BARBER_SHOP_TOKEN;
  if (!token) {
    console.warn("[booking] GHL_BARBER_SHOP_TOKEN unset — skipping photo upload");
    return false;
  }
  try {
    const form = new FormData();
    form.append(
      `${FIELDS.hairstylePhoto.id}_1`,
      new Blob([photo.buffer], { type: photo.mimeType }),
      photo.filename
    );
    const url =
      `https://services.leadconnectorhq.com/forms/upload-custom-files` +
      `?contactId=${encodeURIComponent(contactId)}&locationId=${encodeURIComponent(LOCATION_ID)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" },
      body: form,
    });
    if (!res.ok) {
      console.warn(`[booking] photo upload failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[booking] photo upload errored:", err?.message);
    return false;
  }
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

  // ── the optional custom-field inputs ──
  const silent = body.silent === true || body.silent === "true";
  const barberNotes = String(body.barberNotes || "").trim().slice(0, FIELDS.notes.maxLength);

  // A malformed video link shouldn't block a booking, but we must not hand GHL
  // junk either — drop it and say so rather than failing the whole request.
  const rawLink = String(body.videoLink || "").trim();
  const videoLink = rawLink && isHttpUrl(rawLink) ? rawLink : "";
  const droppedLink = !!rawLink && !videoLink;

  // add-ons: { eyebrows: [...], waxing: [...] } — options must be real, and the
  // barber must actually offer them. Unknown values are discarded silently.
  const addOns = {};
  const rawAddOns = body.addOns && typeof body.addOns === "object" ? body.addOns : {};
  for (const key of Object.keys(ADD_ONS)) {
    // pass everything through even if this barber can't offer it —
    // buildCustomFields does the gating and reports it for the audit row
    const valid = normalizeAddOnSelection(key, rawAddOns[key]);
    if (valid.length) addOns[key] = valid;
  }

  return {
    errors,
    clean: {
      barberSlug, service, firstName, lastName, email, phone, note, slotISO, slotMs,
      silent, barberNotes, videoLink, droppedLink, addOns,
    },
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

    // 3b. the hairstyle photo (optional). A bad photo is never fatal — we book
    //     the appointment and note the reason in the audit row.
    const photo = parsePhoto(body.hairstylePhoto);
    const photoError = photo?.error || null;

    // 4. upsert contact (GHL dedups per location "Allow Duplicate Contact" setting)
    //    The customer's preferences ride along here — one call, and NEVER the
    //    FILE_UPLOAD field (that would 400 and discard every field with it).
    const { customFields, dropped } = buildCustomFields(clean, clean.barberSlug);
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
        ...(customFields.length ? { customFields } : {}),
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
    //    Everything the customer asked for is repeated in the description: the
    //    barber reads the calendar event, not the contact record.
    const endISO = new Date(clean.slotMs + mins * 60 * 1000).toISOString();
    // only what actually got written — an add-on this barber doesn't offer was
    // dropped from the contact, so it must not appear on the calendar either
    const acceptedAddOns = Object.entries(clean.addOns).filter(([key]) =>
      offersAddOn(clean.barberSlug, key)
    );
    const addOnLines = acceptedAddOns.map(
      ([key, values]) => `${ADD_ONS[key].label}: ${values.join(", ")}`
    );
    const descLines = ["Booked via website widget."];
    if (clean.silent) descLines.push("*** SILENT APPOINTMENT REQUESTED ***");
    if (addOnLines.length) descLines.push(`Add-ons — ${addOnLines.join(" | ")}`);
    if (clean.barberNotes) descLines.push(`Notes to barber: ${clean.barberNotes}`);
    if (clean.note) descLines.push(`Customer note: ${clean.note}`);
    if (clean.videoLink) descLines.push(`Hairstyle video: ${clean.videoLink}`);
    if (photo?.buffer) descLines.push("Hairstyle photo attached to the contact record.");

    const titleFlags = [
      clean.silent ? "SILENT" : null,
      addOnLines.length ? "+add-ons" : null,
      clean.barberNotes || clean.note ? "see notes" : null,
    ].filter(Boolean);

    let appt;
    try {
      appt = await ghlBarber.calendars.createAppointment({
        calendarId: barber.calendarId,
        locationId: LOCATION_ID,
        contactId,
        startTime: clean.slotISO,
        endTime: endISO,
        title: `${serviceDef.label} — ${barber.name}${
          titleFlags.length ? ` (${titleFlags.join(", ")})` : ""
        }`,
        description: descLines.join("\n"),
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

    // 7. hairstyle photo — after the booking, deliberately. The appointment is
    //    the thing that must not fail; a photo that doesn't stick is a note in
    //    the audit row, not a lost slot.
    let photoUploaded = false;
    if (photo?.buffer) {
      photoUploaded = await uploadHairstylePhoto(contactId, photo);
    }

    // 8. success
    const appointmentId = appt?.id || null;
    const extras = [
      clean.silent ? "silent" : null,
      clean.barberNotes ? "notes" : null,
      clean.videoLink ? "video-link" : null,
      photo?.buffer ? (photoUploaded ? "photo" : "photo FAILED") : null,
      photoError ? `photo rejected (${photoError})` : null,
      clean.droppedLink ? "video link dropped (not a URL)" : null,
      dropped.length ? `add-ons not offered by ${clean.barberSlug}: ${dropped.join(",")}` : null,
      ...Object.entries(clean.addOns).map(([k, v]) => `${k}=${v.join("/")}`),
    ].filter(Boolean);

    await logBookingAttempt({
      ...audit, contactId, appointmentId, success: true,
      stepReached: "done", turnstileOk: true,
      summary: `Booked ${slotLabel} (${mins}min)${extras.length ? ` [${extras.join("; ")}]` : ""}`,
    });
    return res.status(201).json({ appointmentId, contactId, photoUploaded });
  });
}

// parsePhoto/uploadHairstylePhoto are exported so the GHL write path can be
// exercised against a test contact without booking a real slot on a barber's
// live calendar.
module.exports = { registerBookingCreateRoute, parsePhoto, uploadHairstylePhoto };
