// ─── Friends & Family login (barbershop) ───────────────────────────────
//
// Lionel keeps a private rate for people he knows. The old site gated it
// behind a single password box: the password IS the client's phone number
// as it appears in the barbershop CRM, and the contact has to carry
// "Family Friends" = 1. This reproduces that, with the lookup on the
// server where the GHL token lives — the browser never sees a key and
// never sees the roster.
//
// WHAT THIS IS NOT: a real login. The secret is a phone number, which is
// not private, guessable in bulk, and shared with everyone the client has
// ever given it to. It gates a discount, not anything sensitive, and the
// success payload is a first name and two booking links that are already
// public URLs. It is treated accordingly — but it is still rate-limited
// hard, because without that it is a free oracle for "is this number in
// the barbershop CRM", which IS private.
//
// The response is deliberately identical for "no such contact" and "not
// on the list". Distinguishing them would leak exactly that.

const { ghlBarber } = require("../clients/ghlMultiLocationSdk");

const BARBER_LOCATION_ID =
  process.env.GHL_BARBER_LOCATION_ID || "GLRkNAxfPtWTqTiN83xj";

// "Family Friends" — contact.family_friends, TEXT. Keyed by field ID, not
// fieldKey: a customField read by key silently returns undefined.
const FAMILY_FRIENDS_FIELD_ID = "WSqr9F1EUslbzwBjW2li";

// "Family Friends" is a TIER, not a yes/no. Today only tier 1 exists, but
// Lionel is adding 2 for clients grandfathered onto an older price before
// the next increase — so the value has to select a rate card rather than
// merely open the door. Keeping that shape now means the second tier is a
// data change here, and means a contact marked 2 before it is configured
// gets a logged, diagnosable denial instead of being quietly told they
// are not on the list.
//
// Calendars are on the GHL-hosted booking widget, deliberately NOT the
// site's own: these calendars are excluded from barberDirectory, the
// deposit config and the refund flow on purpose, and quietly wiring them
// in here would put appointments through a pricing path none of those
// know about.
const TIERS = {
  "1": {
    label: "friends & family",
    options: [
      {
        key: "haircut",
        label: "Haircut",
        price: 65,
        calendarId: "9a66xeZi2pEJWQpxiMjy",
      },
      {
        key: "haircut-beard",
        label: "Haircut + Beard",
        price: 80,
        calendarId: "0qOmPMcP7L4qz58fxmu4",
      },
    ],
  },
  // "2": grandfathered rate — awaiting its calendars and prices. Until it
  // is filled in, a contact marked 2 is denied and logged (see below).
};

// Hand-typed spellings of "yes" that predate the tier scheme, all meaning
// tier 1. The data was normalised to "1" on 2026-09-04 (230 of 231 already
// were); this is a hedge against the next person typing True at the desk,
// not a supported vocabulary. Numbers are the vocabulary.
const LEGACY_TIER_1 = new Set(["1.0", "true", "yes", "y"]);

// Spellings of "no". These deny like an empty field does — silently. An
// explicit no is not the same as an unrecognised tier, and warning about
// it would bury the warning that matters.
const EXPLICIT_NO = new Set(["0", "no", "false", "n"]);

function tierFor(rawValue) {
  if (rawValue === null) return null;
  const v = String(rawValue).trim();
  if (!v) return null;
  if (EXPLICIT_NO.has(v.toLowerCase())) return null;
  if (TIERS[v]) return { key: v, ...TIERS[v] };
  if (LEGACY_TIER_1.has(v.toLowerCase())) return { key: "1", ...TIERS["1"] };
  return { key: v, unconfigured: true };
}

const BOOKING_HOST = "https://mn.studioaz.us";

// ── Announcement ──
// A GHL location Custom Value, so Lionel edits it in Settings → Custom
// Values, in the tool he is in every day, and it takes effect without a
// deploy. Empty means no banner at all — the portal shows nothing rather
// than an empty frame or a stale "we're open as usual".
//
// Cached briefly: long enough that a burst of sign-ins doesn't re-query
// GHL per person, short enough that an edit made because he is leaving
// tomorrow is live before the next client looks.
const ANNOUNCEMENT_CV_ID = "S9S7hLDdLRP2vWakt8yN";
const ANNOUNCEMENT_TTL_MS = 2 * 60 * 1000;
let announcementCache = { at: 0, text: "" };

async function fetchAnnouncement() {
  if (Date.now() - announcementCache.at < ANNOUNCEMENT_TTL_MS) {
    return announcementCache.text;
  }
  try {
    const r = await ghlBarber.locations.getCustomValues({
      locationId: BARBER_LOCATION_ID,
    });
    const hit = (r?.customValues || []).find((v) => v.id === ANNOUNCEMENT_CV_ID);
    const text = String(hit?.value ?? "").trim();
    announcementCache = { at: Date.now(), text };
    return text;
  } catch (err) {
    // An announcement is a nicety; never let it take the sign-in down.
    console.warn("[ff] announcement fetch failed:", err.message);
    return announcementCache.text;
  }
}

// ── Rate limiting ──
// Per-IP, in memory. Resets on deploy, which is acceptable: the window is
// minutes and a redeploy is not something an attacker can trigger.
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 6;
const LOCKOUT_MS = 15 * 60 * 1000;
const attempts = new Map(); // ip -> { count, first, lockedUntil }

function rateLimit(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);

  if (rec?.lockedUntil && now < rec.lockedUntil) {
    return { blocked: true, retryAfter: Math.ceil((rec.lockedUntil - now) / 1000) };
  }
  if (!rec || now - rec.first > ATTEMPT_WINDOW_MS) {
    attempts.set(ip, { count: 1, first: now, lockedUntil: 0 });
    return { blocked: false };
  }
  rec.count += 1;
  if (rec.count > MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOCKOUT_MS;
    return { blocked: true, retryAfter: Math.ceil(LOCKOUT_MS / 1000) };
  }
  return { blocked: false };
}

/** Clear an IP's strikes once it proves it belongs. */
function rateLimitReset(ip) {
  attempts.delete(ip);
}

// Keep the map from growing without bound on a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of attempts) {
    if (now - rec.first > ATTEMPT_WINDOW_MS && now > (rec.lockedUntil || 0)) {
      attempts.delete(ip);
    }
  }
}, 30 * 60 * 1000).unref?.();

/**
 * People type their own number every way there is: 612-555-1212,
 * (612) 555 1212, 6125551212, +1 612 555 1212. GHL stores E.164. Reduce
 * to digits and rebuild.
 */
function toE164(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  // Anything else is either not a US number or not a number at all; hand
  // it back only if it is plausibly E.164 already.
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

// ── Next available slot, per F&F calendar ──
// The portal must quote the calendar the client will actually book on.
// Lionel's REGULAR calendar is the one /api/availability reports, and it
// is a different calendar with different hours — quoting it here would
// promise a time the F&F calendar may not have.
const SLOT_TTL_MS = 10 * 60 * 1000;
const SLOT_LOOKAHEAD_DAYS = 30;
const slotCache = new Map(); // calendarId -> { at, iso }

async function nextSlotFor(calendarId) {
  const cached = slotCache.get(calendarId);
  if (cached && Date.now() - cached.at < SLOT_TTL_MS) {
    // Re-check on serve: a cached slot can fall into the past while it
    // still counts as fresh.
    if (!cached.iso || Date.parse(cached.iso) > Date.now()) return cached.iso;
  }
  try {
    const now = Date.now();
    const data = await ghlBarber.calendars.getSlots({
      calendarId,
      startDate: now,
      endDate: now + SLOT_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000,
    });
    let earliest = null;
    let earliestMs = Infinity;
    for (const [key, val] of Object.entries(data || {})) {
      if (key === "traceId") continue;
      for (const iso of val?.slots || []) {
        const ms = Date.parse(iso);
        if (Number.isNaN(ms) || ms <= now || ms >= earliestMs) continue;
        earliestMs = ms;
        earliest = iso;
      }
    }
    slotCache.set(calendarId, { at: Date.now(), iso: earliest });
    return earliest;
  } catch (err) {
    // Never let a slot lookup take the sign-in down — the calendar embed
    // below it still works, it just opens without a headline time.
    console.warn(`[ff] slots ${calendarId} failed:`, err.message);
    return cached?.iso ?? null;
  }
}

function familyFriendsValue(contact) {
  const fields = Array.isArray(contact?.customFields) ? contact.customFields : [];
  const hit = fields.find((f) => f?.id === FAMILY_FRIENDS_FIELD_ID);
  if (!hit) return null;
  return String(hit.value ?? "").trim();
}

function isOnTheList(contact) {
  const t = tierFor(familyFriendsValue(contact));
  return Boolean(t && !t.unconfigured);
}

function registerFriendsFamilyRoutes(app) {
  /**
   * GET  /api/barbershop/friends-family/announcement
   * PUT  /api/barbershop/friends-family/announcement   body: { text }
   *
   * The iOS Tools tab reads and writes the notice here rather than talking
   * to GHL directly, so the app never carries a GHL token and the field id
   * lives in exactly one place.
   *
   * Gated by x-owner-key, the same header the refund approvals use. The
   * app additionally hides the screen from everyone but Lionel, but that
   * is a UI courtesy — this header is the actual gate.
   */
  function ownerOnly(req, res) {
    const key = req.headers["x-owner-key"];
    if (!process.env.OWNER_SETTLE_KEY || key !== process.env.OWNER_SETTLE_KEY) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return false;
    }
    return true;
  }

  app.get("/api/barbershop/friends-family/announcement", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!ownerOnly(req, res)) return;
    if (!ghlBarber) return res.status(503).json({ ok: false, error: "GHL unavailable" });
    try {
      const r = await ghlBarber.locations.getCustomValues({ locationId: BARBER_LOCATION_ID });
      const hit = (r?.customValues || []).find((v) => v.id === ANNOUNCEMENT_CV_ID);
      return res.json({ ok: true, text: String(hit?.value ?? "") });
    } catch (err) {
      console.error("[ff] announcement read failed:", err.message);
      return res.status(502).json({ ok: false, error: "Couldn't read the notice." });
    }
  });

  app.put("/api/barbershop/friends-family/announcement", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!ownerOnly(req, res)) return;
    if (!ghlBarber) return res.status(503).json({ ok: false, error: "GHL unavailable" });

    // Cap the length: this renders in a band on a phone, and the field is
    // a notice, not a newsletter.
    const text = String(req.body?.text ?? "").trim().slice(0, 600);
    try {
      await ghlBarber.locations.updateCustomValue(
        { locationId: BARBER_LOCATION_ID, id: ANNOUNCEMENT_CV_ID },
        { name: "FF Portal Announcement", value: text }
      );
      // Publish immediately rather than making him wait out the read cache
      // — he just pressed save and will go look.
      announcementCache = { at: Date.now(), text };
      return res.json({ ok: true, text });
    } catch (err) {
      console.error("[ff] announcement write failed:", err.message);
      return res.status(502).json({ ok: false, error: "Couldn't save the notice." });
    }
  });

  /**
   * POST /api/barbershop/friends-family/login
   * body: { password }   — the client's phone number as held in the CRM
   *
   * 200 { ok: true, firstName, options } when the contact exists AND
   *     carries Family Friends = 1.
   * 401 { ok: false, error } for every other outcome, worded identically.
   */
  app.post("/api/barbershop/friends-family/login", async (req, res) => {
    // Never cache an auth response at the CDN.
    res.set("Cache-Control", "no-store");

    const ip =
      (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.ip ||
      "unknown";

    const gate = rateLimit(ip);
    if (gate.blocked) {
      res.set("Retry-After", String(gate.retryAfter));
      return res.status(429).json({
        ok: false,
        error: "Too many attempts. Try again in a few minutes.",
      });
    }

    if (!ghlBarber) {
      console.error("[ff] GHL_BARBER_SHOP_TOKEN is not set");
      return res
        .status(503)
        .json({ ok: false, error: "Sign-in is unavailable right now." });
    }

    const DENY = {
      ok: false,
      error:
        "That number isn't on the friends & family list. Check with Lionel if you think it should be.",
    };

    const phone = toE164(req.body?.password);
    if (!phone) return res.status(401).json(DENY);

    try {
      const result = await ghlBarber.contacts.getContacts({
        locationId: BARBER_LOCATION_ID,
        query: phone,
        limit: 10,
      });
      const contacts = result?.contacts || [];

      // getContacts is a fuzzy search — match the phone exactly rather
      // than trusting the first row back.
      const match = contacts.find((c) => toE164(c?.phone) === phone);
      if (!match) return res.status(401).json(DENY);

      const tier = tierFor(familyFriendsValue(match));
      if (!tier) return res.status(401).json(DENY);

      // Marked with a tier nobody has configured yet. The client is still
      // turned away — there is no rate card to show them — but say so in
      // the log, because the alternative is Lionel flagging someone and
      // watching the door not open with no explanation anywhere.
      if (tier.unconfigured) {
        console.warn(
          `[ff] contact ${match.id} has Family Friends = ${JSON.stringify(tier.key)}, ` +
            `which has no tier configured in TIERS. Denied.`
        );
        return res.status(401).json(DENY);
      }

      rateLimitReset(ip);

      // Announcement and both calendars' next slots in parallel — this is
      // the only place the client waits, so it should not be three
      // round-trips deep.
      const [announcement, ...slots] = await Promise.all([
        fetchAnnouncement(),
        ...tier.options.map((o) => nextSlotFor(o.calendarId)),
      ]);
      const firstName = (match.firstNameRaw || match.firstName || "").trim();
      return res.json({
        ok: true,
        firstName: firstName ? firstName.replace(/\b\w/g, (m) => m.toUpperCase()) : "",
        tier: tier.key,
        tierLabel: tier.label,
        announcement,
        options: tier.options.map((o, i) => ({
          key: o.key,
          label: o.label,
          price: o.price,
          nextSlot: slots[i] ?? null,
          url: `${BOOKING_HOST}/widget/booking/${o.calendarId}`,
        })),
      });
    } catch (err) {
      console.error("[ff] lookup failed:", err.message);
      return res
        .status(502)
        .json({ ok: false, error: "Sign-in is unavailable right now." });
    }
  });
}

module.exports = { registerFriendsFamilyRoutes, toE164, isOnTheList, tierFor };
