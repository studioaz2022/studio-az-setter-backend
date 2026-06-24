#!/usr/bin/env node
// One-off: create Kaelani's Tattoo + Online + In-Person Consultation calendars by
// cloning Andrew's exact config (round-robin, same groups, same slot/format settings),
// swapping in Kaelani's user id, display names, and unique widget slugs.
// Mirrors scripts/create-megan-calendars.js + create-megan-inperson-calendar.js.
require("dotenv").config({ quiet: true });

const { ghl } = require("../src/clients/ghlSdk");

const KAELANI_USER_ID = "C94R2IHBHHf0yuPzBpuS";

// Andrew's source calendars to clone
const ANDREW_ONLINE = "yVylpytpJmhu47osg3mN";
const ANDREW_TATTOO = "9KwARaShHhymNjgarXgA";
const ANDREW_IN_PERSON = "yKJJJoyEZ6j8tZhVgJ5i";

// Fields that are server-side / read-only and must not be sent on create
const STRIP = ["id", "appointmentPerSlot", "appointmentPerDay"];

function buildPayload(sourceCal, { name, widgetSlug }) {
  const payload = { ...sourceCal };
  STRIP.forEach((k) => delete payload[k]);

  payload.name = name;
  payload.widgetSlug = widgetSlug;

  // GET returns `formSubmitRedirectUrl`; the create DTO expects `formSubmitRedirectURL`.
  if ("formSubmitRedirectUrl" in payload) {
    if (payload.formSubmitRedirectUrl) {
      payload.formSubmitRedirectURL = payload.formSubmitRedirectUrl;
    }
    delete payload.formSubmitRedirectUrl;
  }

  // Keep every team-member setting from Andrew (meeting location, kind, etc.),
  // only repoint the userId to Kaelani.
  payload.teamMembers = (sourceCal.teamMembers || []).map((tm) => ({
    ...tm,
    userId: KAELANI_USER_ID,
  }));

  return payload;
}

async function cloneOne(label, sourceId, overrides) {
  const src = (await ghl.calendars.getCalendar({ calendarId: sourceId })).calendar;
  const payload = buildPayload(src, overrides);
  const res = await ghl.calendars.createCalendar(payload);
  const cal = res.calendar || res;
  console.log(`\n✅ Created ${label}`);
  console.log(`   name:      ${cal.name}`);
  console.log(`   id:        ${cal.id}`);
  console.log(`   slug:      ${cal.widgetSlug}`);
  console.log(`   groupId:   ${cal.groupId}`);
  console.log(`   eventType: ${cal.eventType}`);
  console.log(`   teamMember:${(cal.teamMembers || []).map((t) => t.userId).join(", ")}`);
  return cal;
}

async function main() {
  console.log("Creating Kaelani's calendars (user:", KAELANI_USER_ID, ")");

  const tattoo = await cloneOne("Tattoo w/ Kaelani", ANDREW_TATTOO, {
    name: "Tattoo w/ Kaelani",
    widgetSlug: "tattoo-consultation/kaelani-tattoo",
  });

  const online = await cloneOne("Online Consultation w/ Kaelani", ANDREW_ONLINE, {
    name: "Online Consultation w/ Kaelani",
    widgetSlug: "tattoo-consultation/kaelani-online",
  });

  const inperson = await cloneOne("In-Person Consultation w/ Kaelani", ANDREW_IN_PERSON, {
    name: "In-Person Consultation w/ Kaelani",
    widgetSlug: "tattoo-consultation/kaelani-in-person",
  });

  console.log("\n──────── SUMMARY (record these) ────────");
  console.log(`kaelaniTattoo                = "${tattoo.id}"`);
  console.log(`kaelaniConsultation          = "${online.id}"`);
  console.log(`kaelaniInPersonConsultation  = "${inperson.id}"`);
  console.log("────────────────────────────────────────");
}

main().catch((e) => {
  console.error("\n❌ Error:", JSON.stringify(e.response?.data, null, 2) || e.message);
  process.exit(1);
});
