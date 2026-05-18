/**
 * Front Desk Dashboard — Webhook Gap: source-of-the-80 (READ-ONLY)
 *
 * The original gap (64 Lionel + 16 Joshua) was already healed by the
 * 2026-05-18 reconcile backfill, so a live GHL-vs-cache diff now shows
 * almost nothing. To find the ROOT CAUSE we instead look at the rows the
 * reconciler INSERTED on 2026-05-18 (their created_at clusters on that day)
 * and ask: what calendar_id were they on, and what were their titles?
 *
 * Hypothesis under test: the rows the live webhook never persisted are the
 * ones on calendars NOT present in kioskConfig BARBER_DATA — chiefly the
 * generic round-robin "Appointment" calendar lijQ2ubF4UcrHxDwfzyK that
 * holds blocked-time / breaks / manual blocks. If true, the gap is not a
 * handler bug and not a per-barber problem — it's "which calendars fire
 * the GHL workflow that calls /webhooks/ghl/appointments".
 *
 *   node scripts/frontdesk-webhook-gap-source.js
 */

const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
const { BARBER_DATA, BARBER_LOCATION_ID } = require("../src/config/kioskConfig");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CAL_LABEL = {};
for (const b of BARBER_DATA) {
  for (const [svc, calId] of Object.entries(b.calendars || {})) {
    CAL_LABEL[calId] = `${b.name.split(" ")[0]} / ${svc}`;
  }
}
const inKiosk = (id) => Boolean(CAL_LABEL[id]);
const calLabel = (id) =>
  !id
    ? "(no calendar_id)"
    : CAL_LABEL[id]
    ? `${id} [${CAL_LABEL[id]}]`
    : `${id} [NOT in kioskConfig]`;

function bump(m, k) {
  m[k] = (m[k] || 0) + 1;
}
function printCounts(title, m) {
  console.log(`\n  ${title}`);
  const e = Object.entries(m).sort((a, b) => b[1] - a[1]);
  if (!e.length) return console.log("    (none)");
  for (const [k, v] of e) console.log(`    ${String(v).padStart(4)}  ${k}`);
}

async function pullAll(ghlUserId) {
  const rows = [];
  let from = 0;
  const page = 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabase
      .from("appointments")
      .select("id, calendar_id, status, title, start_time, created_at, ghl_created_at")
      .eq("location_id", BARBER_LOCATION_ID)
      .eq("assigned_user_id", ghlUserId)
      .range(from, from + page - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < page) break;
    from += page;
  }
  return rows;
}

// The backfill ran 2026-05-18. Rows it inserted have created_at on that
// UTC day. Webhook-written rows were created whenever the booking happened.
function createdOnBackfillDay(iso) {
  if (!iso) return false;
  return String(iso).slice(0, 10) === "2026-05-18";
}

async function analyze(name, ghlUserId) {
  const rows = await pullAll(ghlUserId);
  const backfilled = rows.filter((r) => createdOnBackfillDay(r.created_at));
  const webhookWritten = rows.filter((r) => !createdOnBackfillDay(r.created_at));

  console.log(`\n${"=".repeat(74)}`);
  console.log(`${name} (${ghlUserId})`);
  console.log("=".repeat(74));
  console.log(
    `Total cached rows: ${rows.length} | created on backfill day 2026-05-18: ` +
      `${backfilled.length} | created other days (webhook): ${webhookWritten.length}`
  );

  // Split each cohort by whether its calendar is in kioskConfig.
  for (const [label, set] of [
    ["BACKFILLED rows (webhook MISSED these)", backfilled],
    ["WEBHOOK-written rows (pipeline worked)", webhookWritten],
  ]) {
    const byCal = {};
    const byInKiosk = { "in kioskConfig": 0, "NOT in kioskConfig": 0 };
    const byTitle = {};
    const byStatus = {};
    for (const r of set) {
      bump(byCal, calLabel(r.calendar_id));
      bump(byInKiosk, inKiosk(r.calendar_id) ? "in kioskConfig" : "NOT in kioskConfig");
      const t = (r.title || "").trim();
      bump(byTitle, !t ? "(empty)" : /block|break|busy|lunch|off/i.test(t) ? "block/break-ish" : "client/service");
      bump(byStatus, r.status || "(none)");
    }
    console.log(`\n${"-".repeat(74)}\n  ${label}: ${set.length}`);
    printCounts("split: calendar in kioskConfig BARBER_DATA?", byInKiosk);
    printCounts("by calendar_id:", byCal);
    printCounts("by title type:", byTitle);
    printCounts("by status:", byStatus);
  }
}

(async () => {
  console.log("Webhook Gap — source of the 80 (READ-ONLY)");
  console.log("Run at:", new Date().toISOString());
  await analyze("Lionel Chavez", "1kFG5FWdUDhXLUX46snG");
  await analyze("Joshua Flores", "Dm20lBxWvG393LUoxuEV");
  await analyze("Drew Smith (control — should have ~0 backfilled)", "zKiZ5w3ImX0bA7zrFIZx");
  process.exit(0);
})().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
