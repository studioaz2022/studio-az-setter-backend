// ─── Barber directory for the website booking widget ───
//
// Slug → calendar + per-service pricing for the 9 barbershop calendars.
//
// ⚠️ THIS DATA EXISTS IN TWO OTHER PLACES — keep all three in sync:
//   1. barbershop-website/lib/barbers.ts        (frontend roster: slugs, prices)
//   2. src/availability/availabilityRoutes.js   (homepage "Next:" tiles: slugs, calendarIds)
// A barber/price/calendar change must hit all of them; none cascade.
//
// slotDurationMinutes / slotIntervalMinutes were read from the live GHL
// calendar configs on 2026-07-14 (see BOOKING_WIDGET_PLAN.md Phase 1). If a
// barber's calendar duration changes in GHL, update here.
//
// `notes` carries per-barber, per-service caveats shown in the booking flow
// (e.g. Elle/Anna H+B excludes straight razor).
//
// Service eligibility = a price key present for that barber. This encodes the
// roster footnotes (Liam's $45 hot towel is a face shave, he does NO standalone
// beard trims; Joshua does NO standalone beard trims). Do not infer from the
// website's specialties[] — those are content groupings, not service menus.
//
// IMPORTANT: chavez uses Lionel's REGULAR haircut calendar (Bsv9ngkRgsbLzgtN3Vpq),
// NOT the friends & family calendar (9a66xeZi2pEJWQpxiMjy).

const BARBERS = {
  gilberto: {
    name: "Gilberto Castro",
    calendarId: "38Uhu6i5W4L5yGJbE0My",
    slotDurationMinutes: 60,
    slotIntervalMinutes: 60,
    prices: { haircut: 35, "haircut-beard": 50 },
  },
  liam: {
    name: "Liam Meagher",
    calendarId: "kiGx7ec1vj9e62U33ZhU",
    slotDurationMinutes: 45,
    slotIntervalMinutes: 15,
    prices: { haircut: 45, "haircut-beard": 55, "hot-towel": 45 },
  },
  david: {
    name: "David Mackflin",
    calendarId: "qvcPzTqyaQOxsijIQqAN",
    slotDurationMinutes: 40,
    slotIntervalMinutes: 40,
    prices: { haircut: 50, "haircut-beard": 65 },
  },
  logan: {
    name: "Logan Jensen",
    calendarId: "o1fvyti3GnoFGKZN5Hwr",
    slotDurationMinutes: 45,
    slotIntervalMinutes: 45,
    prices: { haircut: 50, "haircut-beard": 65, beard: 27 },
  },
  drew: {
    name: "Drew Smith",
    calendarId: "AzIK0eW09u4V1jJTXQ0x",
    slotDurationMinutes: 45,
    slotIntervalMinutes: 60,
    // hot-towel price varies with beard length → null renders "Varies" in the UI
    prices: { haircut: 65, "haircut-beard": 80, beard: 35, "hot-towel": null },
  },
  elle: {
    name: "Elle Gibeau",
    calendarId: "Bcqa2hqjUX7xhNu37cL1",
    slotDurationMinutes: 45,
    slotIntervalMinutes: 45,
    prices: { haircut: 70, "haircut-beard": 85 },
    notes: { "haircut-beard": "Does not include straight razor." },
  },
  joshua: {
    name: "Joshua Flores",
    calendarId: "X1xINoRML65yAOVUsAGa",
    slotDurationMinutes: 45,
    slotIntervalMinutes: 45,
    prices: { haircut: 65, "haircut-beard": 75 },
    notes: {
      "haircut-beard":
        "No hot towel. Straight razor on cheeks only. Hair wash may or may not be included, depending on time.",
    },
  },
  chavez: {
    name: "Lionel Chavez",
    calendarId: "Bsv9ngkRgsbLzgtN3Vpq",
    // GHL user behind this round_robin calendar (its only teamMember). The
    // deposit flow needs it even when createAppointment's response omits
    // assignedUserId: the rollback edit rejects without it, and the ledger's
    // artist_ghl_id column is NOT NULL.
    ghlUserId: "1kFG5FWdUDhXLUX46snG",
    slotDurationMinutes: 30,
    slotIntervalMinutes: 30,
    prices: { haircut: 80, "haircut-beard": 100 },
  },
  // ── Hidden. For end-to-end tests of the live booking path. ──
  // Books the "WalkIn · Haircut · Test (Studio AZ)" calendar, whose only
  // team member is the "Studio AZ" admin user — so a test booking notifies
  // no barber. `hidden` keeps it out of the catalog unless a request names
  // it (`?reveal=test`), which only the widget does, and only when the URL
  // it was opened from already said `?barber=test`. Still bookable by slug
  // like any other entry; everything downstream (slots, create, audit, the
  // GHL workflows) runs the real code.
  test: {
    name: "Test Barber",
    calendarId: "48a2xaeIgoz2XNMSAwRj",
    ghlUserId: "mf1uNeKFJ1hTl1ZEvwjW",
    slotDurationMinutes: 30,
    slotIntervalMinutes: 30,
    prices: { haircut: 0 },
    hidden: true,
  },
  anna: {
    name: "Anna Kinkead",
    calendarId: "WWduImUIgEoEx8mBTkmp",
    slotDurationMinutes: 40,
    slotIntervalMinutes: 40,
    prices: { haircut: 45, "haircut-beard": 60 },
    notes: { "haircut-beard": "Does not include straight razor." },
  },
};

// v1 service catalog. `buzz` (Logan only) deliberately excluded.
// duration: "native" = the barber's calendar slot duration;
//           "native+30" = calendar duration + 30min beard add-on (combo);
//           a number = fixed minutes regardless of calendar.
const SERVICES = {
  haircut: { label: "Haircut", duration: "native" },
  "haircut-beard": { label: "Haircut + Beard", duration: "native+30" },
  beard: { label: "Beard Trim", duration: 30 },
  "hot-towel": { label: "Hot Towel Shave", duration: "native" },
};

// How far ahead the booking flow works, in days. ONE number, shared by the
// read path (how many days of slots the widget shows) and the write path
// (how far out a submitted slot may be). They MUST be the same number.
//
// They weren't. The widget showed 60 days while create hard-rejected
// anything past 31 with "slot too far out", so a client who picked a slot
// in that gap got a failure they could do nothing about — then hit the IP
// rate limit for retrying. Measured on 2026-09-16: one client lost on
// Liam at 35 days, another on Drew at 58 days after TEN attempts across
// 90 minutes. Live since launch.
//
// 31 was not arbitrary — it matched every calendar's allowBookingFor when
// it was written. Lionel's is still 31; the other eight are now 61. That
// is exactly why this is not hardcoded per-barber here: GHL is the
// authority. The widget can only ever offer slots GHL returned, and GHL
// self-limits each calendar by its own allowBookingFor, so this constant
// only has to be a sane outer bound that matches what we display.
const BOOKING_HORIZON_DAYS = 60;

const SERVICE_ORDER = ["haircut", "haircut-beard", "beard", "hot-towel"];

function getBarber(slug) {
  return BARBERS[slug] || null;
}

function serviceOffered(barberSlug, serviceSlug) {
  const b = BARBERS[barberSlug];
  return !!(b && SERVICES[serviceSlug] && serviceSlug in b.prices);
}

/**
 * Barbers offering a service, for the public catalog. Hidden entries are
 * left out unless `reveal` names one of them by slug.
 */
function eligibleBarbers(serviceSlug, { reveal = null } = {}) {
  return Object.entries(BARBERS)
    .filter(([slug, b]) => serviceSlug in b.prices && (!b.hidden || slug === reveal))
    .map(([slug, b]) => ({ slug, ...b }));
}

/** Per-barber caveat for a service ("what's not included"), or null. */
function serviceNote(barberSlug, serviceSlug) {
  return BARBERS[barberSlug]?.notes?.[serviceSlug] || null;
}

/** Appointment length in minutes for barber × service. */
function durationMinutes(barberSlug, serviceSlug) {
  const b = BARBERS[barberSlug];
  const s = SERVICES[serviceSlug];
  if (!b || !s) return null;
  if (s.duration === "native") return b.slotDurationMinutes;
  if (s.duration === "native+30") return b.slotDurationMinutes + 30;
  return s.duration;
}

module.exports = {
  BARBERS,
  BOOKING_HORIZON_DAYS,
  SERVICES,
  SERVICE_ORDER,
  getBarber,
  serviceOffered,
  eligibleBarbers,
  durationMinutes,
  serviceNote,
};
