const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

(async () => {
  const BARBER_GHL_ID = "1kFG5FWdUDhXLUX46snG";

  const { data: all, error } = await supabase
    .from("transactions")
    .select("id, contact_name, gross_amount, service_price, tip_amount, session_date, created_at, square_payment_id, appointment_id, contact_id, transaction_type, payment_method")
    .eq("artist_ghl_id", BARBER_GHL_ID)
    .order("session_date", { ascending: false });

  if (error) { console.error("Error:", error); return; }

  console.log("Total transactions for Lionel:", all.length);

  console.log("\nBy payment_method:");
  const byMethod = {};
  all.forEach(t => { byMethod[t.payment_method || "null"] = (byMethod[t.payment_method || "null"] || 0) + 1; });
  console.log(byMethod);

  console.log("\nBy transaction_type:");
  const byType = {};
  all.forEach(t => { byType[t.transaction_type || "null"] = (byType[t.transaction_type || "null"] || 0) + 1; });
  console.log(byType);

  console.log("\nBy session_date:");
  const byDate = {};
  all.forEach(t => { byDate[t.session_date || "null"] = (byDate[t.session_date || "null"] || 0) + 1; });
  Object.keys(byDate).sort().reverse().forEach(d => console.log("  " + d + ": " + byDate[d]));

  console.log("\nAll transactions:");
  all.forEach(t => {
    console.log("  " + t.session_date + " | $" + t.gross_amount + " | " + (t.contact_name || "unnamed") + " | type:" + t.transaction_type + " | method:" + t.payment_method + " | sqid:" + (t.square_payment_id ? t.square_payment_id.slice(0, 10) + "..." : "none") + " | apt:" + (t.appointment_id ? "yes" : "no"));
  });

  // Also check: are there transactions with a different artist_ghl_id or null?
  const { data: otherArtist, error: e2 } = await supabase
    .from("transactions")
    .select("artist_ghl_id")
    .not("artist_ghl_id", "eq", BARBER_GHL_ID);

  if (!e2) {
    const byArtist = {};
    otherArtist.forEach(t => { byArtist[t.artist_ghl_id || "null"] = (byArtist[t.artist_ghl_id || "null"] || 0) + 1; });
    console.log("\nOther artist_ghl_ids in DB:", byArtist);
  }
})();
