#!/usr/bin/env node
// Phase 4 — Create the three Lost-deal analytics custom fields on the tattoo
// GHL location (REFUND_REQUEST_FORM_PLAN.md §6.6). Idempotent: re-running is
// safe — fields that already exist are skipped.
//
// Targets the TATTOO location (GHL_LOCATION_ID), not the BARBER location
// (GHL_BARBER_LOCATION_ID). See memory `ghl-multi-location.md`.
//
// Run from backend root:
//   node scripts/ghl-create-lost-analytics-fields.js

require("dotenv").config({ quiet: true });

const { ghl } = require("../src/clients/ghlSdk");

const LOCATION_ID = process.env.GHL_LOCATION_ID;
const BARBER_LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID;

if (!LOCATION_ID) {
  console.error("❌ GHL_LOCATION_ID is not set.");
  process.exit(2);
}
if (LOCATION_ID === BARBER_LOCATION_ID) {
  console.error(
    "❌ GHL_LOCATION_ID === GHL_BARBER_LOCATION_ID — refusing to run on the barber side."
  );
  process.exit(2);
}

const FIELDS_TO_CREATE = [
  {
    name: "Last Stage Before Lost",
    expectedKey: "last_stage_before_lost",
    dataType: "TEXT",
    placeholder: "Auto-filled when opportunity moves to Cold Nurture Lost",
  },
  {
    name: "Lost Reason",
    expectedKey: "lost_reason",
    dataType: "TEXT",
    placeholder: "Cause-only bucket (price_too_high, scheduling_conflict, etc.)",
  },
  {
    name: "Refund Type",
    expectedKey: "refund_type",
    dataType: "TEXT",
    placeholder:
      "Money outcome (deposit_refunded, partial_refund, no_refund, no_payment)",
  },
];

async function listExistingContactFields() {
  // SDK returns response.data directly; getCustomFields returns
  // { customFields: [...] } per the listing shape used elsewhere.
  const result = await ghl.locations.getCustomFields({
    locationId: LOCATION_ID,
    model: "contact",
  });
  // Some SDK versions wrap in .data, normalize.
  return result?.customFields || result?.data?.customFields || [];
}

function fieldKeyOf(f) {
  // GHL stores keys as "contact.<slug>". Strip the prefix for comparison.
  const k = f?.fieldKey || f?.key || "";
  return k.replace(/^contact\./, "");
}

async function main() {
  console.log(
    `=== Phase 4 GHL setup — creating Lost-analytics fields on location ${LOCATION_ID} ===\n`
  );

  let existing;
  try {
    existing = await listExistingContactFields();
  } catch (err) {
    console.error("❌ Could not list existing custom fields:", err.message);
    if (err.response?.status) {
      console.error("  HTTP", err.response.status);
    }
    process.exit(1);
  }

  console.log(`Found ${existing.length} existing contact custom fields.`);

  const existingKeys = new Set(existing.map(fieldKeyOf));
  const created = [];
  const skipped = [];

  for (const spec of FIELDS_TO_CREATE) {
    if (existingKeys.has(spec.expectedKey)) {
      const match = existing.find((f) => fieldKeyOf(f) === spec.expectedKey);
      console.log(
        `↪︎  SKIP "${spec.name}" — exists (id=${match.id}, key=${fieldKeyOf(match)}, dataType=${match.dataType})`
      );
      skipped.push({ name: spec.name, id: match.id, key: fieldKeyOf(match) });
      continue;
    }

    try {
      const res = await ghl.locations.createCustomField(
        { locationId: LOCATION_ID },
        {
          name: spec.name,
          dataType: spec.dataType,
          placeholder: spec.placeholder,
          model: "contact",
        }
      );
      // Newly-created field is under .customField (or .data.customField).
      const field =
        res?.customField || res?.data?.customField || res?.field || res;
      const id = field?.id;
      const key = fieldKeyOf(field);
      console.log(
        `✅ CREATED "${spec.name}" — id=${id}, key=${key}, dataType=${spec.dataType}`
      );
      created.push({ name: spec.name, id, key });
    } catch (err) {
      console.error(`❌ FAILED to create "${spec.name}":`, err.message);
      if (err.response?.data) {
        // Surface GHL error detail (but not Authorization header).
        const safe = { ...err.response.data };
        delete safe.config;
        delete safe.request;
        console.error("  Detail:", JSON.stringify(safe, null, 2));
      }
      process.exit(1);
    }
  }

  console.log(
    `\n=== Done. Created: ${created.length}, Skipped (existed): ${skipped.length}. ===`
  );
  console.log(JSON.stringify({ created, skipped }, null, 2));
}

main().catch((err) => {
  console.error("Uncaught:", err.message);
  process.exit(1);
});
