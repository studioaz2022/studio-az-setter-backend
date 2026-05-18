/**
 * Front Desk Dashboard — Phase 0.1 verification (READ-ONLY)
 *
 * Answers: do BOTH locations' calendars actually flow into the Supabase
 * `appointments` cache, and is the data fresh enough for a live dashboard?
 *
 * For each location (barbershop + tattoo) and each roster member:
 *   - count cached appointments (all-time + upcoming/recent window)
 *   - newest ghl_updated_at  -> how stale is the freshest write
 *   - newest row by created_at -> recent webhook activity
 *
 * Does NOT write anything. Safe to run anytime.
 *
 *   node scripts/frontdesk-verify-cache-coverage.js
 */

const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const {
  BARBER_DATA,
  BARBER_LOCATION_ID,
  TATTOO_ARTIST_DATA,
  TATTOO_LOCATION_ID,
} = require("../src/config/kioskConfig");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function fmtAge(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "future";
  const min = Math.floor(ms / 60000);
  if (min < 60) return min + "m ago";
  const hr = Math.floor(min / 60);
  if (hr < 48) return hr + "h ago";
  return Math.floor(hr / 24) + "d ago";
}

async function staffStats(locationId, ghlUserId) {
  // All-time count for this staffer at this location
  const { count: total, error: e1 } = await supabase
    .from("appointments")
    .select("id", { count: "exact", head: true })
    .eq("location_id", locationId)
    .eq("assigned_user_id", ghlUserId);
  if (e1) throw e1;

  // Newest by ghl_updated_at (freshness of GHL-sourced data)
  const { data: freshGhl } = await supabase
    .from("appointments")
    .select("id, ghl_updated_at, start_time, status")
    .eq("location_id", locationId)
    .eq("assigned_user_id", ghlUserId)
    .not("ghl_updated_at", "is", null)
    .order("ghl_updated_at", { ascending: false })
    .limit(1);

  // Newest by created_at (when our webhook/backfill wrote the row)
  const { data: freshRow } = await supabase
    .from("appointments")
    .select("id, created_at")
    .eq("location_id", locationId)
    .eq("assigned_user_id", ghlUserId)
    .order("created_at", { ascending: false })
    .limit(1);

  // Upcoming appointments (today forward) — what the grid will actually show
  const todayIso = new Date(new Date().toISOString().slice(0, 10)).toISOString();
  const { count: upcoming } = await supabase
    .from("appointments")
    .select("id", { count: "exact", head: true })
    .eq("location_id", locationId)
    .eq("assigned_user_id", ghlUserId)
    .gte("start_time", todayIso);

  return {
    total: total || 0,
    upcoming: upcoming || 0,
    newestGhlUpdated: freshGhl && freshGhl[0] ? freshGhl[0].ghl_updated_at : null,
    newestRowCreated: freshRow && freshRow[0] ? freshRow[0].created_at : null,
  };
}

async function verifyLocation(label, locationId, roster) {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`${label}  (location_id: ${locationId})`);
  console.log("=".repeat(72));

  // Location-wide totals
  const { count: locTotal } = await supabase
    .from("appointments")
    .select("id", { count: "exact", head: true })
    .eq("location_id", locationId);
  console.log(`Total cached appointments at this location: ${locTotal || 0}\n`);

  const { data: locFresh } = await supabase
    .from("appointments")
    .select("ghl_updated_at")
    .eq("location_id", locationId)
    .not("ghl_updated_at", "is", null)
    .order("ghl_updated_at", { ascending: false })
    .limit(1);
  console.log(
    `Freshest ghl_updated_at anywhere in this location: ${
      locFresh && locFresh[0]
        ? locFresh[0].ghl_updated_at + " (" + fmtAge(locFresh[0].ghl_updated_at) + ")"
        : "NONE"
    }\n`
  );

  console.log(
    "Staff".padEnd(20) +
      "Total".padStart(8) +
      "Upcoming".padStart(10) +
      "  Newest GHL-update".padEnd(24) +
      "Newest row written"
  );
  console.log("-".repeat(72));

  const gaps = [];
  for (const s of roster) {
    let st;
    try {
      st = await staffStats(locationId, s.ghlUserId);
    } catch (err) {
      console.log(`${s.name.padEnd(20)}  ERROR: ${err.message}`);
      continue;
    }
    const line =
      s.name.padEnd(20) +
      String(st.total).padStart(8) +
      String(st.upcoming).padStart(10) +
      ("  " + fmtAge(st.newestGhlUpdated)).padEnd(24) +
      fmtAge(st.newestRowCreated);
    console.log(line);

    if (st.total === 0) gaps.push(`${s.name} — ZERO cached appointments (calendar may not be subscribed)`);
    else if (st.upcoming === 0) gaps.push(`${s.name} — has history but ZERO upcoming (webhook may have stopped, or no future bookings)`);
  }

  console.log("-".repeat(72));
  if (gaps.length === 0) {
    console.log("✅ Every roster member has cached + upcoming appointments.");
  } else {
    console.log("⚠️  Coverage gaps to investigate:");
    gaps.forEach((g) => console.log("   • " + g));
  }
  return gaps;
}

(async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env");
    process.exit(1);
  }

  console.log("Front Desk Dashboard — cache coverage verification (read-only)");
  console.log("Run at: " + new Date().toISOString());

  const barberGaps = await verifyLocation(
    "BARBERSHOP",
    BARBER_LOCATION_ID,
    BARBER_DATA
  );
  const tattooGaps = await verifyLocation(
    "TATTOO SHOP",
    TATTOO_LOCATION_ID,
    TATTOO_ARTIST_DATA
  );

  console.log(`\n${"=".repeat(72)}`);
  console.log("VERDICT");
  console.log("=".repeat(72));
  console.log(
    `Barbershop: ${barberGaps.length === 0 ? "FULL coverage ✅" : barberGaps.length + " gap(s) ⚠️"}`
  );
  console.log(
    `Tattoo shop: ${tattooGaps.length === 0 ? "FULL coverage ✅" : tattooGaps.length + " gap(s) ⚠️"}`
  );
  console.log(
    "\nInterpretation: 'Newest GHL-update' age tells you how live the cache is. " +
      "If it's minutes/hours, webhooks are flowing. If it's days+ for an active " +
      "barber, that calendar likely isn't subscribed to /webhooks/ghl/appointments."
  );
  process.exit(0);
})().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
