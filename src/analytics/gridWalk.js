// gridWalk.js
//
// Grid-walk utilization algorithm — the single, foolproof code path for
// historical, present, and future utilization metrics.
//
// Core principle: utilization = "could a client have booked this slot?"
//                 NOT "was there raw clock time available?"
//
// See GRID_WALK_UTILIZATION_PLAN.md for the full algorithm spec.
//
// This module implements the per-day computation. A higher-level entry
// point (gridWalkUtilization) wraps this with data fetching for both
// historical and live modes.

const { classifyBlockedSlot } = require("./blockedSlotClassifier");

const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const SHOP_TZ = "America/Chicago";

// Recognized GHL appointmentStatus values (lowercased in code)
const CANCELLED_STATUS = "cancelled";
const NOSHOW_STATUS = "no_showed";
const INVALID_STATUS = "invalid";

// ─── Time helpers ──────────────────────────────────────────────────────────

function toMinutes(value, unit) {
  if (!value) return null;
  return unit === "hours" ? value * 60 : value;
}

/** Parse "HH:mm" → minutes since midnight. */
function timeStrToMinutes(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

/** Format minutes-since-midnight → "HH:mm". */
function minutesToTimeStr(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Convert an event's startTime/endTime (ISO string or epoch ms) to
 * minutes-since-midnight in shop-local (Central) time.
 */
function eventToCentralMinutes(ev) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: SHOP_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const startMin = timeStrToMinutes(fmt.format(new Date(ev.startTime)));
  const endMin = timeStrToMinutes(fmt.format(new Date(ev.endTime)));
  return { startMin, endMin };
}

function overlaps(slotStart, slotEnd, blockStart, blockEnd) {
  return blockStart < slotEnd && blockEnd > slotStart;
}

// ─── Schedule resolver ────────────────────────────────────────────────────

/**
 * Returns the bookable [{ startMin, endMin }] windows for a calendar on a date.
 * Handles GHL Schedules API rules array (both wday and date-specific overrides).
 *
 * @param {Array} schedules - List of schedules from /calendars/schedules/search
 * @param {string} calId - Calendar ID
 * @param {string} dayName - "monday", "tuesday", ...
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {Array<{ startMin, endMin }>}
 */
function getScheduleForDay(schedules, calId, dayName, dateStr) {
  for (const sched of schedules) {
    const calIds = sched.calendarIds || [];
    if (!calIds.includes(calId)) continue;

    const rules = sched.rules || sched.schedule || [];

    // Date-specific override takes priority
    const dateOverride = rules.find(
      (r) => r.type === "date" && r.date === dateStr,
    );
    if (dateOverride) {
      if (dateOverride.intervals && dateOverride.intervals.length > 0) {
        return dateOverride.intervals.map((iv) => ({
          startMin: timeStrToMinutes(iv.from),
          endMin: timeStrToMinutes(iv.to),
        }));
      }
      return []; // Date override with empty intervals = day off
    }

    // Weekly day rule
    const dayRule = rules.find((r) => r.type === "wday" && r.day === dayName);
    if (dayRule && dayRule.intervals && dayRule.intervals.length > 0) {
      return dayRule.intervals.map((iv) => ({
        startMin: timeStrToMinutes(iv.from),
        endMin: timeStrToMinutes(iv.to),
      }));
    }

    return []; // Schedule covers this calendar but no intervals = day off
  }

  return []; // No schedule found for this calendar
}

// ─── Calendar config helpers ──────────────────────────────────────────────

/**
 * Normalize calendar config object: { id, type, slotInterval, slotDuration }
 * Each barber has a calendars map: { haircut: id1, haircut_beard: id2, ... }
 * Each calendar config has interval + duration in minutes.
 */
function normalizeCalendarConfigs(barberCalendars, rawCalendarConfigs) {
  // rawCalendarConfigs: calId → { slotDuration, slotDurationUnit, slotInterval, slotIntervalUnit }
  const out = {};
  for (const [type, calId] of Object.entries(barberCalendars)) {
    const raw = rawCalendarConfigs[calId];
    if (!raw) continue;
    const dur = toMinutes(raw.slotDuration, raw.slotDurationUnit) || 30;
    const int = toMinutes(raw.slotInterval, raw.slotIntervalUnit) || dur;
    out[calId] = { id: calId, type, slotInterval: int, slotDuration: dur };
  }
  return out;
}

// ─── Grid generation ──────────────────────────────────────────────────────

/**
 * For each calendar, build the list of slot start times based on schedule windows.
 * Returns: calendarGrids = { calId → [slotStartMin, ...] }
 */
function buildCalendarGrids(barberCalendars, calendarConfigs, schedules, dayName, dateStr) {
  const grids = {};
  for (const [type, calId] of Object.entries(barberCalendars)) {
    const config = calendarConfigs[calId];
    if (!config) continue;

    const windows = getScheduleForDay(schedules, calId, dayName, dateStr);
    if (windows.length === 0) continue;

    const slots = [];
    for (const win of windows) {
      let t = win.startMin;
      while (t + config.slotInterval <= win.endMin) {
        slots.push(t);
        t += config.slotInterval;
      }
    }
    if (slots.length > 0) {
      grids[calId] = slots;
    }
  }
  return grids;
}

// ─── The main algorithm ───────────────────────────────────────────────────

/**
 * Run the grid-walk for a single day.
 *
 * @param {object} params
 * @param {string} params.dateStr - YYYY-MM-DD (in Central time)
 * @param {object} params.barberCalendars - { haircut: calId, haircut_beard: calId, ... }
 * @param {object} params.calendarConfigs - normalized configs: calId → { id, type, slotInterval, slotDuration }
 * @param {Array} params.schedules - GHL schedules for this barber
 * @param {Array} params.calendarEvents - GHL Calendar Events (or Supabase appointments) for this day
 * @param {Array} params.blockedSlotsForDay - GHL Blocked Slots for this day
 * @returns {object|null} - metrics, or null if it's a day off
 */
function gridWalkDay({
  dateStr,
  barberCalendars,
  calendarConfigs,
  schedules,
  calendarEvents,
  blockedSlotsForDay,
}) {
  // Anchor day-of-week off noon UTC to dodge DST edge cases
  const dayDate = new Date(dateStr + "T12:00:00Z");
  const dayName = DAY_NAMES[dayDate.getUTCDay()];

  // ── Step 1: Generate per-calendar slot grids ──
  const calendarGrids = buildCalendarGrids(
    barberCalendars,
    calendarConfigs,
    schedules,
    dayName,
    dateStr,
  );
  if (Object.keys(calendarGrids).length === 0) {
    return null; // Day off
  }

  // ── Step 2: Compute work window (union of all calendar schedules) ──
  let workStart = Infinity,
    workEnd = -Infinity;
  for (const [calId, slots] of Object.entries(calendarGrids)) {
    const config = calendarConfigs[calId];
    workStart = Math.min(workStart, slots[0]);
    workEnd = Math.max(workEnd, slots[slots.length - 1] + config.slotInterval);
  }

  // ── Step 3: Collect blocking events ──
  const appointments = []; // GHL/Supabase appointments
  const breaks = []; // events with break-keyword titles
  const manualBlocks = []; // true personal blocks
  const syncedAppointments = []; // synced/informal from Blocked Slots API
  const breakBlocks = []; // break-titled blocks from Blocked Slots API

  for (const ev of calendarEvents) {
    const { startMin, endMin } = eventToCentralMinutes(ev);
    const status = (ev.appointmentStatus || ev.status || "").toLowerCase();

    if (isBreakLikeTitle(ev.title)) {
      breaks.push({ startMin, endMin });
    } else if (status === INVALID_STATUS) {
      // Skip
    } else {
      appointments.push({
        startMin,
        endMin,
        status,
        title: (ev.title || "").trim(),
        calendarId: ev.calendarId || ev.calendar_id || null,
        contactId: ev.contactId || ev.contact_id || null,
      });
    }
  }

  for (const block of blockedSlotsForDay) {
    const { startMin, endMin } = eventToCentralMinutes(block);
    const classification = classifyBlockedSlot(block);

    if (classification === "synced_appointment" || classification === "informal_appointment") {
      syncedAppointments.push({
        startMin,
        endMin,
        title: (block.title || "").trim(),
        classification,
        status: "confirmed",
        calendarId: null,
      });
    } else if (classification === "break_blocked") {
      breakBlocks.push({ startMin, endMin });
    } else {
      manualBlocks.push({ startMin, endMin, title: block.title || "Blocked" });
    }
  }

  // Merge overlapping breaks (calendar break events + block-list break-titled blocks)
  const mergedBreaks = mergeIntervals([...breaks, ...breakBlocks]);

  // Active appointments — exclude cancelled/no-show, merge in synced ones
  const ghlActiveAppts = appointments.filter(
    (a) => a.status !== CANCELLED_STATUS && a.status !== NOSHOW_STATUS,
  );
  const activeAppts = [...ghlActiveAppts, ...syncedAppointments];
  const cancelledAppts = appointments.filter((a) => a.status === CANCELLED_STATUS);
  const noshowAppts = appointments.filter((a) => a.status === NOSHOW_STATUS);

  // ── Step 4 & 5: Classify each slot, deduplicate across calendars ──

  const primaryCalId = barberCalendars.haircut;
  const primaryConfig = calendarConfigs[primaryCalId];
  const primaryInterval = primaryConfig ? primaryConfig.slotInterval : null;
  const primaryDuration = primaryConfig ? primaryConfig.slotDuration : null;

  // All-calendar deduplicated time-point status (for free-slot detection display)
  const timePointStatus = new Map(); // slotMin → { status, calId }

  // Per-calendar slot status (for service mix efficiency, debugging)
  const perCalendarSlotStatus = new Map(); // calId → Map(slotMin → status)

  for (const [calId, slots] of Object.entries(calendarGrids)) {
    const config = calendarConfigs[calId];
    const duration = config.slotDuration;
    const calSlotMap = new Map();

    for (const slotStart of slots) {
      const slotEnd = slotStart + duration;

      const isBreakBlocked = mergedBreaks.some((brk) =>
        overlaps(slotStart, slotEnd, brk.startMin, brk.endMin),
      );
      const isManuallyBlocked = manualBlocks.some((blk) =>
        overlaps(slotStart, slotEnd, blk.startMin, blk.endMin),
      );
      const isOccupied = activeAppts.some((appt) =>
        overlaps(slotStart, slotEnd, appt.startMin, appt.endMin),
      );

      let slotStatus;
      if (isBreakBlocked) slotStatus = "break-blocked";
      else if (isManuallyBlocked) slotStatus = "manually-blocked";
      else if (isOccupied) slotStatus = "occupied";
      else slotStatus = "free";

      calSlotMap.set(slotStart, slotStatus);

      // Deduplication priority: free > occupied > manually-blocked > break-blocked
      const existing = timePointStatus.get(slotStart);
      if (!existing) {
        timePointStatus.set(slotStart, { status: slotStatus, calId });
      } else if (slotStatus === "free" && existing.status !== "free") {
        timePointStatus.set(slotStart, { status: "free", calId });
      } else if (
        slotStatus === "occupied" &&
        (existing.status === "break-blocked" || existing.status === "manually-blocked")
      ) {
        timePointStatus.set(slotStart, { status: "occupied", calId });
      } else if (
        slotStatus === "manually-blocked" &&
        existing.status === "break-blocked"
      ) {
        timePointStatus.set(slotStart, { status: "manually-blocked", calId });
      }
    }

    perCalendarSlotStatus.set(calId, calSlotMap);
  }

  // ── HC-based primary denominator (Option B framing) ──
  // Use the haircut calendar's grid for utilization & shop impact.
  // Per the plan, manually-blocked slots STAY in the denominator (not removed),
  // so the barber sees the real cost of personal blocks on their score.
  const primaryGrid = calendarGrids[primaryCalId] || [];
  const primarySlotStatus = new Map();
  if (primaryGrid.length > 0 && primaryConfig) {
    for (const slotStart of primaryGrid) {
      const slotEnd = slotStart + primaryDuration;
      const isBreakBlocked = mergedBreaks.some((brk) =>
        overlaps(slotStart, slotEnd, brk.startMin, brk.endMin),
      );
      const isManuallyBlocked = manualBlocks.some((blk) =>
        overlaps(slotStart, slotEnd, blk.startMin, blk.endMin),
      );
      const isOccupied = activeAppts.some((appt) =>
        overlaps(slotStart, slotEnd, appt.startMin, appt.endMin),
      );

      if (isBreakBlocked) primarySlotStatus.set(slotStart, "break-blocked");
      else if (isManuallyBlocked) primarySlotStatus.set(slotStart, "manually-blocked");
      else if (isOccupied) primarySlotStatus.set(slotStart, "occupied");
      else primarySlotStatus.set(slotStart, "free");
    }
  }

  // ── Overtime detection ──
  // Overtime ONLY counts when a GHL-booked appointment STARTS outside the schedule grid.
  // Synced/informal appointments are excluded — they can include personal blocks
  // that the classifier marks as appointments (e.g. parenthetical titles), and we
  // don't want those inflating utilization.
  let overtimeSlots = 0;
  const allGridSlotTimes = new Set();
  for (const slots of Object.values(calendarGrids)) {
    for (const s of slots) allGridSlotTimes.add(s);
  }
  const allIntervals = Object.values(calendarConfigs).map((c) => c.slotInterval);
  const smallestInterval = allIntervals.length > 0 ? Math.min(...allIntervals) : 30;
  for (const appt of ghlActiveAppts) {
    if (appt.startMin >= workEnd && !allGridSlotTimes.has(appt.startMin)) {
      const duration = appt.endMin - appt.startMin;
      overtimeSlots += Math.ceil(duration / smallestInterval);
    }
  }

  // ── Step 6: Compute metrics ──

  // All-calendar deduped counts
  let allOccupied = 0,
    allFree = 0,
    allBreakBlocked = 0,
    allManuallyBlocked = 0;
  for (const [, info] of timePointStatus) {
    switch (info.status) {
      case "occupied": allOccupied++; break;
      case "free": allFree++; break;
      case "break-blocked": allBreakBlocked++; break;
      case "manually-blocked": allManuallyBlocked++; break;
    }
  }

  // HC-based counts (the numbers shown to the barber)
  let occupied = 0,
    free = 0,
    breakBlocked = 0,
    manuallyBlocked = 0;
  for (const [, status] of primarySlotStatus) {
    switch (status) {
      case "occupied": occupied++; break;
      case "free": free++; break;
      case "break-blocked": breakBlocked++; break;
      case "manually-blocked": manuallyBlocked++; break;
    }
  }

  // Option B: scheduledSlots = occupied + free + manuallyBlocked
  // (break-blocked slots are excluded — necessary breaks shouldn't penalize the score)
  const scheduledSlots = occupied + free + manuallyBlocked;
  const utilization =
    scheduledSlots > 0
      ? ((occupied + overtimeSlots) / scheduledSlots) * 100
      : null;

  // Cancellation/no-show impact: how many of these freed slots are still empty
  // ("contributed to your utilization score")
  const allDurations = Object.values(calendarConfigs).map((c) => c.slotDuration);
  const smallestServiceDuration = allDurations.length > 0 ? Math.min(...allDurations) : 30;

  let cancelledUnfilled = 0;
  for (const cxl of cancelledAppts) {
    for (const [slotMin, info] of timePointStatus) {
      if (info.status !== "free") continue;
      if (overlaps(slotMin, slotMin + smallestServiceDuration, cxl.startMin, cxl.endMin)) {
        cancelledUnfilled++;
        break;
      }
    }
  }

  let noshowUnfilled = 0;
  for (const ns of noshowAppts) {
    for (const [slotMin, info] of timePointStatus) {
      if (info.status !== "free") continue;
      if (overlaps(slotMin, slotMin + smallestServiceDuration, ns.startMin, ns.endMin)) {
        noshowUnfilled++;
        break;
      }
    }
  }

  const cancellationImpact =
    scheduledSlots > 0 ? (cancelledUnfilled / scheduledSlots) * 100 : 0;
  const noshowImpact =
    scheduledSlots > 0 ? (noshowUnfilled / scheduledSlots) * 100 : 0;
  const blockedImpact =
    scheduledSlots > 0 ? (manuallyBlocked / scheduledSlots) * 100 : 0;

  // Shop impact (Option B framing) — under Option B, manuallyBlocked is in the
  // denominator already, so utilization === shopImpact. Keeping the separate
  // field for backward compatibility / Stable-tier framing if needed.
  const shopImpact = utilization;

  // Actual break minutes (for revenue per hour)
  let actualBreakMinutes = 0;
  for (const brk of mergedBreaks) {
    const brkStart = Math.max(brk.startMin, workStart);
    const brkEnd = Math.min(brk.endMin, workEnd);
    if (brkEnd > brkStart) actualBreakMinutes += brkEnd - brkStart;
  }

  // ── Service Mix Efficiency ──
  // Two sources of dead space:
  //  1. Short-service: a 30-min beard trim in a 45-min HC slot leaves 15 min unused.
  //  2. Scheduling-gap: a gap between appointments shorter than the smallest service.
  let totalDeadSpaceMinutes = 0;
  let hcDeadSpaceMinutes = 0;
  const deadSpaceDetails = [];

  if (primaryInterval && activeAppts.length > 0) {
    const sortedAppts = [...activeAppts].sort((a, b) => a.startMin - b.startMin);

    // 1. Short-service dead space
    for (const appt of sortedAppts) {
      const apptDuration = appt.endMin - appt.startMin;
      const apptCalConfig = appt.calendarId ? calendarConfigs[appt.calendarId] : null;
      const calType = apptCalConfig ? apptCalConfig.type : null;
      const isHaircutService =
        appt.calendarId === primaryCalId ||
        calType === "haircut" ||
        calType === "haircut_ff";

      if (!isHaircutService && apptDuration < primaryInterval) {
        const gap = primaryInterval - apptDuration;
        if (gap < smallestServiceDuration) {
          totalDeadSpaceMinutes += gap;
          deadSpaceDetails.push({
            type: "short-service",
            time: `${minutesToTimeStr(appt.startMin)}-${minutesToTimeStr(appt.endMin)}`,
            title: appt.title,
            service: calType || "unknown",
            deadSpace: gap,
          });
        }
      }
    }

    // 2. Scheduling-gap dead space
    for (let i = 0; i < sortedAppts.length - 1; i++) {
      const cur = sortedAppts[i];
      const nxt = sortedAppts[i + 1];
      const gapStart = cur.endMin;
      const gapEnd = nxt.startMin;
      const gap = gapEnd - gapStart;

      if (
        gap > 0 &&
        gap < smallestServiceDuration &&
        gapStart >= workStart &&
        gapEnd <= workEnd
      ) {
        const isInBreak = mergedBreaks.some((brk) =>
          overlaps(gapStart, gapEnd, brk.startMin, brk.endMin),
        );
        const isInBlock = manualBlocks.some((blk) =>
          overlaps(gapStart, gapEnd, blk.startMin, blk.endMin),
        );
        if (!isInBreak && !isInBlock) {
          totalDeadSpaceMinutes += gap;
          deadSpaceDetails.push({
            type: "scheduling-gap",
            time: `${minutesToTimeStr(gapStart)}-${minutesToTimeStr(gapEnd)}`,
            title: `gap after ${cur.title}`,
            service: "gap",
            deadSpace: gap,
          });
        }
      }
    }

    // HC-optimized dead space (Coach-only metric):
    // gaps between appointments shorter than the HC duration.
    // This is "what if you only did haircuts?"
    if (primaryDuration) {
      for (let i = 0; i < sortedAppts.length - 1; i++) {
        const cur = sortedAppts[i];
        const nxt = sortedAppts[i + 1];
        const gap = nxt.startMin - cur.endMin;
        if (gap > 0 && gap < primaryDuration && cur.endMin >= workStart && nxt.startMin <= workEnd) {
          const isInBreak = mergedBreaks.some((brk) =>
            overlaps(cur.endMin, nxt.startMin, brk.startMin, brk.endMin),
          );
          const isInBlock = manualBlocks.some((blk) =>
            overlaps(cur.endMin, nxt.startMin, blk.startMin, blk.endMin),
          );
          if (!isInBreak && !isInBlock) hcDeadSpaceMinutes += gap;
        }
      }
    }
  }

  const scheduledMinutes = scheduledSlots * (primaryInterval || 30);
  const serviceMixEfficiency =
    scheduledMinutes > 0
      ? (1 - totalDeadSpaceMinutes / scheduledMinutes) * 100
      : 100;
  const hcOptimizedEfficiency =
    scheduledMinutes > 0
      ? (1 - hcDeadSpaceMinutes / scheduledMinutes) * 100
      : 100;

  return {
    dateStr,
    dayName,
    workWindow: `${minutesToTimeStr(workStart)}-${minutesToTimeStr(workEnd)}`,
    workStart,
    workEnd,

    // ── Primary metrics (HC-denominator, Option B) ──
    scheduledSlots,
    occupied,
    free,
    overtimeSlots,
    breakBlocked,
    manuallyBlocked,
    utilization: round1(utilization),
    shopImpact: round1(shopImpact),

    // ── Cause-of-loss breakdown ──
    cancelledCount: cancelledAppts.length,
    cancelledUnfilled,
    cancellationImpact: round1(cancellationImpact),
    noshowCount: noshowAppts.length,
    noshowUnfilled,
    noshowImpact: round1(noshowImpact),
    blockedImpact: round1(blockedImpact),

    // ── Service mix efficiency ──
    deadSpaceMinutes: totalDeadSpaceMinutes,
    serviceMixEfficiency: round1(serviceMixEfficiency),
    hcDeadSpaceMinutes,
    hcOptimizedEfficiency: round1(hcOptimizedEfficiency),
    deadSpaceDetails,

    // ── Synced appointment counts ──
    syncedAppointmentCount: syncedAppointments.filter((a) => a.classification === "synced_appointment").length,
    informalAppointmentCount: syncedAppointments.filter((a) => a.classification === "informal_appointment").length,

    // ── All-calendar grid (for debugging / free-slot display) ──
    allCalendarGridSlots: timePointStatus.size,
    allCalOccupied: allOccupied,
    allCalFree: allFree,
    allCalBreakBlocked: allBreakBlocked,
    allCalManuallyBlocked: allManuallyBlocked,

    // ── Revenue/hr support ──
    actualBreakMinutes,
    scheduleHours: (workEnd - workStart - actualBreakMinutes) / 60,
    primaryInterval,
    primaryDuration,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function isBreakLikeTitle(title) {
  const t = (title || "").toLowerCase();
  return /\b(lunch|break|almuerzo|comida|descanso|food|eat|meal|rest)\b/.test(t);
}

function mergeIntervals(intervals) {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.startMin - b.startMin);
  const merged = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = merged[merged.length - 1];
    if (cur.startMin <= last.endMin) {
      last.endMin = Math.max(last.endMin, cur.endMin);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

function round1(value) {
  if (value === null || value === undefined) return null;
  return Math.round(value * 10) / 10;
}

module.exports = {
  gridWalkDay,
  normalizeCalendarConfigs,
  buildCalendarGrids,
  getScheduleForDay,
  isBreakLikeTitle,
  // Exposed for tests / advanced callers
  eventToCentralMinutes,
  timeStrToMinutes,
  minutesToTimeStr,
};
