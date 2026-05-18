/**
 * Central-time (America/Chicago) helpers — the shop runs on Central
 * (Minneapolis, MN). The front-desk dashboard MUST compute "today"/"now"
 * server-side in Central; the client never derives the date (a wrong
 * front-desk-computer clock would otherwise make the whole grid lie).
 *
 * Native Intl only (no luxon/date-fns — none installed). Generalizes the
 * DST-correct logic already inlined in app.js's getTodayRangeCentral so
 * it works for ANY date (the grid supports prev/next day), not just today.
 */

const SHOP_TZ = "America/Chicago";

/** Today's date in Central as "YYYY-MM-DD". */
function todayDateStrCentral(now = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return now.toLocaleDateString("en-CA", { timeZone: SHOP_TZ });
}

/** UTC offset in hours for a given UTC instant, as seen in Central time. */
function offsetHoursAt(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SHOP_TZ,
    timeZoneName: "shortOffset",
  }).formatToParts(date);
  const off = parts.find((p) => p.type === "timeZoneName");
  const m = off && off.value.match(/GMT([+-]?\d+)/);
  return m ? parseInt(m[1], 10) : -6; // fallback CST
}

function offsetStr(hours) {
  const sign = hours < 0 ? "-" : "+";
  return `${sign}${String(Math.abs(hours)).padStart(2, "0")}:00`;
}

/**
 * Start/end Date objects for a given Central calendar day.
 * DST-safe: probes the offset before and after the 2am transition window
 * so spring-forward / fall-back days bound correctly.
 *
 * @param {string} [dateStr] "YYYY-MM-DD" in Central; defaults to today Central.
 * @returns {{ dateStr, startOfDay: Date, endOfDay: Date }}
 */
function centralDayRange(dateStr) {
  const ds = dateStr || todayDateStrCentral();

  // 01:00 UTC on this date ≈ 7pm previous day Central — before any 2am DST flip.
  const startOffset = offsetHoursAt(new Date(`${ds}T01:00:00Z`));
  // 23:00 UTC ≈ 5-6pm Central — after any 2am DST flip.
  const endOffset = offsetHoursAt(new Date(`${ds}T23:00:00Z`));

  const startOfDay = new Date(`${ds}T00:00:00.000${offsetStr(startOffset)}`);
  const endOfDay = new Date(`${ds}T23:59:59.999${offsetStr(endOffset)}`);
  return { dateStr: ds, startOfDay, endOfDay };
}

/**
 * Validate/normalize an incoming ?date= param to a Central "YYYY-MM-DD".
 * Returns today (Central) when absent. Throws on a malformed value so the
 * endpoint can 400 rather than silently serving the wrong day.
 */
function resolveCentralDate(dateParam) {
  if (!dateParam) return todayDateStrCentral();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    throw new Error(`Invalid date "${dateParam}" — expected YYYY-MM-DD`);
  }
  // Reject impossible dates (e.g. 2026-13-40) while keeping it TZ-agnostic.
  const probe = new Date(`${dateParam}T12:00:00Z`);
  if (Number.isNaN(probe.getTime())) {
    throw new Error(`Invalid date "${dateParam}"`);
  }
  return dateParam;
}

/** Current instant as an ISO string plus the Central wall-clock parts. */
function nowCentral() {
  const now = new Date();
  return {
    iso: now.toISOString(),
    dateStr: todayDateStrCentral(now),
    // "HH:MM" 24h Central — handy for the grid's "now" line.
    timeStr: now.toLocaleTimeString("en-GB", {
      timeZone: SHOP_TZ,
      hour: "2-digit",
      minute: "2-digit",
    }),
  };
}

module.exports = {
  SHOP_TZ,
  todayDateStrCentral,
  centralDayRange,
  resolveCentralDate,
  nowCentral,
};
