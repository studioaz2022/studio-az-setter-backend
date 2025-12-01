// followupScheduler.js
// Automated follow-up cadence system for leads

const { getContact, updateSystemFields, sendConversationMessage } = require("../../ghlClient");
const { generateOpenerForContact } = require("./aiClient");
const { LEAD_TEMPERATURES, SYSTEM_FIELDS, AI_PHASES } = require("../config/constants");

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
  // Build contact profile for AI
  const cf = contact.customField || contact.customFields || {};
  const contactProfile = {
    tattooPlacement: cf.tattoo_placement || null,
    tattooSize: cf.size_of_tattoo || null,
    tattooSummary: cf.tattoo_summary || null,
    tattooStyle: cf.tattoo_style || null,
    depositPaid: cf[SYSTEM_FIELDS.DEPOSIT_PAID] === "Yes",
    depositLinkSent: cf[SYSTEM_FIELDS.DEPOSIT_LINK_SENT] === "Yes",
  };

  const aiPhase = cf[SYSTEM_FIELDS.AI_PHASE] || AI_PHASES.REENGAGEMENT;

  // Generate reengagement message
  const aiResult = await generateOpenerForContact({
    contact,
    aiPhase: AI_PHASES.REENGAGEMENT,
    leadTemperature,
    contactProfile,
  });

  return aiResult;
}

/**
 * Schedule and send follow-up messages for a contact
 * This should be called by a scheduled job (cron) or queue system
 */
async function processFollowUpsForContact(contactId) {
  try {
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
  getContactsNeedingFollowUps,
};

