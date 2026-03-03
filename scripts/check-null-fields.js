const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

(async () => {
  const { data } = await supabase
    .from("transactions")
    .select("id, contact_name, gross_amount, shop_percentage, artist_percentage, shop_amount, artist_amount, payment_method, payment_recipient, transaction_type, settlement_status, location_id, contact_id")
    .eq("artist_ghl_id", "1kFG5FWdUDhXLUX46snG")
    .limit(200);

  // Check for null values in non-optional fields
  const nonOptionalFields = ["gross_amount", "shop_percentage", "artist_percentage", "shop_amount", "artist_amount", "payment_method", "payment_recipient", "transaction_type", "settlement_status", "location_id", "contact_id"];
  
  for (const field of nonOptionalFields) {
    const nullCount = data.filter(t => t[field] === null || t[field] === undefined).length;
    if (nullCount > 0) {
      console.log("PROBLEM: " + field + " has " + nullCount + " null values");
      const examples = data.filter(t => t[field] === null || t[field] === undefined).slice(0, 3);
      examples.forEach(t => console.log("  -> " + t.contact_name + " (id: " + t.id + ")"));
    } else {
      console.log("OK: " + field + " — all non-null");
    }
  }
})();
