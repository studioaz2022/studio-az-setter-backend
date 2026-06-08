/**
 * Front Desk — Phase 0.1 follow-up (READ-ONLY)
 * Full (paginated) scan of off-roster barbershop assigned_user_ids.
 * These have appointments in the cache but no column in the grid roster.
 */
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { fetchAllRows } = require("../src/clients/supabaseClient");
const { BARBER_LOCATION_ID } = require("../src/config/kioskConfig");

(async () => {
  const { data } = await fetchAllRows(
    supabase
      .from("appointments")
      .select("assigned_user_id, title, start_time, status, ghl_updated_at")
      .eq("location_id", BARBER_LOCATION_ID)
  );
  const ROSTER = new Set([
    "1kFG5FWdUDhXLUX46snG", "zKiZ5w3ImX0bA7zrFIZx", "XrbRTwVGMwgcGOgD2a5n",
    "sLkO5CwFrhdcM7EOtTvg", "47m7vgAy8cwELwCBE3LT", "Dm20lBxWvG393LUoxuEV",
    "GBzpanPloybTcnPEIzpE", "F6m7GBKeyIRcehYkubfe",
  ]);
  const off = {};
  data.forEach((r) => {
    const u = r.assigned_user_id || "(null)";
    if (!ROSTER.has(u)) (off[u] = off[u] || []).push(r);
  });
  console.log("Total barbershop rows scanned:", data.length);
  console.log("\nOff-roster user IDs (would be INVISIBLE in the grid):");
  Object.entries(off)
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([u, rows]) => {
      const upcoming = rows.filter((r) => new Date(r.start_time) >= new Date()).length;
      const newest = rows.map((r) => r.ghl_updated_at).filter(Boolean).sort().pop();
      console.log(`\n  ${u}  —  ${rows.length} rows, ${upcoming} upcoming, newest update ${newest || "?"}`);
      rows
        .sort((a, b) => new Date(b.start_time) - new Date(a.start_time))
        .slice(0, 3)
        .forEach((r) => console.log(`     "${(r.title || "").slice(0, 50)}"  ${r.start_time}  ${r.status}`));
    });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
