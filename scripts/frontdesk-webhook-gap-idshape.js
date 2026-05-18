/**
 * Front Desk Dashboard — Webhook Gap: ID shape of the missed rows (READ-ONLY)
 *
 * The 80 backfilled rows cluster on the generic "Appointment" calendar
 * (lijQ2ubF4UcrHxDwfzyK) and are mostly "Block"/"Break" titles — yet the
 * webhook DID persist hundreds of other rows on that same calendar. So the
 * misses are a SUBSET. This script asks: what is structurally different
 * about the IDs of the missed rows vs the ones that came through?
 *
 * GHL real appointment IDs are a single opaque 20-char token
 * (e.g. "gQk2...zP"). GHL blocked-time / recurring-availability slots use
 * a COMPOSITE id "<ownerId>_<epochMs>_<durationSec>" — these are generated
 * per occurrence and are NOT first-class appointment objects, so GHL does
 * NOT fire appointment.created/updated webhooks for them. The reconciler's
 * /calendars/events fetch returns them anyway, which is why a backfill
 * "finds" them but the live webhook never did.
 *
 *   node scripts/frontdesk-webhook-gap-idshape.js
 */

const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
const { BARBER_LOCATION_ID } = require("../src/config/kioskConfig");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Composite blocked-slot id: ownerId _ epochMs _ durationSeconds
const COMPOSITE_RE = /^[A-Za-z0-9]{15,}_\d{10,}_\d+$/;
const idKind = (id) =>
  !id ? "(no id)" : COMPOSITE_RE.test(id) ? "COMPOSITE (block slot)" : "opaque (real appt)";

function bump(m, k) {
  m[k] = (m[k] || 0) + 1;
}
function printCounts(title, m) {
  console.log(`\n  ${title}`);
  for (const [k, v] of Object.entries(m).sort((a, b) => b[1] - a[1]))
    console.log(`    ${String(v).padStart(4)}  ${k}`);
}

async function pullAll(ghlUserId) {
  const rows = [];
  let from = 0;
  const page = 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabase
      .from("appointments")
      .select("id, title, created_at, ghl_created_at")
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
const backfilled = (r) => String(r.created_at || "").slice(0, 10) === "2026-05-18";

async function analyze(name, ghlUserId) {
  const rows = await pullAll(ghlUserId);
  console.log(`\n${"=".repeat(74)}\n${name} (${ghlUserId})\n${"=".repeat(74)}`);

  for (const [label, set] of [
    ["BACKFILLED (webhook missed these)", rows.filter(backfilled)],
    ["WEBHOOK-written (pipeline worked)", rows.filter((r) => !backfilled(r))],
  ]) {
    const byKind = {};
    for (const r of set) bump(byKind, idKind(r.id));
    console.log(`\n${"-".repeat(74)}\n  ${label}: ${set.length}`);
    printCounts("by id shape:", byKind);
  }

  // Show the few opaque-id rows that were still backfilled — those are the
  // ones a webhook genuinely should have caught but didn't (the real,
  // smaller, residual question).
  const oddballs = rows
    .filter(backfilled)
    .filter((r) => idKind(r.id) === "opaque (real appt)");
  if (oddballs.length) {
    console.log(`\n  Backfilled rows with REAL (opaque) ids — genuine misses:`);
    for (const r of oddballs.slice(0, 12))
      console.log(
        `    id=${r.id} title=${JSON.stringify((r.title || "").slice(0, 32))} ` +
          `ghl_created_at=${r.ghl_created_at}`
      );
  }
}

(async () => {
  console.log("Webhook Gap — ID shape (READ-ONLY)");
  console.log("Run at:", new Date().toISOString());
  await analyze("Lionel Chavez", "1kFG5FWdUDhXLUX46snG");
  await analyze("Joshua Flores", "Dm20lBxWvG393LUoxuEV");
  process.exit(0);
})().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
