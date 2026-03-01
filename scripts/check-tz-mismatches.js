const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

(async () => {
  // Karl Harmston
  const { data: karl } = await supabase.from("transactions")
    .select("contact_name, session_date, square_payment_time, appointment_id, transaction_type")
    .ilike("contact_name", "%karl%");
  console.log("=== Karl Harmston ===");
  (karl || []).forEach(t => console.log("  session_date:", t.session_date, "| sq_time:", t.square_payment_time, "| apt:", t.appointment_id, "| type:", t.transaction_type));

  // Ivan Gil
  const { data: ivan } = await supabase.from("transactions")
    .select("contact_name, session_date, square_payment_time, appointment_id, transaction_type")
    .ilike("contact_name", "%ivan gil%");
  console.log("\n=== Ivan Gil ===");
  (ivan || []).forEach(t => console.log("  session_date:", t.session_date, "| sq_time:", t.square_payment_time, "| apt:", t.appointment_id, "| type:", t.transaction_type));

  // Count mismatches: session_date (UTC) vs local date (Central, UTC-6)
  const { data: all } = await supabase.from("transactions")
    .select("contact_name, session_date, square_payment_time")
    .not("square_payment_time", "is", null);

  let mismatches = [];
  (all || []).forEach(t => {
    const utc = new Date(t.square_payment_time);
    // Feb = CST (UTC-6)
    const centralDate = new Date(utc.getTime() - 6 * 60 * 60 * 1000);
    const localDateStr = centralDate.toISOString().slice(0, 10);
    if (t.session_date !== localDateStr) {
      mismatches.push(t);
    }
  });

  console.log("\n=== DATE MISMATCHES (session_date != Central local date) ===");
  mismatches.forEach(t => {
    const utc = new Date(t.square_payment_time);
    const central = new Date(utc.getTime() - 6 * 60 * 60 * 1000);
    console.log("  " + t.contact_name + " | session_date: " + t.session_date + " | local: " + central.toISOString().slice(0, 10) + " | UTC: " + t.square_payment_time);
  });
  console.log("\nTotal mismatched:", mismatches.length, "/", (all || []).length);
})();
