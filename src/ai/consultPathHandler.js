// consultPathHandler.js
// Helpers to detect and route consultation path preferences (Message vs Video w/ translator)

// consultPathHandler.js
// Helpers to detect and route consultation path preferences (Message vs Video w/ translator)

const { updateSystemFields, createTaskForContact } = require("../../ghlClient");
const { syncOpportunityStageFromContact } = require("./opportunityManager");

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

    return { choice: "translator_question", responseBody };
  }

  if (choice === "message") {
    console.log(`📝 [CONSULTATION_TYPE] Setting consultation_type="message" for contact ${contactId} (detected from: "${messageText}")`);
    await updateSystemFields(contactId, {
      consultation_type: "message",
      consultation_type_locked: true,
      translator_needed: false,
    });

    let responseBody = null;
    if (!applyOnly) {
      responseBody =
        "Sounds good — we'll keep your consult right here in messages so you can share photos and notes at your own pace. I'll make sure the artist sees this thread.";
      try {
        await createTaskForContact(contactId, {
          title: "Message consultation (keep in thread)",
          description:
            "Lead chose to continue consult in messages. Keep thread open; review photos/notes shared here.",
          status: "open",
        });
      } catch (err) {
        console.error("❌ Failed to create message consult task:", err.message || err);
      }

      await sendConversationMessage({
        contactId,
        body: responseBody,
        channelContext,
      });
    } else {
      console.log("📝 [CONSULTATION_TYPE] applyOnly=true; skipping outbound message for message-path choice");
    }

    // 🔁 Sync pipeline: message-based consult → CONSULT_MESSAGE stage
    try {
      await syncOpportunityStageFromContact(contactId, { aiPhase: "consult_support" });
      console.log("🏗️ Pipeline stage synced after consult mode = message");
    } catch (oppErr) {
        console.error("❌ Error syncing opportunity stage after consult mode = message:", oppErr.message || oppErr);
    }

    return responseBody ? { choice: "message", responseBody } : { choice: "message" };
  }

  if (choice === "translator") {
    console.log(`📝 [CONSULTATION_TYPE] Setting consultation_type="appointment" (translator needed) for contact ${contactId} (detected from: "${messageText}")`);
    await updateSystemFields(contactId, {
      consultation_type: "appointment",
      consultation_type_locked: true,
      translator_needed: true,
      language_barrier_explained: true,
      translator_explained: true,
    });

    let responseBody = null;
    if (!applyOnly) {
      responseBody =
        "Our artist's native language is Spanish, so for video consults we include a translator on the call to keep every detail clear. Does that work for you?";

      await sendConversationMessage({
        contactId,
        body: responseBody,
        channelContext,
      });
    } else {
      console.log("📝 [CONSULTATION_TYPE] applyOnly=true; skipping outbound message for translator-path choice");
    }

    // 🔁 Sync pipeline: appointment-based consult → CONSULT_APPOINTMENT stage
    try {
      await syncOpportunityStageFromContact(contactId, { aiPhase: "consult_support" });
      console.log("🏗️ Pipeline stage synced after consult mode = appointment/translator");
    } catch (oppErr) {
      console.error("❌ Error syncing opportunity stage after consult mode = appointment:", oppErr.message || oppErr);
    }

    // Do NOT generate times here; wait until deposit flow is ready

    return responseBody ? { choice: "translator", responseBody } : { choice: "translator" };
  }

  return null;
}

module.exports = {
  detectPathChoice,
  handlePathChoice,
};
