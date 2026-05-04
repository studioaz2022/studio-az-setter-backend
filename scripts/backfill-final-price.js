#!/usr/bin/env node
/**
 * One-time backfill: copy `quote_to_client` (deprecated) → `final_price` (source of truth).
 *
 * Phase 0 of TATTOO_FINANCE_PLAN.md. Only runs where `final_price` is empty AND
 * `quote_to_client` has a value. Idempotent. Logs every change to a JSON report
 * committed to scripts/reports/.
 *
 * Run: node scripts/backfill-final-price.js [--dry-run]
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { updateContact } = require("../src/clients/ghlClient");
const { GHL_CUSTOM_FIELD_IDS } = require("../src/config/constants");

const DRY_RUN = process.argv.includes("--dry-run");
const LOCATION_ID = process.env.GHL_LOCATION_ID;
const PIT_TOKEN = process.env.GHL_FILE_UPLOAD_TOKEN;
const QUOTE_TO_CLIENT_ID = GHL_CUSTOM_FIELD_IDS.QUOTED;
const FINAL_PRICE_ID = GHL_CUSTOM_FIELD_IDS.FINAL_PRICE;

function parseQuote(raw) {
  if (raw == null || raw === "") return null;
  const cleaned = String(raw).replace(/[^0-9.]/g, "");
  const n = parseFloat(cleaned);
  return isNaN(n) || n <= 0 ? null : n;
}

async function searchContactsWithQuoteToClient() {
  const res = await fetch("https://services.leadconnectorhq.com/contacts/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PIT_TOKEN}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      locationId: LOCATION_ID,
      pageLimit: 100,
      filters: [{ field: `customFields.${QUOTE_TO_CLIENT_ID}`, operator: "exists" }],
    }),
  });
  if (!res.ok) {
    throw new Error(`GHL search failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.contacts || [];
}

async function main() {
  console.log(`\n🔄 final_price backfill${DRY_RUN ? " (DRY RUN)" : ""}\n`);

  const contacts = await searchContactsWithQuoteToClient();
  console.log(`Found ${contacts.length} contacts with quote_to_client populated.\n`);

  const report = {
    runAt: new Date().toISOString(),
    dryRun: DRY_RUN,
    candidates: contacts.length,
    backfilled: [],
    skipped: [],
    conflicts: [],
    errors: [],
  };

  for (const c of contacts) {
    const cfs = c.customFields || [];
    const qtc = cfs.find((f) => f.id === QUOTE_TO_CLIENT_ID);
    const fp = cfs.find((f) => f.id === FINAL_PRICE_ID);

    const quoteVal = parseQuote(qtc?.value);
    const finalVal = parseQuote(fp?.value);

    const base = {
      id: c.id,
      name: c.contactName || `${c.firstName || ""} ${c.lastName || ""}`.trim(),
      quote_to_client: qtc?.value ?? null,
      final_price: fp?.value ?? null,
    };

    if (!quoteVal) {
      report.skipped.push({ ...base, reason: "quote_to_client unparseable or zero" });
      continue;
    }

    if (finalVal != null) {
      // Both populated — final_price wins per Vision #1. Log conflict if values differ.
      if (Math.abs(finalVal - quoteVal) > 0.01) {
        report.conflicts.push({ ...base, decision: "kept final_price (signed contract wins)" });
      } else {
        report.skipped.push({ ...base, reason: "final_price already matches" });
      }
      continue;
    }

    // Backfill case: final_price empty, quote_to_client has a real value.
    if (DRY_RUN) {
      report.backfilled.push({ ...base, would_write: quoteVal, dry: true });
      console.log(`  [dry] ${base.name} (${c.id}): would set final_price = ${quoteVal}`);
      continue;
    }

    try {
      await updateContact(c.id, {
        customField: { [FINAL_PRICE_ID]: String(quoteVal) },
      });
      report.backfilled.push({ ...base, wrote: quoteVal });
      console.log(`  ✅ ${base.name} (${c.id}): final_price = ${quoteVal}`);
    } catch (err) {
      report.errors.push({ ...base, error: err.message });
      console.error(`  ❌ ${base.name} (${c.id}): ${err.message}`);
    }
  }

  // Write report
  const reportsDir = path.join(__dirname, "reports");
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `backfill-final-price-${stamp}${DRY_RUN ? "-dryrun" : ""}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\nSummary:`);
  console.log(`  Candidates:   ${report.candidates}`);
  console.log(`  Backfilled:   ${report.backfilled.length}`);
  console.log(`  Skipped:      ${report.skipped.length}`);
  console.log(`  Conflicts:    ${report.conflicts.length}`);
  console.log(`  Errors:       ${report.errors.length}`);
  console.log(`\nReport written to: ${reportPath}\n`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
