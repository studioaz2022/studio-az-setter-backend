const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const multer = require("multer");
const axios = require("axios");
const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.LLM_API_KEY });

const {
  getContact,
  getContactV2,
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
const { verifyStaffEmail, ghlBarber } = require("../clients/ghlMultiLocationSdk");
const { getContactIdFromOrder, createDepositLinkForContact } = require("../payments/squareClient");
const {
  buildOAuthUrl,
  exchangeCodeForToken,
  getBarberToken,
  disconnectBarber,
  getAllBarberConnectionStatuses,
  refreshBarberToken,
  refreshAllExpiringTokens,
} = require("../payments/squareOAuth");
const {
  syncBarberTransactions,
  assignUnmatchedPayment,
  unmatchPayment,
  recordWalkIn,
} = require("../payments/squareTransactionSync");
const { getServicePriceMap } = require("../config/barberServicePrices");
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
  fetchAppointmentsForDateRange,
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
const { fetchAllArtifacts } = require("../clients/googleMeetArtifacts");
const {
  lookupContactBySpace,
  markSubscriptionCompleted,
} = require("../clients/workspaceEvents");
const {
  getTranscript,
  formatTranscriptText,
  batchDeleteTranscripts,
} = require("../clients/firefliesClient");
const { summarizeConsultation } = require("../ai/consultationSummarizer");

// ═══ ENVIRONMENT VARIABLES ═══
const GHL_FILE_UPLOAD_TOKEN = process.env.GHL_FILE_UPLOAD_TOKEN;

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

// ============================================================================
// Qualified Lead AI Response Logic
// ============================================================================

// Stage IDs where AI should limit responses (only FAQ questions)
const QUALIFIED_STAGE_IDS = [
  'd30d3a30-3a78-4123-9387-8db3d6dd8a20', // Consult Appointment (video scheduled)
  '09587a76-13ae-41b3-bd57-81da11f1c56c'  // Consult Message (artist handling)
];

/**
 * Check if contact is in a qualified stage where AI should limit responses
 * Fetches opportunities from GHL API and checks their stage IDs
 */
async function isInQualifiedStage(contactId, locationId) {
  try {
    const opportunitiesUrl = `https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&contact_id=${contactId}`;
    const oppsResp = await axios.get(opportunitiesUrl, {
      headers: {
        'Authorization': `Bearer ${GHL_FILE_UPLOAD_TOKEN}`,
        'Version': '2021-07-28',
        'Accept': 'application/json'
      }
    });

    const opportunities = oppsResp.data.opportunities || [];
    
    // Check if contact has any open opportunity in a qualified stage
    const hasQualifiedOpp = opportunities.some(opp => 
      QUALIFIED_STAGE_IDS.includes(opp.pipelineStageId) && opp.status === 'open'
    );

    return hasQualifiedOpp;
  } catch (err) {
    console.error("⚠️ Error checking qualified stage:", err.message);
    return false; // Default to not qualified if error
  }
}

/**
 * Detect if message is an FAQ question
 * These patterns match common pre-appointment questions
 */
function detectFAQQuestion(text) {
  if (!text) return false;
  
  const lower = text.toLowerCase();
  
  // Common FAQ patterns for tattoo studio
  const faqPatterns = [
    // Time/scheduling questions
    /what\s+time/i,
    /when\s+(is|are)/i,
    /appointment\s+time/i,
    
    // Location questions
    /where\s+(is|are|do)/i,
    /address/i,
    /location/i,
    /how\s+do\s+i\s+get/i,
    /directions/i,
    
    // Preparation questions
    /what\s+should\s+i\s+bring/i,
    /how\s+(to|do\s+i)\s+prepare/i,
    /before\s+(my|the)\s+appointment/i,
    /what\s+to\s+(expect|wear)/i,
    
    // Logistics
    /parking/i,
    /how\s+long/i,
    /duration/i,
    /how\s+much\s+time/i,
    
    // Rescheduling
    /reschedule/i,
    /cancel/i,
    /change\s+(my\s+)?appointment/i,
    /move\s+(my\s+)?appointment/i,
    
    // Payment/cost
    /how\s+much/i,
    /cost/i,
    /price/i,
    /payment/i,
    /pay/i,
    
    // Aftercare (pre-appointment questions about post-care)
    /aftercare/i,
    /how\s+to\s+care/i,
    /healing/i,
  ];
  
  return faqPatterns.some(pattern => pattern.test(lower));
}

/**
 * Determine if AI should respond to this message
 * Returns: { shouldRespond: boolean, reason: string, appendFrontDesk: boolean }
 */
async function shouldAIRespond(contactId, locationId, messageText) {
  // Check if lead is in qualified stage
  const isQualified = await isInQualifiedStage(contactId, locationId);
  
  if (!isQualified) {
    return { 
      shouldRespond: true, 
      reason: 'lead_not_qualified',
      appendFrontDesk: false
    };
  }
  
  // Lead is qualified - only respond to FAQ questions
  const isFAQ = detectFAQQuestion(messageText);
  
  if (isFAQ) {
    return { 
      shouldRespond: true, 
      reason: 'qualified_faq_question',
      appendFrontDesk: true  // Add -FrontDesk suffix
    };
  }
  
  // Qualified lead, not FAQ - artist should handle
  return { 
    shouldRespond: false, 
    reason: 'qualified_artist_handles',
    appendFrontDesk: false
  };
}

// Helper: Extract non-empty custom fields from contact
function getNonEmptyCustomFields(contact) {
  const cf = contact?.customField || contact?.customFields || {};
  return filterNonEmpty(cf);
}

// Helper: Derive channel context from webhook payload and contact
/**
 * Check if phone number is a U.S. number based on country code.
 * U.S. numbers start with +1 followed by a 3-digit area code.
 * This matches the logic in the iOS app's Conversation.swift model.
 */
function isUSPhoneNumber(phone) {
  if (!phone) return true; // Default to US if no phone
  
  // Remove all non-digit characters except leading +
  const cleanedPhone = phone.replace(/[^0-9+]/g, '');
  
  // Check for +1 country code (US/Canada)
  if (cleanedPhone.startsWith('+1') && cleanedPhone.length >= 12) {
    return true;
  }
  
  // Check for 1 followed by 10 digits (US format without +)
  if (cleanedPhone.startsWith('1') && cleanedPhone.length === 11) {
    return true;
  }
  
  // Check for 10-digit number (US format without country code)
  if (!cleanedPhone.startsWith('+') && cleanedPhone.length === 10) {
    return true;
  }
  
  // If it starts with a different country code, it's international
  if (cleanedPhone.startsWith('+') && !cleanedPhone.startsWith('+1')) {
    return false;
  }
  
  // Default to US if we can't determine
  return true;
}

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
  
  // Detect phone information
  const phone = contact?.phone || contact?.phoneNumber || payload?.phone || null;
  const hasPhone = !!phone;
  const isUSPhone = isUSPhoneNumber(phone);
  
  // Detect WhatsApp - ONLY use it if:
  // 1. The whatsapp_user custom field is "Yes", AND
  // 2. The contact does NOT have a US phone number (international numbers only)
  const cf = contact?.customField || contact?.customFields || {};
  const whatsappUser = cf.whatsapp_user || cf.whatsappUser || cf.FnYDobmYqnXDxlLJY5oe || "";
  const isWhatsAppFromField = whatsappUser.toLowerCase() === "yes";
  
  // Only use WhatsApp if explicitly enabled AND phone is international
  const isWhatsApp = isWhatsAppFromField && !isUSPhone;
  
  // Check tags for WhatsApp indicators (as backup context)
  const hasWhatsAppTag = tagsLower.some(t => t.includes("whatsapp")) || medium === "whatsapp";
  
  // Detect DM
  const isDm = isDmFromMedium || isDmFromTags;
  
  // Detect SMS (has phone, not DM, not WhatsApp, OR has US phone)
  // For US numbers, always prefer SMS even if WhatsApp is enabled
  const isSms = hasPhone && !isDm && (!isWhatsApp || isUSPhone) && messageType !== 11;
  
  // Determine channel type for pipeline purposes
  let channelType = "unknown";
  if (isDm) {
    channelType = medium === "instagram" || medium === "ig" ? "instagram" : "facebook";
  } else if (isWhatsApp && !isUSPhone) {
    // Only use WhatsApp channel if international number
    channelType = "whatsapp";
  } else if (isSms || isUSPhone) {
    // For US numbers, always use SMS
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
    phone,
    isUSPhone, // Add this for debugging/logging
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

  // Use JSON body parsing for all routes except webhooks that need raw body for signature verification
  app.use((req, res, next) => {
    if (req.path === "/square/webhook" || req.path === "/fireflies/webhook") {
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

      // Send push notification to assigned owner and followers (non-blocking, don't await)
      // Skip email messages — they cause unclearable badge issues in the iOS app
      const messageTypeCode = latestPayload?.message?.type;
      const messageTypeStr = (latestPayload?.messageType || latestPayload?.message?.messageType || "").toUpperCase();
      const isEmailMessage = messageTypeCode === 1 || messageTypeStr.includes("EMAIL");

      const assignedUserId = contact?.assignedTo;
      const contactFollowers = contact?.followers || [];
      const contactLocationId = contact?.locationId;
      if (!isEmailMessage && (assignedUserId || contactFollowers.length > 0) && combinedMessageText) {
        sendMessagePushNotification(contactId, contactName, combinedMessageText, assignedUserId, contactFollowers, contactLocationId)
          .catch(err => console.error('❌ [MSG APN] Error:', err.message || err));
      } else if (isEmailMessage) {
        if (!COMPACT_MODE) console.log('📧 [MSG APN] Skipping push notification for email message');
      }

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

      // ═══ CHECK IF AI SHOULD RESPOND (QUALIFIED LEAD LOGIC) ═══
      const responseCheck = await shouldAIRespond(contactId, contact.locationId, combinedMessageText);
      
      if (!responseCheck.shouldRespond) {
        if (COMPACT_MODE) {
          console.log(`⏭️ [AI SKIP] ${responseCheck.reason}`);
        } else {
          console.log(`⏭️ [AI SKIP] Lead is qualified - AI will not respond (reason: ${responseCheck.reason})`);
          console.log(`   Stage ID: ${cf.opportunity_stage_id || cf.opportunityStageId}`);
          console.log(`   Message: "${combinedMessageText.substring(0, 50)}${combinedMessageText.length > 50 ? '...' : ''}"`);
        }
        return res.status(200).json({ 
          ok: true, 
          skipped: true, 
          reason: responseCheck.reason 
        });
      }
      
      // Log if this is a qualified lead FAQ response
      if (responseCheck.appendFrontDesk && !COMPACT_MODE) {
        console.log(`💬 [FAQ] Qualified lead asked FAQ question - AI will respond with -FrontDesk suffix`);
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
        qualifiedLeadFAQMode: responseCheck.appendFrontDesk, // Tell AI this is a qualified lead FAQ
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
            // Append -FrontDesk suffix if this is a qualified lead FAQ response
            let messageBody = bubble;
            if (responseCheck.appendFrontDesk) {
              messageBody = `${bubble}\n\n-FrontDesk`;
            }
            
            await sendConversationMessage({
              contactId,
              body: messageBody,
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
          // Use the same logic as deriveChannelContext to ensure consistency
          const whatsappUser = cf.whatsapp_user || cf.whatsappUser || cf.FnYDobmYqnXDxlLJY5oe || "";
          const hasWhatsAppEnabled = whatsappUser.toLowerCase() === "yes";
          const phone = contact?.phone || contact?.phoneNumber;
          const hasPhone = !!phone;
          const isUSPhone = isUSPhoneNumber(phone);
          
          // Only use WhatsApp if explicitly enabled AND phone is international
          // For US numbers, always use SMS
          const useWhatsApp = hasWhatsAppEnabled && !isUSPhone;
          
          if (!COMPACT_MODE) {
            console.log(`📱 [CHANNEL] Deposit confirmation channel selection:`, {
              phone,
              isUSPhone,
              hasWhatsAppEnabled,
              willUse: useWhatsApp ? "WhatsApp" : "SMS"
            });
          }
          
          const depositChannelContext = {
            isDm: false,
            hasPhone,
            isWhatsApp: useWhatsApp,
            isSms: !useWhatsApp && hasPhone,
            channelType: useWhatsApp ? "whatsapp" : "sms",
            isUSPhone, // Add for debugging/logging
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
        locationId,
        tipAmount,
        servicePrice,
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
        notes,
        tipAmount: tipAmount != null ? parseFloat(tipAmount) : null,
        servicePrice: servicePrice != null ? parseFloat(servicePrice) : null,
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
        query = query.gte('session_date', startDate);
      }
      if (endDate) {
        query = query.lte('session_date', endDate);
      }

      const { data: transactions, error } = await query.order('created_at', { ascending: false });

      if (error) throw error;

      // Enrich empty contact_name fields from GHL (batch lookup, then persist)
      const emptyNameTxs = (transactions || []).filter(
        tx => tx.contact_id && tx.contact_id !== 'walk_in' && (!tx.contact_name || tx.contact_name.trim() === '')
      );
      if (emptyNameTxs.length > 0) {
        const uniqueContactIds = [...new Set(emptyNameTxs.map(tx => tx.contact_id))];
        console.log(`[Earnings] Enriching ${uniqueContactIds.length} contacts with empty names (locationId=${locationId})`);
        const nameCache = {};
        // Use the correct SDK based on location (barbershop vs tattoo shop)
        const isBarberLocation = locationId === process.env.GHL_BARBER_LOCATION_ID;
        const sdkForLookup = isBarberLocation && ghlBarber ? ghlBarber : null;
        console.log(`[Earnings] isBarberLocation=${isBarberLocation}, ghlBarber available=${!!ghlBarber}, sdkForLookup=${!!sdkForLookup}`);
        await Promise.all(uniqueContactIds.map(async (cid) => {
          try {
            let contact;
            if (sdkForLookup) {
              // Barbershop: use barber SDK directly
              const data = await sdkForLookup.contacts.getContact({ contactId: cid });
              contact = data?.contact || data;
            } else {
              // Tattoo shop: use existing getContact helper
              contact = await getContact(cid);
            }
            const resolvedName = contact?.contactName || contact?.name
              || `${contact?.firstName || ""} ${contact?.lastName || ""}`.trim() || "";
            nameCache[cid] = resolvedName || "Unknown";
            if (!resolvedName) {
              console.log(`[Earnings] Could not resolve name for contact ${cid}, storing "Unknown"`);
            }
          } catch (err) {
            console.warn(`[Earnings] Failed to fetch contact ${cid}: ${err.message}`);
            nameCache[cid] = "Unknown";
          }
        }));

        console.log(`[Earnings] Resolved names: ${Object.entries(nameCache).filter(([,n]) => n).length}/${uniqueContactIds.length}`);

        // Update transactions in memory and persist non-empty names to DB
        for (const tx of transactions || []) {
          if (nameCache[tx.contact_id] && (!tx.contact_name || tx.contact_name.trim() === '')) {
            tx.contact_name = nameCache[tx.contact_id];
          }
        }
        // Fire-and-forget DB updates for enriched names
        for (const [cid, name] of Object.entries(nameCache)) {
          if (name) {
            supabase.from('transactions')
              .update({ contact_name: name })
              .eq('contact_id', cid)
              .eq('contact_name', '')
              .then(({ error: updateErr }) => {
                if (updateErr) console.warn(`[Earnings] DB update failed for ${cid}: ${updateErr.message}`);
              })
              .catch((err) => {
                console.warn(`[Earnings] DB update error for ${cid}: ${err.message}`);
              });
          }
        }
      }

      // Calculate summary
      let totalEarned = 0;
      let pendingFromShop = 0;
      let owedToShop = 0;
      let revenueGenerated = 0;
      let totalServiceRevenue = 0;
      let totalTips = 0;
      let transactionsWithTips = 0;
      let productRevenue = 0;
      let productSaleCount = 0;
      const revenueByMethod = { square: 0, cash: 0, venmo: 0, zelle: 0, other: 0 };

      for (const tx of transactions || []) {
        totalEarned += parseFloat(tx.artist_amount) || 0;

        // Calculate revenue generated (sum of deposits + session payments)
        if (tx.transaction_type === 'session_payment' || tx.transaction_type === 'deposit') {
          revenueGenerated += parseFloat(tx.gross_amount) || 0;
        }

        // Product sale tracking
        if (tx.transaction_type === 'product_sale') {
          productRevenue += parseFloat(tx.gross_amount) || 0;
          productSaleCount++;
        }

        // Tip tracking (from service_price / tip_amount columns)
        if (tx.service_price != null) {
          totalServiceRevenue += parseFloat(tx.service_price) || 0;
        }
        if (tx.tip_amount != null) {
          totalTips += parseFloat(tx.tip_amount) || 0;
          if (parseFloat(tx.tip_amount) > 0) {
            transactionsWithTips++;
          }
        }

        // Revenue by payment method
        const method = tx.payment_method || 'other';
        if (revenueByMethod.hasOwnProperty(method)) {
          revenueByMethod[method] += parseFloat(tx.gross_amount) || 0;
        } else {
          revenueByMethod.other += parseFloat(tx.gross_amount) || 0;
        }

        if (tx.settlement_status !== 'settled') {
          const unsettled = tx.settlement_status === 'partial'
            ? (tx.payment_recipient === 'shop'
              ? (parseFloat(tx.artist_amount) || 0) - (parseFloat(tx.settled_amount) || 0)
              : (parseFloat(tx.shop_amount) || 0) - (parseFloat(tx.settled_amount) || 0))
            : (tx.payment_recipient === 'shop'
              ? (parseFloat(tx.artist_amount) || 0)
              : (parseFloat(tx.shop_amount) || 0));

          if (tx.payment_recipient === 'shop') {
            pendingFromShop += unsettled;
          } else {
            owedToShop += unsettled;
          }
        }
      }

      // Build top clients directly from transactions (works for both tattoo + barbershop)
      let topClients = [];
      const clientMap = {};
      for (const tx of transactions || []) {
        if (!tx.contact_id || tx.contact_id === 'walk_in') continue;
        if (!clientMap[tx.contact_id]) {
          clientMap[tx.contact_id] = {
            contact_id: tx.contact_id,
            contact_name: tx.contact_name || '',
            total_spent: 0,
            appointment_ids: new Set(), // track distinct appointments
            completed_tattoos: 0,
            is_returning_client: false,
            last_appointment_date: tx.session_date || tx.created_at,
          };
        }
        const c = clientMap[tx.contact_id];
        c.total_spent += parseFloat(tx.gross_amount) || 0;
        if (tx.transaction_type === 'session_payment' || tx.transaction_type === 'deposit') {
          if (tx.appointment_id) {
            c.appointment_ids.add(tx.appointment_id);
          } else {
            // No appointment_id (walk-in etc.) — count as separate
            c.completed_tattoos++;
          }
        }
        // Track most recent date
        const txDate = tx.session_date || tx.created_at;
        if (txDate && (!c.last_appointment_date || txDate > c.last_appointment_date)) {
          c.last_appointment_date = txDate;
        }
        // Use the best available name
        if (!c.contact_name && tx.contact_name) {
          c.contact_name = tx.contact_name;
        }
      }
      topClients = Object.values(clientMap)
        .sort((a, b) => b.total_spent - a.total_spent)
        .slice(0, 10)
        .map(c => ({
          ...c,
          completed_tattoos: c.appointment_ids.size + c.completed_tattoos,
          is_returning_client: (c.appointment_ids.size + c.completed_tattoos) > 1,
        }));

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
          totalServiceRevenue,
          totalTips,
          averageTipAmount: transactionsWithTips > 0 ? totalTips / transactionsWithTips : 0,
          averageTipPercentage: totalServiceRevenue > 0 ? (totalTips / totalServiceRevenue) * 100 : 0,
          revenueByMethod,
          productRevenue,
          productSaleCount,
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

  // GET /api/artists/:artistId/unpaid-appointments - Recent appointments without transactions
  app.get("/api/artists/:artistId/unpaid-appointments", async (req, res) => {
    try {
      const { supabase } = require("../clients/supabaseClient");
      if (!supabase) {
        return res.status(503).json({ success: false, error: "Supabase not configured" });
      }

      const { artistId } = req.params;
      const { locationId } = req.query;

      if (!artistId || !locationId) {
        return res.status(400).json({ success: false, error: "Missing artistId or locationId" });
      }

      // Use barbershop SDK if location matches
      const BARBER_LOC = process.env.GHL_BARBER_LOCATION_ID;
      const sdkInstance = (locationId === BARBER_LOC && ghlBarber) ? ghlBarber : undefined;

      // Date range: last 14 days
      const endTime = new Date().toISOString();
      const startTime = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

      // Fetch GHL appointments
      const events = await fetchAppointmentsForDateRange({
        locationId,
        startTime,
        endTime,
        userId: artistId,
        sdkInstance,
      });

      // Filter to confirmed/showed, assigned to this artist
      const eligible = events.filter(e => {
        const status = e.appointmentStatus || e.appoinmentStatus || e.status;
        return ["showed", "confirmed"].includes(status) &&
               (e.assignedUserId === artistId || e.userId === artistId);
      });

      if (eligible.length === 0) {
        return res.json({ success: true, appointments: [] });
      }

      // Get already-paid appointment IDs from transactions
      const apptIds = eligible.map(e => e.id);
      const { data: paidRows } = await supabase
        .from("transactions")
        .select("appointment_id")
        .in("appointment_id", apptIds);
      const paidSet = new Set((paidRows || []).map(r => r.appointment_id));

      // Load service prices and calendar names
      const { data: priceRows } = await supabase
        .from("barber_service_prices")
        .select("calendar_id, calendar_name, price");
      const priceMap = new Map();
      const nameMap = new Map();
      for (const row of priceRows || []) {
        priceMap.set(row.calendar_id, parseFloat(row.price));
        nameMap.set(row.calendar_id, row.calendar_name);
      }

      // Build unpaid list
      const unpaid = eligible
        .filter(e => !paidSet.has(e.id))
        .map(e => ({
          appointmentId: e.id,
          contactId: e.contactId || null,
          contactName: e.title || "Unknown",
          calendarId: e.calendarId,
          calendarName: nameMap.get(e.calendarId) || "Service",
          servicePrice: priceMap.get(e.calendarId) || null,
          startTime: e.startTime,
          status: e.appointmentStatus || e.appoinmentStatus || e.status,
        }))
        .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

      res.json({ success: true, appointments: unpaid });

    } catch (error) {
      console.error("[API] Error fetching unpaid appointments:", error);
      res.status(500).json({ success: false, error: error.message });
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

  // GET /api/contacts/:contactId/transactions - Get all transactions for a contact
  app.get("/api/contacts/:contactId/transactions", async (req, res) => {
    try {
      if (!supabase) {
        return res.status(503).json({ success: false, error: "Supabase not configured" });
      }

      const { contactId } = req.params;
      const { artistId, locationId } = req.query;

      let query = supabase
        .from("transactions")
        .select("*")
        .eq("contact_id", contactId);

      if (artistId) query = query.eq("artist_ghl_id", artistId);
      if (locationId) query = query.eq("location_id", locationId);

      const { data: transactions, error } = await query.order("session_date", { ascending: false });
      if (error) throw error;

      // Enrich empty contact_name from GHL if needed
      const needsEnrichment = (transactions || []).some(
        tx => !tx.contact_name || tx.contact_name.trim() === ""
      );
      if (needsEnrichment && contactId !== "walk_in") {
        const isBarberLocation = locationId === process.env.GHL_BARBER_LOCATION_ID;
        let resolvedName = "";
        try {
          let contact;
          if (isBarberLocation && ghlBarber) {
            const data = await ghlBarber.contacts.getContact({ contactId });
            contact = data?.contact || data;
          } else {
            contact = await getContact(contactId);
          }
          resolvedName = contact?.contactName || contact?.name
            || `${contact?.firstName || ""} ${contact?.lastName || ""}`.trim() || "";
        } catch { /* ignore */ }

        if (resolvedName) {
          for (const tx of transactions || []) {
            if (!tx.contact_name || tx.contact_name.trim() === "") {
              tx.contact_name = resolvedName;
            }
          }
          // Persist enriched names
          supabase.from("transactions")
            .update({ contact_name: resolvedName })
            .eq("contact_id", contactId)
            .eq("contact_name", "")
            .then(() => {}).catch(() => {});
        }
      }

      res.json({ success: true, transactions: transactions || [] });
    } catch (error) {
      console.error("[API] Error fetching contact transactions:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // GET /api/contacts/:contactId/appointments - Get appointment history for a contact
  app.get("/api/contacts/:contactId/appointments", async (req, res) => {
    try {
      const { contactId } = req.params;
      const { locationId } = req.query;

      if (!contactId) {
        return res.status(400).json({ success: false, error: "contactId is required" });
      }

      const isBarberLocation = locationId === process.env.GHL_BARBER_LOCATION_ID;
      let events = [];

      if (isBarberLocation && ghlBarber) {
        // Barbershop: use barber SDK
        const result = await ghlBarber.contacts.getAppointmentsForContact({ contactId });
        events = result?.events || [];
      } else {
        // Tattoo shop: use existing helper
        events = await listAppointmentsForContact(contactId);
      }

      // Sort by startTime descending (most recent first)
      events.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

      res.json({ success: true, appointments: events });
    } catch (error) {
      console.error("[API] Error fetching contact appointments:", error);
      res.status(500).json({ success: false, error: error.message });
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

  // PUT /api/contacts/:contactId/consultation-artifacts - Fetch and store Google Meet consultation artifacts
  app.put("/api/contacts/:contactId/consultation-artifacts", async (req, res) => {
    try {
      const { contactId } = req.params;
      let { meetUrl } = req.body;

      // If no meetUrl provided, look up the contact's existing google_meet_link
      if (!meetUrl) {
        const contact = await getContact(contactId);
        // GHL returns customFields as array of {id, value} objects or as a flat object
        const cf = contact?.customField || contact?.customFields;
        if (Array.isArray(cf)) {
          const meetField = cf.find(f => f.id === "rQrUAlymMTeoJZ1uxSvt");
          meetUrl = meetField?.value;
        } else if (cf) {
          meetUrl = cf.google_meet_link || cf.rQrUAlymMTeoJZ1uxSvt;
        }
      }

      if (!meetUrl) {
        return res.status(400).json({ error: "No Google Meet URL found for this contact" });
      }

      console.log(`[consultation-artifacts] Fetching artifacts for contact ${contactId}, meetUrl: ${meetUrl}`);

      const artifacts = await fetchAllArtifacts(meetUrl);

      // Build custom field updates using the same key-value object format used elsewhere
      const customField = {};
      if (artifacts.recordingUrl) {
        customField["BEkPhRd1GFo2o3JdEUU7"] = artifacts.recordingUrl;
      }
      if (artifacts.transcriptUrl) {
        customField["gahUM3ON1zMOl3meTOJt"] = artifacts.transcriptUrl;
      }
      if (artifacts.smartNotesUrl) {
        customField["tey5KNaD9CGSyMTCRV07"] = artifacts.smartNotesUrl;
      }
      if (artifacts.smartNotesText) {
        customField["xHbhQ2sA7r0jzMfIFMQT"] = artifacts.smartNotesText;
      }

      if (Object.keys(customField).length > 0) {
        await updateContact(contactId, { customField });
      }

      res.json({ success: true, artifacts });
    } catch (err) {
      console.error("[consultation-artifacts] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GOOGLE PUB/SUB PUSH WEBHOOK
  // Receives push notifications from Workspace Events API when Meet artifacts
  // (recordings, transcripts) are ready after a consultation.
  // ═══════════════════════════════════════════════════════════════════════════

  app.post("/google/pubsub/push", async (req, res) => {
    // Acknowledge immediately so Pub/Sub doesn't retry
    res.status(200).json({ ok: true });

    setImmediate(async () => {
      try {
        console.log("\n📡 ════════════════════════════════════════════════════════");
        console.log("📡 GOOGLE PUB/SUB PUSH NOTIFICATION");
        console.log("📡 ════════════════════════════════════════════════════════");

        const message = req.body?.message;
        if (!message) {
          console.warn("⚠️ Pub/Sub push with no message body");
          return;
        }

        // Decode the base64-encoded Pub/Sub message data
        const dataStr = message.data
          ? Buffer.from(message.data, "base64").toString("utf-8")
          : "{}";

        const attributes = message.attributes || {};
        const eventType = attributes["ce-type"] || "";
        const subject = attributes["ce-subject"] || "";

        console.log("📦 Event type:", eventType);
        console.log("📦 Subject:", subject);

        // Extract space name from ce-subject
        // Format: "//meet.googleapis.com/spaces/abc-defg-hij"
        let spaceName = null;
        if (subject.includes("meet.googleapis.com/spaces/")) {
          spaceName = subject.replace("//meet.googleapis.com/", "");
        }

        if (!spaceName) {
          console.warn("⚠️ Could not extract space name from subject:", subject);
          return;
        }

        console.log("🔍 Space:", spaceName);

        // Look up the contact associated with this meeting space
        const mapping = await lookupContactBySpace(spaceName);
        if (!mapping) {
          console.warn(`⚠️ No contact mapping found for space: ${spaceName}`);
          return;
        }

        const { contactId, meetUrl } = mapping;
        console.log(`👤 Contact: ${contactId} | Meet: ${meetUrl}`);

        // Brief delay — file may need a few seconds to finalize after notification
        await new Promise((resolve) => setTimeout(resolve, 10000));

        // Fetch all artifacts (recordings, transcripts, smart notes)
        console.log(`🔄 Fetching artifacts for contact ${contactId}...`);
        const artifacts = await fetchAllArtifacts(meetUrl);

        // Save to GHL custom fields
        const customField = {};
        if (artifacts.recordingUrl)
          customField["BEkPhRd1GFo2o3JdEUU7"] = artifacts.recordingUrl;
        if (artifacts.transcriptUrl)
          customField["gahUM3ON1zMOl3meTOJt"] = artifacts.transcriptUrl;
        if (artifacts.smartNotesUrl)
          customField["tey5KNaD9CGSyMTCRV07"] = artifacts.smartNotesUrl;
        if (artifacts.smartNotesText)
          customField["xHbhQ2sA7r0jzMfIFMQT"] = artifacts.smartNotesText;

        if (Object.keys(customField).length > 0) {
          await updateContact(contactId, { customField });
          console.log(
            `✅ Saved ${Object.keys(customField).length} artifact(s) for contact ${contactId}`
          );
          await markSubscriptionCompleted(spaceName);
        } else {
          console.log(`⚠️ No artifacts available yet for contact ${contactId}`);
        }

        console.log("📡 ════════════════════════════════════════════════════════\n");
      } catch (err) {
        console.error("❌ Pub/Sub push handler error:", err.message || err);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // FIREFLIES.AI WEBHOOK
  // Receives notifications when Fireflies finishes transcribing a meeting.
  // Acts as a backup when Google Meet/Gemini artifacts are unavailable.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Verify Fireflies webhook HMAC signature.
   * Fireflies sends x-hub-signature header with SHA-256 HMAC of the raw body.
   */
  function verifyFirefliesSignature(rawBody, signature, secret) {
    if (!signature || !secret) return false;

    // Strip "sha256=" prefix (Fireflies sends "sha256=<hex>")
    const sig = signature.includes("=") ? signature.split("=").slice(1).join("=") : signature;

    const expected = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    // Guard against length mismatch to avoid timingSafeEqual throwing
    const sigBuf = Buffer.from(sig, "utf-8");
    const expBuf = Buffer.from(expected, "utf-8");
    if (sigBuf.length !== expBuf.length) return false;

    return crypto.timingSafeEqual(sigBuf, expBuf);
  }

  /**
   * Extract the client name from a calendar event title.
   * Title format: "Signature Consultation📱: Leonel Chavez"
   * Returns the name portion after the colon, or null.
   */
  function extractNameFromTitle(title) {
    if (!title || !title.includes(":")) return null;
    const afterColon = title.split(":").pop().trim();
    // Strip any emoji prefixes/suffixes
    return afterColon.replace(/[\u{1F000}-\u{1FFFF}]/gu, "").trim() || null;
  }

  /**
   * Check if Google/Gemini artifacts already exist for a contact.
   * @param {string} contactId
   * @returns {Promise<boolean>}
   */
  async function checkGoogleArtifactsExist(contactId) {
    try {
      const contact = await getContact(contactId);
      const cf = contact?.customField || contact?.customFields;
      let summaryText = null;
      let recordingUrl = null;

      if (Array.isArray(cf)) {
        const summaryField = cf.find((f) => f.id === "xHbhQ2sA7r0jzMfIFMQT");
        summaryText = summaryField?.value;
        const recordField = cf.find((f) => f.id === "BEkPhRd1GFo2o3JdEUU7");
        recordingUrl = recordField?.value;
      } else if (cf) {
        summaryText = cf["xHbhQ2sA7r0jzMfIFMQT"];
        recordingUrl = cf["BEkPhRd1GFo2o3JdEUU7"];
      }

      return !!(summaryText || recordingUrl);
    } catch {
      return false;
    }
  }

  app.post("/fireflies/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    // Acknowledge immediately
    res.status(200).json({ ok: true });

    setImmediate(async () => {
      try {
        console.log("\n🔥 ════════════════════════════════════════════════════════");
        console.log("🔥 FIREFLIES WEBHOOK NOTIFICATION");
        console.log("🔥 ════════════════════════════════════════════════════════");

        // Raw body is a Buffer from express.raw()
        const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf-8") : String(req.body);

        // Verify HMAC signature
        const webhookSecret = process.env.FIREFLIES_WEBHOOK_SECRET;
        const signature = req.headers["x-hub-signature"];

        if (webhookSecret && !verifyFirefliesSignature(rawBody, signature, webhookSecret)) {
          console.error("🔥 Invalid Fireflies webhook signature — rejecting");
          return;
        }

        const payload = JSON.parse(rawBody);
        const { meetingId, eventType } = payload;

        console.log("🔥 Event:", eventType, "| Meeting ID:", meetingId);

        if (eventType !== "Transcription completed" || !meetingId) {
          console.log("🔥 Ignoring non-transcription event");
          return;
        }

        // Brief delay to ensure transcript is fully available
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // 1. Fetch transcript from Fireflies
        let transcript;
        try {
          transcript = await getTranscript(meetingId);
        } catch (err) {
          console.error("🔥 Failed to fetch transcript:", err.message);
          return;
        }

        if (!transcript || !transcript.sentences || transcript.sentences.length === 0) {
          console.warn("🔥 Transcript is empty or has no sentences");
          return;
        }

        console.log(`🔥 Transcript: "${transcript.title}" (${transcript.sentences.length} sentences)`);

        // 2. Match to contact via calendar event title
        const transcriptTitle = transcript.title || "";
        const transcriptDate = transcript.date ? new Date(transcript.date) : new Date();
        let contactId = null;
        let clientName = null;

        // Try matching by title — extract name from transcript title
        // Fireflies uses the calendar event title, so it should match our format
        const nameFromTitle = extractNameFromTitle(transcriptTitle);

        if (nameFromTitle && supabase) {
          // Search meet_event_subscriptions for a matching calendar event
          const windowStart = new Date(transcriptDate.getTime() - 24 * 60 * 60 * 1000).toISOString();
          const windowEnd = new Date(transcriptDate.getTime() + 24 * 60 * 60 * 1000).toISOString();

          const { data: matches } = await supabase
            .from("meet_event_subscriptions")
            .select("contact_id, calendar_event_title")
            .ilike("calendar_event_title", `%${nameFromTitle}%`)
            .gte("scheduled_start", windowStart)
            .lte("scheduled_start", windowEnd)
            .order("created_at", { ascending: false })
            .limit(1);

          if (matches && matches.length > 0) {
            contactId = matches[0].contact_id;
            clientName = nameFromTitle;
            console.log(`🔥 Matched to contact ${contactId} via title "${nameFromTitle}"`);
          }
        }

        // Fallback: try matching by transcript title directly against calendar_event_title
        if (!contactId && supabase) {
          const { data: titleMatches } = await supabase
            .from("meet_event_subscriptions")
            .select("contact_id, calendar_event_title")
            .ilike("calendar_event_title", `%${transcriptTitle.substring(0, 50)}%`)
            .order("created_at", { ascending: false })
            .limit(1);

          if (titleMatches && titleMatches.length > 0) {
            contactId = titleMatches[0].contact_id;
            clientName = extractNameFromTitle(titleMatches[0].calendar_event_title);
            console.log(`🔥 Matched to contact ${contactId} via direct title match`);
          }
        }

        if (!contactId) {
          console.warn("🔥 Could not match transcript to any contact — storing as unmatched");
          if (supabase) {
            await supabase.from("fireflies_transcripts").upsert(
              {
                transcript_id: meetingId,
                meeting_title: transcriptTitle,
                meeting_date: transcriptDate.toISOString(),
                status: "unmatched",
              },
              { onConflict: "transcript_id" }
            );
          }
          return;
        }

        // 3. Check if Google/Gemini artifacts already exist (priority check)
        const googleExists = await checkGoogleArtifactsExist(contactId);
        if (googleExists) {
          console.log("🔥 Google/Gemini artifacts already exist — skipping Fireflies backup");
          if (supabase) {
            await supabase.from("fireflies_transcripts").upsert(
              {
                transcript_id: meetingId,
                contact_id: contactId,
                meeting_title: transcriptTitle,
                meeting_date: transcriptDate.toISOString(),
                status: "skipped_google_exists",
                processed_at: new Date().toISOString(),
              },
              { onConflict: "transcript_id" }
            );
          }
          return;
        }

        // 4. Format transcript
        const rawText = formatTranscriptText(transcript.sentences);
        console.log(`🔥 Formatted transcript: ${rawText.length} chars`);

        // 5. Generate ChatGPT summary
        let summaryText = "";
        try {
          summaryText = await summarizeConsultation(rawText, {
            clientName: clientName || "Client",
          });
        } catch (err) {
          console.error("🔥 Failed to generate summary:", err.message);
          summaryText = "Summary generation failed. See raw transcript.";
        }

        // 6. Save to GHL custom fields
        const customField = {
          Tj9WuXbE1hWtxfTgCMGM: rawText,         // fireflies_transcript_text
          EU4U5jeDJxXHQ8Jh8gfT: summaryText,     // fireflies_chatgpt_summary
          LUASmxIwwPBr3SsZEHd9: meetingId,       // fireflies_transcript_id
          HORoQH6waBo9xSabFbyM: new Date().toISOString(), // fireflies_processed_at
        };

        try {
          await updateContact(contactId, { customField });
          console.log(`🔥 ✅ Saved Fireflies data to contact ${contactId}`);
        } catch (err) {
          console.error("🔥 Failed to update GHL contact:", err.message);
        }

        // 7. Track for cleanup
        if (supabase) {
          await supabase.from("fireflies_transcripts").upsert(
            {
              transcript_id: meetingId,
              contact_id: contactId,
              meeting_title: transcriptTitle,
              meeting_date: transcriptDate.toISOString(),
              status: "processed",
              processed_at: new Date().toISOString(),
            },
            { onConflict: "transcript_id" }
          );
        }

        console.log("🔥 ════════════════════════════════════════════════════════\n");
      } catch (err) {
        console.error("🔥 Fireflies webhook handler error:", err.message || err);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // FIREFLIES CLEANUP ENDPOINT
  // Deletes processed transcripts from Fireflies to stay within free plan
  // storage limits. Call weekly via cron or manually.
  // ═══════════════════════════════════════════════════════════════════════════

  app.post("/api/fireflies/cleanup", async (req, res) => {
    try {
      console.log("🧹 Starting Fireflies transcript cleanup...");

      if (!supabase) {
        return res.status(500).json({ error: "Supabase not configured" });
      }

      // Find transcripts older than 7 days that are processed or skipped
      const cutoffDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const { data: toDelete, error: queryErr } = await supabase
        .from("fireflies_transcripts")
        .select("transcript_id")
        .in("status", ["processed", "skipped_google_exists"])
        .lt("created_at", cutoffDate);

      if (queryErr) {
        console.error("🧹 Error querying transcripts:", queryErr);
        return res.status(500).json({ error: queryErr.message });
      }

      if (!toDelete || toDelete.length === 0) {
        console.log("🧹 No transcripts to clean up");
        return res.json({ success: true, deleted: 0, message: "No transcripts to clean up" });
      }

      const ids = toDelete.map((r) => r.transcript_id);
      console.log(`🧹 Found ${ids.length} transcripts to delete from Fireflies`);

      // Delete from Fireflies API
      const deletedCount = await batchDeleteTranscripts(ids);

      // Mark as deleted in Supabase
      const { error: updateErr } = await supabase
        .from("fireflies_transcripts")
        .update({
          status: "deleted",
          deleted_at: new Date().toISOString(),
        })
        .in("transcript_id", ids);

      if (updateErr) {
        console.error("🧹 Error updating deletion status:", updateErr);
      }

      console.log(`🧹 Cleanup complete: ${deletedCount}/${ids.length} deleted`);
      res.json({ success: true, deleted: deletedCount, total: ids.length });
    } catch (err) {
      console.error("🧹 Cleanup error:", err.message);
      res.status(500).json({ error: err.message });
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

    // GHL only sends webhooks when appointments are created/updated, not when they end.
    // We schedule the task creation to run AFTER the appointment ends.
    const now = new Date();
    const appointmentEndTime = new Date(endTime);
    const msUntilEnd = appointmentEndTime.getTime() - now.getTime();

    if (msUntilEnd > 0) {
      // Appointment hasn't ended yet - schedule the check for after it ends
      console.log(`⏰ Scheduling quote verification check for after consultation ends`);
      console.log(`   Appointment ends at: ${endTime}`);
      console.log(`   Will check in: ${Math.round(msUntilEnd / 1000 / 60)} minutes`);

      setTimeout(async () => {
        console.log(`🔔 Consultation ended, now checking if quote verification is needed for contact ${contactId}`);
        await createQuoteVerificationTaskIfNeeded(contactId, appointmentId, calendarId, appointmentEndTime);
      }, msUntilEnd + 1000); // Add 1 second buffer

      return;
    }

    // Appointment already ended - check immediately
    console.log(`✅ Consultation already ended (ended at ${endTime}), checking if quote verification task is needed...`);
    await createQuoteVerificationTaskIfNeeded(contactId, appointmentId, calendarId, appointmentEndTime);
  }

  /**
   * Helper function to create quote verification task if needed
   * Called either immediately (if appointment ended) or after scheduled delay
   */
  async function createQuoteVerificationTaskIfNeeded(contactId, appointmentId, calendarId, appointmentEndTime) {
    const { supabase } = require("../clients/supabaseClient");

    // Fetch contact from GHL v2 API to get followers array
    // v1 API doesn't return followers, only assignedTo
    let contact = null;
    try {
      contact = await getContactV2(contactId);
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

      console.log("👥 Contact assignment info:", {
        owner: contactOwner,
        followers: followers,
      });

      // Build assignees list (owner + followers)
      const assignees = [contactOwner, ...followers].filter(Boolean);

      if (assignees.length === 0) {
        console.warn("⚠️ No assignees found for quote verification task");
        return;
      }

      console.log("📋 Task will be assigned to:", assignees);

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

  // ═══════════════════════════════════════════════════════════════════════════
  // SQUARE PAYMENT LINK GENERATION (iOS app on-demand)
  // ═══════════════════════════════════════════════════════════════════════════

  // POST /api/generate-payment-link - Generate a Square payment link for a contact
  app.post("/api/generate-payment-link", async (req, res) => {
    try {
      const { contactId, amountCents, description } = req.body;

      if (!contactId) {
        return res.status(400).json({
          success: false,
          error: "Missing required field: contactId",
        });
      }

      if (!amountCents || typeof amountCents !== "number" || amountCents <= 0) {
        return res.status(400).json({
          success: false,
          error: "Missing or invalid required field: amountCents (must be a positive number)",
        });
      }

      console.log(`[API] Generating payment link for contact ${contactId} — $${amountCents / 100}`);

      const paymentLink = await createDepositLinkForContact({
        contactId,
        amountCents,
        description: description || "Studio AZ Tattoo Payment",
      });

      console.log(`[API] Payment link generated: ${paymentLink.url}`);

      res.json({
        success: true,
        paymentLink: {
          url: paymentLink.url,
          paymentLinkId: paymentLink.paymentLinkId,
          orderId: paymentLink.orderId,
        },
      });
    } catch (error) {
      console.error("[API] Error generating payment link:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Failed to generate payment link",
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SQUARE OAUTH — PER-BARBER ACCOUNT CONNECTION
  // ═══════════════════════════════════════════════════════════════════════════

  // GET /square/oauth/start?barberGhlId=xxx
  // iOS opens this URL in an ASWebAuthenticationSession (Safari sheet).
  // Returns a redirect to Square's OAuth authorization page.
  app.get("/square/oauth/start", (req, res) => {
    try {
      const { barberGhlId } = req.query;
      if (!barberGhlId) {
        return res.status(400).send("Missing barberGhlId query parameter");
      }
      const url = buildOAuthUrl(barberGhlId);
      res.redirect(url);
    } catch (error) {
      console.error("[SquareOAuth] Error building OAuth URL:", error.message);
      res.status(500).send("Failed to initiate Square OAuth");
    }
  });

  // GET /square/oauth/callback?code=xxx&state=barberGhlId
  // Square redirects here after the barber authorizes.
  // Exchanges code for token, stores in Supabase, then redirects to a deep link
  // so the iOS app knows the connection succeeded.
  app.get("/square/oauth/callback", async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
      console.error("[SquareOAuth] OAuth denied by user:", error);
      return res.redirect(`studioaz://square-oauth?success=false&error=${encodeURIComponent(error)}`);
    }

    if (!code || !state) {
      return res.status(400).send("Missing code or state in OAuth callback");
    }

    const barberGhlId = decodeURIComponent(state);

    try {
      const result = await exchangeCodeForToken(code, barberGhlId);
      console.log(`[SquareOAuth] Connected barber ${barberGhlId} → merchant ${result.merchantId}`);
      // Deep link back to the iOS app — the app listens for this URL scheme
      res.redirect(
        `studioaz://square-oauth?success=true&merchantName=${encodeURIComponent(result.merchantName || "")}`
      );
    } catch (err) {
      console.error("[SquareOAuth] Token exchange failed:", err.message);
      res.redirect(`studioaz://square-oauth?success=false&error=${encodeURIComponent(err.message)}`);
    }
  });

  // GET /api/barbers/:barberGhlId/square/status
  // Check if a barber has connected their Square account.
  app.get("/api/barbers/:barberGhlId/square/status", async (req, res) => {
    try {
      const { barberGhlId } = req.params;
      const tokenRow = await getBarberToken(barberGhlId);
      if (!tokenRow) {
        return res.json({ success: true, connected: false });
      }
      res.json({
        success: true,
        connected: true,
        merchantName: tokenRow.square_merchant_name,
        connectedAt: tokenRow.connected_at,
        lastSyncedAt: tokenRow.last_synced_at,
      });
    } catch (error) {
      console.error("[API] Error checking Square status:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // DELETE /api/barbers/:barberGhlId/square/disconnect
  // Disconnect a barber's Square account.
  app.delete("/api/barbers/:barberGhlId/square/disconnect", async (req, res) => {
    try {
      const { barberGhlId } = req.params;
      await disconnectBarber(barberGhlId);
      res.json({ success: true });
    } catch (error) {
      console.error("[API] Error disconnecting Square:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // GET /api/barbers/square/connections
  // Admin: list all barbers and their Square connection status.
  app.get("/api/barbers/square/connections", async (req, res) => {
    try {
      const statuses = await getAllBarberConnectionStatuses();
      res.json({ success: true, connections: statuses });
    } catch (error) {
      console.error("[API] Error listing barber connections:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/barbers/:barberGhlId/square/sync
  // Pull and sync a barber's Square transactions.
  // Body: { startDate?, endDate?, incremental? }
  app.post("/api/barbers/:barberGhlId/square/sync", async (req, res) => {
    try {
      const { barberGhlId } = req.params;
      const { startDate, endDate, incremental } = req.body;
      const result = await syncBarberTransactions(barberGhlId, {
        startDate,
        endDate,
        incremental,
      });
      res.json({ success: true, ...result });
    } catch (error) {
      console.error("[API] Error syncing barber transactions:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/barbers/:barberGhlId/square/assign
  // Manually assign an unmatched payment to a GHL contact.
  // Body: { squarePaymentId, contactId, amountCents, createdAt, note?, appointmentId? }
  app.post("/api/barbers/:barberGhlId/square/assign", async (req, res) => {
    try {
      const { barberGhlId } = req.params;
      const { squarePaymentId, contactId, contactName, amountCents, serviceCents, createdAt, note, appointmentId, calendarId, squareTipCents, itemType, isProductSale } = req.body;

      if (!squarePaymentId || !contactId || !amountCents) {
        return res.status(400).json({
          success: false,
          error: "Missing required fields: squarePaymentId, contactId, amountCents",
        });
      }

      const result = await assignUnmatchedPayment({
        barberGhlId,
        squarePaymentId,
        contactId,
        contactName,
        amountCents,
        serviceCents,
        createdAt,
        note,
        appointmentId,
        calendarId,
        squareTipCents,
        itemType,
        isProductSale,
      });

      res.json({ success: true, ...result });
    } catch (error) {
      console.error("[API] Error assigning unmatched payment:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/barbers/:barberGhlId/square/unmatch
  // Reverse an auto-matched payment (delete the transaction record).
  // Body: { squarePaymentId }
  app.post("/api/barbers/:barberGhlId/square/unmatch", async (req, res) => {
    try {
      const { barberGhlId } = req.params;
      const { squarePaymentId } = req.body;

      if (!squarePaymentId) {
        return res.status(400).json({ success: false, error: "Missing squarePaymentId" });
      }

      const result = await unmatchPayment({ barberGhlId, squarePaymentId });
      res.json({ success: true, ...result });
    } catch (error) {
      console.error("[API] Error unmatching payment:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/barbers/:barberGhlId/square/walk-in
  // Record a payment as a walk-in (no GHL contact or appointment).
  // Body: { squarePaymentId, amountCents, createdAt }
  app.post("/api/barbers/:barberGhlId/square/walk-in", async (req, res) => {
    try {
      const { barberGhlId } = req.params;
      const { squarePaymentId, amountCents, createdAt } = req.body;

      if (!squarePaymentId || !amountCents) {
        return res.status(400).json({
          success: false,
          error: "Missing required fields: squarePaymentId, amountCents",
        });
      }

      const result = await recordWalkIn({ barberGhlId, squarePaymentId, amountCents, createdAt });
      res.json({ success: true, ...result });
    } catch (error) {
      console.error("[API] Error recording walk-in payment:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/barbers/:barberGhlId/square/bulk-confirm
  // Bulk-confirm suggested matches, walk-ins, and reversals in a single request.
  // Body: { matches: [...], walkIns: [...], reversals: [...] }
  app.post("/api/barbers/:barberGhlId/square/bulk-confirm", async (req, res) => {
    try {
      const { barberGhlId } = req.params;
      const { matches = [], walkIns = [], reversals = [] } = req.body;

      const results = { confirmed: 0, walkInsRecorded: 0, reversed: 0, errors: [] };

      // 1. Process matches (both auto-suggested and manual)
      for (const match of matches) {
        try {
          await assignUnmatchedPayment({
            barberGhlId,
            squarePaymentId: match.squarePaymentId,
            contactId: match.contactId,
            contactName: match.contactName,
            amountCents: match.amountCents,
            serviceCents: match.serviceCents,
            createdAt: match.createdAt,
            note: match.note,
            appointmentId: match.appointmentId,
            calendarId: match.calendarId,
            squareTipCents: match.squareTipCents,
            itemType: match.itemType,
            isProductSale: match.isProductSale,
            basePriceCents: match.basePriceCents,
          });
          results.confirmed++;
        } catch (err) {
          results.errors.push({ squarePaymentId: match.squarePaymentId, error: err.message });
        }
      }

      // 2. Process walk-ins
      for (const walkIn of walkIns) {
        try {
          await recordWalkIn({
            barberGhlId,
            squarePaymentId: walkIn.squarePaymentId,
            amountCents: walkIn.amountCents,
            createdAt: walkIn.createdAt,
          });
          results.walkInsRecorded++;
        } catch (err) {
          results.errors.push({ squarePaymentId: walkIn.squarePaymentId, error: err.message });
        }
      }

      // 3. Process reversals (unmatch previously confirmed payments)
      for (const reversal of reversals) {
        try {
          await unmatchPayment({ barberGhlId, squarePaymentId: reversal.squarePaymentId });
          results.reversed++;
        } catch (err) {
          results.errors.push({ squarePaymentId: reversal.squarePaymentId, error: err.message });
        }
      }

      console.log(`[API] Bulk confirm for ${barberGhlId}: ${results.confirmed} confirmed, ${results.walkInsRecorded} walk-ins, ${results.reversed} reversed, ${results.errors.length} errors`);
      res.json({ success: results.errors.length === 0, ...results });
    } catch (error) {
      console.error("[API] Error in bulk confirm:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/barbers/:barberGhlId/square/refresh-token
  // Manually refresh a single barber's Square access token.
  app.post("/api/barbers/:barberGhlId/square/refresh-token", async (req, res) => {
    try {
      const { barberGhlId } = req.params;
      const result = await refreshBarberToken(barberGhlId);
      res.json({ success: true, expiresAt: result.expires_at });
    } catch (error) {
      console.error("[API] Error refreshing Square token:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/barbers/square/refresh-all-tokens
  // Refresh tokens for all barbers expiring within 8 days.
  // Intended to be called by a daily cron job (e.g., Render Cron or an external scheduler).
  app.post("/api/barbers/square/refresh-all-tokens", async (req, res) => {
    try {
      const results = await refreshAllExpiringTokens();
      res.json({ success: true, ...results });
    } catch (error) {
      console.error("[API] Error in batch token refresh:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // GET /api/barbers/:barberGhlId/square/order/:orderId
  // Fetch a Square Order's full details (line items, discounts, etc.)
  app.get("/api/barbers/:barberGhlId/square/order/:orderId", async (req, res) => {
    try {
      const { barberGhlId, orderId } = req.params;
      const tokenRow = await getBarberToken(barberGhlId);
      if (!tokenRow) {
        return res.status(404).json({ success: false, error: "No Square connection for this barber" });
      }

      const IS_PROD = process.env.SQUARE_ENVIRONMENT === "production";
      const BASE_URL = IS_PROD ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";

      const orderRes = await axios.get(`${BASE_URL}/v2/orders/${orderId}`, {
        headers: { Authorization: `Bearer ${tokenRow.access_token}` },
      });

      const order = orderRes.data?.order;
      if (!order) {
        return res.status(404).json({ success: false, error: "Order not found" });
      }

      // Return a clean summary
      res.json({
        success: true,
        order: {
          id: order.id,
          state: order.state,
          totalMoney: order.total_money,
          totalDiscountMoney: order.total_discount_money,
          totalTipMoney: order.total_tip_money,
          lineItems: (order.line_items || []).map(li => ({
            name: li.name,
            quantity: li.quantity,
            basePriceMoney: li.base_price_money,
            totalMoney: li.total_money,
            totalDiscountMoney: li.total_discount_money,
            appliedDiscounts: li.applied_discounts,
            itemType: li.item_type,
            catalogObjectId: li.catalog_object_id,
          })),
          discounts: order.discounts,
          referenceId: order.reference_id,
          createdAt: order.created_at,
        },
      });
    } catch (error) {
      console.error("[API] Error fetching Square order:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // GET /api/service-prices - Return all calendar service prices
  app.get("/api/service-prices", async (req, res) => {
    try {
      const priceMap = await getServicePriceMap();
      const prices = {};
      for (const [calendarId, price] of priceMap) {
        prices[calendarId] = price;
      }
      res.json({ success: true, prices });
    } catch (error) {
      console.error("[API] Error fetching service prices:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TRANSLATION (iOS in-app message translation via OpenAI)
  // ═══════════════════════════════════════════════════════════════════════════

  // POST /api/translate - Translate text between English and Spanish
  app.post("/api/translate", async (req, res) => {
    try {
      const { text, targetLanguage } = req.body;

      if (!text || typeof text !== "string" || !text.trim()) {
        return res.status(400).json({
          success: false,
          error: "Missing required field: text",
        });
      }

      const target = targetLanguage || "es"; // Default: English → Spanish
      const targetLabel = target === "es" ? "Spanish" : "English";
      const sourceLabel = target === "es" ? "English" : "Spanish";

      console.log(`[API] Translating text (${sourceLabel} → ${targetLabel}): "${text.substring(0, 60)}..."`);

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are a strict text translator. Your ONLY job is to translate text from ${sourceLabel} to ${targetLabel}. Do NOT reply to the message. Do NOT interpret it. Do NOT add context or commentary. Return ONLY the direct translation of the input text, preserving the original meaning and tone. If the text already appears to be in ${targetLabel}, translate it literally anyway — do not generate a response.`,
          },
          {
            role: "user",
            content: `Translate this to ${targetLabel}: ${text.trim()}`,
          },
        ],
        temperature: 0.2,
        max_tokens: 500,
      });

      const translatedText = completion.choices[0]?.message?.content?.trim();

      if (!translatedText) {
        throw new Error("Empty response from OpenAI");
      }

      console.log(`[API] Translation result: "${translatedText.substring(0, 60)}..."`);

      res.json({
        success: true,
        translatedText,
        sourceLanguage: target === "es" ? "en" : "es",
        targetLanguage: target,
      });
    } catch (error) {
      console.error("[API] Translation error:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Failed to translate message",
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // MERGED WEBHOOK SERVER ROUTES
  // (Previously in webhook_server/index.js — now part of unified backend)
  // ═══════════════════════════════════════════════════════════════════════════

  const {
    handleAppointmentCreated,
    handleAppointmentUpdated,
    handleAppointmentDeleted,
    sendMessagePushNotification,
  } = require("../clients/appointmentWebhooks");

  const apnsService = require("../services/apnsService");
  const { TASK_TYPES, createCommandCenterTask } = require("../clients/commandCenter");
  const { generateVenmoDescription } = require("../clients/financialTracking");
  const { GHL_USER_IDS: GHL_IDS } = require("../config/constants");

  // ═══ GHL APPOINTMENT WEBHOOK (Supabase sync + reschedule detection + push) ═══
  app.post("/webhooks/ghl/appointments", async (req, res) => {
    try {
      console.log("📥 Received GHL appointment webhook");

      const { type } = req.body;

      switch (type) {
        case "AppointmentCreate":
        case "appointment.created":
          await handleAppointmentCreated(req.body);
          break;
        case "AppointmentUpdate":
        case "appointment.updated":
          await handleAppointmentUpdated(req.body);
          break;
        case "AppointmentDelete":
        case "appointment.deleted":
          await handleAppointmentDeleted(req.body);
          break;
        default:
          console.log(`⚠️ Unknown appointment event type: ${type}`);
      }

      res.status(200).json({ success: true });
    } catch (error) {
      console.error("❌ Error processing appointment webhook:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ═══ AI SETTER EVENTS — iOS polling endpoints ═══

  app.get("/api/ai-setter/events", async (req, res) => {
    try {
      if (!supabase) return res.status(503).json({ success: false, error: "Supabase not configured" });

      const { contactId, since, limit = 50 } = req.query;

      let query = supabase
        .from("ai_setter_events")
        .select("*")
        .order("event_timestamp", { ascending: false })
        .limit(parseInt(limit));

      if (contactId) query = query.eq("contact_id", contactId);
      if (since) query = query.gte("event_timestamp", since);

      const { data, error } = await query;
      if (error) throw error;

      res.json({ success: true, events: data || [] });
    } catch (error) {
      console.error("❌ Error fetching AI Setter events:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/ai-setter/stats", async (req, res) => {
    try {
      if (!supabase) return res.status(503).json({ success: false, error: "Supabase not configured" });

      const { data, error } = await supabase
        .from("ai_setter_events")
        .select("event_type")
        .gte("event_timestamp", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

      if (error) throw error;

      const stats = {
        depositsThisWeek: data.filter((e) => e.event_type === "deposit_paid").length,
        leadsQualifiedThisWeek: data.filter((e) => e.event_type === "lead_qualified").length,
        appointmentsBookedThisWeek: data.filter((e) => e.event_type === "appointment_booked").length,
        humanHandoffsThisWeek: data.filter((e) => e.event_type === "human_handoff").length,
      };

      res.json({ success: true, stats });
    } catch (error) {
      console.error("❌ Error fetching AI Setter stats:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ═══ PUSH NOTIFICATIONS ═══

  app.post("/api/notifications/queue", async (req, res) => {
    try {
      const { userId, title, body, type, data = {}, priority = "normal" } = req.body;

      if (!userId || !title || !body || !type) {
        return res.status(400).json({ success: false, error: "Missing required fields: userId, title, body, type" });
      }

      const notification = {
        user_id: userId,
        title,
        body,
        notification_type: type,
        data,
        priority,
        status: "pending",
        created_at: new Date().toISOString(),
      };

      const { data: result, error } = await supabase
        .from("notification_queue")
        .insert([notification])
        .select()
        .single();

      if (error) throw error;
      res.json({ success: true, notification: result });
    } catch (error) {
      console.error("❌ Error queuing notification:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/notifications/pending", async (req, res) => {
    try {
      const { limit = 100 } = req.query;

      const { data: notifications, error: notifError } = await supabase
        .from("notification_queue")
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(parseInt(limit));

      if (notifError) throw notifError;

      const userIds = [...new Set(notifications.map((n) => n.user_id))];

      const { data: tokens, error: tokenError } = await supabase
        .from("push_tokens")
        .select("user_id, token, platform, device_model")
        .in("user_id", userIds)
        .eq("is_active", true);

      if (tokenError) throw tokenError;

      const tokensByUser = {};
      for (const token of tokens || []) {
        if (!tokensByUser[token.user_id]) tokensByUser[token.user_id] = [];
        tokensByUser[token.user_id].push(token);
      }

      const result = notifications.map((n) => ({
        ...n,
        push_tokens: tokensByUser[n.user_id] || [],
      }));

      res.json({ success: true, notifications: result });
    } catch (error) {
      console.error("❌ Error fetching pending notifications:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/notifications/:id/sent", async (req, res) => {
    try {
      const { id } = req.params;
      const { error } = await supabase
        .from("notification_queue")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", id);

      if (error) throw error;
      res.json({ success: true });
    } catch (error) {
      console.error("❌ Error marking notification sent:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/notifications/:id/failed", async (req, res) => {
    try {
      const { id } = req.params;
      const { error: errorMessage } = req.body;

      const { error } = await supabase
        .from("notification_queue")
        .update({ status: "failed", error_message: errorMessage })
        .eq("id", id);

      if (error) throw error;
      res.json({ success: true });
    } catch (error) {
      console.error("❌ Error marking notification failed:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/push-tokens/:userId", async (req, res) => {
    try {
      const { userId } = req.params;
      const { data, error } = await supabase
        .from("push_tokens")
        .select("*")
        .eq("user_id", userId)
        .eq("is_active", true);

      if (error) throw error;
      res.json({ success: true, tokens: data || [] });
    } catch (error) {
      console.error("❌ Error fetching push tokens:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/apns/status", (req, res) => {
    const status = apnsService.getConfigStatus();
    res.json({ success: true, ...status });
  });

  app.post("/api/apns/test", async (req, res) => {
    try {
      const { deviceToken, title, body, userId } = req.body;
      let targetToken = deviceToken;

      if (!targetToken && userId) {
        const { data: tokens, error } = await supabase
          .from("push_tokens")
          .select("token")
          .eq("user_id", userId)
          .eq("is_active", true)
          .limit(1);

        if (error || !tokens || tokens.length === 0) {
          return res.status(404).json({ success: false, error: "No push token found for user" });
        }
        targetToken = tokens[0].token;
      }

      if (!targetToken) {
        return res.status(400).json({ success: false, error: "Either deviceToken or userId is required" });
      }

      const result = await apnsService.send(targetToken, {
        title: title || "Test Notification",
        body: body || "This is a test notification from Studio AZ",
        type: "test",
      });

      res.json({ success: result.success, result });
    } catch (error) {
      console.error("❌ Error sending test notification:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ═══ ARTIST EARNINGS SUMMARY (admin dashboard) ═══
  // IMPORTANT: This must be defined BEFORE /api/artists/:artistId/earnings
  // to prevent Express from matching "earnings" as :artistId
  app.get("/api/artists/earnings/summary", async (req, res) => {
    try {
      if (!supabase) return res.status(503).json({ success: false, error: "Supabase not configured" });

      const { locationId = "mUemx2jG4wly4kJWBkI4" } = req.query;

      const { data: transactions, error: txError } = await supabase
        .from("transactions")
        .select("*")
        .eq("location_id", locationId);

      if (txError) throw txError;

      const { data: rates, error: ratesError } = await supabase
        .from("artist_commission_rates")
        .select("artist_ghl_id, artist_name, shop_percentage, artist_percentage")
        .eq("location_id", locationId)
        .is("effective_to", null);

      if (ratesError) throw ratesError;

      const artistInfo = {};
      for (const r of rates || []) {
        artistInfo[r.artist_ghl_id] = {
          name: r.artist_name,
          shopPercentage: r.shop_percentage,
          artistPercentage: r.artist_percentage,
        };
      }

      const byArtist = {};
      for (const t of transactions || []) {
        if (!byArtist[t.artist_ghl_id]) byArtist[t.artist_ghl_id] = [];
        byArtist[t.artist_ghl_id].push(t);
      }

      const artistsSummary = [];
      for (const [artistId, artistTransactions] of Object.entries(byArtist)) {
        let totalEarned = 0;
        let pendingFromShop = 0;
        let owedToShop = 0;

        for (const t of artistTransactions) {
          totalEarned += parseFloat(t.artist_amount);

          if (t.settlement_status !== "settled") {
            const unsettled =
              t.settlement_status === "partial"
                ? t.payment_recipient === "shop"
                  ? parseFloat(t.artist_amount) - parseFloat(t.settled_amount || 0)
                  : parseFloat(t.shop_amount) - parseFloat(t.settled_amount || 0)
                : t.payment_recipient === "shop"
                  ? parseFloat(t.artist_amount)
                  : parseFloat(t.shop_amount);

            if (t.payment_recipient === "shop") {
              pendingFromShop += unsettled;
            } else {
              owedToShop += unsettled;
            }
          }
        }

        artistsSummary.push({
          artistId,
          artistName: artistInfo[artistId]?.name || "Unknown Artist",
          shopPercentage: artistInfo[artistId]?.shopPercentage || 50,
          artistPercentage: artistInfo[artistId]?.artistPercentage || 50,
          totalEarned: parseFloat(totalEarned.toFixed(2)),
          pendingFromShop: parseFloat(pendingFromShop.toFixed(2)),
          owedToShop: parseFloat(owedToShop.toFixed(2)),
          netBalance: parseFloat((pendingFromShop - owedToShop).toFixed(2)),
          transactionCount: artistTransactions.length,
        });
      }

      // Add artists with no transactions
      for (const r of rates || []) {
        if (!byArtist[r.artist_ghl_id]) {
          artistsSummary.push({
            artistId: r.artist_ghl_id,
            artistName: r.artist_name,
            shopPercentage: r.shop_percentage,
            artistPercentage: r.artist_percentage,
            totalEarned: 0,
            pendingFromShop: 0,
            owedToShop: 0,
            netBalance: 0,
            transactionCount: 0,
          });
        }
      }

      // Calculate shop totals
      let shopTotalRevenue = 0;
      let shopPendingPayouts = 0;
      let shopPendingCollections = 0;

      for (const t of transactions || []) {
        shopTotalRevenue += parseFloat(t.shop_amount);
        if (t.settlement_status !== "settled") {
          if (t.payment_recipient === "shop") {
            shopPendingPayouts += parseFloat(t.artist_amount) - parseFloat(t.settled_amount || 0);
          } else {
            shopPendingCollections += parseFloat(t.shop_amount) - parseFloat(t.settled_amount || 0);
          }
        }
      }

      res.json({
        success: true,
        summary: {
          artists: artistsSummary,
          shopTotals: {
            totalRevenue: parseFloat(shopTotalRevenue.toFixed(2)),
            pendingPayouts: parseFloat(shopPendingPayouts.toFixed(2)),
            pendingCollections: parseFloat(shopPendingCollections.toFixed(2)),
            netBalance: parseFloat((shopPendingCollections - shopPendingPayouts).toFixed(2)),
          },
        },
      });
    } catch (error) {
      console.error("❌ Error fetching earnings summary:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ═══ PAYOUTS ═══

  app.post("/api/payouts", async (req, res) => {
    try {
      const {
        artistId,
        artistName,
        payoutType,
        totalAmount,
        payoutMethod,
        transactionIds,
        periodStart,
        periodEnd,
        notes,
        locationId = "mUemx2jG4wly4kJWBkI4",
      } = req.body;

      if (!artistId || !artistName || !payoutType || !totalAmount) {
        return res.status(400).json({
          success: false,
          error: "Missing required fields: artistId, artistName, payoutType, totalAmount",
        });
      }

      let venmoDescription = "";
      if (transactionIds && transactionIds.length > 0) {
        venmoDescription = await generateVenmoDescription(transactionIds, payoutType);
      }

      const payout = {
        id: crypto.randomUUID(),
        artist_ghl_id: artistId,
        artist_name: artistName,
        payout_type: payoutType,
        total_amount: parseFloat(totalAmount),
        payout_method: payoutMethod || null,
        transaction_ids: transactionIds || [],
        venmo_description: venmoDescription,
        status: "pending",
        period_start: periodStart || null,
        period_end: periodEnd || null,
        notes: notes || null,
        location_id: locationId,
        created_at: new Date().toISOString(),
      };

      const { data, error } = await supabase
        .from("artist_payouts")
        .insert([payout])
        .select()
        .single();

      if (error) throw error;

      console.log(`✅ Payout created: $${totalAmount} ${payoutType} for ${artistName}`);
      res.json({ success: true, payout: data, venmoDescription });
    } catch (error) {
      console.error("❌ Error creating payout:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/payouts/:id/complete", async (req, res) => {
    try {
      const { id } = req.params;
      const { completedBy } = req.body;

      const { data: payout, error: fetchError } = await supabase
        .from("artist_payouts")
        .select("*")
        .eq("id", id)
        .single();

      if (fetchError) throw fetchError;

      const { error: updateError } = await supabase
        .from("artist_payouts")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          completed_by: completedBy || null,
        })
        .eq("id", id);

      if (updateError) throw updateError;

      // Mark linked transactions as settled
      if (payout.transaction_ids && payout.transaction_ids.length > 0) {
        for (const txId of payout.transaction_ids) {
          const { data: tx } = await supabase
            .from("transactions")
            .select("*")
            .eq("id", txId)
            .single();

          if (tx) {
            const amountToSettle =
              payout.payout_type === "shop_to_artist"
                ? parseFloat(tx.artist_amount)
                : parseFloat(tx.shop_amount);

            await supabase
              .from("transactions")
              .update({
                settlement_status: "settled",
                settled_amount: amountToSettle,
                settled_at: new Date().toISOString(),
              })
              .eq("id", txId);
          }
        }
      }

      console.log(`✅ Payout ${id} completed`);
      res.json({ success: true });
    } catch (error) {
      console.error("❌ Error completing payout:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/payouts", async (req, res) => {
    try {
      const { artistId, status, locationId = "mUemx2jG4wly4kJWBkI4", limit = 50 } = req.query;

      let query = supabase
        .from("artist_payouts")
        .select("*")
        .eq("location_id", locationId)
        .order("created_at", { ascending: false })
        .limit(parseInt(limit));

      if (artistId) query = query.eq("artist_ghl_id", artistId);
      if (status) query = query.eq("status", status);

      const { data, error } = await query;
      if (error) throw error;

      res.json({ success: true, payouts: data || [] });
    } catch (error) {
      console.error("❌ Error fetching payouts:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ═══ CONTACT COMMENTS (Route A Admin-Artist Communication) ═══

  app.get("/api/contacts/:contactId/comments", async (req, res) => {
    const { contactId } = req.params;
    const { locationId } = req.query;

    if (!locationId) {
      return res.status(400).json({ success: false, error: "locationId is required" });
    }

    try {
      const { data, error } = await supabase
        .from("contact_comments")
        .select("*")
        .eq("contact_id", contactId)
        .eq("location_id", locationId)
        .order("created_at", { ascending: true });

      if (error) throw error;
      res.json({ success: true, comments: data });
    } catch (error) {
      console.error("❌ Error fetching comments:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/contacts/:contactId/admin-update", async (req, res) => {
    const { contactId } = req.params;
    const { contactName, adminNotes, fieldChanges, artistGhlId, authorGhlId, authorName, locationId } = req.body;

    if (!adminNotes || !artistGhlId || !authorGhlId || !locationId) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: adminNotes, artistGhlId, authorGhlId, locationId",
      });
    }

    try {
      const threadId = crypto.randomUUID();

      const comment = {
        id: crypto.randomUUID(),
        contact_id: contactId,
        author_ghl_id: authorGhlId,
        author_name: authorName || "Admin",
        author_role: "admin",
        comment_type: "update",
        message: adminNotes,
        field_changes: fieldChanges && fieldChanges.length > 0 ? fieldChanges : null,
        quote_change: null,
        parent_comment_id: null,
        thread_id: threadId,
        is_read: false,
        created_at: new Date().toISOString(),
        location_id: locationId,
      };

      const { data: commentData, error: commentError } = await supabase
        .from("contact_comments")
        .insert([comment])
        .select()
        .single();

      if (commentError) throw commentError;

      const dueAt = new Date(Date.now() + 6 * 60 * 60 * 1000);

      await createCommandCenterTask({
        type: TASK_TYPES.ADMIN_UPDATE,
        contactId,
        contactName: contactName || "Unknown Contact",
        assignedTo: [artistGhlId],
        triggerEvent: "admin_update",
        locationId,
        customDueDate: dueAt,
        metadata: {
          comment_id: commentData.id,
          thread_id: threadId,
          admin_name: authorName || "Admin",
        },
      });

      console.log(`✅ Created admin update comment and task for artist: ${artistGhlId}`);
      res.json({ success: true, comment: commentData, taskCreated: true });
    } catch (error) {
      console.error("❌ Error creating admin update:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/contacts/:contactId/artist-response", async (req, res) => {
    const { contactId } = req.params;
    const { contactName, parentCommentId, threadId, artistNotes, quoteChange, fieldChangesConfirmed, authorGhlId, authorName, locationId } = req.body;

    if (!artistNotes || !threadId || !authorGhlId || !locationId) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: artistNotes, threadId, authorGhlId, locationId",
      });
    }

    try {
      const comment = {
        id: crypto.randomUUID(),
        contact_id: contactId,
        author_ghl_id: authorGhlId,
        author_name: authorName || "Artist",
        author_role: "artist",
        comment_type: "response",
        message: artistNotes,
        field_changes: fieldChangesConfirmed && fieldChangesConfirmed.length > 0 ? fieldChangesConfirmed : null,
        quote_change: quoteChange || null,
        parent_comment_id: parentCommentId || null,
        thread_id: threadId,
        is_read: false,
        created_at: new Date().toISOString(),
        location_id: locationId,
      };

      const { data: commentData, error: commentError } = await supabase
        .from("contact_comments")
        .insert([comment])
        .select()
        .single();

      if (commentError) throw commentError;

      const dueAt = new Date(Date.now() + 2 * 60 * 60 * 1000);

      await createCommandCenterTask({
        type: TASK_TYPES.ARTIST_RESPONSE,
        contactId,
        contactName: contactName || "Unknown Contact",
        assignedTo: [GHL_IDS.MARIA],
        triggerEvent: "artist_response",
        locationId,
        customDueDate: dueAt,
        metadata: {
          comment_id: commentData.id,
          thread_id: threadId,
          artist_name: authorName || "Artist",
          quote_changed: quoteChange ? "true" : "false",
        },
      });

      console.log("✅ Created artist response comment and task for admin");
      res.json({ success: true, comment: commentData, taskCreated: true });
    } catch (error) {
      console.error("❌ Error creating artist response:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/comments/:commentId/read", async (req, res) => {
    const { commentId } = req.params;
    const { userGhlId } = req.body;

    if (!userGhlId) {
      return res.status(400).json({ success: false, error: "userGhlId is required" });
    }

    try {
      const { error } = await supabase
        .from("contact_comments")
        .update({
          is_read: true,
          read_at: new Date().toISOString(),
          read_by: userGhlId,
        })
        .eq("id", commentId);

      if (error) throw error;
      res.json({ success: true });
    } catch (error) {
      console.error("❌ Error marking comment as read:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // STAFF EMAIL VERIFICATION (Sign-Up Flow)
  // ═══════════════════════════════════════════════════════════════════════════

  // Simple rate limiter: 5 requests per minute per IP
  const verifyEmailRateLimit = new Map();

  app.post("/api/verify-email", async (req, res) => {
    try {
      // Rate limiting
      const ip = req.ip || req.connection.remoteAddress;
      const now = Date.now();
      const windowMs = 60 * 1000;
      const maxRequests = 5;

      const entry = verifyEmailRateLimit.get(ip);
      if (entry && now - entry.windowStart < windowMs) {
        if (entry.count >= maxRequests) {
          return res.status(429).json({
            success: false,
            error: "Too many requests. Please try again in a minute.",
          });
        }
        entry.count++;
      } else {
        verifyEmailRateLimit.set(ip, { windowStart: now, count: 1 });
      }

      // Clean up old entries periodically
      if (verifyEmailRateLimit.size > 1000) {
        for (const [key, val] of verifyEmailRateLimit) {
          if (now - val.windowStart > windowMs) verifyEmailRateLimit.delete(key);
        }
      }

      const { email } = req.body;
      if (!email || typeof email !== "string") {
        return res.status(400).json({
          success: false,
          error: "Email is required.",
        });
      }

      const result = await verifyStaffEmail(email);

      if (!result.found) {
        return res.json({
          success: false,
          error:
            "This email is not associated with a Studio AZ staff account. Please contact your manager for access.",
        });
      }

      // Auto-assign role based on email
      const normalizedEmail = email.trim().toLowerCase();
      let role = "artist";
      if (normalizedEmail === "chavezctz@gmail.com") {
        role = "owner";
      } else if (normalizedEmail === "mariaaclaflin@gmail.com") {
        role = "admin";
      }

      res.json({
        success: true,
        ghlUser: result.ghlUser,
        locations: result.locations,
        role,
      });
    } catch (error) {
      console.error("❌ Error verifying staff email:", error);
      res.status(500).json({
        success: false,
        error: "Failed to verify email. Please try again.",
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // RENT TRACKER — Venmo Email Webhook (CloudMailin)
  // ═══════════════════════════════════════════════════════════════════════════

  app.post("/api/rent-tracker/venmo-webhook", async (req, res) => {
    try {
      const { db } = require("../clients/instantDb");
      const { id } = require("@instantdb/admin");
      const { parseVenmoEmail, generateDedup } = require("../rentTracker/venmoEmailParser");
      const { buildAliasMap, matchTenant, attributeToWeek, getPaymentType } = require("../rentTracker/tenantMatcher");

      const payload = req.body;
      console.log("\n📩 Venmo webhook received");

      // 1. Basic validation — check it came from Venmo
      const envelopeFrom = payload?.envelope?.from || "";
      const headerFrom = payload?.headers?.from || "";
      const subject = payload?.headers?.subject || "";

      if (!envelopeFrom.includes("venmo") && !headerFrom.toLowerCase().includes("venmo")) {
        console.log("  ⚠️ Not from Venmo, ignoring:", envelopeFrom);
        return res.status(200).json({ ok: true, skipped: "not-venmo" });
      }

      // 2. Parse the email body
      const emailDate = payload?.headers?.date || null;
      const parsed = parseVenmoEmail(payload?.plain || "", payload?.html || "", emailDate);

      console.log("  Parsed:", {
        sender: parsed.senderName,
        amount: parsed.amount,
        note: parsed.note,
        date: parsed.date?.toISOString(),
      });

      if (!parsed.senderName || !parsed.amount) {
        console.log("  ⚠️ Could not parse sender or amount, skipping");
        return res.status(200).json({ ok: true, skipped: "parse-failed" });
      }

      // 3. Load tenants and match
      const { tenants } = await db.query({ tenants: {} });
      const aliasMap = buildAliasMap(tenants);
      const tenant = matchTenant(parsed.senderName, aliasMap);

      if (!tenant) {
        console.log(`  ⚠️ No tenant match for "${parsed.senderName}", skipping`);
        return res.status(200).json({ ok: true, skipped: "no-tenant-match", sender: parsed.senderName });
      }

      console.log(`  ✅ Matched to tenant: ${tenant.name}`);

      // 4. Check for duplicates — both by dedup key AND by tenant+amount+week
      const dedupKey = generateDedup(parsed.senderName, parsed.amount, parsed.date, parsed.note);

      const { payments: existingByDedup } = await db.query({
        payments: {
          $: { where: { venmoTxId: dedupKey } },
        },
      });

      if (existingByDedup.length > 0) {
        console.log(`  ⚠️ Duplicate detected by dedup key (${dedupKey}), skipping`);
        return res.status(200).json({ ok: true, skipped: "duplicate", dedupKey });
      }

      // Also check if a CSV-imported payment already exists for this tenant+amount+week
      // This prevents duplicates when forwarding emails for payments already in the CSV import
      const paymentDate = parsed.date || new Date();
      const { weekOf: checkWeek } = attributeToWeek(parsed.amount, parsed.note, paymentDate, tenant);

      const { payments: tenantPayments } = await db.query({
        payments: {
          $: { where: { weekOf: checkWeek } },
          tenant: {},
        },
      });

      const alreadyExists = tenantPayments.some(
        (p) => p.tenant?.[0]?.id === tenant.id && Math.abs(p.amount - parsed.amount) < 1,
      );

      if (alreadyExists) {
        console.log(`  ⚠️ Payment already exists for ${tenant.name} in week ${checkWeek} ($${parsed.amount}), skipping`);
        return res.status(200).json({ ok: true, skipped: "already-recorded", tenant: tenant.name, weekOf: checkWeek });
      }

      // 5. Determine week attribution (paymentDate already computed above)
      const { weekOf, attribution } = attributeToWeek(
        parsed.amount,
        parsed.note,
        paymentDate,
        tenant,
      );
      const paymentType = getPaymentType(tenant);

      console.log(`  Week: ${weekOf} | Attribution: ${attribution} | Type: ${paymentType}`);

      // 6. Write to InstantDB
      const paymentId = id();
      await db.transact(
        db.tx.payments[paymentId]
          .update({
            amount: parsed.amount,
            method: "venmo",
            type: paymentType,
            weekOf,
            paidAt: paymentDate,
            notes: parsed.note || undefined,
            venmoTxId: dedupKey,
            verified: false,
            attribution,
          })
          .link({ tenant: tenant.id }),
      );

      console.log(`  ✅ Payment logged: $${parsed.amount} from ${tenant.name} → week ${weekOf} (unverified)`);

      return res.status(200).json({
        ok: true,
        logged: true,
        tenant: tenant.name,
        amount: parsed.amount,
        weekOf,
      });
    } catch (error) {
      console.error("❌ Venmo webhook error:", error);
      // Always return 200 so CloudMailin doesn't retry
      return res.status(200).json({ ok: true, error: "internal-error" });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // END MERGED WEBHOOK SERVER ROUTES
  // ═══════════════════════════════════════════════════════════════════════════

  return app;
}

module.exports = { createApp };
