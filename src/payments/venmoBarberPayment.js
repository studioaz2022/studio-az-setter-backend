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

  // Strategy 1: Match sender name against today's appointment titles directly.
  // This catches cases like "CJ Washington" → "C.J. Washington" where GHL search fails.
  if (unclaimedAppts.length > 0 && parsed.senderName) {
    const senderNorm = normalize(parsed.senderName);
    for (const apt of unclaimedAppts) {
      const titleNorm = normalize(apt.title);
      if (titleNorm && (titleNorm.includes(senderNorm) || senderNorm.includes(titleNorm))) {
        contactId = apt.contactId || null;
        console.log(`  [VenmoBarber] Appointment title match: "${parsed.senderName}" → "${apt.title}" (contact: ${contactId})`);
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
      // No GHL contact found at all — use time proximity as a best guess
      const proximityAppt = unclaimedAppts[0];
      appointmentId = proximityAppt.id;
      calendarId = proximityAppt.calendarId || null;

      if (proximityAppt.contactId) {
        contactId = proximityAppt.contactId;
      }
      console.log(`  [VenmoBarber] Time-proximity match: appointment ${appointmentId}`);
    }
  }

  // Step 6: Record to Supabase
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
    service_price: parsed.amount,
    tip_amount: 0,
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
