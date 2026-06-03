#!/usr/bin/env node
// GO-LIVE #3 — Create the `consultation_preference` custom field on the tattoo
// GHL location. The consultation widget (Examples/tattoo_consultation_widget.html)
// already asks medium+/large English leads to pick "Video Call with Coordinator",
// "Video Call with Translator", or "Message-Based Consultation" — but the backend
// never stored that answer, so the v2 bot re-asked "online or in person?". This
// field captures the raw form choice so the bot can honor it (and skip in-person,
// which the form never offers).
//
// Idempotent: re-running skips the field if it already exists.
// Run from backend root:  node scripts/ghl-create-consult-preference-field.js

require("dotenv").config({ quiet: true });

const { ghl } = require("../src/clients/ghlSdk");

const LOCATION_ID = process.env.GHL_LOCATION_ID;
const BARBER_LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID;

if (!LOCATION_ID) {
  console.error("❌ GHL_LOCATION_ID is not set.");
  process.exit(2);
}
if (LOCATION_ID === BARBER_LOCATION_ID) {
  console.error("❌ GHL_LOCATION_ID === GHL_BARBER_LOCATION_ID — refusing to run on the barber side.");
  process.exit(2);
}

const FIELDS_TO_CREATE = [
  {
    name: "Consultation Preference",
    expectedKey: "consultation_preference",
    dataType: "TEXT",
    placeholder: "Form choice: Video Call with Coordinator / Video Call with Translator / Message-Based Consultation",
  },
];

function fieldKeyOf(f) {
  const k = f?.fieldKey || f?.key || "";
  return k.replace(/^contact\./, "");
}

async function main() {
  console.log(`=== GO-LIVE #3 — creating consultation_preference field on location ${LOCATION_ID} ===\n`);

  let existing;
  try {
    const result = await ghl.locations.getCustomFields({ locationId: LOCATION_ID, model: "contact" });
    existing = result?.customFields || result?.data?.customFields || [];
  } catch (err) {
    console.error("❌ Could not list existing custom fields:", err.message);
    process.exit(1);
  }

  console.log(`Found ${existing.length} existing contact custom fields.`);
  const existingKeys = new Set(existing.map(fieldKeyOf));
  const out = { created: [], skipped: [] };

  for (const spec of FIELDS_TO_CREATE) {
    if (existingKeys.has(spec.expectedKey)) {
      const match = existing.find((f) => fieldKeyOf(f) === spec.expectedKey);
      console.log(`↪︎  SKIP "${spec.name}" — exists (id=${match.id}, key=${fieldKeyOf(match)})`);
      out.skipped.push({ name: spec.name, id: match.id, key: fieldKeyOf(match) });
      continue;
    }
    try {
      const res = await ghl.locations.createCustomField(
        { locationId: LOCATION_ID },
        { name: spec.name, dataType: spec.dataType, placeholder: spec.placeholder, model: "contact" }
      );
      const field = res?.customField || res?.data?.customField || res?.field || res;
      console.log(`✅ CREATED "${spec.name}" — id=${field?.id}, key=${fieldKeyOf(field)}`);
      out.created.push({ name: spec.name, id: field?.id, key: fieldKeyOf(field) });
    } catch (err) {
      console.error(`❌ FAILED to create "${spec.name}":`, err.message);
      process.exit(1);
    }
  }

  console.log(`\n=== Done. Created: ${out.created.length}, Skipped: ${out.skipped.length}. ===`);
  console.log("CONSULT_PREFERENCE_FIELD_ID=" + (out.created[0]?.id || out.skipped[0]?.id || "UNKNOWN"));
}

main().catch((err) => {
  console.error("Uncaught:", err.message);
  process.exit(1);
});
