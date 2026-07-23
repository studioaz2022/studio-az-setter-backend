#!/usr/bin/env node
// Probe: verify the exact GHL sequence bookingCreate now performs, without
// touching any calendar — upsert (expect new:true), re-upsert (expect
// new:false), write lead-source fields via updateContact, read them back,
// then DELETE the test contact. Safe to re-run.
require("dotenv").config({ quiet: true });
const { ghlBarber } = require("../src/clients/ghlMultiLocationSdk");
const { buildLeadSourceFields, FIELDS } = require("../src/booking/bookingFields");

const LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID;
const TEST = {
  firstName: "Ztest",
  lastName: "LeadAttribution",
  email: "ztest-lead-attr@studioaz-test.invalid",
  phone: "+16125550137",
};

async function main() {
  // 1. first upsert — should be NEW
  const up1 = await ghlBarber.contacts.upsertContact({
    locationId: LOCATION_ID,
    ...TEST,
    source: "attribution-probe",
    tags: ["attribution-probe"],
  });
  const contactId = up1?.contact?.id;
  console.log("upsert #1 → new:", up1?.new, "| contactId:", contactId);

  // 2. second upsert — should be EXISTING
  const up2 = await ghlBarber.contacts.upsertContact({
    locationId: LOCATION_ID,
    ...TEST,
    source: "attribution-probe",
  });
  console.log("upsert #2 → new:", up2?.new, "| same id:", up2?.contact?.id === contactId);

  // 3. write lead fields exactly like bookingCreate step 4b
  const fields = buildLeadSourceFields({
    leadSource: "meta_ad",
    leadCampaign: "probe-campaign",
    leadBarber: "gilberto",
  });
  await ghlBarber.contacts.updateContact({ contactId }, { customFields: fields });

  // 4. read back
  const got = await ghlBarber.contacts.getContact({ contactId });
  const cf = got?.contact?.customFields || [];
  const byId = new Map(cf.map((f) => [f.id, f.value ?? f.field_value]));
  console.log("readback → leadSource:", byId.get(FIELDS.leadSource.id),
    "| campaign:", byId.get(FIELDS.leadCampaign.id),
    "| barber:", byId.get(FIELDS.leadBarberAttribution.id));

  // 5. cleanup
  await ghlBarber.contacts.deleteContact({ contactId });
  console.log("test contact deleted ✓");
}

main().catch((e) => {
  console.error("FAILED:", e?.response?.data?.message || e.message);
  process.exit(1);
});
