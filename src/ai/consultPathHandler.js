// consultPathHandler.js
// Helpers to detect and route consultation path preferences (Message vs Video w/ translator)

const { updateSystemFields, createTaskForContact } = require("../../ghlClient");
const { syncOpportunityStageFromContact, transitionToStage } = require("./opportunityManager");
const { createDepositLinkForContact } = require("../payments/squareClient");
const { DEPOSIT_CONFIG, OPPORTUNITY_STAGES } = require("../config/constants");

function detectPathChoice(messageText) {
  if (!messageText) return null;
  const v = String(messageText).toLowerCase();

  const picksMessage =
    (/\b(messages?|chat|dm|mensajes)\b/.test(v) &&
      !/instead of\s+messag/i.test(v) &&
      !/\bnot\b.*message/.test(v)) ||
    /consult.*(here|messages|chat)/.test(v) ||
    /pref(er)?\s+(messages?|chat)/.test(v);

  const picksTranslator =
    /\btranslator\b/.test(v) ||
    /\btranslate\b/.test(v) ||
    /\bvideo\b/.test(v) ||
    /\blive\b/.test(v) ||
    /\bcall\b/.test(v) ||
    /consult.*(video|zoom|translator)/.test(v);

  // If they ask why a translator is needed, treat it specially so we can explain first
  const asksWhyTranslator =
    /\bwhy\b.*translator/.test(v) || /translator.*\bwhy\b/.test(v);

  if (asksWhyTranslator) return "translator_question";

  if (picksMessage && !picksTranslator) return "message";
  if (picksTranslator) return "translator";
  return null;
}

async function handlePathChoice({
  contactId,
  messageText,
  channelContext,
  sendConversationMessage,
  triggerAppointmentOffer, // unused now to avoid premature time generation
  existingConsultType = null,
  consultationTypeLocked = false,
  applyOnly = false, // when true, apply state updates without sending consult-only messages
}) {
  const choice = detectPathChoice(messageText);
  if (!choice) return null;

  // Do not overwrite consult type unless user explicitly changes it
  if ((existingConsultType || consultationTypeLocked) && choice !== "translator_question") {
    const explicitSwitch = /\bactually\b|\brather\b|\binstead\b|\bprefer\b/.test(
      String(messageText).toLowerCase()
    );
    if (!explicitSwitch && consultationTypeLocked) {
      return null;
    }
  }

  if (choice === "translator_question") {
    if (applyOnly) {
      console.log("📝 [CONSULTATION_TYPE] translator question detected (applyOnly=true); skipping outbound");
      return { choice: "translator_question" };
    }

    const responseBody =
      "Our artist's native language is Spanish, so we add a translator to keep all the design details clear. We can do that on a quick video call or keep things in messages—both work great. Which do you prefer?";

    await sendConversationMessage({
      contactId,
      body: responseBody,
      channelContext,
    });

    try {
      await updateSystemFields(contactId, {
        language_barrier_explained: true,
      });
    } catch (err) {
      console.error(
        "❌ Failed to mark language_barrier_explained after translator question:",
        err.message || err
      );
    }

    // Return WITHOUT responseBody since message was already sent directly
    return { choice: "translator_question", messageSent: true };
  }

  if (choice === "message") {
    console.log(`📝 [CONSULTATION_TYPE] Setting consultation_type="message" for contact ${contactId} (detected from: "${messageText}")`);
    await updateSystemFields(contactId, {
      consultation_type: "message",
      consultation_type_locked: true,
      translator_needed: false,
    });

    if (!applyOnly) {
      // Enhanced message for English leads: emphasize flexibility and artist joining after deposit
      const confirmationBody =
        "Perfect — we'll handle your consult right here in messages so you can share photos and notes at your own pace. Once the deposit's locked in, I'll add the artist to this thread so you can go back and forth directly.";
      try {
        await createTaskForContact(contactId, {
          title: "Message consultation (keep in thread)",
          description:
            "Lead chose to continue consult in messages. Keep thread open; review photos/notes shared here. Add artist after deposit is paid.",
          status: "open",
        });
      } catch (err) {
        console.error("❌ Failed to create message consult task:", err.message || err);
      }

      await sendConversationMessage({
        contactId,
        body: confirmationBody,
        channelContext,
      });
      console.log("📝 [CONSULTATION_TYPE] Sent message-path confirmation directly");

      // === Send deposit link after confirmation ===
      try {
        const deposit = await createDepositLinkForContact({
          contactId,
          amountCents: DEPOSIT_CONFIG.DEFAULT_AMOUNT_CENTS,
          description: DEPOSIT_CONFIG.DEFAULT_DESCRIPTION,
        });

        const amount = (DEPOSIT_CONFIG.DEFAULT_AMOUNT_CENTS || 0) / 100;
        const depositMessage = 
          `The $${amount} deposit locks in your spot and is fully refundable if you change your mind — it goes toward your tattoo total either way.\n\n` +
          `Here's the link whenever you're ready: ${deposit?.url}`;

        await sendConversationMessage({
          contactId,
          body: depositMessage,
          channelContext,
        });

        // Update system fields to mark deposit link sent
        await updateSystemFields(contactId, {
          deposit_link_sent: true,
          deposit_link_url: deposit?.url || null,
        });

        // Transition pipeline to DEPOSIT_PENDING
        try {
          await transitionToStage(contactId, OPPORTUNITY_STAGES.DEPOSIT_PENDING);
          console.log("📊 [PIPELINE] Message consult + deposit link sent → DEPOSIT_PENDING");
        } catch (pipeErr) {
          console.error("❌ [PIPELINE] Failed to transition to DEPOSIT_PENDING:", pipeErr.message || pipeErr);
        }

        console.log("📝 [CONSULTATION_TYPE] Sent deposit link after message-path confirmation");
      } catch (depositErr) {
        console.error("❌ Failed to create/send deposit link for message consult:", depositErr.message || depositErr);
        // Send fallback message without link
        const amount = (DEPOSIT_CONFIG.DEFAULT_AMOUNT_CENTS || 0) / 100;
        const fallbackMessage = `Just need the $${amount} refundable deposit to get started — it goes toward your tattoo total. I'll send the payment link shortly.`;
        await sendConversationMessage({
          contactId,
          body: fallbackMessage,
          channelContext,
        });
      }
    } else {
      console.log("📝 [CONSULTATION_TYPE] applyOnly=true; skipping outbound message for message-path choice");
    }

    // 🔁 Sync pipeline: message-based consult → CONSULT_MESSAGE stage
    try {
      await syncOpportunityStageFromContact(contactId, {
        aiPhase: "consult_support",
        fieldOverrides: {
          consultation_type: "message",
        },
      });
      console.log("🏗️ Pipeline stage synced after consult mode = message");
    } catch (oppErr) {
      console.error("❌ Error syncing opportunity stage after consult mode = message:", oppErr.message || oppErr);
      if (oppErr.response?.data) {
        console.error("❌ Pipeline sync response (message consult):", oppErr.response.status, oppErr.response.data);
      }
    }

    // Return WITHOUT responseBody since message was already sent directly
    return { choice: "message", messageSent: !applyOnly };
  }

  if (choice === "translator") {
    console.log(`📝 [CONSULTATION_TYPE] Setting consultation_type="appointment" (translator needed) for contact ${contactId} (detected from: "${messageText}")`);
    
    // Auto-confirm translator when they pick video - they implicitly accepted it
    // since video call option was presented WITH translator context already
    await updateSystemFields(contactId, {
      consultation_type: "appointment",
      consultation_type_locked: true,
      translator_needed: true,
      translator_confirmed: true, // AUTO-CONFIRM: They chose video which was explained with translator
      language_barrier_explained: true,
      translator_explained: true,
    });

    // 🔁 Sync pipeline: appointment-based consult → CONSULT_APPOINTMENT stage
    try {
      await syncOpportunityStageFromContact(contactId, {
        aiPhase: "consult_support",
        fieldOverrides: {
          consultation_type: "appointment",
          translator_needed: true,
          translator_confirmed: true,
          translator_explained: true,
          language_barrier_explained: true,
        },
      });
      console.log("🏗️ Pipeline stage synced after consult mode = appointment/translator");
    } catch (oppErr) {
      console.error("❌ Error syncing opportunity stage after consult mode = appointment:", oppErr.message || oppErr);
      if (oppErr.response?.data) {
        console.error("❌ Pipeline sync response (appointment consult):", oppErr.response.status, oppErr.response.data);
      }
    }

    // CHANGED: Don't ask "Does that work for you?" - they already chose video
    // Instead, return flag to trigger immediate slot offering
    // The controller will handle offering slots directly
    return { 
      choice: "translator", 
      messageSent: false, // No message sent - let scheduling flow handle it
      shouldOfferSlots: true, // Signal to controller to offer slots immediately
    };
  }

  return null;
}

module.exports = {
  detectPathChoice,
  handlePathChoice,
};
