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
} = require("../../ghlClient");
const { handleInboundMessage } = require("../ai/controller");
const { getContactIdFromOrder } = require("../payments/squareClient");
const {
  extractCustomFieldsFromPayload,
  buildEffectiveContact,
  formatThreadForLLM,
} = require("../ai/contextBuilder");
const {
  syncPipelineOnEntry,
  transitionToStage,
} = require("../ai/opportunityManager");
const { OPPORTUNITY_STAGES } = require("../config/constants");
const { formatSlotDisplay } = require("../ai/bookingController");

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
  
  // Detect WhatsApp
  const isWhatsApp = tagsLower.some(t => t.includes("whatsapp")) || medium === "whatsapp";
  
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
    origin: [
      'https://tattooshopminneapolis.com',
      'http://localhost:3000',
      'http://localhost:8080',
      'http://127.0.0.1:5500', // Common local dev server port
    ],
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

  app.post("/ghl/message-webhook", async (req, res) => {
    try {
      console.log("\n💬 ════════════════════════════════════════════════════════");
      console.log("💬 GHL MESSAGE WEBHOOK HIT");
      console.log("💬 ════════════════════════════════════════════════════════");

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

      // Log non-empty payload fields
      const nonEmptyPayload = filterNonEmpty(payload);
      console.log("📦 Webhook Payload (non-empty fields):", JSON.stringify(nonEmptyPayload, null, 2));

      // Log the incoming message prominently
      console.log("📩 Incoming message text:", messageText || "(empty)");
      console.log("👤 Contact ID:", contactId);

      if (!contactId) {
        console.warn("⚠️ /ghl/message-webhook missing contactId");
        return res.status(200).json({ ok: false, error: "missing contactId" });
      }

      const contactRaw = await getContact(contactId);
      
      // Extract custom fields from webhook payload (more reliable than getContact array format)
      const webhookCustomFields = extractCustomFieldsFromPayload(payload);
      console.log("📋 Webhook custom fields extracted:", JSON.stringify(webhookCustomFields, null, 2));
      
      // Merge webhook custom fields into contact (webhook payload has correct format)
      const contact = buildEffectiveContact(contactRaw, webhookCustomFields);
      
      // Log contact info
      console.log("👤 Contact:", contact?.firstName || "(no first name)", contact?.lastName || "(no last name)");
      console.log("📋 Contact custom fields (merged):", JSON.stringify(getNonEmptyCustomFields(contact), null, 2));

      // Derive channel context for message sending and pipeline sync
      const channelContext = deriveChannelContext(payload, contact);
      console.log("📡 Channel context:", channelContext);

      // Sync pipeline on entry - SMS/DM/WhatsApp start at DISCOVERY
      const cf = contact?.customField || contact?.customFields || {};
      const hasOpportunity = !!cf.opportunity_id;
      if (!hasOpportunity && channelContext.channelType !== "unknown") {
        console.log(`📊 [PIPELINE] New lead from ${channelContext.channelType} - syncing entry stage...`);
        await syncPipelineOnEntry(contactId, {
          channelType: channelContext.channelType,
          isFirstMessage: true,
          contact,
        });
      }

      // Fetch conversation history for context
      console.log("📜 Fetching conversation history...");
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
      
      console.log("📜 Thread context:", {
        totalMessages: conversationThread.totalCount,
        recentCount: conversationThread.thread?.length || 0,
        hasSummary: !!conversationThread.summary,
        hasImageContext: !!conversationThread.imageContext,
        wasHumanHandling: conversationThread.handoffContext?.wasHumanHandling || false,
        isReturningClient: !!cf.returning_client,
      });

      const result = await handleInboundMessage({
        contact,
        aiPhase: null,
        leadTemperature: null,
        latestMessageText: messageText,
        contactProfile: {},
        consultExplained: contact?.customField?.consult_explained || webhookCustomFields?.consult_explained,
        conversationThread, // Pass thread context to AI
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

      console.log("💬 ════════════════════════════════════════════════════════\n");
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

        const result = await handleInboundMessage({
          contact: effectiveContact,
          aiPhase: null,
          leadTemperature: null,
          latestMessageText: syntheticText,
          contactProfile: {},
          consultExplained: effectiveContact?.customField?.consult_explained || webhookCustomFields?.consult_explained,
          conversationThread, // Pass thread context to AI
        });

        // Log AI result summary
        console.log("🤖 AI Response Summary:", {
          bubblesCount: result?.aiResult?.bubbles?.length || 0,
          phase: result?.ai_phase,
          handler: result?.routing?.selected_handler,
          reason: result?.routing?.reason,
          fieldUpdatesKeys: Object.keys(result?.aiResult?.field_updates || {}),
        });

        // Derive channel context for message sending
        const channelContext = deriveChannelContext(payload, effectiveContact);
        console.log("📡 Channel context:", channelContext);

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
    const signature = req.get("x-square-signature") || "";

    if (!secret) {
      console.warn("⚠️ Missing SQUARE_WEBHOOK_SECRET");
      return res.status(401).send("missing secret");
    }

    const raw = req.rawBody || Buffer.from("");
    const expected = crypto.createHmac("sha256", secret).update(raw).digest("base64");

    if (signature !== expected) {
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
      console.log("\n💳 ════════════════════════════════════════════════════════");
      console.log("💳 SQUARE PAYMENT WEBHOOK HIT");
      console.log("💳 ════════════════════════════════════════════════════════");

      const payment = payload?.data?.object?.payment || {};
      const orderId = payment.order_id || payment.orderId || null;
      let contactId = payment.reference_id || payment.referenceId || null;

      if (!contactId && orderId) {
        contactId = await getContactIdFromOrder(orderId);
      }

      if (contactId) {
        console.log(`💳 Deposit paid for contact: ${contactId}`);
        
        // Update deposit_paid field
        await updateSystemFields(contactId, {
          deposit_paid: true,
        });

        // Sync pipeline to QUALIFIED stage
        console.log(`📊 [PIPELINE] Deposit paid - transitioning to QUALIFIED...`);
        await transitionToStage(contactId, OPPORTUNITY_STAGES.QUALIFIED);
        console.log(`✅ [PIPELINE] Contact ${contactId} moved to QUALIFIED stage`);

        // === SEND DEPOSIT CONFIRMATION MESSAGE ===
        try {
          // Fetch contact info for personalization and appointment details
          const contact = await getContact(contactId);
          const cf = contact?.customField || contact?.customFields || {};
          const firstName = contact?.firstName || contact?.first_name || "";
          
          // Get the pending/hold slot info
          const pendingSlotDisplay = cf.pending_slot_display || cf.pendingSlotDisplay || null;
          const pendingSlotStartTime = cf.pending_slot_start_time || cf.pendingSlotStartTime || null;
          const consultationType = cf.consultation_type || cf.consultationType || "online";
          const translatorNeeded = cf.translator_needed === true || cf.translator_needed === "true";
          
          // Format the appointment time if we have it
          let appointmentDisplay = pendingSlotDisplay;
          if (!appointmentDisplay && pendingSlotStartTime) {
            try {
              appointmentDisplay = formatSlotDisplay(new Date(pendingSlotStartTime));
            } catch (e) {
              appointmentDisplay = pendingSlotStartTime;
            }
          }
          
          // Build confirmation message
          let confirmationMessage = "";
          if (appointmentDisplay) {
            const consultTypeText = consultationType === "message" 
              ? "message-based consult" 
              : translatorNeeded 
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
            channelContext: {},
          });
          console.log(`✅ [DEPOSIT] Sent confirmation message to contact ${contactId}`);
          
        } catch (msgErr) {
          console.error("❌ [DEPOSIT] Failed to send confirmation message:", msgErr.message || msgErr);
          // Don't fail the webhook - deposit was already processed
        }
      } else {
        console.warn("⚠️ /square/webhook could not resolve contactId from payment");
      }

      console.log("💳 ════════════════════════════════════════════════════════\n");
    } catch (err) {
      console.error("❌ /square/webhook processing error:", err.message || err);
    }

    return res.status(200).json({ ok: true });
  });

  return app;
}

module.exports = { createApp };
