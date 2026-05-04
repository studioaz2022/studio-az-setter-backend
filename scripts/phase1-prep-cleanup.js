#!/usr/bin/env node
/**
 * Phase 1 prep cleanup: align tattoo transactions table with the new 30/70
 * default and remove old test/seed data.
 *
 * Actions (in order):
 *   1. Update artist_commission_rates: Andrew + Claudia → 30/70 (Joan already 30/70)
 *   2. Fix 3 real recent transactions: set artist_ghl_id = Andrew, splits = 30/70
 *      - Amelia Cervantes deposit
 *      - Joseph Keomanyvong session_payment
 *      - Jeff Skibitsky deposit (current artist_ghl_id is the calendar string
 *        "Soonest Available", a separate upstream bug)
 *   3. Delete 14 Jan 2026 test/seed rows (Sarah Johnson, Emma Williams,
 *      Michael Chen, Jessica Brown, Render Test User 2, David Martinez)
 *   4. Skip 7 anonymous Square tips (will be handled in a separate dedup pass)
 *
 * Run: node scripts/phase1-prep-cleanup.js [--dry-run]
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const DRY_RUN = process.argv.includes("--dry-run");
const TATTOO_LOCATION_ID = "mUemx2jG4wly4kJWBkI4";
const ANDREW_GHL_ID = "O8ChoMYj1BmMWJJsDlvC";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const TEST_NAMES = new Set([
  "Sarah Johnson",
  "Emma Williams",
  "Michael Chen",
  "Jessica Brown",
  "Render Test User 2",
  "David Martinez",
]);

const REAL_RECENT_NAMES = new Set([
  "Amelia Cervantes",
  "Joseph Keomanyvong",
  "Jeff Skibitsky",
]);

async function loadTattooTransactions() {
  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("location_id", TATTOO_LOCATION_ID)
    .order("session_date", { ascending: false });
  if (error) throw new Error(`Load failed: ${error.message}`);
  return data;
}

async function step1UpdateRates(report) {
  const updates = [
    { artist_ghl_id: ANDREW_GHL_ID, name: "Andrew" },
    { artist_ghl_id: "Wl24x1ZrucHuHatM0ODD", name: "Claudia" },
  ];

  for (const u of updates) {
    if (DRY_RUN) {
      report.rateUpdates.push({ ...u, would_set: "30/70", dry: true });
      console.log(`  [dry] ${u.name}: would set 30/70`);
      continue;
    }
    const { error } = await supabase
      .from("artist_commission_rates")
      .update({
        shop_percentage: 30,
        artist_percentage: 70,
        updated_at: new Date().toISOString(),
      })
      .eq("artist_ghl_id", u.artist_ghl_id)
      .eq("location_id", TATTOO_LOCATION_ID)
      .is("effective_to", null);

    if (error) {
      report.errors.push({ step: "rates", name: u.name, error: error.message });
      console.error(`  ❌ ${u.name}: ${error.message}`);
    } else {
      report.rateUpdates.push({ ...u, set: "30/70" });
      console.log(`  ✅ ${u.name}: 30/70`);
    }
  }
}

async function step2FixRealTransactions(rows, report) {
  const targets = rows.filter((r) => REAL_RECENT_NAMES.has((r.contact_name || "").trim()));
  for (const r of targets) {
    const gross = Number(r.gross_amount);
    const newShop = Math.round(gross * 0.30 * 100) / 100;
    const newArtist = Math.round(gross * 0.70 * 100) / 100;

    const before = {
      id: r.id,
      name: r.contact_name,
      gross,
      shop_pct: r.shop_percentage,
      artist_pct: r.artist_percentage,
      shop_amount: r.shop_amount,
      artist_amount: r.artist_amount,
      artist_ghl_id: r.artist_ghl_id,
    };

    if (DRY_RUN) {
      report.txFixes.push({
        ...before,
        would_set: { artist_ghl_id: ANDREW_GHL_ID, shop_pct: 30, artist_pct: 70, shop_amount: newShop, artist_amount: newArtist },
        dry: true,
      });
      console.log(`  [dry] ${r.contact_name} ${r.transaction_type} $${gross}: artist→Andrew, splits→30/70 ($${newShop}/$${newArtist})`);
      continue;
    }

    const { error } = await supabase
      .from("transactions")
      .update({
        artist_ghl_id: ANDREW_GHL_ID,
        shop_percentage: 30,
        artist_percentage: 70,
        shop_amount: newShop,
        artist_amount: newArtist,
        updated_at: new Date().toISOString(),
      })
      .eq("id", r.id);

    if (error) {
      report.errors.push({ step: "fix-tx", id: r.id, error: error.message });
      console.error(`  ❌ ${r.contact_name}: ${error.message}`);
    } else {
      report.txFixes.push({ ...before, set: { artist_ghl_id: ANDREW_GHL_ID, shop_pct: 30, artist_pct: 70, shop_amount: newShop, artist_amount: newArtist } });
      console.log(`  ✅ ${r.contact_name} ${r.transaction_type} $${gross}: artist→Andrew, splits→30/70`);
    }
  }
}

async function step3DeleteSeedRows(rows, report) {
  const seeds = rows.filter((r) => TEST_NAMES.has((r.contact_name || "").trim()));
  for (const r of seeds) {
    const snap = {
      id: r.id,
      session_date: r.session_date,
      contact_name: r.contact_name,
      transaction_type: r.transaction_type,
      gross_amount: r.gross_amount,
    };

    if (DRY_RUN) {
      report.deletes.push({ ...snap, dry: true });
      console.log(`  [dry] would delete ${r.session_date} ${r.contact_name} ${r.transaction_type} $${r.gross_amount}`);
      continue;
    }

    const { error } = await supabase.from("transactions").delete().eq("id", r.id);
    if (error) {
      report.errors.push({ step: "delete-seed", id: r.id, error: error.message });
      console.error(`  ❌ delete ${r.id}: ${error.message}`);
    } else {
      report.deletes.push(snap);
      console.log(`  ✅ deleted ${r.contact_name} ${r.transaction_type} $${r.gross_amount}`);
    }
  }
}

async function main() {
  console.log(`\n🧹 Phase 1 prep cleanup${DRY_RUN ? " (DRY RUN)" : ""}\n`);

  const rows = await loadTattooTransactions();
  console.log(`Loaded ${rows.length} tattoo transactions.\n`);

  const report = {
    runAt: new Date().toISOString(),
    dryRun: DRY_RUN,
    rateUpdates: [],
    txFixes: [],
    deletes: [],
    skipped: [],
    errors: [],
  };

  // Note skipped anon tips for the report
  for (const r of rows) {
    if (r.artist_ghl_id === "unknown" && r.transaction_type === "tip") {
      report.skipped.push({
        id: r.id,
        session_date: r.session_date,
        square_payment_id: r.square_payment_id,
        gross_amount: r.gross_amount,
        reason: "anonymous Square tip — handled in separate dedup pass",
      });
    }
  }

  console.log("Step 1: Update artist_commission_rates → 30/70 for Andrew + Claudia");
  await step1UpdateRates(report);

  console.log("\nStep 2: Fix 3 real recent transactions (artist→Andrew, split→30/70)");
  await step2FixRealTransactions(rows, report);

  console.log("\nStep 3: Delete 14 Jan 2026 seed/test rows");
  await step3DeleteSeedRows(rows, report);

  console.log(`\nStep 4: Skipped ${report.skipped.length} anonymous Square tips (separate cleanup)`);

  // Write report
  const reportsDir = path.join(__dirname, "reports");
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(
    reportsDir,
    `phase1-prep-cleanup-${stamp}${DRY_RUN ? "-dryrun" : ""}.json`
  );
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\nSummary:`);
  console.log(`  Rate updates: ${report.rateUpdates.length}`);
  console.log(`  Tx fixes:     ${report.txFixes.length}`);
  console.log(`  Deletes:      ${report.deletes.length}`);
  console.log(`  Skipped:      ${report.skipped.length}`);
  console.log(`  Errors:       ${report.errors.length}`);
  console.log(`\nReport: ${reportPath}\n`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
