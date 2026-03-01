/**
 * One-time script to link orphan transactions (null appointment_id) to GHL appointments.
 *
 * Strategy:
 *   1. Fetch all orphan transactions (null appointment_id, has square_payment_id)
 *   2. Group by session_date to minimize GHL API calls
 *   3. For each day, fetch GHL appointments across ALL barbershop calendars
 *   4. Match by contactId on the appointment → transaction contact_id
 *   5. Fallback: match by contact name appearing in appointment title
 *   6. Update the transaction's appointment_id and calendar_id
 *
 * Usage: cd studio-az-setter-backend && node scripts/backfill-appointment-ids.js
 */

const { createClient } = require("@supabase/supabase-js");
const { ghlBarber } = require("../src/clients/ghlMultiLocationSdk");
require("dotenv").config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BARBER_LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID;

// ALL barbershop calendar IDs (from Constants.swift)
const ALL_CALENDAR_IDS = [
  // Lionel
  "Bsv9ngkRgsbLzgtN3Vpq", // lionelHaircut
  "pGNsYjGyEYW9LCD1GcQN", // lionelHaircutBeard
  "9a66xeZi2pEJWQpxiMjy", // lionelHaircutFnF
  "0qOmPMcP7L4qz58fxmu4", // lionelHaircutBeardFnF
  // Drew
  "AzIK0eW09u4V1jJTXQ0x", // drewHaircut
  "dCuPcZbqylgwftyDu8kw", // drewHaircutBeard
  "RsdMc558Cjjs28xpyCCf", // drewBeardTrim
  // Logan
  "o1fvyti3GnoFGKZN5Hwr", // loganHaircut
  "lsBgjayKLFOUahMvuVNe", // loganHaircutBeard
  "Us8MYQ74AcvMsJBmIucQ", // loganBeardTrim
  // Elle
  "Bcqa2hqjUX7xhNu37cL1", // elleHaircut
  "D9l8VEIX7hOLrqSrSJVc", // elleHaircutBeard
  // David
  "qvcPzTqyaQOxsijIQqAN", // davidHaircut
  "prLxqGcd2JYNnb0sPGmc", // davidHaircutBeard
  // Joshua
  "X1xINoRML65yAOVUsAGa", // joshuaHaircut
  "Vs496YAmFt5uX2JTg2Bs", // joshuaHaircutBeard
  "3NsSPGmWCxSAZJSPTIDY", // joshuaBeardTrim
  // Albe
  "h9VQL30IBqr6TTiKwAQm", // albeHaircut
  "NZSQNzPM10Fe6mUuJuyU", // albeHaircutBeard
  "xLjnOmLqToiknndXnvbk", // albeBeardTrim
  // Liam
  "kiGx7ec1vj9e62U33ZhU", // liamHaircut
  "vLpnhjAc93piHn1e2cfQ", // liamHaircutBeard
  // Gilberto
  "38Uhu6i5W4L5yGJbE0My", // gilbertoHaircut
  "7Bj9t1Gwi0zcJRTwCvYA", // gilbertoHaircutBeard
];

/**
 * Fetch appointments for a single calendar on a given day using the GHL SDK.
 */
async function fetchApptsForCalendar(calendarId, startTime, endTime) {
  const startMs = new Date(startTime).getTime();
  const endMs = new Date(endTime).getTime();
  try {
    const result = await ghlBarber.calendars.getCalendarEvents({
      locationId: BARBER_LOCATION_ID,
      calendarId,
      startTime: startMs,
      endTime: endMs,
    });
    return result?.events || [];
  } catch (err) {
    // 404 or calendar not found is fine — skip it
    if (err.statusCode === 404 || err.statusCode === 400) return [];
    throw err;
  }
}

/**
 * Extract the contact name from a GHL appointment title.
 * GHL titles have formats like:
 *   "Haircut: John Smith"
 *   "Long/MedHaircut + Beard: Zach Hempstead"
 *   " Haircut: Ivan Gil"
 *   "John Smith - Haircut"
 * Returns lowercased name or null.
 */
function extractNameFromTitle(title) {
  if (!title) return null;
  const t = title.trim().toLowerCase();
  // Format: "Service: Name"
  const colonIdx = t.indexOf(":");
  if (colonIdx !== -1) {
    return t.slice(colonIdx + 1).trim();
  }
  // Format: "Name - Service"
  const dashIdx = t.indexOf(" - ");
  if (dashIdx !== -1) {
    return t.slice(0, dashIdx).trim();
  }
  return t;
}

async function main() {
  if (!ghlBarber) {
    console.error("ghlBarber SDK not available — check GHL_BARBER_PIT env var");
    return;
  }

  // 1. Fetch all orphan transactions with square_payment_id
  const { data: orphans, error } = await supabase
    .from("transactions")
    .select("id, contact_id, contact_name, session_date, square_payment_time, square_payment_id, appointment_id")
    .is("appointment_id", null)
    .not("square_payment_id", "is", null)
    .not("contact_id", "eq", "walk_in");

  if (error) {
    console.error("Failed to fetch orphans:", error);
    return;
  }

  console.log(`Found ${orphans.length} orphan transactions to link\n`);

  // 2. Group by session_date
  const byDay = {};
  for (const tx of orphans) {
    const day = tx.session_date;
    if (!day) continue;
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(tx);
  }

  const days = Object.keys(byDay).sort();
  console.log(`Spanning ${days.length} unique days: ${days[0]} → ${days[days.length - 1]}\n`);

  let linked = 0;
  let noMatch = 0;
  let errors = 0;

  // 3. For each day, fetch appointments across all calendars and try to match
  for (const day of days) {
    const dayTxs = byDay[day];

    const startOfDay = new Date(`${day}T00:00:00-06:00`);
    const endOfDay = new Date(`${day}T23:59:59-06:00`);

    let appointments = [];
    try {
      // Fetch from all calendars — batch 5 at a time to avoid overwhelming GHL
      for (let i = 0; i < ALL_CALENDAR_IDS.length; i += 5) {
        const batch = ALL_CALENDAR_IDS.slice(i, i + 5);
        const results = await Promise.all(
          batch.map((calId) =>
            fetchApptsForCalendar(calId, startOfDay.toISOString(), endOfDay.toISOString())
          )
        );
        appointments = appointments.concat(results.flat());
      }
      // Filter to active appointments
      appointments = appointments.filter(
        (apt) => ["confirmed", "showed", "new"].includes(apt.appointmentStatus)
      );
      // Deduplicate by appointment ID
      const seen = new Set();
      appointments = appointments.filter((apt) => {
        if (seen.has(apt.id)) return false;
        seen.add(apt.id);
        return true;
      });
    } catch (err) {
      console.error(`  ERROR fetching appointments for ${day}: ${err.message}`);
      errors += dayTxs.length;
      continue;
    }

    if (appointments.length === 0) {
      console.log(`  ${day}: No appointments found (${dayTxs.length} orphans)`);
      noMatch += dayTxs.length;
      continue;
    }

    console.log(`  ${day}: ${appointments.length} appointments, ${dayTxs.length} orphans`);

    // Check which appointments already have transactions linked
    const { data: linkedTxs } = await supabase
      .from("transactions")
      .select("appointment_id")
      .not("appointment_id", "is", null)
      .in("appointment_id", appointments.map((a) => a.id));
    const alreadyLinkedAptIds = new Set((linkedTxs || []).map((t) => t.appointment_id));

    // Track claimed appointments
    const claimedAptIds = new Set(alreadyLinkedAptIds);

    for (const tx of dayTxs) {
      let matchedApt = null;

      // Strategy A: Match by contactId
      const contactMatches = appointments.filter(
        (apt) => apt.contactId === tx.contact_id && !claimedAptIds.has(apt.id)
      );
      if (contactMatches.length === 1) {
        matchedApt = contactMatches[0];
        console.log(`    ✓ ${tx.contact_name}: contactId match → ${matchedApt.id}`);
      } else if (contactMatches.length > 1 && tx.square_payment_time) {
        const payTime = new Date(tx.square_payment_time);
        contactMatches.sort((a, b) => {
          const diffA = Math.abs(payTime - new Date(a.startTime));
          const diffB = Math.abs(payTime - new Date(b.startTime));
          return diffA - diffB;
        });
        matchedApt = contactMatches[0];
        console.log(`    ✓ ${tx.contact_name}: contactId match (closest of ${contactMatches.length}) → ${matchedApt.id}`);
      }

      // Strategy B: Match by contact name in appointment title
      if (!matchedApt) {
        const txNameLower = (tx.contact_name || "").toLowerCase().trim();
        if (txNameLower && txNameLower !== "unknown") {
          const nameMatches = appointments.filter((apt) => {
            if (claimedAptIds.has(apt.id)) return false;
            const aptNameFromTitle = extractNameFromTitle(apt.title);
            if (!aptNameFromTitle) return false;
            // Exact name match or one contains the other
            return aptNameFromTitle === txNameLower ||
              aptNameFromTitle.includes(txNameLower) ||
              txNameLower.includes(aptNameFromTitle);
          });
          if (nameMatches.length === 1) {
            matchedApt = nameMatches[0];
            console.log(`    ✓ ${tx.contact_name}: name match → ${matchedApt.id} (title: "${matchedApt.title}")`);
          } else if (nameMatches.length > 1 && tx.square_payment_time) {
            const payTime = new Date(tx.square_payment_time);
            nameMatches.sort((a, b) => {
              const diffA = Math.abs(payTime - new Date(a.startTime));
              const diffB = Math.abs(payTime - new Date(b.startTime));
              return diffA - diffB;
            });
            matchedApt = nameMatches[0];
            console.log(`    ✓ ${tx.contact_name}: name match (closest of ${nameMatches.length}) → ${matchedApt.id} (title: "${matchedApt.title}")`);
          }
        }
      }

      // NO Strategy C (time proximity) — too unreliable for backfill
      // Matches by time alone pair wrong clients to wrong appointments

      if (!matchedApt) {
        console.log(`    ✗ ${tx.contact_name}: no match found`);
        noMatch++;
        continue;
      }

      // Update the transaction
      claimedAptIds.add(matchedApt.id);
      const { error: updateErr } = await supabase
        .from("transactions")
        .update({
          appointment_id: matchedApt.id,
          calendar_id: matchedApt.calendarId || null,
        })
        .eq("id", tx.id);

      if (updateErr) {
        console.error(`    ERROR updating ${tx.contact_name}: ${updateErr.message}`);
        errors++;
      } else {
        linked++;
      }
    }

    // Rate limit between days to avoid GHL API throttling
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\nDone: ${linked} linked, ${noMatch} no match, ${errors} errors`);
}

main().catch(console.error);
