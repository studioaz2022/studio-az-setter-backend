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

  // Step 3: Contact matching by name
  let contactId = null;
  let contactName = parsed.senderName;

  if (ghlBarber && parsed.senderName) {
    try {
      const result = await ghlBarber.contacts.getContacts({
        locationId: BARBER_LOCATION_ID,
        query: parsed.senderName,
        limit: 5,
      });

      const contacts = result?.contacts || [];
      if (contacts.length > 0) {
        // Try exact full name match first (case-insensitive)
        const senderLower = parsed.senderName.toLowerCase().trim();
        const exactMatch = contacts.find((c) => {
          const fullName = `${c.firstName || ""} ${c.lastName || ""}`.trim().toLowerCase();
          return fullName === senderLower;
        });

        if (exactMatch) {
          contactId = exactMatch.id;
          contactName = `${exactMatch.firstName || ""} ${exactMatch.lastName || ""}`.trim();
          console.log(`  [VenmoBarber] Exact name match: ${contactName} (${contactId})`);
        } else if (contacts.length === 1) {
          // Only one result — use it
          const c = contacts[0];
          contactId = c.id;
          contactName = `${c.firstName || ""} ${c.lastName || ""}`.trim();
          console.log(`  [VenmoBarber] Single result match: ${contactName} (${contactId})`);
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
              contactName = `${partialMatch.firstName || ""} ${partialMatch.lastName || ""}`.trim();
              console.log(`  [VenmoBarber] First+last match: ${contactName} (${contactId})`);
            }
          }
        }

        if (!contactId) {
          console.log(`  [VenmoBarber] ${contacts.length} results but no confident match for "${parsed.senderName}"`);
        }
      } else {
        console.log(`  [VenmoBarber] No GHL contacts found for "${parsed.senderName}"`);
      }
    } catch (err) {
      console.warn(`  [VenmoBarber] Contact search failed: ${err.message}`);
    }
  }

  // Step 4: Appointment matching
  let appointmentId = null;
  let calendarId = null;
  const paymentDate = parsed.date || new Date();
  const localDate = toLocalDate(paymentDate.toISOString());

  try {
    // Build date range for the payment day in barbershop timezone
    const dayStart = new Date(`${localDate}T00:00:00`);
    const dayEnd = new Date(`${localDate}T23:59:59`);

    const appointments = await fetchAppointmentsForDateRange({
      locationId: BARBER_LOCATION_ID,
      startTime: dayStart.toISOString(),
      endTime: dayEnd.toISOString(),
      userId: barberGhlId,
      sdkInstance: ghlBarber,
    });

    // Filter to active appointments assigned to this barber
    const activeAppts = appointments.filter(
      (apt) =>
        apt.assignedUserId === barberGhlId &&
        ["confirmed", "showed", "new"].includes(apt.appointmentStatus)
    );

    if (activeAppts.length > 0) {
      // Get already-claimed appointment IDs from existing transactions
      const { data: existingTx } = await supabase
        .from("transactions")
        .select("appointment_id")
        .eq("artist_ghl_id", barberGhlId)
        .eq("session_date", localDate)
        .not("appointment_id", "is", null);

      const claimedAptIds = new Set((existingTx || []).map((t) => t.appointment_id));
      const unclaimedAppts = activeAppts
        .filter((apt) => !claimedAptIds.has(apt.id))
        .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

      if (contactId) {
        // Try to find an appointment for this specific contact
        const contactAppt = unclaimedAppts.find((apt) => apt.contactId === contactId);
        if (contactAppt) {
          appointmentId = contactAppt.id;
          calendarId = contactAppt.calendarId || null;
          console.log(`  [VenmoBarber] Matched to contact's appointment: ${appointmentId}`);
        }
      }

      // If no contact-specific match, use time proximity (first unclaimed)
      if (!appointmentId && unclaimedAppts.length > 0) {
        const proximityAppt = unclaimedAppts[0];
        appointmentId = proximityAppt.id;
        calendarId = proximityAppt.calendarId || null;

        // If we didn't have a contact match, use the appointment's contact
        if (!contactId && proximityAppt.contactId) {
          contactId = proximityAppt.contactId;
          // Try to get the contact name from GHL
          try {
            const data = await ghlBarber.contacts.getContact({ contactId });
            const c = data?.contact || data;
            contactName = `${c.firstName || ""} ${c.lastName || ""}`.trim() || contactName;
          } catch {
            // Keep Venmo sender name
          }
        }
        console.log(`  [VenmoBarber] Time-proximity match: appointment ${appointmentId}`);
      }
    } else {
      console.log(`  [VenmoBarber] No active appointments found for ${localDate}`);
    }
  } catch (err) {
    console.warn(`  [VenmoBarber] Appointment matching failed: ${err.message}`);
  }

  // Step 5: Record to Supabase
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
