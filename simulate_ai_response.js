require("dotenv").config();

// Mock sendConversationMessage BEFORE importing controller (which imports it)
const ghlClient = require("./ghlClient");
const sentMessages = [];
const originalSendMessage = ghlClient.sendConversationMessage;
ghlClient.sendConversationMessage = async function(params) {
  sentMessages.push({
    contactId: params.contactId,
    body: params.body,
    channelContext: params.channelContext,
    timestamp: new Date().toISOString(),
  });
  console.log(`\n📤 [MOCK] Would send message to ${params.contactId}:`);
  console.log(`   "${params.body}"`);
  return { mock: true, contactId: params.contactId };
};

// Now import controller (it will use the mocked function)
const { getContact, getConversationHistory } = require("./ghlClient");
const { handleInboundMessage } = require("./src/ai/controller");
const { extractCustomFieldsFromPayload, buildEffectiveContact, formatThreadForLLM, normalizeCustomFields } = require("./src/ai/contextBuilder");
const { buildCanonicalState } = require("./src/ai/phaseContract");
const { TATTOO_FIELDS } = require("./src/config/constants");

async function simulateAIResponse(contactId, messageText = "New form submission") {
  console.log("\n🤖 ════════════════════════════════════════════════════════");
  console.log(`🤖 SIMULATING AI RESPONSE FOR CONTACT: ${contactId}`);
  console.log("🤖 ════════════════════════════════════════════════════════\n");

  // Fetch contact
  console.log("📥 Fetching contact data...");
  const contactRaw = await getContact(contactId);
  
  if (!contactRaw) {
    console.error("❌ Contact not found!");
    return;
  }

  const contactName = `${contactRaw?.firstName || ""} ${contactRaw?.lastName || ""}`.trim() || "(unknown)";
  console.log(`👤 Contact: ${contactName} (${contactId})`);

  // Show raw custom fields from GHL
  console.log("\n📋 RAW CUSTOM FIELDS FROM GHL:");
  console.log("─".repeat(60));
  const rawCf = contactRaw?.customField || contactRaw?.customFields || {};
  const rawCfEntries = Object.entries(rawCf).filter(([k, v]) => v !== null && v !== undefined && v !== "");
  if (rawCfEntries.length > 0) {
    rawCfEntries.forEach(([key, value]) => {
      console.log(`  ${key}: ${JSON.stringify(value)}`);
    });
  } else {
    console.log("  (none found)");
  }

  // Extract and normalize custom fields
  const webhookCustomFields = extractCustomFieldsFromPayload(contactRaw);
  const contact = buildEffectiveContact(contactRaw, webhookCustomFields);
  
  const cf = contact?.customField || contact?.customFields || {};
  
  console.log("\n📋 NORMALIZED CUSTOM FIELDS:");
  console.log("─".repeat(60));
  const normalizedCf = normalizeCustomFields(cf);
  const normalizedEntries = Object.entries(normalizedCf).filter(([k, v]) => v !== null && v !== undefined && v !== "");
  if (normalizedEntries.length > 0) {
    normalizedEntries.forEach(([key, value]) => {
      console.log(`  ${key}: ${JSON.stringify(value)}`);
    });
  } else {
    console.log("  (none found)");
  }

  // Show canonical state
  console.log("\n📊 CANONICAL STATE:");
  console.log("─".repeat(60));
  const canonicalState = buildCanonicalState(contact);
  console.log(`  tattooTitle: ${canonicalState.tattooTitle || "(null)"}`);
  console.log(`  tattooSummary: ${canonicalState.tattooSummary || "(null)"}`);
  console.log(`  tattooPlacement: ${canonicalState.tattooPlacement || "(null)"}`);
  console.log(`  tattooSize: ${canonicalState.tattooSize || "(null)"}`);
  console.log(`  tattooStyle: ${canonicalState.tattooStyle || "(null)"}`);
  console.log(`  timeline: ${canonicalState.timeline || "(null)"}`);

  // Check what TATTOO_FIELDS constants are looking for
  console.log("\n🔍 FIELD MAPPING CHECK:");
  console.log("─".repeat(60));
  console.log(`  Looking for tattoo_title as: "${TATTOO_FIELDS.TATTOO_TITLE}"`);
  console.log(`  Looking for tattoo_summary as: "${TATTOO_FIELDS.TATTOO_SUMMARY}"`);
  console.log(`  Looking for tattoo_placement as: "${TATTOO_FIELDS.TATTOO_PLACEMENT}"`);
  console.log(`  Found in normalized: ${normalizedCf[TATTOO_FIELDS.TATTOO_TITLE] ? "YES" : "NO"}`);
  console.log(`  Found in normalized: ${normalizedCf[TATTOO_FIELDS.TATTOO_SUMMARY] ? "YES" : "NO"}`);
  console.log(`  Found in normalized: ${normalizedCf[TATTOO_FIELDS.TATTOO_PLACEMENT] ? "YES" : "NO"}`);

  // Fetch conversation history
  console.log("\n📜 Fetching conversation history...");
  const rawMessages = await getConversationHistory(contactId, {
    limit: 100,
    sortOrder: "desc",
  });

  // Format thread for LLM
  const conversationThread = formatThreadForLLM(rawMessages, {
    recentCount: 20,
    includeTimestamps: true,
    maxTotalMessages: 100,
    crmFields: {
      tattoo_photo_description: cf.tattoo_photo_description || null,
      tattoo_summary: cf.tattoo_summary || null,
      tattoo_ideasreferences: cf.tattoo_ideasreferences || null,
      previous_conversation_summary: cf.previous_conversation_summary || null,
      returning_client: cf.returning_client || null,
      total_tattoos_completed: cf.total_tattoos_completed || null,
    },
  });

  console.log("📜 Thread context:", {
    totalMessages: conversationThread.totalCount,
    recentCount: conversationThread.thread?.length || 0,
    hasSummary: !!conversationThread.summary,
    hasImageContext: !!conversationThread.imageContext,
  });

  // Derive channel context (widget submission)
  const channelContext = {
    isDm: false,
    hasPhone: !!(contact?.phone || contact?.phoneNumber),
    isWhatsApp: false,
    isSms: false,
    channelType: "widget",
    conversationId: null,
    phone: contact?.phone || contact?.phoneNumber || null,
  };

  console.log("\n💬 Simulating AI response...");
  console.log(`📩 Message text: "${messageText}"`);
  console.log("⚠️  NOTE: sendConversationMessage is mocked - no actual messages will be sent\n");

  // Clear sent messages array
  sentMessages.length = 0;

  // Call handleInboundMessage
  const result = await handleInboundMessage({
    contact,
    aiPhase: null,
    leadTemperature: null,
    latestMessageText: messageText,
    contactProfile: {},
    consultExplained: cf.consult_explained || false,
    conversationThread,
    channelContext,
  });

  // Display results
  console.log("\n✅ ════════════════════════════════════════════════════════");
  console.log("✅ AI RESPONSE GENERATED");
  console.log("✅ ════════════════════════════════════════════════════════\n");

  const bubbles = result?.aiResult?.bubbles || [];
  const meta = result?.aiResult?.meta || {};
  const fieldUpdates = result?.aiResult?.field_updates || {};

  // Show any messages that would have been sent directly (proactive messages)
  if (sentMessages.length > 0) {
    console.log("📤 MESSAGES THAT WOULD BE SENT DIRECTLY:");
    console.log("─".repeat(60));
    sentMessages.forEach((msg, idx) => {
      console.log(`\nMessage ${idx + 1} (to ${msg.contactId}):`);
      console.log(msg.body);
    });
    console.log("");
  }

  console.log("📝 RESPONSE BUBBLES:");
  console.log("─".repeat(60));
  if (bubbles.length > 0) {
    bubbles.forEach((bubble, idx) => {
      console.log(`\nBubble ${idx + 1}:`);
      console.log(bubble);
    });
  } else {
    console.log("(No bubbles - message was sent directly via proactive handler)");
  }

  console.log("\n\n📊 METADATA:");
  console.log("─".repeat(60));
  console.log(JSON.stringify(meta, null, 2));

  console.log("\n\n🔄 FIELD UPDATES:");
  console.log("─".repeat(60));
  console.log(JSON.stringify(fieldUpdates, null, 2));

  console.log("\n\n🧭 ROUTING:");
  console.log("─".repeat(60));
  console.log(`Handler: ${result?.routing?.selected_handler || "unknown"}`);
  console.log(`Reason: ${result?.routing?.reason || "unknown"}`);
  console.log(`Phase: ${result?.ai_phase || "unknown"}`);
  console.log(`Temperature: ${result?.lead_temperature || "unknown"}`);

  if (result?.routing?.intents) {
    const activeIntents = Object.keys(result.routing.intents).filter(k => result.routing.intents[k] === true);
    if (activeIntents.length > 0) {
      console.log(`Intents: ${activeIntents.join(", ")}`);
    }
  }

  console.log("\n" + "═".repeat(60) + "\n");

  return result;
}

// Run if called directly
if (require.main === module) {
  const contactId = process.argv[2] || "7jeWz5I2AkxsMMxlNuuJ";
  const messageText = process.argv[3] || "New form submission";
  
  simulateAIResponse(contactId, messageText)
    .then(() => {
      console.log("✅ Simulation complete");
      process.exit(0);
    })
    .catch((err) => {
      console.error("❌ Error:", err);
      process.exit(1);
    });
}

module.exports = { simulateAIResponse };

