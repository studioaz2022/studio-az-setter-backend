// Backfill tattoo_projects with executed rows from Square-fed transactions
// (TATTOO_PROJECT_HISTORY_PLAN.md §10 Phase 4 / §12).
//
// One row per session_payment — the same convention financialTracking.js uses
// to count completedTattoos. Backfilled rows carry transactional facts only
// (date, price, deposit); idea fields stay null (we can't reconstruct what a
// past tattoo looked like from payments).
//
// Usage: node scripts/backfill-tattoo-projects.js [--live]
//   default = DRY RUN (prints report, writes nothing)

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { supabase } = require("../src/clients/supabaseClient");

const TATTOO_LOCATION_ID = "mUemx2jG4wly4kJWBkI4";
// Designated test records — never backfill.
const EXCLUDED_CONTACTS = new Set([
  "cx8QkqBYM13LnXkOvnQl", // Jose (tattoo test contact)
  "H3NamSlW7XAiF7WVUUo8", // front-desk test contact
]);

const LIVE = process.argv.includes("--live");

(async () => {
  if (!supabase) throw new Error("Supabase not initialized");

  // 1. All tattoo-location transactions
  const { data: txs, error } = await supabase
    .from("transactions")
    .select("contact_id, contact_name, location_id, transaction_type, gross_amount, session_date, created_at")
    .eq("location_id", TATTOO_LOCATION_ID);
  if (error) throw error;

  // 2. Contacts that already have executed rows (idempotency)
  const { data: existing } = await supabase
    .from("tattoo_projects")
    .select("contact_id")
    .eq("executed", true);
  const alreadyDone = new Set((existing || []).map((r) => r.contact_id));

  // 3. Group session payments per contact
  const byContact = new Map();
  for (const tx of txs || []) {
    if (!tx.contact_id || tx.transaction_type !== "session_payment") continue;
    if (EXCLUDED_CONTACTS.has(tx.contact_id)) continue;
    if (alreadyDone.has(tx.contact_id)) continue;
    if (!byContact.has(tx.contact_id)) byContact.set(tx.contact_id, []);
    byContact.get(tx.contact_id).push(tx);
  }

  // 4. Build rows: one per session payment, project_number by date order
  const rows = [];
  for (const [contactId, sessions] of byContact) {
    sessions.sort((a, b) => new Date(a.session_date || a.created_at) - new Date(b.session_date || b.created_at));
    sessions.forEach((tx, i) => {
      const when = new Date(tx.session_date || tx.created_at).toISOString();
      rows.push({
        contact_id: contactId,
        location_id: TATTOO_LOCATION_ID,
        project_number: i + 1,
        status: "completed",
        executed: true,
        executed_at: when,
        final_price: parseFloat(tx.gross_amount) || null,
        source: "backfill",
        closed_at: when,
      });
    });
  }

  // 5. Report
  console.log(`Mode: ${LIVE ? "LIVE INSERT" : "DRY RUN"}`);
  console.log(`Tattoo-location transactions: ${(txs || []).length}`);
  console.log(`Contacts with session payments (new to backfill): ${byContact.size}`);
  console.log(`Rows to insert: ${rows.length}`);
  console.log(`Contacts skipped (already have executed rows): ${alreadyDone.size}`);
  const sample = rows.slice(0, 5);
  console.log("Sample rows:", JSON.stringify(sample, null, 1));
  const multi = [...byContact.entries()].filter(([, s]) => s.length > 1);
  console.log(`Repeat clients (2+ sessions): ${multi.length}`);

  if (!LIVE) {
    console.log("\nDry run complete — re-run with --live to insert.");
    process.exit(0);
  }

  // 6. Insert in chunks
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const { error: insErr } = await supabase.from("tattoo_projects").insert(chunk);
    if (insErr) {
      console.error(`Insert failed at chunk ${i / 100}:`, insErr.message);
      process.exit(1);
    }
    inserted += chunk.length;
  }
  console.log(`\nInserted ${inserted} executed rows.`);

  // 7. Verify counts match
  const { count } = await supabase
    .from("tattoo_projects")
    .select("*", { count: "exact", head: true })
    .eq("source", "backfill");
  console.log(`Verify: rows with source=backfill in table: ${count}`);
  process.exit(0);
})().catch((e) => {
  console.error("BACKFILL ERROR:", e.message);
  process.exit(1);
});
