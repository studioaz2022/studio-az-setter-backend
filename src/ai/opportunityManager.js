const { getContact, updateSystemFields, getConversationHistory } = require("../clients/ghlClient");
const {
  createOpportunity,
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

// Refund Request Form §6.6 — map the funnel stage key (the *when*) to its
// human-readable analytic label. Note: a "Consult Completed" answer cannot be
// derived from pipeline stage alone (CONSULT_APPOINTMENT covers both scheduled
// and completed), so callers with that knowledge — like the refund form, which
// runs consultDidHappen() — should pass `lastStageBeforeLostOverride`.
const LAST_STAGE_LABELS = Object.freeze({
  INTAKE: "Intake",
  DISCOVERY: "Discovery",
  DEPOSIT_PENDING: "Deposit Pending",
  QUALIFIED: "Deposit Paid",
  CONSULT_APPOINTMENT: "Consult Scheduled",
  CONSULT_MESSAGE: "Consult Scheduled",
  TATTOO_BOOKED: "Tattoo Booked",
});

function deriveLastStageBeforeLost(currentStageKey) {
  if (!currentStageKey) return null;
  return LAST_STAGE_LABELS[currentStageKey] || null;
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
    // OPEN opportunities only — closed ones (won at completion, abandoned on a
    // new-idea reset) must not be reused, so a returning client's next project
    // mints a fresh opportunity at INTAKE (TATTOO_PROJECT_HISTORY_PLAN.md §14a).
    const { searchOpportunities } = require("../clients/ghlOpportunityClient");
    const opportunities = await searchOpportunities({
      query: { contactId, status: "open" },
    });
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

    // No OPEN opportunity. GHL allows only ONE opportunity per contact per
    // pipeline (verified live 2026-07-16: create returns "Can not create
    // duplicate opportunity for the contact"), so a client with a closed
    // (won/abandoned) opportunity from a past project gets it REOPENED at the
    // entry stage — a fresh funnel journey on the same opportunity object.
    // Per-project history lives in Supabase tattoo_projects, not here
    // (TATTOO_PROJECT_HISTORY_PLAN.md §3/§14a: the opportunity is plumbing).
    const anyExisting = await getOpportunitiesByContact({ contactId });
    const closedExisting = anyExisting?.[0] || null;

    if (closedExisting) {
      opportunityId = closedExisting.id || closedExisting._id;
      await updateOpportunityStage({
        opportunityId,
        pipelineStageId: stageId,
        status: "open",
      });
      opportunityStage = stageKey;
      console.log(
        `🔄 [PIPELINE] Reopened closed opportunity ${opportunityId} at ${stageKey} for returning contact ${contactId}`
      );
    } else {
      // Opportunity name is just first + last name
      const firstName = contactRecord.firstName || contactRecord.first_name || "";
      const lastName = contactRecord.lastName || contactRecord.last_name || "";
      const name = `${firstName} ${lastName}`.trim() || "Tattoo Opportunity";

      const created = await createOpportunity({
        contactId,
        pipelineStageId: stageId,
        name,
      });

      const createdOpp = created?.opportunity || created;
      opportunityId = createdOpp?.id || createdOpp?._id;
      opportunityStage = getStageKeyFromId(createdOpp?.pipelineStageId) || stageKey;
    }
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
  const {
    contact: providedContact,
    allowRegression = false,
    monetaryValue,
    note,
    status,
    skipCompletionArchive = false,
    // Lost-deal analytics (§6.6). Set on transitions to COLD_NURTURE_LOST.
    //   lastStageBeforeLostOverride — caller supplies the precise label (e.g.
    //     refund form passes "Consult Completed" derived from Fireflies). When
    //     omitted, we derive from `currentStage` via the mapping below.
    //   lostReason  — one of 9 cause-only buckets (or 'other'). See §6.6.
    //   refundType  — 'deposit_refunded' | 'partial_refund' | 'no_refund' | 'no_payment'.
    lastStageBeforeLostOverride,
    lostReason,
    refundType,
  } = options;
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

  // Handle tattoo completion — archive conversation, then snapshot the project
  // to Supabase tattoo_projects, clear the idea fields, and close the
  // opportunity as won (TATTOO_PROJECT_HISTORY_PLAN.md §10 Phase 1).
  if (stageKey === OPPORTUNITY_STAGES.COMPLETED && currentStage !== OPPORTUNITY_STAGES.COMPLETED && !skipCompletionArchive) {
    console.log(`🎉 [PIPELINE] Tattoo marked as complete - archiving conversation...`);
    try {
      // Deferred to avoid circular dependency issues
      setTimeout(async () => {
        try {
          const { generateComprehensiveConversationSummary: genSummary, appendToConversationHistory: appendSummary } = require("./contextBuilder");
          const { getConversationHistory: getHistory, getContact: getFreshContact, updateContact: updateContactRaw } = require("../clients/ghlClient");
          const projectHistory = require("../services/tattooProjectHistory");
          const {
            TATTOO_FIELD_IDS,
            SYSTEM_CONTEXT_FIELD_IDS,
          } = require("../config/tattooIdeaFields");

          // Fetch a FRESH contact — customField is keyed by FIELD ID, so all
          // reads below go through IDs (the old friendly-key reads were
          // silently undefined and archived empty CRM fields).
          const freshContact = (await getFreshContact(contactId)) || contact;
          const idea = projectHistory.readIdeaFields(freshContact);
          const readById = (id) => {
            const v = (freshContact?.customField || {})[id];
            return v == null || String(v).trim() === "" ? null : String(v);
          };

          // Fetch full conversation history
          const allMessages = await getHistory(contactId, { limit: 500, sortOrder: "desc" });

          const crmFields = {
            tattoo_summary: idea.tattoo_summary,
            tattoo_placement: idea.tattoo_placement,
            tattoo_style: idea.tattoo_style,
            tattoo_size: idea.tattoo_size,
            tattoo_color_preference: idea.tattoo_color_preference,
            assigned_artist: readById(SYSTEM_CONTEXT_FIELD_IDS.assigned_technician),
            inquired_technician: readById(TATTOO_FIELD_IDS.inquired_technician),
            consultation_type: readById(TATTOO_FIELD_IDS.consultation_type),
            language_preference: readById(TATTOO_FIELD_IDS.language_preference),
          };

          const completedAt = new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
          const newSummary = genSummary(allMessages, crmFields, { completedAt });
          const existingSummary = readById(SYSTEM_CONTEXT_FIELD_IDS.previous_conversation_summary) || "";
          const combinedSummary = appendSummary(existingSummary, newSummary);

          // Write archive fields by REAL field ID (the old key-based write
          // never landed). total_tattoos_completed is intentionally NOT
          // incremented here — the Square-fed financial path owns that count
          // (plan §9.1: single source of truth).
          await updateContactRaw(contactId, {
            customField: {
              [SYSTEM_CONTEXT_FIELD_IDS.previous_conversation_summary]: combinedSummary,
              [SYSTEM_CONTEXT_FIELD_IDS.last_tattoo_completed_at]: new Date().toISOString(),
              [SYSTEM_CONTEXT_FIELD_IDS.returning_client]: "Yes",
            },
          });

          console.log(`✅ [COMPLETION] Archived ${allMessages.length} messages for contact ${contactId}`);

          // Snapshot → clear → close-as-won (invariant: clear only after the
          // snapshot lands; see service).
          await projectHistory.handleCompletionSnapshotAndReset(contactId, {
            contact: freshContact,
            conversationSummary: newSummary,
            opportunityId: updatedOpportunityId || opportunityId || null,
          });
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
    // Update the resolved opportunity DIRECTLY by id. The previous
    // contact-matched upsert is unsafe here: GHL's upsert matches by
    // contact+pipeline regardless of status, so once a client has a closed
    // (won/abandoned) opportunity from a past project it could grab and
    // mutate that one instead of the current open opportunity.
    await updateOpportunityStage({
      opportunityId,
      pipelineStageId: stageId,
      status,
    });

    if (typeof monetaryValue === "number") {
      await updateOpportunityValue({ opportunityId, monetaryValue });
    }
  } catch (err) {
    console.error(
      `❌ [PIPELINE] updateOpportunityStage failed for contact ${contactId}:`,
      err.message || err
    );
    if (err.response?.data) {
      console.error("❌ [PIPELINE] GHL response:", err.response.status, err.response.data);
    }
    throw err;
  }

  // Update opportunity name if it's still the fallback and we now have a name
  if (updatedOpportunityId && contact) {
    await updateOpportunityNameIfNeeded({ opportunityId: updatedOpportunityId, contact });
  }

  if (note) {
    await addOpportunityNote({ opportunityId: updatedOpportunityId, content: note });
  }

  // Lost-deal analytics (§6.6) — every transition to COLD_NURTURE_LOST writes
  // the three structural fields. Auto-derives `last_stage_before_lost` from
  // the stage we're moving FROM; callers with finer knowledge (e.g. the refund
  // form already ran consultDidHappen and knows "Consult Completed") pass
  // lastStageBeforeLostOverride. Idempotency guard: if we're already at LOST,
  // do NOT recapture — we'd otherwise overwrite the true "last stage before
  // we became Lost" with the value `cold_nurture_lost`. updateSystemFields
  // filters out undefined, so unsupplied options are silent no-ops.
  const systemFieldUpdates = {
    opportunity_stage: updatedStageKey,
    opportunity_id: updatedOpportunityId,
  };
  if (stageKey === OPPORTUNITY_STAGES.COLD_NURTURE_LOST) {
    const wasAlreadyLost = currentStage === OPPORTUNITY_STAGES.COLD_NURTURE_LOST;
    if (!wasAlreadyLost) {
      const derived = deriveLastStageBeforeLost(currentStage);
      const lastStage = lastStageBeforeLostOverride || derived;
      if (lastStage) {
        systemFieldUpdates.last_stage_before_lost = lastStage;
      }
    }
    if (lostReason) {
      systemFieldUpdates.lost_reason = lostReason;
    }
    if (refundType) {
      systemFieldUpdates.refund_type = refundType;
    }
  }
  await updateSystemFields(contactId, systemFieldUpdates);

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

