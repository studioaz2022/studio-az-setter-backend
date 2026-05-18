/**
 * Front Desk — Phase 0.1 follow-up (READ-ONLY)
 * Dig into the tattoo location + Gilberto to decide if the "gaps" are real
 * coverage problems or just low volume.
 */
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { TATTOO_LOCATION_ID, BARBER_LOCATION_ID } = require("../src/config/kioskConfig");

function age(iso) {
  if (!iso) return "—";
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d < 0 ? "future" : d + "d ago";
}

(async () => {
  // 1) ALL tattoo appointments regardless of assigned_user_id — is the roster filter hiding rows?
  const { data: tat, error } = await supabase
    .from("appointments")
    .select("id, assigned_user_id, calendar_id, start_time, status, ghl_updated_at, created_at")
    .eq("location_id", TATTOO_LOCATION_ID)
    .order("ghl_updated_at", { ascending: false });
  if (error) throw error;

  console.log("=== TATTOO LOCATION — all rows (any assigned_user_id) ===");
  console.log("Total rows:", tat.length);
  const byUser = {};
  const byCal = {};
  let nullUser = 0;
  tat.forEach((r) => {
    const u = r.assigned_user_id || "(null)";
    byUser[u] = (byUser[u] || 0) + 1;
    byCal[r.calendar_id || "(null)"] = (byCal[r.calendar_id || "(null)"] || 0) + 1;
    if (!r.assigned_user_id) nullUser++;
  });
  console.log("Rows with NULL assigned_user_id:", nullUser);
  console.log("\nBy assigned_user_id:");
  Object.entries(byUser).sort((a, b) => b[1] - a[1]).forEach(([u, c]) => console.log("  " + u + ": " + c));
  console.log("\nBy calendar_id:");
  Object.entries(byCal).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => console.log("  " + c + ": " + n));
  console.log("\nMost recent 8 tattoo rows:");
  tat.slice(0, 8).forEach((r) =>
    console.log(`  ${r.start_time}  upd=${age(r.ghl_updated_at)}  status=${r.status}  cal=${r.calendar_id}`)
  );
  const upcomingTat = tat.filter((r) => new Date(r.start_time) >= new Date()).length;
  console.log("\nUpcoming tattoo appts (any user):", upcomingTat);

  // 2) Gilberto — look at his actual rows
  const GIL = "F6m7GBKeyIRcehYkubfe";
  const { data: gil } = await supabase
    .from("appointments")
    .select("id, start_time, status, ghl_updated_at, calendar_id")
    .eq("location_id", BARBER_LOCATION_ID)
    .eq("assigned_user_id", GIL)
    .order("start_time", { ascending: false })
    .limit(8);
  console.log("\n=== GILBERTO CASTRO — most recent 8 rows ===");
  (gil || []).forEach((r) =>
    console.log(`  ${r.start_time}  status=${r.status}  upd=${age(r.ghl_updated_at)}`)
  );

  // 3) Barbershop: any rows with NULL or off-roster assigned_user_id we'd miss in the grid?
  const { data: barbAll } = await supabase
    .from("appointments")
    .select("assigned_user_id")
    .eq("location_id", BARBER_LOCATION_ID);
  const barbByUser = {};
  let barbNull = 0;
  (barbAll || []).forEach((r) => {
    if (!r.assigned_user_id) barbNull++;
    else barbByUser[r.assigned_user_id] = (barbByUser[r.assigned_user_id] || 0) + 1;
  });
  console.log("\n=== BARBERSHOP — assigned_user_id distribution ===");
  console.log("Rows with NULL assigned_user_id:", barbNull, "of", (barbAll || []).length);
  const ROSTER = new Set([
    "1kFG5FWdUDhXLUX46snG","zKiZ5w3ImX0bA7zrFIZx","XrbRTwVGMwgcGOgD2a5n","sLkO5CwFrhdcM7EOtTvg",
    "47m7vgAy8cwELwCBE3LT","Dm20lBxWvG393LUoxuEV","m0i0Q9vfa2YTmxLrrriK","GBzpanPloybTcnPEIzpE",
    "F6m7GBKeyIRcehYkubfe",
  ]);
  const offRoster = Object.entries(barbByUser).filter(([u]) => !ROSTER.has(u));
  console.log("Off-roster assigned_user_ids (would NOT show in grid):");
  if (offRoster.length === 0) console.log("  none");
  else offRoster.sort((a,b)=>b[1]-a[1]).forEach(([u, c]) => console.log("  " + u + ": " + c));

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
