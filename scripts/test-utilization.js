#!/usr/bin/env node
/**
 * test-utilization.js — Chair Utilization Test Runner
 *
 * Usage:
 *   node scripts/test-utilization.js                          # Lionel, last 7 days
 *   node scripts/test-utilization.js --barber="Drew Smith"    # Specific barber
 *   node scripts/test-utilization.js --start=2026-03-01 --end=2026-03-15
 *   node scripts/test-utilization.js --verbose                # Show every event + break
 *   node scripts/test-utilization.js --raw                    # Show raw GHL data (schedules, events)
 *
 * Requires: .env with GHL_BARBER_LOCATION_ID, GHL_FILE_UPLOAD_TOKEN (PIT token)
 */

require("dotenv").config();
const { getChairUtilization } = require("../src/analytics/analyticsQueries");
const { BARBER_DATA, BARBER_LOCATION_ID } = require("../src/config/kioskConfig");

// ── Parse CLI args ──
const args = process.argv.slice(2);
const getArg = (name) => {
  const match = args.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split("=").slice(1).join("=") : null;
};
const hasFlag = (name) => args.includes(`--${name}`);

const barberName = getArg("barber") || "Lionel Chavez";
const verbose = hasFlag("verbose");
const rawMode = hasFlag("raw");

// Default: last 7 days
const endDate =
  getArg("end") ||
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(
    new Date()
  );
const startDate =
  getArg("start") ||
  (() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago",
    }).format(d);
  })();

const barber = BARBER_DATA.find(
  (b) => b.name.toLowerCase() === barberName.toLowerCase()
);
if (!barber) {
  console.error(
    `Barber "${barberName}" not found. Available: ${BARBER_DATA.map((b) => b.name).join(", ")}`
  );
  process.exit(1);
}

const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

async function showRawData() {
  const { ghlBarber } = require("../src/clients/ghlMultiLocationSdk");
  const httpClient = ghlBarber.getHttpClient();

  // 1. Schedules
  console.log("\n═══ SCHEDULE RULES ═══");
  const schedResp = await httpClient.get(
    `/calendars/schedules/search?locationId=${BARBER_LOCATION_ID}&userId=${barber.ghlUserId}`
  );
  const schedules = schedResp.data?.schedules || [];
  for (const sched of schedules) {
    const calIds = sched.calendarIds || [];
    const label =
      calIds.length === 0
        ? "Work Hours"
        : calIds
            .map((id) => {
              const entry = Object.entries(barber.calendars || {}).find(
                ([, v]) => v === id
              );
              return entry ? entry[0] : id.substring(0, 8);
            })
            .join("+");
    console.log(`\n  ${label}:`);
    for (const rule of sched.rules || []) {
      if (rule.type !== "wday") continue;
      const intervals = (rule.intervals || []).filter(
        (iv) => iv.from && iv.to
      );
      console.log(
        `    ${rule.day.padEnd(10)}: ${intervals.length > 0 ? intervals.map((iv) => `${iv.from}-${iv.to}`).join(", ") : "CLOSED"}`
      );
    }
  }

  // 2. Calendar configs
  console.log("\n═══ CALENDAR SLOT CONFIG ═══");
  const toMinutes = (v, u) => (u === "hours" ? v * 60 : v);
  for (const [type, calId] of Object.entries(barber.calendars || {})) {
    try {
      const calResp = await ghlBarber.calendars.getCalendar({
        calendarId: calId,
      });
      const cal = calResp?.calendar || calResp;
      const dur = toMinutes(cal.slotDuration, cal.slotDurationUnit);
      const int = toMinutes(cal.slotInterval, cal.slotIntervalUnit);
      console.log(
        `  ${type.padEnd(20)}: duration=${dur}min, interval=${int}min, buffer=${cal.slotBuffer || 0}min`
      );
    } catch (err) {
      console.log(`  ${type.padEnd(20)}: ERROR — ${err.message}`);
    }
  }
}

async function showVerboseDay(date) {
  const { ghlBarber } = require("../src/clients/ghlMultiLocationSdk");
  const httpClient = ghlBarber.getHttpClient();
  const sf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const getMin = (p) =>
    parseInt(p.find((x) => x.type === "hour").value) * 60 +
    parseInt(p.find((x) => x.type === "minute").value);
  const fmtTime = (m) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

  const offset = "-06:00"; // Central (approximate — DST handled by Intl)
  const dayStartMs = new Date(`${date}T00:00:00${offset}`).getTime();
  const dayEndMs = new Date(`${date}T23:59:59${offset}`).getTime();

  const resp = await httpClient.get(
    `/calendars/events?locationId=${BARBER_LOCATION_ID}&userId=${barber.ghlUserId}&startTime=${dayStartMs}&endTime=${dayEndMs}`,
    { headers: { Version: "2021-04-15" } }
  );
  const events = resp.data?.events || [];

  const breakKw = [
    "break",
    "lunch",
    "block",
    "time off",
    "blocked",
    "unavailable",
  ];
  const kioskCals = new Set(Object.values(barber.calendars || {}));
  const hbTypes = new Set(["haircut_beard", "haircut_beard_fnf"]);
  const hbCals = new Set();
  for (const [type, calId] of Object.entries(barber.calendars || {})) {
    if (hbTypes.has(type)) hbCals.add(calId);
  }

  for (const ev of events) {
    const s = new Date(ev.startTime);
    const e = new Date(ev.endTime);
    const startMin = getMin(sf.formatToParts(s));
    const endMin = getMin(sf.formatToParts(e));
    const dur = (e - s) / 60000;
    const title = (ev.title || "").toLowerCase();
    const isBreak = breakKw.some((kw) => title.includes(kw));
    const inKiosk = kioskCals.has(ev.calendarId);
    const isHB = hbCals.has(ev.calendarId);
    const calType =
      Object.entries(barber.calendars || {}).find(
        ([, id]) => id === ev.calendarId
      )?.[0] || "unknown";

    const tag = isBreak
      ? "BREAK"
      : isHB
        ? "H+B"
        : inKiosk
          ? "CLIENT"
          : "OTHER";
    const kioskTag = inKiosk ? "" : " [non-kiosk]";
    console.log(
      `    ${fmtTime(startMin)}-${fmtTime(endMin)} (${String(dur).padStart(3)}min) ${tag.padEnd(6)} ${calType.padEnd(18)} ${ev.title || "untitled"}${kioskTag}`
    );
  }

  // Blocked slots
  const bsResp = await httpClient.get(
    `/calendars/blocked-slots?locationId=${BARBER_LOCATION_ID}&userId=${barber.ghlUserId}&startTime=${dayStartMs}&endTime=${dayEndMs}`,
    { headers: { Version: "2021-04-15" } }
  );
  const blocked = (bsResp.data?.events || []).filter((b) => !b.deleted);
  if (blocked.length > 0) {
    for (const bs of blocked) {
      const s = new Date(bs.startTime);
      const e = new Date(bs.endTime);
      const startMin = getMin(sf.formatToParts(s));
      const endMin = getMin(sf.formatToParts(e));
      console.log(
        `    ${fmtTime(startMin)}-${fmtTime(endMin)} (${endMin - startMin}min) BLOCKED  recurring:${bs.isRecurring} | ${bs.title || "untitled"}`
      );
    }
  }
}

async function run() {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  Chair Utilization Test — ${barber.name.padEnd(20)} ${startDate} → ${endDate}  ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝`);
  console.log(`  GHL User ID: ${barber.ghlUserId}`);
  console.log(`  Location:    ${BARBER_LOCATION_ID}`);
  console.log(
    `  Calendars:   ${Object.entries(barber.calendars || {}).map(([t, id]) => `${t}=${id.substring(0, 8)}`).join(", ")}`
  );

  if (rawMode) {
    await showRawData();
  }

  console.log(
    "\n  Date       | Day | rawSch | Cap  | Used | Free | brkCost | hbBld | Util    | Appts | availIdx | blk%"
  );
  console.log(
    "  -----------|-----|--------|------|------|------|---------|-------|---------|-------|----------|-----"
  );

  const current = new Date(startDate + "T12:00:00Z");
  const end = new Date(endDate + "T12:00:00Z");

  while (current <= end) {
    const dateStr = current.toISOString().split("T")[0];
    const day = dayNames[current.getUTCDay()];

    if (verbose) {
      console.log(`\n  ── ${dateStr} (${day}) ──`);
      await showVerboseDay(dateStr);
    }

    const r = await getChairUtilization(
      barber.ghlUserId,
      BARBER_LOCATION_ID,
      1,
      dateStr
    );
    const util =
      r.utilization != null ? r.utilization.toFixed(1) + "%" : "null";
    const availIdx =
      r.availabilityIndex != null
        ? r.availabilityIndex.toFixed(0) + "%"
        : "—";
    const blkPct =
      r.blockedPercent != null ? r.blockedPercent.toFixed(0) + "%" : "—";

    // Derive break cost and H+B bleed from the numbers
    const raw = r.rawScheduleMinutes || 0;
    const cap = r.capacityMinutes || 0;
    // breakCost + deadSpace - hbBleed = raw - cap (we can't separate them without more data)
    const deductions = raw - cap;

    console.log(
      `  ${dateStr} | ${day} | ${String(raw).padStart(6)} | ${String(cap).padStart(4)} | ` +
        `${String(r.utilizedMinutes).padStart(4)} | ${String(r.freeSlotMinutes).padStart(4)} | ` +
        `${String(deductions).padStart(7)} |     — | ${util.padStart(7)} | ${String(r.appointmentCount).padStart(5)} | ` +
        `${availIdx.padStart(8)} | ${blkPct.padStart(4)}`
    );

    current.setUTCDate(current.getUTCDate() + 1);
  }

  // Weekly summary
  console.log("\n  ── Period Summary ──");
  const period = await getChairUtilization(
    barber.ghlUserId,
    BARBER_LOCATION_ID,
    Math.round((end - new Date(startDate + "T12:00:00Z")) / 86400000) + 1,
    endDate
  );
  console.log(`  Utilization:        ${period.utilization != null ? period.utilization.toFixed(1) + "%" : "null"}`);
  console.log(`  Capacity:           ${period.capacityMinutes} min (${(period.capacityMinutes / 60).toFixed(1)} hrs)`);
  console.log(`  Utilized:           ${period.utilizedMinutes} min (${(period.utilizedMinutes / 60).toFixed(1)} hrs)`);
  console.log(`  Free slots:         ${period.freeSlotMinutes} min (${(period.freeSlotMinutes / 60).toFixed(1)} hrs)`);
  console.log(`  Appointments:       ${period.appointmentCount}`);
  console.log(`  Availability Index: ${period.availabilityIndex != null ? period.availabilityIndex.toFixed(1) + "%" : "—"}`);
  console.log(`  Shop Impact:        ${period.shopImpact != null ? period.shopImpact.toFixed(1) + "%" : "—"}`);
  console.log(`  Blocked %:          ${period.blockedPercent != null ? period.blockedPercent.toFixed(1) + "%" : "—"}`);
  console.log(`  At Risk:            ${period.atRisk ? "YES (*)" : "No"}`);
  console.log(`  Mode:               ${period.mode}`);

  if (period.byDayOfWeek && Object.keys(period.byDayOfWeek).length > 0) {
    console.log("\n  ── By Day of Week ──");
    for (const [day, data] of Object.entries(period.byDayOfWeek)) {
      console.log(
        `  ${day.padEnd(10)}: ${data.avgBookedHours}h avg booked, ${data.daysWorked} days worked`
      );
    }
  }

  process.exit(0);
}

run().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
