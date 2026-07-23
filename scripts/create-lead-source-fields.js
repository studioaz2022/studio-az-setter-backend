#!/usr/bin/env node
// One-off: ensure the barbershop location has the Phase 2 lead-attribution
// custom fields (future-marketing-platform-roadmap.md). Idempotent — lists
// existing fields first and only creates what's missing. Prints the IDs to
// hardcode into src/booking/bookingFields.js.
require("dotenv").config({ quiet: true });
const { ghlBarber } = require("../src/clients/ghlMultiLocationSdk");

const LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID;

const WANTED = [
  { key: "leadSource", name: "Lead Source", placeholder: "meta_ad | google_organic | ig_bio_drew | direct ..." },
  { key: "leadCampaign", name: "Lead Campaign", placeholder: "utm_campaign of the first touch" },
  { key: "leadBarberAttribution", name: "Lead Barber Attribution", placeholder: "barber slug whose link/page was the entry point" },
];

async function main() {
  if (!ghlBarber || !LOCATION_ID) throw new Error("barber GHL SDK or GHL_BARBER_LOCATION_ID not configured");

  const existing = await ghlBarber.locations.getCustomFields({ locationId: LOCATION_ID, model: "contact" });
  const fields = existing?.customFields || [];
  const byName = new Map(fields.map((f) => [f.name, f]));

  for (const want of WANTED) {
    const found = byName.get(want.name);
    if (found) {
      console.log(`EXISTS  ${want.key}: { id: "${found.id}", name: "${found.name}", type: "${found.dataType}" }`);
      continue;
    }
    const created = await ghlBarber.locations.createCustomField(
      { locationId: LOCATION_ID },
      { name: want.name, dataType: "TEXT", placeholder: want.placeholder, model: "contact" }
    );
    const f = created?.customField || created;
    console.log(`CREATED ${want.key}: { id: "${f.id}", name: "${f.name}", type: "${f.dataType}" }`);
  }
}

main().catch((e) => {
  console.error("FAILED:", e?.response?.data?.message || e.message);
  process.exit(1);
});
