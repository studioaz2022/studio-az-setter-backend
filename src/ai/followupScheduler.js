// followupScheduler.js
// Automated follow-up cadence system for leads

const { getContact, updateSystemFields, sendConversationMessage } = require("../../ghlClient");
const { generateOpenerForContact } = require("./aiClient");
const { LEAD_TEMPERATURES, SYSTEM_FIELDS, AI_PHASES, CALENDARS, HOLD_CONFIG, APPOINTMENT_STATUS } = require("../config/constants");
const { buildCanonicalState, derivePhaseFromFields, computeLastSeenDiff } = require("./phaseContract");
const { buildContactProfile } = require("./contextBuilder");
const {
  getConsultAppointmentsForContact,
  updateAppointmentStatus,
} = require("../clients/ghlCalendarClient");
const { formatSlotDisplay } = require("./bookingController");

/**
 * Calculate follow-up cadence based on lead temperature and days since last message
 * Returns the number of follow-ups allowed for the given day
 */
function getFollowUpCadence(leadTemperature, daysSinceLastMessage) {
  const cadence = {
    [LEAD_TEMPERATURES.HOT]: {
      0: 3, // Day 1: up to 3 nudges
      1: 2, // Day 2: up to 2 per day
      2: 2, // Day 3: up to 2 per day
      3: 1, // Day 4: 1 per day
      4: 1,
      5: 1,
      6: 1,
      default: 0, // After day 7, very light occasional reactivation
    },
    [LEAD_TEMPERATURES.WARM]: {
      0: 2, // Day 1: up to 2 nudges
      1: 1, // Day 2-3: 1-2 per day
      2: 1,
      3: 1, // Day 4-7: 1 per day
      4: 1,
      5: 1,
      6: 1,
      default: 0, // Weekly after that
    },
    [LEAD_TEMPERATURES.COLD]: {
      0: 1, // Day 1: 1 nudge
      1: 0, // Day 2-3: occasional
      2: 0,
      3: 0, // Day 4-7: occasional
      4: 0,
      5: 0,
      6: 0,
      default: 0, // Longer nurture (7-30 days), very light
    },
  };

  const tempCadence = cadence[leadTemperature] || cadence[LEAD_TEMPERATURES.WARM];
  return tempCadence[daysSinceLastMessage] !== undefined
    ? tempCadence[daysSinceLastMessage]
    : tempCadence.default;
}

/**
 * Check if follow-ups should stop (e.g., deposit paid, lead disqualified)
 */
function shouldStopFollowUps(contact) {
  const cf = contact.customField || contact.customFields || {};
  const depositPaid = cf[SYSTEM_FIELDS.DEPOSIT_PAID] === "Yes" || cf[SYSTEM_FIELDS.DEPOSIT_PAID] === true;
  const leadTemp = cf[SYSTEM_FIELDS.LEAD_TEMPERATURE];
  const disqualified = leadTemp === LEAD_TEMPERATURES.DISQUALIFIED;

  return depositPaid || disqualified;
}

/**
 * Generate a follow-up message for a lead
 */
async function generateFollowUpMessage({ contact, leadTemperature, daysSinceLastMessage }) {
  const canonicalState = buildCanonicalState(contact);
  const derivedPhase = derivePhaseFromFields(canonicalState) || AI_PHASES.REENGAGEMENT;
  const { changedFields } = computeLastSeenDiff(
    canonicalState,
    canonicalState.lastSeenSnapshot || {}
  );
  const contactProfile = buildContactProfile(canonicalState, {
    changedFields,
    derivedPhase,
  });

  const aiPhase = derivedPhase || AI_PHASES.REENGAGEMENT;

  // Generate reengagement message
  const aiResult = await generateOpenerForContact({
    contact,
    canonicalState,
    aiPhase: aiPhase || AI_PHASES.REENGAGEMENT,
    leadTemperature,
    contactProfile,
  });

  return aiResult;
}

/**
 * Process appointment hold reminders and cancellations
 * Checks for pending appointments and sends reminders or cancels them
 */
async function processAppointmentHoldsForContact(contactId) {
  try {
    const contact = await getContact(contactId);
    if (!contact) {
      console.warn(`⚠️ Contact ${contactId} not found for appointment hold processing`);
      return;
    }

    // Check if deposit is paid - if so, no need to process holds
    const cf = contact.customField || contact.customFields || {};
    const depositPaid = cf[SYSTEM_FIELDS.DEPOSIT_PAID] === "Yes" || cf[SYSTEM_FIELDS.DEPOSIT_PAID] === true;

    if (depositPaid) {
      console.log(`ℹ️ Deposit paid for contact ${contactId}, skipping appointment hold processing`);
      return;
    }

    // Get consult appointments
    const consultCalendarIds = Object.values(CALENDARS);
    const consultAppointments = await getConsultAppointmentsForContact(
      contactId,
      consultCalendarIds
    );

    // Filter for pending appointments (status = "new")
    const pendingAppointments = consultAppointments.filter(
      (apt) => apt.appointmentStatus === APPOINTMENT_STATUS.NEW
    );

    if (pendingAppointments.length === 0) {
      return; // No pending appointments
    }

    const now = new Date();

    for (const appointment of pendingAppointments) {
      const dateAdded = new Date(appointment.dateAdded);
      const holdExpiresAt = new Date(dateAdded.getTime() + HOLD_CONFIG.HOLD_MINUTES * 60 * 1000);
      const finalReminderAt = new Date(
        holdExpiresAt.getTime() - HOLD_CONFIG.FINAL_REMINDER_MINUTES_BEFORE_EXPIRY * 60 * 1000
      );

      // Check if we're in the final reminder window
      if (now >= finalReminderAt && now < holdExpiresAt) {
        // Send final reminder
        const slotDisplay = formatSlotDisplay(new Date(appointment.startTime));
        const reminderMessage = `Quick reminder: We're still holding your ${slotDisplay} consultation slot. To keep it, please complete the $100 refundable deposit now. Otherwise, we may have to release the time for other clients.`;

        const hasPhone = !!(contact.phone || contact.phoneNumber);
        const tags = contact.tags || [];
        const isDm = tags.some((t) =>
          typeof t === "string" &&
          (t.includes("INSTAGRAM") || t.includes("FACEBOOK") || t.includes("DM"))
        );

        const channelContext = {
          isDm,
          hasPhone,
          conversationId: null,
          phone: contact.phone || contact.phoneNumber || null,
        };

        await sendConversationMessage({
          contactId,
          body: reminderMessage,
          channelContext,
        });

        console.log(`📅 Sent final reminder for appointment ${appointment.id}`);
      }

      // Check if hold has expired
      if (now >= holdExpiresAt) {
        // Cancel the appointment
        try {
          await updateAppointmentStatus(appointment.id, APPOINTMENT_STATUS.CANCELLED);

          const slotDisplay = formatSlotDisplay(new Date(appointment.startTime));
          const cancelMessage = `We had to release your ${slotDisplay} consultation slot since we didn't receive the deposit. No worries though - we can help you find another time that works if you're still interested!`;

          const hasPhone = !!(contact.phone || contact.phoneNumber);
          const tags = contact.tags || [];
          const isDm = tags.some((t) =>
            typeof t === "string" &&
            (t.includes("INSTAGRAM") || t.includes("FACEBOOK") || t.includes("DM"))
          );

          const channelContext = {
            isDm,
            hasPhone,
            conversationId: null,
            phone: contact.phone || contact.phoneNumber || null,
          };

          await sendConversationMessage({
            contactId,
            body: cancelMessage,
            channelContext,
          });

          console.log(`📅 Cancelled expired appointment ${appointment.id}`);
        } catch (cancelErr) {
          console.error(`❌ Error cancelling appointment ${appointment.id}:`, cancelErr.message || cancelErr);
        }
      }
    }
  } catch (err) {
    console.error(`❌ Error processing appointment holds for contact ${contactId}:`, err.message || err);
    throw err;
  }
}

/**
 * Schedule and send follow-up messages for a contact
 * This should be called by a scheduled job (cron) or queue system
 */
async function processFollowUpsForContact(contactId) {
  try {
    // First, process appointment holds
    await processAppointmentHoldsForContact(contactId);

    const contact = await getContact(contactId);
    if (!contact) {
      console.warn(`⚠️ Contact ${contactId} not found for follow-up processing`);
      return;
    }

    // Check if follow-ups should stop
    if (shouldStopFollowUps(contact)) {
      console.log(`ℹ️ Follow-ups stopped for contact ${contactId} (deposit paid or disqualified)`);
      return;
    }

    const cf = contact.customField || contact.customFields || {};
    const leadTemperature = cf[SYSTEM_FIELDS.LEAD_TEMPERATURE] || LEAD_TEMPERATURES.WARM;
    const lastPhaseUpdateAt = cf[SYSTEM_FIELDS.LAST_PHASE_UPDATE_AT];

    if (!lastPhaseUpdateAt) {
      console.warn(`⚠️ No last_phase_update_at for contact ${contactId}, skipping follow-up`);
      return;
    }

    // Calculate days since last message
    const lastUpdate = new Date(lastPhaseUpdateAt);
    const now = new Date();
    const daysSinceLastMessage = Math.floor((now - lastUpdate) / (1000 * 60 * 60 * 24));

    // Check cadence
    const allowedFollowUps = getFollowUpCadence(leadTemperature, daysSinceLastMessage);
    if (allowedFollowUps === 0) {
      console.log(`ℹ️ No follow-ups scheduled for contact ${contactId} (day ${daysSinceLastMessage}, cadence: 0)`);
      return;
    }

    // Generate and send follow-up message
    const aiResult = await generateFollowUpMessage({
      contact,
      leadTemperature,
      daysSinceLastMessage,
    });

    if (aiResult && Array.isArray(aiResult.bubbles)) {
      const bubblesToSend = aiResult.bubbles
        .map((b) => (b || "").trim())
        .filter(Boolean)
        .slice(0, 1); // Keep follow-ups short (1 bubble)

      if (bubblesToSend.length > 0) {
        // Build channel context (infer from contact)
        const hasPhone = !!(contact.phone || contact.phoneNumber);
        const tags = contact.tags || [];
        const isDm = tags.some((t) =>
          typeof t === "string" && (t.includes("INSTAGRAM") || t.includes("FACEBOOK") || t.includes("DM"))
        );

        const channelContext = {
          isDm,
          hasPhone,
          conversationId: null,
          phone: contact.phone || contact.phoneNumber || null,
        };

        for (const text of bubblesToSend) {
          await sendConversationMessage({
            contactId,
            body: text,
            channelContext,
          });
        }

        // Update last_phase_update_at
        await updateSystemFields(contactId, {
          [SYSTEM_FIELDS.LAST_PHASE_UPDATE_AT]: new Date().toISOString(),
        });

        console.log(`✅ Sent follow-up message to contact ${contactId}`);
      }
    }
  } catch (err) {
    console.error(`❌ Error processing follow-ups for contact ${contactId}:`, err.message || err);
    throw err;
  }
}

/**
 * Get all contacts that need follow-ups
 * This should query GHL for contacts matching criteria:
 * - deposit_link_sent = true
 * - deposit_paid = false
 * - last_phase_update_at is within follow-up window
 * - lead_temperature is not disqualified
 */
async function getContactsNeedingFollowUps() {
  // TODO: Implement GHL query/API call to get contacts matching follow-up criteria
  // For now, this is a placeholder
  console.warn("⚠️ getContactsNeedingFollowUps() not yet implemented - requires GHL query API");
  return [];
}

module.exports = {
  getFollowUpCadence,
  shouldStopFollowUps,
  generateFollowUpMessage,
  processFollowUpsForContact,
  processAppointmentHoldsForContact,
  getContactsNeedingFollowUps,
};

