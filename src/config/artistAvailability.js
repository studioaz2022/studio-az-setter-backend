// artistAvailability.js
// One switch for "which artists can receive an automatically-routed lead."
//
// An artist who can't actually see leads is worse than an artist who isn't in
// the pool at all: the lead gets assigned, nobody is notified, and it sits in
// GHL until someone notices by hand. This module is the single place that
// decides who the workload balancer is allowed to pick.

/** Public Instagram for artists we bounce inquiries to. */
const ARTIST_INSTAGRAM = {
  Kaelani: "https://www.instagram.com/azaditatz/",
};

// ─── THE SWITCH ──────────────────────────────────────────────────────────────
// Artists named here are Instagram-only. The AI setter's workload balancer
// never auto-assigns them, and the website points their book/inquire CTAs at
// Instagram instead of opening the inquiry form.
//
// Kaelani, added 2026-07-27: she hasn't signed into the iOS app, so every lead
// assigned to her has landed nowhere — she never saw any of them. Instagram at
// least puts the inquiry somewhere she reads. Take her out of this set the day
// she confirms she's signed in.
//
// Mirror every change here in the website's matching flag:
//   tattoo-website/src/lib/artists.ts → Artist.instagramOnlyBooking
// The two switches are flipped together or the surfaces disagree.
const INSTAGRAM_ONLY_ARTISTS = new Set(["Kaelani"]);
// ─────────────────────────────────────────────────────────────────────────────

// Everyone eligible for automatic assignment *before* the switch is applied.
// Deliberately excluded:
//   • Megan  — apprentice; takes only leads that ask for her by name or that
//              the shop assigns by hand, never the auto round-robin.
//   • Claudia — test account; must never receive a real lead.
const BASE_AUTO_ASSIGN_POOL = ["Andrew", "Joan", "Kaelani"];

/** True when this artist's inquiries should go to Instagram, not the CRM. */
function isInstagramOnly(name) {
  if (!name) return false;
  const lc = String(name).trim().toLowerCase();
  for (const artist of INSTAGRAM_ONLY_ARTISTS) {
    if (artist.toLowerCase() === lc) return true;
  }
  return false;
}

/** Instagram URL for an Instagram-only artist, or null. */
function instagramUrlFor(name) {
  if (!name) return null;
  const lc = String(name).trim().toLowerCase();
  const key = Object.keys(ARTIST_INSTAGRAM).find((a) => a.toLowerCase() === lc);
  return key ? ARTIST_INSTAGRAM[key] : null;
}

/** Drop Instagram-only artists from a candidate list. */
function withoutInstagramOnly(names) {
  if (!Array.isArray(names)) return [];
  return names.filter((n) => !isInstagramOnly(n));
}

/**
 * Who the balancer may pick when the lead has no artist preference
 * (i.e. "Soonest Available"). Never empty — falls back to the base pool if the
 * switch would otherwise leave nobody, so a bad flag can't strand every lead.
 */
function autoAssignPool() {
  const pool = withoutInstagramOnly(BASE_AUTO_ASSIGN_POOL);
  return pool.length > 0 ? pool : [...BASE_AUTO_ASSIGN_POOL];
}

module.exports = {
  ARTIST_INSTAGRAM,
  INSTAGRAM_ONLY_ARTISTS,
  BASE_AUTO_ASSIGN_POOL,
  isInstagramOnly,
  instagramUrlFor,
  withoutInstagramOnly,
  autoAssignPool,
};
