// gridWalkUtilization.js
//
// Single entry point for grid-walk utilization. Handles both historical
// (past dates from Supabase) and live (today/future from GHL Calendar Events).
//
// Same algorithm runs in all modes — only the appointment data source changes.
// This replaces the old _liveUtilization / _historicalUtilization / _mergeUtilization
// trio with one function that produces consistent metrics across any date.
//
// See GRID_WALK_UTILIZATION_PLAN.md for the algorithm details.

const { gridWalkDay, normalizeCalendarConfigs } = require("./gridWalk");
const {
  fetchCalendarConfigs,
  fetchSchedules,
  fetchBlockedSlots,
  filterBlockedSlotsToDay,
  fetchAppointmentsForDate,
  getModeForDate,
} = require("./gridWalkFetchers");
const { BARBER_DATA } = require("../config/kioskConfig");
const { toShopDateString } = require("../utils/dateUtils");

/**
 * Compute grid-walk metrics for a single barber on a single date.
 *
 * @param {object} params
 * @param {string} params.barberGhlUserId - GHL user ID for the barber
 * @param {string} params.dateStr - YYYY-MM-DD (Central-time date)
 * @returns {Promise<object|null>} - Metrics object or null if day off / no schedule
 */
async function gridWalkUtilization({ barberGhlUserId, dateStr }) {
  const barberConfig = BARBER_DATA.find((b) => b.ghlUserId === barberGhlUserId);
  if (!barberConfig) {
    throw new Error(`Barber ${barberGhlUserId} not found in BARBER_DATA`);
  }

  const mode = getModeForDate(dateStr);

  // Fetch all the inputs for this day
  const [rawCalendarConfigs, schedules, blockedSlotsAll, calendarEvents] =
    await Promise.all([
      fetchCalendarConfigs(barberConfig.calendars),
      fetchSchedules(barberGhlUserId),
      fetchBlockedSlots(barberGhlUserId, dateStr, dateStr),
      fetchAppointmentsForDate(barberGhlUserId, dateStr, mode),
    ]);

  const calendarConfigs = normalizeCalendarConfigs(
    barberConfig.calendars,
    rawCalendarConfigs,
  );

  const blockedSlotsForDay = filterBlockedSlotsToDay(blockedSlotsAll, dateStr);

  const result = gridWalkDay({
    dateStr,
    barberCalendars: barberConfig.calendars,
    calendarConfigs,
    schedules,
    calendarEvents,
    blockedSlotsForDay,
  });

  if (!result) return null;

  return {
    ...result,
    mode,
    barberName: barberConfig.name,
    barberGhlUserId,
  };
}

/**
 * Compute grid-walk metrics for a single barber across a date range.
 * Bulk-fetches blocked slots once for the whole range to save API calls.
 *
 * @param {object} params
 * @param {string} params.barberGhlUserId
 * @param {string} params.startDateStr
 * @param {string} params.endDateStr
 * @returns {Promise<Array<object>>}
 */
async function gridWalkUtilizationRange({
  barberGhlUserId,
  startDateStr,
  endDateStr,
}) {
  const barberConfig = BARBER_DATA.find((b) => b.ghlUserId === barberGhlUserId);
  if (!barberConfig) {
    throw new Error(`Barber ${barberGhlUserId} not found in BARBER_DATA`);
  }

  // One-time fetches for the range
  const [rawCalendarConfigs, schedules, blockedSlotsAll] = await Promise.all([
    fetchCalendarConfigs(barberConfig.calendars),
    fetchSchedules(barberGhlUserId),
    fetchBlockedSlots(barberGhlUserId, startDateStr, endDateStr),
  ]);
  const calendarConfigs = normalizeCalendarConfigs(
    barberConfig.calendars,
    rawCalendarConfigs,
  );

  // Build the list of dates in Central time
  const dates = [];
  let cursor = startDateStr;
  while (cursor <= endDateStr) {
    dates.push(cursor);
    const next = new Date(cursor + "T12:00:00Z");
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = toShopDateString(next);
  }

  const results = [];
  for (const dateStr of dates) {
    const mode = getModeForDate(dateStr);
    const calendarEvents = await fetchAppointmentsForDate(
      barberGhlUserId,
      dateStr,
      mode,
    );
    const blockedSlotsForDay = filterBlockedSlotsToDay(blockedSlotsAll, dateStr);

    const dayResult = gridWalkDay({
      dateStr,
      barberCalendars: barberConfig.calendars,
      calendarConfigs,
      schedules,
      calendarEvents,
      blockedSlotsForDay,
    });

    if (dayResult) {
      results.push({
        ...dayResult,
        mode,
        barberName: barberConfig.name,
        barberGhlUserId,
      });
    }
  }

  return results;
}

module.exports = {
  gridWalkUtilization,
  gridWalkUtilizationRange,
};
