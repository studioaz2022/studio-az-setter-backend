const { generateOpenerForContact } = require("./aiClient");
const { buildCanonicalState, derivePhaseFromFields, computeLastSeenDiff } = require("./phaseContract");
const { detectIntents } = require("./intents");
const { handlePathChoice } = require("./consultPathHandler");
const { shouldHardSkipAI } = require("./hardSkip");
const { buildDeterministicResponse } = require("./deterministicResponses");
const { evaluateHoldState } = require("./holdLifecycle");
const { updateSystemFields, sendConversationMessage } = require("../../ghlClient");
const { SYSTEM_FIELDS, OPPORTUNITY_STAGES } = require("../config/constants");
const { buildContactProfile, buildEffectiveContact } = require("./contextBuilder");
const { advanceFromIntakeToDiscovery } = require("./opportunityManager");

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
  conversationThread = null, // NEW: Formatted conversation history
  channelContext = {}, // NEW: Channel context for message sending
}) {
  const startTime = Date.now();
  
  // Log the incoming context for debugging
  console.log("🧠 [AI CONTEXT] Processing message:", {
    messageText: latestMessageText,
    contactId: contact?.id || contact?._id,
    contactName: `${contact?.firstName || ""} ${contact?.lastName || ""}`.trim() || "(unknown)",
    consultExplained,
    threadStats: conversationThread ? {
      totalMessages: conversationThread.totalCount,
      recentMessages: conversationThread.thread?.length || 0,
      hasSummary: !!conversationThread.summary,
      hasImageContext: !!conversationThread.imageContext,
      wasHumanHandling: conversationThread.handoffContext?.wasHumanHandling || false,
    } : null,
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

  // Log objection detection separately for sales tracking
  if (intents.objection_intent && intents.objection_type) {
    console.log(`🚨 [OBJECTION] Detected objection type: "${intents.objection_type}" (category: ${intents.objection_data?.category || 'unknown'})`);
  }

  // === Advance Widget leads from INTAKE to DISCOVERY on first AI response ===
  // When a lead comes from the React widget, they start at INTAKE.
  // Once they respond to our AI opener, we advance them to DISCOVERY.
  const opportunityStage = canonicalBefore.opportunityStage;
  if (opportunityStage === OPPORTUNITY_STAGES.INTAKE && latestMessageText && latestMessageText.trim()) {
    console.log(`📊 [PIPELINE] Widget lead responded - advancing from INTAKE to DISCOVERY...`);
    try {
      await advanceFromIntakeToDiscovery(effectiveContact?.id || effectiveContact?._id, { contact: effectiveContact });
    } catch (err) {
      console.error("❌ [PIPELINE] Failed to advance to DISCOVERY:", err.message || err);
    }
  }

  let response = null;
  let selectedHandler = null;
  let routingReason = null;

  // === Proactive consultation options explanation for consult_path phase ===
  // SIMPLIFIED: Only check if they haven't chosen a consultation type yet
  // The AI with thread context will handle not repeating the explanation
  const shouldExplainConsultOptions = 
    derivedPhaseBefore === "consult_path" &&
    !canonicalBefore.consultationType && // Only trigger if no choice made yet
    !canonicalBefore.consultationTypeLocked &&
    !intents.scheduling_intent && // Don't interrupt if they're already asking for times
    !intents.slot_selection_intent &&
    !intents.consult_path_choice_intent; // Don't explain if they're already choosing

  if (shouldExplainConsultOptions && (effectiveContact?.id || effectiveContact?._id)) {
    const consultContactId = effectiveContact.id || effectiveContact._id;
    
    // Determine language preference
    const languagePreference = canonicalBefore.languagePreference || "English";
    const isSpanish = String(languagePreference).toLowerCase().includes("span") || 
                      String(languagePreference).toLowerCase() === "es";
    
    let consultOptionsMessage = "";
    
    if (isSpanish) {
      // Spanish-speaking leads get simple choice
      consultOptionsMessage = 
        "El siguiente paso es una consulta rápida de 15-20 minutos con el artista para entender completamente tu diseño.\n\n" +
        "¿Prefieres una videollamada o hacerlo por mensajes?";
    } else {
      // English leads get the full explanation with translator context
      consultOptionsMessage = 
        "Since our artist's native language is Spanish, our clients either do a video call with a translator or message the artist directly about their idea.\n\n" +
        "Both options have worked great — which do you prefer?";
    }
    
    // Send the consultation options message
    try {
      await sendConversationMessage({
        contactId: consultContactId,
        body: consultOptionsMessage,
        channelContext,
      });
      
      // Mark that we've explained the consult options
      await updateSystemFields(consultContactId, {
        consult_explained: true,
      });
      
      console.log("📝 [CONSULT_PATH] Proactively sent consultation options explanation");
      
      // Return early - don't process further this turn
      const endTime = Date.now();
      console.log(`⏱️ [TIMING] Total handleInboundMessage took ${endTime - startTime}ms`);
      
      return {
        aiResult: {
          language: isSpanish ? "es" : "en",
          bubbles: [], // Message already sent directly
          internal_notes: "proactive_consult_options_explanation",
          meta: { aiPhase: derivedPhaseBefore, leadTemperature: null },
          field_updates: { consult_explained: true },
          _messageSentDirectly: true,
        },
        ai_phase: derivedPhaseBefore,
        lead_temperature: null,
        flags: {},
        routing: { intents, selected_handler: "consult_path_proactive", reason: "consult_path_explanation" },
      };
    } catch (err) {
      console.error("❌ Failed to send proactive consult options:", err.message || err);
      // Continue with normal flow if this fails
    }
  }

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

      // If video call was picked, offer slots immediately (translator auto-confirmed)
      if (consultResult?.shouldOfferSlots) {
        console.log("📅 [ROUTING] Video call selected → offering slots immediately (translator auto-confirmed)");
        
        // Send a brief acknowledgment then offer slots
        await sendConversationMessage({
          contactId: effectiveContact.id || effectiveContact._id,
          body: "Perfect — let me pull up some times for you.",
          channelContext: {},
        });
        
        // Trigger scheduling flow by setting scheduling intent
        const schedulingResponse = await buildDeterministicResponse({
          intents: { scheduling_intent: true },
          derivedPhase: derivedPhaseBefore,
          canonicalState: { ...canonicalBefore, translatorConfirmed: true },
          contact: effectiveContact,
          channelContext: {},
          messageText: latestMessageText,
          changedFields: {},
        });
        
        response = {
          ...schedulingResponse,
          internal_notes: "consult_path_video_with_immediate_slots",
          _messageSentDirectly: true,
        };
        selectedHandler = "consult_path_scheduling";
        routingReason = "video_consult_with_slots";
      } else {
        // Don't add to bubbles if message was already sent directly by handlePathChoice
        const messageSent = consultResult?.messageSent === true;

        response = {
          language: "en",
          bubbles: [], // Empty - message already sent by consultPathHandler
          internal_notes: "consult_path_choice",
          meta: { aiPhase: derivedPhaseBefore || null, leadTemperature: null },
          field_updates: {},
          _messageSentDirectly: messageSent, // Flag to prevent double-send
        };
        selectedHandler = "consult_path";
        routingReason = "consult_path_choice_intent";
      }
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
        conversationThread, // Pass thread context to AI
        detectedObjection: intents.objection_data || null, // Pass objection data if detected
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
