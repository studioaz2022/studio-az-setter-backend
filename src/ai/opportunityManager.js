const { getContact, updateSystemFields } = require("../../ghlClient");
const {
  upsertOpportunity,
  updateOpportunityStage,
  updateOpportunityValue,
  getOpportunitiesByContact,
  addOpportunityNote,
} = require("../clients/ghlOpportunityClient");
const { PIPELINE_STAGE_ORDER, PIPELINE_STAGE_CONFIG, getStageId } = require("../config/pipelineConfig");
const { AI_PHASES, OPPORTUNITY_STAGES } = require("../config/constants");

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
    const name =
      contactRecord.firstName || contactRecord.first_name
        ? `${contactRecord.firstName || contactRecord.first_name} Tattoo`
        : "Tattoo Opportunity";

    const upserted = await upsertOpportunity({
      contactId,
      pipelineStageId: stageId,
      name,
    });

    const createdOpp = upserted?.opportunity || upserted;
    opportunityId = createdOpp?.id || createdOpp?._id;
    opportunityStage = getStageKeyFromId(createdOpp?.pipelineStageId) || stageKey;
  }

  if (opportunityId) {
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
  const { contact: providedContact, allowRegression = false, monetaryValue, note, status } = options;
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
  }

  let updatedStageKey = stageKey;
  let updatedOpportunityId = opportunityId;

  try {
    const name =
      contact?.firstName || contact?.first_name
        ? `${contact.firstName || contact.first_name} Tattoo`
        : "Tattoo Opportunity";

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

module.exports = {
  ensureOpportunity,
  transitionToStage,
  determineStageFromContext,
  syncOpportunityStageFromContact,
  syncPipelineOnEntry,
  advanceFromIntakeToDiscovery,
  getStageKeyFromId,
  boolField,
  normalizeCustomFields,
};

