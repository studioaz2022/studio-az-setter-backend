// ─── Booking deposit rules (barbershop website widget) ───
//
// Which barbers require a deposit before the chair is held, and how much.
// See BOOKING_DEPOSIT_PLAN.md. Lionel only, 50%, taken via Square.
//
// The amount is DERIVED from the same barberDirectory price the widget quotes,
// never stored separately — a second copy is a second thing to drift.
//
// Lionel's Friends & Family calendar (9a66xeZi2pEJWQpxiMjy) is not exposed in
// the widget at all; `chavez` maps only to the regular calendar, so F&F is
// untouched by any of this.

const { getBarber } = require("./barberDirectory");

const DEPOSIT_RULES = {
  chavez: { percent: 50 },
};

/** Does this barber take a deposit for anything? (cheap check, no service needed) */
function requiresDeposit(barberSlug) {
  return !!DEPOSIT_RULES[barberSlug];
}

/**
 * Deposit terms for one barber × service, or null when none is due.
 *
 * All money is integer cents throughout — prices are whole dollars, and doing
 * the percentage in cents keeps a 50% split of an odd amount exact instead of
 * inheriting float dust.
 *
 * A "Varies" price (null) can't be halved, so those services take no deposit
 * rather than guessing at a number to charge someone.
 */
function depositFor(barberSlug, serviceSlug) {
  const rule = DEPOSIT_RULES[barberSlug];
  if (!rule) return null;

  const price = getBarber(barberSlug)?.prices?.[serviceSlug];
  if (typeof price !== "number") return null;

  const priceCents = Math.round(price * 100);
  const amountCents = Math.round((priceCents * rule.percent) / 100);

  return {
    required: true,
    percent: rule.percent,
    amountCents,
    servicePriceCents: priceCents,
    /** what they still owe in the chair — shown at checkout so nothing surprises them */
    balanceCents: priceCents - amountCents,
  };
}

/** "$40" / "$42.50" — for copy, never for arithmetic. */
function formatCents(cents) {
  return cents % 100 === 0
    ? `$${cents / 100}`
    : `$${(cents / 100).toFixed(2)}`;
}

module.exports = { DEPOSIT_RULES, requiresDeposit, depositFor, formatCents };
