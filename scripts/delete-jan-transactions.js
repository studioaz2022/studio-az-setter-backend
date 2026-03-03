/**
 * Delete Jan 1-26 transactions from both InstantDB and Supabase.
 */
require("dotenv").config();
const { init } = require("@instantdb/admin");
const { createClient } = require("@supabase/supabase-js");

const db = init({
  appId: "c72e7565-3bf0-47b5-a23d-57ef8afe65b3",
  adminToken: process.env.INSTANT_APP_ADMIN_TOKEN,
});
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const LIONEL_GHL_ID = "1kFG5FWdUDhXLUX46snG";

(async () => {
  // 1. Delete from InstantDB — records with paidAt before Jan 26
  console.log("=== InstantDB ===");
  const { serviceIncome } = await db.query({ serviceIncome: {} });
  const jan = serviceIncome.filter((r) => {
    const d = new Date(r.paidAt);
    return d < new Date("2026-01-26T00:00:00");
  });
  console.log(`Found ${jan.length} records before Jan 26`);

  if (jan.length > 0) {
    const txns = jan.map((r) => db.tx.serviceIncome[r.id].delete());
    await db.transact(txns);
    console.log(`Deleted ${jan.length} records from InstantDB`);
  }

  // 2. Delete from Supabase — Lionel's transactions with session_date before Jan 26
  console.log("\n=== Supabase ===");
  const { data: before, error: countErr } = await supabase
    .from("transactions")
    .select("id", { count: "exact" })
    .eq("artist_ghl_id", LIONEL_GHL_ID)
    .lt("session_date", "2026-01-26");

  if (countErr) {
    console.error("Count error:", countErr.message);
    return;
  }
  console.log(`Found ${before.length} Supabase transactions before Jan 26`);

  if (before.length > 0) {
    const { error: delErr } = await supabase
      .from("transactions")
      .delete()
      .eq("artist_ghl_id", LIONEL_GHL_ID)
      .lt("session_date", "2026-01-26");

    if (delErr) {
      console.error("Delete error:", delErr.message);
    } else {
      console.log(`Deleted ${before.length} transactions from Supabase`);
    }
  }

  console.log("\nDone.");
})();
