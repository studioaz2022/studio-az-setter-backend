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
  const opportunities = await getOpportunitiesByContact({ contactId });
  return opportunities?.[0] || null;
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

async function syncOpportunityStageFromContact(contactId, { aiPhase }) {
  const contact = await getContact(contactId);
  if (!contact) return null;

  const cf = normalizeCustomFields(contact.customField || contact.customFields);
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

module.exports = {
  ensureOpportunity,
  transitionToStage,
  determineStageFromContext,
  syncOpportunityStageFromContact,
  getStageKeyFromId,
  boolField,
};

