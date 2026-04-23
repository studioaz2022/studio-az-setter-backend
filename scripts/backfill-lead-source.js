#!/usr/bin/env node
/**
 * One-time backfill script for lead_source custom field.
 *
 * Only backfills from the landing_page_inquiry field (reliable signal).
 * The "Source: Web Widget" tag is too broadly applied to use for ai_setter inference.
 *
 * Run: node scripts/backfill-lead-source.js [--dry-run]
 */

require("dotenv").config();

const { searchOpportunities } = require("../src/clients/ghlOpportunityClient");
const { getContactsBatch, updateSystemFields } = require("../src/clients/ghlClient");
const { PIPELINE_ID } = require("../src/config/pipelineConfig");

const LANDING_PAGE_INQUIRY_FIELD_ID = "kNJrZsTQhDmILbdqJlo0";
const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  console.log(`\n🔄 Lead Source Backfill${DRY_RUN ? " (DRY RUN)" : ""}\n`);

  // 1. Fetch all open opportunities in the tattoo pipeline
  console.log("Fetching pipeline opportunities...");
  const opportunities = await searchOpportunities({
    query: { pipelineId: PIPELINE_ID, status: "open" },
  });
  console.log(`Found ${opportunities.length} open opportunities.\n`);

  if (!opportunities.length) {
    console.log("No opportunities to process. Done.");
    return;
  }

  // 2. Batch-fetch contacts
  const contactIds = [...new Set(
    opportunities.map((opp) => opp.contactId || opp.contact_id).filter(Boolean)
  )];
  console.log(`Fetching ${contactIds.length} contacts...`);
  const contactMap = await getContactsBatch(contactIds, { concurrency: 5 });
  console.log(`Fetched ${contactMap.size} contacts.\n`);

  // 3. Check each contact
  let alreadySet = 0;
  let backfilled = 0;
  let noSignal = 0;
  let errors = 0;

  for (const [contactId, contact] of contactMap) {
    if (!contact) {
      errors++;
      continue;
    }

    const cf = contact.customField || {};
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contactId;

    // Already has lead_source — skip
    if (cf.lead_source) {
      alreadySet++;
      continue;
    }

    // Check for landing_page_inquiry field (reliable signal)
    if (cf[LANDING_PAGE_INQUIRY_FIELD_ID]) {
      if (DRY_RUN) {
        console.log(`  [DRY RUN] Would set ${name} → artist_landing_page`);
      } else {
        try {
          await updateSystemFields(contactId, { lead_source: "artist_landing_page" });
          console.log(`  ✅ ${name} → artist_landing_page`);
        } catch (err) {
          console.error(`  ❌ ${name}: ${err.message}`);
          errors++;
          continue;
        }
      }
      backfilled++;
      continue;
    }

    // No reliable signal — leave as null
    noSignal++;
  }

  // 4. Summary
  console.log(`\n--- Summary ---`);
  console.log(`Already set:  ${alreadySet}`);
  console.log(`Backfilled:   ${backfilled}${DRY_RUN ? " (dry run)" : ""}`);
  console.log(`No signal:    ${noSignal} (left as Unknown)`);
  console.log(`Errors:       ${errors}`);
  console.log(`Total:        ${contactMap.size}\n`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
