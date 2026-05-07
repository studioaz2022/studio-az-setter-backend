/**
 * Date utilities for tattoo finance reconciliation.
 *
 * Reconciliation weeks run Monday 00:00 → Sunday 23:59:59.999 in America/Chicago.
 * The shop is in Minneapolis (Central time), so all week boundaries must be
 * computed in that timezone — never UTC, never the server's local time.
 */

const SHOP_TZ = "America/Chicago";

/**
 * Returns { year, month, day, hour, minute, second } for the given Date in the
 * shop's timezone. Used as the building block for week boundary math.
 */
function shopParts(date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: SHOP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value])
  );
  // weekday short → number (Mon=1, Sun=7) following ISO
  const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    isoWeekday: weekdayMap[parts.weekday],
  };
}

/**
 * Convert a year/month/day in the shop's timezone to a UTC instant
 * representing midnight (00:00:00) on that calendar day in the shop.
 *
 * We compute the UTC offset for that local date by formatting it back through
 * Intl and adjusting until the round-trip matches.
 */
function shopMidnightUtc(year, month, day) {
  // Start with naive UTC interpretation, then shift by the offset that
  // America/Chicago has on that date (handles DST automatically).
  const naiveUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const probe = new Date(naiveUtc);
  const probeParts = shopParts(probe);
  // diff = how far the probe's "shop local" time is from the desired (Y/M/D 00:00)
  const desiredUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const probeAsLocalUtc = Date.UTC(
    probeParts.year,
    probeParts.month - 1,
    probeParts.day,
    probeParts.hour,
    probeParts.minute,
    probeParts.second,
    0
  );
  const offsetMs = probeAsLocalUtc - desiredUtc;
  return new Date(naiveUtc - offsetMs);
}

/**
 * Returns the Date for Monday 00:00:00.000 of the week containing `date`,
 * in America/Chicago. Weeks are ISO-aligned (Monday = first day).
 */
function getWeekStart(date = new Date()) {
  const p = shopParts(date);
  // Subtract (isoWeekday - 1) days to land on Monday in shop tz.
  const offsetDays = p.isoWeekday - 1;
  // Build the date in shop calendar terms, then back to UTC instant.
  // To handle month/year boundaries cleanly, anchor on a UTC Date and shift.
  const asUtcDate = new Date(Date.UTC(p.year, p.month - 1, p.day));
  asUtcDate.setUTCDate(asUtcDate.getUTCDate() - offsetDays);
  return shopMidnightUtc(
    asUtcDate.getUTCFullYear(),
    asUtcDate.getUTCMonth() + 1,
    asUtcDate.getUTCDate()
  );
}

/**
 * Returns the Date for Sunday 23:59:59.999 of the week containing `date`.
 */
function getWeekEnd(date = new Date()) {
  const start = getWeekStart(date);
  // Sunday end = Monday start + 7 days - 1 ms (in UTC ms terms — DST safe
  // because both endpoints are derived from the same shop timezone).
  return new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
}

/**
 * Returns the calendar date string "YYYY-MM-DD" for the shop tz.
 * Used for storing in `date` columns and for human display.
 */
function toShopDateString(date) {
  const p = shopParts(date);
  return `${p.year.toString().padStart(4, "0")}-${p.month
    .toString()
    .padStart(2, "0")}-${p.day.toString().padStart(2, "0")}`;
}

/**
 * Returns a short month-day range like "Apr 20-26" for Venmo notes.
 * Crosses month boundaries gracefully: "Apr 28-May 4".
 */
function formatWeekRange(weekStart, weekEnd) {
  const startParts = shopParts(weekStart);
  const endParts = shopParts(weekEnd);
  const monthName = (m) =>
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
  if (startParts.month === endParts.month) {
    return `${monthName(startParts.month)} ${startParts.day}-${endParts.day}`;
  }
  return `${monthName(startParts.month)} ${startParts.day}-${monthName(endParts.month)} ${endParts.day}`;
}

/**
 * Returns { startMs, endMs } UTC epoch bounds for the given YYYY-MM-DD date in
 * the shop's timezone (America/Chicago). DST-aware via shopMidnightUtc.
 *
 * Use this anywhere we query GHL APIs by date — passing UTC midnight bounds
 * causes cross-day bleed because UTC midnight = 6/7pm CST the previous day.
 *
 * Example: getCentralDayBounds("2026-04-22") returns:
 *   startMs = April 22 00:00:00 CST = April 22 05:00 UTC (during DST)
 *   endMs   = April 22 23:59:59.999 CST = April 23 04:59:59.999 UTC
 */
function getCentralDayBounds(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`getCentralDayBounds: dateStr must be YYYY-MM-DD, got "${dateStr}"`);
  }
  const [year, month, day] = dateStr.split("-").map(Number);
  const startDate = shopMidnightUtc(year, month, day);
  const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { startMs: startDate.getTime(), endMs: endDate.getTime() };
}

/**
 * Returns the ISO timestamp string (e.g. "2026-04-22T05:00:00.000Z") for
 * Central-time midnight on the given YYYY-MM-DD. Useful for Supabase filters
 * like .gte("start_time", centralDayStartIso(dateStr)).
 */
function centralDayStartIso(dateStr) {
  return new Date(getCentralDayBounds(dateStr).startMs).toISOString();
}

/**
 * Returns the ISO timestamp string for Central-time end-of-day (23:59:59.999)
 * on the given YYYY-MM-DD. Useful for Supabase .lte/.lt filters.
 */
function centralDayEndIso(dateStr) {
  return new Date(getCentralDayBounds(dateStr).endMs).toISOString();
}

module.exports = {
  SHOP_TZ,
  shopParts,
  shopMidnightUtc,
  getWeekStart,
  getWeekEnd,
  toShopDateString,
  formatWeekRange,
  getCentralDayBounds,
  centralDayStartIso,
  centralDayEndIso,
};
