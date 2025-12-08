// consultPathHandler.js
// Helpers to detect and route consultation path preferences (Message vs Video w/ translator)

// consultPathHandler.js
// Helpers to detect and route consultation path preferences (Message vs Video w/ translator)

const { updateSystemFields, createTaskForContact } = require("../../ghlClient");

function detectPathChoice(messageText) {
  if (!messageText) return null;
  const v = String(messageText).toLowerCase();

  const picksMessage =
    /\b(messages?|chat|here|text|dm|mensajes)\b/.test(v) ||
    /consult.*(here|messages|chat)/.test(v) ||
    /pref(er)?\s+(messages?|chat)/.test(v);

  const picksTranslator =
    /\btranslator\b/.test(v) ||
    /\btranslate\b/.test(v) ||
    /\bvideo\b/.test(v) ||
    /\blive\b/.test(v) ||
    /\bcall\b/.test(v) ||
    /consult.*(video|zoom|translator)/.test(v);

  if (picksMessage && !picksTranslator) return "message";
  if (picksTranslator) return "translator";
  return null;
}

async function handlePathChoice({
  contactId,
  messageText,
  channelContext,
  sendConversationMessage,
  triggerAppointmentOffer, // callback to generate and send time slots
}) {
  const choice = detectPathChoice(messageText);
  if (!choice) return null;

  if (choice === "message") {
    console.log(`📝 [CONSULTATION_TYPE] Setting consultation_type="message" for contact ${contactId} (detected from: "${messageText}")`);
    await updateSystemFields(contactId, {
      consultation_type: "message",
      translator_needed: false,
    });

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
      body:
        "Sounds good — we'll keep your consult right here in messages so you can share photos and notes at your own pace. I'll make sure the artist sees this thread.",
      channelContext,
    });

    return { choice: "message" };
  }

  if (choice === "translator") {
    console.log(`📝 [CONSULTATION_TYPE] Setting consultation_type="appointment" (translator needed) for contact ${contactId} (detected from: "${messageText}")`);
    await updateSystemFields(contactId, {
      consultation_type: "appointment",
      translator_needed: true,
    });

    // Send acknowledgment first
    await sendConversationMessage({
      contactId,
      body: "Got it — I'll set up a video consult with a translator.",
      channelContext,
    });

    // Trigger slot generation immediately
    if (triggerAppointmentOffer) {
      console.log("📅 Triggering appointment offer after translator choice");
      try {
        await triggerAppointmentOffer({
          contactId,
          channelContext,
          translatorNeeded: true,
        });
      } catch (err) {
        console.error("❌ Failed to trigger appointment offer:", err.message || err);
        await sendConversationMessage({
          contactId,
          body: "What days work best for you this week?",
          channelContext,
        });
      }
    } else {
      await sendConversationMessage({
        contactId,
        body: "What days work best for you this week?",
        channelContext,
      });
    }

    return { choice: "translator" };
  }

  return null;
}

module.exports = {
  detectPathChoice,
  handlePathChoice,
};

