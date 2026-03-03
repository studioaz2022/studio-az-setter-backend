const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

(async () => {
  const BARBER_GHL_ID = "1kFG5FWdUDhXLUX46snG";

  const { data, error } = await supabase
    .from("transactions")
    .select("id, location_id, contact_name, session_date")
    .eq("artist_ghl_id", BARBER_GHL_ID)
    .order("session_date", { ascending: false })
    .limit(10);

  if (error) { console.error(error); return; }

  console.log("Sample transactions (location_id values):");
  data.forEach(t => console.log("  " + t.session_date + " | " + (t.contact_name || "unnamed") + " | location_id: " + JSON.stringify(t.location_id)));

  // Count by location_id
  const { data: all } = await supabase
    .from("transactions")
    .select("location_id")
    .eq("artist_ghl_id", BARBER_GHL_ID);

  const byLoc = {};
  all.forEach(t => { byLoc[t.location_id || "NULL"] = (byLoc[t.location_id || "NULL"] || 0) + 1; });
  console.log("\nAll Lionel transactions by location_id:", byLoc);

  // Check what locationId the barbershop brand maps to
  console.log("\nExpected barbershop location_id: GLRkNAxfPtWTqTiN83xj");
})();
