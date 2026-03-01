/**
 * Link deposit transactions to their future appointments.
 * Deposits are made at booking time, but the appointment is on a later date.
 *
 * Strategy:
 *   1. For each deposit with null appointment_id, search GHL for the contact's
 *      appointments in a 30-day window after the deposit date
 *   2. Match by contactId
 *   3. Fallback: match by contact name in appointment title
 *   4. Link the deposit to the matched appointment
 *
 * Usage: cd studio-az-setter-backend && node scripts/link-deposits-to-appointments.js
 */

const { createClient } = require("@supabase/supabase-js");
const { ghlBarber } = require("../src/clients/ghlMultiLocationSdk");
require("dotenv").config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BARBER_LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID;

// Lionel's calendars (deposits are for his clients only)
const LIONEL_CALENDAR_IDS = [
  "Bsv9ngkRgsbLzgtN3Vpq", // lionelHaircut
  "pGNsYjGyEYW9LCD1GcQN", // lionelHaircutBeard
  "9a66xeZi2pEJWQpxiMjy", // lionelHaircutFnF
  "0qOmPMcP7L4qz58fxmu4", // lionelHaircutBeardFnF
];

async function fetchApptsForCalendar(calendarId, startMs, endMs) {
  try {
    const result = await ghlBarber.calendars.getCalendarEvents({
      locationId: BARBER_LOCATION_ID,
      calendarId,
      startTime: startMs,
      endTime: endMs,
    });
    return result?.events || [];
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 400) return [];
    throw err;
  }
}

function extractNameFromTitle(title) {
  if (!title) return null;
  const t = title.trim().toLowerCase();
  const colonIdx = t.indexOf(":");
  if (colonIdx !== -1) return t.slice(colonIdx + 1).trim();
  const dashIdx = t.indexOf(" - ");
  if (dashIdx !== -1) return t.slice(0, dashIdx).trim();
  return t;
}

async function main() {
  if (!ghlBarber) {
    console.error("ghlBarber SDK not available");
    return;
  }

  // Fetch deposit transactions with null appointment_id
  const { data: deposits, error } = await supabase
    .from("transactions")
    .select("id, contact_id, contact_name, session_date, square_payment_id")
    .eq("transaction_type", "deposit")
    .is("appointment_id", null)
    .not("square_payment_id", "is", null)
    .order("session_date");

  if (error) {
    console.error("Failed to fetch deposits:", error);
    return;
  }

  console.log(`Found ${deposits.length} unlinked deposits\n`);

  let linked = 0;
  let noMatch = 0;

  // For each deposit, search for the client's appointment in a 30-day window
  for (const dep of deposits) {
    const depositDate = new Date(`${dep.session_date}T00:00:00-06:00`);
    const searchEnd = new Date(depositDate.getTime() + 30 * 24 * 60 * 60 * 1000);

    // Fetch appointments from all of Lionel's calendars
    let appointments = [];
    for (let i = 0; i < LIONEL_CALENDAR_IDS.length; i += 2) {
      const batch = LIONEL_CALENDAR_IDS.slice(i, i + 2);
      const results = await Promise.all(
        batch.map((calId) => fetchApptsForCalendar(calId, depositDate.getTime(), searchEnd.getTime()))
      );
      appointments = appointments.concat(results.flat());
    }

    // Filter to active, dedupe
    appointments = appointments.filter(
      (apt) => ["confirmed", "showed", "new"].includes(apt.appointmentStatus)
    );
    const seen = new Set();
    appointments = appointments.filter((apt) => {
      if (seen.has(apt.id)) return false;
      seen.add(apt.id);
      return true;
    });

    let matchedApt = null;

    // Strategy A: Match by contactId
    const contactMatches = appointments.filter((apt) => apt.contactId === dep.contact_id);
    if (contactMatches.length === 1) {
      matchedApt = contactMatches[0];
    } else if (contactMatches.length > 1) {
      // Pick the earliest future appointment
      contactMatches.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
      matchedApt = contactMatches[0];
    }

    // Strategy B: Match by name
    if (!matchedApt) {
      const txNameLower = (dep.contact_name || "").toLowerCase().trim();
      if (txNameLower && txNameLower !== "unknown") {
        const nameMatches = appointments.filter((apt) => {
          const aptName = extractNameFromTitle(apt.title);
          if (!aptName) return false;
          return aptName === txNameLower ||
            aptName.includes(txNameLower) ||
            txNameLower.includes(aptName);
        });
        if (nameMatches.length >= 1) {
          nameMatches.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
          matchedApt = nameMatches[0];
        }
      }
    }

    if (matchedApt) {
      const { error: updateErr } = await supabase
        .from("transactions")
        .update({
          appointment_id: matchedApt.id,
          calendar_id: matchedApt.calendarId || null,
        })
        .eq("id", dep.id);

      if (updateErr) {
        console.error(`  ERROR ${dep.contact_name}: ${updateErr.message}`);
      } else {
        const aptDate = new Date(matchedApt.startTime).toISOString().slice(0, 10);
        console.log(`  ✓ ${dep.contact_name} (deposit ${dep.session_date}) → apt ${aptDate} (${matchedApt.title?.trim()})`);
        linked++;
      }
    } else {
      console.log(`  ✗ ${dep.contact_name} (deposit ${dep.session_date}): no appointment found in 30-day window (${appointments.length} appointments checked)`);
      noMatch++;
    }

    // Rate limit
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\nDone: ${linked} linked, ${noMatch} no match`);
}

main().catch(console.error);
