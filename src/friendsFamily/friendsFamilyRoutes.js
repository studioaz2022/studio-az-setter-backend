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

// Lionel's two Friends & Family calendars, on the GHL-hosted booking
// widget. Deliberately NOT routed through the site's own booking widget:
// the F&F calendars are excluded from barberDirectory, the deposit config
// and the refund flow on purpose, and quietly wiring them in here would
// put appointments through a pricing path none of those know about.
const FF_OPTIONS = [
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
];

const BOOKING_HOST = "https://mn.studioaz.us";

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

function familyFriendsValue(contact) {
  const fields = Array.isArray(contact?.customFields) ? contact.customFields : [];
  const hit = fields.find((f) => f?.id === FAMILY_FRIENDS_FIELD_ID);
  if (!hit) return null;
  return String(hit.value ?? "").trim();
}

/**
 * "1" is the flag the old site checked, and it is what 230 of the 231
 * flagged contacts actually hold. One holds "True" — Lionel's own test
 * contact — which is enough to show the field is edited by hand and will
 * eventually be filled in by whoever is at the desk that day. A client
 * turned away because someone typed the wrong true is a bad outcome for a
 * field whose entire meaning is a yes/no, so accept the obvious spellings
 * of yes and nothing else. "0", "" and absent all remain a no.
 */
const TRUTHY = new Set(["1", "1.0", "true", "yes", "y"]);

function isOnTheList(contact) {
  const v = familyFriendsValue(contact);
  return v !== null && TRUTHY.has(v.toLowerCase());
}

function registerFriendsFamilyRoutes(app) {
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
      if (!match || !isOnTheList(match)) {
        return res.status(401).json(DENY);
      }

      rateLimitReset(ip);

      const firstName = (match.firstNameRaw || match.firstName || "").trim();
      return res.json({
        ok: true,
        firstName: firstName ? firstName.replace(/\b\w/g, (m) => m.toUpperCase()) : "",
        options: FF_OPTIONS.map((o) => ({
          key: o.key,
          label: o.label,
          price: o.price,
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

module.exports = { registerFriendsFamilyRoutes, toE164, isOnTheList };
