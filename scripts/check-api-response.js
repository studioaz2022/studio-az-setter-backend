const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

(async () => {
  // Simulate exactly what the API returns for a few transactions
  const { data } = await supabase
    .from("transactions")
    .select("*")
    .eq("artist_ghl_id", "1kFG5FWdUDhXLUX46snG")
    .order("created_at", { ascending: false })
    .limit(3);

  // Show the raw session_date and created_at formats
  data.forEach(tx => {
    console.log("contact_name:", tx.contact_name);
    console.log("  session_date (raw):", JSON.stringify(tx.session_date));
    console.log("  created_at (raw):", JSON.stringify(tx.created_at));
    console.log("  gross_amount:", tx.gross_amount);
    console.log("  service_price:", tx.service_price);
    console.log("  tip_amount:", tx.tip_amount);
    console.log();
  });

  // Also check: what does the JSON look like as the API would send it?
  const https = require("https");
  const url = "https://studio-az-setter-backend.onrender.com/api/artists/1kFG5FWdUDhXLUX46snG/earnings?locationId=GLRkNAxfPtWTqTiN83xj";
  
  https.get(url, (res) => {
    let body = "";
    res.on("data", (chunk) => body += chunk);
    res.on("end", () => {
      const parsed = JSON.parse(body);
      const txs = parsed.earnings?.transactions || [];
      console.log("API returns", txs.length, "transactions");
      
      // Show first 3 transactions' date fields
      txs.slice(0, 3).forEach(tx => {
        console.log("  " + tx.contact_name + " | session_date=" + tx.session_date + " | created_at=" + tx.created_at + " | gross=" + tx.gross_amount + " | svc=" + tx.service_price + " | tip=" + tx.tip_amount);
      });
      
      // Check if session_date is being sent as a Date string or date-only
      const feb = txs.filter(t => t.session_date && t.session_date.startsWith("2026-02"));
      console.log("\nFeb transactions in API response:", feb.length);
      if (feb.length > 0) {
        console.log("Sample Feb session_date format:", feb[0].session_date);
      }
    });
  });
})();
