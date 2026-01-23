const { getContact, updateSystemFields, getConversationHistory } = require("../clients/ghlClient");
const {
  upsertOpportunity,
  updateOpportunityStage,
  updateOpportunityValue,
  getOpportunitiesByContact,
  addOpportunityNote,
  getOpportunity,
  updateOpportunity,
} = require("../clients/ghlOpportunityClient");
const { PIPELINE_STAGE_ORDER, PIPELINE_STAGE_CONFIG, getStageId } = require("../config/pipelineConfig");
const { AI_PHASES, OPPORTUNITY_STAGES, SYSTEM_FIELDS } = require("../config/constants");
const {
  generateComprehensiveConversationSummary,
  appendToConversationHistory
} = require("./contextBuilder");
const { notifyPhaseChanged } = require("../clients/appEventClient");

const STAGE_RANK = PIPELINE_STAGE_ORDER.reduce((acc, key, idx) => {
  acc[key] = idx;
  return acc;
}, {});

function getStageKeyFromId(stageId) {
  if (!stageId) return null;
  return Object.keys(PIPELINE_STAGE_CONFIG).find(key => PIPELINE_STAGE_CONFIG[key].id === stageId) || null;
}

function canAdvance(currentKey, targetKey, { allowRegression = false } = {}) {
  if (!currentKey) return true;
  if (allowRegression) return true;

  const currentRank = STAGE_RANK[currentKey];
  const targetRank = STAGE_RANK[targetKey];
  if (typeof currentRank !== "number" || typeof targetRank !== "number") {
    return true;
  }
  return targetRank >= currentRank;
}

function normalizeCustomFields(raw) {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    return raw.reduce((acc, field) => {
      if (field?.id) {
        acc[field.id] = field.value;
      } else if (field?.key) {
        acc[field.key] = field.value;
      }
      return acc;
    }, {});
  }
  return raw;
}

function boolField(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.toLowerCase() === "yes" || value.toLowerCase() === "true";
  }
  if (typeof value === "number") return value === 1;
  return false;
}

async function findExistingOpportunity(contactId) {
  try {
    const opportunities = await getOpportunitiesByContact({ contactId });
    return opportunities?.[0] || null;
  } catch (err) {
    console.warn(
      `⚠️ [PIPELINE] getOpportunitiesByContact failed; will create a new opportunity for ${contactId}:`,
      err.response?.data || err.message || err
    );
    return null;
  }
}

/**
 * Update opportunity name if it's still the fallback "Tattoo Opportunity"
 * and we now have the contact's name
 */
async function updateOpportunityNameIfNeeded({ opportunityId, contact }) {
  if (!opportunityId || !contact) return;

  try {
    // Get current opportunity to check its name
    const currentOpp = await getOpportunity(opportunityId);
    const currentName = currentOpp?.opportunity?.name || currentOpp?.name || "";

    // If it's still the fallback name, update it
    if (currentName === "Tattoo Opportunity") {
      const firstName = contact?.firstName || contact?.first_name || "";
      const lastName = contact?.lastName || contact?.last_name || "";
      const newName = `${firstName} ${lastName}`.trim();

      // Only update if we have a name
      if (newName && newName !== "Tattoo Opportunity") {
        await updateOpportunity(opportunityId, { name: newName });
        console.log(`📝 [PIPELINE] Updated opportunity ${opportunityId} name from "Tattoo Opportunity" to "${newName}"`);
      }
    }
  } catch (err) {
    // Don't fail the whole operation if name update fails
    console.warn(`⚠️ [PIPELINE] Failed to update opportunity name for ${opportunityId}:`, err.message || err);
  }
}

async function ensureOpportunity({ contactId, stageKey = OPPORTUNITY_STAGES.INTAKE, contact = null }) {
  const contactRecord = contact || (await getContact(contactId));
  if (!contactRecord) {
    throw new Error(`Unable to load contact ${contactId} when ensuring opportunity`);
  }

  const cf = normalizeCustomFields(contactRecord.customField || contactRecord.customFields);
  let opportunityId = cf.opportunity_id;
  let opportunityStage = cf.opportunity_stage;

  if (!opportunityId) {
    const existing = await findExistingOpportunity(contactId);
    if (existing) {
      opportunityId = existing.id || existing._id;
      opportunityStage = getStageKeyFromId(existing.pipelineStageId);
    }
  }

  if (!opportunityId) {
    const stageId = getStageId(stageKey) || getStageId("INTAKE");
    // Opportunity name is just first + last name
    const firstName = contactRecord.firstName || contactRecord.first_name || "";
    const lastName = contactRecord.lastName || contactRecord.last_name || "";
    const name = `${firstName} ${lastName}`.trim() || "Tattoo Opportunity";

    const upserted = await upsertOpportunity({
      contactId,
      pipelineStageId: stageId,
      name,
    });

    const createdOpp = upserted?.opportunity || upserted;
    opportunityId = createdOpp?.id || createdOpp?._id;
    opportunityStage = getStageKeyFromId(createdOpp?.pipelineStageId) || stageKey;
  }

  // Update opportunity name if it's still the fallback and we now have a name
  if (opportunityId) {
    await updateOpportunityNameIfNeeded({ opportunityId, contact: contactRecord });
    
    await updateSystemFields(contactId, {
      opportunity_id: opportunityId,
      opportunity_stage: opportunityStage || stageKey,
    });
  }

  return {
    contact: contactRecord,
    opportunityId,
    currentStage: opportunityStage,
  };
}

async function transitionToStage(contactId, stageKey, options = {}) {
  if (!stageKey) return null;
  const { contact: providedContact, allowRegression = false, monetaryValue, note, status, skipCompletionArchive = false } = options;
  const { contact, opportunityId, currentStage } = await ensureOpportunity({
    contactId,
    stageKey,
    contact: providedContact,
  });

  if (!opportunityId) {
    console.warn(`⚠️ [PIPELINE] No opportunity for contact ${contactId}, skipping stage transition to ${stageKey}`);
    return null;
  }

  const canMove = canAdvance(currentStage, stageKey, { allowRegression });
  if (!canMove) {
    return { skipped: true, reason: "stage_regression", opportunityId, currentStage };
  }

  const stageId = getStageId(stageKey);
  if (!stageId) {
    console.warn(`⚠️ [PIPELINE] Unknown pipeline stage key ${stageKey}`);
    return null;
  }

  // Only log actual transitions (not when staying the same)
  if (currentStage !== stageKey) {
    console.log(`📊 [PIPELINE] Transitioning opportunity ${opportunityId}: ${currentStage || "(none)"} → ${stageKey}`);

    // === NOTIFY iOS APP: Phase/stage changed ===
    const cf = contact?.customField || contact?.customFields || {};
    const leadTemperature = cf.lead_temperature || null;
    notifyPhaseChanged(contactId, {
      previousPhase: currentStage || null,
      newPhase: stageKey,
      leadTemperature,
    }).catch(err => {
      // Don't fail the transition if notification fails
      console.warn(`⚠️ [APP EVENT] Failed to notify phase change:`, err.message || err);
    });
  }

  // Handle tattoo completion - archive conversation when moving to COMPLETED
  if (stageKey === OPPORTUNITY_STAGES.COMPLETED && currentStage !== OPPORTUNITY_STAGES.COMPLETED && !skipCompletionArchive) {
    console.log(`🎉 [PIPELINE] Tattoo marked as complete - archiving conversation...`);
    try {
      // Note: handleTattooCompletion is called after the transition completes
      // We defer this to avoid circular dependency issues
      setTimeout(async () => {
        try {
          const { generateComprehensiveConversationSummary: genSummary, appendToConversationHistory: appendSummary } = require("./contextBuilder");
          const { getConversationHistory: getHistory } = require("../clients/ghlClient");
          
          const cf = contact?.customField || contact?.customFields || {};
          
          // Fetch full conversation history
          const allMessages = await getHistory(contactId, { limit: 500, sortOrder: "desc" });
          
          const crmFields = {
            tattoo_summary: cf.tattoo_summary || null,
            tattoo_placement: cf.tattoo_placement || null,
            tattoo_style: cf.tattoo_style || null,
            tattoo_size: cf.tattoo_size || null,
            tattoo_color_preference: cf.tattoo_color_preference || null,
            assigned_artist: cf.assigned_artist || null,
            inquired_technician: cf.inquired_technician || null,
            consultation_type: cf.consultation_type || null,
            language_preference: cf.language_preference || null,
          };
          
          const completedAt = new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
          const newSummary = genSummary(allMessages, crmFields, { completedAt });
          const existingSummary = cf[SYSTEM_FIELDS.PREVIOUS_CONVERSATION_SUMMARY] || "";
          const combinedSummary = appendSummary(existingSummary, newSummary);
          
          const currentCount = parseInt(cf.total_tattoos_completed || "0", 10) || 0;
          
          await updateSystemFields(contactId, {
            [SYSTEM_FIELDS.PREVIOUS_CONVERSATION_SUMMARY]: combinedSummary,
            [SYSTEM_FIELDS.LAST_TATTOO_COMPLETED_AT]: new Date().toISOString(),
            [SYSTEM_FIELDS.RETURNING_CLIENT]: true,
            total_tattoos_completed: String(currentCount + 1),
          });
          
          console.log(`✅ [COMPLETION] Archived ${allMessages.length} messages for contact ${contactId}`);
        } catch (archiveErr) {
          console.error(`❌ [COMPLETION] Failed to archive conversation:`, archiveErr.message);
        }
      }, 100);
    } catch (err) {
      console.error(`❌ [COMPLETION] Error initiating archive:`, err.message);
    }
  }

  let updatedStageKey = stageKey;
  let updatedOpportunityId = opportunityId;

  try {
    // Opportunity name is just first + last name
    const firstName = contact?.firstName || contact?.first_name || "";
    const lastName = contact?.lastName || contact?.last_name || "";
    const name = `${firstName} ${lastName}`.trim() || "Tattoo Opportunity";

    const upserted = await upsertOpportunity({
      contactId,
      pipelineStageId: stageId,
      status,
      monetaryValue: typeof monetaryValue === "number" ? monetaryValue : undefined,
      name,
    });

    const opp = upserted?.opportunity || upserted;
    updatedOpportunityId = opp?.id || opp?._id || updatedOpportunityId;
    const returnedStageKey = getStageKeyFromId(opp?.pipelineStageId);
    if (returnedStageKey) {
      updatedStageKey = returnedStageKey;
    }
  } catch (err) {
    console.error(
      `❌ [PIPELINE] upsertOpportunity failed for contact ${contactId}:`,
      err.message || err
    );
    if (err.response?.data) {
      console.error("❌ [PIPELINE] GHL response:", err.response.status, err.response.data);
    }

    if (!opportunityId) {
      throw err;
    }

    await updateOpportunityStage({
      opportunityId,
      pipelineStageId: stageId,
      status,
    });

    if (typeof monetaryValue === "number") {
      await updateOpportunityValue({ opportunityId, monetaryValue });
    }
  }

  // Update opportunity name if it's still the fallback and we now have a name
  if (updatedOpportunityId && contact) {
    await updateOpportunityNameIfNeeded({ opportunityId: updatedOpportunityId, contact });
  }

  if (note) {
    await addOpportunityNote({ opportunityId: updatedOpportunityId, content: note });
  }

  await updateSystemFields(contactId, {
    opportunity_stage: updatedStageKey,
    opportunity_id: updatedOpportunityId,
  });

  return { opportunityId: updatedOpportunityId, stageKey: updatedStageKey };
}

function determineStageFromContext({
  aiPhase,
  depositLinkSent = false,
  depositPaid = false,
  consultType = null,
  hasUpcomingTattoo = false,
  tattooCompleted = false,
  lost = false,
}) {
  if (tattooCompleted) return OPPORTUNITY_STAGES.COMPLETED;
  if (lost) return OPPORTUNITY_STAGES.COLD_NURTURE_LOST;
  if (hasUpcomingTattoo) return OPPORTUNITY_STAGES.TATTOO_BOOKED;
  if (consultType === "message") return OPPORTUNITY_STAGES.CONSULT_MESSAGE;
  if (consultType === "appointment" || consultType === "online" || consultType === "in_person")
    return OPPORTUNITY_STAGES.CONSULT_APPOINTMENT;
  if (depositPaid) return OPPORTUNITY_STAGES.QUALIFIED;
  if (depositLinkSent) return OPPORTUNITY_STAGES.DEPOSIT_PENDING;
  if (aiPhase === AI_PHASES.DISCOVERY) return OPPORTUNITY_STAGES.DISCOVERY;
  return OPPORTUNITY_STAGES.INTAKE;
}

/**
 * Sync pipeline stage based on current contact fields.
 * Optionally provide fieldOverrides to reflect just-updated fields that may not
 * yet be visible from getContact (avoids stale reads / eventual consistency).
 */
async function syncOpportunityStageFromContact(contactId, { aiPhase, fieldOverrides = {} }) {
  const contact = await getContact(contactId);
  if (!contact) return null;

  // Merge overrides (lower precedence to live contact so we don't clobber real data)
  const cf = {
    ...normalizeCustomFields(contact.customField || contact.customFields),
    ...fieldOverrides,
  };
  const depositLinkSent = boolField(cf.deposit_link_sent);
  const depositPaid = boolField(cf.deposit_paid);
  const consultType = cf.consultation_type || null;
  const hasUpcomingTattoo = boolField(cf.tattoo_booked);
  const tattooCompleted = boolField(cf.tattoo_completed);
  const lost = boolField(cf.cold_nurture_lost);

  const currentStage = cf.opportunity_stage || null;

  const stageKey = determineStageFromContext({
    aiPhase,
    depositLinkSent,
    depositPaid,
    consultType,
    hasUpcomingTattoo,
    tattooCompleted,
    lost,
  });

  console.log(`🔄 [PIPELINE] Syncing opportunity stage for contact ${contactId}:`, {
    currentStage: currentStage || "(none)",
    targetStage: stageKey,
    context: {
      aiPhase,
      depositLinkSent,
      depositPaid,
      consultType,
      hasUpcomingTattoo,
      tattooCompleted,
      lost,
    },
  });

  const result = await transitionToStage(contactId, stageKey, { contact });

  if (result && !result.skipped && currentStage !== stageKey) {
    console.log(`✅ [PIPELINE] Stage transition: ${currentStage || "(none)"} → ${stageKey} (contact: ${contactId})`);
  } else if (result && result.skipped) {
    console.log(`⏭️ [PIPELINE] Stage transition skipped: ${result.reason} (current: ${currentStage}, target: ${stageKey})`);
  } else if (currentStage === stageKey) {
    console.log(`ℹ️ [PIPELINE] Stage unchanged: ${stageKey} (contact: ${contactId})`);
  }

  return result;
}

/**
 * Sync pipeline stage for lead entry based on channel type.
 * - SMS, DM (Facebook/Instagram), WhatsApp → Start at DISCOVERY
 * - Widget/Form → Start at INTAKE
 */
async function syncPipelineOnEntry(contactId, { channelType, isFirstMessage = true, contact = null }) {
  if (!contactId) return null;

  // Determine entry stage based on channel
  let entryStage;
  const directChannels = ["sms", "dm", "facebook", "instagram", "whatsapp", "messenger"];
  
  if (directChannels.includes(channelType?.toLowerCase())) {
    // Direct message channels start at DISCOVERY (they reached out proactively)
    entryStage = OPPORTUNITY_STAGES.DISCOVERY;
    console.log(`📊 [PIPELINE] Direct channel (${channelType}) → starting at DISCOVERY`);
  } else {
    // Widget/form submissions start at INTAKE
    entryStage = OPPORTUNITY_STAGES.INTAKE;
    console.log(`📊 [PIPELINE] Widget/form channel → starting at INTAKE`);
  }

  try {
    const result = await transitionToStage(contactId, entryStage, { contact });
    if (result && !result.skipped) {
      console.log(`✅ [PIPELINE] Entry stage set: ${entryStage} (contact: ${contactId})`);
    }
    return result;
  } catch (err) {
    console.error(`❌ [PIPELINE] Failed to set entry stage:`, err.message || err);
    return null;
  }
}

/**
 * Move a lead from INTAKE to DISCOVERY (for widget leads after first AI response)
 */
async function advanceFromIntakeToDiscovery(contactId, { contact = null } = {}) {
  if (!contactId) return null;

  const contactRecord = contact || (await getContact(contactId));
  const cf = normalizeCustomFields(contactRecord?.customField || contactRecord?.customFields || {});
  const currentStage = cf.opportunity_stage;

  // Only advance if currently at INTAKE
  if (currentStage && currentStage !== OPPORTUNITY_STAGES.INTAKE) {
    console.log(`ℹ️ [PIPELINE] Not advancing - already past INTAKE (current: ${currentStage})`);
    return null;
  }

  try {
    const result = await transitionToStage(contactId, OPPORTUNITY_STAGES.DISCOVERY, { contact: contactRecord });
    if (result && !result.skipped) {
      console.log(`✅ [PIPELINE] Advanced from INTAKE to DISCOVERY (contact: ${contactId})`);
    }
    return result;
  } catch (err) {
    console.error(`❌ [PIPELINE] Failed to advance to DISCOVERY:`, err.message || err);
    return null;
  }
}

/**
 * Handle tattoo completion - archive conversation history and prepare for next cycle.
 * Called when a lead is marked as "won" / tattoo_completed.
 * 
 * @param {string} contactId - The contact ID
 * @param {object} options - Additional options
 * @returns {Promise<object>} Result with summary and reset info
 */
async function handleTattooCompletion(contactId, { contact = null, notes = "" } = {}) {
  if (!contactId) {
    console.warn("⚠️ [COMPLETION] handleTattooCompletion called without contactId");
    return null;
  }

  console.log(`🎉 [COMPLETION] Processing tattoo completion for contact ${contactId}...`);

  try {
    // Fetch contact if not provided
    const contactRecord = contact || (await getContact(contactId));
    if (!contactRecord) {
      console.error(`❌ [COMPLETION] Could not fetch contact ${contactId}`);
      return null;
    }

    const cf = normalizeCustomFields(contactRecord.customField || contactRecord.customFields || {});

    // Fetch full conversation history (up to 500 messages for archival)
    console.log("📜 [COMPLETION] Fetching full conversation history for archival...");
    const allMessages = await getConversationHistory(contactId, {
      limit: 500, // Max for archival
      sortOrder: "desc",
    });

    console.log(`📜 [COMPLETION] Fetched ${allMessages.length} messages for summary`);

    // Build CRM fields object for the summarizer
    const crmFields = {
      tattoo_summary: cf.tattoo_summary || null,
      tattoo_placement: cf.tattoo_placement || null,
      tattoo_style: cf.tattoo_style || null,
      tattoo_size: cf.tattoo_size || null,
      tattoo_color_preference: cf.tattoo_color_preference || null,
      assigned_artist: cf.assigned_artist || null,
      inquired_technician: cf.inquired_technician || null,
      consultation_type: cf.consultation_type || null,
      language_preference: cf.language_preference || null,
    };

    // Generate comprehensive summary
    const completedAt = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });

    const newSummary = generateComprehensiveConversationSummary(allMessages, crmFields, {
      completedAt,
      notes,
    });

    console.log("📝 [COMPLETION] Generated summary:", newSummary.substring(0, 200) + "...");

    // Get existing summary (for returning clients with multiple tattoos)
    const existingSummary = cf[SYSTEM_FIELDS.PREVIOUS_CONVERSATION_SUMMARY] || "";

    // Append new summary to existing history
    const combinedSummary = appendToConversationHistory(existingSummary, newSummary);

    // Increment tattoo count
    const currentCount = parseInt(cf.total_tattoos_completed || "0", 10) || 0;
    const newCount = currentCount + 1;

    // Update fields in GHL
    const fieldsToUpdate = {
      [SYSTEM_FIELDS.PREVIOUS_CONVERSATION_SUMMARY]: combinedSummary,
      [SYSTEM_FIELDS.LAST_TATTOO_COMPLETED_AT]: new Date().toISOString(),
      [SYSTEM_FIELDS.RETURNING_CLIENT]: true,
      total_tattoos_completed: String(newCount),
      // Reset fields for next tattoo cycle
      tattoo_summary: "",
      tattoo_placement: "",
      tattoo_style: "",
      tattoo_size: "",
      tattoo_size_notes: "",
      tattoo_color_preference: "",
      tattoo_concerns: "",
      tattoo_photo_description: "",
      how_soon_is_client_deciding: "",
      first_tattoo: "",
      // Reset booking state
      deposit_link_sent: "",
      deposit_paid: "",
      deposit_link_url: "",
      times_sent: "",
      last_sent_slots: "",
      hold_appointment_id: "",
      hold_last_activity_at: "",
      hold_warning_sent: "",
      consult_explained: "",
      consultation_type: "",
      consultation_type_locked: "",
      // Reset phase
      ai_phase: "",
      lead_temperature: "",
      tattoo_completed: "",
      tattoo_booked: "",
    };

    await updateSystemFields(contactId, fieldsToUpdate);

    console.log(`✅ [COMPLETION] Archived conversation and reset fields for contact ${contactId}`);
    console.log(`📊 [COMPLETION] Client now has ${newCount} completed tattoo(s)`);

    return {
      success: true,
      summary: newSummary,
      totalTattoos: newCount,
      messagesArchived: allMessages.length,
    };
  } catch (err) {
    console.error(`❌ [COMPLETION] Error handling tattoo completion:`, err.message || err);
    return { success: false, error: err.message || String(err) };
  }
}

module.exports = {
  ensureOpportunity,
  transitionToStage,
  determineStageFromContext,
  syncOpportunityStageFromContact,
  syncPipelineOnEntry,
  advanceFromIntakeToDiscovery,
  handleTattooCompletion,
  getStageKeyFromId,
  boolField,
  normalizeCustomFields,
};

