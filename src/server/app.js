const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const multer = require("multer");

const {
  getContact,
  updateSystemFields,
  createContact,
  updateContact,
  lookupContactIdByEmailOrPhone,
  sendConversationMessage,
  updateTattooFields,
  getConversationHistory,
  upsertContactFromWidget,
  uploadFilesToTattooCustomField,
  assignContactToArtist,
  addTranslatorAsFollower,
} = require("../clients/ghlClient");
const { handleInboundMessage } = require("../ai/controller");
const { getContactIdFromOrder } = require("../payments/squareClient");
const {
  extractCustomFieldsFromPayload,
  buildEffectiveContact,
  formatThreadForLLM,
  normalizeCustomFields,
} = require("../ai/contextBuilder");
const {
  syncPipelineOnEntry,
  transitionToStage,
} = require("../ai/opportunityManager");
const {
  OPPORTUNITY_STAGES,
  CALENDARS,
  TRANSLATOR_CALENDARS,
  TRANSLATOR_USER_IDS,
  CONSULTATION_CALENDARS,
  GHL_USER_IDS,
  GHL_CUSTOM_FIELD_IDS,
} = require("../config/constants");
const { formatSlotDisplay } = require("../ai/bookingController");
const {
  listAppointmentsForContact,
  updateAppointmentStatus,
  rescheduleAppointment,
} = require("../clients/ghlCalendarClient");
const {
  COMPACT_MODE,
  logIncomingMessage,
  logAIResponse,
  logSendResult,
  compactThread,
} = require("../utils/logger");
const {
  notifyDepositPaid,
  notifyLeadQualified,
} = require("../clients/appEventClient");
const {
  isPaymentAlreadyProcessed,
  handleSquarePaymentFinancials,
} = require("../clients/financialTracking");
const {
  handleQualifiedLeadTasks,
} = require("../ai/qualifiedLeadHandler");

// ═══════════════════════════════════════════════════════════════════════════
// MESSAGE DEBOUNCING SYSTEM
// Wait for 15 seconds of "quiet" before processing messages to batch
// multiple rapid messages together (e.g., photo + text sent in quick succession)
// ═══════════════════════════════════════════════════════════════════════════

const MESSAGE_DEBOUNCE_MS = 15000; // 15 seconds

// Store pending message batches by contactId
// Format: { contactId: { messages: [], payloads: [], timer: TimeoutId, receivedAt: Date } }
const pendingMessageBatches = new Map();

/**
 * Add a message to the pending batch for a contact.
 * Starts or resets the debounce timer.
 * Returns a Promise that resolves when the batch is ready to process.
 */
function addToBatch(contactId, messageText, payload) {
  return new Promise((resolve) => {
    let batch = pendingMessageBatches.get(contactId);
    
    if (batch) {
      // Batch exists - clear old timer and add to existing batch
      clearTimeout(batch.timer);
      batch.messages.push(messageText);
      batch.payloads.push(payload);
      console.log(`⏳ [DEBOUNCE] Added message to batch for ${contactId} (${batch.messages.length} total). Resetting 15s timer.`);
    } else {
      // New batch
      batch = {
        messages: [messageText],
        payloads: [payload],
        timer: null,
        receivedAt: new Date(),
        resolvers: [],
      };
      pendingMessageBatches.set(contactId, batch);
      console.log(`⏳ [DEBOUNCE] Started new batch for ${contactId}. Waiting 15s for more messages...`);
    }
    
    // Add this request's resolver to be called when batch is processed
    batch.resolvers.push(resolve);
    
    // Set new timer
    batch.timer = setTimeout(() => {
      const finalBatch = pendingMessageBatches.get(contactId);
      if (finalBatch) {
        pendingMessageBatches.delete(contactId);
        const elapsedSeconds = ((new Date() - finalBatch.receivedAt) / 1000).toFixed(1);
        console.log(`✅ [DEBOUNCE] Processing batch for ${contactId}: ${finalBatch.messages.length} message(s) after ${elapsedSeconds}s`);
        
        // Resolve all waiting requests with the batch data
        const batchData = {
          messages: finalBatch.messages,
          payloads: finalBatch.payloads,
          combinedText: finalBatch.messages.filter(m => m && m.trim()).join("\n\n"),
          latestPayload: finalBatch.payloads[finalBatch.payloads.length - 1],
        };
        
        // Resolve only the first one to actually process, others get null
        finalBatch.resolvers.forEach((resolver, idx) => {
          if (idx === 0) {
            resolver(batchData);
          } else {
            resolver(null); // Signal these requests to skip processing
          }
        });
      }
    }, MESSAGE_DEBOUNCE_MS);
  });
}

// Helper: Filter object to only show non-empty fields (for cleaner logs)
function filterNonEmpty(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const filtered = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    filtered[key] = value;
  }
  return filtered;
}

// Helper: Extract non-empty custom fields from contact
function getNonEmptyCustomFields(contact) {
  const cf = contact?.customField || contact?.customFields || {};
  return filterNonEmpty(cf);
}

// Helper: Derive channel context from webhook payload and contact
function deriveChannelContext(payload, contact) {
  // Check if this is a DM based on attribution source medium
  const medium = (
    payload?.contact?.attributionSource?.medium ||
    payload?.contact?.lastAttributionSource?.medium ||
    ""
  ).toLowerCase();
  
  // Check message type from GHL (type 11 = DM, type 1 = SMS, etc.)
  const messageType = payload?.message?.type;
  
  // Check tags for DM indicators
  const tagsRaw = payload?.tags || contact?.tags || [];
  const tags = Array.isArray(tagsRaw) ? tagsRaw : [tagsRaw];
  const tagsLower = tags.map(t => String(t).toLowerCase());
  
  const isDmFromMedium = medium === "facebook" || medium === "instagram" || medium === "fb" || medium === "ig";
  const isDmFromTags = tagsLower.some(t => 
    t.includes("dm") || 
    t.includes("instagram") || 
    t.includes("facebook") ||
    t.includes("messenger")
  );
  
  // Detect WhatsApp - check tags, medium, OR custom field from form
  const cf = contact?.customField || contact?.customFields || {};
  const whatsappUser = cf.whatsapp_user || cf.whatsappUser || "";
  const isWhatsAppFromField = whatsappUser.toLowerCase() === "yes";
  const isWhatsApp = tagsLower.some(t => t.includes("whatsapp")) || medium === "whatsapp" || isWhatsAppFromField;
  
  // Detect SMS (has phone, not DM, not WhatsApp)
  const hasPhone = !!(contact?.phone || contact?.phoneNumber || payload?.phone);
  const isDm = isDmFromMedium || isDmFromTags;
  const isSms = hasPhone && !isDm && !isWhatsApp && messageType !== 11;
  
  // Determine channel type for pipeline purposes
  let channelType = "unknown";
  if (isDm) {
    channelType = medium === "instagram" || medium === "ig" ? "instagram" : "facebook";
  } else if (isWhatsApp) {
    channelType = "whatsapp";
  } else if (isSms) {
    channelType = "sms";
  } else if (messageType === 11) {
    // GHL message type 11 is typically DM/social
    channelType = "dm";
  }
  
  return {
    isDm,
    hasPhone,
    isWhatsApp,
    isSms,
    channelType,
    conversationId: null,
    phone: contact?.phone || contact?.phoneNumber || payload?.phone || null,
  };
}

function createApp() {
  const app = express();

  // CORS configuration - allow requests from frontend domain
  app.use(cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like GHL embeds, mobile apps, iframes with sandbox)
      if (!origin) return callback(null, true);
      
      const allowedOrigins = [
        'https://tattooshopminneapolis.com',
        'https://app.onthebusinesscrm.com', // GHL custom domain
        'http://localhost:3000',
        'http://localhost:8080',
        'http://localhost:8888',
        'http://127.0.0.1:5500', // Common local dev server port
      ];
      
      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));

  // Use JSON body parsing for all routes except the Square webhook (raw body needed for signature)
  app.use((req, res, next) => {
    if (req.path === "/square/webhook") {
      return next();
    }
    return express.json({ limit: "1mb" })(req, res, next);
  });

  // Raw body for Square webhook verification
  app.use(
    "/square/webhook",
    express.raw({
      type: "*/*",
      limit: "1mb",
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  // Multer configuration for file uploads (memory storage)
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB limit per file
      files: 3, // Max 3 files
    },
  });

  // Lead endpoints for widget form submissions
  app.post("/lead/partial", async (req, res) => {
    try {
      console.log("\n📝 ════════════════════════════════════════════════════════");
      console.log("📝 LEAD PARTIAL SUBMISSION");
      console.log("📝 ════════════════════════════════════════════════════════");

      const payload = req.body || {};
      console.log("📦 Payload:", JSON.stringify(filterNonEmpty(payload), null, 2));

      const result = await upsertContactFromWidget(payload, "partial");
      
      if (result?.contactId) {
        // Sync pipeline on entry - Widget submissions start at INTAKE
        const contact = await getContact(result.contactId);
        const cf = contact?.customField || contact?.customFields || {};
        const hasOpportunity = !!cf.opportunity_id;
        if (!hasOpportunity) {
          console.log(`📊 [PIPELINE] New lead from Widget - syncing entry stage to INTAKE...`);
          await syncPipelineOnEntry(result.contactId, {
            channelType: "widget",
            isFirstMessage: true,
            contact,
          });
        }
        console.log(`✅ Partial lead created/updated: ${result.contactId}`);
      }

      console.log("📝 ════════════════════════════════════════════════════════\n");
      return res.status(200).json({ ok: true, contactId: result?.contactId });
    } catch (err) {
      console.error("❌ /lead/partial error:", err.message || err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/lead/final", upload.array("files", 3), async (req, res) => {
    try {
      console.log("\n📝 ════════════════════════════════════════════════════════");
      console.log("📝 LEAD FINAL SUBMISSION");
      console.log("📝 ════════════════════════════════════════════════════════");

      let payload = {};
      
      // Handle both JSON and multipart/form-data
      if (req.body.data) {
        // Multipart form data - parse JSON from 'data' field
        try {
          payload = JSON.parse(req.body.data);
        } catch (e) {
          console.error("❌ Failed to parse JSON from form data:", e.message);
          return res.status(400).json({ ok: false, error: "Invalid JSON in data field" });
        }
      } else {
        // Regular JSON body
        payload = req.body || {};
      }

      console.log("📦 Payload:", JSON.stringify(filterNonEmpty(payload), null, 2));
      console.log("📎 Files:", req.files?.length || 0);

      // Upsert contact with final mode (ensures consultation tag)
      const result = await upsertContactFromWidget(payload, "final");
      
      if (!result?.contactId) {
        console.error("❌ Failed to create/update contact");
        return res.status(500).json({ ok: false, error: "Failed to create contact" });
      }

      const contactId = result.contactId;

      // Upload files if any
      if (req.files && req.files.length > 0) {
        try {
          console.log(`📎 Uploading ${req.files.length} file(s) to contact ${contactId}...`);
          await uploadFilesToTattooCustomField(contactId, req.files);
          console.log("✅ Files uploaded successfully");
        } catch (fileErr) {
          console.error("❌ File upload error:", fileErr.message || fileErr);
          // Don't fail the whole request if file upload fails
        }
      }

      // Sync pipeline on entry - Widget submissions start at INTAKE
      const contact = await getContact(contactId);
      const cf = contact?.customField || contact?.customFields || {};
      const hasOpportunity = !!cf.opportunity_id;
      if (!hasOpportunity) {
        console.log(`📊 [PIPELINE] New lead from Widget - syncing entry stage to INTAKE...`);
        await syncPipelineOnEntry(contactId, {
          channelType: "widget",
          isFirstMessage: true,
          contact,
        });
      }

      console.log(`✅ Final lead created/updated: ${contactId}`);
      console.log("📝 ════════════════════════════════════════════════════════\n");
      return res.status(200).json({ ok: true, contactId });
    } catch (err) {
      console.error("❌ /lead/final error:", err.message || err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/lead/update", async (req, res) => {
    try {
      console.log("\n📝 ════════════════════════════════════════════════════════");
      console.log("📝 LEAD UPDATE (SECONDARY QUESTIONS)");
      console.log("📝 ════════════════════════════════════════════════════════");

      const { email, customFields } = req.body || {};
      console.log("📦 Update payload:", JSON.stringify(filterNonEmpty(req.body), null, 2));

      if (!email) {
        return res.status(400).json({ ok: false, error: "Email required" });
      }

      // Look up contact by email
      const contactId = await lookupContactIdByEmailOrPhone(email, null);
      
      if (!contactId) {
        console.error("❌ Contact not found for email:", email);
        return res.status(404).json({ ok: false, error: "Contact not found" });
      }

      console.log(`👤 Found contact: ${contactId}`);

      // Update the custom fields
      if (customFields && Object.keys(customFields).length > 0) {
        await updateTattooFields(contactId, customFields);
        console.log("✅ Updated custom fields:", Object.keys(customFields));
      }

      console.log("📝 ════════════════════════════════════════════════════════\n");
      return res.status(200).json({ ok: true, contactId });
    } catch (err) {
      console.error("❌ /lead/update error:", err.message || err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/ghl/message-webhook", async (req, res) => {
    try {
      // ═══ VERBOSE MODE HEADER ═══
      if (!COMPACT_MODE) {
        console.log("\n💬 ════════════════════════════════════════════════════════");
        console.log("💬 GHL MESSAGE WEBHOOK HIT");
        console.log("💬 ════════════════════════════════════════════════════════");
      }

      const payload = req.body || {};
      const contactId =
        payload.contactId ||
        payload.contact_id ||
        payload.contact?.id ||
        payload.contact?.contactId ||
        null;
      
      // Extract message text - handle both string and object formats
      // GHL sends message as {type: 11, body: "..."} for DM messages
      const rawMessage = payload.message;
      const messageText =
        (typeof rawMessage === "object" && rawMessage?.body) ? rawMessage.body :
        (typeof rawMessage === "string") ? rawMessage :
        payload.text ||
        payload.customData?.messageBody ||
        (typeof payload.body === "string" ? payload.body : null) ||
        payload.body?.text ||
        payload.body?.message ||
        "";

      // ═══ VERBOSE PAYLOAD LOGGING ═══
      if (!COMPACT_MODE) {
        const nonEmptyPayload = filterNonEmpty(payload);
        console.log("📦 Webhook Payload (non-empty fields):", JSON.stringify(nonEmptyPayload, null, 2));
        console.log("📩 Incoming message text:", messageText || "(empty)");
        console.log("👤 Contact ID:", contactId);
      }

      if (!contactId) {
        console.warn("⚠️ /ghl/message-webhook missing contactId");
        return res.status(200).json({ ok: false, error: "missing contactId" });
      }

      // ═══ MESSAGE DEBOUNCING ═══
      // Wait for 15 seconds of "quiet" to batch multiple rapid messages
      const batchData = await addToBatch(contactId, messageText, payload);
      
      // If batchData is null, another request will handle this batch
      if (!batchData) {
        if (!COMPACT_MODE) console.log(`⏭️ [DEBOUNCE] Skipping - batch will be processed by another request`);
        return res.status(200).json({ ok: true, debounced: true });
      }
      
      // Use the combined message text from all batched messages
      const combinedMessageText = batchData.combinedText;
      const latestPayload = batchData.latestPayload;
      
      if (!COMPACT_MODE) {
        console.log(`📦 [DEBOUNCE] Processing ${batchData.messages.length} batched message(s):`);
        batchData.messages.forEach((msg, idx) => {
          console.log(`   ${idx + 1}. ${msg || "(empty/image)"}`);
        });
      }

      const contactRaw = await getContact(contactId);
      
      // Extract custom fields from webhook payload (use latest payload for most current data)
      const webhookCustomFields = extractCustomFieldsFromPayload(latestPayload);
      
      // Merge webhook custom fields into contact (webhook payload has correct format)
      const contact = buildEffectiveContact(contactRaw, webhookCustomFields);
      const contactName = `${contact?.firstName || ""} ${contact?.lastName || ""}`.trim() || "(unknown)";
      
      // Derive channel context for message sending and pipeline sync (use latest payload)
      const channelContext = deriveChannelContext(latestPayload, contact);
      
      if (!COMPACT_MODE) {
        console.log("📋 Webhook custom fields extracted:", JSON.stringify(webhookCustomFields, null, 2));
        console.log("👤 Contact:", contact?.firstName || "(no first name)", contact?.lastName || "(no last name)");
        console.log("📋 Contact custom fields (merged):", JSON.stringify(getNonEmptyCustomFields(contact), null, 2));
        console.log("📡 Channel context:", channelContext);
      }

      // Sync pipeline on entry - SMS/DM/WhatsApp start at DISCOVERY
      const cf = contact?.customField || contact?.customFields || {};
      const hasOpportunity = !!cf.opportunity_id;
      if (!hasOpportunity && channelContext.channelType !== "unknown") {
        if (!COMPACT_MODE) console.log(`📊 [PIPELINE] New lead from ${channelContext.channelType} - syncing entry stage...`);
        await syncPipelineOnEntry(contactId, {
          channelType: channelContext.channelType,
          isFirstMessage: true,
          contact,
        });
      }

      // Fetch conversation history for context
      if (!COMPACT_MODE) console.log("📜 Fetching conversation history...");
      const rawMessages = await getConversationHistory(contactId, {
        limit: 100, // Fetch last 100 messages
        sortOrder: "desc", // Newest first
      });
      
      // Format thread for LLM with CRM fields for image context
      const conversationThread = formatThreadForLLM(rawMessages, {
        recentCount: 20, // Keep last 20 messages in full detail
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
      
      // ═══ COMPACT MODE: LOG INCOMING MESSAGE ═══
      if (COMPACT_MODE) {
        logIncomingMessage({
          contactId,
          contactName,
          channel: channelContext.channelType,
          message: combinedMessageText,
          customFields: webhookCustomFields,
          threadContext: conversationThread,
        });
      } else {
        console.log("📜 Thread context:", {
          totalMessages: conversationThread.totalCount,
          recentCount: conversationThread.thread?.length || 0,
          hasSummary: !!conversationThread.summary,
          hasImageContext: !!conversationThread.imageContext,
          wasHumanHandling: conversationThread.handoffContext?.wasHumanHandling || false,
          isReturningClient: !!cf.returning_client,
        });
      }

      const result = await handleInboundMessage({
        contact,
        aiPhase: null,
        leadTemperature: null,
        latestMessageText: combinedMessageText, // Use combined text from all batched messages
        contactProfile: {},
        consultExplained: contact?.customField?.consult_explained || webhookCustomFields?.consult_explained,
        conversationThread, // Pass thread context to AI
        channelContext, // Pass channel context for message sending
      });

      // ═══ COMPACT MODE: LOG AI RESPONSE ═══
      const bubbles = result?.aiResult?.bubbles || [];
      const fieldUpdates = result?.aiResult?.field_updates || {};
      
      if (COMPACT_MODE) {
        logAIResponse({
          bubbles,
          meta: result?.aiResult?.meta,
          fieldUpdates,
          timing: result?.timing,
          handler: result?.routing?.selected_handler,
          reason: result?.routing?.reason,
        });
      } else {
        console.log("🤖 AI Response Summary:", {
          bubblesCount: bubbles.length,
          phase: result?.ai_phase,
          handler: result?.routing?.selected_handler,
          reason: result?.routing?.reason,
          fieldUpdatesKeys: Object.keys(fieldUpdates),
        });
      }

      // Send the AI's bubbles to the user
      let sentCount = 0;
      for (const bubble of bubbles) {
        if (bubble && bubble.trim()) {
          try {
            await sendConversationMessage({
              contactId,
              body: bubble,
              channelContext,
            });
            sentCount++;
          } catch (err) {
            console.error("❌ Failed to send bubble:", err.message || err);
          }
        }
      }
      
      // ═══ COMPACT MODE: LOG SEND RESULT ═══
      if (COMPACT_MODE) {
        logSendResult({
          sent: sentCount,
          total: bubbles.length,
          channel: channelContext.channelType,
          contactId,
        });
      } else {
        console.log(`📤 Sent ${sentCount}/${bubbles.length} bubbles to GHL conversation`);
      }

      // Persist the field updates from AI
      if (Object.keys(fieldUpdates).length > 0 && contactId) {
        try {
          await updateTattooFields(contactId, fieldUpdates);
          if (!COMPACT_MODE) console.log("✅ Persisted field_updates:", Object.keys(fieldUpdates));
        } catch (err) {
          console.error("❌ Failed to persist field_updates:", err.message || err);
        }
      } else {
        if (!COMPACT_MODE) console.log("ℹ️ No field_updates from AI to persist this turn");
      }

      if (!COMPACT_MODE) console.log("💬 ════════════════════════════════════════════════════════\n");
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("❌ /ghl/message-webhook error:", err.message || err);
      return res.status(200).json({ ok: false });
    }
  });

  app.post("/ghl/form-webhook", async (req, res) => {
    try {
      console.log("\n📝 ════════════════════════════════════════════════════════");
      console.log("📝 GHL FORM WEBHOOK HIT");
      console.log("📝 ════════════════════════════════════════════════════════");

      const payload = req.body || {};
      const {
        contactId: bodyContactId,
        contact_id: legacyContactId,
        firstName,
        lastName,
        email,
        phone,
        message,
        notes,
      } = payload;

      // Log non-empty payload fields
      const nonEmptyPayload = filterNonEmpty(payload);
      console.log("📦 Form Payload (non-empty fields):", JSON.stringify(nonEmptyPayload, null, 2));

      let contactId =
        bodyContactId || legacyContactId || payload.contact?.id || null;

      if (!contactId) {
        console.log("🔍 No contactId in payload, looking up by email/phone...");
        contactId = await lookupContactIdByEmailOrPhone(email, phone);
      }

      if (!contactId) {
        console.log("🆕 Creating new contact...");
        const created = await createContact({
          firstName,
          lastName,
          email,
          phone,
        });
        contactId =
          created?.id || created?._id || created?.contact?.id || created?.contact?._id || null;
        console.log("🆕 Created new contact:", contactId);
      } else {
        console.log("🔄 Updating existing contact:", contactId);
        await updateContact(contactId, {
          firstName,
          lastName,
          email,
          phone,
        });
      }

      const contact = contactId ? await getContact(contactId) : null;

      // Log contact info
      console.log("👤 Contact:", contact?.firstName || "(no first name)", contact?.lastName || "(no last name)");
      console.log("👤 Contact ID:", contactId);

      if (contact) {
        const webhookCustomFields = extractCustomFieldsFromPayload(payload);
        const effectiveContact = buildEffectiveContact(contact, webhookCustomFields);
        const syntheticText = message || notes || "New form submission";
        console.log("📩 Form message/notes:", syntheticText);
        console.log("📋 Contact custom fields (non-empty):", JSON.stringify(getNonEmptyCustomFields(effectiveContact), null, 2));

        // Sync pipeline on entry - Widget/Form submissions start at INTAKE
        const cf = effectiveContact?.customField || effectiveContact?.customFields || {};
        const hasOpportunity = !!cf.opportunity_id;
        if (!hasOpportunity) {
          console.log(`📊 [PIPELINE] New lead from Widget/Form - syncing entry stage to INTAKE...`);
          await syncPipelineOnEntry(contactId, {
            channelType: "widget",
            isFirstMessage: true,
            contact: effectiveContact,
          });
        }

        // Fetch conversation history for context (may be empty for new leads from form)
        console.log("📜 Fetching conversation history...");
        const rawMessages = await getConversationHistory(contactId, {
          limit: 100,
          sortOrder: "desc",
        });
        
        // Format thread for LLM with CRM fields for image context
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
          wasHumanHandling: conversationThread.handoffContext?.wasHumanHandling || false,
        });

        // Derive channel context for message sending (before handleInboundMessage so it can use it)
        const channelContext = deriveChannelContext(payload, effectiveContact);
        console.log("📡 Channel context:", channelContext);

        const result = await handleInboundMessage({
          contact: effectiveContact,
          aiPhase: null,
          leadTemperature: null,
          latestMessageText: syntheticText,
          contactProfile: {},
          consultExplained: effectiveContact?.customField?.consult_explained || webhookCustomFields?.consult_explained,
          conversationThread, // Pass thread context to AI
          channelContext, // Pass channel context for message sending
        });

        // Log AI result summary
        console.log("🤖 AI Response Summary:", {
          bubblesCount: result?.aiResult?.bubbles?.length || 0,
          phase: result?.ai_phase,
          handler: result?.routing?.selected_handler,
          reason: result?.routing?.reason,
          fieldUpdatesKeys: Object.keys(result?.aiResult?.field_updates || {}),
        });

        // Send the AI's bubbles to the user
        const bubbles = result?.aiResult?.bubbles || [];
        let sentCount = 0;
        for (const bubble of bubbles) {
          if (bubble && bubble.trim()) {
            try {
              await sendConversationMessage({
                contactId,
                body: bubble,
                channelContext,
              });
              sentCount++;
            } catch (err) {
              console.error("❌ Failed to send bubble:", err.message || err);
            }
          }
        }
        console.log(`📤 Sent ${sentCount}/${bubbles.length} bubbles to GHL conversation`);

        // Persist the field updates from AI
        const fieldUpdates = result?.aiResult?.field_updates || {};
        if (Object.keys(fieldUpdates).length > 0 && contactId) {
          try {
            await updateTattooFields(contactId, fieldUpdates);
            console.log("✅ Persisted field_updates:", Object.keys(fieldUpdates));
          } catch (err) {
            console.error("❌ Failed to persist field_updates:", err.message || err);
          }
        } else {
          console.log("ℹ️ No field_updates from AI to persist this turn");
        }
      } else {
        console.warn("⚠️ No contact found/created, skipping AI processing");
      }

      console.log("📝 ════════════════════════════════════════════════════════\n");
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("❌ /ghl/form-webhook error:", err.message || err);
      return res.status(200).json({ ok: false });
    }
  });

  app.post("/square/webhook", async (req, res) => {
    const secret = process.env.SQUARE_WEBHOOK_SECRET;
    // FIX: Correct header name for Square HMAC-SHA256 signature
    const signature = req.get("x-square-hmacsha256-signature") || "";

    if (!secret) {
      console.warn("⚠️ Missing SQUARE_WEBHOOK_SECRET");
      return res.status(401).send("missing secret");
    }

    // FIX: Square signature = HMAC-SHA256(webhookUrl + requestBody, signatureKey)
    const raw = req.rawBody || Buffer.from("");
    const notificationUrl = "https://studio-az-setter-backend.onrender.com/square/webhook";
    const stringToSign = notificationUrl + raw.toString();
    const expected = crypto.createHmac("sha256", secret).update(stringToSign).digest("base64");

    if (signature !== expected) {
      console.error("❌ Square signature mismatch:", {
        receivedSignature: signature ? signature.substring(0, 20) + "..." : "(empty)",
        expectedSignature: expected.substring(0, 20) + "...",
        notificationUrl,
      });
      return res.status(401).send("invalid signature");
    }

    let payload = {};
    try {
      payload = JSON.parse(raw.toString() || "{}");
    } catch (err) {
      console.error("❌ /square/webhook invalid JSON:", err.message || err);
      return res.status(400).send("invalid json");
    }

    try {
      if (!COMPACT_MODE) {
        console.log("\n💳 ════════════════════════════════════════════════════════");
        console.log("💳 SQUARE PAYMENT WEBHOOK HIT");
        console.log("💳 ════════════════════════════════════════════════════════");
      }

      // IMPORTANT: Only process payment.updated events with COMPLETED status to avoid duplicates
      // Square sends multiple webhook events (order.created, order.updated, payment.created, payment.updated)
      // We only want to process the final payment.updated event when payment is complete
      const eventType = payload?.type || '';
      
      if (eventType !== 'payment.updated') {
        if (!COMPACT_MODE) {
          console.log(`💳 Ignoring ${eventType} event (only processing payment.updated)`);
        }
        return res.json({ received: true, ignored: true, reason: `Only processing payment.updated events` });
      }

      const payment = payload?.data?.object?.payment || {};
      const paymentStatus = payment.status || '';
      
      // Only process completed payments
      if (paymentStatus !== 'COMPLETED') {
        if (!COMPACT_MODE) {
          console.log(`💳 Ignoring payment with status: ${paymentStatus} (waiting for COMPLETED)`);
        }
        return res.json({ received: true, ignored: true, reason: `Payment status is ${paymentStatus}` });
      }

      const orderId = payment.order_id || payment.orderId || null;
      let contactId = payment.reference_id || payment.referenceId || null;

      // Debug: Log payment structure to understand what we're receiving
      if (!COMPACT_MODE) {
        console.log("💳 [DEBUG] Payment object keys:", Object.keys(payment));
        console.log("💳 [DEBUG] Order ID:", orderId);
        console.log("💳 [DEBUG] Reference ID from payment:", contactId);
        console.log("💳 [DEBUG] Payment Status:", paymentStatus);
      }

      if (!contactId && orderId) {
        console.log("💳 [DEBUG] No reference_id on payment, fetching from order:", orderId);
        contactId = await getContactIdFromOrder(orderId);
        console.log("💳 [DEBUG] Contact ID from order:", contactId);
      }

      if (contactId) {
        const amount = payment.amount_money?.amount || payment.total_money?.amount || 0;
        if (COMPACT_MODE) {
          console.log(`\n💳 SQUARE DEPOSIT PAID: contact=${contactId.slice(0, 8)}… $${amount / 100}`);
        } else {
          console.log(`💳 Deposit paid for contact: ${contactId}`);
        }
        
        // Update deposit_paid field
        await updateSystemFields(contactId, {
          deposit_paid: true,
        });

        // Fetch contact info for consultation type check and personalization
        const contact = await getContact(contactId);
        // Normalize custom fields from array to object with friendly names
        const cf = normalizeCustomFields(contact?.customField || contact?.customFields || {});
        const firstName = contact?.firstName || contact?.first_name || "";
        const contactName = `${firstName} ${contact?.lastName || contact?.last_name || ""}`.trim() || "Unknown";
        const consultationType = cf.consultation_type || cf.consultationType || "online";
        const translatorNeeded = cf.translator_needed === true || cf.translator_needed === "true" || cf.translator_needed === "Yes";
        const isMessageConsult = consultationType === "message";

        // === FINANCIAL TRACKING: Record deposit payment ===
        try {
          let alreadyProcessed = false;
          let canCheckDuplicates = true;
          
          // Try to check for duplicates
          try {
            alreadyProcessed = await isPaymentAlreadyProcessed(payment.id);
          } catch (checkErr) {
            console.error('[Financial] Cannot check for duplicates due to database error:', checkErr.message);
            console.warn('[Financial] Proceeding with payment recording despite duplicate check failure');
            canCheckDuplicates = false;
            // Don't throw - we'll proceed with recording and log the duplicate check failure
          }
          
          if (alreadyProcessed) {
            console.log(`[Financial] Payment ${payment.id} already processed, skipping`);
          } else {
            const assignedArtist = cf.assigned_artist || cf.inquired_technician || 'unknown';
            await handleSquarePaymentFinancials(payment, contactId, contactName, assignedArtist);
            if (!COMPACT_MODE) {
              const checkStatus = canCheckDuplicates ? 'duplicate-checked' : 'duplicate-check-failed';
              console.log(`[Financial] Successfully recorded payment for contact ${contactId} (${checkStatus})`);
            }
          }
        } catch (financialErr) {
          console.error('[Financial] Error recording payment:', financialErr.message || financialErr);
          // Don't fail the webhook - deposit was already processed
        }

        // Sync pipeline to QUALIFIED stage first
        if (!COMPACT_MODE) console.log(`📊 [PIPELINE] Deposit paid - transitioning to QUALIFIED...`);
        await transitionToStage(contactId, OPPORTUNITY_STAGES.QUALIFIED);
        if (!COMPACT_MODE) console.log(`✅ [PIPELINE] Contact ${contactId} moved to QUALIFIED stage`);

        // === NOTIFY iOS APP: Deposit paid event ===
        const paymentId = payment.id || payment.payment_id || null;
        const assignedArtist = cf.assigned_artist || cf.inquired_technician || null;
        await notifyDepositPaid(contactId, {
          amount,
          paymentId,
          artistId: assignedArtist,
          consultationType,
        });

        // === NOTIFY iOS APP: Lead qualified event ===
        await notifyLeadQualified(contactId, {
          assignedArtist,
          consultationType,
          tattooSummary: cf.tattoo_summary || null,
        });

        // === iOS APP TASK CREATION: Based on consultation type, language, and tattoo size ===
        try {
          const languagePreference = cf.language_preference || cf.languagePreference || "English";
          const leadSpanishComfortable = cf.lead_spanish_comfortable === true || 
                                          cf.lead_spanish_comfortable === "true" || 
                                          cf.lead_spanish_comfortable === "Yes";
          const isSpanishOrComfortable = languagePreference === "Spanish" || leadSpanishComfortable;
          const tattooSize = cf.tattoo_size || cf.size_of_tattoo || "";

          // Use the actual GHL assigned user ID from the contact, not the custom field
          // This ensures tasks are created for the user who owns the contact
          const assignedToUserId = contact?.assignedTo || contact?.assignedUserId || null;

          // Map GHL user IDs to artist names for the webhook server
          const USER_ID_TO_ARTIST_NAME = {
            '1wuLf50VMODExBSJ9xPI': 'Joan',
            'O8ChoMYj1BmMWJJsDlvC': 'Andrew',
            'uAWhIMemqUPJC1SqCyDR': 'Maria',
            '1kFG5FWdUDhXLUX46snG': 'Lionel',
            'Wl24x1ZrucHuHatM0ODD': 'Claudia',
          };
          
          const artistName = assignedToUserId ? USER_ID_TO_ARTIST_NAME[assignedToUserId] || assignedToUserId : null;

          await handleQualifiedLeadTasks({
            contactId,
            contactName,
            consultationType,
            isSpanishOrComfortable,
            tattooSize,
            assignedArtist: artistName
          });
        } catch (taskErr) {
          console.error("❌ [TASK] Failed to create iOS app task:", taskErr.message || taskErr);
          // Don't fail the webhook - task creation is non-critical
        }

        // === MESSAGE-BASED CONSULTATION: Assign artist and move to CONSULT_MESSAGE ===
        if (isMessageConsult) {
          if (!COMPACT_MODE) console.log(`📝 [MESSAGE CONSULT] Deposit paid for message consultation - assigning artist...`);
          
          // Assign the artist to the contact
          try {
            await assignContactToArtist(contactId);
            if (!COMPACT_MODE) console.log(`✅ [MESSAGE CONSULT] Artist assigned to contact ${contactId}`);
          } catch (assignErr) {
            console.error("❌ [MESSAGE CONSULT] Failed to assign artist:", assignErr.message || assignErr);
          }
          
          // Transition to CONSULT_MESSAGE stage
          try {
            await transitionToStage(contactId, OPPORTUNITY_STAGES.CONSULT_MESSAGE);
            if (COMPACT_MODE) {
              console.log(`   → CONSULT_MESSAGE stage | artist assigned`);
            } else {
              console.log(`✅ [PIPELINE] Contact ${contactId} moved to CONSULT_MESSAGE stage`);
            }
          } catch (stageErr) {
            console.error("❌ [PIPELINE] Failed to transition to CONSULT_MESSAGE:", stageErr.message || stageErr);
          }
        }

        // === VIDEO CALL CONSULTATION: Add translator as follower if needed ===
        if (!isMessageConsult && translatorNeeded) {
          if (!COMPACT_MODE) console.log(`🌐 [TRANSLATOR] Adding translator as follower for video consultation...`);
          try {
            await addTranslatorAsFollower(contactId);
            if (COMPACT_MODE) {
              console.log(`   → translator added as follower`);
            } else {
              console.log(`✅ [TRANSLATOR] Translator added as follower for contact ${contactId}`);
            }
          } catch (followerErr) {
            console.error("❌ [TRANSLATOR] Failed to add translator as follower:", followerErr.message || followerErr);
          }
        }

        // === SEND DEPOSIT CONFIRMATION MESSAGE ===
        try {
          // Build channel context from contact for message sending
          const whatsappUser = cf.whatsapp_user || cf.whatsappUser || cf.FnYDobmYqnXDxlLJY5oe || "";
          const hasWhatsAppEnabled = whatsappUser.toLowerCase() === "yes";
          const depositChannelContext = {
            isDm: false,
            hasPhone: !!(contact?.phone || contact?.phoneNumber),
            isWhatsApp: hasWhatsAppEnabled,
            isSms: !hasWhatsAppEnabled && !!(contact?.phone || contact?.phoneNumber),
            channelType: hasWhatsAppEnabled ? "whatsapp" : "sms",
            conversationId: null,
            phone: contact?.phone || contact?.phoneNumber || null,
          };

          // Get the pending/hold slot info
          const pendingSlotDisplay = cf.pending_slot_display || cf.pendingSlotDisplay || null;
          const pendingSlotStartTime = cf.pending_slot_start_time || cf.pendingSlotStartTime || null;
          
          // Format the appointment time if we have it
          let appointmentDisplay = pendingSlotDisplay;
          if (!appointmentDisplay && pendingSlotStartTime) {
            try {
              appointmentDisplay = formatSlotDisplay(new Date(pendingSlotStartTime));
            } catch (e) {
              appointmentDisplay = pendingSlotStartTime;
            }
          }
          
          // Build confirmation message based on consultation type
          let confirmationMessage = "";
          if (isMessageConsult) {
            // Message-based consultation confirmation
            confirmationMessage = firstName
              ? `Got your deposit${firstName ? `, ${firstName}` : ""} — you're all set! 🎉\n\n` +
                `The artist has been added to this conversation and will reach out shortly to discuss your tattoo idea.`
              : `Got your deposit — you're all set! 🎉\n\n` +
                `The artist has been added to this conversation and will reach out shortly to discuss your tattoo idea.`;
          } else if (appointmentDisplay) {
            // Video consultation with appointment time
            const consultTypeText = translatorNeeded 
              ? "video consultation with translator" 
              : "video consultation";
            
            confirmationMessage = firstName 
              ? `Got your deposit${firstName ? `, ${firstName}` : ""} — your consultation is confirmed! 🎉\n\n` +
                `📅 ${appointmentDisplay}\n` +
                `📍 ${consultTypeText}\n\n` +
                `You'll get a reminder before the call. See you then!`
              : `Got your deposit — your consultation is confirmed! 🎉\n\n` +
                `📅 ${appointmentDisplay}\n` +
                `📍 ${consultTypeText}\n\n` +
                `You'll get a reminder before the call. See you then!`;
          } else {
            // No specific appointment time found - generic confirmation
            confirmationMessage = firstName
              ? `Got your deposit${firstName ? `, ${firstName}` : ""} — you're all set! 🎉\n\n` +
                `Your consultation is confirmed. We'll follow up with the details shortly.`
              : `Got your deposit — you're all set! 🎉\n\n` +
                `Your consultation is confirmed. We'll follow up with the details shortly.`;
          }
          
          // Send the confirmation message
          await sendConversationMessage({
            contactId,
            body: confirmationMessage,
            channelContext: depositChannelContext,
          });
          if (COMPACT_MODE) {
            console.log(`   → confirmation sent ✓`);
          } else {
            console.log(`✅ [DEPOSIT] Sent confirmation message to contact ${contactId}`);
          }
          
        } catch (msgErr) {
          console.error("❌ [DEPOSIT] Failed to send confirmation message:", msgErr.message || msgErr);
          // Don't fail the webhook - deposit was already processed
        }
      } else {
        console.warn("⚠️ /square/webhook could not resolve contactId from payment");
        console.warn("💳 [DEBUG] Payment ID:", payment.id);
        console.warn("💳 [DEBUG] Order ID:", orderId);
        console.warn("💳 [DEBUG] Payload:", JSON.stringify(payload, null, 2));
      }

      if (!COMPACT_MODE) console.log("💳 ════════════════════════════════════════════════════════\n");
    } catch (err) {
      console.error("❌ /square/webhook processing error:", err.message || err);
    }

    return res.status(200).json({ ok: true });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // APPOINTMENT SYNC WEBHOOK - Sync artist <-> translator appointments
  // When an appointment is cancelled or rescheduled on one calendar,
  // find and update the sibling appointment on the other calendar.
  // ═══════════════════════════════════════════════════════════════════════════
  
  // Helper: Ensure time string has timezone offset (America/Chicago)
  // GHL sends times without timezone, but expects them back WITH timezone
  const ensureTimezone = (timeStr) => {
    if (!timeStr) return timeStr;
    // If already has timezone info (Z or +/- offset), return as-is
    if (/Z$/.test(timeStr) || /[+-]\d{2}:\d{2}$/.test(timeStr)) {
      return timeStr;
    }
    // Add America/Chicago offset (CST = -06:00, CDT = -05:00)
    // For simplicity, use -06:00 (CST) - could be enhanced to detect DST
    const date = new Date(timeStr);
    const month = date.getMonth(); // 0-11
    // Rough DST check: March-November is CDT (-05:00), else CST (-06:00)
    const isDST = month >= 2 && month <= 10; // March (2) to November (10)
    const offset = isDST ? "-05:00" : "-06:00";
    return `${timeStr}${offset}`;
  };

  app.post("/ghl/appointment-webhook", async (req, res) => {
    // Acknowledge immediately so GHL doesn't retry
    res.status(200).json({ ok: true });

    // Process asynchronously
    setImmediate(async () => {
      try {
        console.log("\n📅 ════════════════════════════════════════════════════════");
        console.log("📅 GHL APPOINTMENT WEBHOOK HIT");
        console.log("📅 ════════════════════════════════════════════════════════");

        const payload = req.body || {};
        const calendar = payload.calendar || {};

        // Extract key fields from payload
        const contactId = payload.contact_id || payload.contactId || payload.contact?.id || null;
        const appointmentId = calendar.appointmentId || payload.appointmentId || null;
        const calendarId = calendar.id || calendar.calendarId || payload.calendarId || null;
        
        // Get times and ensure they have timezone info
        const rawStartTime = calendar.startTime || payload.startTime || null;
        const rawEndTime = calendar.endTime || payload.endTime || null;
        const startTime = ensureTimezone(rawStartTime);
        const endTime = ensureTimezone(rawEndTime);

        // Get appointment status (GHL sometimes misspells it as "appoinmentStatus")
        const rawStatus = String(
          calendar.appoinmentStatus || 
          calendar.appointmentStatus || 
          calendar.status || 
          payload.appointmentStatus ||
          ""
        ).toLowerCase();

        const isCancelled = ["cancelled", "canceled"].includes(rawStatus);

        console.log("📦 Appointment webhook payload:", {
          contactId,
          appointmentId,
          calendarId,
          rawStartTime,
          rawEndTime,
          startTime, // with timezone
          endTime,   // with timezone
          status: rawStatus,
          isCancelled,
        });

        if (!contactId || !appointmentId || !calendarId) {
          console.warn("⚠️ Missing required fields (contactId, appointmentId, or calendarId)");
          return;
        }

        // Build calendar sets to determine calendar type
        const artistCalendarSet = new Set(Object.values(CALENDARS).filter(Boolean));
        const translatorCalendarSet = new Set(Object.values(TRANSLATOR_CALENDARS).filter(Boolean));
        const consultationCalendarSet = new Set(Object.values(CONSULTATION_CALENDARS).filter(Boolean));

        const isArtistCalendar = artistCalendarSet.has(calendarId);
        const isTranslatorCalendar = translatorCalendarSet.has(calendarId);
        const isConsultationCalendar = consultationCalendarSet.has(calendarId);

        // Handle consultation calendar appointments - check for consultation ended
        if (isConsultationCalendar) {
          console.log("📋 Consultation calendar detected, checking for consultation end...");
          await handleConsultationAppointment(contactId, {
            appointmentId,
            calendarId,
            startTime,
            endTime,
            rawStatus,
            isCancelled,
          });
          return;
        }

        if (!isArtistCalendar && !isTranslatorCalendar) {
          console.log("ℹ️ Calendar not in artist, translator, or consultation list, skipping sync");
          return;
        }

        const actorType = isArtistCalendar ? "artist" : "translator";
        const siblingCalendarSet = isArtistCalendar ? translatorCalendarSet : artistCalendarSet;

        console.log(`🔍 Appointment is on ${actorType} calendar, looking for sibling on ${isArtistCalendar ? "translator" : "artist"} calendar...`);

        // Fetch all appointments for this contact to find the sibling
        let allAppointments = [];
        try {
          allAppointments = await listAppointmentsForContact(contactId);
        } catch (err) {
          console.error("❌ Failed to fetch appointments for contact:", err.message || err);
          return;
        }

        // Extract pairing key from notes (format: PairingKey:XXXXXXXX)
        const extractPairingKey = (notes) => {
          if (!notes) return null;
          const match = notes.match(/PairingKey:([A-F0-9]{8})/i);
          return match ? match[0] : null; // Return full "PairingKey:XXXXXXXX"
        };

        // Get notes from the webhook payload
        const triggerNotes = calendar.notes || payload.notes || "";
        const triggerPairingKey = extractPairingKey(triggerNotes);
        
        console.log("🔑 Pairing key from webhook notes:", triggerPairingKey || "(none found)");

        // Debug: Log all appointments found
        console.log("📋 All appointments for contact:", allAppointments.map(apt => ({
          id: apt.id,
          calendarId: apt.calendarId,
          status: apt.appointmentStatus || apt.status,
          startTime: apt.startTime,
          notes: apt.notes ? apt.notes.substring(0, 50) + "..." : "(no notes)",
          pairingKey: extractPairingKey(apt.notes),
          isOnSiblingCalendar: siblingCalendarSet.has(apt.calendarId),
        })));
        console.log("🔍 Looking for siblings on calendars:", Array.from(siblingCalendarSet));

        // Find sibling appointment - first by pairing key, then by exact time match
        let siblingAppointments = [];
        
        // === STRATEGY 1: Match by PairingKey ===
        if (triggerPairingKey) {
          siblingAppointments = allAppointments.filter((apt) => {
            // Must be on a sibling calendar
            if (!siblingCalendarSet.has(apt.calendarId)) return false;
            // Must not be the same appointment
            if (apt.id === appointmentId) return false;
            // Must have matching pairing key
            const aptPairingKey = extractPairingKey(apt.notes);
            if (aptPairingKey !== triggerPairingKey) return false;
            // Must not already be cancelled (for cancellation syncs)
            const siblingStatus = String(apt.appointmentStatus || apt.status || "").toLowerCase();
            if (isCancelled && ["cancelled", "canceled"].includes(siblingStatus)) return false;
            
            console.log(`   ✅ Matched sibling ${apt.id} by PairingKey: ${aptPairingKey}`);
            return true;
          });
          
          if (siblingAppointments.length > 0) {
            console.log(`🔑 Found ${siblingAppointments.length} sibling(s) by PairingKey match`);
          }
        }

        // === STRATEGY 2: Fallback to exact start time match (only if no pairing key match) ===
        if (siblingAppointments.length === 0 && rawStartTime) {
          console.log("🔍 No PairingKey match, falling back to exact start time match...");
          
          // Normalize start time for comparison (strip timezone for comparison)
          const normalizeTime = (t) => {
            if (!t) return null;
            // Remove any timezone suffix for comparison
            return t.replace(/[-+]\d{2}:\d{2}$/, "").replace(/Z$/, "");
          };
          
          const triggerStartNormalized = normalizeTime(rawStartTime);
          
          siblingAppointments = allAppointments.filter((apt) => {
            // Must be on a sibling calendar
            if (!siblingCalendarSet.has(apt.calendarId)) {
              console.log(`   ❌ Apt ${apt.id} not on sibling calendar`);
              return false;
            }
            // Must not be the same appointment
            if (apt.id === appointmentId) {
              console.log(`   ❌ Apt ${apt.id} is the same appointment`);
              return false;
            }
            // Must have EXACT same start time
            const aptStartNormalized = normalizeTime(apt.startTime);
            if (aptStartNormalized !== triggerStartNormalized) {
              console.log(`   ❌ Apt ${apt.id} start time mismatch: ${aptStartNormalized} vs ${triggerStartNormalized}`);
              return false;
            }
            // Must not already be cancelled (for cancellation syncs)
            const siblingStatus = String(apt.appointmentStatus || apt.status || "").toLowerCase();
            if (isCancelled && ["cancelled", "canceled"].includes(siblingStatus)) {
              console.log(`   ❌ Apt ${apt.id} already cancelled`);
              return false;
            }
            
            console.log(`   ✅ Matched sibling ${apt.id} by exact start time: ${aptStartNormalized}`);
            return true;
          });
          
          if (siblingAppointments.length > 0) {
            console.log(`⏰ Found ${siblingAppointments.length} sibling(s) by exact start time fallback`);
          }
        }

        if (siblingAppointments.length === 0) {
          console.log("ℹ️ No sibling appointment found to sync (no PairingKey or exact time match)");
          return;
        }

        console.log(`📅 Found ${siblingAppointments.length} sibling appointment(s) to sync`);

        // Helper: Get translator user ID for a calendar
        const getTranslatorUserIdForCalendar = (calId) => {
          if (calId === TRANSLATOR_CALENDARS.LIONEL_ONLINE) return TRANSLATOR_USER_IDS.LIONEL;
          if (calId === TRANSLATOR_CALENDARS.MARIA_ONLINE) return TRANSLATOR_USER_IDS.MARIA;
          return null;
        };

        // Process each sibling
        for (const sibling of siblingAppointments) {
          const siblingId = sibling.id;
          const siblingCalendarId = sibling.calendarId;
          
          // Get the assignedUserId - use existing one from sibling, or look up for translator calendars
          const siblingAssignedUserId = sibling.assignedUserId || 
            getTranslatorUserIdForCalendar(siblingCalendarId);
          
          if (isCancelled) {
            // === CANCEL SYNC ===
            console.log(`🚫 Cancelling sibling appointment ${siblingId}...`);
            try {
              await updateAppointmentStatus(siblingId, "cancelled", siblingCalendarId);
              console.log(`✅ Sibling appointment ${siblingId} cancelled`);
            } catch (err) {
              console.error(`❌ Failed to cancel sibling ${siblingId}:`, err.message || err);
            }
          } else if (startTime && endTime) {
            // === RESCHEDULE SYNC ===
            // Only reschedule if times are different
            const siblingStart = sibling.startTime;
            const siblingEnd = sibling.endTime;
            
            if (siblingStart === startTime && siblingEnd === endTime) {
              console.log(`ℹ️ Sibling ${siblingId} already has the same time, skipping`);
              continue;
            }

            console.log(`📅 Rescheduling sibling appointment ${siblingId} to match...`);
            console.log(`   From: ${siblingStart} - ${siblingEnd}`);
            console.log(`   To:   ${startTime} - ${endTime}`);
            console.log(`   AssignedUserId: ${siblingAssignedUserId || "(none)"}`);
            
            try {
              await rescheduleAppointment(siblingId, {
                startTime,
                endTime,
                calendarId: siblingCalendarId,
                assignedUserId: siblingAssignedUserId,
              });
              console.log(`✅ Sibling appointment ${siblingId} rescheduled`);
            } catch (err) {
              console.error(`❌ Failed to reschedule sibling ${siblingId}:`, err.message || err);
            }
          }
        }

        console.log("📅 ════════════════════════════════════════════════════════\n");
      } catch (err) {
        console.error("❌ Appointment webhook handler error:", err.message || err);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // FINANCIAL TRACKING API ENDPOINTS
  // ═══════════════════════════════════════════════════════════════════════════

  const { supabase } = require("../clients/supabaseClient");
  const { recordTransaction } = require("../clients/financialTracking");

  // POST /api/transactions - Record a manual transaction
  app.post("/api/transactions", async (req, res) => {
    try {
      const {
        contactId,
        contactName,
        appointmentId,
        artistId,
        transactionType,
        paymentMethod,
        paymentRecipient,
        grossAmount,
        sessionDate,
        notes,
        locationId
      } = req.body;

      // Validate required fields
      if (!contactId || !artistId || !grossAmount || !transactionType || !paymentMethod) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: contactId, artistId, grossAmount, transactionType, paymentMethod'
        });
      }

      const transaction = await recordTransaction({
        contactId,
        contactName: contactName || 'Unknown',
        appointmentId,
        artistId,
        transactionType,
        paymentMethod,
        paymentRecipient: paymentRecipient || 'shop',
        grossAmount: parseFloat(grossAmount),
        sessionDate: sessionDate ? new Date(sessionDate) : new Date(),
        squarePaymentId: null,
        locationId: locationId || process.env.GHL_LOCATION_ID || 'studio_az_tattoo',
        notes
      });

      res.json({
        success: true,
        transaction
      });

    } catch (error) {
      console.error('[API] Error recording transaction:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // GET /api/artists/:artistId/earnings - Get artist earnings summary
  app.get("/api/artists/:artistId/earnings", async (req, res) => {
    try {
      if (!supabase) {
        return res.status(503).json({
          success: false,
          error: 'Financial tracking not available - Supabase not configured'
        });
      }

      const { artistId } = req.params;
      const { locationId, startDate, endDate } = req.query;

      let query = supabase
        .from('transactions')
        .select('*')
        .eq('artist_ghl_id', artistId);

      if (locationId) {
        query = query.eq('location_id', locationId);
      }
      if (startDate) {
        query = query.gte('created_at', startDate);
      }
      if (endDate) {
        query = query.lte('created_at', endDate);
      }

      const { data: transactions, error } = await query.order('created_at', { ascending: false });

      if (error) throw error;

      // Calculate summary
      let totalEarned = 0;
      let pendingFromShop = 0;
      let owedToShop = 0;
      let revenueGenerated = 0;

      for (const tx of transactions || []) {
        totalEarned += parseFloat(tx.artist_amount) || 0;

        // Calculate revenue generated (sum of deposits + session payments)
        if (tx.transaction_type === 'session_payment' || tx.transaction_type === 'deposit') {
          revenueGenerated += parseFloat(tx.gross_amount) || 0;
        }

        if (tx.settlement_status !== 'settled') {
          if (tx.payment_recipient === 'shop') {
            pendingFromShop += parseFloat(tx.artist_amount) || 0;
          } else if (tx.payment_recipient === 'artist_direct') {
            owedToShop += parseFloat(tx.shop_amount) || 0;
          }
        }
      }

      // Get top clients from client_financials
      let topClients = [];
      const uniqueContactIds = [...new Set((transactions || []).map(t => t.contact_id).filter(Boolean))];
      if (uniqueContactIds.length > 0) {
        const { data: clientFinancials } = await supabase
          .from('client_financials')
          .select('*')
          .in('contact_id', uniqueContactIds)
          .order('total_spent', { ascending: false })
          .limit(10);

        if (clientFinancials) {
          topClients = clientFinancials.map(cf => ({
            contact_id: cf.contact_id,
            contact_name: cf.contact_name,
            total_spent: parseFloat(cf.total_spent) || 0,
            quote_amount: cf.quote_amount ? parseFloat(cf.quote_amount) : null,
            completed_tattoos: cf.completed_tattoos || 0,
            is_returning_client: cf.is_returning_client || false,
            last_appointment_date: cf.last_appointment_date
          }));
        }
      }

      res.json({
        success: true,
        earnings: {
          artistId,
          revenueGenerated,
          totalEarned,
          pendingFromShop,
          owedToShop,
          netBalance: pendingFromShop - owedToShop,
          transactionCount: transactions?.length || 0,
          transactions,
          topClients
        }
      });

    } catch (error) {
      console.error('[API] Error fetching artist earnings:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // GET /api/contacts/:contactId/financials - Get client LTV data
  app.get("/api/contacts/:contactId/financials", async (req, res) => {
    try {
      if (!supabase) {
        return res.status(503).json({
          success: false,
          error: 'Financial tracking not available - Supabase not configured'
        });
      }

      const { contactId } = req.params;

      const { data, error } = await supabase
        .from('client_financials')
        .select('*')
        .eq('contact_id', contactId)
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 = not found
        throw error;
      }

      res.json({
        success: true,
        financials: data || null
      });

    } catch (error) {
      console.error('[API] Error fetching client financials:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // PUT /api/contacts/:contactId/quote - Update contact's quote_to_client custom field
  app.put("/api/contacts/:contactId/quote", async (req, res) => {
    try {
      const { contactId } = req.params;
      const { quoteAmount, locationId } = req.body;

      if (!contactId) {
        return res.status(400).json({
          success: false,
          message: 'Contact ID is required'
        });
      }

      if (quoteAmount === undefined || quoteAmount === null) {
        return res.status(400).json({
          success: false,
          message: 'Quote amount is required'
        });
      }

      console.log(`[API] Updating quote for contact ${contactId} to $${quoteAmount}`);

      // Update GHL contact with quote_to_client custom field
      const { updateContact } = require('../clients/ghlClient');

      // The quote_to_client field key - GHL will match by key name
      const customField = {
        'quote_to_client': quoteAmount
      };

      const updateResult = await updateContact(contactId, { customField });

      // Also update client_financials table if it exists
      if (supabase) {
        const { error: upsertError } = await supabase
          .from('client_financials')
          .upsert({
            contact_id: contactId,
            quote_amount: quoteAmount,
            updated_at: new Date().toISOString()
          }, {
            onConflict: 'contact_id'
          });

        if (upsertError) {
          console.warn('[API] Warning: Could not update client_financials:', upsertError.message);
        }
      }

      console.log(`[API] Quote updated successfully for contact ${contactId}`);

      res.json({
        success: true,
        contactId,
        quoteAmount,
        message: 'Quote updated successfully'
      });

    } catch (error) {
      console.error('[API] Error updating contact quote:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to update quote'
      });
    }
  });

  // PUT /api/contacts/:contactId/post-consultation - Save complete post-consultation checklist
  app.put("/api/contacts/:contactId/post-consultation", async (req, res) => {
    try {
      const { contactId } = req.params;
      const { quoteAmount, paymentType, sessionEstimate, locationId } = req.body;

      if (!contactId) {
        return res.status(400).json({
          success: false,
          message: 'Contact ID is required'
        });
      }

      if (quoteAmount === undefined || quoteAmount === null) {
        return res.status(400).json({
          success: false,
          message: 'Quote amount is required'
        });
      }

      console.log(`[API] Saving post-consultation checklist for contact ${contactId}`);
      console.log(`   Quote: $${quoteAmount}`);
      console.log(`   Payment Type: ${paymentType}`);
      console.log(`   Session Estimate: ${sessionEstimate}`);

      // Update GHL contact with all custom fields
      const { updateContact } = require('../clients/ghlClient');

      // Custom fields to update
      const customField = {
        'quote_to_client': quoteAmount,
        'payment_type': paymentType,
        'session_estimate': sessionEstimate
      };

      const updateResult = await updateContact(contactId, { customField });

      // Also update client_financials table if it exists
      if (supabase) {
        const { error: upsertError } = await supabase
          .from('client_financials')
          .upsert({
            contact_id: contactId,
            quote_amount: quoteAmount,
            payment_type: paymentType,
            session_estimate: sessionEstimate,
            updated_at: new Date().toISOString()
          }, {
            onConflict: 'contact_id'
          });

        if (upsertError) {
          console.warn('[API] Warning: Could not update client_financials:', upsertError.message);
        }
      }

      console.log(`[API] Post-consultation checklist saved successfully for contact ${contactId}`);

      res.json({
        success: true,
        contactId,
        quoteAmount,
        paymentType,
        sessionEstimate,
        message: 'Post-consultation checklist saved successfully'
      });

    } catch (error) {
      console.error('[API] Error saving post-consultation checklist:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to save checklist'
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CONSULTATION ENDED HANDLING
  // Creates quote verification task when a consultation appointment ends
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle consultation calendar appointment events
   * Checks if appointment has ended and creates quote verification task if needed
   */
  async function handleConsultationAppointment(contactId, data) {
    const { supabase } = require("../clients/supabaseClient");
    const { appointmentId, calendarId, startTime, endTime, rawStatus, isCancelled } = data;

    console.log("🎬 Processing consultation appointment:", {
      contactId,
      appointmentId,
      calendarId,
      endTime,
      status: rawStatus,
    });

    // Skip if cancelled
    if (isCancelled) {
      console.log("ℹ️ Consultation was cancelled, skipping quote verification");
      return;
    }

    // Note: GHL only sends webhooks when appointments are created/updated, not when they end.
    // We create the task immediately when a consultation is confirmed - the artist will
    // complete it after the consultation ends. The due_at time is set to 2 hours after
    // the appointment end time to give them time to follow up.
    const appointmentEndTime = new Date(endTime);
    console.log(`✅ Consultation appointment detected (ends at ${endTime}), checking if quote verification task is needed...`);

    // Fetch contact from GHL to check custom fields
    let contact = null;
    try {
      contact = await getContact(contactId);
    } catch (err) {
      console.error("❌ Failed to fetch contact:", err.message);
      return;
    }

    if (!contact) {
      console.warn("⚠️ Contact not found:", contactId);
      return;
    }

    // Extract custom field values
    const customFields = contact.customFields || contact.customField || [];
    const getFieldValue = (fieldId) => {
      const field = customFields.find((f) => f.id === fieldId);
      return field ? field.value : null;
    };

    const quotedValue = getFieldValue(GHL_CUSTOM_FIELD_IDS.QUOTED);
    const clientInformed = getFieldValue(GHL_CUSTOM_FIELD_IDS.CLIENT_INFORMED);
    const languagePreference = getFieldValue(GHL_CUSTOM_FIELD_IDS.LANGUAGE_PREFERENCE);

    console.log("📊 Contact quote status:", {
      quoted: quotedValue,
      clientInformed,
      languagePreference,
    });

    // Check if quote verification is needed
    const hasQuote = quotedValue && String(quotedValue).trim() !== "" && String(quotedValue) !== "0";
    const isClientInformed = clientInformed &&
      (String(clientInformed).toLowerCase() === "yes" || String(clientInformed).toLowerCase() === "true");

    const needsQuoteVerification = !hasQuote || !isClientInformed;

    if (!needsQuoteVerification) {
      console.log("✅ Quote is set and client is informed, no verification needed");
      return;
    }

    console.log("📋 Quote verification needed:", {
      hasQuote,
      isClientInformed,
      reason: !hasQuote ? "Quote not set" : "Client not informed",
    });

    // Check if task already exists
    if (supabase) {
      const { data: existingTask } = await supabase
        .from("command_center_tasks")
        .select("id")
        .eq("type", "quote_verification")
        .eq("contact_id", contactId)
        .eq("trigger_event", "consultation_ended")
        .eq("status", "pending")
        .maybeSingle();

      if (existingTask) {
        console.log("ℹ️ Quote verification task already exists, skipping");
        return;
      }

      // Get contact name and owner
      const contactName = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || "Unknown Contact";
      const contactOwner = contact.assignedTo;
      const followers = contact.followers || [];
      const locationId = contact.locationId;

      // Build assignees list (owner + followers)
      const assignees = [contactOwner, ...followers].filter(Boolean);

      if (assignees.length === 0) {
        console.warn("⚠️ No assignees found for quote verification task");
        return;
      }

      // Create the task - due immediately when the appointment ends
      const dueAt = new Date(appointmentEndTime.getTime());

      const taskData = {
        type: "quote_verification",
        contact_id: contactId,
        contact_name: contactName,
        assigned_to: assignees,
        created_by: "system",
        created_at: new Date().toISOString(),
        due_at: dueAt.toISOString(),
        status: "pending",
        urgency_level: "normal",
        trigger_event: "consultation_ended",
        related_appointment_id: appointmentId,
        requires_all_assignees: false,
        metadata: {
          current_quote: hasQuote ? String(quotedValue) : "",
          client_informed: isClientInformed ? "true" : "false",
          requires_quote_entry: hasQuote ? "false" : "true",
          language_preference: languagePreference || "english",
          consultation_calendar: calendarId,
        },
        location_id: locationId,
      };

      const { error: insertError } = await supabase
        .from("command_center_tasks")
        .insert([taskData]);

      if (insertError) {
        console.error("❌ Failed to create quote verification task:", insertError);
      } else {
        console.log("✅ Created quote_verification task for:", contactName);
        console.log("   Assigned to:", assignees);
        console.log("   Due at:", dueAt.toISOString());
      }
    } else {
      console.warn("⚠️ Supabase not configured, cannot create quote verification task");
    }
  }

  return app;
}

module.exports = { createApp };
