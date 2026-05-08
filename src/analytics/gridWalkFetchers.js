// gridWalkFetchers.js
//
// Data-fetching helpers for grid-walk utilization.
//
// Two appointment sources, depending on date:
//   - Past dates → Supabase appointments table (authoritative, webhook-fed)
//   - Today/future → GHL Calendar Events API (real-time)
//
// Schedules and Blocked Slots always come from GHL APIs regardless of date.
//
// Uses Central-time day bounds (DST-aware) to avoid cross-day bleed.

const { supabase } = require("../clients/supabaseClient");
const { ghlBarber } = require("../clients/ghlMultiLocationSdk");
const {
  getCentralDayBounds,
  centralDayStartIso,
  centralDayEndIso,
  toShopDateString,
} = require("../utils/dateUtils");

const BARBER_LOCATION_ID = "GLRkNAxfPtWTqTiN83xj";

// ─── Calendar configs (slot intervals + durations) ────────────────────────

/**
 * Fetch raw calendar configs for a barber's calendars.
 * Returns: calId → { slotDuration, slotDurationUnit, slotInterval, slotIntervalUnit }
 */
async function fetchCalendarConfigs(barberCalendars) {
  if (!ghlBarber) {
    throw new Error("ghlBarber SDK not configured");
  }
  const out = {};
  for (const [type, calId] of Object.entries(barberCalendars)) {
    try {
      const resp = await ghlBarber.calendars.getCalendar({ calendarId: calId });
      // SDK response shape: { data: { calendar: {...} } } | { calendar: {...} } | direct
      const cal = resp?.data?.calendar || resp?.calendar || resp?.data || resp;
      out[calId] = {
        slotDuration: cal.slotDuration,
        slotDurationUnit: cal.slotDurationUnit,
        slotInterval: cal.slotInterval,
        slotIntervalUnit: cal.slotIntervalUnit,
      };
    } catch (err) {
      console.warn(
        `[gridWalk] Failed to fetch calendar config for ${type} (${calId}): ${err.message}`,
      );
      // Sensible fallback: 30-min slots
      out[calId] = {
        slotDuration: 30,
        slotDurationUnit: "mins",
        slotInterval: 30,
        slotIntervalUnit: "mins",
      };
    }
  }
  return out;
}

// ─── Schedules ────────────────────────────────────────────────────────────

/**
 * Fetch schedules (weekly availability rules) for a barber.
 * Returns the array of schedules.
 */
async function fetchSchedules(barberGhlUserId) {
  if (!ghlBarber) throw new Error("ghlBarber SDK not configured");
  const httpClient = ghlBarber.getHttpClient();
  const resp = await httpClient.get(
    `/calendars/schedules/search?locationId=${BARBER_LOCATION_ID}&userId=${barberGhlUserId}`,
    { headers: { Version: "2021-04-15" } },
  );
  return resp.data?.schedules || [];
}

// ─── Blocked Slots ────────────────────────────────────────────────────────

/**
 * Fetch blocked slots for a barber across a date range.
 * Used for both day-by-day fetches and bulk caching.
 *
 * @param {string} barberGhlUserId
 * @param {string} startDateStr - YYYY-MM-DD (Central)
 * @param {string} endDateStr - YYYY-MM-DD (Central, inclusive)
 * @returns {Array} - Blocked slot events
 */
async function fetchBlockedSlots(barberGhlUserId, startDateStr, endDateStr) {
  if (!ghlBarber) throw new Error("ghlBarber SDK not configured");
  const httpClient = ghlBarber.getHttpClient();
  const { startMs } = getCentralDayBounds(startDateStr);
  const { endMs } = getCentralDayBounds(endDateStr);

  const resp = await httpClient.get(
    `/calendars/blocked-slots?locationId=${BARBER_LOCATION_ID}&userId=${barberGhlUserId}&startTime=${startMs}&endTime=${endMs}`,
    { headers: { Version: "2021-04-15" } },
  );
  // GHL response shape varies; handle all known forms
  const slots = resp.data?.events || resp.data?.blockedSlots || resp.data || [];
  return Array.isArray(slots) ? slots.filter((b) => !b.deleted) : [];
}

/**
 * Filter blocked slots to those that overlap a single Central-time day.
 * Use after a bulk fetch to slice per-day.
 */
function filterBlockedSlotsToDay(blockedSlots, dateStr) {
  const { startMs, endMs } = getCentralDayBounds(dateStr);
  return blockedSlots.filter((b) => {
    const bStart = new Date(b.startTime).getTime();
    const bEnd = new Date(b.endTime).getTime();
    return bStart < endMs && bEnd > startMs;
  });
}

// ─── Appointments (historical: Supabase) ──────────────────────────────────

/**
 * Fetch all appointments for a barber on a single Central-time date from Supabase.
 * Used for historical mode (past dates).
 *
 * Returns events shaped to look like GHL Calendar Events for downstream code.
 */
async function fetchAppointmentsFromSupabase(barberGhlUserId, dateStr) {
  const startIso = centralDayStartIso(dateStr);
  const endIso = centralDayEndIso(dateStr);

  const { data, error } = await supabase
    .from("appointments")
    .select(
      "id, calendar_id, contact_id, start_time, end_time, status, title, assigned_user_id",
    )
    .eq("assigned_user_id", barberGhlUserId)
    .eq("location_id", BARBER_LOCATION_ID)
    .gte("start_time", startIso)
    .lte("start_time", endIso);

  if (error) {
    throw new Error(`Supabase appointments query failed: ${error.message}`);
  }

  // Shape to match GHL Calendar Events for the grid-walk consumer
  return (data || []).map((a) => ({
    id: a.id,
    calendarId: a.calendar_id,
    contactId: a.contact_id,
    startTime: a.start_time,
    endTime: a.end_time,
    appointmentStatus: a.status,
    title: a.title,
    assignedUserId: a.assigned_user_id,
  }));
}

// ─── Appointments (live: GHL Calendar Events) ─────────────────────────────

/**
 * Fetch GHL Calendar Events for a single Central-time date for a barber.
 * Used for present/future mode.
 *
 * Filters server response to only events that START on this Central-time day,
 * since the GHL API may bleed cross-day events.
 */
async function fetchAppointmentsFromGHL(barberGhlUserId, dateStr) {
  if (!ghlBarber) throw new Error("ghlBarber SDK not configured");
  const httpClient = ghlBarber.getHttpClient();
  const { startMs, endMs } = getCentralDayBounds(dateStr);

  const resp = await httpClient.get(
    `/calendars/events?locationId=${BARBER_LOCATION_ID}&startTime=${startMs}&endTime=${endMs}&userId=${barberGhlUserId}`,
    { headers: { Version: "2021-04-15" } },
  );
  const events = resp.data?.events || [];
  // Belt-and-suspenders: only keep events whose START falls in our Central day
  return events.filter((ev) => {
    const evStart = new Date(ev.startTime).getTime();
    return evStart >= startMs && evStart <= endMs;
  });
}

// ─── Mode resolver ────────────────────────────────────────────────────────

/**
 * Decide whether a date is past, today, or future in Central time.
 * Past dates use Supabase; today and future use GHL.
 */
function getModeForDate(dateStr, nowDate = new Date()) {
  const today = toShopDateString(nowDate);
  if (dateStr < today) return "historical";
  if (dateStr === today) return "live"; // today is "live" — partial day, evolving
  return "future";
}

async function fetchAppointmentsForDate(barberGhlUserId, dateStr, mode) {
  const m = mode || getModeForDate(dateStr);
  if (m === "historical") {
    return fetchAppointmentsFromSupabase(barberGhlUserId, dateStr);
  }
  return fetchAppointmentsFromGHL(barberGhlUserId, dateStr);
}

module.exports = {
  fetchCalendarConfigs,
  fetchSchedules,
  fetchBlockedSlots,
  filterBlockedSlotsToDay,
  fetchAppointmentsFromSupabase,
  fetchAppointmentsFromGHL,
  fetchAppointmentsForDate,
  getModeForDate,
};
