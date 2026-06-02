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
const { runShadow: runShadowFunnelGate } = require("../ai/v2/shadowGate"); // Phase 0.5 — funnel gate shadow mode (logs only)
const { verifyStaffEmail, ghlBarber, getCachedUsers } = require("../clients/ghlMultiLocationSdk");
const { getContactIdFromOrder, createDepositLinkForContact, getCheckoutSession, processCheckoutPayment } = require("../payments/squareClient");
const { createFinancingLinkForContact } = require("../payments/stripeClient");
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
  backfillBarberTransactions,
  assignUnmatchedPayment,
  unmatchPayment,
  recordWalkIn,
  SquareReauthRequiredError,
} = require("../payments/squareTransactionSync");
const { getServicePriceMap } = require("../config/barberServicePrices");
const { processArtistInquiry, ARTIST_USER_IDS } = require("../services/tattooInquiryService");
const {
  createToken: createFillToken,
  resolveToken: resolveFillToken,
  recordStepProgress: recordFillStepProgress,
  consumeToken: consumeFillToken,
  getPhotoForToken: getFillPhotoForToken,
  FillTokenError,
} = require("../services/fillTokenService");
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
  ARTIST_NAME_TO_ID,
  ARTIST_ASSIGNED_USER_IDS,
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
const {
  determineArtist,
  assignArtistToContact,
} = require("../ai/artistRouter");
const analyticsRoutes = require("../analytics/analyticsRoutes");
const seoRoutes = require("../seo/seoRoutes");
const leadsRoutes = require("../leads/leadsRoutes");
const { startSnapshotCron, startMondayRitualCron } = require("../analytics/snapshotCron");

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
  // Global kill switch — set AI_RESPONSES_ENABLED=false in .env to suspend all AI responses
  if (process.env.AI_RESPONSES_ENABLED === 'false') {
    return { shouldRespond: false, reason: 'ai_suspended_by_env', appendFrontDesk: false };
  }

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

// Sentinel display strings that have historically leaked into artist fields
// (calendar names, "soonest" labels). Treat them as no-artist.
const ARTIST_SENTINELS = new Set(["soonest available", "soonest possible", "soonest_available", "unknown", ""]);

// Resolve a contact to a real GHL artist user ID.
// Priority: contact.assignedTo (GHL CRM owner) → name lookup on assigned_artist/inquired_technician → null.
function resolveArtistUserId(contact) {
  const assignedTo = contact?.assignedTo || contact?.assigned_to || null;
  if (assignedTo && Object.values(ARTIST_ASSIGNED_USER_IDS).includes(assignedTo)) {
    return assignedTo;
  }
  const cf = contact?.customField || contact?.customFields || {};
  for (const candidate of [cf.assigned_artist, cf.inquired_technician]) {
    const raw = String(candidate || "").trim().toLowerCase();
    if (!raw || ARTIST_SENTINELS.has(raw)) continue;
    if (ARTIST_NAME_TO_ID[raw]) return ARTIST_NAME_TO_ID[raw];
    if (raw.includes("joan")) return ARTIST_NAME_TO_ID.joan;
    if (raw.includes("andrew")) return ARTIST_NAME_TO_ID.andrew;
  }
  return null;
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
        'https://studio-az-check-in.onrender.com', // Kiosk check-in app
        'https://studio-az-checkin.vercel.app', // Kiosk check-in (Vercel)
        'https://consent.studioaztattoo.com', // Consent form web app
        'https://refund.studioaztattoo.com', // Refund request form (Phase 6)
        'http://localhost:3003', // Refund form dev (Phase 6)
        'https://pay.studioaztattoo.com', // Short links (Stripe financing)
        'https://checkout.studioaztattoo.com', // Custom checkout page (Square deposits)
        'https://checkout-chi-nine.vercel.app', // Checkout page (Vercel dev)
        'https://rent-tracker-tawny.vercel.app', // Rent tracker production alias
        'https://rent-tracker-studioaz2022s-projects.vercel.app', // Rent tracker fallback alias
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:3002', // Front-desk dashboard (dev)
        'http://localhost:3098', // Front-desk dashboard (local prod-test)
        'http://localhost:8080',
        'http://localhost:8888',
        'http://127.0.0.1:5500', // Common local dev server port
      ];

      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else if (/^https:\/\/rent-tracker-[a-z0-9-]+-studioaz2022s-projects\.vercel\.app$/.test(origin)) {
        // Rent tracker preview/branch deploys
        callback(null, true);
      } else if (/^https:\/\/front-desk-[a-z0-9-]+\.vercel\.app$/.test(origin) ||
                 /^https:\/\/front-desk-[a-z0-9-]+-studioaz2022s-projects\.vercel\.app$/.test(origin)) {
        // Front-desk dashboard production + preview/branch deploys (Vercel)
        callback(null, true);
      } else if (/^https:\/\/refund-form-[a-z0-9-]+\.vercel\.app$/.test(origin) ||
                 /^https:\/\/refund-form-[a-z0-9-]+-studioaz2022s-projects\.vercel\.app$/.test(origin)) {
        // Refund form preview/branch deploys (Vercel)
        callback(null, true);
      } else if (/^http:\/\/(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|localhost)(:\d+)?$/.test(origin)) {
        // Allow any private/local network IP (kiosk, local dev)
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-owner-key', 'x-internal-key'],
  }));

  // Use JSON body parsing for all routes except webhooks that need raw body for signature verification
  app.use((req, res, next) => {
    if (req.path === "/square/webhook" || req.path === "/fireflies/webhook" || req.path === "/stripe/webhook") {
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

  // Raw body for Stripe webhook signature verification
  app.use(
    "/stripe/webhook",
    express.raw({
      type: "application/json",
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

      // Auto-assign artist if no technician preference was specified.
      // Treat legacy sentinel strings (calendar names, "Soonest Available") as no-preference —
      // they're display labels, not real artist selections.
      const inquiredTech = (payload.customFields?.inquired_technician || "").trim();
      const SENTINEL_NO_PREF = new Set(["soonest available", "soonest possible", "soonest_available"]);
      const hasRealPreference = inquiredTech && !SENTINEL_NO_PREF.has(inquiredTech.toLowerCase());
      if (!hasRealPreference) {
        try {
          const freshContact = await getContact(contactId);
          const artist = await determineArtist(freshContact);
          if (artist) {
            await assignArtistToContact(contactId, artist);
            console.log(`🎯 Auto-assigned artist via workload balancing: ${artist}`);
          }
        } catch (routeErr) {
          console.error("⚠️ Artist auto-assign failed (non-fatal):", routeErr.message || routeErr);
        }
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
    // Acknowledge immediately so GHL doesn't retry while we debounce + run AI.
    // The handler awaits a 15s debounce + AI pipeline, which exceeds GHL's webhook
    // timeout and previously caused 5–7 retries per message → duplicate APN sends.
    res.status(200).json({ ok: true, queued: true });

    setImmediate(async () => {
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
        return;
      }

      // ═══ MESSAGE DEBOUNCING ═══
      // Wait for 15 seconds of "quiet" to batch multiple rapid messages
      const batchData = await addToBatch(contactId, messageText, payload);

      // If batchData is null, another request will handle this batch
      if (!batchData) {
        if (!COMPACT_MODE) console.log(`⏭️ [DEBOUNCE] Skipping - batch will be processed by another request`);
        return;
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

      // Detect location from webhook payload to use the correct SDK
      const webhookLocationId = latestPayload?.locationId || latestPayload?.location?.id || null;
      const isBarbershopMessage = webhookLocationId === process.env.GHL_BARBER_LOCATION_ID;

      let contactRaw;
      if (isBarbershopMessage && ghlBarber) {
        try {
          const resp = await ghlBarber.contacts.getContact({ contactId });
          contactRaw = resp?.contact || resp;
        } catch (err) {
          console.error('⚠️ [MSG] Barbershop getContact failed:', err.message);
          contactRaw = null;
        }
      } else {
        contactRaw = await getContact(contactId);
      }

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

      // Barbershop messages: push notification is all we need — skip AI setter + pipeline
      if (isBarbershopMessage) {
        console.log(`💈 [MSG] Barbershop message from ${contactName} — push sent, skipping AI setter`);
        return;
      }

      // ═══ PHASE 0.5: v2 FUNNEL GATE — SHADOW MODE ═══
      // Logs what the v2 location filter + funnel gate WOULD decide. Changes nothing,
      // never awaited (no latency to v1), never throws. Gated by AI_BOT_SHADOW="true".
      runShadowFunnelGate({ payload: latestPayload, contact, contactId, contactName, messageText: combinedMessageText })
        .catch((err) => console.error("🕵️ [SHADOW] unexpected:", err?.message || err));

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

        // Persist lead source on first contact
        let leadSource = channelContext.channelType;
        if (leadSource === "dm") {
          const medium = body?.attributionSource?.medium || "";
          if (medium.toLowerCase().includes("instagram")) leadSource = "instagram";
          else if (medium.toLowerCase().includes("facebook")) leadSource = "facebook";
        }
        await updateSystemFields(contactId, { lead_source: leadSource });
        if (!COMPACT_MODE) console.log(`📍 [LEAD SOURCE] Set lead_source="${leadSource}" for ${contactId}`);
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
        return;
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
    } catch (err) {
      console.error("❌ /ghl/message-webhook error:", err.message || err);
    }
    });
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

          // Persist lead source — widget chat = ai_setter
          await updateSystemFields(contactId, { lead_source: "ai_setter" });
          console.log(`📍 [LEAD SOURCE] Set lead_source="ai_setter" for ${contactId}`);
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
      const rawReferenceId = payment.reference_id || payment.referenceId || null;

      // Square sometimes injects its own customer_id (24-char lowercase hex) into
      // reference_id — that is NOT a GHL contact ID. GHL IDs are mixed-case alphanumeric
      // ~20 chars. Reject pure hex strings so we fall through to order-based lookup.
      const isSquareCustomerId = rawReferenceId && /^[0-9a-f]{24}$/.test(rawReferenceId);
      let contactId = isSquareCustomerId ? null : rawReferenceId;

      // Debug: Log payment structure to understand what we're receiving
      if (!COMPACT_MODE) {
        console.log("💳 [DEBUG] Payment object keys:", Object.keys(payment));
        console.log("💳 [DEBUG] Order ID:", orderId);
        console.log("💳 [DEBUG] Reference ID from payment:", rawReferenceId, isSquareCustomerId ? "(Square customer ID — ignored)" : "");
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

          // Dedup check: if it throws, SKIP the insert (safer than double-recording).
          // Square retries webhooks aggressively; the previous "proceed despite failure"
          // policy turned a single payment into 5 rows when retries raced the dedup check.
          try {
            alreadyProcessed = await isPaymentAlreadyProcessed(payment.id, process.env.GHL_LOCATION_ID);
          } catch (checkErr) {
            console.error(`[Financial] Dedup check failed for payment ${payment.id} — SKIPPING insert to avoid duplicates. err=${checkErr.message}`);
            alreadyProcessed = true;
          }

          if (alreadyProcessed) {
            console.log(`[Financial] Payment ${payment.id} already processed, skipping`);
          } else {
            const assignedArtist = resolveArtistUserId(contact) || 'unknown';
            if (assignedArtist === 'unknown') {
              console.warn(`[Financial] Could not resolve artist user ID for contact ${contactId} — recording as 'unknown'. assignedTo=${contact?.assignedTo} cf.assigned_artist=${cf.assigned_artist} cf.inquired_technician=${cf.inquired_technician}`);
            }
            try {
              await handleSquarePaymentFinancials(payment, contactId, contactName, assignedArtist);
              if (!COMPACT_MODE) {
                console.log(`[Financial] Successfully recorded payment for contact ${contactId}`);
              }
            } catch (insertErr) {
              // Postgres unique-violation (code 23505) means a concurrent webhook beat us to it.
              // That's the desired outcome of the unique index — log and move on.
              if (insertErr?.message?.includes('23505') || /duplicate key/i.test(insertErr?.message || '')) {
                console.log(`[Financial] Payment ${payment.id} race won by concurrent webhook (unique constraint), skipping`);
              } else {
                throw insertErr;
              }
            }
          }

          // Mirror tattoo deposit to InstantDB for rent tracker (non-fatal)
          if (!alreadyProcessed) {
            try {
              const { writeServiceIncome } = require("../rentTracker/serviceIncomeWriter");
              const { weekOfDate } = require("../rentTracker/tenantMatcher");
              await writeServiceIncome({
                senderName: contactName,
                amount: amount / 100,
                method: "square",
                type: "deposit",
                paidAt: new Date(),
                notes: `Tattoo deposit`,
                squarePaymentId: payment.id,
                weekOf: weekOfDate(new Date()),
                location: "tattoo",
                tipAmount: 0,
                servicePriceAmount: amount / 100,
              });
            } catch (instantErr) {
              console.warn("[SquareWebhook] InstantDB write failed (non-fatal):", instantErr.message);
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
        const assignedArtist = resolveArtistUserId(contact);
        await notifyDepositPaid(contactId, {
          amount,
          paymentId,
          artistId: assignedArtist,
          consultationType,
        });

        // === PUSH NOTIFICATION: Deposit paid ===
        try {
          const { sendPaymentReceivedNotification } = require("../services/paymentNotifications");
          const contactDisplayName = contact?.contactName || contact?.firstName || "Client";
          await sendPaymentReceivedNotification({
            artistGhlUserId: assignedArtist,
            contactName: contactDisplayName,
            amount: amount / 100,
            paymentMethod: "square",
            contactId,
          });
        } catch (pushErr) {
          console.warn("⚠️ Deposit push notification failed (non-fatal):", pushErr.message);
        }

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

      const parsedGross = parseFloat(grossAmount);
      const parsedTip = tipAmount != null ? parseFloat(tipAmount) : null;
      const parsedServicePrice = servicePrice != null ? parseFloat(servicePrice) : null;
      const txLocationId = locationId || process.env.GHL_LOCATION_ID || 'studio_az_tattoo';
      const txSessionDate = sessionDate ? new Date(sessionDate) : new Date();

      const transaction = await recordTransaction({
        contactId,
        contactName: contactName || 'Unknown',
        appointmentId,
        artistId,
        transactionType,
        paymentMethod,
        paymentRecipient: paymentRecipient || 'shop',
        grossAmount: parsedGross,
        sessionDate: txSessionDate,
        squarePaymentId: null,
        locationId: txLocationId,
        notes,
        tipAmount: parsedTip,
        servicePrice: parsedServicePrice,
      });

      // Mirror to InstantDB for rent tracker (non-fatal)
      try {
        const { writeServiceIncome } = require("../rentTracker/serviceIncomeWriter");
        const { weekOfDate } = require("../rentTracker/tenantMatcher");

        let incomeType = "service";
        if (transactionType === "deposit") incomeType = "deposit";
        else if (transactionType === "product_sale") incomeType = "product_sale";

        await writeServiceIncome({
          senderName: contactName || "Unknown",
          amount: parsedGross,
          method: paymentMethod,
          type: incomeType,
          paidAt: txSessionDate,
          notes: notes || null,
          weekOf: weekOfDate(txSessionDate),
          location: txLocationId === "mUemx2jG4wly4kJWBkI4" ? "tattoo" : "barbershop",
          tipAmount: parsedTip || 0,
          servicePriceAmount: parsedServicePrice || undefined,
          barberGhlId: artistId,
        });
      } catch (err) {
        console.warn(`[API] InstantDB mirror failed (non-fatal): ${err.message}`);
      }

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

  // ────────────────────────────────────────────────────────────────────────
  // Phase 7g · Artist Edit / Undo / Restore for manually-logged payments
  // ────────────────────────────────────────────────────────────────────────
  //
  // Two restrictions enforced here:
  //   1. payment_recipient must be "artist_direct" (cash/Venmo/Zelle in
  //      hand). Square/Stripe rows are sourced from external systems and
  //      must NOT be edited or undone — that would break audit trail with
  //      the upstream provider.
  //   2. The transaction must NOT be in a settled reconciliation. The chain
  //      is contact_id → project_completion → reconciliation. If the
  //      contact has a project_completion linked to a settled reconciliation,
  //      the row is locked (409 Conflict).
  //
  // Audit trail behavior:
  //   - artist-edit creates a new row and stamps superseded_by on the old
  //     row. The old row stays in the database forever.
  //   - artist-undo soft-deletes via deleted_at. Restorable via artist-restore.
  //   - artist-restore clears deleted_at (undo-the-undo).
  //
  // Read endpoints (payment-history, financial-summary, earnings, tax-export,
  // outstanding-contacts) all filter `superseded_by IS NULL AND deleted_at
  // IS NULL` so the visible ledger never shows a row that's been replaced or
  // undone, but the full history is preserved for audit.

  /**
   * Shared guard. Returns { ok: bool, status?: int, error?: string, tx?: row }.
   * If ok=false, caller should res.status(status).json({success:false,error}).
   */
  async function loadArtistEditableTransaction(transactionId) {
    if (!supabase) {
      return { ok: false, status: 503, error: "Supabase not configured" };
    }
    const { data: tx, error } = await supabase
      .from("transactions")
      .select("*")
      .eq("id", transactionId)
      .maybeSingle();
    if (error) return { ok: false, status: 500, error: error.message };
    if (!tx) return { ok: false, status: 404, error: "Transaction not found" };

    // Restriction 1: must be artist_direct (manually logged)
    if (tx.payment_recipient !== "artist_direct") {
      return {
        ok: false,
        status: 409,
        error: "Only manually-logged payments (cash, Venmo, Zelle) can be edited or undone.",
      };
    }

    // Restriction 2: must not be already superseded or deleted
    if (tx.superseded_by) {
      return { ok: false, status: 409, error: "This row has already been edited." };
    }
    if (tx.deleted_at) {
      return { ok: false, status: 409, error: "This row has already been undone." };
    }

    // Restriction 3: must not be in a settled reconciliation
    if (tx.contact_id && tx.artist_ghl_id) {
      const { data: completion } = await supabase
        .from("project_completions")
        .select("id, reconciliation_id")
        .eq("contact_id", tx.contact_id)
        .eq("artist_ghl_id", tx.artist_ghl_id)
        .maybeSingle();
      if (completion?.reconciliation_id) {
        const { data: recon } = await supabase
          .from("reconciliations")
          .select("status")
          .eq("id", completion.reconciliation_id)
          .maybeSingle();
        if (recon?.status === "settled") {
          return {
            ok: false,
            status: 409,
            error: "This payment is part of a settled week and is locked. Only Lionel can adjust settled rows from Supabase.",
          };
        }
      }
    }

    return { ok: true, tx };
  }

  /**
   * PATCH /api/transactions/:id/artist-edit
   *
   * Inserts a new transaction with the edited values, marks the old row
   * as superseded. Body accepts any subset of:
   *   { grossAmount, paymentMethod, sessionDate, notes }
   * (other fields are copied from the original row).
   *
   * Response: { success, transaction: <new row>, supersededId: <old id> }
   */
  app.patch("/api/transactions/:id/artist-edit", async (req, res) => {
    try {
      const { id } = req.params;
      const guard = await loadArtistEditableTransaction(id);
      if (!guard.ok) {
        return res.status(guard.status).json({ success: false, error: guard.error });
      }
      const original = guard.tx;
      const { grossAmount, paymentMethod, sessionDate, notes } = req.body || {};

      const newGross = grossAmount != null ? parseFloat(grossAmount) : Number(original.gross_amount);
      if (!Number.isFinite(newGross) || newGross <= 0) {
        return res.status(400).json({ success: false, error: "Invalid grossAmount" });
      }
      const newMethod = paymentMethod || original.payment_method;
      const newSessionDate = sessionDate ? new Date(sessionDate) : new Date(original.session_date);
      const newNotes = notes !== undefined ? notes : original.notes;

      // Recompute shop/artist split using the snapshotted percentages from the
      // original row (the rate that was in force when the work was done). This
      // matches the math engine's "snapshot at completion" rule.
      const shopPct = Number(original.shop_percentage ?? 30);
      const artistPct = Number(original.artist_percentage ?? 70);
      const newShopAmount = +(newGross * (shopPct / 100)).toFixed(2);
      const newArtistAmount = +(newGross * (artistPct / 100)).toFixed(2);

      // Insert the replacement row.
      const replacementPayload = {
        contact_id: original.contact_id,
        contact_name: original.contact_name,
        appointment_id: original.appointment_id,
        artist_ghl_id: original.artist_ghl_id,
        transaction_type: original.transaction_type,
        payment_method: newMethod,
        payment_recipient: "artist_direct",
        gross_amount: newGross,
        tip_amount: original.tip_amount,
        service_price: original.service_price,
        shop_amount: newShopAmount,
        artist_amount: newArtistAmount,
        shop_percentage: shopPct,
        artist_percentage: artistPct,
        session_date: newSessionDate.toISOString(),
        notes: newNotes,
        location_id: original.location_id,
        // Square / Venmo external IDs deliberately not copied — the new row
        // is the artist's record, not a re-mirror of the external payment.
      };

      const { data: newTx, error: insertErr } = await supabase
        .from("transactions")
        .insert(replacementPayload)
        .select()
        .single();
      if (insertErr) {
        return res.status(500).json({ success: false, error: insertErr.message });
      }

      // Stamp the original as superseded.
      const { error: updateErr } = await supabase
        .from("transactions")
        .update({ superseded_by: newTx.id })
        .eq("id", id);
      if (updateErr) {
        // Best-effort rollback of the insert
        await supabase.from("transactions").delete().eq("id", newTx.id);
        return res.status(500).json({ success: false, error: updateErr.message });
      }

      console.log(`[Phase7g] artist-edit ${id} → ${newTx.id} (gross ${original.gross_amount} → ${newGross})`);
      res.json({ success: true, transaction: newTx, supersededId: id });
    } catch (error) {
      console.error("[Phase7g] artist-edit error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * POST /api/transactions/:id/artist-undo
   *
   * Soft-deletes the row by setting deleted_at = now(). Idempotent — second
   * call no-ops. Restorable via /artist-restore.
   *
   * Response: { success, transactionId, deletedAt }
   */
  app.post("/api/transactions/:id/artist-undo", async (req, res) => {
    try {
      const { id } = req.params;
      const guard = await loadArtistEditableTransaction(id);
      if (!guard.ok) {
        return res.status(guard.status).json({ success: false, error: guard.error });
      }
      const now = new Date().toISOString();
      const { error } = await supabase
        .from("transactions")
        .update({ deleted_at: now })
        .eq("id", id);
      if (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
      console.log(`[Phase7g] artist-undo ${id}`);
      res.json({ success: true, transactionId: id, deletedAt: now });
    } catch (error) {
      console.error("[Phase7g] artist-undo error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * POST /api/transactions/:id/artist-restore
   *
   * Clears deleted_at, restoring the row to the visible ledger. Used by the
   * iOS "Just undone — Restore" 5-second toast. No-op if the row isn't
   * currently soft-deleted.
   *
   * Same artist_direct + not-settled guards apply (the row could have been
   * pulled into a reconciliation while the toast was on screen, however
   * unlikely — guard handles it).
   *
   * Response: { success, transactionId }
   */
  app.post("/api/transactions/:id/artist-restore", async (req, res) => {
    try {
      const { id } = req.params;
      if (!supabase) {
        return res.status(503).json({ success: false, error: "Supabase not configured" });
      }
      // We can't use the shared guard here because the row IS soft-deleted
      // (deleted_at set). Inline the artist_direct + settled checks instead.
      const { data: tx, error: fetchErr } = await supabase
        .from("transactions")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (fetchErr) return res.status(500).json({ success: false, error: fetchErr.message });
      if (!tx) return res.status(404).json({ success: false, error: "Transaction not found" });
      if (tx.payment_recipient !== "artist_direct") {
        return res.status(409).json({
          success: false,
          error: "Only manually-logged payments can be restored.",
        });
      }
      if (tx.superseded_by) {
        return res.status(409).json({
          success: false,
          error: "This row was edited, not undone. Cannot restore an edited row.",
        });
      }
      if (!tx.deleted_at) {
        // Already restored / never deleted — idempotent
        return res.json({ success: true, transactionId: id, alreadyRestored: true });
      }
      // Settled-row check
      if (tx.contact_id && tx.artist_ghl_id) {
        const { data: completion } = await supabase
          .from("project_completions")
          .select("reconciliation_id")
          .eq("contact_id", tx.contact_id)
          .eq("artist_ghl_id", tx.artist_ghl_id)
          .maybeSingle();
        if (completion?.reconciliation_id) {
          const { data: recon } = await supabase
            .from("reconciliations")
            .select("status")
            .eq("id", completion.reconciliation_id)
            .maybeSingle();
          if (recon?.status === "settled") {
            return res.status(409).json({
              success: false,
              error: "This contact's project has been settled in the meantime. Cannot restore.",
            });
          }
        }
      }

      const { error } = await supabase
        .from("transactions")
        .update({ deleted_at: null })
        .eq("id", id);
      if (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
      console.log(`[Phase7g] artist-restore ${id}`);
      res.json({ success: true, transactionId: id });
    } catch (error) {
      console.error("[Phase7g] artist-restore error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // GET /api/contacts/:contactId/payment-history - Full ledger for contact profile
  // Returns quote amount + all transactions + tips + computed totals
  app.get("/api/contacts/:contactId/payment-history", async (req, res) => {
    try {
      if (!supabase) {
        return res.status(503).json({
          success: false,
          error: "Financial tracking not available"
        });
      }

      const { contactId } = req.params;
      if (!contactId) {
        return res.status(400).json({ success: false, error: "Missing contactId" });
      }

      // 1. Fetch all transactions for this contact.
      // Phase 7g — filter out superseded (edited) and soft-deleted rows so
      // the visible ledger never shows a row that's been replaced or undone.
      const { data: rawTransactions, error: txError } = await supabase
        .from("transactions")
        .select("id, transaction_type, payment_method, payment_recipient, gross_amount, tip_amount, session_date, notes, superseded_by, deleted_at")
        .eq("contact_id", contactId)
        .is("superseded_by", null)
        .is("deleted_at", null)
        .order("session_date", { ascending: true });

      if (txError) {
        console.error(`[PaymentHistory] Error fetching transactions:`, txError);
        return res.status(500).json({ success: false, error: txError.message });
      }

      const transactions = rawTransactions || [];

      // 2. Fetch quote amount from GHL contact custom fields.
      // The normalized customField object is keyed by GHL field ID, not field name —
      // so we look up by ID. Source of truth is FINAL_PRICE (signed consent-form contract);
      // fall back to deprecated QUOTED for legacy contacts pre-consent-form.
      let quoteAmount = null;
      try {
        const contact = await getContact(contactId);
        const cf = contact?.customField || {};
        const rawQuote = cf[GHL_CUSTOM_FIELD_IDS.FINAL_PRICE] ?? cf[GHL_CUSTOM_FIELD_IDS.QUOTED];
        if (rawQuote != null && rawQuote !== "") {
          const parsed = parseFloat(String(rawQuote).replace(/[^0-9.]/g, ""));
          if (!isNaN(parsed) && parsed > 0) quoteAmount = parsed;
        }
      } catch (ghlErr) {
        console.warn(`[PaymentHistory] Could not fetch GHL quote: ${ghlErr.message}`);
      }

      // 3. Split into payments vs tips
      // Tips: any transaction with a non-zero tip_amount
      // Payments: everything else (including the service_price portion of tipped transactions)
      const paymentLines = [];
      const tipLines = [];

      for (const tx of transactions) {
        const txDate = tx.session_date || new Date().toISOString();
        const method = tx.payment_method || "unknown";
        const methodLabel = formatMethodLabel(method);
        const isRefund = (tx.transaction_type || "").toLowerCase().includes("refund")
          || (tx.gross_amount || 0) < 0;
        const gross = Math.abs(tx.gross_amount || 0);
        const tip = tx.tip_amount || 0;
        const servicePortion = tip > 0 ? gross - tip : gross;

        // Parse merchant fee from notes (format: "(incl. $64 financing fee → shop)")
        let merchantFee = 0;
        const notes = tx.notes || "";
        const feeMatch = notes.match(/\(incl\. \$?([\d.]+) financing fee/);
        if (feeMatch) {
          merchantFee = parseFloat(feeMatch[1]) || 0;
        }

        // The "collected" amount for display is what the client actually paid
        // For stripe financing, that's gross + merchant fee (shop's share from the fee)
        // For deposits, that's just gross
        // For tipped transactions, we display the service portion (tips shown separately)
        let collectedAmount = servicePortion;
        if (method.startsWith("stripe_") && merchantFee > 0) {
          collectedAmount = servicePortion + merchantFee;
        }

        if (servicePortion > 0 || merchantFee > 0) {
          paymentLines.push({
            id: tx.id,
            transactionType: tx.transaction_type || "session_payment",
            paymentMethod: method,
            methodLabel,
            // Phase 7g — iOS uses paymentRecipient + isManual to decide
            // whether the long-press Edit/Undo menu should be available.
            paymentRecipient: tx.payment_recipient || null,
            isManual: tx.payment_recipient === "artist_direct",
            collectedAmount,
            merchantFee,
            sessionDate: txDate,
            isRefund,
            notes: tx.notes || null,
          });
        }

        if (tip > 0 && !isRefund) {
          tipLines.push({
            id: `${tx.id}_tip`,
            amount: tip,
            sessionDate: txDate,
            method,
          });
        }
      }

      // 4. Compute totals
      const collected = paymentLines.reduce((sum, p) => {
        return sum + (p.isRefund ? -p.collectedAmount : p.collectedAmount);
      }, 0);
      const totalTips = tipLines.reduce((sum, t) => sum + t.amount, 0);
      const remainingBalance = quoteAmount != null ? quoteAmount - collected : null;

      // 5. Phase 7a — Project completion + settlement state for the Settled
      // pill. Chain: project_completions(contact_id) -> reconciliations.id ->
      // status. We pick the row for the LATEST artist if multiple completions
      // exist for the contact (multi-artist contacts are rare but supported).
      let projectCompletion = null; // { id, artistGhlId, completedAt, reconciliationId }
      let settlement = null;       // { settled: bool, settledAt, reconciliationId, weekStart, weekEnd }
      try {
        const { data: completions } = await supabase
          .from("project_completions")
          .select("id, artist_ghl_id, completed_at, reconciliation_id")
          .eq("contact_id", contactId)
          .order("completed_at", { ascending: false });
        const latest = (completions || [])[0];
        if (latest) {
          projectCompletion = {
            id: latest.id,
            artistGhlId: latest.artist_ghl_id,
            completedAt: latest.completed_at,
            reconciliationId: latest.reconciliation_id,
          };
          if (latest.reconciliation_id) {
            const { data: r } = await supabase
              .from("reconciliations")
              .select("id, status, settled_at, week_start, week_end")
              .eq("id", latest.reconciliation_id)
              .maybeSingle();
            if (r) {
              settlement = {
                settled: r.status === "settled",
                settledAt: r.settled_at,
                reconciliationId: r.id,
                weekStart: r.week_start,
                weekEnd: r.week_end,
              };
            }
          }
        }
      } catch (settleErr) {
        console.warn(`[PaymentHistory] settlement lookup failed: ${settleErr.message}`);
      }

      res.json({
        success: true,
        quoteAmount,
        transactions: paymentLines,
        tips: tipLines,
        collected: parseFloat(collected.toFixed(2)),
        totalTips: parseFloat(totalTips.toFixed(2)),
        remainingBalance: remainingBalance != null ? parseFloat(remainingBalance.toFixed(2)) : null,
        // Phase 7a/7b additions — non-breaking; older clients ignore the new fields
        projectCompletion,
        settlement,
      });
    } catch (err) {
      console.error(`[PaymentHistory] Error:`, err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Helper: friendly label for payment method
  function formatMethodLabel(method) {
    if (!method) return "Unknown";
    if (method === "square") return "Square";
    if (method === "venmo") return "Venmo";
    if (method === "cash") return "Cash";
    if (method === "stripe_affirm") return "Affirm";
    if (method === "stripe_klarna") return "Klarna";
    if (method === "stripe_card") return "Card";
    return method.replace("stripe_", "").replace(/^./, c => c.toUpperCase());
  }

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
        .eq('artist_ghl_id', artistId)
        .is('superseded_by', null) // Phase 7g
        .is('deleted_at', null);   // Phase 7g

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
        if (tx.transaction_type === 'session_payment') {
          if (tx.appointment_id) {
            c.appointment_ids.add(tx.appointment_id);
          } else {
            // No appointment_id (walk-in etc.) — count as separate session
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

  // ────────────────────────────────────────────────────────────────────────
  // Phase 1 · Reconciliation engine
  // See TATTOO_FINANCE_PLAN.md and src/services/reconciliationService.js
  // ────────────────────────────────────────────────────────────────────────
  const {
    computeContactReconciliation,
    computeWeeklyReconciliation,
    generateVenmoCode,
  } = require("../services/reconciliationService");
  const { getWeekStart, getWeekEnd } = require("../utils/dateUtils");

  // GET /api/artists/:artistId/outstanding-contacts
  // Phase 3 — drives the "Outstanding from Clients" section of the Finance tab.
  // For every contact this artist has transactions on, compute outstanding =
  // final_price - collected. Filter to outstanding > 0 (or quote === null with
  // any collected, treated as "no quote yet" and excluded). Returns sorted by
  // largest outstanding. Each row includes amendmentCount so the iOS row can
  // render the AMENDED pill without a follow-up call.
  app.get("/api/artists/:artistId/outstanding-contacts", async (req, res) => {
    try {
      const { artistId } = req.params;
      if (!supabase) {
        return res.status(503).json({ success: false, error: "Supabase not configured" });
      }

      // 1. Fetch all transactions for this artist (group by contact later).
      // Phase 7g — exclude superseded + soft-deleted rows.
      const { data: txs, error: txErr } = await supabase
        .from("transactions")
        .select("contact_id, contact_name, gross_amount, shop_amount, artist_amount, shop_percentage, payment_recipient, transaction_type")
        .eq("artist_ghl_id", artistId)
        .is("superseded_by", null)
        .is("deleted_at", null);
      if (txErr) {
        return res.status(500).json({ success: false, error: txErr.message });
      }

      // Group transactions by contact
      const byContact = {};
      for (const tx of txs || []) {
        if (!tx.contact_id || tx.contact_id === "walk_in") continue;
        if (!byContact[tx.contact_id]) {
          byContact[tx.contact_id] = { contactName: tx.contact_name || "", transactions: [] };
        }
        byContact[tx.contact_id].transactions.push(tx);
        if (!byContact[tx.contact_id].contactName && tx.contact_name) {
          byContact[tx.contact_id].contactName = tx.contact_name;
        }
      }

      const contactIds = Object.keys(byContact);
      if (contactIds.length === 0) {
        return res.json({ success: true, outstandingContacts: [], totalOutstanding: 0 });
      }

      // 2. Batch-fetch GHL contacts (final_price, contact name) — concurrency capped
      const { getContactsBatch } = require("../clients/ghlClient");
      const contactMap = await getContactsBatch(contactIds, { concurrency: 5 });

      // 3. Batch-fetch amendment counts per contact (single query).
      // Phase 4 fold-in: only count amendments where status='completed' so the
      // AMENDED pill represents an actual contract change, not a sent-but-unsigned
      // amendment. Matches Phase 4's inline indicator semantics for consistency.
      const amendmentCounts = {};
      try {
        const { data: amendmentRows, error: amendErr } = await supabase
          .from("consent_amendments")
          .select("contact_id")
          .in("contact_id", contactIds)
          .eq("status", "completed");
        if (!amendErr && amendmentRows) {
          for (const row of amendmentRows) {
            amendmentCounts[row.contact_id] = (amendmentCounts[row.contact_id] || 0) + 1;
          }
        }
      } catch (e) {
        console.warn(`[Outstanding] amendment count fetch failed (non-fatal): ${e.message}`);
      }

      // 4. For each contact, compute reconciliation and emit row if outstanding > 0
      const rows = [];
      for (const [contactId, info] of Object.entries(byContact)) {
        const ghlContact = contactMap[contactId];
        const cf = ghlContact?.customField || {};
        const rawQuote = cf[GHL_CUSTOM_FIELD_IDS.FINAL_PRICE] ?? cf[GHL_CUSTOM_FIELD_IDS.QUOTED];
        let quote = null;
        if (rawQuote != null && rawQuote !== "") {
          const parsed = parseFloat(String(rawQuote).replace(/[^0-9.]/g, ""));
          if (Number.isFinite(parsed) && parsed > 0) quote = parsed;
        }

        // Skip contacts without a quote — outstanding is undefined
        if (quote == null) continue;

        // Use the rate snapshotted on the most-recent transaction (matches Phase 1 financial-summary)
        let shopPercentage = 30;
        const latestTx = info.transactions[info.transactions.length - 1];
        if (latestTx && latestTx.shop_percentage != null) {
          shopPercentage = Number(latestTx.shop_percentage);
        }

        const summary = computeContactReconciliation({
          quote,
          shopPercentage,
          transactions: info.transactions,
        });

        if (summary.outstanding == null || summary.outstanding <= 0) continue;

        // Resolve name: prefer GHL, fall back to denormalized contact_name
        const resolvedName =
          ghlContact?.contactName ||
          (ghlContact ? `${ghlContact.firstName || ""} ${ghlContact.lastName || ""}`.trim() : "") ||
          info.contactName ||
          "Unknown";

        rows.push({
          contactId,
          contactName: resolvedName,
          quote: summary.quote,
          collected: summary.collected,
          outstanding: summary.outstanding,
          isFullyPaid: summary.isFullyPaid,
          amendmentCount: amendmentCounts[contactId] || 0,
        });
      }

      // 5. Sort largest outstanding first
      rows.sort((a, b) => b.outstanding - a.outstanding);

      const totalOutstanding = rows.reduce((sum, r) => sum + r.outstanding, 0);

      res.json({
        success: true,
        outstandingContacts: rows,
        totalOutstanding: Math.round(totalOutstanding * 100) / 100,
        count: rows.length,
      });
    } catch (error) {
      console.error("[Outstanding] error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Internal helper: fetch the contract quote (final_price) for a contact.
  // Returns a number in dollars, or null if not set.
  async function fetchContractQuote(contactId) {
    try {
      const contact = await getContact(contactId);
      const cf = contact?.customField || {};
      const raw = cf[GHL_CUSTOM_FIELD_IDS.FINAL_PRICE] ?? cf[GHL_CUSTOM_FIELD_IDS.QUOTED];
      if (raw == null || raw === "") return null;
      const n = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch (err) {
      console.warn(`[Reconciliation] could not fetch quote for ${contactId}: ${err.message}`);
      return null;
    }
  }

  // Internal helper: look up an artist's display name + current commission rate.
  async function fetchArtistContext(artistGhlId, locationId) {
    let artistName = null;
    let shopPercentage = 30; // policy default
    if (!supabase) return { artistName, shopPercentage };
    const { data } = await supabase
      .from("artist_commission_rates")
      .select("artist_name, shop_percentage, artist_percentage")
      .eq("artist_ghl_id", artistGhlId)
      .eq("location_id", locationId)
      .is("effective_to", null)
      .maybeSingle();
    if (data) {
      artistName = data.artist_name;
      shopPercentage = Number(data.shop_percentage);
    }
    return { artistName, shopPercentage };
  }

  // Internal helper: enrich project_completions rows (which only store
  // contact_id) with contact_name pulled from GHL. Batches concurrent fetches
  // and de-dupes contactIds so each contact is hit at most once per call.
  // Falls back gracefully — if GHL fetch fails, leaves contact_name unset
  // and the downstream "Unknown Client" fallback kicks in.
  async function withContactNames(completions) {
    const list = completions || [];
    if (list.length === 0) return list;
    const uniqueIds = Array.from(new Set(list.map((c) => c.contact_id).filter(Boolean)));
    const nameById = {};
    await Promise.all(
      uniqueIds.map(async (id) => {
        try {
          const c = await getContact(id);
          const name = [c?.firstName, c?.lastName].filter(Boolean).join(" ").trim()
            || c?.contactName
            || c?.fullName
            || null;
          if (name) nameById[id] = name;
        } catch (_) {
          // Swallow — downstream falls back to "Unknown Client".
        }
      })
    );
    return list.map((c) => (
      nameById[c.contact_id] ? { ...c, contact_name: nameById[c.contact_id] } : c
    ));
  }

  // GET /api/contacts/:contactId/financial-summary
  // Returns the per-contact reconciliation snapshot used by the contact ledger.
  app.get("/api/contacts/:contactId/financial-summary", async (req, res) => {
    try {
      const { contactId } = req.params;
      if (!supabase) {
        return res.status(503).json({ success: false, error: "Supabase not configured" });
      }

      const [quote, { data: txs, error: txErr }] = await Promise.all([
        fetchContractQuote(contactId),
        supabase
          .from("transactions")
          .select("*")
          .eq("contact_id", contactId)
          .is("superseded_by", null) // Phase 7g — exclude edited rows
          .is("deleted_at", null)    // Phase 7g — exclude soft-deleted rows
          .order("session_date", { ascending: true }),
      ]);
      if (txErr) {
        return res.status(500).json({ success: false, error: txErr.message });
      }

      // Use the rate snapshotted on the most recent transaction (matches what
      // was in force when the work was actually done). Fall back to 30 if no
      // transactions yet.
      let shopPercentage = 30;
      const latestTx = (txs || []).slice(-1)[0];
      if (latestTx && latestTx.shop_percentage != null) {
        shopPercentage = Number(latestTx.shop_percentage);
      }

      const summary = computeContactReconciliation({
        quote,
        shopPercentage,
        transactions: txs || [],
      });

      // Check whether this contact has been marked complete by any artist.
      const { data: completions } = await supabase
        .from("project_completions")
        .select("artist_ghl_id, completed_at, reconciliation_id")
        .eq("contact_id", contactId);

      res.json({
        success: true,
        contactId,
        ...summary,
        isComplete: (completions || []).length > 0,
        completions: completions || [],
        transactions: txs || [],
      });
    } catch (error) {
      console.error("[Reconciliation] financial-summary error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/contacts/:contactId/mark-complete
  // Marks a project complete for the given artist; snapshots quote + collected.
  app.post("/api/contacts/:contactId/mark-complete", async (req, res) => {
    try {
      const { contactId } = req.params;
      const { artistGhlId, completedBy } = req.body || {};
      if (!artistGhlId) {
        return res.status(400).json({ success: false, error: "artistGhlId required" });
      }
      if (!supabase) {
        return res.status(503).json({ success: false, error: "Supabase not configured" });
      }

      const locationId = process.env.GHL_LOCATION_ID;
      const [quote, { data: txs, error: txErr }, { shopPercentage }] = await Promise.all([
        fetchContractQuote(contactId),
        supabase
          .from("transactions")
          .select("*")
          .eq("contact_id", contactId)
          .eq("artist_ghl_id", artistGhlId)
          // Phase 7g — exclude soft-deleted (artist-undo) and edited (superseded)
          // rows. Without this, mark-complete would snapshot the full historical
          // sum including rows the artist already retracted.
          .is("superseded_by", null)
          .is("deleted_at", null),
        fetchArtistContext(artistGhlId, locationId),
      ]);
      if (txErr) return res.status(500).json({ success: false, error: txErr.message });

      const summary = computeContactReconciliation({
        quote,
        shopPercentage,
        transactions: txs || [],
      });

      if (quote == null) {
        return res.status(400).json({
          success: false,
          error: "Contact has no final_price; cannot reconcile a project without a contract quote.",
        });
      }

      const row = {
        contact_id: contactId,
        artist_ghl_id: artistGhlId,
        completed_by: completedBy || null,
        quote_at_completion: summary.quote,
        collected_at_completion: summary.collected,
        net_to_artist: summary.netToArtist,
        shop_percentage_at_completion: summary.shopPercentage,
        artist_percentage_at_completion: summary.artistPercentage,
      };

      // Idempotent insert: unique (contact_id, artist_ghl_id).
      const { data, error } = await supabase
        .from("project_completions")
        .upsert(row, { onConflict: "contact_id,artist_ghl_id" })
        .select()
        .single();

      if (error) return res.status(500).json({ success: false, error: error.message });
      res.json({ success: true, completion: data, summary });
    } catch (error) {
      console.error("[Reconciliation] mark-complete error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // DELETE /api/contacts/:contactId/mark-complete?artistGhlId=...
  // Reopen a completed project. Refuses if already settled.
  app.delete("/api/contacts/:contactId/mark-complete", async (req, res) => {
    try {
      const { contactId } = req.params;
      const artistGhlId = req.query.artistGhlId;
      if (!artistGhlId) {
        return res.status(400).json({ success: false, error: "artistGhlId required" });
      }
      if (!supabase) {
        return res.status(503).json({ success: false, error: "Supabase not configured" });
      }

      const { data: existing } = await supabase
        .from("project_completions")
        .select("id, reconciliation_id")
        .eq("contact_id", contactId)
        .eq("artist_ghl_id", artistGhlId)
        .maybeSingle();

      if (!existing) {
        return res.status(404).json({ success: false, error: "Not marked complete" });
      }
      if (existing.reconciliation_id) {
        return res.status(409).json({
          success: false,
          error: "Already settled in a reconciliation; cannot reopen automatically.",
        });
      }

      const { error } = await supabase.from("project_completions").delete().eq("id", existing.id);
      if (error) return res.status(500).json({ success: false, error: error.message });
      res.json({ success: true, reopened: true });
    } catch (error) {
      console.error("[Reconciliation] reopen error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // GET /api/artists/:artistId/reconciliation/current
  // Pending reconciliation for the current week (Mon-Sun, America/Chicago).
  app.get("/api/artists/:artistId/reconciliation/current", async (req, res) => {
    try {
      const { artistId } = req.params;
      if (!supabase) {
        return res.status(503).json({ success: false, error: "Supabase not configured" });
      }

      const now = new Date();
      const weekStart = getWeekStart(now);
      const weekEnd = getWeekEnd(now);
      const locationId = process.env.GHL_LOCATION_ID;
      const { artistName } = await fetchArtistContext(artistId, locationId);

      // Phase 5 — pending row may already exist for this (artist, week_start).
      // We pull completions in two passes so the running total stays accurate
      // even after the row is eager-created mid-week:
      //   pass 1: completions linked to an existing PENDING row for this week
      //   pass 2: unsettled completions (reconciliation_id IS NULL) in this week
      // The two sets are disjoint (FK is set when linking, NULL otherwise).
      const { toShopDateString } = require("../utils/dateUtils");
      const weekStartStr = toShopDateString(weekStart);

      const { data: existingRecon } = await supabase
        .from("reconciliations")
        .select("id, status, settled_at")
        .eq("artist_ghl_id", artistId)
        .eq("week_start", weekStartStr)
        .maybeSingle();

      const linkedCompletions = existingRecon
        ? (
            await supabase
              .from("project_completions")
              .select("*")
              .eq("artist_ghl_id", artistId)
              .eq("reconciliation_id", existingRecon.id)
              .order("completed_at", { ascending: true })
          ).data || []
        : [];

      const { data: unlinkedCompletions, error: unlinkedErr } = await supabase
        .from("project_completions")
        .select("*")
        .eq("artist_ghl_id", artistId)
        .is("reconciliation_id", null)
        .gte("completed_at", weekStart.toISOString())
        .lte("completed_at", weekEnd.toISOString())
        .order("completed_at", { ascending: true });
      if (unlinkedErr) return res.status(500).json({ success: false, error: unlinkedErr.message });

      const completions = await withContactNames([
        ...linkedCompletions,
        ...(unlinkedCompletions || []),
      ]);

      const result = computeWeeklyReconciliation({
        artistGhlId: artistId,
        artistName: artistName || artistId,
        weekStart,
        weekEnd,
        completions,
      });

      // Phase 5 — Eager-create or update the pending reconciliations row so:
      //   (a) Phase 3's "Mark Settled" button has a real id to settle, and
      //   (b) when Lionel sends a Venmo with [a:XXXNNNN], the parser finds
      //       a row to settle against immediately.
      //
      // Only create if there are completions AND direction != "settled"
      // (a zero-net week shouldn't generate a phantom row).
      let reconciliationId = existingRecon?.id || null;
      let status = existingRecon?.status || "pending";

      if (result.projectCount > 0 && result.direction !== "settled") {
        if (existingRecon) {
          // Refresh totals on the existing PENDING row (idempotent for SETTLED).
          if (existingRecon.status === "pending") {
            await supabase
              .from("reconciliations")
              .update({
                net_amount: result.netAmount,
                direction: result.direction,
                venmo_note: result.venmoNote,
                project_count: result.projectCount,
              })
              .eq("id", existingRecon.id);
          }
        } else {
          // Insert new pending row. UNIQUE(venmo_code) collision retried with -2 suffix.
          const insertPayload = {
            artist_ghl_id: artistId,
            week_start: result.weekStart,
            week_end: result.weekEnd,
            net_amount: result.netAmount,
            direction: result.direction,
            status: "pending",
            venmo_code: result.venmoCode,
            venmo_note: result.venmoNote,
            project_count: result.projectCount,
          };
          const { data: inserted, error: insertErr } = await supabase
            .from("reconciliations")
            .insert(insertPayload)
            .select("id")
            .maybeSingle();

          if (insertErr) {
            if (String(insertErr.message || "").toLowerCase().includes("unique")) {
              const retryCode = `${result.venmoCode}-2`;
              const { data: retryInserted } = await supabase
                .from("reconciliations")
                .insert({ ...insertPayload, venmo_code: retryCode })
                .select("id")
                .maybeSingle();
              reconciliationId = retryInserted?.id || null;
            } else {
              console.error("[Reconciliation] eager insert failed:", insertErr.message);
            }
          } else {
            reconciliationId = inserted?.id || null;
          }

          // Link the unsettled completions we just rolled into this row so we
          // don't double-count on the next /current call. Linked completions
          // continue to be included via pass-1 above, so subsequent additions
          // (new projects completed this week) still aggregate correctly.
          if (reconciliationId && unlinkedCompletions && unlinkedCompletions.length > 0) {
            const completionIds = unlinkedCompletions.map((c) => c.id);
            await supabase
              .from("project_completions")
              .update({ reconciliation_id: reconciliationId })
              .in("id", completionIds);
          }
        }
      }

      res.json({
        success: true,
        status,
        id: reconciliationId,
        ...result,
      });
    } catch (error) {
      console.error("[Reconciliation] current error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // GET /api/artists/:artistId/reconciliation/history?limit=20
  app.get("/api/artists/:artistId/reconciliation/history", async (req, res) => {
    try {
      const { artistId } = req.params;
      const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
      if (!supabase) {
        return res.status(503).json({ success: false, error: "Supabase not configured" });
      }
      const { data, error } = await supabase
        .from("reconciliations")
        .select("*")
        .eq("artist_ghl_id", artistId)
        .order("week_start", { ascending: false })
        .limit(limit);
      if (error) return res.status(500).json({ success: false, error: error.message });
      res.json({ success: true, reconciliations: data || [] });
    } catch (error) {
      console.error("[Reconciliation] history error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/reconciliations/:reconciliationId/settle
  // Marks an existing reconciliation row as settled. Used for cash/Zelle/manual
  // payouts; Phase 5 adds Venmo auto-detection.
  // Owner-only guard for manual reconciliation settlement. The auto-settle
  // path (Venmo webhook → reconciliationVenmoHandler) talks to Supabase
  // directly and never crosses this endpoint, so gating REST is sufficient
  // to enforce "only Lionel + Venmo can settle".
  //
  // Header: x-owner-key (env: OWNER_SETTLE_KEY).
  function requireOwnerKey(req, res) {
    const expected = process.env.OWNER_SETTLE_KEY;
    if (!expected) {
      res.status(503).json({
        success: false,
        error: "OWNER_SETTLE_KEY not configured on server",
      });
      return false;
    }
    if (req.get("x-owner-key") !== expected) {
      res.status(403).json({
        success: false,
        error: "Only the owner can settle reconciliations. Use the Venmo webhook or sign in as Lionel.",
      });
      return false;
    }
    return true;
  }

  app.post("/api/reconciliations/:reconciliationId/settle", async (req, res) => {
    if (!requireOwnerKey(req, res)) return;
    try {
      const { reconciliationId } = req.params;
      const { method, settlementPaymentId } = req.body || {};
      const validMethods = ["venmo_auto", "venmo_manual", "cash", "other"];
      if (!validMethods.includes(method)) {
        return res.status(400).json({
          success: false,
          error: `method must be one of: ${validMethods.join(", ")}`,
        });
      }
      if (!supabase) {
        return res.status(503).json({ success: false, error: "Supabase not configured" });
      }

      // Route through markSettled so rollup cascading happens uniformly
      // here AND in the Venmo webhook auto-settle path.
      const { markSettled } = require("../services/reconciliationVenmoHandler");
      const result = await markSettled({
        reconciliationId,
        settlementPaymentId: settlementPaymentId || null,
        method,
      });
      if (!result.ok) {
        return res.status(500).json({ success: false, error: result.reason });
      }
      res.json({ success: true, reconciliation: result.row });
    } catch (error) {
      console.error("[Reconciliation] settle error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/artists/:artistId/consolidate-pending
  //
  // Phase 8 — Net-Settlement Consolidation.
  // Gathers ALL pending non-rollup recons for the artist, nets the signed
  // amounts, creates a "rollup" reconciliation that consolidates them.
  // The rollup is a normal recon row with `consolidates` populated and
  // its own venmo_code (`<ARTIST><MMDD>-R`). When the rollup settles
  // (via Venmo webhook OR manual /settle), the cascade in
  // reconciliationVenmoHandler.markSettled() flips all children to
  // `status=settled, settled_via='rollup', parent_reconciliation_id=<rollup id>`.
  //
  // Owner-only (same auth posture as /settle).
  // Returns 409 if fewer than 2 pending children, or if a rollup already exists.
  app.post("/api/artists/:artistId/consolidate-pending", async (req, res) => {
    if (!requireOwnerKey(req, res)) return;
    try {
      const { artistId } = req.params;
      if (!supabase) {
        return res.status(503).json({ success: false, error: "Supabase not configured" });
      }

      // 1. Refuse if a pending rollup already exists for this artist —
      //    avoids accidental double-roll while one is in flight.
      const { data: existingRollup } = await supabase
        .from("reconciliations")
        .select("id, venmo_code, net_amount, direction")
        .eq("artist_ghl_id", artistId)
        .eq("status", "pending")
        .not("consolidates", "is", null)
        .limit(1)
        .maybeSingle();
      if (existingRollup) {
        return res.status(409).json({
          success: false,
          error: "A pending rollup already exists for this artist. Settle or delete it first.",
          existingRollup,
        });
      }

      // 2. Fetch all pending non-rollup recons (the children).
      const { data: children, error: childErr } = await supabase
        .from("reconciliations")
        .select("*")
        .eq("artist_ghl_id", artistId)
        .eq("status", "pending")
        .is("consolidates", null)
        .order("week_start", { ascending: true });
      if (childErr) {
        return res.status(500).json({ success: false, error: childErr.message });
      }

      if (!children || children.length < 2) {
        return res.status(409).json({
          success: false,
          error: `Need at least 2 pending recons to consolidate; found ${children?.length || 0}.`,
        });
      }

      // 3. Net the signed amounts. A child in direction shop_owes_artist
      //    contributes +net_amount (positive = artist receives); artist_owes_shop
      //    contributes −net_amount.
      let netCents = 0;
      for (const c of children) {
        const cents = Math.round(Number(c.net_amount) * 100);
        netCents += c.direction === "shop_owes_artist" ? cents : -cents;
      }
      const netDollars = netCents / 100;
      const direction =
        netCents > 0 ? "shop_owes_artist"
        : netCents < 0 ? "artist_owes_shop"
        : "settled";

      // 4. Look up artist context for venmo_code prefix + display name.
      const locationId = process.env.GHL_LOCATION_ID;
      const { artistName } = await fetchArtistContext(artistId, locationId);

      // 5. Generate the rollup code: <PREFIX><MMDD>-R. Today's MMDD is fine —
      //    rollups are exempt from the (artist_ghl_id, week_start) unique
      //    index, so collision with a current-week recon code is OK.
      const { toShopDateString } = require("../utils/dateUtils");
      const today = new Date();
      const todayShop = toShopDateString(today); // YYYY-MM-DD (Central tz)
      const baseCode = generateVenmoCode({
        artistName: artistName || artistId,
        weekStart: today,
      }); // e.g. "AND0527"
      let rollupCode = `${baseCode}-R`;

      // Collision dodge: if -R is taken (rare — same artist consolidated
      // earlier today and that rollup is already settled), append a counter.
      for (let suffix = 2; suffix < 20; suffix++) {
        const { data: clash } = await supabase
          .from("reconciliations")
          .select("id")
          .eq("venmo_code", rollupCode)
          .maybeSingle();
        if (!clash) break;
        rollupCode = `${baseCode}-R${suffix}`;
      }

      // 6. Build the venmo note. Mirror the per-week format but say
      //    "Consolidated" + N projects.
      const weekStart = todayShop;
      const maxWeekEnd = children.reduce((max, c) =>
        c.week_end > max ? c.week_end : max, children[0].week_end);
      const netStr = `$${Math.abs(netDollars).toFixed(0)}`;
      const directionStr = direction === "shop_owes_artist" ? " to artist"
        : direction === "artist_owes_shop" ? " to shop" : "";
      const venmoNote = `StudioAZ Recon Consolidated · ${children.length} weeks · Net ${netStr}${directionStr} · [a:${rollupCode}]`;

      // 7. Create the rollup row. If net == 0, mark settled immediately
      //    so the audit log reflects "consolidated and zeroed out."
      const childIds = children.map((c) => c.id);
      const isZeroNet = netCents === 0;
      const rollupInsert = {
        artist_ghl_id: artistId,
        week_start: weekStart,
        week_end: maxWeekEnd,
        net_amount: Math.abs(netDollars),
        direction: isZeroNet ? "shop_owes_artist" : direction,
        // Schema check constraint requires one of the two directions even
        // for zero-net rollups. We use shop_owes_artist as a neutral pick
        // (it'll be immediately settled with status=settled below).
        status: isZeroNet ? "settled" : "pending",
        venmo_code: rollupCode,
        venmo_note: venmoNote,
        project_count: children.reduce((sum, c) => sum + (c.project_count || 0), 0),
        consolidates: childIds,
        settled_at: isZeroNet ? new Date().toISOString() : null,
        settled_via: isZeroNet ? "rollup" : null,
      };

      const { data: rollup, error: rollupErr } = await supabase
        .from("reconciliations")
        .insert(rollupInsert)
        .select()
        .single();
      if (rollupErr) {
        return res.status(500).json({ success: false, error: rollupErr.message });
      }

      // 8. Stamp parent_reconciliation_id on children. Children stay
      //    `status=pending` until the rollup settles (then the venmo
      //    handler's cascade flips them). EXCEPT in the zero-net case
      //    where we settle children immediately too.
      const childUpdate = isZeroNet
        ? {
            status: "settled",
            settled_at: new Date().toISOString(),
            settled_via: "rollup",
            parent_reconciliation_id: rollup.id,
          }
        : { parent_reconciliation_id: rollup.id };
      const { error: cascadeErr } = await supabase
        .from("reconciliations")
        .update(childUpdate)
        .in("id", childIds);
      if (cascadeErr) {
        // Roll back the rollup row so we don't leave orphaned state.
        await supabase.from("reconciliations").delete().eq("id", rollup.id);
        return res.status(500).json({
          success: false,
          error: `cascade-link failed: ${cascadeErr.message}`,
        });
      }

      console.log(
        `[Reconciliation] Consolidated ${children.length} recons → rollup ${rollupCode}` +
          ` (net=${direction === "settled" ? "0" : netDollars} ${direction})`
      );

      res.json({
        success: true,
        rollup,
        consolidated: childIds,
        zeroNet: isZeroNet,
      });
    } catch (error) {
      console.error("[Reconciliation] consolidate error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Phase 6a + 6b · Shop Settlements / Owner Surfaces
  // ────────────────────────────────────────────────────────────────────────
  //
  // SECURITY POSTURE (Phase 6b 2026-05-07):
  // These shop endpoints are intentionally NOT auth-gated to match the rest
  // of the iOS↔backend layer (URL-trusted, no JWT). The Render URL is public
  // and aggregate financial data IS exposed to anyone who guesses the routes.
  // Tracked as Known Security Debt — Phase 8 hardening will add proper auth.
  //
  // requireOwner() is kept defined-but-unused so we can reinstate the gate
  // in Phase 8 without refactoring callers.
  //
  // The "owner" identity for excluding Lionel from cross-artist lists comes
  // from the LIONEL_GHL_ID constant (also used by serviceIncomeWriter.js)
  // OR from x-ghl-user-id header if iOS sends it. Web (Rent Tracker) calls
  // without the header → falls back to LIONEL_GHL_ID.

  const { LIONEL_GHL_ID } = require("../rentTracker/serviceIncomeWriter");

  /**
   * Reserved for Phase 8 hardening. Currently unused — left in place so the
   * gate can be reinstated without refactoring every shop endpoint.
   */
  // eslint-disable-next-line no-unused-vars
  async function requireOwner(req, res) {
    const ghlUserId = req.get("x-ghl-user-id");
    if (!ghlUserId) {
      res.status(401).json({ success: false, error: "x-ghl-user-id header required" });
      return false;
    }
    if (!supabase) {
      res.status(503).json({ success: false, error: "Supabase not configured" });
      return false;
    }
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("role")
      .eq("ghl_user_id", ghlUserId)
      .maybeSingle();
    if (error) {
      res.status(500).json({ success: false, error: error.message });
      return false;
    }
    if (!profile || profile.role !== "owner") {
      res.status(403).json({ success: false, error: "Owner access required" });
      return false;
    }
    return true;
  }

  /**
   * GET /api/shop/settlements-board
   *
   * Lionel-only. Returns the cross-artist settlement summary for the iOS
   * Shop Settlements section. For each active tattoo artist (excluding
   * Lionel himself, who has his own personal Finance tab below):
   *   - currentReconciliation: the pending Mon-Sun week (eager-creates row)
   *   - lastSettledReconciliation: the most recently settled week, if
   *     within the last 14 days (per Phase 6a decision)
   *   - venmoUsername: artist_commission_rates.venmo_username if populated
   *
   * The pending row creation is intentionally identical to GET /current —
   * same eager-create + two-pass completion query — so the artist's iOS
   * view and the owner's iOS view see the exact same id, net, and code.
   */
  app.get("/api/shop/settlements-board", async (req, res) => {
    try {
      // Phase 6b: open endpoint (Phase 8 will reinstate requireOwner).
      const locationId = process.env.GHL_LOCATION_ID || "mUemx2jG4wly4kJWBkI4";
      // Owner identity for excluding Lionel from the cross-artist list.
      // Prefer the iOS-provided header; fall back to the LIONEL_GHL_ID
      // constant when called from the Rent Tracker web (no header).
      const ownerGhlUserId = req.get("x-ghl-user-id") || LIONEL_GHL_ID;

      const now = new Date();
      const weekStart = getWeekStart(now);
      const weekEnd = getWeekEnd(now);
      const weekStartStr = require("../utils/dateUtils").toShopDateString(weekStart);

      // Active tattoo artists. Exclude the owner — their personal Finance tab
      // shows their own row below.
      const { data: artists, error: artistsErr } = await supabase
        .from("artist_commission_rates")
        .select("artist_ghl_id, artist_name, shop_percentage, artist_percentage, venmo_username")
        .eq("location_id", locationId)
        .is("effective_to", null)
        .neq("artist_ghl_id", ownerGhlUserId);
      if (artistsErr) {
        return res.status(500).json({ success: false, error: artistsErr.message });
      }

      // Lookback boundary for "recently settled" — last 14 days.
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

      const rows = [];
      for (const artist of artists || []) {
        const artistId = artist.artist_ghl_id;
        const artistName = artist.artist_name || artistId;

        // ── Current week: re-run the same eager-create flow as /current ──
        const { data: existingRecon } = await supabase
          .from("reconciliations")
          .select("id, status")
          .eq("artist_ghl_id", artistId)
          .eq("week_start", weekStartStr)
          .maybeSingle();

        const linkedCompletions = existingRecon
          ? (
              await supabase
                .from("project_completions")
                .select("*")
                .eq("artist_ghl_id", artistId)
                .eq("reconciliation_id", existingRecon.id)
                .order("completed_at", { ascending: true })
            ).data || []
          : [];

        const { data: unlinkedCompletions } = await supabase
          .from("project_completions")
          .select("*")
          .eq("artist_ghl_id", artistId)
          .is("reconciliation_id", null)
          .gte("completed_at", weekStart.toISOString())
          .lte("completed_at", weekEnd.toISOString())
          .order("completed_at", { ascending: true });

        const completions = await withContactNames([
          ...linkedCompletions,
          ...(unlinkedCompletions || []),
        ]);

        const currentResult = computeWeeklyReconciliation({
          artistGhlId: artistId,
          artistName,
          weekStart,
          weekEnd,
          completions,
        });

        let currentRow = null;
        if (currentResult.projectCount > 0 && currentResult.direction !== "settled") {
          let reconciliationId = existingRecon?.id || null;
          let status = existingRecon?.status || "pending";

          if (existingRecon) {
            if (existingRecon.status === "pending") {
              await supabase
                .from("reconciliations")
                .update({
                  net_amount: currentResult.netAmount,
                  direction: currentResult.direction,
                  venmo_note: currentResult.venmoNote,
                  project_count: currentResult.projectCount,
                })
                .eq("id", existingRecon.id);
            }
          } else {
            const insertPayload = {
              artist_ghl_id: artistId,
              week_start: currentResult.weekStart,
              week_end: currentResult.weekEnd,
              net_amount: currentResult.netAmount,
              direction: currentResult.direction,
              status: "pending",
              venmo_code: currentResult.venmoCode,
              venmo_note: currentResult.venmoNote,
              project_count: currentResult.projectCount,
            };
            const { data: inserted, error: insertErr } = await supabase
              .from("reconciliations")
              .insert(insertPayload)
              .select("id")
              .maybeSingle();
            if (insertErr) {
              if (String(insertErr.message || "").toLowerCase().includes("unique")) {
                const retryCode = `${currentResult.venmoCode}-2`;
                const { data: retryInserted } = await supabase
                  .from("reconciliations")
                  .insert({ ...insertPayload, venmo_code: retryCode })
                  .select("id")
                  .maybeSingle();
                reconciliationId = retryInserted?.id || null;
              } else {
                console.error("[ShopBoard] eager insert failed:", insertErr.message);
              }
            } else {
              reconciliationId = inserted?.id || null;
            }
            if (reconciliationId && unlinkedCompletions && unlinkedCompletions.length > 0) {
              await supabase
                .from("project_completions")
                .update({ reconciliation_id: reconciliationId })
                .in("id", unlinkedCompletions.map((c) => c.id));
            }
          }

          currentRow = {
            id: reconciliationId,
            status,
            ...currentResult,
          };
        }

        // ── Phase 8 — Pending recon picture ──
        // Gather ALL pending recons for this artist (not just current week).
        // Used to:
        //   (a) decide whether to surface a rollup as the primary row,
        //   (b) count "additional" pending recons for the Consolidate button,
        //   (c) compute the artist's total signed pending net across weeks.
        const { data: allPending } = await supabase
          .from("reconciliations")
          .select("id, week_start, week_end, net_amount, direction, venmo_code, venmo_note, project_count, status, consolidates")
          .eq("artist_ghl_id", artistId)
          .eq("status", "pending")
          .order("week_start", { ascending: true });

        const pendingList = allPending || [];
        const pendingRollup = pendingList.find((r) => Array.isArray(r.consolidates) && r.consolidates.length > 0);
        const pendingChildren = pendingList.filter((r) => !r.consolidates || r.consolidates.length === 0);

        // Total signed net across non-rollup children (the "what's outstanding total")
        let pendingNetCents = 0;
        for (const c of pendingChildren) {
          const cents = Math.round(Number(c.net_amount) * 100);
          pendingNetCents += c.direction === "shop_owes_artist" ? cents : -cents;
        }

        // Rollup takes priority — represents the artist's consolidated debt.
        if (pendingRollup) {
          currentRow = {
            id: pendingRollup.id,
            status: pendingRollup.status,
            artistGhlId: artistId,
            weekStart: pendingRollup.week_start,
            weekEnd: pendingRollup.week_end,
            netAmount: Math.abs(Number(pendingRollup.net_amount)),
            direction: pendingRollup.direction,
            venmoCode: pendingRollup.venmo_code,
            venmoNote: pendingRollup.venmo_note,
            projectCount: pendingRollup.project_count || 0,
            isRollup: true,
            consolidates: pendingRollup.consolidates,
          };
        }
        // ── Carry forward: surface unsettled prior-week recons ──
        // An artist who still owes the shop (or is still owed) should not
        // drop off the board when the week rolls over. If the current week
        // produced no pending recon, fall back to the OLDEST still-pending
        // non-rollup recon (children only — rollup case handled above).
        else if (!currentRow && pendingChildren.length > 0) {
          const carried = pendingChildren[0]; // already sorted asc by week_start
          currentRow = {
            id: carried.id,
            status: carried.status,
            artistGhlId: artistId,
            weekStart: carried.week_start,
            weekEnd: carried.week_end,
            netAmount: Math.abs(Number(carried.net_amount)),
            direction: carried.direction,
            venmoCode: carried.venmo_code,
            venmoNote: carried.venmo_note,
            projectCount: carried.project_count || 0,
            carriedForward: true,
          };
        }

        // ── Last settled within 14 days ──
        const { data: lastSettled } = await supabase
          .from("reconciliations")
          .select("*")
          .eq("artist_ghl_id", artistId)
          .eq("status", "settled")
          .gte("settled_at", fourteenDaysAgo.toISOString())
          .order("settled_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        rows.push({
          artistGhlId: artistId,
          artistName,
          venmoUsername: artist.venmo_username || null,
          shopPercentage: Number(artist.shop_percentage),
          artistPercentage: Number(artist.artist_percentage),
          currentReconciliation: currentRow,
          lastSettledReconciliation: lastSettled || null,
          // Phase 8 — Consolidation hints for the UI.
          //   pendingChildrenCount: # of non-rollup pending recons.
          //     If >= 2 AND no rollup yet → show "Consolidate" button.
          //   pendingNetSigned: total signed net across non-rollup pending recons.
          //     Positive = shop owes artist; negative = artist owes shop.
          pendingChildrenCount: pendingChildren.length,
          pendingNetSigned: pendingNetCents / 100,
          hasPendingRollup: !!pendingRollup,
        });
      }

      // Sort rows: pending shop_owes_artist first (action items), then
      // pending artist_owes_shop (awaiting), then settled-only at the bottom.
      rows.sort((a, b) => {
        const score = (r) => {
          if (r.currentReconciliation?.direction === "shop_owes_artist") return 0;
          if (r.currentReconciliation?.direction === "artist_owes_shop") return 1;
          if (r.lastSettledReconciliation) return 2;
          return 3;
        };
        return score(a) - score(b);
      });

      // Aggregate top-line totals for the section header
      const totalToPayOut = rows.reduce((sum, r) => {
        if (r.currentReconciliation?.direction === "shop_owes_artist") {
          return sum + Number(r.currentReconciliation.netAmount || 0);
        }
        return sum;
      }, 0);
      const totalAwaiting = rows.reduce((sum, r) => {
        if (r.currentReconciliation?.direction === "artist_owes_shop") {
          return sum + Number(r.currentReconciliation.netAmount || 0);
        }
        return sum;
      }, 0);
      const pendingArtistCount = rows.filter((r) => r.currentReconciliation != null).length;

      res.json({
        success: true,
        weekStart: weekStartStr,
        weekEnd: require("../utils/dateUtils").toShopDateString(weekEnd),
        artists: rows,
        totals: {
          toPayOut: totalToPayOut,
          awaiting: totalAwaiting,
          pendingArtistCount,
          totalArtistCount: rows.length,
        },
      });
    } catch (error) {
      console.error("[ShopBoard] error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Phase 6b · Rent Tracker Web — Owner Audit Surfaces
  // ────────────────────────────────────────────────────────────────────────

  /**
   * GET /api/shop/fee-revenue?period=YYYY
   *
   * Returns month-by-month + YTD financing fee revenue (Stripe 6%).
   * The fee is parsed from `transactions.notes` matching:
   *     "(incl. $XX financing fee → shop)"
   * Only Stripe-method transactions are considered. Refunded amounts
   * are NOT yet subtracted (Phase 7 polish — needs a `refunded_at`
   * filter once refund handling lands).
   *
   * Response: {
   *   success: true,
   *   period: "2026",
   *   months: [{ month: "2026-04", label: "April 2026", feeRevenue, transactionCount }, ...],
   *   ytdFeeRevenue: number,
   *   ytdTransactionCount: number,
   *   parseFailures: number  // rows that looked Stripe but didn't match the regex
   * }
   */
  app.get("/api/shop/fee-revenue", async (req, res) => {
    try {
      if (!supabase) {
        return res.status(503).json({ success: false, error: "Supabase not configured" });
      }
      const period = String(req.query.period || new Date().getFullYear());
      const yearNum = parseInt(period, 10);
      if (!Number.isFinite(yearNum) || yearNum < 2020 || yearNum > 2100) {
        return res.status(400).json({ success: false, error: "Invalid period" });
      }

      const locationId = process.env.GHL_LOCATION_ID || "mUemx2jG4wly4kJWBkI4";
      const startOfYear = `${yearNum}-01-01T00:00:00Z`;
      const endOfYear = `${yearNum + 1}-01-01T00:00:00Z`;

      // Pull all Stripe-method tattoo transactions in the year. We filter
      // by payment_method LIKE 'stripe%' to capture stripe_affirm,
      // stripe_klarna, stripe_card, etc. Notes column carries the fee.
      const { data: txs, error } = await supabase
        .from("transactions")
        .select("id, gross_amount, payment_method, notes, created_at, session_date")
        .eq("location_id", locationId)
        .gte("created_at", startOfYear)
        .lt("created_at", endOfYear)
        .like("payment_method", "stripe%");
      if (error) {
        return res.status(500).json({ success: false, error: error.message });
      }

      // Bucket by month
      const monthsByKey = {};
      let parseFailures = 0;
      const feeRegex = /\(incl\. \$?([\d.]+) financing fee/i;

      for (const t of txs || []) {
        const match = (t.notes || "").match(feeRegex);
        const fee = match ? parseFloat(match[1]) : null;
        if (!match) {
          parseFailures += 1;
          continue;
        }
        const date = t.session_date || t.created_at;
        const d = new Date(date);
        if (isNaN(d.getTime())) continue;
        const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
        if (!monthsByKey[monthKey]) {
          monthsByKey[monthKey] = { feeRevenue: 0, transactionCount: 0 };
        }
        monthsByKey[monthKey].feeRevenue += fee;
        monthsByKey[monthKey].transactionCount += 1;
      }

      const monthLabel = (key) => {
        const [y, m] = key.split("-");
        const monthNames = ["January", "February", "March", "April", "May", "June",
          "July", "August", "September", "October", "November", "December"];
        return `${monthNames[parseInt(m, 10) - 1]} ${y}`;
      };

      const months = Object.keys(monthsByKey)
        .sort((a, b) => b.localeCompare(a)) // newest first
        .map((key) => ({
          month: key,
          label: monthLabel(key),
          feeRevenue: Number(monthsByKey[key].feeRevenue.toFixed(2)),
          transactionCount: monthsByKey[key].transactionCount,
        }));

      const ytdFeeRevenue = months.reduce((s, m) => s + m.feeRevenue, 0);
      const ytdTransactionCount = months.reduce((s, m) => s + m.transactionCount, 0);

      res.json({
        success: true,
        period,
        months,
        ytdFeeRevenue: Number(ytdFeeRevenue.toFixed(2)),
        ytdTransactionCount,
        parseFailures,
      });
    } catch (error) {
      console.error("[FeeRevenue] error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * GET /api/shop/outstanding-receivables
   *
   * Returns the cross-artist outstanding-client pipeline. Iterates every
   * active tattoo artist, calls computeContactReconciliation per contact
   * with final_price set, then dedupes contacts by id (a contact tied to
   * multiple artists picks the most-recent assignment).
   *
   * Response: {
   *   success: true,
   *   total: number,            // sum of outstanding across all contacts
   *   activeProjectCount: number,
   *   topContacts: [{ contactId, contactName, artistName, quote, collected, outstanding }, ...20]
   * }
   */
  app.get("/api/shop/outstanding-receivables", async (req, res) => {
    try {
      if (!supabase) {
        return res.status(503).json({ success: false, error: "Supabase not configured" });
      }
      const locationId = process.env.GHL_LOCATION_ID || "mUemx2jG4wly4kJWBkI4";

      // 1. Get all tattoo transactions; group by contact_id; for each contact
      //    pick the artist_ghl_id from the LATEST transaction (canonical owner).
      const { data: txs, error: txErr } = await supabase
        .from("transactions")
        .select("contact_id, contact_name, artist_ghl_id, gross_amount, shop_amount, artist_amount, shop_percentage, payment_recipient, transaction_type, created_at")
        .eq("location_id", locationId);
      if (txErr) return res.status(500).json({ success: false, error: txErr.message });

      // Group transactions by contact_id, recording latest artist + name
      const byContact = {};
      for (const t of txs || []) {
        if (!t.contact_id) continue;
        if (!byContact[t.contact_id]) {
          byContact[t.contact_id] = {
            contactId: t.contact_id,
            contactName: t.contact_name || "",
            latestArtistGhlId: t.artist_ghl_id,
            latestCreatedAt: t.created_at,
            transactions: [],
          };
        }
        const c = byContact[t.contact_id];
        if (!c.contactName && t.contact_name) c.contactName = t.contact_name;
        if (t.created_at && (!c.latestCreatedAt || t.created_at > c.latestCreatedAt)) {
          c.latestCreatedAt = t.created_at;
          c.latestArtistGhlId = t.artist_ghl_id;
        }
        c.transactions.push(t);
      }

      // 2. Pull artist names + commission rates so we can label rows.
      const { data: rates } = await supabase
        .from("artist_commission_rates")
        .select("artist_ghl_id, artist_name, shop_percentage")
        .eq("location_id", locationId)
        .is("effective_to", null);
      const artistNames = {};
      for (const r of rates || []) {
        artistNames[r.artist_ghl_id] = r.artist_name;
      }

      // 3. For each contact, compute outstanding via Phase 1 math engine.
      //    Skip contacts with null final_price (no contract quote → undefined).
      const contactIds = Object.keys(byContact);
      const rows = [];

      // Concurrency limit — 5 GHL contact lookups in flight at once
      const concurrency = 5;
      let cursor = 0;
      async function next() {
        while (cursor < contactIds.length) {
          const idx = cursor++;
          const contactId = contactIds[idx];
          const c = byContact[contactId];
          try {
            const quote = await fetchContractQuote(contactId);
            if (quote == null) continue;
            const latestTx = c.transactions[c.transactions.length - 1];
            const shopPercentage = latestTx?.shop_percentage != null
              ? Number(latestTx.shop_percentage)
              : 30;
            const summary = computeContactReconciliation({
              quote,
              shopPercentage,
              transactions: c.transactions,
            });
            if (summary.outstanding <= 0) continue;
            rows.push({
              contactId,
              contactName: c.contactName || "Unknown Client",
              artistGhlId: c.latestArtistGhlId,
              artistName: artistNames[c.latestArtistGhlId] || c.latestArtistGhlId,
              quote: summary.quote,
              collected: summary.collected,
              outstanding: summary.outstanding,
            });
          } catch (e) {
            console.error(`[Receivables] contact ${contactId} error:`, e.message);
          }
        }
      }
      await Promise.all(Array.from({ length: concurrency }, () => next()));

      // 4. Aggregate + sort top 20
      const total = rows.reduce((s, r) => s + Number(r.outstanding || 0), 0);
      const topContacts = rows
        .sort((a, b) => Number(b.outstanding) - Number(a.outstanding))
        .slice(0, 20);

      res.json({
        success: true,
        total: Number(total.toFixed(2)),
        activeProjectCount: rows.length,
        topContacts,
      });
    } catch (error) {
      console.error("[Receivables] error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * GET /api/shop/contacts/search?q=...&limit=20
   *
   * Phase 9 — Searches contacts that already appear in the tattoo shop's
   * transactions table by contact_name (case-insensitive substring). This
   * is the owner-web entry point for drilling into any contact's ledger
   * without having to wait for them to bubble up in outstanding receivables.
   *
   * Returns: { success, results: [{ contactId, contactName, latestArtistGhlId,
   *   transactionCount, lastSessionDate }] }
   */
  app.get("/api/shop/contacts/search", async (req, res) => {
    try {
      if (!supabase) {
        return res.status(503).json({ success: false, error: "Supabase not configured" });
      }
      const q = String(req.query.q || "").trim();
      const limit = Math.min(Number(req.query.limit) || 20, 50);
      if (q.length < 2) {
        return res.json({ success: true, results: [] });
      }
      const locationId = process.env.GHL_LOCATION_ID || "mUemx2jG4wly4kJWBkI4";

      const { data: txs, error } = await supabase
        .from("transactions")
        .select("contact_id, contact_name, artist_ghl_id, session_date")
        .eq("location_id", locationId)
        .ilike("contact_name", `%${q}%`)
        .is("superseded_by", null)
        .is("deleted_at", null)
        .order("session_date", { ascending: false })
        .limit(500);
      if (error) {
        return res.status(500).json({ success: false, error: error.message });
      }

      const byContact = {};
      for (const t of txs || []) {
        if (!t.contact_id) continue;
        const c = byContact[t.contact_id] || (byContact[t.contact_id] = {
          contactId: t.contact_id,
          contactName: t.contact_name || "Unknown",
          latestArtistGhlId: t.artist_ghl_id,
          transactionCount: 0,
          lastSessionDate: t.session_date,
        });
        c.transactionCount++;
        if (t.session_date && (!c.lastSessionDate || t.session_date > c.lastSessionDate)) {
          c.lastSessionDate = t.session_date;
          c.latestArtistGhlId = t.artist_ghl_id;
        }
      }

      const { data: rates } = await supabase
        .from("artist_commission_rates")
        .select("artist_ghl_id, artist_name")
        .eq("location_id", locationId)
        .is("effective_to", null);
      const artistNames = {};
      for (const r of rates || []) artistNames[r.artist_ghl_id] = r.artist_name;

      const results = Object.values(byContact)
        .map((c) => ({
          ...c,
          artistName: artistNames[c.latestArtistGhlId] || null,
        }))
        .sort((a, b) => (b.lastSessionDate || "").localeCompare(a.lastSessionDate || ""))
        .slice(0, limit);

      res.json({ success: true, results });
    } catch (error) {
      console.error("[ContactSearch] error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * GET /api/shop/audit-log?startDate=...&endDate=...&artistId=...&type=...&limit=100&offset=0
   *
   * Unified time-ordered audit log combining:
   *   - reconciliations (settled rows with settled_at)
   *   - reconciliation_email_log (every parser decision)
   *
   * Each row is normalized to { id, eventType, occurredAt, artistGhlId, artistName, amount, code, decision, decisionNote, sourceTable, settledVia, reconciliationId }.
   *
   * Filters:
   *   startDate / endDate — ISO strings, applied to occurredAt
   *   artistId — optional, restricts to one artist
   *   type — optional, restricts to one eventType
   *   limit (default 100, max 500), offset (default 0)
   *
   * Response: { success, events: [...], total, limit, offset }
   */
  app.get("/api/shop/audit-log", async (req, res) => {
    try {
      if (!supabase) {
        return res.status(503).json({ success: false, error: "Supabase not configured" });
      }
      const locationId = process.env.GHL_LOCATION_ID || "mUemx2jG4wly4kJWBkI4";

      const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);
      const offset = Math.max(parseInt(req.query.offset || "0", 10), 0);
      const artistId = req.query.artistId || null;
      const startDate = req.query.startDate || null;
      const endDate = req.query.endDate || null;
      const typeFilter = req.query.type || null;

      // Fetch artist name map for labeling
      const { data: rates } = await supabase
        .from("artist_commission_rates")
        .select("artist_ghl_id, artist_name")
        .eq("location_id", locationId)
        .is("effective_to", null);
      const artistNames = {};
      for (const r of rates || []) {
        artistNames[r.artist_ghl_id] = r.artist_name;
      }

      // Fetch settlements
      let settlementsQuery = supabase
        .from("reconciliations")
        .select("id, artist_ghl_id, week_start, week_end, net_amount, direction, status, venmo_code, settled_at, settled_via, settlement_payment_id, created_at")
        .eq("status", "settled");
      if (artistId) settlementsQuery = settlementsQuery.eq("artist_ghl_id", artistId);
      if (startDate) settlementsQuery = settlementsQuery.gte("settled_at", startDate);
      if (endDate) settlementsQuery = settlementsQuery.lte("settled_at", endDate);
      const { data: settlements, error: settlementsErr } = await settlementsQuery;
      if (settlementsErr) {
        return res.status(500).json({ success: false, error: settlementsErr.message });
      }

      // Fetch parser log
      let logQuery = supabase
        .from("reconciliation_email_log")
        .select("id, artist_ghl_id, parsed_amount, parsed_code, decision, decision_note, reconciliation_id, created_at");
      if (artistId) logQuery = logQuery.eq("artist_ghl_id", artistId);
      if (startDate) logQuery = logQuery.gte("created_at", startDate);
      if (endDate) logQuery = logQuery.lte("created_at", endDate);
      const { data: logs, error: logsErr } = await logQuery;
      if (logsErr) {
        return res.status(500).json({ success: false, error: logsErr.message });
      }

      // Normalize into a unified event array
      const events = [];

      for (const s of settlements || []) {
        events.push({
          id: `settle:${s.id}`,
          eventType: s.settled_via === "venmo_auto" ? "settled_auto" : "settled_manual",
          occurredAt: s.settled_at,
          artistGhlId: s.artist_ghl_id,
          artistName: artistNames[s.artist_ghl_id] || s.artist_ghl_id,
          amount: Number(s.net_amount),
          code: s.venmo_code,
          decision: s.status,
          decisionNote: s.settlement_payment_id
            ? `Tx ${s.settlement_payment_id}`
            : `Settled via ${s.settled_via || "unknown"}`,
          sourceTable: "reconciliations",
          settledVia: s.settled_via,
          reconciliationId: s.id,
          weekStart: s.week_start,
          weekEnd: s.week_end,
          direction: s.direction,
        });
      }

      for (const l of logs || []) {
        // Skip "settled" rows from the log if we already have the settlement
        // (avoid duplicate entries — the settlement row above is canonical).
        if (l.decision === "settled" && l.reconciliation_id &&
            (settlements || []).some((s) => s.id === l.reconciliation_id)) {
          continue;
        }
        events.push({
          id: `log:${l.id}`,
          eventType: `parser_${l.decision}`,
          occurredAt: l.created_at,
          artistGhlId: l.artist_ghl_id,
          artistName: l.artist_ghl_id ? (artistNames[l.artist_ghl_id] || l.artist_ghl_id) : null,
          amount: l.parsed_amount != null ? Number(l.parsed_amount) : null,
          code: l.parsed_code,
          decision: l.decision,
          decisionNote: l.decision_note,
          sourceTable: "reconciliation_email_log",
          settledVia: null,
          reconciliationId: l.reconciliation_id,
        });
      }

      // Optional eventType filter (after normalization so users can filter
      // by 'settled_auto', 'settled_manual', or any 'parser_*').
      const filtered = typeFilter
        ? events.filter((e) => e.eventType === typeFilter || e.decision === typeFilter)
        : events;

      // Sort newest first
      filtered.sort((a, b) => {
        const ta = a.occurredAt ? new Date(a.occurredAt).getTime() : 0;
        const tb = b.occurredAt ? new Date(b.occurredAt).getTime() : 0;
        return tb - ta;
      });

      const total = filtered.length;
      const page = filtered.slice(offset, offset + limit);

      res.json({
        success: true,
        events: page,
        total,
        limit,
        offset,
      });
    } catch (error) {
      console.error("[AuditLog] error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Phase 7c · Reconciliation Drill-Down (project breakdown)
  // ────────────────────────────────────────────────────────────────────────

  /**
   * GET /api/reconciliations/:id/projects
   *
   * Returns the per-project breakdown for one reconciliation row. Used by
   * the iOS Settlement History drill-down sheet (Phase 7c) to show the math
   * reveal: each contact's gross + shop% + artist% + tip + net contribution
   * to the week's reconciliation total.
   *
   * Joins server-side so the iOS sheet doesn't need per-row contact lookups.
   * Falls back to denormalized `transactions.contact_name` when GHL returns
   * blank (matches the pattern in /api/artists/:artistId/earnings).
   *
   * Response shape:
   *   {
   *     success: true,
   *     reconciliation: { id, weekStart, weekEnd, netAmount, direction,
   *                       venmoCode, venmoNote, status, settledAt, settledVia },
   *     projects: [{ contactId, contactName, completedAt, quote, collected,
   *                  netToArtist, shopPercentage, artistPercentage }]
   *   }
   */
  app.get("/api/reconciliations/:id/projects", async (req, res) => {
    try {
      if (!supabase) {
        return res.status(503).json({ success: false, error: "Supabase not configured" });
      }
      const { id } = req.params;
      if (!id) {
        return res.status(400).json({ success: false, error: "Missing reconciliation id" });
      }

      // 1. Load the reconciliation row
      const { data: recon, error: reconErr } = await supabase
        .from("reconciliations")
        .select("id, artist_ghl_id, week_start, week_end, net_amount, direction, status, venmo_code, venmo_note, settled_at, settled_via, project_count")
        .eq("id", id)
        .maybeSingle();
      if (reconErr) return res.status(500).json({ success: false, error: reconErr.message });
      if (!recon) return res.status(404).json({ success: false, error: "Reconciliation not found" });

      // 2. Load all completions linked to this reconciliation
      const { data: completions, error: compErr } = await supabase
        .from("project_completions")
        .select("id, contact_id, completed_at, quote_at_completion, collected_at_completion, net_to_artist, shop_percentage_at_completion, artist_percentage_at_completion")
        .eq("reconciliation_id", id)
        .order("completed_at", { ascending: true });
      if (compErr) return res.status(500).json({ success: false, error: compErr.message });

      const rows = completions || [];
      const contactIds = [...new Set(rows.map((r) => r.contact_id).filter(Boolean))];

      // 3. Resolve contact names — denormalized first, GHL fallback for any blanks
      const nameMap = {};
      if (contactIds.length > 0) {
        const { data: txs } = await supabase
          .from("transactions")
          .select("contact_id, contact_name")
          .in("contact_id", contactIds);
        for (const t of txs || []) {
          if (t.contact_name && !nameMap[t.contact_id]) {
            nameMap[t.contact_id] = t.contact_name;
          }
        }
        const missing = contactIds.filter((c) => !nameMap[c]);
        if (missing.length > 0) {
          await Promise.all(missing.map(async (cid) => {
            try {
              const contact = await getContact(cid);
              const name = contact?.contactName
                || `${contact?.firstName || ""} ${contact?.lastName || ""}`.trim();
              nameMap[cid] = name || "Unknown Client";
            } catch {
              nameMap[cid] = "Unknown Client";
            }
          }));
        }
      }

      const projects = rows.map((r) => ({
        contactId: r.contact_id,
        contactName: nameMap[r.contact_id] || "Unknown Client",
        completedAt: r.completed_at,
        quote: Number(r.quote_at_completion),
        collected: Number(r.collected_at_completion),
        netToArtist: Number(r.net_to_artist),
        shopPercentage: Number(r.shop_percentage_at_completion),
        artistPercentage: Number(r.artist_percentage_at_completion),
      }));

      res.json({
        success: true,
        reconciliation: {
          id: recon.id,
          artistGhlId: recon.artist_ghl_id,
          weekStart: recon.week_start,
          weekEnd: recon.week_end,
          netAmount: Number(recon.net_amount),
          direction: recon.direction,
          venmoCode: recon.venmo_code,
          venmoNote: recon.venmo_note,
          projectCount: recon.project_count,
          status: recon.status,
          settledAt: recon.settled_at,
          settledVia: recon.settled_via,
        },
        projects,
      });
    } catch (error) {
      console.error("[ReconProjects] error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Phase 7d · Tax Export CSV (per-artist, calendar year)
  // ────────────────────────────────────────────────────────────────────────

  /**
   * GET /api/artists/:artistId/tax-export?year=YYYY
   *
   * Streams a CSV of every transaction for the artist in the given calendar
   * year (America/Chicago timezone). Columns:
   *   Date, Client, Method, Gross, Your Share, Settled, Settled Date
   *
   * "Settled" derivation: the transaction's contact has a project_completion
   * row whose reconciliation_id points to a reconciliations row with
   * status='settled'. The settled date is reconciliations.settled_at.
   *
   * Refunds appear as negative Gross/Your Share rows so they net out in a
   * spreadsheet sum. Tips are treated as part of the gross (artist keeps tips
   * 100% — but we still record them in the same row for tax-record clarity).
   *
   * No auth gate (Phase 6b posture). Phase 8 will reinstate.
   */
  app.get("/api/artists/:artistId/tax-export", async (req, res) => {
    try {
      if (!supabase) {
        return res.status(503).json({ success: false, error: "Supabase not configured" });
      }
      const { artistId } = req.params;
      const yearStr = String(req.query.year || new Date().getFullYear());
      const yearNum = parseInt(yearStr, 10);
      if (!Number.isFinite(yearNum) || yearNum < 2020 || yearNum > 2100) {
        return res.status(400).json({ success: false, error: "Invalid year" });
      }

      const startISO = `${yearNum}-01-01T00:00:00-06:00`; // America/Chicago year-start
      const endISO = `${yearNum + 1}-01-01T00:00:00-06:00`;

      // 1. Pull all transactions for this artist in the year.
      // Phase 7g — exclude superseded + soft-deleted rows so the tax CSV
      // matches what the artist sees in their own Finance tab.
      const { data: txs, error: txErr } = await supabase
        .from("transactions")
        .select("id, contact_id, contact_name, transaction_type, payment_method, gross_amount, tip_amount, shop_amount, artist_amount, shop_percentage, artist_percentage, session_date, notes")
        .eq("artist_ghl_id", artistId)
        .is("superseded_by", null)
        .is("deleted_at", null)
        .gte("session_date", startISO)
        .lt("session_date", endISO)
        .order("session_date", { ascending: true });
      if (txErr) {
        return res.status(500).json({ success: false, error: txErr.message });
      }
      const transactions = txs || [];

      // 2. For each contact in those transactions, look up their settled status:
      //    project_completion (artist_ghl_id, contact_id) → reconciliation_id → reconciliations.status
      const contactIds = [...new Set(transactions.map((t) => t.contact_id).filter(Boolean))];
      const settlementByContact = {}; // contactId -> { settled: bool, settledAt: ISO }
      if (contactIds.length > 0) {
        const { data: completions } = await supabase
          .from("project_completions")
          .select("contact_id, reconciliation_id")
          .eq("artist_ghl_id", artistId)
          .in("contact_id", contactIds);
        const reconIds = [...new Set((completions || []).map((c) => c.reconciliation_id).filter(Boolean))];
        let reconMap = {};
        if (reconIds.length > 0) {
          const { data: recons } = await supabase
            .from("reconciliations")
            .select("id, status, settled_at")
            .in("id", reconIds);
          for (const r of recons || []) reconMap[r.id] = r;
        }
        for (const c of completions || []) {
          const r = c.reconciliation_id ? reconMap[c.reconciliation_id] : null;
          settlementByContact[c.contact_id] = {
            settled: r?.status === "settled",
            settledAt: r?.settled_at || null,
          };
        }
      }

      // 3. Stream the CSV. Use America/Chicago for human-readable dates.
      const filename = `tattoo-tax-${artistId}-${yearNum}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

      const escape = (val) => {
        if (val == null) return "";
        const s = String(val);
        // Quote if contains comma, quote, or newline
        if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
      };

      const formatShopDate = (isoOrDate) => {
        if (!isoOrDate) return "";
        const d = new Date(isoOrDate);
        if (isNaN(d.getTime())) return "";
        const fmt = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Chicago",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        });
        return fmt.format(d); // YYYY-MM-DD
      };

      const methodLabel = (m) => {
        const map = {
          square: "Square",
          stripe_affirm: "Stripe Affirm",
          stripe_klarna: "Stripe Klarna",
          stripe_card: "Stripe Card",
          venmo: "Venmo",
          cash: "Cash",
          zelle: "Zelle",
          other: "Other",
        };
        return map[m] || m || "Unknown";
      };

      // Header
      res.write("Date,Client,Method,Gross,Your Share,Settled,Settled Date\n");

      for (const t of transactions) {
        const isRefund = (t.transaction_type || "").toLowerCase().includes("refund")
          || (t.gross_amount || 0) < 0;
        // Sign: refunds keep their negative sign so a spreadsheet sum nets out
        const grossSigned = isRefund
          ? -Math.abs(Number(t.gross_amount || 0))
          : Math.abs(Number(t.gross_amount || 0));
        // Artist share: prefer the snapshotted artist_amount, fall back to
        // gross * artist_percentage if unset.
        let artistSigned;
        if (t.artist_amount != null) {
          artistSigned = isRefund
            ? -Math.abs(Number(t.artist_amount))
            : Math.abs(Number(t.artist_amount));
        } else {
          const pct = t.artist_percentage != null ? Number(t.artist_percentage) : 70;
          artistSigned = (grossSigned * pct) / 100;
        }

        const settle = settlementByContact[t.contact_id];
        const settled = settle?.settled ? "Yes" : "No";
        const settledDate = settle?.settled ? formatShopDate(settle.settledAt) : "";

        const row = [
          formatShopDate(t.session_date),
          escape(t.contact_name || ""),
          methodLabel(t.payment_method),
          grossSigned.toFixed(2),
          artistSigned.toFixed(2),
          settled,
          settledDate,
        ].join(",");
        res.write(row + "\n");
      }

      res.end();
    } catch (error) {
      console.error("[TaxExport] error:", error);
      // If headers were already sent (mid-stream), we can't change status.
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: error.message });
      } else {
        res.end();
      }
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

      // Update GHL contact with final_price custom field (single source of truth — the contract).
      const { updateContact } = require('../clients/ghlClient');
      const { GHL_CUSTOM_FIELD_IDS } = require('../config/constants');

      const customField = {
        [GHL_CUSTOM_FIELD_IDS.FINAL_PRICE]: quoteAmount,
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

      // Update GHL contact with all custom fields. Quote writes go to final_price (the contract).
      const { updateContact } = require('../clients/ghlClient');
      const { GHL_CUSTOM_FIELD_IDS } = require('../config/constants');

      const customField = {
        [GHL_CUSTOM_FIELD_IDS.FINAL_PRICE]: quoteAmount,
        'payment_type': paymentType,
        'session_estimate': sessionEstimate,
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

        // Fallback 2: search GHL contacts by name when no meet_event_subscriptions match
        if (!contactId && nameFromTitle) {
          try {
            const { ghl } = require("../clients/ghlSdk");
            const result = await ghl.contacts.getContacts({
              locationId: process.env.GHL_LOCATION_ID || "mUemx2jG4wly4kJWBkI4",
              query: nameFromTitle,
              limit: 5,
            });
            const contacts = result?.contacts || [];
            if (contacts.length > 0) {
              // Pick best match — prefer exact name match
              const exactMatch = contacts.find((c) => {
                const fullName = `${c.firstName || ""} ${c.lastName || ""}`.trim().toLowerCase();
                return fullName === nameFromTitle.toLowerCase();
              });
              const match = exactMatch || contacts[0];
              contactId = match.id || match._id;
              clientName = nameFromTitle;
              console.log(`🔥 Matched to contact ${contactId} via GHL name search for "${nameFromTitle}"`);
            }
          } catch (searchErr) {
            console.warn("🔥 GHL contact name search failed:", searchErr.message);
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
  // FIREFLIES REPROCESS UNMATCHED TRANSCRIPTS
  // Retries matching for unmatched transcripts using GHL contact name search
  // ═══════════════════════════════════════════════════════════════════════════

  app.post("/api/fireflies/reprocess-unmatched", async (req, res) => {
    try {
      if (!supabase) {
        return res.status(500).json({ error: "Supabase not configured" });
      }

      // Optionally target a specific transcript
      const { transcriptId } = req.body || {};

      let query = supabase
        .from("fireflies_transcripts")
        .select("*")
        .eq("status", "unmatched");

      if (transcriptId) {
        query = query.eq("transcript_id", transcriptId);
      }

      const { data: unmatched, error: queryErr } = await query;

      if (queryErr) {
        return res.status(500).json({ error: queryErr.message });
      }

      if (!unmatched || unmatched.length === 0) {
        return res.json({ success: true, processed: 0, message: "No unmatched transcripts" });
      }

      console.log(`🔥 Reprocessing ${unmatched.length} unmatched transcript(s)...`);

      const results = [];

      for (const row of unmatched) {
        const nameFromTitle = extractNameFromTitle(row.meeting_title);

        if (!nameFromTitle) {
          results.push({ id: row.transcript_id, status: "skipped", reason: "no name in title" });
          continue;
        }

        // Search GHL contacts by name
        let contactId = null;
        try {
          const { ghl } = require("../clients/ghlSdk");
          const result = await ghl.contacts.getContacts({
            locationId: process.env.GHL_LOCATION_ID || "mUemx2jG4wly4kJWBkI4",
            query: nameFromTitle,
            limit: 5,
          });
          const contacts = result?.contacts || [];
          if (contacts.length > 0) {
            const exactMatch = contacts.find((c) => {
              const fullName = `${c.firstName || ""} ${c.lastName || ""}`.trim().toLowerCase();
              return fullName === nameFromTitle.toLowerCase();
            });
            contactId = (exactMatch || contacts[0]).id;
          }
        } catch (searchErr) {
          results.push({ id: row.transcript_id, status: "error", reason: searchErr.message });
          continue;
        }

        if (!contactId) {
          results.push({ id: row.transcript_id, status: "still_unmatched", name: nameFromTitle });
          continue;
        }

        // Fetch transcript from Fireflies
        let transcript;
        try {
          transcript = await getTranscript(row.transcript_id);
        } catch (fetchErr) {
          results.push({ id: row.transcript_id, status: "error", reason: `fetch failed: ${fetchErr.message}` });
          continue;
        }

        if (!transcript || !transcript.sentences || transcript.sentences.length === 0) {
          results.push({ id: row.transcript_id, status: "error", reason: "empty transcript" });
          continue;
        }

        // Check if Google/Gemini artifacts already exist
        const googleExists = await checkGoogleArtifactsExist(contactId);
        if (googleExists) {
          await supabase.from("fireflies_transcripts").update({
            contact_id: contactId,
            status: "skipped_google_exists",
            processed_at: new Date().toISOString(),
          }).eq("transcript_id", row.transcript_id);
          results.push({ id: row.transcript_id, status: "skipped_google_exists", contactId });
          continue;
        }

        // Format + summarize
        const rawText = formatTranscriptText(transcript.sentences);
        let summaryText = "";
        try {
          summaryText = await summarizeConsultation(rawText, { clientName: nameFromTitle });
        } catch (sumErr) {
          summaryText = "Summary generation failed. See raw transcript.";
        }

        // Save to GHL custom fields
        const customField = {
          Tj9WuXbE1hWtxfTgCMGM: rawText,
          EU4U5jeDJxXHQ8Jh8gfT: summaryText,
          LUASmxIwwPBr3SsZEHd9: row.transcript_id,
          HORoQH6waBo9xSabFbyM: new Date().toISOString(),
        };

        try {
          await updateContact(contactId, { customField });
        } catch (updateErr) {
          results.push({ id: row.transcript_id, status: "error", reason: `GHL update failed: ${updateErr.message}` });
          continue;
        }

        // Mark as processed
        await supabase.from("fireflies_transcripts").update({
          contact_id: contactId,
          status: "processed",
          processed_at: new Date().toISOString(),
        }).eq("transcript_id", row.transcript_id);

        results.push({ id: row.transcript_id, status: "processed", contactId, name: nameFromTitle });
        console.log(`🔥 ✅ Reprocessed transcript "${row.meeting_title}" → contact ${contactId}`);
      }

      return res.json({ success: true, processed: results.length, results });
    } catch (err) {
      console.error("🔥 Reprocess error:", err);
      return res.status(500).json({ error: err.message });
    }
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
      const { contactId, amountCents, paymentType, description, artistId, artistName, contactName, language } = req.body;

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

      // paymentType is the explicit deposit-vs-consult intent. Required for refund
      // disambiguation — historical rows that lacked it can't be safely refunded.
      if (paymentType !== "deposit" && paymentType !== "consult") {
        return res.status(400).json({
          success: false,
          error: 'Missing or invalid required field: paymentType (must be "deposit" or "consult")',
        });
      }

      console.log(`[API] Generating payment link for contact ${contactId} — $${amountCents / 100} [${paymentType}]${artistName ? ` (artist: ${artistName})` : ''}`);

      const paymentLink = await createDepositLinkForContact({
        contactId,
        amountCents,
        paymentType,
        description: description || "Studio AZ Tattoo Payment",
        artistId: artistId || null,
        artistName: artistName || null,
        contactName: contactName || null,
        language: language === "Spanish" ? "es" : "en",
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
  // REFUND REQUEST FORM (Phase 3 lifecycle — money + Lost still STUBBED here,
  // wired in Phase 5). See REFUND_REQUEST_FORM_PLAN.md §6.2 for the contract.
  // ═══════════════════════════════════════════════════════════════════════════
  const {
    createRefundRequest,
    getRefundRequestByToken,
    submitRefundRequest,
  } = require("../refundRequest/refundRequestService");

  // POST /api/refund-request/send — Internal: mint token + SMS to client.
  // Called by iOS ("Send refund link") and the AI setter on explicit cancel.
  // Gated by x-internal-key, same pattern as /api/tattoo/fill-token.
  app.post("/api/refund-request/send", async (req, res) => {
    if (!requireInternalKey(req, res)) return;
    try {
      const { contactId } = req.body || {};
      if (!contactId) {
        return res
          .status(400)
          .json({ success: false, error: "contactId is required" });
      }

      const result = await createRefundRequest(contactId);

      if (!result.success) {
        return res.status(400).json(result);
      }

      res.json(result);
    } catch (err) {
      console.error("❌ POST /api/refund-request/send error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/refund-request/:token — Public prefill for the web form.
  // Never exposes the raw drop_off_stage — only the boolean showConsultQuality.
  app.get("/api/refund-request/:token", async (req, res) => {
    try {
      const result = await getRefundRequestByToken(req.params.token);
      if (!result.success) {
        const status =
          result.error === "expired" || result.error === "already_submitted"
            ? 410
            : result.error === "not_found"
            ? 404
            : 500;
        return res.status(status).json(result);
      }
      res.json(result);
    } catch (err) {
      console.error("❌ GET /api/refund-request/:token error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/refund-request/:token/submit — Public submit.
  // Phase 3: persist answers only. Phase 5 wires the actual refund + Lost.
  app.post("/api/refund-request/:token/submit", async (req, res) => {
    try {
      const requestMeta = {
        ip:
          req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
          req.socket?.remoteAddress ||
          null,
        userAgent: req.headers["user-agent"] || null,
      };

      const result = await submitRefundRequest(
        req.params.token,
        req.body || {},
        requestMeta
      );

      if (!result.success) {
        const status = result.httpStatus || 400;
        // Strip our internal httpStatus from the response body.
        const { httpStatus, ...body } = result;
        return res.status(status).json(body);
      }

      // Strip httpStatus if present (it won't be on success).
      const { httpStatus, ...body } = result;
      res.json(body);
    } catch (err) {
      console.error("❌ POST /api/refund-request/:token/submit error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/contacts/:contactId/refund — Owner-only manual refund path
  // (REFUND_REQUEST_FORM_PLAN.md §12.4). Used by the rent-tracker Ledger
  // Plate to settle a multi/missing-deposit escalation by hand.
  //
  // Auth: requireOwnerKey (x-owner-key, same as /api/reconciliations/.../settle).
  // Body: { paymentId, amountCents?, refundType }
  //   - paymentId: REQUIRED. The Square payment id of the deposit to reverse.
  //   - amountCents: OPTIONAL. Defaults to the full deposit amount (looked up
  //     from the original transactions row).
  //   - refundType: REQUIRED. 'deposit_refunded' | 'partial_refund' | 'no_refund'.
  //     'no_refund' is supported for the bookkeeping-only path (e.g. owner
  //     decides not to refund and just wants to mark the contact Lost).
  //
  // Returns { success, refundId?, refundStatus, ledgerRowId? } plus the
  // raw refund response from Square (when issued).
  app.post("/api/contacts/:contactId/refund", async (req, res) => {
    if (!requireOwnerKey(req, res)) return;
    try {
      const { contactId } = req.params;
      const { paymentId, amountCents, refundType, reason } = req.body || {};

      if (!contactId) {
        return res
          .status(400)
          .json({ success: false, error: "contactId is required" });
      }
      if (!paymentId && refundType !== "no_refund") {
        return res.status(400).json({
          success: false,
          error: "paymentId is required (or supply refundType='no_refund' for bookkeeping-only)",
        });
      }
      if (!["deposit_refunded", "partial_refund", "no_refund"].includes(refundType)) {
        return res.status(400).json({
          success: false,
          error: "refundType must be one of: deposit_refunded, partial_refund, no_refund",
        });
      }

      const {
        lookupOriginalDepositTxn,
        postRefundLedgerRow,
        mirrorRefundToInstantDb,
        notifyRefundManualReview,
      } = require("../refundRequest/refundRequestService");
      const { refundPayment } = require("../payments/squareClient");
      const { transitionToStage } = require("../ai/opportunityManager");
      const { OPPORTUNITY_STAGES } = require("../config/constants");

      let refundId = null;
      let ledgerRow = null;
      let appliedAmountCents = null;

      // Bookkeeping-only path — skip Square, skip ledger, just write
      // refund_type onto the Lost transition so the §6.6 analytics roll up.
      if (refundType !== "no_refund") {
        const originalTxn = await lookupOriginalDepositTxn(paymentId);
        if (!originalTxn) {
          return res.status(404).json({
            success: false,
            error: `No deposit transaction found for square_payment_id ${paymentId}`,
          });
        }

        // Default the amount to the full original deposit.
        appliedAmountCents =
          typeof amountCents === "number" && amountCents > 0
            ? amountCents
            : Math.round(Number(originalTxn.gross_amount) * 100);

        // Idempotency key: deterministic per (paymentId, amountCents) so a
        // retry doesn't double-refund (Square caps at 45 chars).
        const idempotencyKey = `owner-${paymentId.slice(-20)}-${appliedAmountCents}`.slice(0, 45);

        try {
          const refund = await refundPayment({
            paymentId,
            amountCents: appliedAmountCents,
            idempotencyKey,
            currency: "USD",
            reason: reason || "Owner manual refund",
          });
          refundId = refund.refundId;
        } catch (squareErr) {
          // The owner needs to know immediately if Square rejected the refund.
          return res.status(502).json({
            success: false,
            error: `Square refund failed: ${squareErr.message}`,
          });
        }

        ledgerRow = await postRefundLedgerRow({
          refundedTxn: originalTxn,
          contactName: null,
          squareRefundId: refundId,
          refundAmountCents: appliedAmountCents,
        });

        await mirrorRefundToInstantDb({
          refundedTxn: originalTxn,
          refundAmountCents: appliedAmountCents,
          squareRefundId: refundId,
        });
      }

      // Move opportunity to Lost (Phase 4 idempotency guard handles the
      // already-LOST case where last_stage_before_lost is preserved).
      try {
        await transitionToStage(contactId, OPPORTUNITY_STAGES.COLD_NURTURE_LOST, {
          allowRegression: true,
          refundType,
          // The owner endpoint doesn't have a drop_off_stage to map; let
          // Phase 4's auto-derive run from the contact's current stage.
        });
      } catch (lostErr) {
        // Non-fatal — money already moved (or wasn't needed for no_refund).
        console.error(
          `[OwnerRefund] Lost transition failed for ${contactId}: ${lostErr.message}`
        );
      }

      // Best-effort notification so the owner sees confirmation in iOS.
      try {
        await notifyRefundManualReview({
          contactId,
          contactName: null,
          reason: `Manual refund completed (${refundType})`,
        });
      } catch (notifyErr) {
        console.warn(
          `[OwnerRefund] manual-review notify failed: ${notifyErr.message}`
        );
      }

      return res.json({
        success: true,
        refundId,
        refundStatus: refundType === "no_refund" ? "skipped" : "refunded",
        appliedAmountCents,
        ledgerRowId: ledgerRow?.id || null,
      });
    } catch (err) {
      console.error("❌ POST /api/contacts/:contactId/refund error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TATTOO ARTIST SOCIAL LANDING PAGE INQUIRY
  // ═══════════════════════════════════════════════════════════════════════════

  // POST /api/tattoo/inquiry — Form submission from artist bio link landing pages
  // Creates/upserts GHL contact, assigns artist as owner, posts inbound SMS
  // Accepts JSON or multipart/form-data (with `data` JSON field + `files` images)
  app.post("/api/tattoo/inquiry", upload.array("files", 3), async (req, res) => {
    try {
      let payload = {};
      if (req.body && typeof req.body.data === "string") {
        // Multipart: JSON is in the `data` field
        try {
          payload = JSON.parse(req.body.data);
        } catch (e) {
          return res.status(400).json({ success: false, error: "Invalid JSON in data field" });
        }
      } else {
        payload = req.body || {};
      }

      const { firstName, lastName, phone, message, artistSlug, source, language, pageLang } = payload;

      if (!firstName || !lastName || !phone || !message || !artistSlug) {
        return res.status(400).json({
          success: false,
          error: "Missing required fields: firstName, lastName, phone, message, artistSlug",
        });
      }

      if (!ARTIST_USER_IDS[artistSlug]) {
        return res.status(400).json({
          success: false,
          error: `Unknown artist: ${artistSlug}`,
        });
      }

      const fileCount = req.files?.length || 0;
      console.log(`[Inquiry] New inquiry for artist ${artistSlug} from ${firstName} ${lastName} (${phone}) via ${source || "unknown"} — ${fileCount} file(s) attached, language=${language || "unset"} pageLang=${pageLang || "unset"}`);

      const result = await processArtistInquiry({
        firstName,
        lastName,
        phone,
        message,
        artistSlug,
        source,
        language,
        pageLang,
        files: req.files || [],
      });

      res.json(result);
    } catch (error) {
      console.error("[Inquiry] Error processing artist inquiry:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Failed to process inquiry",
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // FILL FLOW — pre-loaded consultation page (FILL_FLOW_PLAN.md Phase 1)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // 4 endpoints:
  //   POST /api/tattoo/fill-token       — internal-only: mint a token (back-fill / re-issue)
  //   GET  /api/tattoo/fill/:token      — public: resolve token → prefill payload
  //   POST /api/tattoo/fill/:token/step — public: record step transition (analytics)
  //   POST /api/tattoo/fill/:token      — public: submit the full form, lock the token
  //
  // Validity is enforced inside fillTokenService — handlers just translate
  // FillTokenError.code into the matching HTTP status.

  // Custom field IDs the fill submission writes back to GHL.
  // Mirrored from src/clients/ghlClient.js CUSTOM_FIELD_MAP.
  const FILL_GHL_FIELD_IDS = {
    tattoo_title: "8JqgdVJraABsqgUeqJ3a",
    tattoo_summary: "xAGtMfmbxtfCHdo2oyf7",
    tattoo_placement: "jd8YhvKsBi4aGqjqOEOv",
    tattoo_style: "12b2O4ydlfO99FA4yCuk",
    tattoo_size: "KXtfZYdeSKUyS5llTKsr",
    tattoo_color_preference: "SzyropMDMcitUDhhb8dd",
    how_soon_is_client_deciding: "ra4Nk80WMA8EQkLCfXST",
    first_tattoo: "QqDydmY1fnldidlcMnBC",
    tattoo_photo_description: "ptrJy8TBBjlnRWQepdnP",
    // Note: budget_range + tattoo_concerns are not yet wired to known GHL
    // field IDs. They get added when those fields are provisioned in GHL;
    // until then we accept-and-drop silently (logged) so the fill page can
    // still POST without 400ing.
  };

  // Stamped on every successful submit — the iOS app reads this to surface
  // the second synthetic "provided more details" bubble (Phase 3 of the plan).
  const FILL_FORM_SUBMITTED_AT_FIELD_ID = "TxmgB8Y0j8ETyZaziAqi";

  function sendFillError(res, err, where) {
    if (err instanceof FillTokenError) {
      console.warn(`[Fill][${where}] ${err.code} ${err.message}`);
      const status = err.code === 404 ? 404 : err.code === 410 ? 410 : 500;
      return res.status(status).json({
        success: false,
        error: err.message,
      });
    }
    console.error(`[Fill][${where}] Unexpected:`, err);
    return res.status(500).json({
      success: false,
      error: err?.message || "Internal error",
    });
  }

  // Tiny shared-secret guard for the internal mint endpoint. Same pattern the
  // analytics endpoint will use in Phase 4.5. Header: x-internal-key.
  function requireInternalKey(req, res) {
    const expected = process.env.INTERNAL_API_KEY;
    if (!expected) {
      // No key configured = endpoint is locked.
      res.status(503).json({
        success: false,
        error: "INTERNAL_API_KEY not configured on server",
      });
      return false;
    }
    if (req.get("x-internal-key") !== expected) {
      res.status(401).json({ success: false, error: "Unauthorized" });
      return false;
    }
    return true;
  }

  // ═══ v2 AI Setter — iOS contact-profile controls (Phase 4) ═══
  // These back the Pause AI / Resume AI / "AI handle this" buttons on the iOS contact profile.
  // The SwiftUI controls themselves live in the iOS repo (separate workstream); these are the
  // backend they call. The status indicator just reads the funnel_status custom field — no
  // endpoint needed. Internal-only (x-internal-key). Body: { contactId }.
  async function setFunnelStatus(contactId, fields) {
    const { updateContact } = require("../clients/ghlClient");
    return updateContact(contactId, { customField: fields });
  }

  // Pause AI → funnel_status = paused_manual (silent until manually resumed; no auto-resume).
  app.post("/api/ai-setter/pause", async (req, res) => {
    if (!requireInternalKey(req, res)) return;
    const { FUNNEL_STATUSES, SYSTEM_FIELDS } = require("../config/constants");
    const contactId = req.body?.contactId;
    if (!contactId) return res.status(400).json({ success: false, error: "contactId required" });
    try {
      await setFunnelStatus(contactId, { [SYSTEM_FIELDS.FUNNEL_STATUS]: FUNNEL_STATUSES.PAUSED_MANUAL });
      return res.json({ success: true, funnel_status: FUNNEL_STATUSES.PAUSED_MANUAL });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // Resume AI → funnel_status = active (bot picks up on next inbound). Clears the human-pause clock.
  app.post("/api/ai-setter/resume", async (req, res) => {
    if (!requireInternalKey(req, res)) return;
    const { FUNNEL_STATUSES, SYSTEM_FIELDS } = require("../config/constants");
    const contactId = req.body?.contactId;
    if (!contactId) return res.status(400).json({ success: false, error: "contactId required" });
    try {
      await setFunnelStatus(contactId, {
        [SYSTEM_FIELDS.FUNNEL_STATUS]: FUNNEL_STATUSES.ACTIVE,
        [SYSTEM_FIELDS.HUMAN_LAST_MESSAGE_AT]: "",
      });
      return res.json({ success: true, funnel_status: FUNNEL_STATUSES.ACTIVE });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // AI handle this → let the bot send the next reply even though a human was just in the thread.
  // Sets active + clears the human-pause clock so the decay window won't block re-entry.
  app.post("/api/ai-setter/ai-handle", async (req, res) => {
    if (!requireInternalKey(req, res)) return;
    const { FUNNEL_STATUSES, SYSTEM_FIELDS } = require("../config/constants");
    const contactId = req.body?.contactId;
    if (!contactId) return res.status(400).json({ success: false, error: "contactId required" });
    try {
      await setFunnelStatus(contactId, {
        [SYSTEM_FIELDS.FUNNEL_STATUS]: FUNNEL_STATUSES.ACTIVE,
        [SYSTEM_FIELDS.HUMAN_LAST_MESSAGE_AT]: "",
      });
      return res.json({ success: true, funnel_status: FUNNEL_STATUSES.ACTIVE, note: "bot will handle next inbound" });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/tattoo/fill-token
  // Internal-only re-issue / back-fill. Useful for migrating existing leads or
  // manually generating a link from iOS. Body: { contactId, artistSlug, language?, source?, expiryDays? }
  app.post("/api/tattoo/fill-token", async (req, res) => {
    if (!requireInternalKey(req, res)) return;
    try {
      const { contactId, artistSlug, language, source, expiryDays } = req.body || {};
      if (!contactId || !artistSlug) {
        return res.status(400).json({
          success: false,
          error: "contactId and artistSlug are required",
        });
      }
      if (!ARTIST_USER_IDS[artistSlug]) {
        return res.status(400).json({
          success: false,
          error: `Unknown artist: ${artistSlug}`,
        });
      }
      const result = await createFillToken({
        contactId,
        artistSlug,
        language: language || "en",
        source: source || null,
        expiryDays: typeof expiryDays === "number" ? expiryDays : undefined,
      });
      return res.json({ success: true, ...result });
    } catch (err) {
      return sendFillError(res, err, "POST fill-token");
    }
  });

  // GET /api/tattoo/fill/:token
  // Public. Returns the prefill payload + bumps last_seen_at.
  app.get("/api/tattoo/fill/:token", async (req, res) => {
    try {
      const payload = await resolveFillToken(req.params.token);

      // Surface the artist's first name for the welcome screen — the page
      // already knows the slug from `payload.artistSlug` but a humanized name
      // belongs server-side so we can ever rename / remap without a redeploy.
      const ARTIST_DISPLAY_NAMES = { joan: "Joan", andrew: "Andrew" };
      const artistFirstName = ARTIST_DISPLAY_NAMES[payload.artistSlug] ||
        payload.artistSlug.charAt(0).toUpperCase() + payload.artistSlug.slice(1);

      return res.json({
        success: true,
        ...payload,
        artistFirstName,
      });
    } catch (err) {
      return sendFillError(res, err, "GET fill");
    }
  });

  // GET /api/tattoo/fill/:token/photo/:index
  // Public proxy. The raw GHL / GCS URLs require a PIT auth header that we
  // can't expose to the lead's browser — fetch + stream them through here.
  // Caches at the edge for an hour (private since it's per-token).
  app.get("/api/tattoo/fill/:token/photo/:index", async (req, res) => {
    try {
      const { stream, contentType, contentLength } = await getFillPhotoForToken(
        req.params.token,
        req.params.index
      );
      res.setHeader("Content-Type", contentType);
      if (contentLength) res.setHeader("Content-Length", contentLength);
      // Token is per-contact, link is short-lived — short cache is safe and
      // saves a GHL round-trip if the lead reloads or revisits.
      res.setHeader("Cache-Control", "private, max-age=600");
      // Pipe the upstream body directly to the response.
      const { Readable } = require("stream");
      Readable.fromWeb(stream).pipe(res);
    } catch (err) {
      return sendFillError(res, err, "GET fill photo");
    }
  });

  // POST /api/tattoo/fill/:token/step
  // Public, fire-and-forget from the page on each step transition.
  // Body: { step: number }. Failures are tolerated client-side.
  app.post("/api/tattoo/fill/:token/step", async (req, res) => {
    try {
      const step = Number(req.body?.step);
      if (!Number.isFinite(step) || step < 1) {
        return res.status(400).json({
          success: false,
          error: "step must be a positive integer",
        });
      }
      await recordFillStepProgress(req.params.token, step);
      return res.json({ success: true });
    } catch (err) {
      return sendFillError(res, err, "POST fill/:token/step");
    }
  });

  // POST /api/tattoo/fill/:token
  // Public, final submission. Accepts JSON (no extra photos) or multipart
  // (with `data` JSON field + `files` images, mirroring /api/tattoo/inquiry).
  // Locks the token, then writes form values to GHL custom fields and appends
  // any new photos. Phase 3 will wire the iOS-side "fill_form_submitted_at"
  // bubble onto a real GHL field — for now we just log + return ok.
  app.post(
    "/api/tattoo/fill/:token",
    upload.array("files", 3),
    async (req, res) => {
      // Step 1: lock the token first. If the token is invalid we never touch GHL.
      let tokenContext;
      try {
        tokenContext = await consumeFillToken(req.params.token);
      } catch (err) {
        return sendFillError(res, err, "POST fill submit (consume)");
      }

      // Step 2: parse the payload (JSON or multipart).
      let payload = {};
      if (req.body && typeof req.body.data === "string") {
        try {
          payload = JSON.parse(req.body.data);
        } catch (e) {
          return res.status(400).json({
            success: false,
            error: "Invalid JSON in data field",
          });
        }
      } else {
        payload = req.body || {};
      }

      const { contactId } = tokenContext;
      const fieldsAccepted = [];
      const fieldsDropped = [];
      const customFields = [];

      Object.entries(payload).forEach(([key, value]) => {
        if (value === undefined || value === null || value === "") return;
        const fieldId = FILL_GHL_FIELD_IDS[key];
        if (!fieldId) {
          fieldsDropped.push(key);
          return;
        }
        customFields.push({ id: fieldId, field_value: String(value) });
        fieldsAccepted.push(key);
      });

      // Always stamp fill_form_submitted_at — drives the iOS synthetic bubble.
      // Done unconditionally so even an empty submission (every field dropped)
      // still surfaces in the artist's thread.
      customFields.push({
        id: FILL_FORM_SUBMITTED_AT_FIELD_ID,
        field_value: new Date().toISOString(),
      });
      fieldsAccepted.push("fill_form_submitted_at");

      if (fieldsDropped.length > 0) {
        console.warn(
          `[Fill][POST submit] contact=${contactId} dropped unknown fields: ${fieldsDropped.join(", ")}`
        );
      }

      // Step 3: persist GHL custom fields (best-effort — token is already locked).
      const errors = [];
      if (customFields.length > 0) {
        try {
          const { ghl: ghlSdk } = require("../clients/ghlSdk");
          await ghlSdk.contacts.updateContact(
            { contactId },
            { customFields }
          );
          console.log(
            `[Fill][POST submit] contact=${contactId} wrote ${customFields.length} fields: ${fieldsAccepted.join(", ")}`
          );
        } catch (cfErr) {
          console.error(
            `[Fill][POST submit] contact=${contactId} custom-field update failed:`,
            cfErr.message
          );
          errors.push(`custom_fields: ${cfErr.message}`);
        }
      }

      // Step 4: append new photos (best-effort).
      if (req.files && req.files.length > 0) {
        try {
          const { uploadFilesToTattooCustomField } = require("../clients/ghlClient");
          await uploadFilesToTattooCustomField(contactId, req.files);
          console.log(
            `[Fill][POST submit] contact=${contactId} uploaded ${req.files.length} new photo(s)`
          );
        } catch (uploadErr) {
          console.error(
            `[Fill][POST submit] contact=${contactId} photo upload failed:`,
            uploadErr.message
          );
          errors.push(`photos: ${uploadErr.message}`);
        }
      }

      return res.json({
        success: errors.length === 0,
        contactId,
        fieldsAccepted,
        fieldsDropped,
        photosUploaded: req.files?.length || 0,
        errors: errors.length > 0 ? errors : undefined,
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // LEAD FUNNEL ANALYTICS (FILL_FLOW_PLAN.md Phase 4.5)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // GET /api/analytics/lead-funnel?days=30
  //   - Internal-only (x-internal-key header)
  //   - 5-min in-memory cache; pass ?force=1 to bypass
  //   - days clamped to [1, 365]
  //   - Returns the JSON shape documented in FILL_FLOW_PLAN.md Phase 4.5

  app.get("/api/analytics/lead-funnel", async (req, res) => {
    if (!requireInternalKey(req, res)) return;
    try {
      const { getFunnelSnapshot } = require("../analytics/leadFunnelAnalytics");
      const days = Number(req.query.days) || 30;
      const force = req.query.force === "1" || req.query.force === "true";
      const snapshot = await getFunnelSnapshot(days, { force });
      return res.json(snapshot);
    } catch (err) {
      console.error("[Analytics][lead-funnel] failed:", err);
      return res.status(500).json({
        success: false,
        error: err?.message || "Failed to compute funnel snapshot",
      });
    }
  });

  // POST /api/tattoo/fill-nudge/sweep
  //   - Internal-only (x-internal-key header)
  //   - Hit hourly by Render cron; runs the 24h non-engager nudge sweep.
  //   - Returns the tally of sent / skipped / deferred rows (see
  //     fillNudgeService.runNudgeSweep for the schema).
  //   - Honors LANDING_PAGE_FILL_NUDGE_ENABLED kill switch.
  //
  // NOTE: lives under /api/tattoo/fill-nudge/, NOT /api/tattoo/fill/, because
  // POST /api/tattoo/fill/:token (the form-submit handler) is registered above
  // and would otherwise swallow this path with `:token = "nudge-sweep"`. Same
  // sibling-namespace pattern as POST /api/tattoo/fill-token.
  app.post("/api/tattoo/fill-nudge/sweep", async (req, res) => {
    if (!requireInternalKey(req, res)) return;
    try {
      const { runNudgeSweep } = require("../services/fillNudgeService");
      const result = await runNudgeSweep();
      return res.json(result);
    } catch (err) {
      console.error("[fillNudge] sweep failed:", err);
      return res.status(500).json({
        ok: false,
        error: err?.message || "Nudge sweep failed",
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SHORT LINK REDIRECT — pay.studioaztattoo.com/:code
  // ═══════════════════════════════════════════════════════════════════════════

  const EXPIRED_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Link Expired — Studio AZ Tattoo</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      background:#111;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{text-align:center;max-width:380px}
    .icon{font-size:48px;margin-bottom:16px;opacity:.6}
    h1{font-size:22px;font-weight:700;margin-bottom:8px}
    p{font-size:15px;color:#999;line-height:1.5;margin-bottom:24px}
    a{display:inline-block;padding:12px 32px;background:#7B5EA7;color:#fff;
      text-decoration:none;border-radius:12px;font-weight:600;font-size:15px}
    a:hover{opacity:.9}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⏱</div>
    <h1>TITLE_PLACEHOLDER</h1>
    <p>MSG_PLACEHOLDER</p>
    <a href="https://studioaztattoo.com">Visit Studio AZ</a>
  </div>
</body>
</html>`;

  const NOT_FOUND_HTML = EXPIRED_LINK_HTML
    .replace("Link Expired", "Not Found")
    .replace("TITLE_PLACEHOLDER", "Link not found")
    .replace("MSG_PLACEHOLDER", "This payment link doesn&#39;t exist or may have been removed. Please contact your artist for assistance.")
    .replace("⏱", "🔗")
    .replace("#7B5EA7", "#333");

  function expiredPage(title, message) {
    return EXPIRED_LINK_HTML
      .replace("TITLE_PLACEHOLDER", title)
      .replace("MSG_PLACEHOLDER", message);
  }

  app.get("/:code", async (req, res) => {
    const { code } = req.params;
    if (!/^[a-z0-9]{6}$/.test(code)) return res.status(404).send(NOT_FOUND_HTML);

    try {
      const { createClient } = require("@supabase/supabase-js");
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

      const { data, error } = await supabase
        .from("short_links")
        .select("destination_url, click_count, session_id")
        .eq("code", code)
        .single();

      if (error || !data) {
        console.warn(`[ShortLink] Code not found: ${code}`);
        return res.status(404).send(NOT_FOUND_HTML);
      }

      // Check if this is a Stripe session — verify it's still active
      if (data.session_id && data.session_id.startsWith("cs_")) {
        try {
          const Stripe = require("stripe");
          const stripeInstance = Stripe(process.env.STRIPE_SECRET_KEY);
          const session = await stripeInstance.checkout.sessions.retrieve(data.session_id);
          if (session.status === "expired") {
            console.log(`[ShortLink] ${code} → expired Stripe session ${data.session_id}`);
            return res.status(410).send(expiredPage(
              "This link has expired",
              "Payment links expire after 24 hours for your security. Please contact your artist to get a new link."
            ));
          }
          if (session.status === "complete") {
            console.log(`[ShortLink] ${code} → already paid Stripe session ${data.session_id}`);
            return res.status(410).send(expiredPage(
              "This link has already been used",
              "This payment has already been completed. If you have questions, please contact your artist."
            ));
          }
        } catch (stripeErr) {
          console.warn(`[ShortLink] Could not check Stripe session status: ${stripeErr.message}`);
          // Fall through to redirect — let Stripe handle the error
        }
      }

      // Increment click count (fire and forget)
      supabase
        .from("short_links")
        .update({ click_count: (data.click_count || 0) + 1 })
        .eq("code", code)
        .then(() => {});

      console.log(`[ShortLink] ${code} → ${data.destination_url.substring(0, 60)}...`);
      return res.redirect(302, data.destination_url);
    } catch (err) {
      console.error(`[ShortLink] Error resolving code ${code}:`, err.message);
      return res.status(500).send("Server error");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // STRIPE FINANCING LINKS + WEBHOOK
  // ═══════════════════════════════════════════════════════════════════════════

  // POST /api/generate-financing-link — Create a Stripe Checkout Session for financing
  app.post("/api/generate-financing-link", async (req, res) => {
    try {
      const { contactId, amountCents, originalQuoteAmountCents, description, artistId, artistName, contactName } = req.body;

      if (!contactId) {
        return res.status(400).json({ success: false, error: "Missing required field: contactId" });
      }
      if (!amountCents || typeof amountCents !== "number" || amountCents <= 0) {
        return res.status(400).json({ success: false, error: "Missing or invalid required field: amountCents (must be a positive number)" });
      }

      console.log(`[Stripe] Generating financing link for contact ${contactId} — $${amountCents / 100}${originalQuoteAmountCents ? ` (quote: $${originalQuoteAmountCents / 100})` : ""}${artistName ? ` (artist: ${artistName})` : ""}`);

      const result = await createFinancingLinkForContact({
        contactId,
        amountCents,
        originalQuoteAmountCents: originalQuoteAmountCents || amountCents,
        description: description || "Tattoo Session",
        artistId: artistId || null,
        artistName: artistName || null,
        contactName: contactName || null,
      });

      console.log(`[Stripe] Financing link generated: ${result.url}`);

      res.json({
        success: true,
        financingLink: {
          url: result.url,
          sessionId: result.sessionId,
        },
      });
    } catch (error) {
      console.error("[Stripe] Error generating financing link:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Failed to generate financing link",
      });
    }
  });

  // POST /stripe/webhook — Handle Stripe payment events
  app.post("/stripe/webhook", async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.warn("⚠️ Missing STRIPE_WEBHOOK_SECRET");
      return res.status(401).send("missing secret");
    }

    let event;
    try {
      const Stripe = require("stripe");
      const stripeInstance = Stripe(process.env.STRIPE_SECRET_KEY);
      event = stripeInstance.webhooks.constructEvent(req.rawBody || Buffer.from(""), sig, webhookSecret);
    } catch (err) {
      console.error("❌ Stripe webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook error: ${err.message}`);
    }

    try {
      if (!COMPACT_MODE) {
        console.log("\n💳 ════════════════════════════════════════════════════════");
        console.log(`💳 STRIPE WEBHOOK: ${event.type}`);
        console.log("💳 ════════════════════════════════════════════════════════");
      }

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const contactId = session.metadata?.contactId;
        const artistId = session.metadata?.artistId || null;
        const artistName = session.metadata?.artistName || null;
        const amountCents = session.amount_total;
        const paymentMethod = session.payment_method_types?.[0] || "unknown";

        if (!contactId) {
          console.warn("⚠️ Stripe webhook: checkout.session.completed missing contactId in metadata", session.id);
          return res.json({ received: true, warning: "no contactId in metadata" });
        }

        console.log(`💳 Stripe payment completed: contact=${contactId} $${amountCents / 100} via ${paymentMethod}`);

        // Update Supabase stripe_checkout_sessions record
        const { createClient } = require("@supabase/supabase-js");
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

        await supabase
          .from("stripe_checkout_sessions")
          .update({
            status: "paid",
            payment_method_used: paymentMethod,
            paid_at: new Date().toISOString(),
          })
          .eq("session_id", session.id);

        // Update GHL contact — mark financing as paid
        try {
          await updateSystemFields(contactId, {
            deposit_paid: "true",
          });
          console.log(`💳 GHL contact ${contactId} updated: deposit_paid=true`);
        } catch (ghlErr) {
          console.error("⚠️ Failed to update GHL contact after Stripe payment:", ghlErr.message);
        }

        // Record in transactions table for Finances + Projects tab
        try {
          const contactName = session.metadata?.contactName || "Unknown Client";
          const resolvedArtistId = (artistId && artistId !== "") ? artistId : "unknown";

          // originalQuoteAmountCents = artist commission base (before 6% merchant fee gross-up)
          // Use it for grossAmount so commission splits are calculated on the correct base.
          // The actual collected amount (amountCents) is stored in the notes for shop bookkeeping.
          const originalQuoteAmountCents = parseInt(session.metadata?.originalQuoteAmountCents || amountCents, 10);
          const collectedAmount = amountCents / 100;
          const quoteAmount = originalQuoteAmountCents / 100;
          const shopFee = parseFloat((collectedAmount - quoteAmount).toFixed(2));

          await recordTransaction({
            contactId,
            contactName,
            appointmentId: null,
            artistId: resolvedArtistId,
            transactionType: "session_payment",
            paymentMethod: `stripe_${paymentMethod}`, // e.g. 'stripe_affirm', 'stripe_klarna', 'stripe_card'
            paymentRecipient: "shop",
            grossAmount: quoteAmount, // commission base — what artist is paid on
            sessionDate: new Date(),
            squarePaymentId: null,
            locationId: process.env.GHL_LOCATION_ID || "studio_az_tattoo",
            notes: `Stripe financing — ${paymentMethod} — session ${session.id} — collected $${collectedAmount}${shopFee > 0 ? ` (incl. $${shopFee} financing fee → shop)` : ""}`,
          });
          console.log(`💳 Transaction recorded: contact=${contactId} artist=${resolvedArtistId} quote=$${quoteAmount} collected=$${collectedAmount}`);

          // Push notification to artist
          try {
            const { sendPaymentReceivedNotification } = require("../services/paymentNotifications");
            await sendPaymentReceivedNotification({
              artistGhlUserId: resolvedArtistId,
              contactName,
              amount: collectedAmount,
              paymentMethod: `stripe_${paymentMethod}`,
              contactId,
            });
          } catch (pushErr) {
            console.warn("⚠️ Payment push notification failed (non-fatal):", pushErr.message);
          }
        } catch (txErr) {
          console.error("⚠️ Failed to record Stripe transaction:", txErr.message);
          // Non-fatal — payment already processed, don't fail the webhook
        }

      } else if (event.type === "checkout.session.expired") {
        const session = event.data.object;
        const { createClient } = require("@supabase/supabase-js");
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        await supabase
          .from("stripe_checkout_sessions")
          .update({ status: "expired" })
          .eq("session_id", session.id);
        console.log(`💳 Stripe session expired: ${session.id}`);

      } else if (event.type === "payment_intent.payment_failed") {
        const pi = event.data.object;
        console.warn(`⚠️ Stripe payment failed: ${pi.id} — ${pi.last_payment_error?.message || "unknown reason"}`);
      }

      res.json({ received: true });
    } catch (err) {
      console.error("❌ /stripe/webhook processing error:", err.message || err);
      res.status(500).json({ error: "webhook processing failed" });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CUSTOM CHECKOUT — Frontend API for branded checkout page
  // ═══════════════════════════════════════════════════════════════════════════

  // GET /api/checkout/:id — Frontend loads checkout details
  app.get("/api/checkout/:id", async (req, res) => {
    try {
      const session = await getCheckoutSession(req.params.id);
      if (!session) {
        return res.status(404).json({ success: false, error: "Checkout session not found" });
      }

      // Don't expose internal fields to the frontend
      const { _squareOrderId, _contactId, ...publicData } = session;

      res.json({ success: true, checkout: publicData });
    } catch (error) {
      console.error("[API] Error fetching checkout session:", error.message);
      res.status(500).json({ success: false, error: "Failed to load checkout" });
    }
  });

  // POST /api/checkout/:id/pay — Frontend submits payment token
  app.post("/api/checkout/:id/pay", async (req, res) => {
    try {
      const { sourceId, buyerEmail } = req.body;

      if (!sourceId) {
        return res.status(400).json({ success: false, error: "Missing sourceId (payment token)" });
      }

      const result = await processCheckoutPayment(req.params.id, sourceId, buyerEmail);

      res.json({
        success: true,
        payment: {
          paymentId: result.paymentId,
          status: result.status,
          receiptUrl: result.receiptUrl,
        },
      });
    } catch (error) {
      console.error("[API] Checkout payment error:", error.response?.data || error.message);
      const status = error.message?.includes("not found") ? 404
        : error.message?.includes("expired") ? 410
        : error.message?.includes("already") || error.message?.includes("is paid") ? 409
        : 500;
      res.status(status).json({ success: false, error: error.message });
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
      if (error instanceof SquareReauthRequiredError) {
        return res.status(401).json({
          success: false,
          errorCode: "square_reauth_required",
          error: "Square connection expired — please reconnect.",
        });
      }
      console.error("[API] Error syncing barber transactions:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/barbers/:barberGhlId/square/backfill
  // Backfill historical Square transactions (from 2026-01-01 by default).
  // Processes in monthly chunks to handle large volumes.
  // Body: { startDate?, endDate? }
  app.post("/api/barbers/:barberGhlId/square/backfill", async (req, res) => {
    req.setTimeout(300000);
    res.setTimeout(300000);

    try {
      const { barberGhlId } = req.params;
      const { startDate, endDate } = req.body;
      const result = await backfillBarberTransactions(barberGhlId, {
        startDate,
        endDate,
      });
      res.json({ success: true, ...result });
    } catch (error) {
      if (error instanceof SquareReauthRequiredError) {
        return res.status(401).json({
          success: false,
          errorCode: "square_reauth_required",
          error: "Square connection expired — please reconnect.",
        });
      }
      console.error("[API] Error backfilling barber transactions:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // GET /api/barbers/:barberGhlId/has-transactions
  // Returns whether a barber has ANY existing transaction rows. Used by the iOS
  // app to distinguish first-time setup (needs backfill) from a re-auth scenario
  // (already has data, skip the backfill prompt).
  app.get("/api/barbers/:barberGhlId/has-transactions", async (req, res) => {
    try {
      const { barberGhlId } = req.params;
      const { supabase } = require("../clients/supabaseClient");
      const { count, error } = await supabase
        .from("transactions")
        .select("id", { count: "exact", head: true })
        .eq("artist_ghl_id", barberGhlId);
      if (error) throw error;
      res.json({ success: true, hasTransactions: (count || 0) > 0, count: count || 0 });
    } catch (error) {
      console.error("[API] Error checking has-transactions:", error.message);
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
            cashTipCents: match.cashTipCents,
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

  // GET /api/barbers/:barberGhlId/venmo/unreviewed
  // Fetch Venmo payments that need manual review (unmatched contact or no appointment).
  app.get("/api/barbers/:barberGhlId/venmo/unreviewed", async (req, res) => {
    try {
      const { barberGhlId } = req.params;
      const { supabase } = require("../clients/supabaseClient");

      const { data, error } = await supabase
        .from("transactions")
        .select("*")
        .eq("artist_ghl_id", barberGhlId)
        .eq("payment_method", "venmo")
        .or("contact_id.eq.venmo_unmatched,appointment_id.is.null")
        .order("session_date", { ascending: false });

      if (error) throw new Error(error.message);

      const payments = (data || []).map((tx) => ({
        supabaseId: tx.id,
        venmoTransactionId: tx.venmo_transaction_id,
        amountCents: Math.round((tx.gross_amount || 0) * 100),
        serviceCents: tx.service_price ? Math.round(tx.service_price * 100) : null,
        tipCents: tx.tip_amount ? Math.round(tx.tip_amount * 100) : null,
        createdAt: tx.square_payment_time || tx.created_at,
        senderName: tx.contact_name,
        note: tx.notes,
        contactId: tx.contact_id,
        contactName: tx.contact_name,
        appointmentId: tx.appointment_id,
        sessionDate: tx.session_date,
        storyUrl: tx.venmo_story_url || null,
        profilePicUrl: tx.venmo_profile_pic_url || null,
      }));

      console.log(`[API] Venmo unreviewed for ${barberGhlId}: ${payments.length} payments`);
      res.json({ success: true, payments });
    } catch (error) {
      console.error("[API] Error fetching unreviewed Venmo payments:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/barbers/:barberGhlId/venmo/confirm
  // Confirm/match Venmo payments by updating existing Supabase records.
  // Body: { matches: [{ supabaseId, contactId, contactName, appointmentId?, calendarId? }], walkIns: [{ supabaseId }] }
  app.post("/api/barbers/:barberGhlId/venmo/confirm", async (req, res) => {
    try {
      const { barberGhlId } = req.params;
      const { matches = [], walkIns = [] } = req.body;
      const { supabase } = require("../clients/supabaseClient");

      const results = { confirmed: 0, walkInsRecorded: 0, errors: [] };

      // Process matches — update contact, appointment, and recalculate tip/service split
      const { lookupServicePrice } = require("../config/barberServicePrices");

      for (const match of matches) {
        try {
          const updateFields = {
            contact_id: match.contactId,
            contact_name: match.contactName || null,
          };
          if (match.appointmentId) updateFields.appointment_id = match.appointmentId;
          if (match.calendarId) updateFields.calendar_id = match.calendarId;
          // Allow overriding session_date for late payments matched to past appointments
          if (match.sessionDate) updateFields.session_date = match.sessionDate;

          // Cash tip (extra cash on top of electronic payment)
          const cashTip = match.cashTipCents ? match.cashTipCents / 100 : 0;

          // Manual slider override takes priority
          if (match.servicePriceCents != null && match.tipAmountCents != null) {
            updateFields.service_price = match.servicePriceCents / 100;
            updateFields.tip_amount = match.tipAmountCents / 100 + cashTip;
          } else if (match.calendarId) {
            // Auto-recalculate split using calendar price (match may have changed appointment)
            const calendarPrice = await lookupServicePrice(match.calendarId);
            if (calendarPrice) {
              // Fetch the existing gross_amount
              const { data: existing } = await supabase
                .from("transactions")
                .select("gross_amount")
                .eq("id", match.supabaseId)
                .maybeSingle();
              const grossAmount = existing?.gross_amount || 0;
              if (grossAmount >= calendarPrice) {
                updateFields.service_price = calendarPrice;
                updateFields.tip_amount = +(grossAmount - calendarPrice).toFixed(2) + cashTip;
              }
            }
          } else if (cashTip > 0) {
            // No slider and no calendar — just add cash tip to existing tip
            const { data: existing } = await supabase
              .from("transactions")
              .select("tip_amount")
              .eq("id", match.supabaseId)
              .maybeSingle();
            updateFields.tip_amount = (existing?.tip_amount || 0) + cashTip;
          }

          // Add cash tip to gross_amount
          if (cashTip > 0) {
            const { data: existing } = await supabase
              .from("transactions")
              .select("gross_amount")
              .eq("id", match.supabaseId)
              .maybeSingle();
            const currentGross = existing?.gross_amount || 0;
            updateFields.gross_amount = currentGross + cashTip;
            updateFields.artist_amount = currentGross + cashTip;
          }

          const { error } = await supabase
            .from("transactions")
            .update(updateFields)
            .eq("id", match.supabaseId)
            .eq("artist_ghl_id", barberGhlId);

          if (error) throw new Error(error.message);
          results.confirmed++;
        } catch (err) {
          results.errors.push({ supabaseId: match.supabaseId, error: err.message });
        }
      }

      // Process walk-ins — mark as walk-in
      for (const walkIn of walkIns) {
        try {
          const { error } = await supabase
            .from("transactions")
            .update({ contact_id: "walk_in", contact_name: "Walk-in" })
            .eq("id", walkIn.supabaseId)
            .eq("artist_ghl_id", barberGhlId);

          if (error) throw new Error(error.message);
          results.walkInsRecorded++;
        } catch (err) {
          results.errors.push({ supabaseId: walkIn.supabaseId, error: err.message });
        }
      }

      console.log(`[API] Venmo confirm for ${barberGhlId}: ${results.confirmed} confirmed, ${results.walkInsRecorded} walk-ins, ${results.errors.length} errors`);
      res.json({ success: results.errors.length === 0, ...results });
    } catch (error) {
      console.error("[API] Error confirming Venmo payments:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // PATCH /api/transactions/:id/cash-tip
  // Add or update a cash tip on an already-confirmed transaction.
  // Body: { cashTipCents: number }
  app.patch("/api/transactions/:id/cash-tip", async (req, res) => {
    try {
      const { id } = req.params;
      const { cashTipCents } = req.body;
      const { supabase } = require("../clients/supabaseClient");

      if (cashTipCents == null || cashTipCents < 0) {
        return res.status(400).json({ success: false, error: "cashTipCents is required and must be >= 0" });
      }

      // Fetch existing transaction
      const { data: tx, error: fetchErr } = await supabase
        .from("transactions")
        .select("gross_amount, tip_amount, service_price")
        .eq("id", id)
        .maybeSingle();

      if (fetchErr) throw new Error(fetchErr.message);
      if (!tx) return res.status(404).json({ success: false, error: "Transaction not found" });

      const cashTip = cashTipCents / 100;
      // Recalculate: new tip = service-derived tip + cash tip
      // service-derived tip = gross - service_price (before any previous cash tip)
      const servicePrice = tx.service_price || 0;
      const electronicTip = Math.max(0, (tx.gross_amount || 0) - servicePrice - (tx.tip_amount || 0) > -0.01 ? (tx.tip_amount || 0) : 0);
      // For simplicity: just set tip_amount and adjust gross
      // Previous tip included any old cash tip, so we need the base electronic tip
      // Base electronic tip = gross - service - old_cash_tip... but we don't track cash tip separately
      // Simplest approach: add the cash tip on top of current tip and gross
      const newTip = (tx.tip_amount || 0) + cashTip;
      const newGross = (tx.gross_amount || 0) + cashTip;

      const { error: updateErr } = await supabase
        .from("transactions")
        .update({
          tip_amount: newTip,
          gross_amount: newGross,
          artist_amount: newGross,
        })
        .eq("id", id);

      if (updateErr) throw new Error(updateErr.message);

      console.log(`[API] Added cash tip $${cashTip.toFixed(2)} to transaction ${id}. New tip: $${newTip.toFixed(2)}, new gross: $${newGross.toFixed(2)}`);
      res.json({ success: true, newTipAmount: newTip, newGrossAmount: newGross });
    } catch (error) {
      console.error("[API] Error adding cash tip:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // DELETE /api/transactions/:id
  // Delete a manually-created transaction (cash/venmo/zelle recorded from the app).
  app.delete("/api/transactions/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { supabase } = require("../clients/supabaseClient");

      // Fetch the transaction to verify it exists and is a manual type
      const { data: tx, error: fetchErr } = await supabase
        .from("transactions")
        .select("id, payment_method, square_payment_id")
        .eq("id", id)
        .maybeSingle();

      if (fetchErr) throw new Error(fetchErr.message);
      if (!tx) return res.status(404).json({ success: false, error: "Transaction not found" });

      const { error: deleteErr } = await supabase
        .from("transactions")
        .delete()
        .eq("id", id);

      if (deleteErr) throw new Error(deleteErr.message);

      console.log(`[API] Deleted transaction ${id} (method: ${tx.payment_method})`);
      res.json({ success: true });
    } catch (error) {
      console.error("[API] Error deleting transaction:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // PATCH /api/transactions/:id/split
  // Adjust the service/tip split on an already-confirmed transaction.
  // Body: { serviceCents: number, tipCents: number }
  app.patch("/api/transactions/:id/split", async (req, res) => {
    try {
      const { id } = req.params;
      const { serviceCents, tipCents } = req.body;
      const { supabase } = require("../clients/supabaseClient");

      if (serviceCents == null || tipCents == null) {
        return res.status(400).json({ success: false, error: "serviceCents and tipCents are required" });
      }
      if (serviceCents < 0 || tipCents < 0) {
        return res.status(400).json({ success: false, error: "serviceCents and tipCents must be >= 0" });
      }

      // Fetch existing transaction
      const { data: tx, error: fetchErr } = await supabase
        .from("transactions")
        .select("gross_amount, service_price, tip_amount")
        .eq("id", id)
        .maybeSingle();

      if (fetchErr) throw new Error(fetchErr.message);
      if (!tx) return res.status(404).json({ success: false, error: "Transaction not found" });

      const servicePrice = serviceCents / 100;
      const tipAmount = tipCents / 100;
      const newGross = servicePrice + tipAmount;

      const { error: updateErr } = await supabase
        .from("transactions")
        .update({
          service_price: servicePrice,
          tip_amount: tipAmount,
          gross_amount: newGross,
          artist_amount: newGross,
        })
        .eq("id", id);

      if (updateErr) throw new Error(updateErr.message);

      console.log(`[API] Adjusted split for transaction ${id}. Service: $${servicePrice.toFixed(2)}, Tip: $${tipAmount.toFixed(2)}, Gross: $${newGross.toFixed(2)}`);
      res.json({ success: true, servicePrice, tipAmount, grossAmount: newGross });
    } catch (error) {
      console.error("[API] Error adjusting split:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ─── VENMO CONNECTION MANAGEMENT ────────────────────────────────────────────

  // GET /api/barbers/:barberGhlId/venmo/status
  app.get("/api/barbers/:barberGhlId/venmo/status", async (req, res) => {
    try {
      const { barberGhlId } = req.params;
      const { createClient } = require("@supabase/supabase-js");
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

      const { data, error } = await supabase
        .from("venmo_connections")
        .select("*")
        .eq("barber_ghl_id", barberGhlId)
        .maybeSingle();

      if (error) throw error;

      if (!data || data.status === "disconnected") {
        return res.json({
          success: true,
          connected: false,
          forwardingEmail: null,
          venmoDisplayName: null,
          hasCompletedOnboarding: false,
          hasCompletedCsvImport: false,
          connectedAt: null,
          lastPaymentAt: null,
        });
      }

      res.json({
        success: true,
        connected: true,
        forwardingEmail: data.forwarding_email,
        venmoDisplayName: data.venmo_display_name,
        hasCompletedOnboarding: data.has_completed_onboarding,
        hasCompletedCsvImport: data.has_completed_csv_import,
        connectedAt: data.connected_at,
        lastPaymentAt: data.last_payment_at,
      });
    } catch (error) {
      console.error("[API] Error fetching Venmo status:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/barbers/:barberGhlId/venmo/connect
  app.post("/api/barbers/:barberGhlId/venmo/connect", async (req, res) => {
    try {
      const { barberGhlId } = req.params;
      const { forwardingEmail, venmoDisplayName } = req.body;
      const { createClient } = require("@supabase/supabase-js");
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

      if (!forwardingEmail) {
        return res.status(400).json({ success: false, error: "forwardingEmail is required" });
      }

      const BARBER_LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID;

      // Upsert into venmo_connections
      const { error } = await supabase
        .from("venmo_connections")
        .upsert({
          barber_ghl_id: barberGhlId,
          forwarding_email: forwardingEmail.toLowerCase().trim(),
          venmo_display_name: venmoDisplayName || null,
          status: "active",
          has_completed_onboarding: true,
          location_id: BARBER_LOCATION_ID,
          connected_at: new Date().toISOString(),
        }, { onConflict: "barber_ghl_id" });

      if (error) throw error;

      console.log(`[API] Venmo connected for ${barberGhlId}: ${forwardingEmail}`);
      res.json({
        success: true,
        cloudmailinAddress: "788b0d92b40d683887d5@cloudmailin.net",
      });
    } catch (error) {
      console.error("[API] Error connecting Venmo:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // DELETE /api/barbers/:barberGhlId/venmo/disconnect
  app.delete("/api/barbers/:barberGhlId/venmo/disconnect", async (req, res) => {
    try {
      const { barberGhlId } = req.params;
      const { createClient } = require("@supabase/supabase-js");
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

      const { error } = await supabase
        .from("venmo_connections")
        .update({ status: "disconnected", forwarding_email: null })
        .eq("barber_ghl_id", barberGhlId);

      if (error) throw error;

      console.log(`[API] Venmo disconnected for ${barberGhlId}`);
      res.json({ success: true });
    } catch (error) {
      console.error("[API] Error disconnecting Venmo:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/barbers/:barberGhlId/venmo/csv-import
  // Accepts multipart CSV file upload, parses, filters, and imports to Supabase
  app.post("/api/barbers/:barberGhlId/venmo/csv-import", async (req, res) => {
    try {
      const { barberGhlId } = req.params;
      const { createClient } = require("@supabase/supabase-js");
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const { parseVenmoCSV } = require("../payments/venmoCsvParser");
      const { ghlBarber } = require("../clients/ghlMultiLocationSdk");
      const { fetchAppointmentsForDateRange } = require("../clients/ghlCalendarClient");
      const { toLocalDate } = require("../payments/squareTransactionSync");

      const BARBER_LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID;

      // Get barber's Venmo display name from venmo_connections
      const { data: conn } = await supabase
        .from("venmo_connections")
        .select("venmo_display_name")
        .eq("barber_ghl_id", barberGhlId)
        .maybeSingle();

      const barberVenmoName = conn?.venmo_display_name || "";

      // Parse CSV from request body (expect { csv: "..." } as JSON or raw text)
      let csvString = "";
      if (req.body?.csv) {
        csvString = req.body.csv;
      } else if (typeof req.body === "string") {
        csvString = req.body;
      } else {
        return res.status(400).json({ success: false, error: "No CSV data provided. Send as { csv: '...' }" });
      }

      const { rows, venmoUsername } = parseVenmoCSV(csvString, barberVenmoName);
      console.log(`[API] Venmo CSV: ${rows.length} incoming payments parsed for ${barberGhlId} (username: ${venmoUsername})`);

      // Load tenant alias map for rent-tenant filtering
      // buildAliasMap() returns a Map<string, tenant>, so use Map.keys() not Object.keys()
      let tenantAliasMap = null;
      try {
        const { db } = require("../clients/instantDb");
        const { tenants } = await db.query({ tenants: {} });
        const { buildAliasMap, matchTenant } = require("../rentTracker/tenantMatcher");
        tenantAliasMap = buildAliasMap(tenants);
        console.log(`[API] Loaded ${tenantAliasMap.size} tenant aliases for filtering`);
      } catch (err) {
        console.warn(`[API] Could not load tenant list (non-fatal): ${err.message}`);
      }

      let imported = 0;
      let duplicates = 0;
      let skippedTenant = 0;
      let skippedOutsideHours = 0;

      // Cache appointments by date to avoid repeated API calls
      const appointmentCache = {};

      for (const row of rows) {
        // Dedup check
        const { data: existing } = await supabase
          .from("transactions")
          .select("id")
          .eq("venmo_transaction_id", row.txId)
          .maybeSingle();

        if (existing) {
          duplicates++;
          continue;
        }

        // Tenant filter — use matchTenant() which handles aliases, middle initials, etc.
        if (tenantAliasMap) {
          const { matchTenant } = require("../rentTracker/tenantMatcher");
          const tenant = matchTenant(row.from, tenantAliasMap);
          if (tenant) {
            skippedTenant++;
            continue;
          }
        }

        // Working hours filter — check if payment falls within barber's shift ±1hr
        const paymentDate = new Date(row.datetime + "Z"); // treat as UTC initially
        // CSV datetimes from Venmo are in UTC
        const localDate = toLocalDate(paymentDate.toISOString());

        if (!appointmentCache[localDate]) {
          try {
            const dayStart = new Date(`${localDate}T00:00:00`);
            const dayEnd = new Date(`${localDate}T23:59:59`);
            appointmentCache[localDate] = await fetchAppointmentsForDateRange({
              locationId: BARBER_LOCATION_ID,
              startTime: dayStart.toISOString(),
              endTime: dayEnd.toISOString(),
              userId: barberGhlId,
              sdkInstance: ghlBarber,
            });
          } catch (err) {
            console.warn(`[API] Could not fetch appointments for ${localDate}: ${err.message}`);
            appointmentCache[localDate] = [];
          }
        }

        // Filter to real client appointments — exclude breaks, blocks, personal holds
        const blockedTitles = ["break", "block", "blocked", "lunch", "personal", "off"];
        const dayAppts = (appointmentCache[localDate] || []).filter((apt) => {
          if (apt.assignedUserId !== barberGhlId) return false;
          if (!["confirmed", "showed", "new"].includes(apt.appointmentStatus)) return false;
          const title = (apt.title || "").toLowerCase().trim();
          return !blockedTitles.includes(title);
        });

        // If barber has no appointments that day, skip (not a work day)
        if (dayAppts.length === 0) {
          skippedOutsideHours++;
          continue;
        }

        // Check if payment time is within working hours ±1hr buffer
        if (dayAppts.length > 0) {
          const apptTimes = dayAppts.map((a) => new Date(a.startTime).getTime());
          const earliestAppt = Math.min(...apptTimes);
          const latestAppt = Math.max(...apptTimes);
          const bufferMs = 60 * 60 * 1000; // 1 hour
          const paymentTime = paymentDate.getTime();

          if (paymentTime < earliestAppt - bufferMs || paymentTime > latestAppt + bufferMs) {
            skippedOutsideHours++;
            continue;
          }
        }

        // Contact matching — search GHL by Venmo sender name
        // IMPORTANT: contactName is ALWAYS the original Venmo sender name (row.from).
        // We never overwrite it with appointment contact info — the Venmo sender identity is sacred.
        let contactId = null;
        const contactName = row.from; // immutable — always the Venmo sender
        let appointmentId = null;
        let calendarId = null;

        // Build unclaimed appointments list first — needed for both contact matching and fallback
        let unclaimed = [];
        if (dayAppts.length > 0) {
          const { data: existingTx } = await supabase
            .from("transactions")
            .select("appointment_id")
            .eq("artist_ghl_id", barberGhlId)
            .eq("session_date", localDate)
            .not("appointment_id", "is", null);

          const claimedIds = new Set((existingTx || []).map((t) => t.appointment_id));
          unclaimed = dayAppts
            .filter((a) => !claimedIds.has(a.id))
            .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
        }

        // Normalize helper: strip periods, collapse whitespace, lowercase
        // e.g. "C.J. Washington" → "cj washington", "Pablo RP" → "pablo rp"
        const normalize = (s) => (s || "").replace(/\./g, "").replace(/\s+/g, " ").trim().toLowerCase();

        // Common nickname/diminutive pairs for first-name matching
        const nicknameMap = {
          ben: "benjamin", benjamin: "ben",
          mike: "michael", michael: "mike",
          steve: "stephen", stephen: "steve",
          steven: "steve", steve: "steven",
          matt: "matthew", matthew: "matt",
          dan: "daniel", daniel: "dan",
          dave: "david", david: "dave",
          rob: "robert", robert: "rob",
          bob: "robert",
          jim: "james", james: "jim",
          joe: "joseph", joseph: "joe",
          tom: "thomas", thomas: "tom",
          nick: "nicholas", nicholas: "nick",
          chris: "christopher", christopher: "chris",
          jon: "jonathan", jonathan: "jon",
          alex: "alexander", alexander: "alex",
          will: "william", william: "will",
          bill: "william",
          ed: "edward", edward: "ed",
          tony: "anthony", anthony: "tony",
          jake: "jacob", jacob: "jake",
          josh: "joshua", joshua: "josh",
          sam: "samuel", samuel: "sam",
          zac: "zachary", zach: "zachary", zachary: "zach",
          drew: "andrew", andrew: "drew",
          pat: "patrick", patrick: "pat",
          greg: "gregory", gregory: "greg",
          jeff: "jeffrey", jeffrey: "jeff",
          larry: "lawrence", lawrence: "larry",
          rick: "richard", richard: "rick",
          dick: "richard",
          charlie: "charles", charles: "charlie",
          chuck: "charles",
          liz: "elizabeth", elizabeth: "liz",
          beth: "elizabeth",
          kate: "katherine", katherine: "kate",
          katie: "katherine",
          jen: "jennifer", jennifer: "jen",
          jess: "jessica", jessica: "jess",
          dj: "d j",
        };

        // Check if two names match, considering nicknames
        // Compares last names exactly, first names with nickname fallback
        const namesMatch = (name1, name2) => {
          const parts1 = name1.split(" ");
          const parts2 = name2.split(" ");
          if (parts1.length < 2 || parts2.length < 2) return false;
          const first1 = parts1[0], last1 = parts1[parts1.length - 1];
          const first2 = parts2[0], last2 = parts2[parts2.length - 1];
          if (last1 !== last2) return false;
          if (first1 === first2) return true;
          // Check nickname variants
          return nicknameMap[first1] === first2 || nicknameMap[first2] === first1;
        };

        // Strategy 1: Match sender name against today's appointment titles directly.
        // This catches cases like "CJ Washington" → "C.J. Washington" where GHL search fails
        // due to punctuation differences. Also handles nicknames (Ben → Benjamin, etc.).
        if (unclaimed.length > 0) {
          const senderNorm = normalize(row.from);
          for (const apt of unclaimed) {
            // Appointment title often contains the contact name (e.g., "C.J. Washington" or "Haircut: Amit Sethi")
            const titleNorm = normalize(apt.title);
            if (!titleNorm) continue;
            // Check if sender name appears in title or title contains sender name
            if (titleNorm.includes(senderNorm) || senderNorm.includes(titleNorm)) {
              contactId = apt.contactId || null;
              console.log(`[API] Appointment title match: "${row.from}" → "${apt.title}" (contact: ${contactId})`);
              break;
            }
            // Check with nickname matching (e.g., "Benjamin Wright" → "Ben Wright")
            if (namesMatch(senderNorm, titleNorm)) {
              contactId = apt.contactId || null;
              console.log(`[API] Appointment nickname match: "${row.from}" → "${apt.title}" (contact: ${contactId})`);
              break;
            }
          }
        }

        // Strategy 2: GHL contact search (if appointment title match didn't work)
        if (!contactId && ghlBarber && row.from) {
          try {
            const result = await ghlBarber.contacts.getContacts({
              locationId: BARBER_LOCATION_ID,
              query: row.from,
              limit: 5,
            });
            const contacts = result?.contacts || [];
            if (contacts.length > 0) {
              const senderLower = row.from.toLowerCase().trim();
              const exactMatch = contacts.find((c) => {
                const fullName = `${c.firstName || ""} ${c.lastName || ""}`.trim().toLowerCase();
                return fullName === senderLower;
              });
              if (exactMatch) {
                contactId = exactMatch.id;
              } else if (contacts.length === 1) {
                contactId = contacts[0].id;
              }
            }

            // Fallback: Venmo names are often abbreviated (e.g., "Pablo RP" for "Pablo Ruiz Plaza").
            // If full-name search failed, try first-name-only and cross-reference with day's appointments.
            if (!contactId && row.from.includes(" ")) {
              const firstName = row.from.split(/\s+/)[0];
              const firstNameResult = await ghlBarber.contacts.getContacts({
                locationId: BARBER_LOCATION_ID,
                query: firstName,
                limit: 10,
              });
              const firstNameContacts = firstNameResult?.contacts || [];
              if (firstNameContacts.length > 0 && unclaimed.length > 0) {
                // Cross-reference: find a contact that has an unclaimed appointment today
                const apptContactIds = new Set(unclaimed.map((a) => a.contactId).filter(Boolean));
                const apptMatch = firstNameContacts.find((c) => apptContactIds.has(c.id));
                if (apptMatch) {
                  contactId = apptMatch.id;
                  console.log(`[API] First-name fallback matched "${row.from}" → ${apptMatch.firstName} ${apptMatch.lastName} (${contactId}) via appointment cross-ref`);
                }
              }
            }
          } catch (err) {
            console.warn(`[API] Contact search failed for "${row.from}": ${err.message}`);
          }
        }

        // Appointment matching
        if (unclaimed.length > 0) {
          if (contactId) {
            // We found a GHL contact — only match to THEIR appointment, never a stranger's
            const contactAppt = unclaimed.find((a) => a.contactId === contactId);
            if (contactAppt) {
              appointmentId = contactAppt.id;
              calendarId = contactAppt.calendarId || null;
            }
            // If their appointment is already claimed or doesn't exist, leave as unmatched
            // rather than grabbing someone else's appointment by proximity
          } else if (unclaimed.length > 0) {
            // No GHL contact found at all — use distance-from-end scoring as a best guess.
            // Same logic as Square batch matching: 10-min grace period before end,
            // 45-min max threshold to reject unlikely matches.
            const MAX_MATCH_DISTANCE_MIN = 45;
            const GRACE_PERIOD_MS = 10 * 60 * 1000;
            const paymentMs = paymentDate.getTime();
            let bestApt = null;
            let bestScore = Infinity;
            for (const apt of unclaimed) {
              const aptStart = new Date(apt.startTime);
              const aptEnd = apt.endTime ? new Date(apt.endTime) : new Date(aptStart.getTime() + 60 * 60 * 1000);
              const graceStart = new Date(aptEnd.getTime() - GRACE_PERIOD_MS);
              let score;
              if (paymentMs >= graceStart.getTime()) {
                score = Math.abs(paymentMs - aptEnd.getTime()) / 60000;
              } else {
                score = 1000 + (aptEnd.getTime() - paymentMs) / 60000;
              }
              if (score < bestScore) {
                bestScore = score;
                bestApt = apt;
              }
            }
            if (bestApt && bestScore <= MAX_MATCH_DISTANCE_MIN) {
              appointmentId = bestApt.id;
              calendarId = bestApt.calendarId || null;

              // Link the appointment's GHL contact for internal tracking,
              // but NEVER overwrite contactName — it stays as the Venmo sender
              if (bestApt.contactId) {
                contactId = bestApt.contactId;
              }
            }
          }
        }

        // Calculate service price and tip using calendar price when available
        const { lookupServicePrice } = require("../config/barberServicePrices");
        const calendarPrice = calendarId ? await lookupServicePrice(calendarId) : null;
        let servicePrice, tipAmount;
        if (calendarPrice && row.amount >= calendarPrice) {
          // Calendar price known — split: service = calendar price, tip = remainder
          servicePrice = calendarPrice;
          tipAmount = +(row.amount - calendarPrice).toFixed(2);
        } else {
          // No calendar or payment less than calendar price — use CSV tip column (usually 0)
          servicePrice = row.amount - row.tip;
          tipAmount = row.tip;
        }

        // CSV imports don't have the ?k= auth parameter that email-forwarded URLs do,
        // so we don't set venmo_story_url — the bare URL requires Venmo login and won't work.

        // Insert to Supabase
        const { error: insertErr } = await supabase.from("transactions").insert({
          contact_id: contactId || "venmo_unmatched",
          contact_name: contactName || row.from,
          appointment_id: appointmentId || null,
          artist_ghl_id: barberGhlId,
          transaction_type: "session_payment",
          payment_method: "venmo",
          payment_recipient: "artist_direct",
          gross_amount: row.amount,
          shop_percentage: 0,
          artist_percentage: 100,
          shop_amount: 0,
          artist_amount: row.amount,
          settlement_status: "settled",
          venmo_transaction_id: row.txId,
          session_date: localDate,
          location_id: BARBER_LOCATION_ID,
          notes: row.note || null,
          calendar_id: calendarId || null,
          service_price: servicePrice,
          tip_amount: tipAmount,
          square_payment_time: paymentDate.toISOString(),
        });

        if (insertErr) {
          console.warn(`[API] CSV insert failed for txId ${row.txId}: ${insertErr.message}`);
          continue;
        }

        imported++;
      }

      // Update venmo_connections to mark CSV import complete
      await supabase
        .from("venmo_connections")
        .update({ has_completed_csv_import: true })
        .eq("barber_ghl_id", barberGhlId);

      const total = rows.length;
      console.log(`[API] Venmo CSV import for ${barberGhlId}: ${imported} imported, ${duplicates} dups, ${skippedTenant} tenant, ${skippedOutsideHours} outside hours, ${total} total parsed`);

      res.json({
        success: true,
        imported,
        duplicates,
        skippedTenant,
        skippedOutsideHours,
        total,
      });
    } catch (error) {
      console.error("[API] Error importing Venmo CSV:", error.message);
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
  const { sendTaskAssignedNotification, sendTaskCompletedNotification, sendTaskOverdueNotification, sendTaskUrgentNotification } = require("../services/taskNotifications");
  const { TASK_TYPES, createCommandCenterTask } = require("../clients/commandCenter");
  const { generateVenmoDescription } = require("../clients/financialTracking");
  const { GHL_USER_IDS: GHL_IDS } = require("../config/constants");

  // ═══ GHL APPOINTMENT WEBHOOK (Supabase sync + reschedule detection + push) ═══
  //
  // Shared-secret auth (FAIL-OPEN until configured):
  //   - If GHL_WEBHOOK_SECRET is NOT set: accept all requests (logs a warning).
  //     This keeps the LIVE pipeline working while the secret is rolled out.
  //   - If GHL_WEBHOOK_SECRET IS set: require it via the `x-ghl-webhook-secret`
  //     header OR `?secret=` query param (GHL workflow webhooks can send either).
  //
  // Rollout is a coordinated 2-step (do NOT set the env var alone):
  //   1. Deploy this code (no behavior change — secret unset = fail-open).
  //   2. In GHL, add the header/query secret to every barbershop + tattoo
  //      appointment webhook, THEN set GHL_WEBHOOK_SECRET on Render. Enforcement
  //      turns on only once both sides match. See FRONT_DESK_DASHBOARD_PLAN.md §7.
  function ghlWebhookAuthorized(req) {
    const expected = process.env.GHL_WEBHOOK_SECRET;
    if (!expected) {
      console.warn(
        "⚠️ [GHL webhook] GHL_WEBHOOK_SECRET not set — accepting unauthenticated (fail-open). Configure to enforce."
      );
      return true;
    }
    const provided =
      req.get("x-ghl-webhook-secret") ||
      req.query.secret ||
      (req.body && req.body.webhookSecret);
    return provided === expected;
  }

  app.post("/webhooks/ghl/appointments", async (req, res) => {
    try {
      if (!ghlWebhookAuthorized(req)) {
        console.warn("🚫 [GHL webhook] Rejected — bad/missing secret");
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const { type } = req.body;

      let handledAppointment = false;
      switch (type) {
        case "AppointmentCreate":
        case "appointment.created":
          console.log("📥 Received GHL appointment webhook");
          await handleAppointmentCreated(req.body);
          handledAppointment = true;
          break;
        case "AppointmentUpdate":
        case "appointment.updated":
          console.log("📥 Received GHL appointment webhook");
          await handleAppointmentUpdated(req.body);
          handledAppointment = true;
          break;
        case "AppointmentDelete":
        case "appointment.deleted":
          console.log("📥 Received GHL appointment webhook");
          await handleAppointmentDeleted(req.body);
          handledAppointment = true;
          break;
        default:
          // Non-appointment events (ContactUpdate, OutboundMessage, etc.) — ignore silently
          break;
      }

      // Proof-of-life for the front-desk stale banner (Section 10). Only on
      // real appointment events; best-effort (touchHeartbeat never throws).
      if (handledAppointment) {
        const appt = req.body.appointment || req.body;
        const locId =
          req.body.locationId || appt.locationId || appt.location_id || null;
        if (locId) {
          const { touchHeartbeat } = require("../clients/syncHeartbeat");
          touchHeartbeat(locId, "webhook", type);
        }
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

  // ═══ TASK PUSH NOTIFICATIONS ═══

  app.post("/api/notifications/task-assigned", async (req, res) => {
    try {
      const { assigneeGhlUserId, creatorGhlUserId, creatorName, contactName, taskNote, taskId } = req.body;

      if (!assigneeGhlUserId || !creatorGhlUserId) {
        return res.status(400).json({ success: false, error: "assigneeGhlUserId and creatorGhlUserId are required" });
      }

      const result = await sendTaskAssignedNotification({
        assigneeGhlUserId,
        creatorGhlUserId,
        creatorName: creatorName || "Someone",
        contactName: contactName || "a contact",
        taskNote,
        taskId,
      });

      res.json({ success: true, ...result });
    } catch (error) {
      console.error("❌ Error sending task-assigned notification:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/notifications/task-completed", async (req, res) => {
    try {
      const { creatorGhlUserId, completerGhlUserId, completerName, contactName, taskId } = req.body;

      if (!creatorGhlUserId || !completerGhlUserId) {
        return res.status(400).json({ success: false, error: "creatorGhlUserId and completerGhlUserId are required" });
      }

      const result = await sendTaskCompletedNotification({
        creatorGhlUserId,
        completerGhlUserId,
        completerName: completerName || "Someone",
        contactName: contactName || "a contact",
        taskId,
      });

      res.json({ success: true, ...result });
    } catch (error) {
      console.error("❌ Error sending task-completed notification:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/notifications/task-overdue", async (req, res) => {
    try {
      const { assigneeGhlUserId, contactName, taskId } = req.body;

      if (!assigneeGhlUserId) {
        return res.status(400).json({ success: false, error: "assigneeGhlUserId is required" });
      }

      const result = await sendTaskOverdueNotification({
        assigneeGhlUserId,
        contactName: contactName || "a contact",
        taskId,
      });

      res.json({ success: true, ...result });
    } catch (error) {
      console.error("❌ Error sending task-overdue notification:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/notifications/task-urgent", async (req, res) => {
    try {
      const { assigneeGhlUserId, contactName, taskId } = req.body;

      if (!assigneeGhlUserId) {
        return res.status(400).json({ success: false, error: "assigneeGhlUserId is required" });
      }

      const result = await sendTaskUrgentNotification({
        assigneeGhlUserId,
        contactName: contactName || "a contact",
        taskId,
      });

      res.json({ success: true, ...result });
    } catch (error) {
      console.error("❌ Error sending task-urgent notification:", error);
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

  // ═══ CONTACT SEARCH (GHL CRM) ═══

  app.get("/api/contacts/search", async (req, res) => {
    const { q, locationId } = req.query;
    if (!q || !locationId) {
      return res.status(400).json({ success: false, error: "q and locationId are required" });
    }

    try {
      const BARBER_LOC = process.env.GHL_BARBER_LOCATION_ID;
      const isBarberLocation = locationId === BARBER_LOC;
      const sdk = isBarberLocation && ghlBarber ? ghlBarber : null;

      if (!sdk) {
        return res.status(400).json({ success: false, error: "No SDK available for this location" });
      }

      const result = await sdk.contacts.getContacts({
        locationId,
        query: q,
        limit: 20,
      });

      // Build userId → name map from cached users for assignedTo resolution
      const locationKey = isBarberLocation ? "barber" : "tattoo";
      let userNameMap = {};
      try {
        const users = await getCachedUsers(locationKey, sdk, locationId);
        for (const u of users) {
          userNameMap[u.id] = u.name || `${u.firstName || ""} ${u.lastName || ""}`.trim();
        }
      } catch (err) {
        console.warn("[ContactSearch] Failed to fetch users for assignedTo resolution:", err.message);
      }

      const titleCase = (str) => {
        if (!str) return str;
        return str.replace(/\b\w/g, (c) => c.toUpperCase());
      };

      const contacts = (result?.contacts || []).map((c) => {
        const rawName = c.contactName || `${c.firstName || ""} ${c.lastName || ""}`.trim() || null;
        return {
          id: c.id,
          locationId: c.locationId,
          contactName: titleCase(rawName),
          firstName: titleCase(c.firstName),
          lastName: titleCase(c.lastName),
          email: c.email,
          phone: c.phone,
          assignedTo: c.assignedTo,
          assignedToName: c.assignedTo ? (userNameMap[c.assignedTo] || null) : null,
          followers: c.followers,
          tags: c.tags,
        };
      });

      res.json({ success: true, contacts });
    } catch (error) {
      console.error("❌ Error searching contacts:", error.message || error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ═══ ADD FOLLOWER TO CONTACT ═══

  app.post("/api/contacts/:contactId/add-follower", async (req, res) => {
    const { contactId } = req.params;
    const { followerId, locationId } = req.body;

    if (!followerId || !locationId) {
      return res.status(400).json({ success: false, error: "followerId and locationId are required" });
    }

    try {
      const BARBER_LOC = process.env.GHL_BARBER_LOCATION_ID;
      const isBarberLocation = locationId === BARBER_LOC;
      const sdk = isBarberLocation && ghlBarber ? ghlBarber : require("../clients/ghlSdk").ghl;

      if (!sdk) {
        return res.status(400).json({ success: false, error: "No SDK available for this location" });
      }

      await sdk.contacts.addFollowersContact(
        { contactId },
        { followers: [followerId] }
      );

      res.json({ success: true });
    } catch (error) {
      console.error("❌ Error adding follower:", error.message || error);
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
      const { buildAliasMap, matchTenant, attributeToWeek, getPaymentType, toISODate, getMonday } = require("../rentTracker/tenantMatcher");

      const payload = req.body;
      console.log("\n📩 Venmo webhook received");

      // 1. Basic validation — check it's a Venmo payment notification
      // When forwarded via Hotmail, envelope.from is the forwarder's address,
      // so we also check subject + body content for "paid you".
      const envelopeFrom = payload?.envelope?.from || "";
      const headerFrom = payload?.headers?.from || "";
      const subject = payload?.headers?.subject || "";
      const bodyText = payload?.plain || payload?.html || "";

      const isFromVenmo = envelopeFrom.includes("venmo") || headerFrom.toLowerCase().includes("venmo");
      const subjectHasPaidYou = /paid you(?:r)?/i.test(subject);
      const bodyHasPaidYou = /paid you(?:r)?/i.test(bodyText);

      if (!isFromVenmo && !subjectHasPaidYou && !bodyHasPaidYou) {
        console.log("  ⚠️ Not a Venmo payment email, ignoring. From:", envelopeFrom, "| Subject:", subject);
        return res.status(200).json({ ok: true, skipped: "not-venmo" });
      }
      console.log("  ✓ Venmo payment detected (from:", isFromVenmo, "subject:", subjectHasPaidYou, "body:", bodyHasPaidYou, ")");

      // 2. Parse the email body
      const emailDate = payload?.headers?.date || null;
      // DEBUG: Log raw plain text to diagnose forwarding format
      console.log("  [DEBUG] Raw plain text (first 800 chars):", JSON.stringify((payload?.plain || "").slice(0, 800)));
      console.log("  [DEBUG] Subject:", JSON.stringify(subject));
      console.log("  [DEBUG] Headers date:", JSON.stringify(emailDate));
      // For "X paid your $Y request" emails (request-fulfillment flow), Venmo's
      // HTML body has a misleading <title> tag ("Leonel paid you $72") that would
      // make the parser think the recipient paid themselves. The subject line
      // is the only reliable source of the payer's name. Prepend it to plain
      // text so stripForwardingHeaders() can pull the correct name via its
      // existing "paid your request" subject regex.
      const plainWithSubject = subject
        ? `Subject: ${subject}\n\n${payload?.plain || ""}`
        : (payload?.plain || "");
      const parsed = parseVenmoEmail(plainWithSubject, payload?.html || "", emailDate);

      console.log("  Parsed:", {
        sender: parsed.senderName,
        amount: parsed.amount,
        note: parsed.note,
        date: parsed.date?.toISOString(),
        transactionId: parsed.transactionId,
      });

      if (!parsed.senderName || !parsed.amount) {
        console.log("  ⚠️ Could not parse sender or amount, skipping");
        return res.status(200).json({ ok: true, skipped: "parse-failed" });
      }

      // 2.5 Tattoo reconciliation routing (Phase 5)
      // Before tenant matching, check if this is a tattoo-finance reconciliation
      // payment (note has [a:XXXNNNN] code or "StudioAZ Recon" text). If so,
      // route to the recon handler. Otherwise fall through to rent/barber logic.
      const { looksLikeReconciliation } = require("../services/reconciliationVenmoParser");
      const noteAndBody = `${parsed.note || ""} ${payload?.plain || ""}`;
      if (looksLikeReconciliation(noteAndBody)) {
        console.log("  💰 [Recon] Reconciliation candidate detected — routing to handler");
        const { handleReconciliationVenmoEmail } = require("../services/reconciliationVenmoHandler");
        const result = await handleReconciliationVenmoEmail({
          parsed,
          rawPlain: payload?.plain || "",
          rawHtml: payload?.html || "",
          emailDate,
          rawPayload: payload,
        });
        return res.status(200).json({ ok: true, recon: true, ...result });
      }

      // 3. Load tenants and match
      const { tenants } = await db.query({ tenants: {} });
      const aliasMap = buildAliasMap(tenants);
      const tenant = matchTenant(parsed.senderName, aliasMap);

      if (!tenant) {
        // Not a known tenant — likely a client paying a barber for services
        // Identify which barber forwarded the email via envelope.from (dynamic lookup)
        const { createClient: createSupa } = require("@supabase/supabase-js");
        const supa = createSupa(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        const forwarderEmail = (payload?.envelope?.from || "").toLowerCase().trim();
        const { data: venmoConn } = await supa
          .from("venmo_connections")
          .select("barber_ghl_id")
          .eq("forwarding_email", forwarderEmail)
          .eq("status", "active")
          .maybeSingle();
        const barberGhlId = venmoConn?.barber_ghl_id;
        if (!barberGhlId) {
          console.log(`  ⚠️ No tenant match and unknown forwarder (${forwarderEmail}), skipping`);
          return res.status(200).json({ ok: true, skipped: "no-tenant-no-barber", sender: parsed.senderName });
        }
        console.log(`  📋 No tenant match — routing to barbershop handler for barber ${barberGhlId}`);
        const { handleBarberVenmoPayment } = require("../payments/venmoBarberPayment");
        const result = await handleBarberVenmoPayment({ parsed, barberGhlId });
        console.log(`  Result:`, result);
        return res.status(200).json({ ok: true, ...result });
      }

      console.log(`  ✅ Matched to tenant: ${tenant.name}`);

      // 4. Check for duplicates — by real Venmo transaction ID, then dedup key, then tenant+amount+week
      // Prefer real Venmo transaction ID (e.g. "4543609756456913145") over synthetic dedup key
      const venmoTxId = parsed.transactionId || generateDedup(parsed.senderName, parsed.amount, parsed.date, parsed.note);

      const { payments: existingByTxId } = await db.query({
        payments: {
          $: { where: { venmoTxId } },
        },
      });

      if (existingByTxId.length > 0) {
        console.log(`  ⚠️ Duplicate detected by venmoTxId (${venmoTxId}), skipping`);
        return res.status(200).json({ ok: true, skipped: "duplicate", venmoTxId });
      }

      // 5. Determine week attribution
      // Fetch tenant's recent payments for late-payment detection + duplicate check
      const paymentDate = parsed.date || new Date();
      const lookbackDate = new Date(paymentDate);
      lookbackDate.setDate(lookbackDate.getDate() - 35);
      const lookbackWeek = toISODate(getMonday(lookbackDate));

      const { payments: recentTenantPayments } = await db.query({
        payments: {
          $: { where: { weekOf: { $gte: lookbackWeek } } },
          tenant: {},
        },
      });
      const tenantRecentPayments = recentTenantPayments.filter((p) => {
        const t = Array.isArray(p.tenant) ? p.tenant[0] : p.tenant;
        return t && t.id === tenant.id;
      });
      const paidWeeks = tenantRecentPayments.map((p) => p.weekOf);

      const { weekOf, attribution } = attributeToWeek(
        parsed.amount,
        parsed.note,
        paymentDate,
        tenant,
        paidWeeks,
      );

      // Check if a payment already exists for this tenant+amount+week (CSV import or prior webhook)
      const alreadyExists = tenantRecentPayments.some(
        (p) => p.weekOf === weekOf && Math.abs(p.amount - parsed.amount) < 1,
      );

      if (alreadyExists) {
        console.log(`  ⚠️ Payment already exists for ${tenant.name} in week ${weekOf} ($${parsed.amount}), skipping`);
        return res.status(200).json({ ok: true, skipped: "already-recorded", tenant: tenant.name, weekOf });
      }
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
            venmoTxId,
            venmoStoryUrl: parsed.storyUrl || undefined,
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

  // POST /api/rent-tracker/sync-square-to-instantdb
  // Pull Lionel's transactions from Supabase and backfill to InstantDB serviceIncome.
  // Does NOT call Square API — only reads from Supabase (source of truth).
  app.post("/api/rent-tracker/sync-square-to-instantdb", async (req, res) => {
    try {
      const { createClient } = require("@supabase/supabase-js");
      const { writeServiceIncome, LIONEL_GHL_ID } = require("../rentTracker/serviceIncomeWriter");
      const { weekOfDate } = require("../rentTracker/tenantMatcher");

      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      );

      const { startDate, endDate } = req.body;
      const start = startDate || "2026-01-01";
      const end = endDate || new Date().toISOString().slice(0, 10);

      console.log(`\n📊 Syncing Supabase → InstantDB for Lionel (${start} to ${end})`);

      // Fetch all of Lionel's transactions from Supabase
      const { data: transactions, error } = await supabase
        .from("transactions")
        .select("*")
        .eq("artist_ghl_id", LIONEL_GHL_ID)
        .gte("session_date", start)
        .lte("session_date", end)
        .order("session_date", { ascending: false });

      if (error) {
        console.error("  ❌ Supabase query failed:", error.message);
        return res.status(500).json({ success: false, error: error.message });
      }

      console.log(`  Found ${transactions.length} transactions in Supabase`);

      let written = 0;
      let skipped = 0;
      let errors = 0;

      for (const tx of transactions) {
        try {
          // Map Supabase transaction_type to InstantDB type
          let type = "service";
          if (tx.transaction_type === "deposit") type = "deposit";
          else if (tx.transaction_type === "product_sale") type = "product_sale";

          const paidAt = tx.square_payment_time
            ? new Date(tx.square_payment_time)
            : tx.session_date
              ? new Date(tx.session_date + "T12:00:00")
              : new Date();

          const result = await writeServiceIncome({
            senderName: tx.contact_name || "Unknown",
            amount: parseFloat(tx.gross_amount) || 0,
            method: tx.payment_method || "square",
            type,
            paidAt,
            notes: tx.notes || null,
            squarePaymentId: tx.square_payment_id || undefined,
            venmoTxId: tx.venmo_transaction_id || undefined,
            weekOf: tx.session_date ? weekOfDate(new Date(tx.session_date + "T12:00:00")) : weekOfDate(paidAt),
            location: tx.location_id === "mUemx2jG4wly4kJWBkI4" ? "tattoo" : "barbershop",
            tipAmount: parseFloat(tx.tip_amount) || 0,
            servicePriceAmount: parseFloat(tx.service_price) || undefined,
          });

          if (result.written) {
            written++;
          } else {
            skipped++;
          }
        } catch (err) {
          errors++;
          console.warn(`  ⚠️ Failed to write tx ${tx.id}: ${err.message}`);
        }
      }

      // Auto-verify any existing unverified Square records
      const { db } = require("../clients/instantDb");
      const { serviceIncome: unverified } = await db.query({
        serviceIncome: { $: { where: { method: "square", verified: false } } },
      });
      let autoVerified = 0;
      if (unverified.length > 0) {
        const txns = unverified.map((r) =>
          db.tx.serviceIncome[r.id].update({ verified: true })
        );
        await db.transact(txns);
        autoVerified = unverified.length;
        console.log(`  ✅ Auto-verified ${autoVerified} existing Square records`);
      }

      console.log(`  ✅ Sync complete: ${written} written, ${skipped} skipped (dupes), ${errors} errors`);

      return res.json({
        success: true,
        total: transactions.length,
        written,
        skipped,
        errors,
        autoVerified,
      });
    } catch (error) {
      console.error("❌ Supabase→InstantDB sync error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // END MERGED WEBHOOK SERVER ROUTES
  // ═══════════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════════
  // KIOSK CHECK-IN ENDPOINTS
  // iPad reception kiosk for barbershop + tattoo shop
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * POST /api/kiosk/check-in
   * Appointment check-in — sets "Here" custom field on contact, marks appointment
   * as "showed", and sends push notification to the barber/artist.
   *
   * Body params:
   *   ghlUserId     — barber/artist GHL user ID
   *   customerName  — display name for push notification
   *   location      — "barbershop" or "tattoo"
   *   type          — "appointment" (normal) or "name_only" (fallback with custom field alert)
   *   appointmentId — (optional) if known from carousel, skip name-based matching
   *   contactId     — (optional) for setting custom fields on the contact
   */
  app.post("/api/kiosk/check-in", async (req, res) => {
    const { ghlUserId, customerName, location, type, appointmentId: knownApptId, contactId } = req.body;

    if (!ghlUserId || !customerName || !location) {
      return res.status(400).json({
        success: false,
        error: "ghlUserId, customerName, and location are required",
      });
    }

    try {
      const { supabase } = require("../clients/supabaseClient");
      const apnsService = require("../services/apnsService");
      const { BARBER_LOCATION_ID } = require("../config/kioskConfig");

      const isBarbershop = location === "barbershop";
      const sdkInstance = isBarbershop ? ghlBarber : undefined;
      const sdk = sdkInstance || require("../clients/ghlSdk").ghl;

      const CHECK_IN_FIELD_ID = "J78FOcL9lie4BKji08gs"; // barbershop
      const TATTOO_CHECK_IN_FIELD_ID = "sPhtINDWyvqVkFyZ9ILY"; // tattoo
      const WALK_IN_SERVICE_FIELD_ID = "ez95QC6Ois2V2uAFQUGY";

      let matchedAppointmentId = knownApptId || null;
      let matchedContactId = contactId || null;

      // 1. If appointmentId is provided (from carousel), use it directly.
      //    Otherwise fall back to name-based matching for tattoo check-ins.
      //
      //    NOTE: We do NOT mark the appointment as "showed" in GHL here.
      //    The kiosk check-in is an operational record (checked_in_at in Supabase),
      //    not a source of truth for appointment status. The "showed" status change
      //    was triggering GHL AppointmentUpdate webhooks that upserted rows into
      //    Supabase with incorrect created_at timestamps, corrupting utilization data.
      //    Appointment status should be managed by GHL's own flows or the barber.
      if (matchedAppointmentId) {
        // Fetch appointment to get contactId if we don't have it
        if (!matchedContactId) {
          try {
            const apptData = await sdk.calendars.getAppointment({ eventId: matchedAppointmentId });
            const evt = apptData?.appointment || apptData?.event || apptData;
            const apptContact = evt?.contactId || evt?.contact?.id;
            if (apptContact) {
              matchedContactId = apptContact;
              console.log(`✅ [KIOSK] Extracted contactId ${matchedContactId} from appointment`);
            } else {
              console.log(`⚠️ [KIOSK] getAppointment returned no contactId. Keys:`, Object.keys(apptData || {}));
            }
          } catch (fetchErr) {
            console.error("⚠️ [KIOSK] Could not fetch appointment for contactId:", fetchErr.message);
          }
        }
        console.log(`✅ [KIOSK] Appointment ${matchedAppointmentId} matched for ${customerName} (check-in only, no GHL status change)`);
      } else if (type !== "name_only") {
        // Legacy fallback: match by name (used by tattoo check-in)
        try {
          const locationId = isBarbershop ? BARBER_LOCATION_ID : process.env.GHL_LOCATION_ID;
          const now = new Date();
          const startOfDay = new Date(now);
          startOfDay.setHours(0, 0, 0, 0);
          const endOfDay = new Date(now);
          endOfDay.setHours(23, 59, 59, 999);

          const events = await fetchAppointmentsForDateRange({
            locationId,
            startTime: startOfDay.toISOString(),
            endTime: endOfDay.toISOString(),
            userId: ghlUserId,
            sdkInstance,
          });

          const inputFirst = customerName.trim().split(/\s+/)[0].toLowerCase();
          const match = events.find((evt) => {
            if (evt.appointmentStatus === "cancelled" || evt.appointmentStatus === "noshow") return false;
            const contactName = evt.contact?.name || evt.title || "";
            const contactFirst = contactName.trim().split(/\s+/)[0].toLowerCase();
            return contactFirst === inputFirst;
          });

          if (match) {
            matchedAppointmentId = match.id;
            matchedContactId = matchedContactId || match.contact?.id;
            // NOTE: No longer marking as "showed" in GHL — kiosk only records checked_in_at
            console.log(`✅ [KIOSK] Matched appointment ${match.id} for ${customerName} via name lookup (check-in only, no GHL status change)`);
          }
        } catch (apptErr) {
          console.error("⚠️ [KIOSK] Appointment lookup/update failed:", apptErr.message);
        }
      }

      // 2. Set custom field on the contact
      if (matchedContactId && isBarbershop) {
        try {
          if (type === "name_only") {
            // Fallback flow — alert barber with walk-in service field
            await ghlBarber.contacts.updateContact(
              { contactId: matchedContactId },
              {
                assignedTo: ghlUserId,
                customFields: [
                  { id: WALK_IN_SERVICE_FIELD_ID, field_value: "question. Check with them quick" },
                ],
              }
            );
            console.log(`✅ [KIOSK] Set alert custom field on contact ${matchedContactId}`);
          } else {
            // Normal appointment check-in — set "Here" field
            const updateRes = await ghlBarber.contacts.updateContact(
              { contactId: matchedContactId },
              {
                customFields: [
                  { id: CHECK_IN_FIELD_ID, field_value: "Here" },
                ],
              }
            );
            const updatedContact = updateRes?.contact || updateRes;
            const cfAfter = updatedContact?.customFields?.find(f => f.id === CHECK_IN_FIELD_ID);
            console.log(`✅ [KIOSK] Set 'Here' custom field on contact ${matchedContactId} — response field:`, JSON.stringify(cfAfter));
          }
        } catch (cfErr) {
          console.error("⚠️ [KIOSK] Custom field update failed:", cfErr.message);
        }
      } else if (!isBarbershop) {
        // Tattoo check-in — set "Here" field on tattoo location contact using tattoo SDK
        const tattooSdk = require("../clients/ghlSdk").ghl;
        const { TATTOO_LOCATION_ID } = require("../config/kioskConfig");

        // If no contactId (name_only fallback), create a contact first
        if (!matchedContactId && type === "name_only") {
          try {
            const nameParts = customerName.trim().split(/\s+/);
            const firstName = nameParts[0];
            const lastName = nameParts.slice(1).join(" ") || "";

            const created = await tattooSdk.contacts.createContact({
              firstName,
              lastName: lastName || undefined,
              locationId: TATTOO_LOCATION_ID,
              source: "Kiosk Tattoo Check-In",
              assignedTo: ghlUserId,
              customFields: [
                { id: TATTOO_CHECK_IN_FIELD_ID, field_value: "Here" },
              ],
            });
            matchedContactId = created?.contact?.id;
            console.log(`✅ [KIOSK] Created tattoo contact ${matchedContactId} for ${customerName} with 'Here' field`);
          } catch (createErr) {
            console.error("⚠️ [KIOSK] Tattoo contact creation failed:", createErr.message);
          }
        } else if (matchedContactId) {
          // Normal tattoo check-in — update existing contact
          try {
            const updateRes = await tattooSdk.contacts.updateContact(
              { contactId: matchedContactId },
              {
                customFields: [
                  { id: TATTOO_CHECK_IN_FIELD_ID, field_value: "Here" },
                ],
              }
            );
            const updatedContact = updateRes?.contact || updateRes;
            const cfAfter = updatedContact?.customFields?.find(f => f.id === TATTOO_CHECK_IN_FIELD_ID);
            console.log(`✅ [KIOSK] Set 'Here' tattoo custom field on contact ${matchedContactId} — response field:`, JSON.stringify(cfAfter));
          } catch (cfErr) {
            console.error("⚠️ [KIOSK] Tattoo custom field update failed:", cfErr.message);
          }
        }
      }

      // 3. Write checked_in_at to Supabase appointments table
      if (matchedAppointmentId) {
        try {
          const { data: updated, error: checkinError } = await supabase
            .from("appointments")
            .update({ checked_in_at: new Date().toISOString() })
            .eq("id", matchedAppointmentId)
            .select("id");

          if (checkinError) {
            console.error("⚠️ [KIOSK] Supabase checked_in_at update error:", checkinError.message);
          } else if (!updated || updated.length === 0) {
            console.log(`⚠️ [KIOSK] Appointment ${matchedAppointmentId} not found in Supabase (GHL webhook may not have synced yet) — check-in continues`);
          } else {
            console.log(`✅ [KIOSK] Set checked_in_at on appointment ${matchedAppointmentId}`);
          }
        } catch (dbErr) {
          console.error("⚠️ [KIOSK] Supabase checked_in_at write failed:", dbErr.message);
        }
      }

      // 4. Send push notification to barber/artist
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("id")
        .eq("ghl_user_id", ghlUserId)
        .single();

      if (profileError || !profile) {
        console.log(`⚠️ [KIOSK] No profile found for GHL user ${ghlUserId} — check-in recorded without push`);
        return res.json({ success: true, notified: false, appointmentId: matchedAppointmentId });
      }

      if (apnsService.isConfigured()) {
        const { data: tokens } = await supabase
          .from("push_tokens")
          .select("token, language")
          .eq("user_id", profile.id)
          .eq("is_active", true);

        if (tokens && tokens.length > 0) {
          for (const tokenRecord of tokens) {
            try {
              const isSpanish = tokenRecord.language === 'es';
              const locationLabel = isSpanish
                ? (location === "tattoo" ? "el Estudio de Tatuajes" : "la Barbería")
                : (location === "tattoo" ? "the Tattoo Shop" : "the Barbershop");
              const notification = {
                title: isSpanish ? "Cliente Llegó" : "Client Check-In",
                body: isSpanish
                  ? `${customerName} ha llegado a ${locationLabel}`
                  : `${customerName} has arrived at ${locationLabel}`,
                data: { type: "kiosk_check_in", customerName, location, appointmentId: matchedAppointmentId },
              };
              await apnsService.sendWithRefresh(tokenRecord.token, notification);
            } catch (pushErr) {
              console.error("❌ [KIOSK] Push send error:", pushErr.message);
            }
          }
          console.log(`✅ [KIOSK] Check-in notification sent for ${customerName} → ${ghlUserId}`);
        }
      }

      return res.json({ success: true, notified: true, appointmentId: matchedAppointmentId });
    } catch (error) {
      console.error("❌ [KIOSK] Check-in error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Returns start/end of "today" in America/Chicago timezone as Date objects.
   * Handles CST/CDT correctly even on DST transition days by using
   * Intl.DateTimeFormat to get the UTC offset at specific hours.
   */
  function getTodayRangeCentral() {
    const shopTZ = "America/Chicago";
    const now = new Date();
    // Get today's date string in Central time: "YYYY-MM-DD"
    const dateStr = now.toLocaleDateString('en-CA', { timeZone: shopTZ });

    // Helper: get the UTC offset (in hours) for a given UTC instant in Central time.
    function getOffsetHours(date) {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: shopTZ,
        timeZoneName: 'shortOffset',
      }).formatToParts(date);
      const offsetPart = parts.find(p => p.type === 'timeZoneName');
      const match = offsetPart?.value.match(/GMT([+-]?\d+)/);
      return match ? parseInt(match[1], 10) : -6;
    }

    // Probe at 01:00 UTC on this date to get the offset valid at midnight Central.
    // (01:00 UTC = ~7pm previous day Central — well before any 2am DST transition)
    const probeStart = new Date(`${dateStr}T01:00:00Z`);
    const startOffset = getOffsetHours(probeStart);
    const startOffsetStr = `${startOffset < 0 ? '-' : '+'}${String(Math.abs(startOffset)).padStart(2, '0')}:00`;

    // Probe at 23:00 UTC on this date to get the offset valid at end-of-day Central.
    // (23:00 UTC = 5-6pm Central — well after any 2am DST transition)
    const probeEnd = new Date(`${dateStr}T23:00:00Z`);
    const endOffset = getOffsetHours(probeEnd);
    const endOffsetStr = `${endOffset < 0 ? '-' : '+'}${String(Math.abs(endOffset)).padStart(2, '0')}:00`;

    const startOfDay = new Date(`${dateStr}T00:00:00.000${startOffsetStr}`);
    const endOfDay = new Date(`${dateStr}T23:59:59.999${endOffsetStr}`);
    return { startOfDay, endOfDay };
  }

  // ═══════════════════════════════════════════════════════════════════
  // FRONT DESK DASHBOARD — read endpoints (Phase 1.7)
  // Read the Supabase `appointments` CACHE (fast, <100ms), NOT live GHL.
  // Webhook + reconciler keep the cache fresh. location-parameterized;
  // all dates computed server-side in Central. See
  // FRONT_DESK_DASHBOARD_PLAN.md Sections 3.2 / 12.
  // ═══════════════════════════════════════════════════════════════════
  {
    const {
      BARBER_DATA,
      BARBER_LOCATION_ID: FD_BARBER_LOC,
      TATTOO_ARTIST_DATA,
      TATTOO_LOCATION_ID: FD_TATTOO_LOC,
    } = require("../config/kioskConfig");
    const {
      centralDayRange,
      resolveCentralDate,
      nowCentral,
    } = require("../util/centralTime");

    const FD_BARBER_LOC_ID =
      process.env.GHL_BARBER_LOCATION_ID || FD_BARBER_LOC;
    const FD_TATTOO_LOC_ID = process.env.GHL_LOCATION_ID || FD_TATTOO_LOC;

    /** Map ?location= to { locationId, roster, label }. */
    function fdResolveLocation(location) {
      const loc = (location || "barbershop").toLowerCase();
      if (loc === "barbershop" || loc === FD_BARBER_LOC_ID) {
        return { locationId: FD_BARBER_LOC_ID, roster: BARBER_DATA, label: "barbershop" };
      }
      if (loc === "tattoo" || loc === FD_TATTOO_LOC_ID) {
        return { locationId: FD_TATTOO_LOC_ID, roster: TATTOO_ARTIST_DATA, label: "tattoo" };
      }
      return null;
    }

    /**
     * GET /api/frontdesk/staff?location=barbershop|tattoo
     * Roster for the grid columns. Source of truth = kioskConfig.js.
     */
    app.get("/api/frontdesk/staff", (req, res) => {
      const resolved = fdResolveLocation(req.query.location);
      if (!resolved) {
        return res.status(400).json({ success: false, error: "Invalid location" });
      }
      const staff = resolved.roster.map((m) => ({
        ghlUserId: m.ghlUserId,
        name: m.name,
        photoUrl: m.photoUrl || null,
        calendars: m.calendars || (m.calendarId ? { default: m.calendarId } : {}),
      }));
      res.json({ success: true, location: resolved.label, staff });
    });

    /**
     * GET /api/frontdesk/ping
     * Tiny heartbeat for the dashboard connection-health model (Section 10).
     */
    app.get("/api/frontdesk/ping", (req, res) => {
      res.json({ ok: true, ...nowCentral() });
    });

    /**
     * GET /api/frontdesk/schedule?location=barbershop|tattoo&date=YYYY-MM-DD
     * All appointments for that location + Central day, grouped by staff.
     * Reads the Supabase cache. `date` defaults to today (Central).
     * Surfaces off-roster assigned_user_ids instead of dropping them
     * (roster-drift guard — Section 6).
     */
    app.get("/api/frontdesk/schedule", async (req, res) => {
      try {
        if (!supabase) {
          return res.status(503).json({ success: false, error: "Supabase not configured" });
        }
        const resolved = fdResolveLocation(req.query.location);
        if (!resolved) {
          return res.status(400).json({ success: false, error: "Invalid location" });
        }

        let dateStr;
        try {
          dateStr = resolveCentralDate(req.query.date);
        } catch (e) {
          return res.status(400).json({ success: false, error: e.message });
        }
        const { startOfDay, endOfDay } = centralDayRange(dateStr);

        const { data: rows, error } = await supabase
          .from("appointments")
          .select(
            "id, title, calendar_id, contact_id, start_time, end_time, status, assigned_user_id, address, notes, checked_in_at, ghl_updated_at, updated_at"
          )
          .eq("location_id", resolved.locationId)
          .gte("start_time", startOfDay.toISOString())
          .lte("start_time", endOfDay.toISOString())
          .order("start_time", { ascending: true });

        if (error) {
          console.error("[frontdesk/schedule] supabase error:", error.message);
          return res.status(500).json({ success: false, error: error.message });
        }

        const rosterById = new Map(
          resolved.roster.map((m) => [m.ghlUserId, m])
        );

        // Block-slot classification (Section 12). GHL stores break/
        // availability "slots" in the same appointments table — they are
        // NOT client bookings. Two reliable signals (from inspecting real
        // data 2026-05-19): composite id `<id>_<epoch>_<dur>` AND/OR the
        // dedicated break calendar `lijQ2ubF4UcrHxDwfzyK`. Flag them so
        // the grid renders a hatched band, not a client card, and they're
        // excluded from the booking count.
        const BLOCK_CALENDAR_ID = "lijQ2ubF4UcrHxDwfzyK";
        const BLOCK_ID_RE = /^[A-Za-z0-9]{15,}_\d{10,}_\d+$/;
        const isBlockRow = (r) =>
          r.calendar_id === BLOCK_CALENDAR_ID || BLOCK_ID_RE.test(r.id || "");

        // Group by staff; collect off-roster assignees. Blocks stay on
        // their staffer's column (a barber's break belongs there) but are
        // tagged isBlock for the UI.
        const byStaff = new Map();
        const offRoster = new Map();
        let blockCount = 0;
        for (const r of rows || []) {
          if (isBlockRow(r)) {
            r.isBlock = true;
            blockCount++;
          }
          const uid = r.assigned_user_id || "__unassigned__";
          const known = rosterById.has(uid);
          const bucket = known ? byStaff : offRoster;
          if (!bucket.has(uid)) bucket.set(uid, []);
          bucket.get(uid).push(r);
        }

        const staff = resolved.roster.map((m) => ({
          ghlUserId: m.ghlUserId,
          name: m.name,
          photoUrl: m.photoUrl || null,
          appointments: byStaff.get(m.ghlUserId) || [],
        }));

        const offRosterColumns = [...offRoster.entries()].map(
          ([uid, appts]) => ({
            ghlUserId: uid === "__unassigned__" ? null : uid,
            name: uid === "__unassigned__" ? "Unassigned" : "Unknown staff",
            photoUrl: null,
            appointments: appts,
            offRoster: true,
          })
        );

        // Per-day newest write — informational ("data for THIS day last
        // changed at..."). NOT used for the stale banner: a quiet schedule
        // day legitimately has old per-day timestamps even when the
        // pipeline is perfectly healthy.
        let dayNewest = null;
        for (const r of rows || []) {
          const t = r.ghl_updated_at || r.updated_at;
          if (t && (!dayNewest || new Date(t) > new Date(dayNewest))) dayNewest = t;
        }

        // Staleness = "is the cache PIPELINE alive?" — answered by the
        // sync heartbeat, which advances on every webhook hit AND every
        // reconciler sweep (fixed cadence). This is the ONLY honest signal:
        // appointment-write age can't tell "sync down" from "quiet day"
        // (webhook only writes on changes). The sweep guarantees the
        // heartbeat moves even with zero bookings. (Section 10 / Section 12.)
        const { getHeartbeat } = require("../clients/syncHeartbeat");
        const heartbeatAt = await getHeartbeat(resolved.locationId);
        // Threshold > the reconciler sweep cadence (~10-15min) + slack.
        const stale =
          !heartbeatAt ||
          Date.now() - new Date(heartbeatAt).getTime() > 20 * 60 * 1000;

        res.json({
          success: true,
          location: resolved.label,
          date: dateStr,
          serverNow: nowCentral(),
          syncedAt: heartbeatAt, // pipeline proof-of-life → drives stale banner
          dayLastChanged: dayNewest, // informational: this day's newest write
          stale,
          totalAppointments: (rows || []).length - blockCount, // real bookings only
          totalRows: (rows || []).length,
          blockCount,
          staff,
          offRoster: offRosterColumns,
        });
      } catch (err) {
        console.error("❌ GET /api/frontdesk/schedule error:", err);
        res.status(500).json({ success: false, error: err.message });
      }
    });

    /**
     * POST /api/frontdesk/check-in   (Phase 2.12)
     * One-tap arrival marker. Body: { appointmentId, location,
     *   actingStaffGhlUserId?, actingStaffName?, undo? }
     *
     * Check-in is an OPERATIONAL record only — sets/clears
     * appointments.checked_in_at in Supabase, NO GHL status change
     * (mirrors the kiosk's deliberate behavior). The grid already
     * knows the exact appointmentId from the tapped card, so no
     * name/phone matching is needed.
     *
     * NOT gated by the identity wizard (Section 8.3 — high-frequency,
     * low-stakes) but still audit-logged under the session identity
     * (best-effort attribution, by design). `undo:true` clears it
     * (mis-tap recovery — the desk needs to be able to un-check-in).
     */
    app.post("/api/frontdesk/check-in", async (req, res) => {
      try {
        if (!supabase) {
          return res
            .status(503)
            .json({ success: false, error: "Supabase not configured" });
        }
        const {
          appointmentId,
          location,
          actingStaffGhlUserId = null,
          actingStaffName = null,
          undo = false,
        } = req.body || {};

        if (!appointmentId) {
          return res
            .status(400)
            .json({ success: false, error: "appointmentId is required" });
        }
        const resolved = fdResolveLocation(location);
        if (!resolved) {
          return res
            .status(400)
            .json({ success: false, error: "Invalid location" });
        }

        const checkedInAt = undo ? null : new Date().toISOString();
        const { data: updated, error: upErr } = await supabase
          .from("appointments")
          .update({ checked_in_at: checkedInAt })
          .eq("id", appointmentId)
          .eq("location_id", resolved.locationId) // scope guard
          .select("id, checked_in_at, title");

        const ok = !upErr && updated && updated.length > 0;

        // Audit (Section 8.2) — logged even though no wizard. Best-effort.
        try {
          await supabase.from("frontdesk_audit_log").insert([
            {
              location: resolved.label,
              acting_staff_ghl_user_id: actingStaffGhlUserId,
              acting_staff_name: actingStaffName,
              action: undo ? "check_in_undo" : "check_in",
              target_type: "appointment",
              target_id: appointmentId,
              summary: ok
                ? `${undo ? "Un-checked-in" : "Checked in"}: ${
                    (updated[0].title || "").trim() || appointmentId
                  }`
                : `check-in ${undo ? "undo " : ""}failed for ${appointmentId}`,
              result: ok ? "success" : "failed",
              error_text: upErr
                ? upErr.message
                : ok
                ? null
                : "appointment not found in cache",
            },
          ]);
        } catch (auditErr) {
          console.warn(
            "[frontdesk/check-in] audit insert failed (non-fatal):",
            auditErr.message
          );
        }

        if (upErr) {
          console.error("[frontdesk/check-in] update error:", upErr.message);
          return res
            .status(500)
            .json({ success: false, error: upErr.message });
        }
        if (!ok) {
          // Cache miss — webhook may not have synced this row yet.
          return res.status(404).json({
            success: false,
            error: "Appointment not found in cache",
          });
        }
        return res.json({
          success: true,
          appointmentId,
          checkedInAt: updated[0].checked_in_at,
        });
      } catch (err) {
        console.error("❌ POST /api/frontdesk/check-in error:", err);
        res.status(500).json({ success: false, error: err.message });
      }
    });

    /**
     * GET /api/frontdesk/search?location=&q=    (Phase 2.13)
     * Client lookup by name / phone / email. Thin wrapper over the
     * existing /api/contacts/search logic, but exposes the uniform
     * `location=barbershop|tattoo` param (maps it to the right SDK +
     * locationId) so the frontend API surface stays consistent.
     */
    app.get("/api/frontdesk/search", async (req, res) => {
      try {
        const q = (req.query.q || "").toString().trim();
        const resolved = fdResolveLocation(req.query.location);
        if (!resolved) {
          return res
            .status(400)
            .json({ success: false, error: "Invalid location" });
        }
        if (q.length < 2) {
          // Avoid hammering GHL on every keystroke / empty box.
          return res.json({ success: true, contacts: [] });
        }

        const isBarber = resolved.locationId === FD_BARBER_LOC_ID;
        const sdk = isBarber && ghlBarber ? ghlBarber : ghl;

        const result = await sdk.contacts.getContacts({
          locationId: resolved.locationId,
          query: q,
          limit: 20,
        });

        // Resolve assignedTo → staff name from the cached user list.
        let userNameMap = {};
        try {
          const users = await getCachedUsers(
            isBarber ? "barber" : "tattoo",
            sdk,
            resolved.locationId
          );
          for (const u of users) {
            userNameMap[u.id] =
              u.name || `${u.firstName || ""} ${u.lastName || ""}`.trim();
          }
        } catch (e) {
          console.warn(
            "[frontdesk/search] user map failed (non-fatal):",
            e.message
          );
        }

        const titleCase = (s) =>
          s ? s.replace(/\b\w/g, (c) => c.toUpperCase()) : s;
        const contacts = (result?.contacts || []).map((c) => {
          const rawName =
            c.contactName ||
            `${c.firstName || ""} ${c.lastName || ""}`.trim() ||
            null;
          return {
            id: c.id,
            contactName: titleCase(rawName),
            firstName: titleCase(c.firstName),
            lastName: titleCase(c.lastName),
            email: c.email || null,
            phone: c.phone || null,
            assignedTo: c.assignedTo || null,
            assignedToName: c.assignedTo
              ? userNameMap[c.assignedTo] || null
              : null,
            tags: c.tags || [],
          };
        });

        res.json({ success: true, location: resolved.label, contacts });
      } catch (err) {
        console.error("❌ GET /api/frontdesk/search error:", err.message || err);
        res.status(500).json({ success: false, error: err.message });
      }
    });

    /**
     * GET /api/frontdesk/contact-appointments?location=&contactId=
     * That contact's appointments, newest-first. Wrapper over the
     * existing /api/contacts/:id/appointments logic with `location=`.
     */
    app.get("/api/frontdesk/contact-appointments", async (req, res) => {
      try {
        const contactId = (req.query.contactId || "").toString();
        const resolved = fdResolveLocation(req.query.location);
        if (!contactId) {
          return res
            .status(400)
            .json({ success: false, error: "contactId is required" });
        }
        if (!resolved) {
          return res
            .status(400)
            .json({ success: false, error: "Invalid location" });
        }

        const isBarber = resolved.locationId === FD_BARBER_LOC_ID;
        let events = [];
        if (isBarber && ghlBarber) {
          const r = await ghlBarber.contacts.getAppointmentsForContact({
            contactId,
          });
          events = r?.events || [];
        } else {
          events = await listAppointmentsForContact(contactId);
        }
        events.sort(
          (a, b) => new Date(b.startTime) - new Date(a.startTime)
        );

        res.json({
          success: true,
          location: resolved.label,
          appointments: events,
        });
      } catch (err) {
        console.error(
          "❌ GET /api/frontdesk/contact-appointments error:",
          err.message || err
        );
        res.status(500).json({ success: false, error: err.message });
      }
    });

    /**
     * GET /api/frontdesk/conversation?location=&contactId=&limit=
     * Read a contact's conversation thread (Phase 2.14). Own clean
     * read — NOT via ghlClient.getConversationHistory which is
     * hardcoded to the tattoo location. Picks the right SDK by
     * location and hits /conversations/messages/export.
     */
    app.get("/api/frontdesk/conversation", async (req, res) => {
      try {
        const resolved = fdResolveLocation(req.query.location);
        const contactId = (req.query.contactId || "").toString();
        const limit = Math.max(
          10,
          Math.min(parseInt(req.query.limit, 10) || 50, 500)
        );
        if (!resolved) {
          return res
            .status(400)
            .json({ success: false, error: "Invalid location" });
        }
        if (!contactId) {
          return res
            .status(400)
            .json({ success: false, error: "contactId is required" });
        }

        const isBarber = resolved.locationId === FD_BARBER_LOC_ID;
        const sdk =
          isBarber && ghlBarber
            ? ghlBarber
            : require("../clients/ghlSdk").ghl;

        const params = new URLSearchParams({
          locationId: resolved.locationId,
          contactId,
          limit: String(limit),
          sortBy: "createdAt",
          sortOrder: "desc",
        });
        const httpClient = sdk.getHttpClient();
        const resp = await httpClient.get(
          `/conversations/messages/export?${params}`
        );
        const messages = resp.data?.messages || [];
        res.json({ success: true, location: resolved.label, messages });
      } catch (err) {
        console.error(
          "❌ GET /api/frontdesk/conversation error:",
          err.response?.data || err.message || err
        );
        res.status(500).json({
          success: false,
          error: err.response?.data?.message || err.message,
        });
      }
    });

    /**
     * POST /api/frontdesk/message   (Phase 2.14 — sends REAL SMS)
     * Body: { location, contactId, body, type?='SMS',
     *         actingStaffGhlUserId?, actingStaffName? }
     *
     * Clean human-attributed send path. **Deliberately does NOT use
     * ghlClient.sendConversationMessage** because that function:
     *   - appends the iOS AI_MESSAGE_MARKER (double-space) so iOS
     *     classifies the message as AI — desk messages are HUMAN
     *     and must NOT carry it,
     *   - temporarily reassigns the contact to the AI Bot userId
     *     (a tattoo-shop AI-setter trick the desk doesn't want),
     *   - is hardcoded to the tattoo location,
     *   - respects AI_RESPONSES_ENABLED kill switch (would block
     *     legitimate desk messages).
     *
     * Each send: identity-wizard-gated client-side; audit-logged
     * here (success AND failure) for the forensic trail.
     */
    app.post("/api/frontdesk/message", async (req, res) => {
      const {
        location,
        contactId,
        body,
        type = "SMS",
        actingStaffGhlUserId = null,
        actingStaffName = null,
      } = req.body || {};

      const resolved = fdResolveLocation(location);
      const trimmed = (body || "").trim();

      // Always write an audit row, success or failure. We resolve
      // the audit values up front so the catch can use them.
      const auditBase = {
        location: resolved?.label || (location ?? null),
        acting_staff_ghl_user_id: actingStaffGhlUserId,
        acting_staff_name: actingStaffName,
        action: "message_send",
        target_type: "contact",
        target_id: contactId || null,
        summary: trimmed
          ? `to contact ${contactId || "?"}: ${trimmed.slice(0, 80)}`
          : "empty message",
        payload: { type, len: trimmed.length },
      };

      async function logAudit(result, errorText = null) {
        if (!supabase) return;
        try {
          await supabase
            .from("frontdesk_audit_log")
            .insert([{ ...auditBase, result, error_text: errorText }]);
        } catch (e) {
          console.warn(
            "[frontdesk/message] audit insert failed (non-fatal):",
            e.message
          );
        }
      }

      try {
        if (!resolved) {
          await logAudit("failed", "Invalid location");
          return res
            .status(400)
            .json({ success: false, error: "Invalid location" });
        }
        if (!contactId) {
          await logAudit("failed", "contactId is required");
          return res
            .status(400)
            .json({ success: false, error: "contactId is required" });
        }
        if (!trimmed) {
          await logAudit("failed", "empty body");
          return res
            .status(400)
            .json({ success: false, error: "Message body is empty" });
        }

        const isBarber = resolved.locationId === FD_BARBER_LOC_ID;
        const sdk =
          isBarber && ghlBarber
            ? ghlBarber
            : require("../clients/ghlSdk").ghl;

        // The SDK posts to POST /conversations/messages. We pass NO
        // userId (the desk operator is self-identified via the wizard,
        // but isn't necessarily a GHL user; identity attribution lives
        // in the audit log, not in GHL's message envelope).
        const payload = {
          contactId,
          locationId: resolved.locationId,
          message: trimmed, // <-- NO AI marker. Critical (Section 6).
          type, // 'SMS' | 'Email' | 'WhatsApp' (default SMS)
        };
        const result = await sdk.conversations.sendANewMessage(payload);

        await logAudit("success");
        res.json({
          success: true,
          messageId:
            result?.messageId ||
            result?.id ||
            result?.data?.messageId ||
            null,
        });
      } catch (err) {
        const msg = err.response?.data?.message || err.message || String(err);
        console.error("❌ POST /api/frontdesk/message error:", msg);
        await logAudit("failed", msg);
        res.status(500).json({ success: false, error: msg });
      }
    });

    /**
     * POST /api/frontdesk/cancel   (Phase 3 — first real GHL write)
     * Body: { location, appointmentId, reason?, actionId?,
     *         actingStaffGhlUserId?, actingStaffName? }
     *
     * Sets the GHL appointment's status to "cancelled" (the webhook
     * then echoes the change back into the Supabase cache within
     * seconds — same convergence path as any other GHL-side edit).
     *
     * Wizard-gated client-side (Section 8.3). Every call writes a
     * `frontdesk_audit_log` row, success AND failure. The operation
     * is resource-idempotent (cancelling an already-cancelled appt
     * is a no-op in GHL + cache) so `actionId` is accepted for the
     * shared write-contract but not required for dedup here — book/
     * reschedule will use it for real.
     *
     * Pre-write scope guard: confirm the appointment exists in our
     * cache under this location BEFORE calling GHL. Prevents a desk
     * on the wrong location from cancelling another shop's row.
     */
    app.post("/api/frontdesk/cancel", async (req, res) => {
      const {
        location,
        appointmentId,
        reason = null,
        actionId = null,
        actingStaffGhlUserId = null,
        actingStaffName = null,
      } = req.body || {};

      const resolved = fdResolveLocation(location);
      const trimmedReason = reason ? String(reason).trim().slice(0, 200) : null;

      const auditBase = {
        location: resolved?.label || (location ?? null),
        acting_staff_ghl_user_id: actingStaffGhlUserId,
        acting_staff_name: actingStaffName,
        action: "cancel",
        target_type: "appointment",
        target_id: appointmentId || null,
        payload: {
          reason: trimmedReason,
          actionId,
        },
      };

      async function logAudit(result, summary, errorText = null) {
        if (!supabase) return;
        try {
          await supabase
            .from("frontdesk_audit_log")
            .insert([
              { ...auditBase, summary, result, error_text: errorText },
            ]);
        } catch (e) {
          console.warn(
            "[frontdesk/cancel] audit insert failed (non-fatal):",
            e.message
          );
        }
      }

      try {
        if (!supabase) {
          return res
            .status(503)
            .json({ success: false, error: "Supabase not configured" });
        }
        if (!resolved) {
          await logAudit("failed", "cancel rejected: invalid location", "Invalid location");
          return res
            .status(400)
            .json({ success: false, error: "Invalid location" });
        }
        if (!appointmentId) {
          await logAudit(
            "failed",
            "cancel rejected: missing appointmentId",
            "appointmentId is required"
          );
          return res
            .status(400)
            .json({ success: false, error: "appointmentId is required" });
        }

        // Cache lookup: scope to location + grab calendar_id (some GHL
        // clusters require it on edits — see ghlCalendarClient.js).
        const { data: cacheRow, error: cacheErr } = await supabase
          .from("appointments")
          .select("id, calendar_id, title, status, location_id")
          .eq("id", appointmentId)
          .eq("location_id", resolved.locationId)
          .maybeSingle();

        if (cacheErr) {
          await logAudit(
            "failed",
            `cancel cache lookup failed for ${appointmentId}`,
            cacheErr.message
          );
          console.error("[frontdesk/cancel] cache lookup error:", cacheErr.message);
          return res.status(500).json({ success: false, error: cacheErr.message });
        }
        if (!cacheRow) {
          await logAudit(
            "failed",
            `cancel rejected: appointment ${appointmentId} not in ${resolved.label} cache`,
            "appointment not found in cache for this location"
          );
          return res.status(404).json({
            success: false,
            error: "Appointment not found in cache for this location",
          });
        }

        // Already cancelled? — resource-idempotent: return success
        // without touching GHL again. (A duplicate click after a slow
        // first request lands here harmlessly.)
        const currentStatus = (cacheRow.status || "").toLowerCase();
        if (currentStatus === "cancelled" || currentStatus === "canceled") {
          await logAudit(
            "success",
            `cancel no-op (already cancelled): ${
              (cacheRow.title || "").trim() || appointmentId
            }`
          );
          return res.json({
            success: true,
            appointmentId,
            alreadyCancelled: true,
          });
        }

        const isBarber = resolved.locationId === FD_BARBER_LOC_ID;
        const sdk =
          isBarber && ghlBarber
            ? ghlBarber
            : require("../clients/ghlSdk").ghl;

        const payload = {
          appointmentStatus: "cancelled",
          toNotify: false,
        };
        // Include calendarId — some GHL clusters require it on edits.
        if (cacheRow.calendar_id) payload.calendarId = cacheRow.calendar_id;

        await sdk.calendars.editAppointment(
          { eventId: appointmentId },
          payload
        );

        const niceSummary = `Cancelled: ${
          (cacheRow.title || "").trim() || appointmentId
        }${trimmedReason ? ` — reason: ${trimmedReason}` : ""}`;
        await logAudit("success", niceSummary);

        // Optimistic mirror in cache so the next dashboard poll sees
        // "cancelled" immediately even if the GHL webhook is briefly
        // slow. The webhook will arrive within seconds and converge.
        try {
          await supabase
            .from("appointments")
            .update({ status: "cancelled" })
            .eq("id", appointmentId)
            .eq("location_id", resolved.locationId);
        } catch (mirrorErr) {
          console.warn(
            "[frontdesk/cancel] cache mirror failed (non-fatal — webhook will reconcile):",
            mirrorErr.message
          );
        }

        return res.json({
          success: true,
          appointmentId,
          status: "cancelled",
        });
      } catch (err) {
        const msg = err.response?.data?.message || err.message || String(err);
        console.error("❌ POST /api/frontdesk/cancel error:", msg);
        await logAudit(
          "failed",
          `cancel failed for ${appointmentId || "?"}`,
          msg
        );
        res.status(500).json({ success: false, error: msg });
      }
    });

    /**
     * POST /api/frontdesk/no-show   (Phase 3.15b)
     * Body: { location, appointmentId, reason?, actionId?,
     *         actingStaffGhlUserId?, actingStaffName? }
     *
     * Mirror of /api/frontdesk/cancel — the verb shape is identical
     * (status flip + scope guard + audit + optimistic cache mirror).
     * The only differences are:
     *   - GHL status → "noshow" (canonical value, see constants.js +
     *     every existing filter in app.js — webhook accepts the three
     *     casings inbound but we write the lowercase form),
     *   - audit `action` is "no_show" (distinct verb for the forensic
     *     trail; cancel and no-show are semantically different
     *     operational decisions even when the row ends up similarly
     *     filtered out of reports),
     *   - resource-idempotent on `status === "noshow"`,
     *   - upstream UI clears `checked_in_at` already via the
     *     appointmentWebhooks handler when status flips to noshow
     *     (see "Clear checked_in_at if appointment is cancelled or
     *     no-show" in appointmentWebhooks.js), so we don't need to
     *     do that here. The optimistic mirror sets only status.
     */
    app.post("/api/frontdesk/no-show", async (req, res) => {
      const {
        location,
        appointmentId,
        reason = null,
        actionId = null,
        actingStaffGhlUserId = null,
        actingStaffName = null,
      } = req.body || {};

      const resolved = fdResolveLocation(location);
      const trimmedReason = reason ? String(reason).trim().slice(0, 200) : null;

      const auditBase = {
        location: resolved?.label || (location ?? null),
        acting_staff_ghl_user_id: actingStaffGhlUserId,
        acting_staff_name: actingStaffName,
        action: "no_show",
        target_type: "appointment",
        target_id: appointmentId || null,
        payload: { reason: trimmedReason, actionId },
      };

      async function logAudit(result, summary, errorText = null) {
        if (!supabase) return;
        try {
          await supabase
            .from("frontdesk_audit_log")
            .insert([
              { ...auditBase, summary, result, error_text: errorText },
            ]);
        } catch (e) {
          console.warn(
            "[frontdesk/no-show] audit insert failed (non-fatal):",
            e.message
          );
        }
      }

      try {
        if (!supabase) {
          return res
            .status(503)
            .json({ success: false, error: "Supabase not configured" });
        }
        if (!resolved) {
          await logAudit("failed", "no-show rejected: invalid location", "Invalid location");
          return res
            .status(400)
            .json({ success: false, error: "Invalid location" });
        }
        if (!appointmentId) {
          await logAudit(
            "failed",
            "no-show rejected: missing appointmentId",
            "appointmentId is required"
          );
          return res
            .status(400)
            .json({ success: false, error: "appointmentId is required" });
        }

        // Cache scope guard (location + id must match an existing row).
        const { data: cacheRow, error: cacheErr } = await supabase
          .from("appointments")
          .select("id, calendar_id, title, status, location_id")
          .eq("id", appointmentId)
          .eq("location_id", resolved.locationId)
          .maybeSingle();

        if (cacheErr) {
          await logAudit(
            "failed",
            `no-show cache lookup failed for ${appointmentId}`,
            cacheErr.message
          );
          console.error("[frontdesk/no-show] cache lookup error:", cacheErr.message);
          return res.status(500).json({ success: false, error: cacheErr.message });
        }
        if (!cacheRow) {
          await logAudit(
            "failed",
            `no-show rejected: appointment ${appointmentId} not in ${resolved.label} cache`,
            "appointment not found in cache for this location"
          );
          return res.status(404).json({
            success: false,
            error: "Appointment not found in cache for this location",
          });
        }

        // Already a no-show? short-circuit success (idempotent).
        const currentStatus = (cacheRow.status || "").toLowerCase();
        if (currentStatus === "noshow") {
          await logAudit(
            "success",
            `no-show no-op (already noshow): ${
              (cacheRow.title || "").trim() || appointmentId
            }`
          );
          return res.json({
            success: true,
            appointmentId,
            alreadyNoShow: true,
          });
        }

        const isBarber = resolved.locationId === FD_BARBER_LOC_ID;
        const sdk =
          isBarber && ghlBarber
            ? ghlBarber
            : require("../clients/ghlSdk").ghl;

        const payload = {
          appointmentStatus: "noshow",
          toNotify: false,
        };
        if (cacheRow.calendar_id) payload.calendarId = cacheRow.calendar_id;

        await sdk.calendars.editAppointment(
          { eventId: appointmentId },
          payload
        );

        const niceSummary = `No-show: ${
          (cacheRow.title || "").trim() || appointmentId
        }${trimmedReason ? ` — reason: ${trimmedReason}` : ""}`;
        await logAudit("success", niceSummary);

        // Optimistic cache mirror — webhook will reconcile within
        // seconds either way; this just makes the next poll see the
        // change immediately. checked_in_at is cleared by the webhook
        // handler (appointmentWebhooks.js) when status → noshow, so
        // we don't need to touch it here.
        try {
          await supabase
            .from("appointments")
            .update({ status: "noshow" })
            .eq("id", appointmentId)
            .eq("location_id", resolved.locationId);
        } catch (mirrorErr) {
          console.warn(
            "[frontdesk/no-show] cache mirror failed (non-fatal — webhook will reconcile):",
            mirrorErr.message
          );
        }

        return res.json({
          success: true,
          appointmentId,
          status: "noshow",
        });
      } catch (err) {
        const msg = err.response?.data?.message || err.message || String(err);
        console.error("❌ POST /api/frontdesk/no-show error:", msg);
        await logAudit(
          "failed",
          `no-show failed for ${appointmentId || "?"}`,
          msg
        );
        res.status(500).json({ success: false, error: msg });
      }
    });

    // ── Phase 3.15c: BOOKING READ ENDPOINTS ─────────────────────────
    // Both endpoints below are read-only (no GHL writes, no audit).
    // The actual POST /api/frontdesk/book lands in the next chunk,
    // along with the BookingSheet UI. These two reads exist now so:
    //   - the BookingSheet can populate its service dropdown and time
    //     picker from real data while it is being built,
    //   - the user can sanity-check the data shape before any write
    //     surface lights up.

    // Pretty labels for service KEYS used in kioskConfig.calendars.
    // Keys ARE the source of truth (each barber has different keys);
    // this map just gives the dropdown a human label. New keys added
    // to kioskConfig still work — they just render with a title-cased
    // fallback label until added here.
    const FD_SERVICE_LABELS = {
      haircut: "Haircut",
      haircut_beard: "Haircut + Beard",
      beard_trim: "Beard Trim",
      grey_blending: "Grey Blending",
      neck_trim: "Neck Trim",
      haircut_fnf: "Haircut (F&F)",
      haircut_beard_fnf: "Haircut + Beard (F&F)",
    };
    function fdServiceLabel(key) {
      if (FD_SERVICE_LABELS[key]) return FD_SERVICE_LABELS[key];
      // Title-case fallback so we never render the raw key.
      return key
        .split("_")
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(" ");
    }

    // Per-process cache: calendarId → { durationMinutes, intervalMinutes, fetchedAt }.
    // GHL is slow (~1s/call) and these almost never change in a day.
    // 10-minute TTL keeps stale data short without hammering the API
    // on every staff×service combination as the dashboard is browsed.
    const fdCalendarCache = new Map();
    const FD_CAL_CACHE_TTL_MS = 10 * 60 * 1000;
    const FD_CAL_FALLBACK = { durationMinutes: 45, intervalMinutes: 15 };

    function fdNormalizeMinutes(value, unit) {
      const u = (unit || "mins").toLowerCase();
      const v = Number(value) || 0;
      if (v <= 0) return 0;
      return u.startsWith("hour") ? v * 60 : v;
    }

    async function fdGetCalendarMeta(sdk, calendarId) {
      const now = Date.now();
      const cached = fdCalendarCache.get(calendarId);
      if (cached && now - cached.fetchedAt < FD_CAL_CACHE_TTL_MS) {
        return cached;
      }
      try {
        const r = await sdk.calendars.getCalendar({ calendarId });
        const cal = r?.calendar || r;
        const dur =
          fdNormalizeMinutes(cal?.slotDuration, cal?.slotDurationUnit) ||
          FD_CAL_FALLBACK.durationMinutes;
        // slotInterval = how often a new booking can START. GHL may
        // omit it; when missing, the conventional fallback is "step
        // by duration" (back-to-back bookings, no staggered starts).
        const intRaw = fdNormalizeMinutes(
          cal?.slotInterval,
          cal?.slotIntervalUnit
        );
        const interval = intRaw > 0 ? intRaw : dur;
        const meta = {
          durationMinutes: dur,
          intervalMinutes: interval,
          fetchedAt: now,
        };
        fdCalendarCache.set(calendarId, meta);
        return meta;
      } catch (err) {
        console.warn(
          `[frontdesk] getCalendar(${calendarId}) failed, using fallback:`,
          err.response?.data?.message || err.message
        );
        const meta = { ...FD_CAL_FALLBACK, fetchedAt: now };
        fdCalendarCache.set(calendarId, meta);
        return meta;
      }
    }

    // Per-process cache: staffGhlUserId → { schedules, fetchedAt }.
    // Schedules also change rarely (weekly availability tweaks); same
    // TTL as the calendar cache.
    const fdScheduleCache = new Map();

    async function fdGetSchedulesForStaff(sdk, locationId, staffGhlUserId) {
      const cacheKey = `${locationId}::${staffGhlUserId}`;
      const now = Date.now();
      const cached = fdScheduleCache.get(cacheKey);
      if (cached && now - cached.fetchedAt < FD_CAL_CACHE_TTL_MS) {
        return cached.schedules;
      }
      try {
        const httpClient = sdk.getHttpClient();
        const resp = await httpClient.get(
          `/calendars/schedules/search?locationId=${locationId}&userId=${staffGhlUserId}`,
          { headers: { Version: "2021-04-15" } }
        );
        const schedules = resp.data?.schedules || [];
        fdScheduleCache.set(cacheKey, { schedules, fetchedAt: now });
        return schedules;
      } catch (err) {
        console.warn(
          `[frontdesk] schedules/search(${staffGhlUserId}) failed, treating as no schedule:`,
          err.response?.data?.message || err.message
        );
        fdScheduleCache.set(cacheKey, { schedules: [], fetchedAt: now });
        return [];
      }
    }

    // Resolve a calendar's bookable wall-clock intervals on a given
    // YYYY-MM-DD (Central). Returns [{ startMin, endMin }] in minutes
    // since midnight. Empty array means "no schedule found / day off"
    // — caller decides whether to show that as "outside hours" or
    // fall back to a wider default window.
    function fdOpenIntervalsForDay(schedules, calendarId, dateStr) {
      const dt = new Date(`${dateStr}T12:00:00Z`);
      const dayName = dt
        .toLocaleDateString("en-US", {
          timeZone: "America/Chicago",
          weekday: "long",
        })
        .toLowerCase();
      for (const sched of schedules) {
        const calIds = sched.calendarIds || [];
        if (!calIds.includes(calendarId)) continue;
        const rules = sched.rules || sched.schedule || [];
        const dateOverride = rules.find(
          (r) => r.type === "date" && r.date === dateStr
        );
        if (dateOverride) {
          if (
            dateOverride.intervals &&
            dateOverride.intervals.length > 0
          ) {
            return dateOverride.intervals.map((iv) => ({
              startMin: timeToMin(iv.from),
              endMin: timeToMin(iv.to),
            }));
          }
          return []; // empty override = day off
        }
        const dayRule = rules.find(
          (r) => r.type === "wday" && r.day === dayName
        );
        if (dayRule && dayRule.intervals && dayRule.intervals.length > 0) {
          return dayRule.intervals.map((iv) => ({
            startMin: timeToMin(iv.from),
            endMin: timeToMin(iv.to),
          }));
        }
        return []; // schedule covers cal but no rule for today = day off
      }
      return []; // no schedule covers this calendar at all
    }
    function timeToMin(s) {
      const [h, m] = (s || "").split(":").map(Number);
      return (h || 0) * 60 + (m || 0);
    }

    /**
     * GET /api/frontdesk/services?location=&staffGhlUserId=
     * Service catalog for one barber/artist:
     *   [{ key, calendarId, label, durationMinutes }, ...]
     *
     * Tattoo artists have a single calendar with no service key, so
     * we return one entry with key: "default" + label: "Tattoo".
     * Barbershop barbers have a map of service-key → calendarId in
     * kioskConfig; we return one entry per key.
     *
     * Durations come from GHL's calendar settings (fetched + cached
     * 10 min). The desk can override per-booking on the sheet — the
     * value here is just the default.
     */
    app.get("/api/frontdesk/services", async (req, res) => {
      try {
        const resolved = fdResolveLocation(req.query.location);
        if (!resolved) {
          return res.status(400).json({ success: false, error: "Invalid location" });
        }
        const staffId = (req.query.staffGhlUserId || "").toString();
        if (!staffId) {
          return res
            .status(400)
            .json({ success: false, error: "staffGhlUserId is required" });
        }

        const member = resolved.roster.find((m) => m.ghlUserId === staffId);
        if (!member) {
          return res
            .status(404)
            .json({ success: false, error: "Staff not on this location's roster" });
        }

        const isBarber = resolved.locationId === FD_BARBER_LOC_ID;
        const sdk =
          isBarber && ghlBarber
            ? ghlBarber
            : require("../clients/ghlSdk").ghl;

        // Build the [{ key, calendarId }] list. Barbers store a map;
        // tattoo artists store a single calendarId at the top level.
        const entries = [];
        if (member.calendars) {
          for (const [key, calendarId] of Object.entries(member.calendars)) {
            entries.push({ key, calendarId });
          }
        } else if (member.calendarId) {
          entries.push({ key: "default", calendarId: member.calendarId });
        }

        // Fetch metadata in parallel — the cache makes repeat calls cheap.
        const services = await Promise.all(
          entries.map(async ({ key, calendarId }) => {
            const meta = await fdGetCalendarMeta(sdk, calendarId);
            return {
              key,
              calendarId,
              label:
                !isBarber && key === "default"
                  ? "Tattoo"
                  : fdServiceLabel(key),
              durationMinutes: meta.durationMinutes,
              intervalMinutes: meta.intervalMinutes,
            };
          })
        );

        res.json({
          success: true,
          location: resolved.label,
          staffGhlUserId: staffId,
          staffName: member.name,
          services,
        });
      } catch (err) {
        const msg = err.response?.data?.message || err.message || String(err);
        console.error("❌ GET /api/frontdesk/services error:", msg);
        res.status(500).json({ success: false, error: msg });
      }
    });

    /**
     * GET /api/frontdesk/availability
     *   ?location=&staffGhlUserId=&calendarId=&date=YYYY-MM-DD&durationMinutes=
     *
     * Open-slot finder for ONE staff member on ONE day. Reads the
     * Supabase cache for that staff's existing appointments + blocks
     * on the day, then computes gaps wide enough for `durationMinutes`.
     * The cache is fresher than 20s in normal operation, which is fine
     * for browsing — the authoritative gate is the live re-check that
     * /book performs on confirm (Section 11). This endpoint never
     * writes anything.
     *
     * Open hours: 9am–9pm Central as a conservative default; the real
     * per-barber hours come from GHL schedules and will be wired in a
     * polish pass. Until then, slots outside the barber's real working
     * hours will still appear here — the booking write would succeed
     * (GHL doesn't reject out-of-hours bookings), so this is browse
     * convenience, not a true availability oracle.
     *
     * Past times today are excluded (no booking into the past). All
     * times in the response are ISO with offset; the UI formats them
     * in Central.
     */
    app.get("/api/frontdesk/availability", async (req, res) => {
      try {
        if (!supabase) {
          return res
            .status(503)
            .json({ success: false, error: "Supabase not configured" });
        }
        const resolved = fdResolveLocation(req.query.location);
        if (!resolved) {
          return res.status(400).json({ success: false, error: "Invalid location" });
        }
        const staffId = (req.query.staffGhlUserId || "").toString();
        const calendarId = (req.query.calendarId || "").toString();
        const rawDur = parseInt(req.query.durationMinutes, 10);
        if (!staffId || !calendarId || !Number.isFinite(rawDur) || rawDur < 5) {
          return res.status(400).json({
            success: false,
            error:
              "staffGhlUserId, calendarId required; durationMinutes must be >= 5",
          });
        }
        // Clamp the upper bound so a typo can't ask for an 8-hour
        // window. 480 = 8 hours, generous for a tattoo session.
        const durationMinutes = Math.min(480, rawDur);

        let dateStr;
        try {
          dateStr = resolveCentralDate(req.query.date);
        } catch (e) {
          return res.status(400).json({ success: false, error: e.message });
        }
        const { startOfDay, endOfDay } = centralDayRange(dateStr);

        // Pull EVERY appointment + block for this staff member on this
        // day (any calendar). A barber blocked off on their break
        // calendar is still busy; a barber with a haircut on calendar A
        // can't simultaneously be booked on calendar B. Filtering by
        // calendarId here would be wrong.
        const { data: rows, error } = await supabase
          .from("appointments")
          .select(
            "id, title, calendar_id, start_time, end_time, status, assigned_user_id"
          )
          .eq("location_id", resolved.locationId)
          .eq("assigned_user_id", staffId)
          .gte("start_time", startOfDay.toISOString())
          .lte("start_time", endOfDay.toISOString())
          .order("start_time", { ascending: true });

        if (error) {
          console.error("[frontdesk/availability] supabase error:", error.message);
          return res.status(500).json({ success: false, error: error.message });
        }

        // Active appointments only — cancelled/no-show free up the slot.
        // `title` survives into the response so the FE can render the
        // overlap-warning copy ("Conflicts with Jose Chavez 12:00–12:30").
        const busy = (rows || [])
          .filter((r) => {
            const s = (r.status || "").toLowerCase();
            return s !== "cancelled" && s !== "canceled" && s !== "noshow";
          })
          .map((r) => ({
            id: r.id,
            title: r.title || "",
            start: new Date(r.start_time).getTime(),
            end: new Date(r.end_time || r.start_time).getTime(),
          }))
          .sort((a, b) => a.start - b.start);

        // Resolve the day's Central offset once (DST-safe via Intl).
        const probe = new Date(`${dateStr}T12:00:00Z`);
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Chicago",
          timeZoneName: "shortOffset",
        }).formatToParts(probe);
        const off =
          (parts.find((p) => p.type === "timeZoneName") || {}).value || "GMT-6";
        const oM = /([+-])(\d{1,2})(?::(\d{2}))?/.exec(off);
        const sign = oM[1];
        const hh = parseInt(oM[2], 10);
        const mm = oM[3] ? parseInt(oM[3], 10) : 0;
        const offsetStr = `${sign}${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;

        // Resolve calendar interval (the chip step) + per-day open
        // intervals from this staff's schedule. Both come from GHL;
        // both are cached per-process for 10 min.
        const isBarber = resolved.locationId === FD_BARBER_LOC_ID;
        const sdk =
          isBarber && ghlBarber
            ? ghlBarber
            : require("../clients/ghlSdk").ghl;
        const [calMeta, schedules] = await Promise.all([
          fdGetCalendarMeta(sdk, calendarId),
          fdGetSchedulesForStaff(sdk, resolved.locationId, staffId),
        ]);
        const stepMinutes = Math.max(5, calMeta.intervalMinutes || 15);
        const stepMs = stepMinutes * 60 * 1000;
        const dur = durationMinutes * 60 * 1000;
        const nowMs = Date.now();

        // Per-day open intervals from the GHL schedule. EMPTY means
        // "no rule for this calendar on this day" — could be either a
        // legitimate day-off or the staff has no schedule wired up.
        // Either way the FE treats EMPTY as "out of hours window" and
        // surfaces only the toggle-overridden list.
        const openIntervalsMin = fdOpenIntervalsForDay(
          schedules,
          calendarId,
          dateStr
        );

        // Convert wall-clock minutes-since-midnight to UTC ms for that
        // day in Central.
        function minToMs(m) {
          const h = Math.floor(m / 60);
          const mm = m % 60;
          const hhS = String(h).padStart(2, "0");
          const mmS = String(mm).padStart(2, "0");
          return new Date(`${dateStr}T${hhS}:${mmS}:00${offsetStr}`).getTime();
        }
        const openIntervalsMs = openIntervalsMin.map((iv) => ({
          startMs: minToMs(iv.startMin),
          endMs: minToMs(iv.endMin),
        }));

        // Hard outer window for the "any time" toggle list: 9am–9pm
        // Central. This is the same generous default we had before —
        // booking outside the staff's hours stays as an option, just
        // an explicit one.
        const anyWindowStart = minToMs(9 * 60);
        const anyWindowEnd = minToMs(21 * 60);

        // Slot generation: step by calendar.slotInterval (Item 4). A
        // slot starting at t with `duration` mins is OPEN if it does
        // not overlap any active busy interval, ends inside the day,
        // and is not in the past.
        function generateSlots(rangeStart, rangeEnd) {
          const out = [];
          // Anchor the first slot to the rangeStart (so a 9:00 open
          // window with a 20-min step yields 9:00, 9:20, 9:40…).
          for (let t = rangeStart; t + dur <= rangeEnd; t += stepMs) {
            if (t < nowMs) continue;
            const endT = t + dur;
            const overlaps = busy.some(
              (b) => !(endT <= b.start || t >= b.end)
            );
            if (!overlaps) out.push(new Date(t).toISOString());
          }
          return out;
        }

        // In-hours: union of slots generated for each open interval.
        const inHoursSet = new Set();
        for (const iv of openIntervalsMs) {
          for (const s of generateSlots(iv.startMs, iv.endMs)) {
            inHoursSet.add(s);
          }
        }
        const slotsInHours = [...inHoursSet].sort();

        // Any-time: full 9am-9pm window, including in-hours.
        const slotsAnyTime = generateSlots(anyWindowStart, anyWindowEnd);

        // Has this staff any schedule wired at all (for any day)?
        // Lets the FE distinguish "scheduled day off" (toggle stays
        // hidden, label "Day off") from "no schedule wired" (toggle
        // is the default view — we don't know the staff's hours).
        const staffHasAnySchedule = schedules.some((s) => {
          const calIds = s.calendarIds || [];
          if (!calIds.includes(calendarId)) return false;
          const rules = s.rules || s.schedule || [];
          return rules.some(
            (r) =>
              r.type === "wday" &&
              Array.isArray(r.intervals) &&
              r.intervals.length > 0
          );
        });

        res.json({
          success: true,
          location: resolved.label,
          date: dateStr,
          staffGhlUserId: staffId,
          calendarId,
          durationMinutes,
          // Item 4: chip step driven by GHL's calendar.slotInterval.
          stepMinutes,
          // Item 3: per-day open intervals (ISO timestamps for FE
          // visualization — knowing if a chip is in or out of hours).
          openIntervals: openIntervalsMs.map((iv) => ({
            startTime: new Date(iv.startMs).toISOString(),
            endTime: new Date(iv.endMs).toISOString(),
          })),
          // True if the staff has a real schedule wired for THIS
          // calendar (any day, not necessarily this date). When false,
          // the FE shows slotsAnyTime by default — the staff hasn't
          // told us their hours so we shouldn't hide anything.
          staffHasSchedule: staffHasAnySchedule,
          // True if THIS specific day has open hours. When false +
          // staffHasSchedule=true → scheduled day off (FE labels it).
          dayHasOpenHours: openIntervalsMin.length > 0,
          windowStart: new Date(anyWindowStart).toISOString(),
          windowEnd: new Date(anyWindowEnd).toISOString(),
          slotsInHours,
          slotsAnyTime,
          // Active busy intervals for THIS staff on THIS day. Drives
          // the BookingSheet's live "overlap warning" (Phase 3.16c
          // user follow-up): the FE detects when the picked
          // [start, start+duration) overlaps any of these and surfaces
          // who/when inline. Cancelled/no-show rows are already filtered
          // upstream — these are real conflicts.
          busyIntervals: busy.map((b) => ({
            id: b.id,
            title: b.title,
            startTime: new Date(b.start).toISOString(),
            endTime: new Date(b.end).toISOString(),
          })),
          // Back-compat for older FE callers: default to in-hours
          // when a schedule exists, otherwise fall back to any-time.
          slots:
            staffHasAnySchedule && openIntervalsMin.length > 0
              ? slotsInHours
              : slotsAnyTime,
        });
      } catch (err) {
        const msg = err.response?.data?.message || err.message || String(err);
        console.error("❌ GET /api/frontdesk/availability error:", msg);
        res.status(500).json({ success: false, error: msg });
      }
    });

    /**
     * POST /api/frontdesk/book   (Phase 3.15c-ii)
     * Create a new appointment from the BookingSheet. The heaviest
     * write surface in the project: real GHL appointment, fires real
     * workflows, may create a new contact.
     *
     * Body:
     *   {
     *     location,                  // "barbershop" | "tattoo"
     *     staffGhlUserId,            // who's doing the appointment
     *     calendarId,                // service-specific calendar
     *     startTime,                 // ISO string (with offset)
     *     durationMinutes,           // 5..480, post-validated
     *
     *     // Contact — EXACTLY ONE of these must be provided:
     *     contactId,                 // existing contact picked from lookup
     *     newContact: {              // OR inline-create payload
     *       firstName, lastName?,    //   parsed by caller; we don't split
     *       phone                    //   required for createContact
     *     },
     *
     *     // Optional:
     *     serviceLabel,              // pretty label for the title; falls
     *                                //   back to "Appointment"
     *     reason,                    // ignored here; reserved for parity
     *     actionId,                  // client UUID for idempotency
     *     actingStaffGhlUserId,      // wizard identity
     *     actingStaffName,
     *   }
     *
     * Flow:
     *   1. Validate inputs (location, required fields, time, duration).
     *   2. Idempotency check: if actionId already exists in the audit
     *      log with result='success', return the original appointmentId
     *      from its payload. NEVER create twice.
     *   3. Pre-write live re-check (Section 11): pull the staff's
     *      appointments for that day from CACHE; reject if the slot
     *      [startTime, startTime + durationMinutes) overlaps any
     *      active appointment for that assigned_user_id. Cache is
     *      <20s old; this is faster + nearly as authoritative as
     *      calling GHL live, and matches what the availability
     *      endpoint shows the desk so the rejection is consistent.
     *   4. Find or create the contact (barbershop uses ghlBarber,
     *      tattoo uses default ghl). Existing-by-phone wins.
     *   5. Create the appointment via sdk.calendars.createAppointment
     *      with explicit endTime so duration is exact.
     *   6. Audit row written with action='book', the new appointmentId
     *      in target_id, full payload (actionId, contactId, calendarId,
     *      startTime, durationMinutes) for the forensic record.
     *      The webhook will echo the new appointment back into the
     *      cache within seconds.
     *
     * Failure modes (all audit-logged):
     *   - 400: validation
     *   - 409: slot collision (pre-write re-check)
     *   - 500: GHL contact create or appointment create blew up
     *   - 200 + dedup: actionId already used — returns prior result
     */
    app.post("/api/frontdesk/book", async (req, res) => {
      const {
        location,
        staffGhlUserId,
        calendarId,
        startTime,
        durationMinutes,
        contactId: existingContactId,
        newContact,
        serviceLabel,
        actionId,
        actingStaffGhlUserId = null,
        actingStaffName = null,
      } = req.body || {};

      const resolved = fdResolveLocation(location);

      // Pre-build audit base. Filled lazily as we learn the contactId
      // / appointmentId. The summary + target_id update on each branch.
      const auditBase = {
        location: resolved?.label || (location ?? null),
        acting_staff_ghl_user_id: actingStaffGhlUserId,
        acting_staff_name: actingStaffName,
        action: "book",
        target_type: "appointment",
        target_id: null, // filled when GHL returns the new appointment id
        payload: {
          actionId: actionId || null,
          staffGhlUserId: staffGhlUserId || null,
          calendarId: calendarId || null,
          startTime: startTime || null,
          durationMinutes: durationMinutes || null,
          contactId: existingContactId || null,
          newContact: newContact
            ? { firstName: newContact.firstName, phone: newContact.phone }
            : null,
          serviceLabel: serviceLabel || null,
        },
      };

      async function logAudit(result, summary, errorText = null, extra = {}) {
        if (!supabase) return;
        try {
          await supabase.from("frontdesk_audit_log").insert([
            {
              ...auditBase,
              ...extra, // allows target_id override
              summary,
              result,
              error_text: errorText,
            },
          ]);
        } catch (e) {
          console.warn(
            "[frontdesk/book] audit insert failed (non-fatal):",
            e.message
          );
        }
      }

      try {
        if (!supabase) {
          return res
            .status(503)
            .json({ success: false, error: "Supabase not configured" });
        }
        if (!resolved) {
          await logAudit("failed", "book rejected: invalid location", "Invalid location");
          return res
            .status(400)
            .json({ success: false, error: "Invalid location" });
        }
        if (!staffGhlUserId) {
          await logAudit("failed", "book rejected: missing staffGhlUserId", "staffGhlUserId is required");
          return res
            .status(400)
            .json({ success: false, error: "staffGhlUserId is required" });
        }
        if (!calendarId) {
          await logAudit("failed", "book rejected: missing calendarId", "calendarId is required");
          return res
            .status(400)
            .json({ success: false, error: "calendarId is required" });
        }
        if (!startTime) {
          await logAudit("failed", "book rejected: missing startTime", "startTime is required");
          return res
            .status(400)
            .json({ success: false, error: "startTime is required" });
        }
        const startMs = Date.parse(startTime);
        if (!Number.isFinite(startMs)) {
          await logAudit("failed", `book rejected: bad startTime "${startTime}"`, "startTime not parseable as ISO");
          return res
            .status(400)
            .json({ success: false, error: "startTime must be an ISO timestamp" });
        }
        const dur = parseInt(durationMinutes, 10);
        if (!Number.isFinite(dur) || dur < 5 || dur > 480) {
          await logAudit("failed", `book rejected: bad durationMinutes ${durationMinutes}`, "durationMinutes must be 5..480");
          return res
            .status(400)
            .json({ success: false, error: "durationMinutes must be between 5 and 480" });
        }
        // Block bookings into the past (anti-typo guard — clock skew is
        // less than 60s in any realistic case; allow 2 min slack).
        if (startMs < Date.now() - 2 * 60 * 1000) {
          await logAudit("failed", `book rejected: startTime in the past (${startTime})`, "startTime is in the past");
          return res
            .status(400)
            .json({ success: false, error: "startTime is in the past" });
        }
        // Contact: exactly one of contactId or newContact must come.
        const hasExisting = !!existingContactId;
        const hasNew = !!(
          newContact &&
          (newContact.firstName || "").trim() &&
          (newContact.phone || "").trim()
        );
        if (hasExisting && hasNew) {
          await logAudit("failed", "book rejected: both contactId and newContact provided", "Choose one — existing OR new contact");
          return res.status(400).json({
            success: false,
            error: "Provide either contactId OR newContact, not both",
          });
        }
        if (!hasExisting && !hasNew) {
          await logAudit("failed", "book rejected: no contact info", "Need contactId or newContact{firstName,phone}");
          return res.status(400).json({
            success: false,
            error: "contactId or newContact{firstName,phone} is required",
          });
        }

        // Roster sanity check — same guard as /services so a desk
        // can't book a staffer who isn't on the location.
        const member = resolved.roster.find(
          (m) => m.ghlUserId === staffGhlUserId
        );
        if (!member) {
          await logAudit("failed", `book rejected: staff ${staffGhlUserId} not on ${resolved.label} roster`, "Staff not on this location's roster");
          return res
            .status(404)
            .json({ success: false, error: "Staff not on this location's roster" });
        }

        // Idempotency check (Section 10.3). If this actionId has
        // already been used successfully, return the prior appointment
        // id without doing anything else. Safe to retry the request.
        if (actionId) {
          try {
            const { data: prior, error: priorErr } = await supabase
              .from("frontdesk_audit_log")
              .select("target_id, payload, result")
              .eq("action", "book")
              .eq("result", "success")
              .filter("payload->>actionId", "eq", actionId)
              .order("created_at", { ascending: false })
              .limit(1);
            if (!priorErr && Array.isArray(prior) && prior[0]?.target_id) {
              return res.json({
                success: true,
                appointmentId: prior[0].target_id,
                dedup: true,
              });
            }
          } catch (dedupErr) {
            // Non-fatal — fall through to the real write attempt.
            console.warn(
              "[frontdesk/book] dedup lookup failed (continuing):",
              dedupErr.message
            );
          }
        }

        // Pre-write slot re-check (Section 11). Match the algorithm
        // /availability uses: pull EVERY appointment for this staff
        // on the day, ignore cancelled/canceled/noshow, reject if our
        // [startMs, startMs + dur) overlaps any active interval.
        const endMs = startMs + dur * 60 * 1000;
        const dayStartIso = new Date(startMs - 24 * 60 * 60 * 1000).toISOString();
        const dayEndIso = new Date(startMs + 24 * 60 * 60 * 1000).toISOString();
        const { data: busyRows, error: busyErr } = await supabase
          .from("appointments")
          .select("id, title, start_time, end_time, status, assigned_user_id")
          .eq("location_id", resolved.locationId)
          .eq("assigned_user_id", staffGhlUserId)
          .gte("start_time", dayStartIso)
          .lte("start_time", dayEndIso);
        if (busyErr) {
          await logAudit("failed", "book rejected: pre-write check failed", busyErr.message);
          return res.status(500).json({ success: false, error: busyErr.message });
        }
        const conflict = (busyRows || []).find((r) => {
          const s = (r.status || "").toLowerCase();
          if (s === "cancelled" || s === "canceled" || s === "noshow") return false;
          const rs = new Date(r.start_time).getTime();
          const re = new Date(r.end_time || r.start_time).getTime();
          return !(endMs <= rs || startMs >= re);
        });
        if (conflict) {
          const conflictTitle = (conflict.title || "").trim() || "another booking";
          const conflictTime = new Date(conflict.start_time).toLocaleString(
            "en-US",
            {
              timeZone: "America/Chicago",
              hour: "numeric",
              minute: "2-digit",
            }
          );
          const msg = `That ${conflictTime} with ${member.name.split(" ")[0]} was just booked — pick another`;
          await logAudit(
            "failed",
            `book rejected: slot collision with ${conflict.id}`,
            msg
          );
          return res.status(409).json({
            success: false,
            error: msg,
            conflict: { id: conflict.id, title: conflictTitle },
          });
        }

        // Resolve the SDK by location.
        const isBarber = resolved.locationId === FD_BARBER_LOC_ID;
        const sdk =
          isBarber && ghlBarber
            ? ghlBarber
            : require("../clients/ghlSdk").ghl;

        // Find-or-create the contact.
        let contactId = existingContactId || null;
        let contactNamePreview = null;
        let isNewContact = false;

        if (!contactId) {
          const firstName = newContact.firstName.trim();
          const lastName = (newContact.lastName || "").trim();
          const phone = newContact.phone.trim();
          contactNamePreview = [firstName, lastName].filter(Boolean).join(" ");

          // Phone-dup lookup first — mirror the kiosk walk-in-book flow.
          try {
            const dupe = await sdk.contacts.getDuplicateContact({
              locationId: resolved.locationId,
              number: phone,
            });
            contactId = dupe?.contact?.id || null;
          } catch (e) {
            // not found is normal — proceed to create
          }

          if (!contactId) {
            try {
              const created = await sdk.contacts.createContact({
                firstName,
                lastName: lastName || undefined,
                phone,
                locationId: resolved.locationId,
                source: "Front Desk Dashboard",
                assignedTo: staffGhlUserId,
              });
              contactId =
                created?.contact?.id || created?.id || null;
              isNewContact = !!contactId;
            } catch (createErr) {
              const cm = createErr.response?.data?.message || createErr.message;
              await logAudit("failed", `book contact create failed for ${phone}`, cm);
              return res
                .status(500)
                .json({ success: false, error: `Couldn't create contact: ${cm}` });
            }
          }
          if (!contactId) {
            await logAudit("failed", "book: contact resolution returned no id", "no contactId");
            return res
              .status(500)
              .json({ success: false, error: "Could not resolve contact" });
          }
        }

        // Create the GHL appointment. Explicit endTime — duration is
        // user-controlled, not calendar-default. Title MUST follow
        // the "<Service>: <Name>" format so the front-end grid card's
        // clientName/serviceLabel parser (lib/grid.ts) renders name
        // bold + service subdued, matching every webhook-sourced card.
        // For an existing contactId, we didn't carry the name in the
        // request body — fetch it from GHL now. Non-fatal: a failed
        // fetch falls back to service-only so the booking still lands.
        const endIso = new Date(endMs).toISOString();
        let contactNameForTitle = contactNamePreview;
        if (!contactNameForTitle && existingContactId) {
          try {
            const cr = await sdk.contacts.getContact({
              contactId: existingContactId,
            });
            const c = cr?.contact || cr;
            contactNameForTitle = (
              c?.contactName ||
              [c?.firstName, c?.lastName].filter(Boolean).join(" ") ||
              ""
            ).trim() || null;
          } catch (nameErr) {
            console.warn(
              "[frontdesk/book] contact name fetch failed (non-fatal):",
              nameErr.response?.data?.message || nameErr.message
            );
          }
        }
        const title = (() => {
          const base = (serviceLabel || "Appointment").trim();
          if (contactNameForTitle) return `${base}: ${contactNameForTitle}`;
          return base;
        })();

        let newApptId = null;
        try {
          const result = await sdk.calendars.createAppointment({
            calendarId,
            contactId,
            locationId: resolved.locationId,
            startTime: new Date(startMs).toISOString(),
            endTime: endIso,
            title,
            appointmentStatus: "confirmed",
            assignedUserId: staffGhlUserId,
            ignoreFreeSlotValidation: true, // we've already done our own check
            toNotify: false,
          });
          newApptId =
            result?.id ||
            result?.appointment?.id ||
            result?.event?.id ||
            null;
        } catch (bookErr) {
          const bm =
            bookErr.response?.data?.message || bookErr.message || String(bookErr);
          await logAudit("failed", `book GHL create failed`, bm);
          return res.status(500).json({
            success: false,
            error: `Couldn't create appointment: ${bm}`,
          });
        }

        if (!newApptId) {
          await logAudit(
            "failed",
            "book: GHL returned no appointment id",
            "GHL response missing id"
          );
          return res.status(500).json({
            success: false,
            error: "Booked but GHL returned no appointment id",
          });
        }

        const summary = `Booked ${title} for ${new Date(startMs).toLocaleString(
          "en-US",
          {
            timeZone: "America/Chicago",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          }
        )} (${dur}m)`;
        await logAudit("success", summary, null, { target_id: newApptId });

        // No optimistic cache mirror here: the webhook lands a richer
        // row (with calendar_id, contact_id, ghl_updated_at) within
        // seconds. The front-end will see the new appointment on its
        // next 20s poll. Booking from the UI takes the optimistic
        // path on the FE side so the visual lag is hidden.
        return res.json({
          success: true,
          appointmentId: newApptId,
          contactId,
          isNewContact,
          title,
          startTime: new Date(startMs).toISOString(),
          endTime: endIso,
          assignedUserId: staffGhlUserId,
          calendarId,
        });
      } catch (err) {
        const msg = err.response?.data?.message || err.message || String(err);
        console.error("❌ POST /api/frontdesk/book error:", msg);
        await logAudit("failed", `book uncaught error`, msg);
        res.status(500).json({ success: false, error: msg });
      }
    });
  }

  /**
   * GET /api/kiosk/barber-appointments?ghlUserId=X
   * Returns today's appointments for a specific barber — used by the kiosk
   * appointment carousel so clients can tap their name/time to check in.
   */
  app.get("/api/kiosk/barber-appointments", async (req, res) => {
    const { ghlUserId } = req.query;

    if (!ghlUserId) {
      return res.status(400).json({ success: false, error: "ghlUserId is required" });
    }

    try {
      const { BARBER_LOCATION_ID } = require("../config/kioskConfig");

      // Compute "today" in Central time so the kiosk always shows the correct day
      // (server runs in UTC on Render — naive setHours(0) would give UTC midnight)
      const { startOfDay, endOfDay } = getTodayRangeCentral();

      const events = await fetchAppointmentsForDateRange({
        locationId: BARBER_LOCATION_ID,
        startTime: startOfDay.toISOString(),
        endTime: endOfDay.toISOString(),
        userId: ghlUserId,
        sdkInstance: ghlBarber,
      });

      // Calendars to exclude (breaks / internal)
      const BREAK_CALENDAR_IDS = new Set(["lijQ2ubF4UcrHxDwfzyK"]);

      // Calendar ID → base service label for the kiosk carousel
      const CALENDAR_SERVICE_MAP = {
        // Lionel — regular
        "Bsv9ngkRgsbLzgtN3Vpq": "Haircut",
        "pGNsYjGyEYW9LCD1GcQN": "Haircut + Beard",
        // Lionel — Friends & Family
        "9a66xeZi2pEJWQpxiMjy": "Haircut",
        "0qOmPMcP7L4qz58fxmu4": "Haircut + Beard",
        // Drew
        "AzIK0eW09u4V1jJTXQ0x": "Haircut",
        "dCuPcZbqylgwftyDu8kw": "Haircut + Beard",
        "RsdMc558Cjjs28xpyCCf": "Beard Trim",
        // Logan
        "o1fvyti3GnoFGKZN5Hwr": "Haircut",
        "lsBgjayKLFOUahMvuVNe": "Haircut + Beard",
        "Us8MYQ74AcvMsJBmIucQ": "Beard Trim",
        // Elle
        "Bcqa2hqjUX7xhNu37cL1": "Haircut",
        "D9l8VEIX7hOLrqSrSJVc": "Haircut + Beard",
        // David
        "qvcPzTqyaQOxsijIQqAN": "Haircut",
        "prLxqGcd2JYNnb0sPGmc": "Haircut + Beard",
        // Joshua
        "X1xINoRML65yAOVUsAGa": "Haircut",
        "Vs496YAmFt5uX2JTg2Bs": "Haircut + Beard",
        "3NsSPGmWCxSAZJSPTIDY": "Beard Trim",
        "pJSIf74XzkpvFAChges2": "Haircut + Beard",
        "FMi3hYcTU2UMeJ2F1hn6": "Haircut + Beard",
        // Albe
        "h9VQL30IBqr6TTiKwAQm": "Haircut",
        "NZSQNzPM10Fe6mUuJuyU": "Haircut + Beard",
        "xLjnOmLqToiknndXnvbk": "Beard Trim",
        // Liam
        "kiGx7ec1vj9e62U33ZhU": "Haircut",
        "vLpnhjAc93piHn1e2cfQ": "Haircut + Beard",
        "g7DSKwGxH8qsXrHBfZ5h": "Beard Trim",
        "KJZWIO6KESFa2SHiCFr7": "Hot Towel Shave",
        // Gilberto
        "38Uhu6i5W4L5yGJbE0My": "Haircut",
        "7Bj9t1Gwi0zcJRTwCvYA": "Haircut + Beard",
        // Anna
        "WWduImUIgEoEx8mBTkmp": "Haircut",
        "9s2hYN8XT06IrGGt89uT": "Haircut + Beard",
        "ZOORnQ8ZPwiyT3Xtvvlg": "Haircut + Grey Blending",
        "rsg2VbiVFGuGiEwUIhdl": "Neck Trim",
      };

      // ── Title parsing (mirrors iOS TodaysScheduleWidget.swift) ──

      /** Extract contact name from title: "ServiceType: Name" → "Name" */
      function parseContactName(title) {
        if (!title) return "Unknown";
        const colonIdx = title.indexOf(": ");
        if (colonIdx !== -1) return title.slice(colonIdx + 2).trim();
        const dashIdx = title.indexOf(" - ");
        if (dashIdx !== -1) return title.slice(dashIdx + 3).trim();
        return title.trim(); // F&F titles are just the name
      }

      /** Extract raw service text from title: "ServiceType: Name" → "ServiceType" */
      function parseRawService(title) {
        if (!title) return "";
        let raw = title;
        const colonIdx = raw.indexOf(": ");
        if (colonIdx !== -1) raw = raw.slice(0, colonIdx);
        else {
          const dashIdx = raw.indexOf(" - ");
          if (dashIdx !== -1) raw = raw.slice(0, dashIdx);
          else return ""; // no separator = F&F, service comes from calendar
        }
        return raw.replace(/📱/g, "").trim();
      }

      const KNOWN_HAIR_TYPES = ["fade", "afro", "long/med", "kids", "espanol"];

      /** Extract hair type from raw service text: "FadeHaircut" → "Fade" */
      function parseHairType(rawService) {
        if (!rawService) return null;
        let s = rawService.toLowerCase();
        if (s.startsWith("silent")) return null; // silent is separate
        // Strip add-on suffixes after "haircut" (e.g. "Haircut Eyebrows ($10)")
        const hcIdx = s.indexOf("haircut");
        if (hcIdx !== -1) s = s.slice(0, hcIdx + 7);
        // Strip calendar prefixes ("SoonestFade" → "fade")
        if (s.startsWith("soonest")) s = s.slice(7);
        // Check for "FadeHaircut" pattern → extract prefix
        const hcIdx2 = s.indexOf("haircut");
        if (hcIdx2 > 0) {
          const before = s.slice(0, hcIdx2).trim();
          if (KNOWN_HAIR_TYPES.includes(before)) {
            return before === "long/med" ? "Long/Med" : before.charAt(0).toUpperCase() + before.slice(1);
          }
          return null;
        }
        // Standalone hair type after stripping prefix
        const remaining = s.trim();
        if (KNOWN_HAIR_TYPES.includes(remaining)) {
          return remaining === "long/med" ? "Long/Med" : remaining.charAt(0).toUpperCase() + remaining.slice(1);
        }
        return null;
      }

      /** Detect silent appointment */
      function isSilent(rawService) {
        return rawService && rawService.toLowerCase().startsWith("silent");
      }

      /** Extract add-ons from raw service text */
      function parseAddOns(rawService) {
        if (!rawService) return [];
        const lower = rawService.toLowerCase();
        const addOns = [];
        // Match add-ons with their price tags
        const eyebrowMatch = rawService.match(/eyebrow[s]?\s*\(\$\d+\)/i);
        if (eyebrowMatch) addOns.push(eyebrowMatch[0]);
        // "Both Wax ($30)", "Nose or Ear Wax ($15)", "Eye Brow Wax ($15)"
        const waxMatch = rawService.match(/((?:both|nose\s*(?:or|&)\s*ear|eye\s*brow)\s*wax\s*\(\$\d+\))/i);
        if (waxMatch) addOns.push(waxMatch[1]);
        else if (lower.includes("wax") && !lower.includes("eyebrow")) {
          const genericWax = rawService.match(/wax\s*\(\$\d+\)/i);
          if (genericWax) addOns.push(genericWax[0]);
        }
        return addOns;
      }

      /** Build full service label: "Silent · Fade · Haircut + Beard · Eyebrows ($10)" */
      function buildServiceLabel(calendarId, title) {
        const baseService = CALENDAR_SERVICE_MAP[calendarId] || null;
        const rawService = parseRawService(title);
        const parts = [];

        if (isSilent(rawService)) parts.push("Silent");
        const hairType = parseHairType(rawService);
        if (hairType) parts.push(hairType);
        parts.push(baseService || (rawService ? rawService : "Appointment"));
        const addOns = parseAddOns(rawService);
        addOns.forEach((a) => parts.push(a));

        return parts.join(" · ");
      }

      // Filter to active appointments, exclude breaks, extract key fields
      const appointments = events
        .filter((evt) => {
          const status = evt.appointmentStatus;
          if (status === "cancelled" || status === "noshow" || status === "invalid") return false;
          if (BREAK_CALENDAR_IDS.has(evt.calendarId)) return false;
          return true;
        })
        .map((evt) => ({
          id: evt.id,
          contactId: evt.contact?.id || null,
          contactName: parseContactName(evt.title) || evt.contact?.name || "Unknown",
          contactPhone: evt.contact?.phone || evt.contact?.phoneNumber || null,
          startTime: evt.startTime,
          endTime: evt.endTime,
          status: evt.appointmentStatus,
          calendarId: evt.calendarId || null,
          service: buildServiceLabel(evt.calendarId, evt.title),
        }))
        .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

      console.log(`✅ [KIOSK] Found ${appointments.length} appointments today for barber ${ghlUserId}`);
      return res.json({ success: true, appointments });
    } catch (error) {
      console.error("❌ [KIOSK] Barber appointments error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * GET /api/kiosk/tattoo-appointments?ghlUserId=X
   * Returns today's appointments for a specific tattoo artist — used by the kiosk
   * appointment carousel so clients can tap their name/time to check in.
   * Uses the tattoo SDK (default ghl) and tattoo location ID.
   */
  app.get("/api/kiosk/tattoo-appointments", async (req, res) => {
    const { ghlUserId } = req.query;

    if (!ghlUserId) {
      return res.status(400).json({ success: false, error: "ghlUserId is required" });
    }

    try {
      const { TATTOO_LOCATION_ID } = require("../config/kioskConfig");

      // Compute "today" in Central time (shop is in Minneapolis)
      const { startOfDay, endOfDay } = getTodayRangeCentral();

      // Use default ghl SDK (tattoo location) — no sdkInstance param
      const events = await fetchAppointmentsForDateRange({
        locationId: TATTOO_LOCATION_ID,
        startTime: startOfDay.toISOString(),
        endTime: endOfDay.toISOString(),
        userId: ghlUserId,
      });

      // Filter to active appointments, extract key fields
      const appointments = events
        .filter((evt) => {
          const status = evt.appointmentStatus;
          if (status === "cancelled" || status === "noshow" || status === "invalid") return false;
          return true;
        })
        .map((evt) => {
          // Tattoo titles are typically "ServiceName: ContactName" or just contact name
          let contactName = "Unknown";
          const title = evt.title || "";
          const colonIdx = title.indexOf(": ");
          if (colonIdx !== -1) {
            contactName = title.slice(colonIdx + 2).trim();
          } else if (evt.contact?.name) {
            contactName = evt.contact.name;
          } else if (title) {
            contactName = title.trim();
          }

          return {
            id: evt.id,
            contactId: evt.contact?.id || null,
            contactName,
            contactPhone: evt.contact?.phone || evt.contact?.phoneNumber || null,
            startTime: evt.startTime,
            endTime: evt.endTime,
            status: evt.appointmentStatus,
            calendarId: evt.calendarId || null,
            service: null, // tattoo appointments don't need service labels
          };
        })
        .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

      console.log(`✅ [KIOSK] Found ${appointments.length} tattoo appointments today for artist ${ghlUserId}`);
      return res.json({ success: true, appointments });
    } catch (error) {
      console.error("❌ [KIOSK] Tattoo appointments error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * GET /api/kiosk/phone-lookup?phone=X&ghlUserId=X
   * Searches for a contact by phone number on the barbershop location,
   * then checks if they have an appointment today or on another day.
   */
  app.get("/api/kiosk/phone-lookup", async (req, res) => {
    const { phone, ghlUserId } = req.query;

    if (!phone || !ghlUserId) {
      return res.status(400).json({ success: false, error: "phone and ghlUserId are required" });
    }

    try {
      const { BARBER_LOCATION_ID } = require("../config/kioskConfig");

      // 1. Find contact by phone
      let contact = null;
      try {
        const dupeData = await ghlBarber.contacts.getDuplicateContact({
          locationId: BARBER_LOCATION_ID,
          number: phone,
        });
        contact = dupeData?.contact || null;
      } catch (err) {
        // Not found
      }

      if (!contact) {
        return res.json({ success: true, found: false, reason: "no_contact" });
      }

      // 2. Check for appointments today with this barber (Pacific time)
      const { startOfDay, endOfDay } = getTodayRangeCentral();

      const todayEvents = await fetchAppointmentsForDateRange({
        locationId: BARBER_LOCATION_ID,
        startTime: startOfDay.toISOString(),
        endTime: endOfDay.toISOString(),
        userId: ghlUserId,
        sdkInstance: ghlBarber,
      });

      // Find this contact's appointment today
      const todayMatch = todayEvents.find((evt) => {
        if (evt.appointmentStatus === "cancelled" || evt.appointmentStatus === "noshow") return false;
        return evt.contact?.id === contact.id;
      });

      if (todayMatch) {
        return res.json({
          success: true,
          found: true,
          reason: "found_today",
          appointment: {
            id: todayMatch.id,
            contactId: contact.id,
            contactName: contact.name || `${contact.firstName || ""} ${contact.lastName || ""}`.trim(),
            startTime: todayMatch.startTime,
            endTime: todayMatch.endTime,
          },
        });
      }

      // 3. Check next 30 days for upcoming appointments with this barber
      const endFuture = new Date(endOfDay.getTime() + 30 * 24 * 60 * 60 * 1000);

      const futureEvents = await fetchAppointmentsForDateRange({
        locationId: BARBER_LOCATION_ID,
        startTime: endOfDay.toISOString(),
        endTime: endFuture.toISOString(),
        userId: ghlUserId,
        sdkInstance: ghlBarber,
      });

      const futureMatch = futureEvents.find((evt) => {
        if (evt.appointmentStatus === "cancelled" || evt.appointmentStatus === "noshow") return false;
        return evt.contact?.id === contact.id;
      });

      if (futureMatch) {
        return res.json({
          success: true,
          found: true,
          reason: "wrong_day",
          appointment: {
            id: futureMatch.id,
            contactId: contact.id,
            contactName: contact.name || `${contact.firstName || ""} ${contact.lastName || ""}`.trim(),
            startTime: futureMatch.startTime,
            endTime: futureMatch.endTime,
          },
        });
      }

      // 4. No upcoming appointment — check past 60 days for most recent visit
      const contactName = contact.name || `${contact.firstName || ""} ${contact.lastName || ""}`.trim();
      let lastAppointment = null;

      try {
        const startPast = new Date(startOfDay.getTime() - 60 * 24 * 60 * 60 * 1000);

        const pastEvents = await fetchAppointmentsForDateRange({
          locationId: BARBER_LOCATION_ID,
          startTime: startPast.toISOString(),
          endTime: startOfDay.toISOString(),
          userId: ghlUserId,
          sdkInstance: ghlBarber,
        });

        // Find the most recent non-cancelled appointment for this contact
        const pastMatches = pastEvents
          .filter((evt) => {
            if (evt.appointmentStatus === "cancelled" || evt.appointmentStatus === "noshow") return false;
            return evt.contact?.id === contact.id;
          })
          .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

        if (pastMatches.length > 0) {
          lastAppointment = {
            startTime: pastMatches[0].startTime,
            endTime: pastMatches[0].endTime,
          };
        }
      } catch (err) {
        console.error("[KIOSK] Past appointment lookup error (non-fatal):", err.message);
      }

      // Contact exists but no upcoming appointment found with this barber
      return res.json({
        success: true,
        found: true,
        reason: "no_appointment",
        contactId: contact.id,
        contactName,
        lastAppointment,
      });
    } catch (error) {
      console.error("❌ [KIOSK] Phone lookup error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * GET /api/kiosk/walk-in-slots?service=haircut|haircut_beard|beard_trim&days=0
   * Computes real-time walk-in availability per barber by fetching actual
   * appointments + blocked slots + open hours, then finding gaps.
   * Bypasses GHL's getSlots API (and its scheduling-notice penalty).
   *
   * Query params:
   *   service — "haircut", "haircut_beard", or "beard_trim"
   *   days    — 0 = today only (default), 1-7 = today + next N days
   *
   * When days=0, slots are classified into tiers: now, 5-10, 10-20, later
   * When days>0, all slots use tier "later" with actual times, sorted by date
   */
  app.get("/api/kiosk/walk-in-slots", async (req, res) => {
    const { service, days: daysParam } = req.query;

    if (!service || !["haircut", "haircut_beard", "beard_trim"].includes(service)) {
      return res.status(400).json({
        success: false,
        error: 'service must be "haircut", "haircut_beard", or "beard_trim"',
      });
    }

    const days = Math.min(Math.max(parseInt(daysParam) || 0, 0), 7);

    try {
      const { BARBER_DATA, BARBER_LOCATION_ID } = require("../config/kioskConfig");
      const { fetchAppointmentsForDateRange } = require("../clients/ghlCalendarClient");

      const now = new Date();

      // Round "now" up to next 5-minute mark for clean slot start times
      const roundedNow = new Date(now);
      const mins = roundedNow.getMinutes();
      const remainder = mins % 5;
      if (remainder !== 0) {
        roundedNow.setMinutes(mins + (5 - remainder), 0, 0);
      } else {
        roundedNow.setSeconds(0, 0);
      }

      // Compute start-of-day and end-of-day in Central time
      const shopTZ = "America/Chicago";
      const todayCT = now.toLocaleDateString("en-CA", { timeZone: shopTZ });
      const [yr, mo, dy] = todayCT.split("-").map(Number);

      // Build date range: from start of today to end of target day
      const startOfToday = new Date(`${todayCT}T00:00:00`);
      // Adjust to Central offset
      const probeStart = new Date(`${todayCT}T12:00:00Z`);
      const startParts = new Intl.DateTimeFormat('en-US', { timeZone: shopTZ, timeZoneName: 'shortOffset' }).formatToParts(probeStart);
      const startOffsetMatch = startParts.find(p => p.type === 'timeZoneName')?.value.match(/GMT([+-]?\d+)/);
      const offsetHours = startOffsetMatch ? parseInt(startOffsetMatch[1], 10) : -6;
      const offsetStr = `${offsetHours < 0 ? '-' : '+'}${String(Math.abs(offsetHours)).padStart(2, '0')}:00`;

      const rangeStart = new Date(`${todayCT}T00:00:00${offsetStr}`);
      const targetDay = new Date(yr, mo - 1, dy + days);
      const targetDateStr = `${targetDay.getFullYear()}-${String(targetDay.getMonth() + 1).padStart(2, '0')}-${String(targetDay.getDate()).padStart(2, '0')}`;
      const rangeEnd = new Date(`${targetDateStr}T23:59:59.999${offsetStr}`);

      console.log(`[KIOSK walk-in] computing availability: ${roundedNow.toISOString()} → ${rangeEnd.toISOString()} (today in CT: ${todayCT}, days=${days})`);

      // Fetch availability for all barbers in parallel
      const promises = BARBER_DATA.map(async (barber) => {
        const calendarId = barber.calendars[service];
        if (!calendarId) return null;

        try {
          // Fetch calendar config, appointments (by userId), and blocked slots in parallel
          const [calendarInfo, events, blockedSlots] = await Promise.all([
            ghlBarber.calendars.getCalendar({ calendarId }).catch((err) => {
              console.warn(`⚠️ [KIOSK] Calendar info fetch failed for ${barber.name}:`, err.message);
              return null;
            }),
            fetchAppointmentsForDateRange({
              locationId: BARBER_LOCATION_ID,
              startTime: rangeStart.toISOString(),
              endTime: rangeEnd.toISOString(),
              userId: barber.ghlUserId,
              sdkInstance: ghlBarber,
            }).catch((err) => {
              console.warn(`⚠️ [KIOSK] Events fetch failed for ${barber.name}:`, err.message);
              return [];
            }),
            ghlBarber.calendars.getBlockedSlots({
              locationId: BARBER_LOCATION_ID,
              userId: barber.ghlUserId,
              startTime: String(rangeStart.getTime()),
              endTime: String(rangeEnd.getTime()),
            }).catch((err) => {
              console.warn(`���️ [KIOSK] Blocked slots fetch failed for ${barber.name}:`, err.message);
              return { events: [] };
            }),
          ]);

          // Extract slot duration from calendar config (default 30 min)
          let slotDurationMinutes = 30;
          let openHours = [];
          if (calendarInfo) {
            const cal = calendarInfo.calendar || calendarInfo;
            if (cal.slotDuration) {
              const unit = (cal.slotDurationUnit || "mins").toLowerCase();
              if (unit === "hours" || unit === "hour") {
                slotDurationMinutes = cal.slotDuration * 60;
              } else {
                slotDurationMinutes = cal.slotDuration;
              }
            }
            openHours = cal.openHours || [];
          }

          // Build occupied intervals from appointments + blocked slots
          const occupied = [];

          // Add appointments (skip cancelled/noshow)
          for (const evt of events) {
            if (evt.appointmentStatus === "cancelled" || evt.appointmentStatus === "noshow") continue;
            occupied.push({
              start: new Date(evt.startTime).getTime(),
              end: new Date(evt.endTime).getTime(),
            });
          }

          // Add blocked slots
          const blocks = blockedSlots?.events || [];
          for (const block of blocks) {
            if (block.deleted) continue;
            occupied.push({
              start: new Date(block.startTime).getTime(),
              end: new Date(block.endTime).getTime(),
            });
          }

          // Sort occupied intervals by start time
          occupied.sort((a, b) => a.start - b.start);

          // GHL openHours uses daysOfTheWeek (0=Sun, 1=Mon, ... 6=Sat)
          // Iterate each day in range and find gaps
          const slotDurationMs = slotDurationMinutes * 60 * 1000;
          const allSlots = [];

          for (let d = 0; d <= days; d++) {
            const dayDate = new Date(yr, mo - 1, dy + d);
            const dayStr = `${dayDate.getFullYear()}-${String(dayDate.getMonth() + 1).padStart(2, '0')}-${String(dayDate.getDate()).padStart(2, '0')}`;
            const jsDay = dayDate.getDay(); // 0=Sun, 1=Mon, ...

            // Find open hours for this day of week
            const dayOpenHours = openHours.find((oh) =>
              oh.daysOfTheWeek && oh.daysOfTheWeek.includes(jsDay)
            );
            if (!dayOpenHours || !dayOpenHours.hours || dayOpenHours.hours.length === 0) continue;

            for (const hours of dayOpenHours.hours) {
              const windowStart = new Date(`${dayStr}T${String(hours.openHour).padStart(2, '0')}:${String(hours.openMinute).padStart(2, '0')}:00${offsetStr}`).getTime();
              const windowEnd = new Date(`${dayStr}T${String(hours.closeHour).padStart(2, '0')}:${String(hours.closeMinute).padStart(2, '0')}:00${offsetStr}`).getTime();

              // Get occupied intervals that overlap this window
              const windowOccupied = occupied.filter(
                (o) => o.start < windowEnd && o.end > windowStart
              );

              // Walk through the window finding gaps
              let cursor = windowStart;

              for (const occ of windowOccupied) {
                // Gap before this occupied interval
                if (cursor < occ.start) {
                  // Generate slots in this gap
                  let slotStart = cursor;
                  while (slotStart + slotDurationMs <= occ.start) {
                    // Skip slots in the past
                    if (slotStart >= roundedNow.getTime()) {
                      allSlots.push({
                        startTime: new Date(slotStart).toISOString(),
                        endTime: new Date(slotStart + slotDurationMs).toISOString(),
                      });
                    }
                    slotStart += 5 * 60 * 1000; // 5-min increments for walk-in flexibility
                  }
                }
                // Move cursor past this occupied interval
                if (occ.end > cursor) cursor = occ.end;
              }

              // Gap after last occupied interval to window end
              if (cursor < windowEnd) {
                let slotStart = cursor;
                while (slotStart + slotDurationMs <= windowEnd) {
                  if (slotStart >= roundedNow.getTime()) {
                    allSlots.push({
                      startTime: new Date(slotStart).toISOString(),
                      endTime: new Date(slotStart + slotDurationMs).toISOString(),
                    });
                  }
                  slotStart += 5 * 60 * 1000;
                }
              }
            }
          }

          if (allSlots.length === 0) return null;

          // Classify each slot into a tier
          const classifiedSlots = allSlots.map((slot) => {
            const startTime = new Date(slot.startTime);
            const diffMin = (startTime.getTime() - now.getTime()) / 60000;

            let tier;
            if (days > 0) {
              tier = "later";
            } else {
              if (diffMin <= 2) tier = "now";
              else if (diffMin <= 10) tier = "5-10";
              else if (diffMin <= 20) tier = "10-20";
              else tier = "later";
            }

            return { startTime: slot.startTime, endTime: slot.endTime, tier };
          });

          // Determine the barber's best (earliest) tier
          const tierOrder = { now: 0, "5-10": 1, "10-20": 2, later: 3 };
          const bestTier = classifiedSlots.reduce(
            (best, s) => (tierOrder[s.tier] < tierOrder[best] ? s.tier : best),
            "later"
          );

          return {
            barberName: barber.name,
            barberGhlUserId: barber.ghlUserId,
            barberPhoto: barber.photoUrl,
            calendarId,
            slotDuration: slotDurationMinutes,
            tier: bestTier,
            slots: classifiedSlots,
          };
        } catch (err) {
          console.error(`⚠️ [KIOSK] Availability compute failed for ${barber.name}:`, err.message);
          return null;
        }
      });

      const results = await Promise.allSettled(promises);
      let barbers = [];
      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          barbers.push(result.value);
        }
      }

      // Enrich with prices
      try {
        const priceMap = await getServicePriceMap();
        for (const barber of barbers) {
          barber.price = priceMap.get(barber.calendarId) || 0;
        }
      } catch (priceErr) {
        console.error("⚠️ [KIOSK] Price lookup failed:", priceErr.message);
      }

      // Sort barbers: by tier priority first, then by earliest slot time
      const tierOrder = { now: 0, "5-10": 1, "10-20": 2, later: 3 };
      barbers.sort((a, b) => {
        const tierDiff = tierOrder[a.tier] - tierOrder[b.tier];
        if (tierDiff !== 0) return tierDiff;
        const aFirst = new Date(a.slots[0]?.startTime || "9999");
        const bFirst = new Date(b.slots[0]?.startTime || "9999");
        return aFirst - bFirst;
      });

      console.log(`✅ [KIOSK] Found ${barbers.length} available barbers for ${service}, days=${days} (tiers: ${barbers.map(b => b.tier).join(', ')})`);
      return res.json({ success: true, barbers, days });
    } catch (error) {
      console.error("❌ [KIOSK] Walk-in slots error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * POST /api/kiosk/walk-in-book
   * Book a walk-in appointment — creates/finds GHL contact, books on calendar, sends push
   */
  app.post("/api/kiosk/walk-in-book", async (req, res) => {
    const { calendarId, barberGhlUserId, startTime, endTime, customerName, customerPhone, service } = req.body;

    if (!calendarId || !barberGhlUserId || !startTime || !endTime || !customerName || !customerPhone || !service) {
      return res.status(400).json({
        success: false,
        error: "All fields required: calendarId, barberGhlUserId, startTime, endTime, customerName, customerPhone, service",
      });
    }

    try {
      const { supabase } = require("../clients/supabaseClient");
      const apnsService = require("../services/apnsService");
      const { BARBER_LOCATION_ID } = require("../config/kioskConfig");

      // 1. Find or create GHL contact on barbershop location
      const serviceLabel = service === "haircut_beard" ? "Haircut + Beard" : service === "beard_trim" ? "Beard Trim" : "Haircut";
      const WALK_IN_SERVICE_FIELD_ID = "ez95QC6Ois2V2uAFQUGY";

      let contactId;
      let isExistingContact = false;
      try {
        const dupeData = await ghlBarber.contacts.getDuplicateContact({
          locationId: BARBER_LOCATION_ID,
          number: customerPhone,
        });
        contactId = dupeData?.contact?.id;
        if (contactId) isExistingContact = true;
      } catch (err) {
        // Not found — will create
      }

      if (!contactId) {
        // Parse name into first/last
        const nameParts = customerName.trim().split(/\s+/);
        const firstName = nameParts[0];
        const lastName = nameParts.slice(1).join(" ") || "";

        try {
          const created = await ghlBarber.contacts.createContact({
            firstName,
            lastName: lastName || undefined,
            phone: customerPhone,
            locationId: BARBER_LOCATION_ID,
            source: "Kiosk Walk-In",
            assignedTo: barberGhlUserId,
            customFields: [
              { id: WALK_IN_SERVICE_FIELD_ID, field_value: serviceLabel },
            ],
          });
          contactId = created?.contact?.id;
        } catch (createErr) {
          console.error("❌ [KIOSK] Contact creation failed:", createErr.message);
          return res.status(500).json({ success: false, error: "Failed to create contact" });
        }
      }

      if (!contactId) {
        return res.status(500).json({ success: false, error: "Could not find or create contact" });
      }

      // If contact already existed, upsert name + walk-in service field + assign barber
      if (isExistingContact) {
        try {
          const nameParts = customerName.trim().split(/\s+/);
          const firstName = nameParts[0];
          const lastName = nameParts.slice(1).join(" ") || undefined;

          await ghlBarber.contacts.updateContact(
            { contactId },
            {
              firstName,
              lastName,
              assignedTo: barberGhlUserId,
              customFields: [
                { id: WALK_IN_SERVICE_FIELD_ID, field_value: serviceLabel },
              ],
            }
          );
        } catch (updateErr) {
          console.error("⚠️ [KIOSK] Contact update failed (continuing):", updateErr.message);
        }
      }

      // 2. Book appointment on the barber's calendar
      let appointmentId;
      try {
        const result = await ghlBarber.calendars.createAppointment({
          calendarId,
          contactId,
          locationId: BARBER_LOCATION_ID,
          startTime,
          endTime,
          title: `Walk-in ${serviceLabel}: ${customerName}`,
          appointmentStatus: "confirmed",
          assignedUserId: barberGhlUserId,
          toNotify: false,
        });
        appointmentId = result?.id || result?.event?.id;
      } catch (bookErr) {
        console.error("❌ [KIOSK] Appointment creation failed:", bookErr.response?.data || bookErr.message);
        return res.status(500).json({ success: false, error: "Failed to book appointment" });
      }

      // 3. Send push notification to barber
      if (apnsService.isConfigured()) {
        try {
          const { data: profile } = await supabase
            .from("profiles")
            .select("id")
            .eq("ghl_user_id", barberGhlUserId)
            .single();

          if (profile) {
            const { data: tokens } = await supabase
              .from("push_tokens")
              .select("token, language")
              .eq("user_id", profile.id)
              .eq("is_active", true);

            if (tokens && tokens.length > 0) {
              for (const tokenRecord of tokens) {
                try {
                  const isSpanish = tokenRecord.language === 'es';
                  const locale = isSpanish ? 'es-US' : 'en-US';
                  const time = new Date(startTime).toLocaleTimeString(locale, {
                    hour: "numeric",
                    minute: "2-digit",
                    hour12: true,
                    timeZone: "America/Chicago",
                  });
                  const notification = {
                    title: isSpanish ? "Walk-In Reservado" : "Walk-In Booked",
                    body: isSpanish
                      ? `${customerName} — ${serviceLabel} a las ${time}`
                      : `${customerName} — ${serviceLabel} at ${time}`,
                    data: { type: "kiosk_walk_in", appointmentId, customerName, service },
                  };
                  await apnsService.sendWithRefresh(tokenRecord.token, notification);
                } catch (pushErr) {
                  console.error("❌ [KIOSK] Push send error:", pushErr.message);
                }
              }
            }
          }
        } catch (notifErr) {
          console.error("⚠️ [KIOSK] Push notification failed (appointment still booked):", notifErr.message);
        }
      }

      console.log(`✅ [KIOSK] Walk-in booked: ${customerName} → ${barberGhlUserId} at ${startTime}`);
      return res.json({ success: true, appointmentId });
    } catch (error) {
      console.error("❌ [KIOSK] Walk-in booking error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // ═══ ANALYTICS ROUTES ═══
  app.use("/api/barbers", analyticsRoutes);

  // ═══ SEO TOOLKIT ROUTES ═══
  app.use("/api/seo", seoRoutes);

  // ═══ LEADS COMMAND CENTER ROUTES ═══
  app.use("/api/leads", leadsRoutes);

  // ═══ CONSENT FORM ROUTES ═══
  const {
    sendConsentForm,
    getConsentFormByToken,
    submitConsentForm,
    getConsentFormStatus,
    getConsentFormStatusBatch,
    sendDayOfConsentReminders,
    updateConsentForm,
    amendConsentForm,
    getAmendmentByToken,
    submitAmendment,
    getConsentFormDetails,
    checkPhoneForExistingContact,
  } = require("../consentForm/consentFormService");

  // Check if a phone number belongs to an existing GHL contact (called from iOS before creating new contact)
  app.post("/api/consent-form/check-phone", async (req, res) => {
    try {
      const { phone } = req.body;
      if (!phone) {
        return res.status(400).json({ success: false, error: "phone is required" });
      }
      const result = await checkPhoneForExistingContact(phone);
      res.json({ success: true, ...result });
    } catch (err) {
      console.error("❌ POST /api/consent-form/check-phone error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Send consent form SMS to a contact (called from iOS app)
  // Accepts either contactId (existing) or newContact { firstName, lastName, phone } (new)
  app.post("/api/consent-form/send", async (req, res) => {
    try {
      const {
        contactId,
        newContact,
        quotedPrice,
        numberOfSessions,
        assignedTechnician,
        technicianLicense,
        procedureDate,
        tattooPlacement,
        appointmentId,
      } = req.body;

      if (!contactId && !newContact) {
        return res.status(400).json({ success: false, error: "contactId or newContact is required" });
      }

      const result = await sendConsentForm({
        contactId,
        newContact,
        quotedPrice,
        numberOfSessions,
        assignedTechnician,
        technicianLicense,
        procedureDate,
        tattooPlacement,
        appointmentId,
      });

      if (!result.success) {
        return res.status(400).json(result);
      }

      res.json(result);
    } catch (err) {
      console.error("❌ POST /api/consent-form/send error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Get pre-filled consent form data by token (called from web form)
  app.get("/api/consent-form/:token", async (req, res) => {
    try {
      const result = await getConsentFormByToken(req.params.token);

      if (!result.success) {
        // Expired form → 410, already completed → 410, not found → 404
        const status = result.expired ? 410 : result.error?.includes("already") ? 410 : 404;
        return res.status(status).json(result);
      }

      res.json(result);
    } catch (err) {
      console.error("❌ GET /api/consent-form/:token error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Submit completed consent form (called from web form — multipart/form-data with optional ID photo)
  app.post("/api/consent-form/:token/submit", upload.single("idPhoto"), async (req, res) => {
    try {
      // Capture e-signature evidence from request
      const requestMeta = {
        ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || null,
        userAgent: req.headers["user-agent"] || null,
      };

      // Build submission object from multipart form fields + uploaded file
      const submission = { ...req.body };
      if (req.file) {
        submission.idPhoto = {
          buffer: req.file.buffer,
          filename: req.file.originalname,
          contentType: req.file.mimetype,
        };
      }

      const result = await submitConsentForm(req.params.token, submission, requestMeta);

      if (!result.success) {
        return res.status(400).json(result);
      }

      res.json(result);
    } catch (err) {
      console.error("❌ POST /api/consent-form/:token/submit error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Get consent form status for a single contact (called from iOS app)
  app.get("/api/consent-form/status/:contactId", async (req, res) => {
    try {
      const result = await getConsentFormStatus(req.params.contactId);
      res.json(result);
    } catch (err) {
      console.error("❌ GET /api/consent-form/status/:contactId error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Batch get consent form statuses (called from iOS calendar day view)
  app.post("/api/consent-form/status/batch", async (req, res) => {
    try {
      const { contactIds } = req.body;

      if (!Array.isArray(contactIds)) {
        return res.status(400).json({ success: false, error: "contactIds array is required" });
      }

      const result = await getConsentFormStatusBatch(contactIds);
      res.json(result);
    } catch (err) {
      console.error("❌ POST /api/consent-form/status/batch error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Send day-of consent form reminders (cron or manual trigger)
  app.post("/api/consent-form/send-day-of-reminders", async (req, res) => {
    try {
      const result = await sendDayOfConsentReminders();
      res.json(result);
    } catch (err) {
      console.error("❌ POST /api/consent-form/send-day-of-reminders error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── Phase 6: Consent Form Updates & Amendments ───

  // Update an unsigned consent form (new token, expire old, send SMS)
  app.post("/api/consent-form/:contactId/update", async (req, res) => {
    try {
      const { contactId } = req.params;
      const { tattooPlacement, quotedPrice, numberOfSessions, assignedTechnician, dateOfProcedure, changedBy } = req.body;

      const updates = {};
      if (tattooPlacement !== undefined) updates.tattoo_placement = tattooPlacement;
      if (quotedPrice !== undefined) updates.quoted_price = quotedPrice;
      if (numberOfSessions !== undefined) updates.number_of_sessions = numberOfSessions;
      if (assignedTechnician !== undefined) updates.assigned_technician = assignedTechnician;
      if (dateOfProcedure !== undefined) updates.date_of_procedure = dateOfProcedure;

      const result = await updateConsentForm(contactId, updates, changedBy);

      if (!result.success) {
        return res.status(400).json(result);
      }

      res.json(result);
    } catch (err) {
      console.error("❌ POST /api/consent-form/:contactId/update error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Create amendment for a signed consent form (new token, send SMS)
  app.post("/api/consent-form/:contactId/amend", async (req, res) => {
    try {
      const { contactId } = req.params;
      const { tattooPlacement, quotedPrice, numberOfSessions, assignedTechnician, dateOfProcedure } = req.body;

      const updates = {};
      if (tattooPlacement !== undefined) updates.tattoo_placement = tattooPlacement;
      if (quotedPrice !== undefined) updates.quoted_price = quotedPrice;
      if (numberOfSessions !== undefined) updates.number_of_sessions = numberOfSessions;
      if (assignedTechnician !== undefined) updates.assigned_technician = assignedTechnician;
      if (dateOfProcedure !== undefined) updates.date_of_procedure = dateOfProcedure;

      const result = await amendConsentForm(contactId, updates);

      if (!result.success) {
        return res.status(400).json(result);
      }

      res.json(result);
    } catch (err) {
      console.error("❌ POST /api/consent-form/:contactId/amend error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Get amendment details for web page
  app.get("/api/consent-form/amendment/:token", async (req, res) => {
    try {
      const result = await getAmendmentByToken(req.params.token);

      if (!result.success) {
        const status = result.error?.includes("already") ? 410 : 404;
        return res.status(status).json(result);
      }

      res.json(result);
    } catch (err) {
      console.error("❌ GET /api/consent-form/amendment/:token error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Submit signed amendment
  app.post("/api/consent-form/amendment/:token/submit", async (req, res) => {
    try {
      const requestMeta = {
        ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        userAgent: req.headers["user-agent"] || null,
      };

      const result = await submitAmendment(req.params.token, req.body, requestMeta);

      if (!result.success) {
        const status = result.error?.includes("already") ? 410 : 400;
        return res.status(status).json(result);
      }

      res.json(result);
    } catch (err) {
      console.error("❌ POST /api/consent-form/amendment/:token/submit error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Phase 4 — amendment history for a contact's signed amendments.
  // Returns chronological list (newest first) of completed amendments only.
  // The iOS QuotePaymentLedger uses this to render the inline "↳ Amended..."
  // subline + expandable history under the QUOTE total.
  app.get("/api/contacts/:contactId/amendment-history", async (req, res) => {
    try {
      const { contactId } = req.params;
      if (!supabase) {
        return res.status(503).json({ success: false, error: "Supabase not configured" });
      }

      const { data, error } = await supabase
        .from("consent_amendments")
        .select("id, contact_id, consent_form_id, changes, status, sent_at, completed_at, created_at")
        .eq("contact_id", contactId)
        .eq("status", "completed")
        .order("completed_at", { ascending: false });

      if (error) {
        return res.status(500).json({ success: false, error: error.message });
      }

      res.json({
        success: true,
        amendments: data || [],
        count: (data || []).length,
      });
    } catch (err) {
      console.error("[AmendmentHistory] error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Get current effective consent form details (for iOS update/amend sheet)
  app.get("/api/consent-form/:contactId/details", async (req, res) => {
    try {
      const result = await getConsentFormDetails(req.params.contactId);
      res.json(result);
    } catch (err) {
      console.error("❌ GET /api/consent-form/:contactId/details error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ═══ CONSENT FORM DAY-OF REMINDER CRON ═══
  const { startConsentReminderCron } = require("../consentForm/consentReminderCron");
  startConsentReminderCron();

  // ═══ NIGHTLY ANALYTICS SNAPSHOT CRON ═══
  startSnapshotCron();

  // ═══ MONDAY MONEY LEAK RITUAL CRON ═══
  startMondayRitualCron();

  // ═══ META ADS (Marketing API) ═══
  // Smoke-test endpoint — verifies the SDK + token + ad account wiring.
  // Returns the same campaigns the Meta MCP shows in Claude Desktop.
  app.get("/api/meta/campaigns", async (req, res) => {
    try {
      const { adAccount, Campaign } = require("../clients/metaAdsSdk");
      if (!adAccount) {
        return res.status(503).json({ success: false, error: "META_AD_ACCOUNT_ID not configured" });
      }
      const fields = [
        Campaign.Fields.id,
        Campaign.Fields.name,
        Campaign.Fields.objective,
        Campaign.Fields.status,
        Campaign.Fields.effective_status,
        Campaign.Fields.daily_budget,
        Campaign.Fields.lifetime_budget,
        Campaign.Fields.created_time,
      ];
      const campaigns = await adAccount.getCampaigns(fields, { limit: 100 });
      const data = campaigns.map((c) => c._data || c);
      return res.json({ success: true, count: data.length, campaigns: data });
    } catch (err) {
      const fbError = err.response?.data?.error || err.message || String(err);
      console.error("[Meta] /api/meta/campaigns error:", fbError);
      return res.status(500).json({ success: false, error: fbError });
    }
  });

  return app;
}

module.exports = { createApp };
