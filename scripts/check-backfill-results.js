// Check what the backfill actually saved to Supabase
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const BARBER_GHL_ID = "1kFG5FWdUDhXLUX46snG";

(async () => {
  // Count by transaction_type
  const { data: all } = await supabase
    .from("transactions")
    .select("id, transaction_type, contact_name, amount, session_date")
    .eq("artist_ghl_id", BARBER_GHL_ID)
    .gte("session_date", "2026-01-01")
    .order("session_date", { ascending: true });

  const byType = {};
  for (const tx of all || []) {
    const t = tx.transaction_type || "unknown";
    if (!byType[t]) byType[t] = [];
    byType[t].push(tx);
  }

  console.log("=== Transactions saved to Supabase (Jan 1+) ===");
  console.log("Total:", (all || []).length);
  for (const [type, txs] of Object.entries(byType)) {
    console.log(`\n${type}: ${txs.length}`);
    // Show first 3 of each type
    for (const tx of txs.slice(0, 3)) {
      console.log(`  $${tx.amount} | ${tx.contact_name} | ${tx.session_date}`);
    }
    if (txs.length > 3) console.log(`  ... and ${txs.length - 3} more`);
  }
})();
