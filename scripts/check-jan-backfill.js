// Clean up all backfill data (Jan 1 – now) for barber, then verify clean slate
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const BARBER_GHL_ID = "1kFG5FWdUDhXLUX46snG";
const START = "2026-01-01";

(async () => {
  // 1. Count transactions
  const { count: txCount } = await supabase
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .eq("artist_ghl_id", BARBER_GHL_ID)
    .gte("session_date", START);
  console.log("Transactions to delete (Jan 1+): " + txCount);

  // 2. Delete transactions
  if (txCount > 0) {
    const { error, count: deleted } = await supabase
      .from("transactions")
      .delete({ count: "exact" })
      .eq("artist_ghl_id", BARBER_GHL_ID)
      .gte("session_date", START);
    if (error) console.error("Transaction delete failed:", error.message);
    else console.log("Deleted " + deleted + " transactions.");
  }

  // 3. Count appointments
  const { count: aptCount } = await supabase
    .from("appointments")
    .select("id", { count: "exact", head: true })
    .eq("assigned_user_id", BARBER_GHL_ID)
    .gte("start_time", START + "T00:00:00Z");
  console.log("Appointments to delete (Jan 1+): " + aptCount);

  // 4. Delete appointments
  if (aptCount > 0) {
    const { error, count: deleted } = await supabase
      .from("appointments")
      .delete({ count: "exact" })
      .eq("assigned_user_id", BARBER_GHL_ID)
      .gte("start_time", START + "T00:00:00Z");
    if (error) console.error("Appointment delete failed:", error.message);
    else console.log("Deleted " + deleted + " appointments.");
  }

  // 5. Verify clean slate
  const { count: txRemain } = await supabase
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .eq("artist_ghl_id", BARBER_GHL_ID)
    .gte("session_date", START);
  const { count: aptRemain } = await supabase
    .from("appointments")
    .select("id", { count: "exact", head: true })
    .eq("assigned_user_id", BARBER_GHL_ID)
    .gte("start_time", START + "T00:00:00Z");
  console.log("\n--- VERIFICATION ---");
  console.log("Transactions remaining (Jan 1+): " + txRemain);
  console.log("Appointments remaining (Jan 1+): " + aptRemain);
  console.log(txRemain === 0 && aptRemain === 0 ? "Clean slate ready for backfill." : "WARNING: Data still exists!");
})();
