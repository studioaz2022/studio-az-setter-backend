// barberHoursRoutes.js — Barber self-service hours (uploader dashboard)
//
// Lets each barber manage their weekly availability + date overrides from the
// barber-uploader web app. All writes go through the GHL **Schedules API** —
// NEVER the legacy openHours calendar PUT, which returns 200 but silently
// fails to apply on round_robin calendars (see memory/ghl-schedules-api.md).
//
// Learned-the-hard-way rules honored here (mirrors iOS CalendarService):
//   • Schedules belong to a userId; calendars map via schedule.calendarIds.
//     A barber's per-service schedule is shared by their website calendar AND
//     their walk-in kiosk calendar — one edit updates both.
//   • PUT /calendars/schedules/{id} REPLACES ALL RULES. The client must send
//     all 7 wday rules (closed day = empty intervals) + every date rule
//     together, or the omitted ones are wiped. Enforced below.
//   • Days lowercase, times "HH:mm", timezone America/Chicago on every write.
//   • from < to validated server-side (GHL accepts inverted intervals and
//     then misbehaves downstream).
//
// GET /api/barber-hours/schedules?userId=<ghlUserId>   (gated x-internal-key)
//   → { success, schedules: [{ id, name, serviceKey, serviceLabel,
//        calendarIds, rules, timezone }] }
//
// PUT /api/barber-hours/schedules/:scheduleId          (gated x-internal-key)
//   JSON: { userId, rules }
//   Ownership-checked: scheduleId must belong to userId's schedule set.
//   Snapshots previous rules to schedule_history (non-blocking) like iOS.
//   → { success, schedule }

const express = require("express");
const { ghlBarber } = require("../clients/ghlMultiLocationSdk");
const { supabase } = require("../clients/supabaseClient");
const { BARBER_DATA, BARBER_LOCATION_ID, WALK_IN_CALENDARS } = require("../config/kioskConfig");

const router = express.Router();
router.use(express.json({ limit: "128kb" }));

const GHL_VERSION = { Version: "2021-04-15" };
const TIMEZONE = "America/Chicago";

const WDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SERVICE_LABELS = {
  haircut: "Haircut",
  haircut_beard: "Haircut + Beard",
  haircut_fnf: "Haircut (F&F)",
  haircut_beard_fnf: "Haircut + Beard (F&F)",
  beard_trim: "Beard Trim",
  grey_blending: "Grey Blending",
  neck_trim: "Neck Trim",
};
// Display order for the service tabs in the uploader.
const SERVICE_ORDER = Object.keys(SERVICE_LABELS);

// calendarId → { serviceKey, barber ghlUserId }, built once from kioskConfig.
// (Walk-in calendars share the same schedules, so labeling off the website
// calendars is sufficient — a schedule's calendarIds will contain one.)
const CALENDAR_SERVICE = {};
for (const barber of BARBER_DATA) {
  for (const [serviceKey, calId] of Object.entries(barber.calendars)) {
    CALENDAR_SERVICE[calId] = { serviceKey, ghlUserId: barber.ghlUserId };
  }
}

// ─── Calendar booking settings (slot duration / interval) ─────────────────
//
// ⚠️ PUT /calendars/{id} is a FULL REPLACE and it is genuinely destructive.
// Verified live on the test calendar 2026-08-20:
//   • Echoing the whole GET body back and INCLUDING `openHours` DELETES the
//     associated Schedules-API schedule outright (not merely disassociated —
//     it vanishes from /schedules/search, with no orphan to recover).
//   • Echoing the same body but OMITTING `openHours` leaves the schedule
//     completely intact (same id, same rules) and free-slots keep serving.
// So `openHours` in the body is what flips the calendar back to legacy
// availability mode and nukes the schedule. We therefore NEVER send it.
// (The iOS app does the opposite — always sends openHours, then repairs the
// wreckage via reassociateOrRecreateSchedule. This path avoids the damage.)
//
// `availabilities` is omitted for the same reason: legacy date overrides are
// superseded by the schedule's `date` rules, and echoing the server's shape
// (_id/ISO dates/__v) back is a needless risk.
//
// Every other field the GET returned is echoed verbatim, so widgetSlug,
// groupId, eventType, notifications, buffers and appointment caps survive.
const CALENDAR_PUT_STRIP = new Set([
  "id", "_id", "locationId", "createdAt", "updatedAt", "__v", "dateAdded", "dateUpdated",
  "availabilities",
]);

// GHL's calendar GET and PUT disagree on casing: the GET returns
// `formSubmitRedirectUrl`, the PUT schema wants `formSubmitRedirectURL`.
// Sending the GET spelling 422s with "should not exist"; dropping it instead
// 422s with "formSubmitRedirectURL must be a string" on any calendar whose
// formSubmitType is RedirectURL (Drew's Haircut + Beard). So rename, never strip.
const CALENDAR_PUT_RENAME = { formSubmitRedirectUrl: "formSubmitRedirectURL" };

/** Field names GHL named in a 422 "property X should not exist" response. */
function rejectedProperties(err) {
  const messages = err?.response?.data?.message ?? err?.response?.message;
  const list = Array.isArray(messages) ? messages : [messages].filter(Boolean);
  return list
    .map((m) => /property (\S+) should not exist/.exec(String(m))?.[1])
    .filter(Boolean);
}

const MIN_SLOT = 5;
const MAX_SLOT = 480;

async function fetchCalendar(calendarId) {
  const r = await ghlBarber.calendars.getCalendar({ calendarId });
  return r?.data?.calendar || r?.calendar || r?.data || r;
}

/** Minutes, whatever unit GHL stored it in. */
function toMinutes(value, unit) {
  if (typeof value !== "number") return null;
  return unit === "hours" ? value * 60 : value;
}

/**
 * Apply booking settings to one calendar, preserving every other field.
 * `patch` holds only the keys being changed (already in minutes).
 */
async function patchCalendarBooking(calendarId, patch, { scheduleOwnsAvailability }) {
  const current = await fetchCalendar(calendarId);
  const body = {};
  for (const [k, v] of Object.entries(current)) {
    if (CALENDAR_PUT_STRIP.has(k)) continue;
    // Dropping openHours is what keeps the Schedules-API schedule alive — but
    // only a calendar that HAS a schedule can afford to lose it. Calendars
    // still running on legacy openHours (Anna Kinkead's four, as of
    // 2026-08-20) would lose all availability, so theirs is echoed back.
    if (k === "openHours" && scheduleOwnsAvailability) continue;
    body[CALENDAR_PUT_RENAME[k] || k] = v;
  }
  Object.assign(body, patch);

  // GHL's calendar GET and PUT schemas are not symmetric: some fields come
  // back on GET and are refused on PUT. The response names them, so drop
  // exactly those and retry instead of failing the barber's save — different
  // calendars carry different optional fields, and hardcoding the full list
  // would break again on the next calendar that has one we haven't seen.
  const http = ghlBarber.getHttpClient();
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await http.put(`/calendars/${calendarId}`, body, { headers: GHL_VERSION });
      return current;
    } catch (err) {
      const rejected = rejectedProperties(err);
      if (!rejected.length) throw err;
      for (const prop of rejected) delete body[prop];
      console.warn(
        `[barberHours] calendar ${calendarId}: GHL refused ${rejected.join(", ")} on PUT — retrying without`,
      );
    }
  }
  throw new Error(`calendar ${calendarId}: PUT still rejected after stripping refused properties`);
}

function makeRequireInternalKey() {
  return (req, res, next) => {
    const expected = process.env.INTERNAL_API_KEY;
    if (!expected) {
      return res.status(503).json({ success: false, error: "INTERNAL_API_KEY not configured on server" });
    }
    if (req.get("x-internal-key") !== expected) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    next();
  };
}

function findBarber(ghlUserId) {
  return BARBER_DATA.find((b) => b.ghlUserId === ghlUserId) || null;
}

async function searchSchedules(ghlUserId) {
  if (!ghlBarber) throw new Error("ghlBarber SDK not configured");
  const httpClient = ghlBarber.getHttpClient();
  const resp = await httpClient.get(
    `/calendars/schedules/search?locationId=${BARBER_LOCATION_ID}&userId=${ghlUserId}`,
    { headers: GHL_VERSION },
  );
  return (resp.data?.schedules || []).filter((s) => !s.deleted);
}

function serviceForSchedule(schedule) {
  for (const calId of schedule.calendarIds || []) {
    const hit = CALENDAR_SERVICE[calId];
    if (hit) return hit.serviceKey;
  }
  return null;
}

function shapeSchedule(schedule) {
  const serviceKey = serviceForSchedule(schedule);
  return {
    id: schedule._id || schedule.id,
    name: schedule.name,
    serviceKey,
    serviceLabel: serviceKey ? SERVICE_LABELS[serviceKey] : schedule.name,
    calendarIds: schedule.calendarIds || [],
    rules: schedule.rules || [],
    timezone: schedule.timezone || TIMEZONE,
  };
}

/**
 * Which calendars a service's booking settings apply to.
 *
 * A barber's website calendar and their walk-in kiosk calendar share one
 * schedule, but they are NOT interchangeable:
 *   • slotDuration must match on both — a 40-minute cut is 40 minutes whether
 *     it was booked online or walked in; letting them drift double-books the chair.
 *   • slotInterval must NOT be copied to the walk-in calendar. Those are
 *     deliberately 5 min so the kiosk can offer the next 5-minute mark, which
 *     is the entire point of the walk-in group.
 */
function calendarsForService(ghlUserId, serviceKey) {
  const barber = findBarber(ghlUserId);
  const websiteCalendarId = barber?.calendars?.[serviceKey] || null;
  const walkInCandidate = (WALK_IN_CALENDARS[ghlUserId] || {})[serviceKey] || null;
  // The test barber reuses one calendar for both roles — don't PUT it twice.
  const walkInCalendarId = walkInCandidate && walkInCandidate !== websiteCalendarId ? walkInCandidate : null;
  return { websiteCalendarId, walkInCalendarId };
}

/** Booking settings as the uploader shows them: always minutes. */
async function readBookingSettings(ghlUserId, serviceKey) {
  const { websiteCalendarId, walkInCalendarId } = calendarsForService(ghlUserId, serviceKey);
  if (!websiteCalendarId) return null;
  const cal = await fetchCalendar(websiteCalendarId);
  return {
    calendarId: websiteCalendarId,
    walkInCalendarId,
    slotDuration: toMinutes(cal.slotDuration, cal.slotDurationUnit) ?? 30,
    slotInterval: toMinutes(cal.slotInterval, cal.slotIntervalUnit) ?? 30,
  };
}

/**
 * Validate a full replacement rule set.
 * Returns an error string, or null when valid.
 */
function validateRules(rules) {
  if (!Array.isArray(rules)) return "rules must be an array";
  if (rules.length > 400) return "too many rules";

  const seenDays = new Set();
  const seenDates = new Set();

  for (const rule of rules) {
    if (!rule || typeof rule !== "object") return "invalid rule";

    if (rule.type === "wday") {
      if (!WDAYS.includes(rule.day)) return `invalid day "${rule.day}"`;
      if (seenDays.has(rule.day)) return `duplicate rule for ${rule.day}`;
      seenDays.add(rule.day);
    } else if (rule.type === "date") {
      if (!DATE_RE.test(rule.date || "")) return `invalid date "${rule.date}"`;
      if (seenDates.has(rule.date)) return `duplicate override for ${rule.date}`;
      seenDates.add(rule.date);
    } else {
      return `unknown rule type "${rule.type}"`;
    }

    if (!Array.isArray(rule.intervals)) return "intervals must be an array";
    for (const iv of rule.intervals) {
      if (!TIME_RE.test(iv?.from || "") || !TIME_RE.test(iv?.to || "")) {
        return `invalid time interval ${iv?.from}–${iv?.to}`;
      }
      if (iv.from >= iv.to) {
        // "HH:mm" compares correctly as strings
        const label = rule.day || rule.date;
        return `close time must be after open time on ${label} (${iv.from}–${iv.to})`;
      }
    }
  }

  // GHL replaces ALL rules on PUT — a partial wday set would silently wipe the
  // missing days, so require the complete week every time (closed = []).
  if (seenDays.size !== 7) {
    return "rules must include all 7 weekday rules (closed days use empty intervals)";
  }
  return null;
}

/** Sanitize to exactly the fields GHL expects — strip anything else the client sent. */
function cleanRules(rules) {
  return rules.map((rule) =>
    rule.type === "wday"
      ? { type: "wday", day: rule.day, intervals: rule.intervals.map((iv) => ({ from: iv.from, to: iv.to })) }
      : { type: "date", date: rule.date, intervals: rule.intervals.map((iv) => ({ from: iv.from, to: iv.to })) },
  );
}

/** "Changed Mon, Wed hours" — mirrors iOS generateChangeSummary. */
function changeSummary(oldRules, newRules) {
  const abbr = { sunday: "Sun", monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat" };
  const ordered = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const byDay = (rules, day) => JSON.stringify((rules.find((r) => r.type === "wday" && r.day === day) || {}).intervals || []);
  const changed = ordered.filter((d) => byDay(oldRules, d) !== byDay(newRules, d)).map((d) => abbr[d]);

  const oldDates = oldRules.filter((r) => r.type === "date").length;
  const newDates = newRules.filter((r) => r.type === "date").length;
  const parts = [];
  if (changed.length) parts.push(`Changed ${changed.join(", ")} hours`);
  if (newDates !== oldDates) parts.push(`${newDates > oldDates ? "Added" : "Removed"} date override`);
  return parts.join("; ") || "Updated schedule";
}

/** Non-blocking history snapshot, same table iOS writes (schedule_history). */
async function snapshotHistory({ schedule, barber, newRules }) {
  if (!supabase) return;
  try {
    const scheduleId = schedule._id || schedule.id;
    const calendarId = (schedule.calendarIds || [])[0] || "";
    const { data: rows } = await supabase
      .from("schedule_history")
      .select("version_number")
      .eq("calendar_id", calendarId)
      .eq("user_id", barber.ghlUserId)
      .order("version_number", { ascending: false })
      .limit(1);
    const version = ((rows && rows[0]?.version_number) || 0) + 1;

    await supabase.from("schedule_history").insert({
      schedule_id: scheduleId,
      calendar_id: calendarId,
      calendar_name: schedule.name,
      user_id: barber.ghlUserId,
      user_name: barber.name,
      changed_by_ghl_id: barber.ghlUserId, // self-service: the barber is the editor
      changed_by_name: `${barber.name} (uploader)`,
      rules_snapshot: (schedule.rules || []).filter((r) => r.type === "wday"),
      version_number: version,
      change_summary: changeSummary(schedule.rules || [], newRules),
      location_id: BARBER_LOCATION_ID,
    });
    console.log(`[barberHours] history v${version} saved for ${barber.name} (${schedule.name})`);
  } catch (err) {
    console.warn(`[barberHours] history snapshot failed (non-blocking): ${err.message}`);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────

router.get("/schedules", makeRequireInternalKey(), async (req, res) => {
  try {
    const userId = String(req.query.userId || "");
    const barber = findBarber(userId);
    if (!barber) {
      return res.status(404).json({ success: false, error: "Unknown barber" });
    }

    const schedules = (await searchSchedules(userId)).map(shapeSchedule);

    // Only surface schedules we can label as one of the barber's services —
    // keeps stray/orphaned schedules out of the barber-facing UI.
    const known = schedules.filter((s) => s.serviceKey);
    known.sort((a, b) => SERVICE_ORDER.indexOf(a.serviceKey) - SERVICE_ORDER.indexOf(b.serviceKey));

    // Booking settings live on the calendar, not the schedule — fetch in parallel.
    await Promise.all(
      known.map(async (s) => {
        try {
          s.booking = await readBookingSettings(userId, s.serviceKey);
        } catch (err) {
          console.warn(`[barberHours] booking settings unavailable for ${s.serviceKey}: ${err.message}`);
          s.booking = null;
        }
      }),
    );

    return res.json({ success: true, schedules: known });
  } catch (err) {
    console.error(`[barberHours] GET /schedules failed: ${err.message}`);
    return res.status(502).json({ success: false, error: "Could not load schedules from GHL" });
  }
});

router.put("/schedules/:scheduleId", makeRequireInternalKey(), async (req, res) => {
  try {
    const { scheduleId } = req.params;
    const { userId, rules } = req.body || {};

    const barber = findBarber(String(userId || ""));
    if (!barber) {
      return res.status(404).json({ success: false, error: "Unknown barber" });
    }

    const validationError = validateRules(rules);
    if (validationError) {
      return res.status(400).json({ success: false, error: validationError });
    }

    // Ownership check: the schedule must belong to this barber's set. Prevents
    // one barber (or a proxy bug) from editing someone else's hours.
    const owned = await searchSchedules(String(userId));
    const target = owned.find((s) => (s._id || s.id) === scheduleId);
    if (!target) {
      return res.status(403).json({ success: false, error: "That schedule doesn't belong to you" });
    }

    const newRules = cleanRules(rules);

    // Snapshot BEFORE the write (non-blocking), like iOS saveScheduleSnapshot.
    await snapshotHistory({ schedule: target, barber, newRules });

    const httpClient = ghlBarber.getHttpClient();
    const resp = await httpClient.put(
      `/calendars/schedules/${scheduleId}`,
      { rules: newRules, timezone: TIMEZONE },
      { headers: GHL_VERSION },
    );

    const updated = resp.data?.schedule || resp.data;
    console.log(`[barberHours] ${barber.name} updated "${target.name}" (${scheduleId}): ${newRules.length} rules`);
    return res.json({ success: true, schedule: shapeSchedule(updated) });
  } catch (err) {
    console.error(`[barberHours] PUT /schedules failed: ${err.message}`);
    return res.status(502).json({ success: false, error: "Could not save schedule to GHL" });
  }
});

// PUT /schedules/:scheduleId/booking   { userId, slotDuration, slotInterval }
// Minutes only — the uploader never exposes GHL's mins/hours unit toggle.
router.put("/schedules/:scheduleId/booking", makeRequireInternalKey(), async (req, res) => {
  try {
    const { scheduleId } = req.params;
    const { userId, slotDuration, slotInterval } = req.body || {};

    const barber = findBarber(String(userId || ""));
    if (!barber) {
      return res.status(404).json({ success: false, error: "Unknown barber" });
    }

    for (const [label, value] of [["Cut length", slotDuration], ["Start times", slotInterval]]) {
      if (!Number.isInteger(value) || value < MIN_SLOT || value > MAX_SLOT) {
        return res.status(400).json({
          success: false,
          error: `${label} must be between ${MIN_SLOT} and ${MAX_SLOT} minutes`,
        });
      }
      if (value % MIN_SLOT !== 0) {
        return res.status(400).json({ success: false, error: `${label} must be a multiple of ${MIN_SLOT} minutes` });
      }
    }

    const owned = await searchSchedules(String(userId));
    const target = owned.find((s) => (s._id || s.id) === scheduleId);
    if (!target) {
      return res.status(403).json({ success: false, error: "That schedule doesn't belong to you" });
    }

    const serviceKey = serviceForSchedule(target);
    const { websiteCalendarId, walkInCalendarId } = calendarsForService(String(userId), serviceKey);
    if (!websiteCalendarId) {
      return res.status(400).json({ success: false, error: "No bookable calendar for that service" });
    }

    const scheduleCalendars = new Set(target.calendarIds || []);

    // Website calendar carries both settings.
    await patchCalendarBooking(
      websiteCalendarId,
      { slotDuration, slotDurationUnit: "mins", slotInterval, slotIntervalUnit: "mins" },
      { scheduleOwnsAvailability: scheduleCalendars.has(websiteCalendarId) },
    );

    // Walk-in kiosk calendar: duration only. Its 5-minute slotInterval and
    // zero booking notice are what make instant walk-in booking work.
    if (walkInCalendarId) {
      await patchCalendarBooking(
        walkInCalendarId,
        { slotDuration, slotDurationUnit: "mins" },
        { scheduleOwnsAvailability: scheduleCalendars.has(walkInCalendarId) },
      );
    }

    // Belt and braces: the PUT recipe above leaves schedules intact (verified),
    // but a silently destroyed schedule means a barber with no availability, so
    // confirm rather than assume — and rebuild from the pre-PUT snapshot if it
    // ever does vanish.
    const after = await searchSchedules(String(userId));
    let live = after.find((s) => (s._id || s.id) === scheduleId);
    if (!live) {
      console.error(`[barberHours] schedule ${scheduleId} vanished after calendar PUT — rebuilding`);
      const recreated = (
        await ghlBarber.getHttpClient().post(
          "/calendars/schedules",
          {
            name: target.name,
            userId: String(userId),
            locationId: BARBER_LOCATION_ID,
            timezone: target.timezone || TIMEZONE,
            rules: target.rules || [],
          },
          { headers: GHL_VERSION },
        )
      ).data;
      live = recreated.schedule || recreated;
      const newId = live._id || live.id;
      for (const calId of target.calendarIds || []) {
        await ghlBarber
          .getHttpClient()
          .put(`/calendars/schedules/${newId}/associations/${calId}`, {}, { headers: GHL_VERSION });
      }
      console.log(`[barberHours] rebuilt schedule as ${newId} across ${(target.calendarIds || []).length} calendars`);
    }

    const booking = await readBookingSettings(String(userId), serviceKey);
    console.log(
      `[barberHours] ${barber.name} set ${serviceKey} to ${slotDuration}min cut / ${slotInterval}min starts` +
        (walkInCalendarId ? " (duration mirrored to walk-in)" : ""),
    );
    return res.json({ success: true, booking, scheduleId: live._id || live.id });
  } catch (err) {
    console.error(`[barberHours] PUT /booking failed: ${err.message}`);
    return res.status(502).json({ success: false, error: "Could not save booking settings to GHL" });
  }
});

module.exports = router;
