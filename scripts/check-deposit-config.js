// Check what deposit amounts the system knows about
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

(async () => {
  const { data } = await supabase
    .from("barber_service_prices")
    .select("calendar_id, price, deposit_percentage");

  console.log("=== Service Prices & Deposit Config ===");
  const knownDeposits = new Set();
  for (const row of data || []) {
    const pct = row.deposit_percentage;
    const price = parseFloat(row.price);
    if (pct) {
      const depositAmt = Math.round(price * (pct / 100));
      knownDeposits.add(depositAmt);
      console.log(`Calendar ${row.calendar_id}: price=$${price}, deposit=${pct}% = $${depositAmt}`);
    } else {
      console.log(`Calendar ${row.calendar_id}: price=$${price}, NO deposit`);
    }
  }
  console.log("\nKnown deposit amounts:", [...knownDeposits]);
})();
