const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

(async () => {
  const BARBER_GHL_ID = "1kFG5FWdUDhXLUX46snG";

  // Simulate what the earnings endpoint does — no date filter (allTime)
  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("artist_ghl_id", BARBER_GHL_ID)
    .order("session_date", { ascending: false });

  if (error) { console.error("Error:", error); return; }
  console.log("All-time transactions:", data.length);

  // Check: how many have session_date in 2026?
  const y2026 = data.filter(t => t.session_date && t.session_date.startsWith("2026"));
  console.log("2026 transactions:", y2026.length);

  // Check March 2026 specifically (current month based on user saying "for the year" might mean YTD)
  const march = data.filter(t => t.session_date && t.session_date.startsWith("2026-03"));
  console.log("March 2026 transactions:", march.length);
  march.forEach(t => console.log("  " + t.session_date + " | $" + t.gross_amount + " | " + t.contact_name));

  // Maybe the issue is the fetched artist_ghl_id — check if BarberFinanceView uses the right ID
  // Let's also check: are there "Lionel" or "Chavez" transactions with a DIFFERENT artist_ghl_id?
  const { data: byName } = await supabase
    .from("transactions")
    .select("id, artist_ghl_id, contact_name")
    .or("contact_name.ilike.%lionel%,contact_name.ilike.%chavez%");
  
  console.log("\nTransactions with 'lionel' or 'chavez' in contact_name:", byName?.length || 0);
  if (byName && byName.length > 0) {
    byName.forEach(t => console.log("  " + t.contact_name + " | artist:" + t.artist_ghl_id));
  }

  // Check the barber_square_tokens to understand the sync state
  const { data: tokens } = await supabase
    .from("barber_square_tokens")
    .select("barber_ghl_id, last_synced_at, location_id");
  
  console.log("\nBarber Square tokens:", JSON.stringify(tokens, null, 2));
})();
