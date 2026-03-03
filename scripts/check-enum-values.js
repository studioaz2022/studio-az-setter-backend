const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

(async () => {
  const { data } = await supabase
    .from("transactions")
    .select("transaction_type, payment_method, payment_recipient, settlement_status")
    .eq("artist_ghl_id", "1kFG5FWdUDhXLUX46snG");

  const fields = ["transaction_type", "payment_method", "payment_recipient", "settlement_status"];
  for (const field of fields) {
    const values = {};
    data.forEach(t => { values[t[field] || "null"] = (values[t[field] || "null"] || 0) + 1; });
    console.log(field + ":", JSON.stringify(values));
  }
})();
