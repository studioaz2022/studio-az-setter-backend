// venmoBarberPayment.js
// Handles Venmo "paid you" emails that are NOT rent payments — i.e., clients
// paying a barber for a haircut/service. Matches the sender to a GHL contact,
// links to an appointment if possible, and records to the Supabase transactions table.

const { createClient } = require("@supabase/supabase-js");
const { ghlBarber } = require("../clients/ghlMultiLocationSdk");
const { fetchAppointmentsForDateRange } = require("../clients/ghlCalendarClient");
const { generateDedup } = require("../rentTracker/venmoEmailParser");
const { toLocalDate } = require("./squareTransactionSync");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BARBER_LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID;
const BARBER_TZ = "America/Chicago";

/**
 * Handle a Venmo payment that isn't from a known rent tenant.
 * Tries to match the sender to a GHL contact and link to an appointment.
 *
 * @param {Object} params
 * @param {Object} params.parsed - Output from parseVenmoEmail()
 * @param {string} params.barberGhlId - GHL user ID of the barber who received the payment
 * @returns {Object} { recorded, matched, contactName, appointmentId, venmoTxId } or { skipped }
 */
async function handleBarberVenmoPayment({ parsed, barberGhlId }) {
  // Step 1: Build dedup key
  const venmoTxId = parsed.transactionId || generateDedup(parsed.senderName, parsed.amount, parsed.date, parsed.note);

  // Step 2: Dedup check
  const { data: existing } = await supabase
    .from("transactions")
    .select("id")
    .eq("venmo_transaction_id", venmoTxId)
    .maybeSingle();

  if (existing) {
    console.log(`  [VenmoBarber] Duplicate: ${venmoTxId}`);
    return { skipped: "duplicate", venmoTxId };
  }

  // Step 3: Build unclaimed appointments list (needed for contact matching cross-ref)
  let appointmentId = null;
  let calendarId = null;
  const paymentDate = parsed.date || new Date();
  const localDate = toLocalDate(paymentDate.toISOString());
  let unclaimedAppts = [];

  try {
    const dayStart = new Date(`${localDate}T00:00:00`);
    const dayEnd = new Date(`${localDate}T23:59:59`);

    const appointments = await fetchAppointmentsForDateRange({
      locationId: BARBER_LOCATION_ID,
      startTime: dayStart.toISOString(),
      endTime: dayEnd.toISOString(),
      userId: barberGhlId,
      sdkInstance: ghlBarber,
    });

    // Filter to real client appointments — exclude breaks, blocks, personal holds
    const blockedTitles = ["break", "block", "blocked", "lunch", "personal", "off"];
    const activeAppts = appointments.filter((apt) => {
      if (apt.assignedUserId !== barberGhlId) return false;
      if (!["confirmed", "showed", "new"].includes(apt.appointmentStatus)) return false;
      const title = (apt.title || "").toLowerCase().trim();
      return !blockedTitles.includes(title);
    });

    if (activeAppts.length > 0) {
      const { data: existingTx } = await supabase
        .from("transactions")
        .select("appointment_id")
        .eq("artist_ghl_id", barberGhlId)
        .eq("session_date", localDate)
        .not("appointment_id", "is", null);

      const claimedAptIds = new Set((existingTx || []).map((t) => t.appointment_id));
      unclaimedAppts = activeAppts
        .filter((apt) => !claimedAptIds.has(apt.id))
        .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    } else {
      console.log(`  [VenmoBarber] No active appointments found for ${localDate}`);
    }
  } catch (err) {
    console.warn(`  [VenmoBarber] Appointment fetch failed: ${err.message}`);
  }

  // Step 4: Contact matching by name
  // IMPORTANT: contactName is ALWAYS the original Venmo sender name.
  // We never overwrite it with GHL or appointment contact info.
  let contactId = null;
  const contactName = parsed.senderName; // immutable — always the Venmo sender

  // Normalize helper: strip periods, collapse whitespace, lowercase
  // e.g. "C.J. Washington" → "cj washington", "Pablo RP" → "pablo rp"
  const normalize = (s) => (s || "").replace(/\./g, "").replace(/\s+/g, " ").trim().toLowerCase();

  // Common nickname/diminutive pairs for first-name matching
  const nicknameMap = {
    ben: "benjamin", benjamin: "ben",
    mike: "michael", michael: "mike",
    steve: "stephen", stephen: "steve",
    steven: "steve",
    matt: "matthew", matthew: "matt",
    dan: "daniel", daniel: "dan",
    dave: "david", david: "dave",
    rob: "robert", robert: "rob", bob: "robert",
    jim: "james", james: "jim",
    joe: "joseph", joseph: "joe",
    tom: "thomas", thomas: "tom",
    nick: "nicholas", nicholas: "nick",
    chris: "christopher", christopher: "chris",
    jon: "jonathan", jonathan: "jon",
    alex: "alexander", alexander: "alex",
    will: "william", william: "will", bill: "william",
    ed: "edward", edward: "ed",
    tony: "anthony", anthony: "tony",
    jake: "jacob", jacob: "jake",
    josh: "joshua", joshua: "josh",
    sam: "samuel", samuel: "sam",
    zac: "zachary", zach: "zachary", zachary: "zach",
    drew: "andrew", andrew: "drew",
    pat: "patrick", patrick: "pat",
    greg: "gregory", gregory: "greg",
    jeff: "jeffrey", jeffrey: "jeff",
    charlie: "charles", charles: "charlie", chuck: "charles",
    dj: "d j",
  };

  const namesMatch = (name1, name2) => {
    const parts1 = name1.split(" ");
    const parts2 = name2.split(" ");
    if (parts1.length < 2 || parts2.length < 2) return false;
    const first1 = parts1[0], last1 = parts1[parts1.length - 1];
    const first2 = parts2[0], last2 = parts2[parts2.length - 1];
    if (last1 !== last2) return false;
    if (first1 === first2) return true;
    return nicknameMap[first1] === first2 || nicknameMap[first2] === first1;
  };

  // Strategy 1: Match sender name against today's appointment titles directly.
  // This catches cases like "CJ Washington" → "C.J. Washington" where GHL search fails.
  // Also handles nicknames (Ben → Benjamin, etc.).
  if (unclaimedAppts.length > 0 && parsed.senderName) {
    const senderNorm = normalize(parsed.senderName);
    for (const apt of unclaimedAppts) {
      const titleNorm = normalize(apt.title);
      if (!titleNorm) continue;
      if (titleNorm.includes(senderNorm) || senderNorm.includes(titleNorm)) {
        contactId = apt.contactId || null;
        console.log(`  [VenmoBarber] Appointment title match: "${parsed.senderName}" → "${apt.title}" (contact: ${contactId})`);
        break;
      }
      if (namesMatch(senderNorm, titleNorm)) {
        contactId = apt.contactId || null;
        console.log(`  [VenmoBarber] Appointment nickname match: "${parsed.senderName}" → "${apt.title}" (contact: ${contactId})`);
        break;
      }
    }
  }

  // Strategy 2: GHL contact search (if appointment title match didn't work)
  if (!contactId && ghlBarber && parsed.senderName) {
    try {
      const result = await ghlBarber.contacts.getContacts({
        locationId: BARBER_LOCATION_ID,
        query: parsed.senderName,
        limit: 5,
      });

      const contacts = result?.contacts || [];
      if (contacts.length > 0) {
        const senderLower = parsed.senderName.toLowerCase().trim();
        const exactMatch = contacts.find((c) => {
          const fullName = `${c.firstName || ""} ${c.lastName || ""}`.trim().toLowerCase();
          return fullName === senderLower;
        });

        if (exactMatch) {
          contactId = exactMatch.id;
          console.log(`  [VenmoBarber] Exact name match: ${exactMatch.firstName} ${exactMatch.lastName} (${contactId})`);
        } else if (contacts.length === 1) {
          contactId = contacts[0].id;
          console.log(`  [VenmoBarber] Single result match: ${contacts[0].firstName} ${contacts[0].lastName} (${contactId})`);
        } else {
          // Multiple results, try first+last name substring match
          const senderParts = senderLower.split(/\s+/);
          if (senderParts.length >= 2) {
            const firstName = senderParts[0];
            const lastName = senderParts[senderParts.length - 1];
            const partialMatch = contacts.find((c) => {
              const fn = (c.firstName || "").toLowerCase();
              const ln = (c.lastName || "").toLowerCase();
              return fn === firstName && ln === lastName;
            });
            if (partialMatch) {
              contactId = partialMatch.id;
              console.log(`  [VenmoBarber] First+last match: ${partialMatch.firstName} ${partialMatch.lastName} (${contactId})`);
            }
          }
        }

        if (!contactId) {
          console.log(`  [VenmoBarber] ${contacts.length} results but no confident match for "${parsed.senderName}"`);
        }
      } else {
        console.log(`  [VenmoBarber] No GHL contacts found for "${parsed.senderName}"`);
      }

      // Fallback: Venmo names are often abbreviated (e.g., "Pablo RP" for "Pablo Ruiz Plaza").
      // If full-name search failed, try first-name-only and cross-reference with day's appointments.
      if (!contactId && parsed.senderName.includes(" ")) {
        const firstName = parsed.senderName.split(/\s+/)[0];
        const firstNameResult = await ghlBarber.contacts.getContacts({
          locationId: BARBER_LOCATION_ID,
          query: firstName,
          limit: 10,
        });
        const firstNameContacts = firstNameResult?.contacts || [];
        if (firstNameContacts.length > 0 && unclaimedAppts.length > 0) {
          const apptContactIds = new Set(unclaimedAppts.map((a) => a.contactId).filter(Boolean));
          const apptMatch = firstNameContacts.find((c) => apptContactIds.has(c.id));
          if (apptMatch) {
            contactId = apptMatch.id;
            console.log(`  [VenmoBarber] First-name fallback matched "${parsed.senderName}" → ${apptMatch.firstName} ${apptMatch.lastName} (${contactId}) via appointment cross-ref`);
          }
        }
      }
    } catch (err) {
      console.warn(`  [VenmoBarber] Contact search failed: ${err.message}`);
    }
  }

  // Step 5: Appointment matching
  if (unclaimedAppts.length > 0) {
    if (contactId) {
      // We found a GHL contact — only match to THEIR appointment, never a stranger's
      const contactAppt = unclaimedAppts.find((apt) => apt.contactId === contactId);
      if (contactAppt) {
        appointmentId = contactAppt.id;
        calendarId = contactAppt.calendarId || null;
        console.log(`  [VenmoBarber] Matched to contact's appointment: ${appointmentId}`);
      }
      // If their appointment is already claimed or doesn't exist, leave as unmatched
    } else if (unclaimedAppts.length > 0) {
      // No GHL contact found at all — use distance-from-end scoring as a best guess.
      // Same logic as Square batch matching: 10-min grace period, 45-min max threshold.
      const MAX_MATCH_DISTANCE_MIN = 45;
      const GRACE_PERIOD_MS = 10 * 60 * 1000;
      const paymentMs = (parsed.date || new Date()).getTime();
      let bestApt = null;
      let bestScore = Infinity;
      for (const apt of unclaimedAppts) {
        const aptStart = new Date(apt.startTime);
        const aptEnd = apt.endTime ? new Date(apt.endTime) : new Date(aptStart.getTime() + 60 * 60 * 1000);
        const graceStart = new Date(aptEnd.getTime() - GRACE_PERIOD_MS);
        let score;
        if (paymentMs >= graceStart.getTime()) {
          score = Math.abs(paymentMs - aptEnd.getTime()) / 60000;
        } else {
          score = 1000 + (aptEnd.getTime() - paymentMs) / 60000;
        }
        if (score < bestScore) {
          bestScore = score;
          bestApt = apt;
        }
      }
      if (bestApt && bestScore <= MAX_MATCH_DISTANCE_MIN) {
        appointmentId = bestApt.id;
        calendarId = bestApt.calendarId || null;
        if (bestApt.contactId) {
          contactId = bestApt.contactId;
        }
        console.log(`  [VenmoBarber] Distance-from-end match: appointment ${appointmentId} (score: ${bestScore.toFixed(1)} min)`);
      }
    }
  }

  // Step 6: Calculate service/tip split using calendar price when available
  const { lookupServicePrice } = require("../config/barberServicePrices");
  const calendarPrice = calendarId ? await lookupServicePrice(calendarId) : null;
  let servicePrice, tipAmount;
  if (calendarPrice && parsed.amount >= calendarPrice) {
    servicePrice = calendarPrice;
    tipAmount = +(parsed.amount - calendarPrice).toFixed(2);
  } else {
    servicePrice = parsed.amount;
    tipAmount = 0;
  }

  // Step 7: Record to Supabase
  const { error } = await supabase.from("transactions").insert({
    contact_id: contactId || "venmo_unmatched",
    contact_name: contactName || parsed.senderName,
    appointment_id: appointmentId || null,
    artist_ghl_id: barberGhlId,
    transaction_type: "session_payment",
    payment_method: "venmo",
    payment_recipient: "artist_direct",
    gross_amount: parsed.amount,
    shop_percentage: 0,
    artist_percentage: 100,
    shop_amount: 0,
    artist_amount: parsed.amount,
    settlement_status: "settled",
    venmo_transaction_id: venmoTxId,
    session_date: localDate,
    location_id: BARBER_LOCATION_ID,
    notes: parsed.note || null,
    calendar_id: calendarId || null,
    service_price: servicePrice,
    tip_amount: tipAmount,
    venmo_story_url: parsed.storyUrl || null,
    venmo_profile_pic_url: parsed.profilePicUrl || null,
    square_payment_time: parsed.date ? parsed.date.toISOString() : null,
  });

  if (error) {
    console.error(`  [VenmoBarber] Supabase insert failed:`, error.message);
    return { error: "insert-failed", message: error.message };
  }

  const matched = !!contactId && contactId !== "venmo_unmatched";
  console.log(
    `  [VenmoBarber] ✅ Recorded: $${parsed.amount} from ${contactName}` +
    (matched ? ` (contact: ${contactId})` : " (unmatched)") +
    (appointmentId ? ` → apt: ${appointmentId}` : "")
  );

  // Mirror to InstantDB for rent tracker income view (non-fatal)
  try {
    const { writeServiceIncome } = require("../rentTracker/serviceIncomeWriter");
    const { weekOfDate } = require("../rentTracker/tenantMatcher");
    await writeServiceIncome({
      senderName: contactName || parsed.senderName,
      amount: parsed.amount,
      method: "venmo",
      type: "service",
      paidAt: paymentDate,
      notes: parsed.note || null,
      venmoTxId,
      weekOf: weekOfDate(paymentDate),
      location: "barbershop",
      tipAmount: 0,
      servicePriceAmount: parsed.amount,
      barberGhlId,
    });
  } catch (err) {
    console.warn(`  [VenmoBarber] InstantDB write failed (non-fatal): ${err.message}`);
  }

  return { recorded: true, matched, contactName, appointmentId, venmoTxId };
}

module.exports = { handleBarberVenmoPayment };
