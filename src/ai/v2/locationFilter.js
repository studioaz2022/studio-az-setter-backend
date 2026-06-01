// locationFilter.js — first gate of the v2 funnel (Phase 0.5)
//
// The cheapest possible check: a single string comparison on the GHL location ID
// from the inbound webhook payload. Runs before any contact fetch, classifier, or
// LLM call. Barbershop messages must never touch the AI setter pipeline — even if
// a barbershop lead happens to use a tattoo keyword, this gate blocks them.
//
// Location IDs live in env: GHL_LOCATION_ID (tattoo), GHL_BARBER_LOCATION_ID.

/**
 * Extract the GHL location ID from a webhook payload. Mirrors the extraction
 * the live webhook already uses (app.js): payload.locationId || payload.location.id.
 * @param {object} payload GHL webhook body
 * @returns {string|null}
 */
function extractLocationId(payload) {
  return payload?.locationId || payload?.location?.id || null;
}

/**
 * Decide whether an inbound webhook belongs to the tattoo location (the only
 * location the v2 AI setter serves).
 *
 * Decision rules:
 *   - matches GHL_LOCATION_ID            => tattoo  (proceed)
 *   - matches GHL_BARBER_LOCATION_ID     => barbershop (exit)
 *   - matches neither / missing          => unknown (exit, fail-closed)
 *
 * Fail-closed on unknown: if we can't positively identify the tattoo location,
 * we do NOT run the AI setter. Safer to stay silent than to reply into the wrong
 * location.
 *
 * @param {object} payload GHL webhook body
 * @returns {{ isTattoo: boolean, locationId: string|null, reason: "tattoo"|"barbershop"|"unknown_location"|"missing_env" }}
 */
function checkLocation(payload) {
  const locationId = extractLocationId(payload);
  const tattooId = process.env.GHL_LOCATION_ID || null;
  const barberId = process.env.GHL_BARBER_LOCATION_ID || null;

  if (!tattooId) {
    // Can't positively identify tattoo without the env var — fail closed.
    return { isTattoo: false, locationId, reason: "missing_env" };
  }
  if (locationId && locationId === tattooId) {
    return { isTattoo: true, locationId, reason: "tattoo" };
  }
  if (barberId && locationId === barberId) {
    return { isTattoo: false, locationId, reason: "barbershop" };
  }
  return { isTattoo: false, locationId, reason: "unknown_location" };
}

module.exports = { checkLocation, extractLocationId };
