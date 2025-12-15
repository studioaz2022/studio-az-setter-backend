const { generateOpenerForContact } = require("./aiClient");
const { buildCanonicalState, derivePhaseFromFields, computeLastSeenDiff } = require("./phaseContract");
const { detectIntents } = require("./intents");
const { handlePathChoice } = require("./consultPathHandler");
const { shouldHardSkipAI } = require("./hardSkip");
const { buildDeterministicResponse } = require("./deterministicResponses");
const { evaluateHoldState } = require("./holdLifecycle");
const { updateSystemFields, sendConversationMessage } = require("../../ghlClient");
const { SYSTEM_FIELDS } = require("../config/constants");
const { buildContactProfile, buildEffectiveContact } = require("./contextBuilder");

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
  payloadCustomFields = {},
}) {
  const startTime = Date.now();
  
  // Log the incoming context for debugging
  console.log("🧠 [AI CONTEXT] Processing message:", {
    messageText: latestMessageText,
    contactId: contact?.id || contact?._id,
    contactName: `${contact?.firstName || ""} ${contact?.lastName || ""}`.trim() || "(unknown)",
    consultExplained,
  });

  const effectiveContact = buildEffectiveContact(contact, payloadCustomFields);

  const canonicalBefore = buildCanonicalState(effectiveContact);
  const derivedPhaseBefore = derivePhaseFromFields(canonicalBefore);
  const { changedFields: changedFieldsBefore } = computeLastSeenDiff(
    canonicalBefore,
    canonicalBefore.lastSeenSnapshot || {}
  );
  const intents = detectIntents(latestMessageText, canonicalBefore);
  const consultExplainedResolved =
    canonicalBefore.consultExplained !== undefined
      ? canonicalBefore.consultExplained
      : consultExplained;

  // Evaluate hold lifecycle before proceeding (activity-based)
  try {
    await evaluateHoldState({
      contact: effectiveContact,
      canonicalState: canonicalBefore,
      now: new Date(),
    });
  } catch (err) {
    console.error("❌ [HOLD] evaluateHoldState error:", err.message || err);
  }

  // Log canonical state BEFORE any AI call
  console.log("📊 [CANONICAL] State before routing:", {
    tattooSummary: canonicalBefore.tattooSummary,
    tattooPlacement: canonicalBefore.tattooPlacement,
    tattooSize: canonicalBefore.tattooSize,
    timeline: canonicalBefore.timeline,
    consultationType: canonicalBefore.consultationType,
    depositPaid: canonicalBefore.depositPaid,
    derivedPhase: derivedPhaseBefore,
  });

  // Log detected intents with the message that triggered them
  const activeIntents = Object.keys(intents).filter((k) => intents[k] === true);
  if (activeIntents.length > 0) {
    console.log("🎯 [INTENTS] Detected intents:", activeIntents, "from message:", latestMessageText);
  } else {
    console.log("🎯 [INTENTS] No specific intents detected for:", latestMessageText);
  }

  let response = null;
  let selectedHandler = null;
  let routingReason = null;

  // Multi-intent: consult path + scheduling → apply consult choice side effects before scheduling
  if (intents.scheduling_intent && intents.consult_path_choice_intent && (effectiveContact?.id || effectiveContact?._id)) {
    try {
      await handlePathChoice({
        contactId: effectiveContact.id || effectiveContact._id,
        messageText: latestMessageText,
        channelContext: {},
        sendConversationMessage: null,
        existingConsultType: canonicalBefore.consultationType,
        consultationTypeLocked: canonicalBefore.consultationTypeLocked,
        applyOnly: true,
      });
      console.log("[ROUTING] Applied consult-path updates before scheduling");
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

  if (consultOnly && (effectiveContact?.id || effectiveContact?._id)) {
    try {
      const consultResult = await handlePathChoice({
        contactId: effectiveContact.id || effectiveContact._id,
        messageText: latestMessageText,
        channelContext: {},
        sendConversationMessage,
        existingConsultType: canonicalBefore.consultationType,
        consultationTypeLocked: canonicalBefore.consultationTypeLocked,
        applyOnly: false,
      });

      const bubble = consultResult?.responseBody || null;

      response = {
        language: "en",
        bubbles: bubble ? [bubble] : [],
        internal_notes: "consult_path_choice",
        meta: { aiPhase: derivedPhaseBefore || null, leadTemperature: null },
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
      derivedPhase: derivedPhaseBefore,
      canonicalState: canonicalBefore,
    });

    selectedHandler = hardSkip.skip ? "deterministic" : "ai";
    routingReason = hardSkip.reason || "ai_fallback";

    if (hardSkip.skip) {
      response = await buildDeterministicResponse({
        intents,
        derivedPhase: derivedPhaseBefore,
        canonicalState: canonicalBefore,
        contact: effectiveContact,
        channelContext: {},
        messageText: latestMessageText,
        changedFields: changedFieldsBefore,
      });
    } else {
      const aiStartTime = Date.now();
      const resolvedContactProfile =
        contactProfile && Object.keys(contactProfile || {}).length > 0
          ? contactProfile
          : buildContactProfile(canonicalBefore, {
              changedFields: changedFieldsBefore,
              derivedPhase: derivedPhaseBefore,
              intents,
            });

      response = await generateOpenerForContact({
        contact: effectiveContact,
        canonicalState: canonicalBefore,
        aiPhase: derivedPhaseBefore,
        leadTemperature,
        latestMessageText,
        contactProfile: resolvedContactProfile,
        consultExplained: consultExplainedResolved,
      });
      console.log(`⏱️ [TIMING] AI call took ${Date.now() - aiStartTime}ms`);

      if (response?.meta) {
        response.meta.aiPhase = response.meta.aiPhase || derivedPhaseBefore || aiPhase || null;
      }
    }
  }

  // Apply field updates to contact snapshot (in-memory only) before recomputing phase
  const contactWithUpdates = applyFieldUpdatesToContact(
    effectiveContact,
    response?.field_updates || {}
  );

  const canonicalAfter = buildCanonicalState(contactWithUpdates);
  const derivedPhaseAfter = derivePhaseFromFields(canonicalAfter);
  const { updatedSnapshot, changedFields } = computeLastSeenDiff(
    canonicalAfter,
    canonicalBefore.lastSeenSnapshot || {}
  );

  // Persist last seen snapshot if it changed
  if (effectiveContact?.id && Object.keys(changedFields || {}).length > 0) {
    try {
      await updateSystemFields(effectiveContact.id || effectiveContact._id, {
        [SYSTEM_FIELDS.LAST_SEEN_FIELDS]: JSON.stringify(updatedSnapshot),
      });
    } catch (err) {
      console.error("❌ Failed to persist last_seen snapshot:", err.message || err);
    }
  }

  console.log("🧭 [PHASE] derived_phase snapshot", {
    derived_phase: derivedPhaseAfter,
    canonical: {
      tattooSummary: canonicalAfter.tattooSummary,
      tattooPlacement: canonicalAfter.tattooPlacement,
      tattooSize: canonicalAfter.tattooSize,
      timeline: canonicalAfter.timeline,
      consultationType: canonicalAfter.consultationType,
      consultationTypeLocked: canonicalAfter.consultationTypeLocked,
      depositLinkSent: canonicalAfter.depositLinkSent,
      depositPaid: canonicalAfter.depositPaid,
      holdAppointmentId: canonicalAfter.holdAppointmentId,
    },
    intents,
    selected_handler: selectedHandler,
    routing_reason: routingReason,
    intent_flags: Object.keys(intents || {}).filter((k) => intents[k] === true),
  });

  // Log total processing time
  console.log(`⏱️ [TIMING] Total handleInboundMessage took ${Date.now() - startTime}ms`);

  return {
    aiResult: response,
    ai_phase: derivedPhaseAfter || response?.meta?.aiPhase || aiPhase || null,
    lead_temperature: response?.meta?.leadTemperature || leadTemperature || null,
    flags: {},
    routing: { intents, selected_handler: selectedHandler, reason: routingReason },
  };
}

module.exports = {
  handleInboundMessage,
};
