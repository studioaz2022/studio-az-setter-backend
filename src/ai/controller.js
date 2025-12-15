const { generateOpenerForContact } = require("./aiClient");
const { buildCanonicalState, derivePhaseFromFields, computeLastSeenDiff } = require("./phaseContract");
const { detectIntents } = require("./intents");
const { handlePathChoice } = require("./consultPathHandler");
const { shouldHardSkipAI } = require("./hardSkip");
const { buildDeterministicResponse } = require("./deterministicResponses");
const { evaluateHoldState } = require("./holdLifecycle");
const { updateSystemFields, sendConversationMessage } = require("../../ghlClient");
const { SYSTEM_FIELDS } = require("../config/constants");

function applyFieldUpdatesToContact(contact, fieldUpdates = {}) {
  if (!contact) return contact;
  const updated = { ...contact };
  const cf = { ...(contact.customField || contact.customFields || {}) };

  Object.entries(fieldUpdates || {}).forEach(([key, value]) => {
    if (value === undefined) return;
    cf[key] = value;
  });

  updated.customField = cf;
  updated.customFields = cf;
  return updated;
}

async function handleInboundMessage({
  contact,
  aiPhase,
  leadTemperature,
  latestMessageText,
  contactProfile,
  consultExplained,
}) {
  // Evaluate hold lifecycle before proceeding (activity-based)
  try {
    const canonical = buildCanonicalState(contact);
    await evaluateHoldState({
      contact,
      canonicalState: canonical,
      now: new Date(),
    });
  } catch (err) {
    console.error("❌ [HOLD] evaluateHoldState error:", err.message || err);
  }

  const aiResult = await generateOpenerForContact({
    contact,
    aiPhase,
    leadTemperature,
    latestMessageText,
    contactProfile,
    consultExplained, // Pass through to AI for prompt enforcement
  });

  // Apply field updates to contact snapshot (in-memory only) before recomputing phase
  const contactWithUpdates = applyFieldUpdatesToContact(
    contact,
    aiResult?.field_updates || {}
  );

  const canonicalState = buildCanonicalState(contactWithUpdates);
  const { updatedSnapshot, changedFields } = computeLastSeenDiff(
    canonicalState,
    canonicalState.lastSeenSnapshot || {}
  );
  const derivedPhase = derivePhaseFromFields(canonicalState);
  const intents = detectIntents(latestMessageText, canonicalState);

  let response = null;
  let selectedHandler = null;
  let routingReason = null;

  // Multi-intent: consult path + scheduling → apply consult choice side effects, then continue routing
  if (intents.scheduling_intent && intents.consult_path_choice_intent && (contact?.id || contact?._id)) {
    try {
      await handlePathChoice({
        contactId: contact.id || contact._id,
        messageText: latestMessageText,
        channelContext: {},
        sendConversationMessage: null,
        existingConsultType: canonicalState.consultationType,
        consultationTypeLocked: canonicalState.consultationTypeLocked,
        applyOnly: true,
      });
      console.log("[ROUTING] Also applied consult-path updates before scheduling");
    } catch (err) {
      console.error("❌ [ROUTING] Failed to apply consult-path updates (applyOnly):", err.message || err);
    }
  }

  // Consult-only path choice (no scheduling/deposit/slot/reschedule/cancel) → route to consultPathHandler
  const consultOnly =
    intents.consult_path_choice_intent &&
    !intents.scheduling_intent &&
    !intents.deposit_intent &&
    !intents.slot_selection_intent &&
    !intents.reschedule_intent &&
    !intents.cancel_intent;

  if (consultOnly && (contact?.id || contact?._id)) {
    try {
      const consultResult = await handlePathChoice({
        contactId: contact.id || contact._id,
        messageText: latestMessageText,
        channelContext: {},
        sendConversationMessage,
        existingConsultType: canonicalState.consultationType,
        consultationTypeLocked: canonicalState.consultationTypeLocked,
        applyOnly: false,
      });

      const bubble = consultResult?.responseBody || null;

      response = {
        language: "en",
        bubbles: bubble ? [bubble] : [],
        internal_notes: "consult_path_choice",
        meta: { aiPhase: derivedPhase || null, leadTemperature: null },
        field_updates: {},
      };
      selectedHandler = "consult_path";
      routingReason = "consult_path_choice_intent";
    } catch (err) {
      console.error("❌ [ROUTING] Failed to process consult-path choice:", err.message || err);
    }
  }

  if (!response) {
    const hardSkip = shouldHardSkipAI({
      intents,
      derivedPhase,
      canonicalState,
    });

    selectedHandler = hardSkip.skip ? "deterministic" : "ai";
    routingReason = hardSkip.reason || "ai_fallback";
    response = hardSkip.skip
      ? await buildDeterministicResponse({
          intents,
          derivedPhase,
          canonicalState,
          contact,
          channelContext: {},
          messageText: latestMessageText,
          changedFields,
        })
      : aiResult;
  }

  // Persist last seen snapshot if it changed
  if (contact?.id && Object.keys(changedFields || {}).length > 0) {
    try {
      await updateSystemFields(contact.id || contact._id, {
        [SYSTEM_FIELDS.LAST_SEEN_FIELDS]: JSON.stringify(updatedSnapshot),
      });
    } catch (err) {
      console.error("❌ Failed to persist last_seen snapshot:", err.message || err);
    }
  }

  console.log("🧭 [PHASE] derived_phase snapshot", {
    derived_phase: derivedPhase,
    canonical: {
      tattooSummary: canonicalState.tattooSummary,
      tattooPlacement: canonicalState.tattooPlacement,
      tattooSize: canonicalState.tattooSize,
      timeline: canonicalState.timeline,
      consultationType: canonicalState.consultationType,
      consultationTypeLocked: canonicalState.consultationTypeLocked,
      depositLinkSent: canonicalState.depositLinkSent,
      depositPaid: canonicalState.depositPaid,
      holdAppointmentId: canonicalState.holdAppointmentId,
    },
    intents,
    selected_handler: selectedHandler,
    routing_reason: routingReason,
    intent_flags: Object.keys(intents || {}).filter((k) => intents[k] === true),
  });

  return {
    aiResult: response,
    ai_phase: derivedPhase || response?.meta?.aiPhase || aiPhase || null,
    lead_temperature: response?.meta?.leadTemperature || leadTemperature || null,
    flags: {},
    routing: { intents, selected_handler: selectedHandler, reason: routingReason },
  };
}

module.exports = {
  handleInboundMessage,
};
