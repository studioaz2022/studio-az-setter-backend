/**
 * Front Desk Dashboard — Webhook Gap Diagnosis (READ-ONLY)
 *
 * Confirmed gap: reconciling barbershop today-1 → +60d inserted 80 rows
 * that the live webhook pipeline never persisted — 64 for Lionel Chavez,
 * 16 for Joshua Flores, 0 for everyone else.
 *
 * This script does NOT fix anything and does NOT write. It characterizes
 * the shape of "what's missing" so the root cause names itself:
 *
 *   For Lionel (1kFG5FWdUDhXLUX46snG) and Joshua (Dm20lBxWvG393LUoxuEV):
 *     1. Fetch GHL truth (today-1 → +60d) the SAME way the reconciler does.
 *     2. Pull every cached row id for that staffer in the same window.
 *     3. Diff -> the set of appointments GHL has but the cache is missing.
 *     4. Break the MISSING set down by:
 *          - calendar_id  (+ map to a friendly service key)
 *          - status
 *          - dateAdded day-of-week + hour (UTC and America/Chicago)
 *          - title pattern (F&F / blocked / contact name / empty)
 *          - whether the GHL event even has an id / startTime / contactId
 *     5. Same breakdown for the PRESENT (correctly-cached) set, so we can
 *        see what's DIFFERENT about the ones that fell through.
 *
 * Compare the MISSING breakdown to the PRESENT breakdown — the dimension
 * where they diverge is the cause.
 *
 *   cd "/Users/studioaz/AZ Setter Cursor/studio-az-setter-backend"
 *   node scripts/frontdesk-webhook-gap-diagnose.js
 */

const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const { ghlBarber } = require("../src/clients/ghlMultiLocationSdk");
const { fetchAppointmentsForDateRange } = require("../src/clients/ghlCalendarClient");
const { BARBER_DATA, BARBER_LOCATION_ID } = require("../src/config/kioskConfig");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Build calendarId -> "Barber / serviceKey" map from kioskConfig so we can
// read the breakdown without memorizing 30 calendar IDs.
const CAL_LABEL = {};
for (const b of BARBER_DATA) {
  for (const [svc, calId] of Object.entries(b.calendars || {})) {
    CAL_LABEL[calId] = `${b.name.split(" ")[0]} / ${svc}`;
  }
}
function calLabel(id) {
  if (!id) return "(no calendar_id)";
  return CAL_LABEL[id] ? `${id}  [${CAL_LABEL[id]}]` : `${id}  [UNKNOWN/not-in-kioskConfig]`;
}

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function printCounts(title, map) {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  console.log(`\n  ${title}`);
  if (entries.length === 0) {
    console.log("    (none)");
    return;
  }
  for (const [k, v] of entries) {
    console.log(`    ${String(v).padStart(4)}  ${k}`);
  }
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function titlePattern(title) {
  if (!title) return "(empty title)";
  const t = String(title).trim();
  if (!t) return "(empty title)";
  if (/f&f|friends?\s*&?\s*family|fnf/i.test(t)) return "F&F-ish title";
  if (/block|busy|unavailable|lunch|break|off/i.test(t)) return "blocked/busy-ish title";
  return "normal (contact/service title)";
}

function chicagoParts(iso) {
  if (!iso) return { dow: "(no date)", hour: "(no date)" };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { dow: "(bad date)", hour: "(bad date)" };
  // America/Chicago hour + weekday
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const wd = parts.find((p) => p.type === "weekday")?.value || "?";
  const hr = parts.find((p) => p.type === "hour")?.value || "?";
  return { dow: wd, hour: hr };
}

async function fetchCachedIds(locationId, ghlUserId, startIso, endIso) {
  // Pull every cached row for this staffer overlapping the window.
  // We key off start_time within window (same window the reconciler used).
  const ids = new Set();
  const rows = [];
  let from = 0;
  const page = 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabase
      .from("appointments")
      .select("id, calendar_id, status, start_time, title, ghl_created_at, created_at")
      .eq("location_id", locationId)
      .eq("assigned_user_id", ghlUserId)
      .gte("start_time", startIso)
      .lte("start_time", endIso)
      .range(from, from + page - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data) {
      ids.add(r.id);
      rows.push(r);
    }
    if (data.length < page) break;
    from += page;
  }
  return { ids, rows };
}

function characterize(label, events) {
  const byCal = {};
  const byStatus = {};
  const byTitlePat = {};
  const byChiDow = {};
  const byChiHour = {};
  const byAddedDow = {};
  const byAddedHour = {};
  let noId = 0;
  let noStart = 0;
  let noContact = 0;
  let noDateAdded = 0;

  for (const e of events) {
    const id = e.id || e.appointmentId;
    const start = e.startTime || e.start_time;
    const status =
      e.appointmentStatus || e.appoinmentStatus || e.status || "(none)";
    const calId = e.calendarId || e.calendar_id;
    const title = e.title;
    const contactId = e.contactId || e.contact_id;
    const dateAdded = e.dateAdded || e.ghl_created_at;

    if (!id) noId++;
    if (!start) noStart++;
    if (!contactId) noContact++;
    if (!dateAdded) noDateAdded++;

    bump(byCal, calLabel(calId));
    bump(byStatus, String(status));
    bump(byTitlePat, titlePattern(title));

    const cs = chicagoParts(start);
    bump(byChiDow, cs.dow);
    bump(byChiHour, cs.hour + ":00 CT");

    const ca = chicagoParts(dateAdded);
    bump(byAddedDow, ca.dow);
    bump(byAddedHour, ca.hour + ":00 CT");
  }

  console.log(`\n${"-".repeat(74)}`);
  console.log(`  ${label}: ${events.length} appointment(s)`);
  console.log(
    `  integrity: noId=${noId} noStartTime=${noStart} noContactId=${noContact} noDateAdded=${noDateAdded}`
  );
  printCounts("by calendar_id (the smoking-gun dimension):", byCal);
  printCounts("by status:", byStatus);
  printCounts("by title pattern:", byTitlePat);
  printCounts("by appt start — weekday (America/Chicago):", byChiDow);
  printCounts("by GHL dateAdded — weekday (America/Chicago):", byAddedDow);
  printCounts("by GHL dateAdded — hour (America/Chicago):", byAddedHour);
}

async function diagnoseStaff(member, startMs, endMs, startIso, endIso) {
  console.log(`\n${"=".repeat(74)}`);
  console.log(`${member.name}  (${member.ghlUserId})`);
  console.log(
    `Calendars in kioskConfig: ` +
      Object.entries(member.calendars || {})
        .map(([k, v]) => `${k}=${v}`)
        .join("  ")
  );
  console.log("=".repeat(74));

  let events;
  try {
    events = await fetchAppointmentsForDateRange({
      locationId: BARBER_LOCATION_ID,
      startTime: startMs,
      endTime: endMs,
      userId: member.ghlUserId,
      sdkInstance: ghlBarber,
    });
  } catch (err) {
    console.error(`GHL fetch failed for ${member.name}:`, err.message);
    return;
  }

  const { ids: cachedIds } = await fetchCachedIds(
    BARBER_LOCATION_ID,
    member.ghlUserId,
    startIso,
    endIso
  );

  const missing = [];
  const present = [];
  for (const e of events) {
    const id = e.id || e.appointmentId;
    if (id && cachedIds.has(id)) present.push(e);
    else missing.push(e);
  }

  console.log(
    `\nGHL truth: ${events.length} events | cached (start in window): ${cachedIds.size} | ` +
      `PRESENT (in both): ${present.length} | MISSING (GHL only): ${missing.length}`
  );

  characterize("MISSING (never reached / never persisted)", missing);
  characterize("PRESENT (correctly cached — control group)", present);

  // Dump the first few missing rows raw so we can eyeball payload shape.
  console.log(`\n  Sample of up to 8 MISSING raw GHL events:`);
  for (const e of missing.slice(0, 8)) {
    console.log(
      `    id=${e.id || "(none)"} cal=${e.calendarId || "(none)"} ` +
        `status=${e.appointmentStatus || e.status || "(none)"} ` +
        `start=${e.startTime} added=${e.dateAdded || "(none)"} ` +
        `title=${JSON.stringify((e.title || "").slice(0, 40))}`
    );
  }
}

(async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env");
    process.exit(1);
  }
  if (!ghlBarber) {
    console.error(
      "ghlBarber SDK not available — check GHL_BARBER_SHOP_TOKEN in .env"
    );
    process.exit(1);
  }

  // Same window the failing reconcile used: today-1 → +60d.
  const startMs = Date.now() - 1 * MS_PER_DAY;
  const endMs = Date.now() + 60 * MS_PER_DAY;
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();

  console.log("Webhook Gap Diagnosis (READ-ONLY)");
  console.log("Run at:", new Date().toISOString());
  console.log(`Window: ${startIso}  →  ${endIso}  (today-1 → +60d)`);

  const targets = BARBER_DATA.filter(
    (b) =>
      b.ghlUserId === "1kFG5FWdUDhXLUX46snG" || // Lionel
      b.ghlUserId === "Dm20lBxWvG393LUoxuEV" // Joshua
  );

  // Control: also run Drew (reported 83/83 perfectly in sync) to confirm
  // the diagnostic itself agrees there's no gap for a healthy barber.
  const control = BARBER_DATA.find((b) => b.ghlUserId === "zKiZ5w3ImX0bA7zrFIZx");
  if (control) targets.push(control);

  for (const m of targets) {
    await diagnoseStaff(m, startMs, endMs, startIso, endIso);
  }

  console.log(`\n${"=".repeat(74)}`);
  console.log(
    "READ THE DIFF: compare each barber's MISSING breakdown to PRESENT.\n" +
      "If MISSING is concentrated on F&F calendars (haircut_fnf / haircut_beard_fnf)\n" +
      "while PRESENT is the normal calendars, the gap is a per-calendar GHL\n" +
      "workflow-subscription problem, not a handler bug."
  );
  process.exit(0);
})().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
