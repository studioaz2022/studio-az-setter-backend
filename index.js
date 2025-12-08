require("dotenv").config();

const crypto = require("crypto");
const multer = require("multer");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

const express = require("express");
const cors = require("cors");

const {
  uploadFilesToTattooCustomField,
  getContact,
  upsertContactFromWidget,
  updateSystemFields,
  updateTattooFields,
  sendConversationMessage,
} = require("./ghlClient");

const {
  decideLeadTemperature,
  initialPhaseForNewIntake,
  decidePhaseForMessage,
} = require("./src/ai/stateMachine");
const {
  syncOpportunityStageFromContact,
} = require("./src/ai/opportunityManager");

const { generateOpenerForContact } = require("./src/ai/aiClient");
const { handleInboundMessage } = require("./src/ai/controller");
const { createDepositLinkForContact, getContactIdFromOrder } = require("./src/payments/squareClient");
const {
  DEPOSIT_CONFIG,
  AI_PHASES,
  LEAD_TEMPERATURES,
  SYSTEM_FIELDS,
  CALENDARS,
  TRANSLATOR_CALENDARS,
  APPOINTMENT_STATUS,
  TATTOO_FIELDS,
} = require("./src/config/constants");
const { autoAssignArtist, determineArtist, assignArtistToContact } = require("./src/ai/artistRouter");
const { errorHandler, notFoundHandler } = require("./src/middleware/errorHandler");
const { cleanLogObject } = require("./src/utils/logger");
const {
  handleAppointmentOffer,
  createConsultAppointment,
  parseTimeSelection,
  isTimeSelection,
  formatSlotDisplay,
} = require("./src/ai/bookingController");
const {
  listAppointmentsForContact,
  updateAppointmentStatus,
  getConsultAppointmentsForContact,
  rescheduleAppointment,
} = require("./src/clients/ghlCalendarClient");
const {
  detectPathChoice,
  handlePathChoice,
} = require("./src/ai/consultPathHandler");

const app = express();

// 🔹 STRONG booking intent phrases - explicit time/booking requests
// These trigger in ANY phase - user is clearly asking for times
const STRONG_BOOKING_INTENT_PHRASES = [
  /what\s*time/i,
  /what\s*times?\s*(do\s*you\s*have|are\s*available)/i,
  /what\s*availability/i,
  /what\s*days/i,
  /send\s*(me\s*)?(the\s*)?(times|link)/i,
  /what'?s\s*(your\s*)?availability/i,
  /can\s*you\s*do\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
  /when\s*can\s*(we|you)\s*(do\s*it|book|meet)/i,
  /when\s*is\s*the\s*consult/i,
  /ready\s*to\s*(book|lock|schedule)/i,
  /book\s*(it|me|the\s*consult)/i,
  /lock\s*(it\s*)?in/i,
  /let'?s\s*(do\s*it|book|schedule)/i,
  /i\s*want\s*to\s*book/i,
  /schedule\s*(a\s*)?(consult|appointment)/i,
];

// 🔹 WEAK booking intent phrases - generic affirmatives
// These only trigger if we have core tattoo info OR are in late phase
const WEAK_BOOKING_INTENT_PHRASES = [
  /^yes$/i,
  /^yes\s*[!.?]*$/i,
  /^sure$/i,
  /^ok(ay)?$/i,
  /^perfect$/i,
  /^(yep|yup|yeah)$/i,
  /sounds?\s*good/i,
  /that\s*works/i,
  /i'?m\s*ready/i,
  /let'?s\s*do\s*it/i,
];

// 🔹 Slot selection phrases - user is picking a specific time
const SLOT_SELECTION_PHRASES = [
  /let'?s\s*(do|go\s*with|book)\s*(dec|december|jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|september|oct|october|nov|november)/i,
  /let'?s\s*(do|go\s*with|book)\s*(mon|tue|wed|thu|fri|sat|sun)/i,
  /let'?s\s*(do|go\s*with|book)\s*(option|#?\d)/i,
  /i'?ll\s*(take|do|go\s*with)\s*(dec|december|option|#?\d|the\s*\d)/i,
  /(dec|december|jan|january|feb|february|mon|tue|wed|thu|fri|sat|sun)\s*\d+/i,
  /option\s*#?\d/i,
  /#?\d\s*(works|is\s*good|please|sounds\s*good)/i,
  /the\s*(first|second|third|1st|2nd|3rd)\s*(one|option|time)/i,
  /i'?ll\s*take\s*(the\s*)?(first|second|third|1st|2nd|3rd|\d)/i,
];

// 🔹 Weekday names for extraction
const WEEKDAYS = [
  { name: "sunday", abbr: "sun", index: 0 },
  { name: "monday", abbr: "mon", index: 1 },
  { name: "tuesday", abbr: "tue", index: 2 },
  { name: "wednesday", abbr: "wed", index: 3 },
  { name: "thursday", abbr: "thu", index: 4 },
  { name: "friday", abbr: "fri", index: 5 },
  { name: "saturday", abbr: "sat", index: 6 },
];

function extractPreferredArtistFromPayload(payload = {}) {
  const customFields =
    payload.customFields ||
    payload.custom_fields ||
    payload.customField ||
    {};

  const rawValue =
    customFields.inquired_technician ||
    customFields[TATTOO_FIELDS?.INQUIRED_TECHNICIAN];

  if (!rawValue) return null;
  const trimmed = String(rawValue).trim();
  return trimmed.length ? trimmed : null;
}

async function ensureArtistAssignment(contactId, { contact, preferredArtist } = {}) {
  if (!contactId) return null;

  try {
    let contactRecord = contact;
    if (!contactRecord || typeof contactRecord !== "object") {
      contactRecord = await getContact(contactId);
    }

    if (!contactRecord) {
      console.warn(`⚠️ Unable to load contact ${contactId} for artist assignment`);
      return null;
    }

    const cf = contactRecord.customField || contactRecord.customFields || {};
    const currentArtist = cf[TATTOO_FIELDS.INQUIRED_TECHNICIAN];

    let artistToAssign =
      (preferredArtist && preferredArtist.trim()) ||
      (currentArtist && String(currentArtist).trim()) ||
      null;

    if (!artistToAssign) {
      artistToAssign = await determineArtist(contactRecord);
    }

    if (!artistToAssign) {
      console.warn(`⚠️ No artist determined for contact ${contactId}`);
      return null;
    }

    await assignArtistToContact(contactId, artistToAssign);
    return artistToAssign;
  } catch (err) {
    console.error(
      `❌ Failed to ensure artist assignment for contact ${contactId}:`,
      err.message || err
    );
    return null;
  }
}

/**
 * Check if message indicates STRONG booking intent (explicit time request)
 * These trigger in ANY phase
 */
function isStrongBookingIntent(messageText) {
  if (!messageText) return false;
  const text = String(messageText).trim();
  return STRONG_BOOKING_INTENT_PHRASES.some(pattern => pattern.test(text));
}

/**
 * Check if message indicates WEAK booking intent (generic affirmative)
 * These only trigger if we have core info or are in late phase
 */
function isWeakBookingIntent(messageText) {
  if (!messageText) return false;
  const text = String(messageText).trim();
  return WEAK_BOOKING_INTENT_PHRASES.some(pattern => pattern.test(text));
}

/**
 * Check if it's safe to treat weak affirmatives as booking intent
 * Only true if we have core tattoo info OR we're in a late phase
 */
function isSafeToTreatAsBookingIntent(contactProfile, currentPhase) {
  // Must have core tattoo info (summary OR placement)
  const hasCoreInfo = !!(
    contactProfile?.tattooSummary || 
    contactProfile?.tattooPlacement
  );
  
  // Or be in a late phase
  const inLatePhase = 
    currentPhase === AI_PHASES.QUALIFICATION ||
    currentPhase === AI_PHASES.CLOSING;
  
  return hasCoreInfo || inLatePhase;
}

/**
 * Check if message indicates booking intent (combined logic)
 * - Strong intent: triggers in any phase
 * - Weak intent: only triggers if safe (has core info or late phase)
 */
function isBookingIntent(messageText, contactProfile = null, currentPhase = null) {
  if (!messageText) return false;
  
  // Strong booking intent always triggers
  if (isStrongBookingIntent(messageText)) {
    return true;
  }
  
  // Weak booking intent only triggers if safe
  if (isWeakBookingIntent(messageText)) {
    // If no context provided, default to false for safety
    if (!contactProfile && !currentPhase) {
      return false;
    }
    return isSafeToTreatAsBookingIntent(contactProfile, currentPhase);
  }
  
  return false;
}

/**
 * Detect intent to reschedule an existing appointment
 */
function isRescheduleIntent(messageText) {
  if (!messageText) return false;
  const text = String(messageText).toLowerCase();
  const detected = (
    /\bresched(ule|uling)?\b/.test(text) ||
    /\b(change\b.*\b(time|day|date)\b|\btime\b.*\bchange\b)/.test(text) ||
    /\b(move\b.*\b(appointment|consult)\b|\bpush\b.*\b(appointment|consult)\b)/.test(text) ||
    /\b(different|another|new)\s+(time|day|date)\b/.test(text) ||
    /\b(can'?t|cannot)\s+make\s+it\b/.test(text) ||
    /\bsomething\s+came\s+up\b/.test(text) ||
    /\bneed\s+to\s+(change|move|switch)\b.*\b(time|day|date|appointment|consult)\b/.test(text) ||
    /\bthat\s+time\s+won'?t\s+work\b/.test(text) ||
    /\bthat\s+day\s+won'?t\s+work\b/.test(text)
  );
  
  if (detected) {
    console.log(`🔄 [RESCHEDULE_INTENT] Detected reschedule intent from message: "${messageText}"`);
  }
  
  return detected;
}

/**
 * Check if message is selecting a specific slot (should create appointment)
 */
function isSlotSelection(messageText) {
  if (!messageText) return false;
  const text = String(messageText).trim();
  return SLOT_SELECTION_PHRASES.some(pattern => pattern.test(text));
}

/**
 * Detect user's consult mode preference from message
 */
function detectConsultModePreference(messageText) {
  if (!messageText) return null;
  const text = String(messageText).toLowerCase();
  
  if (text.includes("in person") || text.includes("in-person") || text.includes("come in") || text.includes("at the studio") || text.includes("face to face")) {
    return "in-person";
  }
  if (text.includes("online") || text.includes("zoom") || text.includes("video") || text.includes("virtual") || text.includes("facetime")) {
    return "online";
  }
  return null;
}

/**
 * Extract requested weekday from message if user is asking for a specific day
 */
function extractRequestedWeekday(messageText) {
  if (!messageText) return null;
  const text = String(messageText).toLowerCase();
  
  for (const day of WEEKDAYS) {
    // Check for full name or abbreviation
    const fullMatch = new RegExp(`\\b${day.name}\\b`).test(text);
    const abbrMatch = new RegExp(`\\b${day.abbr}\\b`).test(text);
    
    if (fullMatch || abbrMatch) {
      return day;
    }
  }
  return null;
}

/**
 * Check if consult has been explained to this contact
 */
function hasConsultBeenExplained(contact) {
  const cf = contact?.customField || contact?.customFields || {};
  return cf.consult_explained === "Yes" || cf.consult_explained === true || cf.consult_explained === "true";
}

/**
 * Mark consult as explained for a contact
 */
async function markConsultExplained(contactId) {
  await updateSystemFields(contactId, {
    consult_explained: true,
  });
  console.log(`✅ Marked consult as explained for contact ${contactId}`);
}

/**
 * Store pending appointment in GHL custom fields (persists across restarts)
 */
async function storePendingAppointmentToGHL(contactId, appointmentData) {
  const fields = {
    pending_slot_start: appointmentData.slot?.startTime || null,
    pending_slot_end: appointmentData.slot?.endTime || null,
    pending_slot_display: appointmentData.slot?.displayText || null,
    pending_slot_artist: appointmentData.artist || null,
    pending_slot_calendar: appointmentData.calendarId || null,
    pending_slot_mode: appointmentData.consultMode || "online",
  };
  
  // Also store deposit link URL if provided
  if (appointmentData.depositLinkUrl) {
    fields.deposit_link_url = appointmentData.depositLinkUrl;
  }
  
  await updateSystemFields(contactId, fields);
  console.log(`📝 Stored pending appointment in GHL for contact ${contactId}:`, appointmentData.slot?.displayText);
}

/**
 * Get pending appointment from contact's custom fields
 */
function getPendingAppointmentFromContact(contact) {
  const cf = contact?.customField || contact?.customFields || {};
  
  const startTime = cf.pending_slot_start;
  const endTime = cf.pending_slot_end;
  const displayText = cf.pending_slot_display;
  
  // If no pending slot data, return null
  if (!startTime || !displayText) {
    return null;
  }
  
  return {
    slot: {
      startTime,
      endTime,
      displayText,
    },
    artist: cf.pending_slot_artist || null,
    calendarId: cf.pending_slot_calendar || null,
    consultMode: cf.pending_slot_mode || "online",
    depositLinkUrl: cf.deposit_link_url || null,
  };
}

/**
 * Clear pending appointment from GHL custom fields
 */
async function clearPendingAppointmentFromGHL(contactId) {
  await updateSystemFields(contactId, {
    pending_slot_start: null,
    pending_slot_end: null,
    pending_slot_display: null,
    pending_slot_artist: null,
    pending_slot_calendar: null,
    pending_slot_mode: null,
  });
  console.log(`🗑️ Cleared pending appointment from GHL for contact ${contactId}`);
}

/**
 * Check if times have already been sent to this contact
 */
function hasTimesSent(contact) {
  const cf = contact?.customField || contact?.customFields || {};
  return cf.times_sent === "Yes" || cf.times_sent === true;
}

/**
 * Get stored deposit link URL from contact
 */
function getStoredDepositLinkUrl(contact) {
  const cf = contact?.customField || contact?.customFields || {};
  return cf.deposit_link_url || null;
}

/**
 * Check if user wants the previously released slot
 */
function wantsPreviousSlot(messageText, lastReleasedSlotDisplay) {
  if (!messageText || !lastReleasedSlotDisplay) return false;
  
  const text = String(messageText).toLowerCase();
  const slotLower = String(lastReleasedSlotDisplay).toLowerCase();
  
  // Extract day/time from slot display (e.g., "wednesday, dec 3 at 5pm")
  const dayMatch = slotLower.match(/(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/);
  const timeMatch = slotLower.match(/(\d+)\s*(am|pm)/);
  
  const patterns = [
    /same\s*time/i,
    /that\s*time/i,
    /that\s*\d+\s*(am|pm)/i,
    /still\s*(open|available)/i,
    /can\s*i\s*still\s*(get|do|have)/i,
    /is\s*that\s*still\s*(open|available)/i,
    /can\s*we\s*still\s*do\s*that/i,
    /can\s*i\s*still\s*do\s*that/i,
    /that\s*(same|exact)\s*time/i,
  ];
  
  // Check for explicit patterns
  if (patterns.some(p => p.test(text))) {
    return true;
  }
  
  // Check if they mention the same day/time
  if (dayMatch && text.includes(dayMatch[1])) {
    if (timeMatch && text.includes(timeMatch[1]) && text.includes(timeMatch[2])) {
      return true;
    }
    // If they mention the day and ask about availability
    if (text.includes("still") || text.includes("available") || text.includes("open")) {
      return true;
    }
  }
  
  return false;
}

/**
 * Determine if channel supports emojis (IG, FB, WhatsApp, Email - NOT SMS)
 */
function channelSupportsEmojis(channelContext, contact) {
  // If it's a DM (Instagram/Facebook), emojis are OK
  if (channelContext?.isDm) return true;
  
  // Check contact tags for channel type
  const tags = contact?.tags || [];
  const tagStr = tags.map(t => String(t).toUpperCase()).join(" ");
  
  if (tagStr.includes("INSTAGRAM") || tagStr.includes("FACEBOOK") || tagStr.includes("WHATSAPP") || tagStr.includes("EMAIL")) {
    return true;
  }
  
  // If it's SMS (has phone, not DM), no emojis
  if (channelContext?.hasPhone && !channelContext?.isDm) {
    return false;
  }
  
  // Default: no emojis for safety
  return false;
}

/**
 * Strip emojis from text
 */
function stripEmojis(text) {
  if (!text) return text;
  // Remove common emoji ranges
  return text.replace(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FA6F}]|[\u{1FA70}-\u{1FAFF}]|[\u{231A}-\u{231B}]|[\u{23E9}-\u{23F3}]|[\u{23F8}-\u{23FA}]|[\u{25AA}-\u{25AB}]|[\u{25B6}]|[\u{25C0}]|[\u{25FB}-\u{25FE}]|[\u{2614}-\u{2615}]|[\u{2648}-\u{2653}]|[\u{267F}]|[\u{2693}]|[\u{26A1}]|[\u{26AA}-\u{26AB}]|[\u{26BD}-\u{26BE}]|[\u{26C4}-\u{26C5}]|[\u{26CE}]|[\u{26D4}]|[\u{26EA}]|[\u{26F2}-\u{26F3}]|[\u{26F5}]|[\u{26FA}]|[\u{26FD}]|[\u{2702}]|[\u{2705}]|[\u{2708}-\u{270D}]|[\u{270F}]|[\u{2712}]|[\u{2714}]|[\u{2716}]|[\u{271D}]|[\u{2721}]|[\u{2728}]|[\u{2733}-\u{2734}]|[\u{2744}]|[\u{2747}]|[\u{274C}]|[\u{274E}]|[\u{2753}-\u{2755}]|[\u{2757}]|[\u{2763}-\u{2764}]|[\u{2795}-\u{2797}]|[\u{27A1}]|[\u{27B0}]|[\u{27BF}]|[\u{2934}-\u{2935}]|[\u{2B05}-\u{2B07}]|[\u{2B1B}-\u{2B1C}]|[\u{2B50}]|[\u{2B55}]|[\u{3030}]|[\u{303D}]|[\u{3297}]|[\u{3299}]|🙌|🔥|💪|✨|👀|💯|👊|🤙|✅|❤️|💜|💙|🖤|🤍/gu, '').trim();
}

// 🔹 Per-contact generation tracking for canceling pending bubbles
const contactGenerations = new Map();

/**
 * Get current generation ID for a contact
 */
function getContactGeneration(contactId) {
  return contactGenerations.get(contactId) || 0;
}

/**
 * Increment and get new generation ID for a contact
 */
function newContactGeneration(contactId) {
  const newGen = (contactGenerations.get(contactId) || 0) + 1;
  contactGenerations.set(contactId, newGen);
  return newGen;
}

/**
 * Check if a generation is still current (not superseded by new message)
 */
function isGenerationCurrent(contactId, generationId) {
  return contactGenerations.get(contactId) === generationId;
}

// 🔹 Simple heuristic to detect Spanish messages
function looksLikeSpanish(text) {
  if (!text) return false;
  const v = String(text).toLowerCase();

  const spanishHints = [
    "hola",
    "gracias",
    "buenos días",
    "buenas tardes",
    "buenas noches",
    "quiero",
    "podría",
    "me gustaría",
    "tatuaje",
    "tatuajes",
    "cita",
    "presupuesto",
    "antebrazo",
    "muñeca",
    "pierna",
    "dolor",
    "cotizar",
    "cotización",
    "cotices",
    "cotizo",
    "busco",
    "oye",
    "negro y gris",
    "en un mes",
  ];

  const hasAccent = /[áéíóúñ]/.test(v);

  let hits = 0;
  for (const word of spanishHints) {
    if (v.includes(word)) hits++;
  }

  // Accent OR at least 2 Spanish words = Spanish
  return hasAccent || hits >= 2;
}

// Detect if an English lead expresses comfort speaking Spanish/bilingual
function detectsSpanishComfort(text) {
  if (!text) return false;
  const v = String(text).toLowerCase();
  const patterns = [
    /hablo\s+espa[nñ]ol/,
    /puedo\s+hablar\s+espa[nñ]ol/,
    /se[eé]\s+espa[nñ]ol/,
    /\bi\s+spea?k?\s+spanish\b/,
    /\bi'?m\s+bilingual\b/,
    /spanish\s+is\s+fine/,
    /no\s+problem\s+with\s+spanish/,
    /spanish\s+works/,
    /espa[nñ]ol\s+est[aá]\s+bien/,
  ];
  return patterns.some((p) => p.test(v));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculateDelayForText(text) {
  const len = (text || "").length;

  // Delay rules (you can tune these later)
  if (len < 80) return 8000;     // ~8 seconds
  if (len < 160) return 12000;   // ~12 seconds
  return 18000;                  // ~18 seconds
}

// 🔐 Validate Square webhook signatures using x-square-hmacsha256-signature
function verifySquareSignatureSafe({ req, rawBody }) {
  try {
    const signatureHeader =
      req.headers["x-square-hmacsha256-signature"] ||
      req.headers["x-square-signature"];
    const signatureKey = process.env.SQUARE_WEBHOOK_SECRET;
    if (!signatureKey || !signatureHeader) {
      console.warn(
        "[Square] Missing SQUARE_WEBHOOK_SECRET or signature header; skipping strict verification."
      );
      return {
        isValid: false,
        expectedSignature: null,
        receivedSignature: signatureHeader || null,
      };
    }

    // IMPORTANT: Square spec: HMAC-SHA256 over (notificationUrl + rawBody)
    const notificationUrl =
      process.env.SQUARE_WEBHOOK_NOTIFICATION_URL ||
      "https://studio-az-setter-backend.onrender.com/square/webhook";
    const hmac = crypto.createHmac("sha256", signatureKey);
    hmac.update(notificationUrl + rawBody);
    const expectedSignature = hmac.digest("base64");

    const isValid = expectedSignature === signatureHeader;

    return {
      isValid,
      expectedSignature,
      receivedSignature: signatureHeader,
    };
  } catch (err) {
    console.error("[Square] Error verifying webhook signature:", err);
    return {
      isValid: false,
      expectedSignature: null,
      receivedSignature: null,
    };
  }
}

// Internal endpoint for hold sweep (called by cron job)
// TODO: Once GHL pipeline is set up, query contacts by pipeline stage
// For now, this endpoint is ready but needs GHL contact search implementation
app.post("/internal/holds/sweep", async (req, res) => {
  console.log("🕐 Hold sweep job started");
  
  try {
    // TODO: Query contacts with hold_appointment_id set and deposit_paid === false
    // Options:
    // 1. Use GHL API search/filter (when available)
    // 2. Use pipeline stage/opportunity status (once pipeline is set up)
    // 3. Maintain in-memory list (lost on restart - not ideal)
    
    // Placeholder: For now, this endpoint is ready but needs GHL contact query
    // Once pipeline is set up, replace this with:
    // const activeHolds = await getContactsWithActiveHolds(); // Implement this
    
    // Example structure for when pipeline is ready:
    /*
    const activeHolds = await getContactsWithActiveHolds(); // Returns array of contactIds
    
    for (const contactId of activeHolds) {
      const contact = await getContact(contactId);
      const cf = contact?.customField || contact?.customFields || {};
      
      const holdAppointmentId = cf.hold_appointment_id;
      const holdLastActivityAt = cf.hold_last_activity_at;
      const holdWarningSent = cf.hold_warning_sent === "Yes" || cf.hold_warning_sent === true;
      const depositPaid = cf.deposit_paid === "Yes" || cf.deposit_paid === true;
      
      if (!holdAppointmentId || depositPaid) continue;
      
      const now = new Date();
      const lastActivity = new Date(holdLastActivityAt);
      const minutesSinceLastActivity = Math.floor((now - lastActivity) / (1000 * 60));
      
      // Case A: 10 minutes of silence, no warning sent yet
      if (minutesSinceLastActivity >= 10 && minutesSinceLastActivity < 20 && !holdWarningSent) {
        // Get appointment to get slot display
        const consultCalendarIds = Object.values(CALENDARS);
        const appointments = await getConsultAppointmentsForContact(contactId, consultCalendarIds);
        const holdAppointment = appointments.find(apt => apt.id === holdAppointmentId);
        
        if (holdAppointment) {
          const slotDisplay = formatSlotDisplay(new Date(holdAppointment.startTime));
          
          // Determine channel context
          const hasPhone = !!(contact.phone || contact.phoneNumber);
          const tags = contact.tags || [];
          const isDm = tags.some(
            (t) =>
              typeof t === "string" &&
              (t.includes("INSTAGRAM") || t.includes("FACEBOOK") || t.includes("DM"))
          );
          
          const channelContext = {
            isDm,
            hasPhone,
            conversationId: null,
            phone: contact.phone || contact.phoneNumber || null,
          };
          
          const useEmojis = channelSupportsEmojis(channelContext, contact);
          
          const warningMessage = useEmojis
            ? `Quick heads up — I'm holding ${slotDisplay} for you right now.\n\nIf I don't hear back in about 10 minutes, I'll release it so someone else can book that time.\n\nIf you still want it, just reply here or complete the deposit 🙌`
            : `Quick heads up — I'm holding ${slotDisplay} for you right now. If I don't hear back in about 10 minutes, I'll release it so someone else can book that time. If you still want it, just reply here or complete the deposit.`;
          
          await sendConversationMessage({
            contactId,
            body: warningMessage,
            channelContext,
          });
          
          await updateSystemFields(contactId, {
            hold_warning_sent: true,
          });
          
          console.log(`⚠️ Sent 10-minute warning to contact ${contactId}`);
        }
      }
      
      // Case B: 20+ minutes of silence (hard timeout)
      if (minutesSinceLastActivity >= 20 && !depositPaid) {
        const consultCalendarIds = Object.values(CALENDARS);
        const appointments = await getConsultAppointmentsForContact(contactId, consultCalendarIds);
        const holdAppointment = appointments.find(apt => apt.id === holdAppointmentId);
        
        if (holdAppointment && holdAppointment.appointmentStatus === APPOINTMENT_STATUS.NEW) {
          // Cancel the appointment
          await updateAppointmentStatus(holdAppointmentId, APPOINTMENT_STATUS.CANCELLED);
          
          const slotDisplay = formatSlotDisplay(new Date(holdAppointment.startTime));
          
          // Save "last released" info
          await updateSystemFields(contactId, {
            last_released_slot_display: slotDisplay,
            last_released_slot_start: holdAppointment.startTime,
            last_released_slot_end: holdAppointment.endTime,
            // Clear active hold fields
            hold_appointment_id: null,
            hold_last_activity_at: null,
            hold_warning_sent: false,
          });
          
          // Determine channel context
          const hasPhone = !!(contact.phone || contact.phoneNumber);
          const tags = contact.tags || [];
          const isDm = tags.some(
            (t) =>
              typeof t === "string" &&
              (t.includes("INSTAGRAM") || t.includes("FACEBOOK") || t.includes("DM"))
          );
          
          const channelContext = {
            isDm,
            hasPhone,
            conversationId: null,
            phone: contact.phone || contact.phoneNumber || null,
          };
          
          const useEmojis = channelSupportsEmojis(channelContext, contact);
          
          const releaseMessage = useEmojis
            ? `I went ahead and released ${slotDisplay} so someone else can grab it.\n\nIf you still want to move forward, I can send you fresh times or see if that same time is still open 👍`
            : `I went ahead and released ${slotDisplay} so someone else can grab it. If you still want to move forward, I can send you fresh times or see if that same time is still open.`;
          
          await sendConversationMessage({
            contactId,
            body: releaseMessage,
            channelContext,
          });
          
          console.log(`🗑️ Cancelled hold appointment for contact ${contactId} (20+ min inactivity)`);
        }
      }
    }
    */
    
    console.log("✅ Hold sweep completed (placeholder - waiting for GHL pipeline setup)");
    res.status(200).json({ success: true, message: "Hold sweep completed (placeholder)" });
  } catch (err) {
    console.error("❌ Error in hold sweep:", err.message || err);
    res.status(500).json({ error: err.message });
  }
});

// Appointment sync webhook (artist <-> translator)
app.post("/webhooks/ghl/appointment", async (req, res) => {
  const sharedSecret = process.env.GHL_APPOINTMENT_WEBHOOK_SECRET;
  const providedSecret =
    req.headers["x-webhook-secret"] ||
    req.headers["x-ghl-signature"] ||
    null;

  if (sharedSecret && providedSecret && sharedSecret !== providedSecret) {
    console.warn("⚠️ Appointment webhook rejected: invalid secret");
    return res.status(401).json({ ok: false });
  }

  try {
    const payload = req.body || {};
    const appointment = payload.appointment || payload || {};

    const appointmentId = appointment.id || appointment.appointmentId;
    const contactId = appointment.contactId || appointment.contact_id;
    const calendarId = appointment.calendarId || appointment.calendar_id;
    const rawStatus = appointment.appointmentStatus || appointment.status;
    const startISO = appointment.startTime || appointment.start_time;
    const endISO = appointment.endTime || appointment.end_time;

    if (!appointmentId || !contactId || !calendarId || !startISO || !endISO) {
      console.warn("⚠️ Appointment webhook missing required fields");
      return res.status(200).json({ ok: true });
    }

    const translatorCalSet = new Set(Object.values(TRANSLATOR_CALENDARS));
    const artistCalSet = new Set(Object.values(CALENDARS));
    const actorIsTranslator = translatorCalSet.has(calendarId);
    const siblingCalIds = actorIsTranslator ? Array.from(artistCalSet) : Array.from(translatorCalSet);

    const isCancelled = ["cancelled", "canceled"].includes(String(rawStatus || "").toLowerCase());

    const allEvents = await listAppointmentsForContact(contactId);
    const baseStart = new Date(startISO).getTime();
    const dayMs = 24 * 60 * 60 * 1000;

    const siblings = allEvents.filter((ev) => {
      if (!ev || !ev.id || ev.id === appointmentId) return false;
      if (!siblingCalIds.includes(ev.calendarId)) return false;
      if (ev.contactId !== contactId) return false;
      const evStart = new Date(ev.startTime).getTime();
      return Math.abs(evStart - baseStart) <= dayMs;
    });

    if (!siblings.length) {
      console.log("ℹ️ Appointment webhook: no sibling events to sync");
      return res.status(200).json({ ok: true, synced: 0 });
    }

    if (isCancelled) {
      await Promise.all(
        siblings.map((ev) =>
          updateAppointmentStatus(ev.id, APPOINTMENT_STATUS.CANCELLED).catch((err) =>
            console.error("❌ Failed to cancel sibling appointment:", err.response?.data || err.message)
          )
        )
      );
      return res.status(200).json({ ok: true, synced: siblings.length, action: "cancelled" });
    }

    await Promise.all(
      siblings.map((ev) =>
        rescheduleAppointment(ev.id, {
          startTime: startISO,
          endTime: endISO,
          appointmentStatus: ev.appointmentStatus || "confirmed",
        }).catch((err) =>
          console.error("❌ Failed to reschedule sibling appointment:", err.response?.data || err.message)
        )
      )
    );

    return res.status(200).json({ ok: true, synced: siblings.length, action: "rescheduled" });
  } catch (err) {
    console.error("❌ Error in appointment sync webhook:", err.response?.data || err.message);
    return res.status(200).json({ ok: false });
  }
});

app.post(
  "/square/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    console.log("📬 Square webhook received");

    try {
      const rawBody = req.body.toString("utf8");
      console.log("📬 Square Webhook Raw Body:\n", rawBody);

      const { isValid, expectedSignature, receivedSignature } =
        verifySquareSignatureSafe({ req, rawBody });

      if (!isValid) {
        console.warn(
          "⚠️ Square webhook signature did NOT validate. Continuing in sandbox mode.\n" +
            "Double-check that SQUARE_WEBHOOK_SECRET matches the 'Signature key' configured for this webhook subscription in the Square Dashboard."
        );
        if (expectedSignature && receivedSignature) {
          console.warn("Expected:", expectedSignature);
          console.warn("Received:", receivedSignature);
        }
      } else {
        console.log("✅ Square webhook signature validated.");
      }

      // Parse JSON AFTER signature check
      const event = JSON.parse(rawBody);
      console.log("📬 Parsed Square Event Type:", event.type);

      const eventType = event?.type;

      // We care primarily about payment events
      if (eventType === "payment.created" || eventType === "payment.updated") {
        const payment = event?.data?.object?.payment;
        if (!payment) {
          console.warn("⚠️ payment webhook without payment object");
        } else {
          const status = payment.status;
          const amount = payment.amount_money?.amount;
          const currency = payment.amount_money?.currency;
          const orderId = payment.order_id;

          console.log("💳 Payment details:", {
            paymentId: payment.id,
            status,
            amount,
            currency,
            orderId,
          });

          // Only act on completed/approved payments
          const normalizedStatus = (status || "").toUpperCase();
          const isDone =
            normalizedStatus === "COMPLETED" ||
            normalizedStatus === "APPROVED" ||
            normalizedStatus === "CAPTURED";

          if (isDone && orderId) {
            // Map order → GHL contactId via reference_id
            const contactId = await getContactIdFromOrder(orderId);

            if (!contactId) {
              console.warn(
                "⚠️ Could not resolve contactId from order; not updating GHL.",
                { orderId, paymentId: payment.id }
              );
            } else {
              console.log(`🎉 Deposit paid for contact ${contactId}`);

              // Mark deposit as paid in GHL system fields
              try {
                await updateSystemFields(contactId, {
                  deposit_paid: true,
                  deposit_link_sent: true,
                  last_phase_update_at: new Date().toISOString(),
                  ai_phase: AI_PHASES.HANDOFF, // Move to handoff phase after deposit paid
                });
                console.log("✅ System fields updated after deposit payment");

                // 🔁 Sync pipeline: deposit paid → move to QUALIFIED or later
                try {
                  await syncOpportunityStageFromContact(contactId, { aiPhase: AI_PHASES.HANDOFF });
                  console.log("🏗️ Pipeline stage synced after deposit payment");
                } catch (oppErr) {
                  console.error("❌ Error syncing opportunity stage after deposit payment:", oppErr.message || oppErr);
                }
              } catch (ghlErr) {
                console.error("❌ Error updating GHL after deposit:", ghlErr.message || ghlErr);
              }

              // Auto-assign artist after deposit is paid
              try {
                const assignedArtist = await autoAssignArtist(contactId);
                if (assignedArtist) {
                  console.log(`✅ Artist ${assignedArtist} auto-assigned to contact ${contactId}`);
                } else {
                  console.log(`ℹ️ No artist assigned (could not determine from contact data)`);
                }
              } catch (artistErr) {
                console.error("❌ Error auto-assigning artist after deposit:", artistErr.message || artistErr);
                // Don't fail the webhook if artist assignment fails
              }

              // 📅 Check for hold appointment - prioritize hold_appointment_id
              const contact = await getContact(contactId);
              const cf = contact?.customField || contact?.customFields || {};
              const holdAppointmentId = cf.hold_appointment_id;
              
              let appointmentCreated = false;
              let appointmentSlotDisplay = null;
              let appointmentArtist = null;

              if (holdAppointmentId) {
                // Use the hold appointment
                try {
                  const consultCalendarIds = Object.values(CALENDARS);
                  const appointments = await getConsultAppointmentsForContact(contactId, consultCalendarIds);
                  const holdAppointment = appointments.find(apt => apt.id === holdAppointmentId);
                  
                  if (holdAppointment && holdAppointment.appointmentStatus === APPOINTMENT_STATUS.NEW) {
                    // Confirm the hold appointment
                    await updateAppointmentStatus(holdAppointmentId, APPOINTMENT_STATUS.CONFIRMED);
                    
                    appointmentCreated = true;
                    appointmentSlotDisplay = formatSlotDisplay(new Date(holdAppointment.startTime));
                    appointmentArtist = holdAppointment.assignedUserId || null;
                    
                    // Clear hold fields
                    await updateSystemFields(contactId, {
                      hold_appointment_id: null,
                      hold_last_activity_at: null,
                      hold_warning_sent: false,
                    });
                    
                    console.log("✅ Confirmed hold appointment after deposit:", holdAppointmentId);
                  } else {
                    console.log(`⚠️ Hold appointment ${holdAppointmentId} not found or not NEW status`);
                  }
                } catch (apptErr) {
                  console.error("❌ Error confirming hold appointment:", apptErr.message || apptErr);
                }
              }

              // 📅 Fallback: Check GHL for any appointments with status "new" (if hold_appointment_id wasn't found)
              if (!appointmentCreated) {
                try {
                  const consultCalendarIds = Object.values(CALENDARS);
                  const consultAppointments = await getConsultAppointmentsForContact(
                    contactId,
                    consultCalendarIds
                  );

                  // Find the nearest future appointment with status "new"
                  const pendingGHLAppointments = consultAppointments.filter(
                    (apt) => apt.appointmentStatus === APPOINTMENT_STATUS.NEW
                  );

                  if (pendingGHLAppointments.length > 0) {
                    // Sort by startTime and get the earliest one
                    pendingGHLAppointments.sort(
                      (a, b) => new Date(a.startTime) - new Date(b.startTime)
                    );
                    const appointmentToConfirm = pendingGHLAppointments[0];

                    // Update appointment status to "confirmed"
                    await updateAppointmentStatus(
                      appointmentToConfirm.id,
                      APPOINTMENT_STATUS.CONFIRMED
                    );

                    console.log(`✅ Appointment confirmed after deposit:`, {
                      appointmentId: appointmentToConfirm.id,
                      startTime: appointmentToConfirm.startTime,
                    });

                    appointmentCreated = true;
                    appointmentSlotDisplay = formatSlotDisplay(new Date(appointmentToConfirm.startTime));
                    // Try to get artist from appointment
                    appointmentArtist = appointmentToConfirm.assignedUserId || null;
                    
                    // Clear hold fields if they exist
                    await updateSystemFields(contactId, {
                      hold_appointment_id: null,
                      hold_last_activity_at: null,
                      hold_warning_sent: false,
                    });
                  } else {
                    console.log(`ℹ️ No pending appointments found to confirm for contact ${contactId}`);
                  }
                } catch (apptErr) {
                  console.error("❌ Error checking/confirming GHL appointments:", apptErr.message || apptErr);
                }
              }

              // 📬 Send confirmation DM - ONLY if not already sent
              try {
                const contactForDm = contact || (await getContact(contactId));
                if (contactForDm) {
                  const cfForDm = contactForDm.customField || contactForDm.customFields || {};
                  const alreadySent =
                    cfForDm.deposit_confirmation_sent === "Yes" ||
                    cfForDm.deposit_confirmation_sent === true;

                  if (alreadySent) {
                    console.log("ℹ️ Deposit confirmation already sent, skipping duplicate DM");
                  } else {
                    const hasPhone = !!(contactForDm.phone || contactForDm.phoneNumber);
                    const tags = contactForDm.tags || [];
                    const isDm = tags.some(
                      (t) =>
                        typeof t === "string" &&
                        (t.includes("INSTAGRAM") || t.includes("FACEBOOK") || t.includes("DM"))
                    );

                    const channelContext = {
                      isDm,
                      hasPhone,
                      conversationId: null,
                      phone: contactForDm.phone || contactForDm.phoneNumber || null,
                    };

                    const useEmojis = channelSupportsEmojis(channelContext, contactForDm);

                    let confirmMessage;
                    if (appointmentCreated && appointmentSlotDisplay) {
                      confirmMessage = useEmojis
                        ? `Got your deposit 🙌\nYou're officially locked in for ${appointmentSlotDisplay}${appointmentArtist ? ` with ${appointmentArtist}` : ""}.\nYou'll get a reminder before your consult.`
                        : `Got your deposit! You're officially locked in for ${appointmentSlotDisplay}${appointmentArtist ? ` with ${appointmentArtist}` : ""}. You'll get a reminder before your consult.`;
                    } else {
                      confirmMessage = useEmojis
                        ? `Got your deposit 🙌\nNow let's lock in your consult time. What days work best for you?`
                        : `Got your deposit! Now let's lock in your consult time. What days work best for you?`;
                    }

                    await sendConversationMessage({
                      contactId,
                      body: confirmMessage,
                      channelContext,
                    });

                    await updateSystemFields(contactId, {
                      deposit_confirmation_sent: true,
                    });

                    console.log("📬 Deposit confirmation DM sent to contact");
                  }
                }
              } catch (dmErr) {
                console.error("❌ Error sending deposit confirmation DM:", dmErr.message || dmErr);
                // Don't fail the webhook if DM fails
              }

              // (Optional) Later we'll also move pipeline stage here once we have stage IDs nailed down.
              // e.g., await updatePipelineStage(contactId, "Deposit Paid");
            }
          } else {
            console.log(
              "ℹ️ Payment not in a completed/approved state yet; ignoring for now."
            );
          }
        }
      } else {
        // For now we just log other event types (order.updated, etc.)
        console.log("ℹ️ Non-payment webhook event received from Square.");
      }

      res.status(200).send("OK");
    } catch (err) {
      console.error("❌ Square Webhook error:", err);
      res.status(200).send("OK"); // still 200 to avoid retries while debugging
    }
  }
);

app.use(
  express.json({
    verify: (req, res, buf) => {
      // Save raw body for Square HMAC validation
      if (req.originalUrl === "/square/webhook") {
        req.rawBody = buf.toString("utf8");
      }
    },
  })
);

// 🔹 Allow your widget to call this API from the browser
app.use(
  cors({
    origin: "*", // for now allow all; we can tighten this later
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// (Optional but nice): log every request method + path
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// Temporary test route (you can keep this)
app.get("/", (req, res) => {
  res.send("Studio AZ AI Setter backend is running");
});

// Webhook to receive form/intake events from GoHighLevel
app.post("/ghl/form-webhook", async (req, res) => {
  console.log("📝 GHL FORM WEBHOOK HIT");
  console.log("Raw Body:", JSON.stringify(req.body, null, 2));

  const customData = req.body.customData || req.body.custom_data || {};
  const contactId =
    customData.contactId ||
    req.body.contactId ||
    null;

  console.log("Parsed contactId from form webhook:", contactId);

  if (!contactId) {
    console.warn("⚠️ No contactId found in form webhook payload");
    return res.status(200).send("OK");
  }

  const contact = await getContact(contactId);

  if (!contact) {
    console.warn("⚠️ Could not load contact from GHL for id:", contactId);
    return res.status(200).send("OK");
  }

  console.log("✅ Loaded Contact from GHL (form webhook):", cleanLogObject({
    id: contact.id || contact._id,
    firstName: contact.firstName || contact.first_name,
    lastName: contact.lastName || contact.last_name,
    email: contact.email,
    phone: contact.phone,
    tags: contact.tags,
  }));

      // 🔹 Extract how_soon_is_client_deciding in a robust way
  const cfRaw = contact.customField || contact.customFields || {};
  console.log("Contact customField raw:", JSON.stringify(cfRaw, null, 2));

  let howSoonValue = null;

  // 1) Try from contact.customField (object or array)
  if (Array.isArray(cfRaw)) {
    const match = cfRaw.find(
      (f) =>
        f &&
        (
          f.key === "how_soon_is_client_deciding" ||
          f.id === "how_soon_is_client_deciding" ||
          f.customFieldId === "how_soon_is_client_deciding"
        )
    );
    howSoonValue = match?.value || null;
  } else {
    howSoonValue =
      cfRaw["how_soon_is_client_deciding"] ||
      cfRaw["howSoonIsClientDeciding"] ||
      null;
  }

  // 2) If still null, FALL BACK to the webhook body (what GHL just sent us)
  if (!howSoonValue) {
    const rawBody = req.body || {};
    // Your log shows "How Soon Is Client Deciding?" as the label
    for (const [key, value] of Object.entries(rawBody)) {
      if (
        typeof key === "string" &&
        key.toLowerCase().includes("how soon is client deciding")
      ) {
        howSoonValue = value;
        break;
      }
    }
  }

  const leadTemperature = decideLeadTemperature(howSoonValue);
  const aiPhase = initialPhaseForNewIntake();
  const nowIso = new Date().toISOString();

  console.log("🧠 Derived system state (form):", cleanLogObject({
    leadTemperature,
    aiPhase,
    howSoonValue,
  }));

  await updateSystemFields(contactId, {
    ai_phase: aiPhase,
    lead_temperature: leadTemperature,
    last_phase_update_at: nowIso,
  });

  console.log("✅ System fields updated for form webhook");

  // 🔁 Sync pipeline stage based on new intake context
  try {
    await syncOpportunityStageFromContact(contactId, { aiPhase });
    console.log("🏗️ Pipeline stage synced from form webhook context");
  } catch (oppErr) {
    console.error("❌ Error syncing opportunity stage from form webhook:", oppErr.message || oppErr);
  }

  // 🔹 Call AI Setter for Opener and send it
  try {
    const aiResult = await generateOpenerForContact({
      contact,
      aiPhase,
      leadTemperature,
    });

    console.log("🤖 AI Opener suggestion:", JSON.stringify(aiResult, null, 2));

    // Build channel context for form submissions
    // For form submissions, we don't have a conversation yet, so we'll infer from contact data
    const hasPhone = !!(contact.phone || contact.phoneNumber);
    const tags = contact.tags || [];
    const isDm = tags.some(t => 
      typeof t === 'string' && (
        t.includes('INSTAGRAM') || 
        t.includes('FACEBOOK') || 
        t.includes('DM')
      )
    );

    const channelContext = {
      isDm,
      hasPhone,
      conversationId: null, // Form submissions don't have a conversation yet
      phone: contact.phone || contact.phoneNumber || null,
    };

    console.log("📡 Channel context for form opener:", channelContext);

    // Send AI opener bubbles if we have them
    if (aiResult && Array.isArray(aiResult.bubbles)) {
      let bubblesToSend = aiResult.bubbles
        .map((b) => (b || "").trim())
        .filter(Boolean);

      if (bubblesToSend.length === 0) {
        console.warn("⚠️ AI opener bubbles were empty after trimming, nothing sent.");
      } else {
        for (let i = 0; i < bubblesToSend.length; i++) {
          const text = bubblesToSend[i];

          // Only wait before bubble #2 and beyond (more human)
          if (i > 0) {
            const delayMs = calculateDelayForText(text);
            console.log(`⏱ Waiting ${delayMs}ms before sending opener bubble ${i + 1}...`);
            await sleep(delayMs);
          }

          await sendConversationMessage({
            contactId,
            body: text,
            channelContext,
          });
        }
        console.log("📤 Sent AI opener bubbles to GHL conversation.");

        // Update system fields from AI meta if present
        const meta = aiResult.meta || {};
        if (meta.aiPhase || meta.leadTemperature) {
          const updateFields = {};
          if (meta.aiPhase) updateFields.ai_phase = meta.aiPhase;
          if (meta.leadTemperature) updateFields.lead_temperature = meta.leadTemperature;
          updateFields.last_phase_update_at = new Date().toISOString();

          console.log("🧠 Updating contact system fields from AI opener meta:", {
            ai_phase: meta.aiPhase,
            lead_temperature: meta.leadTemperature,
          });

          await updateSystemFields(contactId, updateFields);
        }

        // Apply field_updates from AI response
        const fieldUpdates = aiResult.field_updates || {};
        if (fieldUpdates && Object.keys(fieldUpdates).length > 0) {
          console.log("🧾 Applying AI field_updates from opener to GHL:", fieldUpdates);
          try {
            await updateTattooFields(contactId, fieldUpdates);
            console.log("✅ Field updates applied from opener.");
          } catch (fieldErr) {
            console.error("❌ Error applying field_updates from opener:", fieldErr.message || fieldErr);
          }
        } else {
          console.log("ℹ️ No field_updates from AI opener to apply this turn.");
        }
      }
    } else {
      console.warn("⚠️ AI opener result did not contain bubbles array, nothing sent.");
    }
  } catch (err) {
    console.error("❌ Error generating or sending AI opener:", err.response?.data || err.message || err);
  }

  res.status(200).send("OK");
});


// Webhook to receive conversation messages from GoHighLevel
app.post("/ghl/message-webhook", async (req, res) => {
  const rawBody = req.body || {};
  
  console.log("💬 GHL MESSAGE WEBHOOK HIT");
  console.log("Raw Body:", JSON.stringify(rawBody, null, 2));

  // Identify source channel
  const messageObj = rawBody.message || {};

  const isDm =
    messageObj.type === 11 || // social DM (IG/FB)
    rawBody.channel === "social_dm" ||
    rawBody.channel === "instagram" ||
    rawBody.channel === "facebook";

  const hasPhone =
    !!rawBody.phone ||
    !!rawBody.contact?.phone ||
    !!rawBody.contact?.phoneNumber;

  const channelContext = {
    isDm,
    hasPhone,
    // conversationId is what we should use for DM replies
    conversationId:
      rawBody.conversationId ||
      messageObj.conversationId ||
      rawBody.conversation_id ||
      null,
    // best-guess phone for SMS replies
    phone:
      rawBody.phone ||
      rawBody.contact?.phone ||
      rawBody.contact?.phoneNumber ||
      null,
  };

  console.log("📡 Channel context:", channelContext);

  // Snapshot of relevant tattoo + deposit fields from the webhook body
  const contactProfileFromWebhook = {
    tattooPlacement: rawBody["Tattoo Placement"] || null,
    tattooSize: rawBody["Tattoo Size"] || null,
    tattooSummary: rawBody["Tattoo Summary"] || null,
    tattooStyle: rawBody["Tattoo Style"] || null,
    tattooColor: rawBody["Tattoo Color Preference"] || null,
    depositPaid:
      typeof rawBody["Deposit Paid"] === "string" &&
      rawBody["Deposit Paid"].toLowerCase() === "yes",
    depositLinkSent:
      typeof rawBody["Deposit Link Sent"] === "string" &&
      rawBody["Deposit Link Sent"].toLowerCase() === "yes",
  };

  const customData = req.body.customData || req.body.custom_data || {};
  const contactId =
    customData.contactId ||
    req.body.contactId ||
    null;

  console.log("Parsed contactId from message webhook:", contactId);

  if (!contactId) {
    console.warn("⚠️ No contactId found in message webhook payload");
    return res.status(200).send("OK");
  }

  const contact = await getContact(contactId);

  if (!contact) {
    console.warn("⚠️ Could not load contact from GHL for id:", contactId);
    return res.status(200).send("OK");
  }

  console.log("✅ Loaded Contact from GHL (message webhook):", cleanLogObject({
    id: contact.id || contact._id,
    firstName: contact.firstName || contact.first_name,
    lastName: contact.lastName || contact.last_name,
    email: contact.email,
    phone: contact.phone,
    tags: contact.tags,
  }));

  const cf = contact.customField || contact.customFields || {};
  const currentLanguage =
    cf["language_preference"] ||
    cf["Language Preference"] ||
    null;

  // Extract the latest message text from the webhook payload
  // Try direct string fields first
    let messageText =
    req.body.messageBody ||
    req.body.body ||
    "";

    // If not found yet and there's a message object, use its body
    if (!messageText && req.body.message && typeof req.body.message.body === "string") {
    messageText = req.body.message.body;
    }

    // Also check inside customData if needed
    if (!messageText && typeof customData.messageBody === "string") {
    messageText = customData.messageBody;
    }
    if (!messageText && typeof customData.body === "string") {
    messageText = customData.body;
    }
    if (!messageText && customData.message && typeof customData.message.body === "string") {
    messageText = customData.message.body;
    }

    // Final safety cast
    messageText = String(messageText || "");

    console.log("📩 Incoming message text (for language detection):", messageText);

  // Detect language from message and update if different from existing preference
  const existingLanguagePreference = currentLanguage;

  let detectedLanguage = null;

  if (looksLikeSpanish(messageText)) {
    detectedLanguage = "Spanish";
  } else {
    // If it's not clearly Spanish, treat it as English by default
    detectedLanguage = "English";
  }

  if (
    detectedLanguage &&
    detectedLanguage !== existingLanguagePreference
  ) {
    console.log(
      "🌐 Updating language_preference based on DM/SMS detection:",
      {
        previous: existingLanguagePreference,
        next: detectedLanguage,
      }
    );

    try {
      await updateSystemFields(contactId, {
        language_preference: detectedLanguage,
      });
      console.log("✅ language_preference updated to", detectedLanguage, "for contact:", contactId);
    } catch (err) {
      console.error(
        "❌ Failed to update language_preference:",
        err.response?.data || err.message
      );
    }
  } else {
    console.log(
      "ℹ️ language_preference unchanged:",
      existingLanguagePreference || "(none)"
    );
  }

  // Passive bilingual/Spanish comfort detection for English leads
  const contactLanguagePreference =
    currentLanguage ||
    existingLanguagePreference ||
    "English";

  const currentComfort =
    cf.lead_spanish_comfortable ||
    cf.leadSpanishComfortable ||
    null;
  const spanishComfortDetected = detectsSpanishComfort(messageText);
  const isEnglishLead =
    (contactLanguagePreference || "English").toLowerCase().includes("english");

  if (isEnglishLead && spanishComfortDetected && currentComfort !== "Yes") {
    try {
      await updateSystemFields(contactId, {
        lead_spanish_comfortable: true,
      });
      console.log(
        "✅ Detected Spanish comfort for English lead; updated lead_spanish_comfortable = Yes"
      );
    } catch (err) {
      console.error(
        "❌ Failed to update lead_spanish_comfortable:",
        err.response?.data || err.message
      );
    }
  }

  // Derive system state from webhook + contact fields
  const currentPhase =
    rawBody["AI Phase"] ||
    cf["ai_phase"] ||
    cf["aiPhase"] ||
    "";

  const systemState = {
    currentPhase,
    newPhase: currentPhase || "intake",
    leadTemperature:
      cf["lead_temperature"] ||
      cf["leadTemperature"] ||
      "warm",
  };

  console.log("🧠 Derived system state (message):", systemState);

  const nowIso = new Date().toISOString();

  await updateSystemFields(contactId, {
    ai_phase: systemState.newPhase,
    last_phase_update_at: nowIso,
  });

  console.log("✅ System fields updated for message webhook");

  // 🔁 Sync pipeline stage based on latest message context
  try {
    await syncOpportunityStageFromContact(contactId, { aiPhase: systemState.newPhase });
    console.log("🏗️ Pipeline stage synced from message webhook context");
  } catch (oppErr) {
    console.error("❌ Error syncing opportunity stage from message webhook:", oppErr.message || oppErr);
  }

  // 🔄 Refetch contact so intake sees latest language_preference
  let freshContact = contact;
  try {
    const refreshed = await getContact(contactId);
    if (refreshed) {
      freshContact = refreshed;
      console.log("🔄 Refetched contact after system field update for AI call.");
    }
  } catch (err) {
    console.warn(
      "⚠️ Could not refresh contact before AI call, falling back to stale contact:",
      err.response?.data || err.message
    );
  }

  // 🔹 Extract contact custom fields and system fields for AI payload
  const contactCustomFields = freshContact?.customField || freshContact?.customFields || {};
  const contactSystemFields = contactCustomFields; // System fields are also in customField
  
  // Get language preference from fresh contact
  const contactLanguagePreferenceFresh =
    contactCustomFields["language_preference"] ||
    contactCustomFields["Language Preference"] ||
    contactLanguagePreference ||
    "English";

  // Build merged contactProfile (webhook values take precedence)
  const contactProfile = {
    tattooPlacement:
      contactProfileFromWebhook.tattooPlacement ||
      contactCustomFields?.tattoo_placement ||
      null,
    tattooSize:
      contactProfileFromWebhook.tattooSize ||
      contactCustomFields?.size_of_tattoo ||
      null,
    tattooSummary:
      contactProfileFromWebhook.tattooSummary ||
      contactCustomFields?.tattoo_summary ||
      null,
    tattooStyle:
      contactProfileFromWebhook.tattooStyle ||
      contactCustomFields?.tattoo_style ||
      null,
    tattooColor:
      contactProfileFromWebhook.tattooColor ||
      contactCustomFields?.tattoo_color_preference ||
      null,
    leadSpanishComfortable:
      contactCustomFields?.lead_spanish_comfortable ||
      contactCustomFields?.leadSpanishComfortable ||
      null,
    translatorNeeded:
      contactCustomFields?.translator_needed === "Yes" ||
      contactCustomFields?.translatorNeeded === true,
    depositPaid:
      contactProfileFromWebhook.depositPaid ||
      contactSystemFields?.deposit_paid === "Yes",
    depositLinkSent:
      contactProfileFromWebhook.depositLinkSent ||
      contactSystemFields?.deposit_link_sent === "Yes",
    tattooDescriptionAcknowledged:
      !!(contactProfileFromWebhook.tattooSummary ||
        contactCustomFields?.tattoo_summary ||
        contactCustomFields?.["Tattoo Summary"]),
  };

  // Build enriched AI payload
  const aiPayload = {
    contactId,
    aiPhase: systemState.currentPhase || "intake",
    leadTemperature: systemState.leadTemperature,
    language: contactLanguagePreferenceFresh,
    contactProfile,
  };

  console.log("🤖 Processing message with payload summary:", cleanLogObject({
    contactId: aiPayload.contactId,
    leadTemperature: aiPayload.leadTemperature,
    aiPhase: aiPayload.aiPhase,
    language: aiPayload.language,
    hasTattooPlacement: !!contactProfile.tattooPlacement,
    hasTattooSize: !!contactProfile.tattooSize,
    depositPaid: contactProfile.depositPaid,
    depositLinkSent: contactProfile.depositLinkSent,
  }));

  // 🔄 Create new generation ID for this message (cancels any pending bubbles from previous turn)
  const currentGenerationId = newContactGeneration(contactId);
  console.log(`🔄 New generation ${currentGenerationId} for contact ${contactId}`);

  // Determine if channel supports emojis
  const useEmojis = channelSupportsEmojis(channelContext, freshContact);
  console.log(`📱 Channel emoji support: ${useEmojis ? "yes" : "no (SMS)"}`);

  // 📅 Check if user is selecting a time slot or showing booking intent
  let appointmentOfferData = null;
  let skipAIEntirely = false;

  // Get any existing pending appointment from GHL (persisted)
  const existingPendingAppt = getPendingAppointmentFromContact(freshContact);

  // Check deposit and times status
  const alreadySent = contactProfile.depositLinkSent === true;
  const alreadyPaid = contactProfile.depositPaid === true;
  const timesSent = hasTimesSent(freshContact);
  const storedDepositUrl = getStoredDepositLinkUrl(freshContact);

  // 🔄 Refresh hold timer on every inbound message
  const freshCf = freshContact?.customField || freshContact?.customFields || {};
  const holdAppointmentId = freshCf.hold_appointment_id;
  
  if (holdAppointmentId && !alreadyPaid) {
    // Verify appointment still exists and is NEW status
    try {
      const consultCalendarIds = Object.values(CALENDARS);
      const appointments = await getConsultAppointmentsForContact(contactId, consultCalendarIds);
      const holdAppointment = appointments.find(apt => apt.id === holdAppointmentId);
      
      if (holdAppointment && holdAppointment.appointmentStatus === APPOINTMENT_STATUS.NEW) {
        // Refresh hold timer
        await updateSystemFields(contactId, {
          hold_last_activity_at: new Date().toISOString(),
          hold_warning_sent: false, // Reset warning since they're active
        });
        console.log(`🔄 Refreshed hold timer for contact ${contactId}`);
      } else {
        // Appointment doesn't exist or isn't NEW - clear hold fields
        await updateSystemFields(contactId, {
          hold_appointment_id: null,
          hold_last_activity_at: null,
          hold_warning_sent: false,
        });
        console.log(`🗑️ Cleared invalid hold fields for contact ${contactId}`);
      }
    } catch (holdErr) {
      console.error("❌ Error refreshing hold timer:", holdErr.message || holdErr);
    }
  }

  // Detect consult mode preference from user's message (or default to online)
  const detectedConsultMode = detectConsultModePreference(messageText) || "online";

  // 🔀 Path choice handling (Message vs Translator/Video)
  const pathChoice = detectPathChoice(messageText);
  if (pathChoice && !skipAIEntirely) {
    const handled = await handlePathChoice({
      contactId,
      messageText,
      channelContext,
      sendConversationMessage,
      triggerAppointmentOffer: async ({ contactId: cid, channelContext: ctx, translatorNeeded }) => {
        // Generate appointment slots after translator choice
        const offer = await handleAppointmentOffer({
          contact: freshContact,
          aiMeta: {
            consultMode: detectedConsultMode,
            latestMessageText: messageText,
            translatorNeeded,
          },
          contactProfile,
        });

        if (offer && offer.slots && offer.slots.length > 0) {
          appointmentOfferData = offer;
          const slotsText = offer.slots
            .map((slot, idx) => `${idx + 1}. ${slot.displayText}`)
            .join("\n");

          await sendConversationMessage({
            contactId: cid,
            body: `Here are some times that work:\n\n${slotsText}\n\nWhich one works for you?`,
            channelContext: ctx,
          });
        }
      },
    });
    if (handled) {
      return res.status(200).json({
        success: true,
        message: `Consult path recorded: ${handled.choice}`,
      });
    }
  }

  // 🚀 SLOT SELECTION: User is picking a specific time (e.g., "Let's do Dec 3")
  // This should work in ANY phase - if they're picking a time, book it
  if (isSlotSelection(messageText) || isTimeSelection(messageText)) {
    console.log("🎯 SLOT SELECTION DETECTED - user is picking a specific time");
    skipAIEntirely = true;

    try {
      // Check if user requested a specific weekday that might not be in our current slots
      const requestedWeekday = extractRequestedWeekday(messageText);
      
      // Generate slots to match against (pass requested weekday if any)
      appointmentOfferData = await handleAppointmentOffer({
        contact: freshContact,
        aiMeta: {
          consultMode: detectedConsultMode,
          preferredDay: requestedWeekday?.name,
          latestMessageText: messageText,
          translatorNeeded: contactProfile.translatorNeeded,
        },
        contactProfile,
      });

      if (appointmentOfferData && appointmentOfferData.slots) {
        const matchedIndex = parseTimeSelection(messageText, appointmentOfferData.slots);
        if (matchedIndex !== null) {
          console.log(`✅ Matched slot ${matchedIndex + 1}: ${appointmentOfferData.slots[matchedIndex].displayText}`);
          const selectedSlot = appointmentOfferData.slots[matchedIndex];

          // Use slot's artist/calendar (TIME-FIRST) or fall back to offer data (ARTIST-FIRST)
          const slotArtist = selectedSlot.artist || appointmentOfferData.artist;
          const slotCalendarId = selectedSlot.calendarId || appointmentOfferData.calendarId;
          const translatorCalendarId =
            selectedSlot.translatorCalendarId || appointmentOfferData.translatorCalendarId || null;
          const translatorName = selectedSlot.translator || null;
          
          console.log(`📅 Booking with artist: ${slotArtist}, calendar: ${slotCalendarId} (mode: ${appointmentOfferData.mode || "unknown"})`);

          const reschedulePending =
            contactCustomFields?.reschedule_pending === "Yes" ||
            contactCustomFields?.reschedule_pending === true;
          const rescheduleTargetId =
            contactCustomFields?.reschedule_target_appointment_id ||
            contactCustomFields?.rescheduleTargetAppointmentId ||
            null;
          const rescheduleTranslatorTargetId =
            contactCustomFields?.reschedule_target_translator_appointment_id ||
            contactCustomFields?.rescheduleTargetTranslatorAppointmentId ||
            null;

          // RESCHEDULE FLOW: move existing appointment (and translator if present)
          if (reschedulePending && rescheduleTargetId) {
            try {
              const existingAppointments = await listAppointmentsForContact(contactId);
              const target = existingAppointments.find((apt) => apt.id === rescheduleTargetId);
              const isConfirmedTarget =
                (target && target.appointmentStatus === "confirmed") || alreadyPaid;

              await rescheduleAppointment(rescheduleTargetId, {
                startTime: selectedSlot.startTime,
                endTime: selectedSlot.endTime,
                appointmentStatus: isConfirmedTarget ? "confirmed" : "new",
              });

              if (rescheduleTranslatorTargetId) {
                try {
                  await rescheduleAppointment(rescheduleTranslatorTargetId, {
                    startTime: selectedSlot.startTime,
                    endTime: selectedSlot.endTime,
                    appointmentStatus: isConfirmedTarget ? "confirmed" : "new",
                  });
                } catch (translatorRescheduleErr) {
                  console.error(
                    "❌ Error rescheduling translator appointment:",
                    translatorRescheduleErr.message || translatorRescheduleErr
                  );
                }
              }

              const now = new Date().toISOString();
              const display = selectedSlot.displayText;

              if (isConfirmedTarget) {
                await updateSystemFields(contactId, {
                  ai_phase: AI_PHASES.CLOSING,
                  last_phase_update_at: now,
                  reschedule_pending: false,
                  reschedule_target_appointment_id: null,
                  reschedule_target_translator_appointment_id: null,
                  hold_appointment_id: null,
                  hold_last_activity_at: null,
                  hold_warning_sent: false,
                  last_released_slot_display: null,
                  last_released_slot_start: null,
                  last_released_slot_end: null,
                });

                const confirmMessage = useEmojis
                  ? `All set — I moved your consult to ${display} with ${slotArtist || "our artist"} 🙌`
                  : `All set — I moved your consult to ${display} with ${slotArtist || "our artist"}.`;

                await sendConversationMessage({
                  contactId,
                  body: confirmMessage,
                  channelContext,
                });
              } else {
                await updateSystemFields(contactId, {
                  reschedule_pending: false,
                  reschedule_target_appointment_id: null,
                  reschedule_target_translator_appointment_id: null,
                  hold_appointment_id: rescheduleTargetId,
                  hold_last_activity_at: now,
                  hold_warning_sent: false,
                  ai_phase: AI_PHASES.CLOSING,
                  last_phase_update_at: now,
                  last_released_slot_display: null,
                  last_released_slot_start: null,
                  last_released_slot_end: null,
                });

                const holdMessage = useEmojis
                  ? `Got it — I moved your hold to ${display}. To lock it in, just finish the $100 refundable deposit I sent.`
                  : `Got it — I moved your hold to ${display}. To lock it in, just finish the $100 refundable deposit I sent.`;

                await sendConversationMessage({
                  contactId,
                  body: holdMessage,
                  channelContext,
                });
              }

              return res
                .status(200)
                .json({ success: true, message: "Appointment rescheduled" });
            } catch (rescheduleErr) {
              console.error(
                "❌ Error rescheduling appointment:",
                rescheduleErr.message || rescheduleErr
              );
              // Fall back to normal booking flow
            }
          }

          // Create the hold appointment IMMEDIATELY (status NEW if deposit not paid, CONFIRMED if paid)
          try {
            const appointment = await createConsultAppointment({
              contactId,
              calendarId: slotCalendarId,
              startTime: selectedSlot.startTime,
              endTime: selectedSlot.endTime,
              artist: slotArtist,
              consultMode: appointmentOfferData.consultMode,
              contactProfile,
              translatorNeeded: appointmentOfferData.translatorNeeded || !!translatorCalendarId,
              translatorCalendarId,
              translatorName,
            });

            const now = new Date().toISOString();

            if (alreadyPaid) {
              // Deposit already paid - appointment is CONFIRMED, clear hold fields
              await updateSystemFields(contactId, {
                ai_phase: AI_PHASES.CLOSING,
                last_phase_update_at: now,
                // Clear any hold fields since deposit is paid
                hold_appointment_id: null,
                hold_last_activity_at: null,
                hold_warning_sent: false,
                // Clear last_released fields (fresh session)
                last_released_slot_display: null,
                last_released_slot_start: null,
                last_released_slot_end: null,
              });
              
              // Send confirmation message (createConsultAppointment doesn't send message for CONFIRMED)
              const confirmMessage = useEmojis
                ? `Perfect, you're officially locked in for ${selectedSlot.displayText} with ${slotArtist || "our artist"} 🙌`
                : `Perfect, you're officially locked in for ${selectedSlot.displayText} with ${slotArtist || "our artist"}.`;
              
              await sendConversationMessage({
                contactId,
                body: confirmMessage,
                channelContext,
              });
            } else {
              // Deposit NOT paid - set up hold tracking
              await updateSystemFields(contactId, {
                hold_appointment_id: appointment.id,
                hold_last_activity_at: now,
                hold_warning_sent: false,
                ai_phase: AI_PHASES.CLOSING,
                last_phase_update_at: now,
                // Clear last_released fields (fresh session)
                last_released_slot_display: null,
                last_released_slot_start: null,
                last_released_slot_end: null,
              });

              // Hold message already sent by createConsultAppointment
            }

            return res.status(200).json({ success: true, message: "Slot selected and held" });
          } catch (apptErr) {
            console.error("❌ Error creating hold appointment:", apptErr.message || apptErr);
            await sendConversationMessage({
              contactId,
              body: "Sorry, I had trouble booking that time. Can you try picking another option?",
              channelContext,
            });
            return res.status(200).json({ success: false, message: "Booking failed" });
          }
        } else {
          // ⚠️ Could not match slot - DON'T call AI, just ask them to pick from the list
          console.log("⚠️ Could not match slot selection to available slots - asking to pick from list");
          
          const slotsText = appointmentOfferData.slots
            .map((slot, idx) => `${idx + 1}. ${slot.displayText}`)
            .join("\n");
          
          const clarifyMessage = useEmojis
            ? `I couldn't quite catch that — which of these times works for you?\n\n${slotsText}`
            : `I couldn't quite catch that — which of these times works for you?\n\n${slotsText}`;
          
          await sendConversationMessage({
            contactId,
            body: clarifyMessage,
            channelContext,
          });
          
          return res.status(200).json({ success: true, message: "Asked to clarify slot selection" });
        }
      }
    } catch (slotErr) {
      console.error("❌ Error handling slot selection:", slotErr.message || slotErr);
      skipAIEntirely = false;
    }
  }

  // 🔄 Check if user wants to re-hold previously released slot
  const lastReleasedDisplay = freshCf.last_released_slot_display;
  const lastReleasedStart = freshCf.last_released_slot_start;
  const lastReleasedEnd = freshCf.last_released_slot_end;

  if (!skipAIEntirely && !holdAppointmentId && !alreadyPaid && lastReleasedDisplay && wantsPreviousSlot(messageText, lastReleasedDisplay)) {
    console.log("🔄 User wants to re-hold previously released slot:", lastReleasedDisplay);
    skipAIEntirely = true;
    
    try {
      // Need to get calendar/artist info - try from existing fields or generate slots
      let calendarId = freshCf.pending_slot_calendar || freshCf.last_released_slot_calendar;
      let artist = freshCf.pending_slot_artist || "Joan";
      let consultMode = freshCf.pending_slot_mode || detectedConsultMode;
      
      // If we don't have calendar info, generate slots to get it
      if (!calendarId) {
        appointmentOfferData = await handleAppointmentOffer({
          contact: freshContact,
          aiMeta: {
            consultMode: detectedConsultMode,
            latestMessageText: messageText,
            translatorNeeded: contactProfile.translatorNeeded,
          },
          contactProfile,
        });
        if (appointmentOfferData) {
          // Use first slot's artist/calendar (works for both time-first and artist-first modes)
          const firstSlot = appointmentOfferData.slots?.[0];
          calendarId = firstSlot?.calendarId || appointmentOfferData.calendarId;
          artist = firstSlot?.artist || appointmentOfferData.artist;
          consultMode = appointmentOfferData.consultMode;
        }
      }
      
      if (!calendarId || !lastReleasedStart || !lastReleasedEnd) {
        throw new Error("Missing required slot information for re-hold");
      }
      
      // Try to re-create the appointment (will fail if slot is taken)
      const appointment = await createConsultAppointment({
        contactId,
        calendarId,
        startTime: lastReleasedStart,
        endTime: lastReleasedEnd,
        artist,
        consultMode,
        contactProfile,
      });
      
      // Success - slot was still available
      const now = new Date().toISOString();
      await updateSystemFields(contactId, {
        hold_appointment_id: appointment.id,
        hold_last_activity_at: now,
        hold_warning_sent: false,
        // Clear last_released fields since it's active again
        last_released_slot_display: null,
        last_released_slot_start: null,
        last_released_slot_end: null,
      });
      
      const reholdMessage = useEmojis
        ? `Good news — ${lastReleasedDisplay} is still open, I just put you back on hold for that time 🙌\n\nLet's lock it in with the $100 deposit so it doesn't get taken.`
        : `Good news — ${lastReleasedDisplay} is still open, I just put you back on hold for that time. Let's lock it in with the $100 deposit so it doesn't get taken.`;
      
      await sendConversationMessage({
        contactId,
        body: reholdMessage,
        channelContext,
      });
      
      return res.status(200).json({ success: true, message: "Re-held previous slot" });
    } catch (reholdErr) {
      // Slot is taken - offer fresh times
      console.log("⚠️ Previous slot no longer available, offering fresh times:", reholdErr.message);
      
      const apologyMessage = useEmojis
        ? `That exact time got grabbed, but I can still get you in around then.\n\nDo you want me to send over a couple of nearby times?`
        : `That exact time got grabbed, but I can still get you in around then. Do you want me to send over a couple of nearby times?`;
      
      await sendConversationMessage({
        contactId,
        body: apologyMessage,
        channelContext,
      });
      
      // Fall through to booking intent flow to show fresh times
      skipAIEntirely = false;
    }
  }

  // 🔁 RESCHEDULE INTENT: User wants to move an existing appointment/hold
  const rescheduleRequested = isRescheduleIntent(messageText);

  if (rescheduleRequested) {
    console.log("📅 Reschedule intent detected");
    const consultCalendarIds = Object.values(CALENDARS);
    const translatorApptId =
      contactCustomFields?.translator_appointment_id ||
      contactCustomFields?.translatorAppointmentId ||
      null;

    const consultAppointments = await getConsultAppointmentsForContact(
      contactId,
      consultCalendarIds
    );

    const existingAppointment = consultAppointments[0] || null;

    if (!existingAppointment) {
      console.log("⚠️ No existing appointment to reschedule; falling through to normal flow");
    } else {
      skipAIEntirely = true;

      const currentDisplay = formatSlotDisplay(new Date(existingAppointment.startTime));

      // Offer fresh times (respecting any dates mentioned in the same message)
      appointmentOfferData = await handleAppointmentOffer({
        contact: freshContact,
        aiMeta: {
          consultMode: detectedConsultMode,
          latestMessageText: messageText,
          translatorNeeded: contactProfile.translatorNeeded,
        },
        contactProfile,
      });

      if (appointmentOfferData?.slots?.length) {
        const slotsText = appointmentOfferData.slots
          .map((slot, idx) => `${idx + 1}. ${slot.displayText}`)
          .join("\n");

        const rescheduleMessage = useEmojis
          ? `No problem — you’re currently set for ${currentDisplay}. Here are some other times:\n\n${slotsText}\n\nWhich one should I move you to?`
          : `No problem — you're currently set for ${currentDisplay}. Here are some other times:\n\n${slotsText}\n\nWhich one should I move you to?`;

        await sendConversationMessage({
          contactId,
          body: rescheduleMessage,
          channelContext,
        });

        await updateSystemFields(contactId, {
          reschedule_pending: true,
          reschedule_target_appointment_id: existingAppointment.id,
          reschedule_target_translator_appointment_id: translatorApptId || null,
        });

        return res
          .status(200)
          .json({ success: true, message: "Reschedule options sent" });
      }
    }
  }

  // 🚀 BOOKING INTENT: User is asking for times (e.g., "What times do you have?")
  // - Strong intent (explicit time request): triggers in any phase
  // - Weak intent (generic "yes", "sounds good"): only triggers if we have core info or late phase
  let bookingIntentDetected = isBookingIntent(messageText, contactProfile, systemState.currentPhase);
  const weakIntentDetected = isWeakBookingIntent(messageText);
  const consultModeChosen = ["appointment", "message"].includes(
    String(contactCustomFields?.consultation_type || "").toLowerCase()
  );
  const depositAlreadyPaid =
    contactProfile?.depositPaid === true ||
    contactSystemFields?.deposit_paid === "Yes" ||
    contactSystemFields?.deposit_paid === true;

  if (bookingIntentDetected && weakIntentDetected && !consultModeChosen) {
    console.log("⏳ Weak booking intent but consult mode not chosen yet — gating times");
    bookingIntentDetected = false;
  }

  if (bookingIntentDetected && depositAlreadyPaid && !rescheduleRequested) {
    console.log("💰 Deposit already paid — blocking booking intent flow");
    bookingIntentDetected = false;
  }
  
  if (!skipAIEntirely && bookingIntentDetected) {
    const leadSpanishComfortable =
      String(contactProfile.leadSpanishComfortable || "").toLowerCase() === "yes";
    const isEnglishLead =
      (contactLanguagePreference || "English").toLowerCase().includes("english");
    const needsLanguageBarrierMessage = isEnglishLead && !leadSpanishComfortable;

    // Language barrier gating: default to message consult, offer translator if requested
    if (needsLanguageBarrierMessage) {
      const cf = contact.customField || contact.customFields || {};

      if (cf.language_barrier_explained === "Yes" || cf.language_barrier_explained === true) {
        console.log("ℹ️ Language barrier already explained, continuing to booking intent flow");
      } else {
        const barrierMessage =
          "Our artist's native language is Spanish. Most clients either do a quick video call with a translator or message the artist directly about the design details — both have worked great!\n\nWhich would you prefer?";

        await sendConversationMessage({
          contactId,
          body: barrierMessage,
          channelContext,
        });

        await updateSystemFields(contactId, {
          language_barrier_explained: true,
        });

        return res.status(200).json({
          success: true,
          message: "Language barrier message sent prior to booking options",
        });
      }
    }

    // Log which type of intent was detected
    const intentType = isStrongBookingIntent(messageText) ? "STRONG" : "WEAK (gated)";
    console.log(`🚀 BOOKING INTENT DETECTED (${intentType}) - bypassing AI, sending times directly`);
    skipAIEntirely = true;

    try {
      // Generate appointment slots with detected consult mode
      appointmentOfferData = await handleAppointmentOffer({
        contact: freshContact,
        aiMeta: {
          consultMode: detectedConsultMode,
          latestMessageText: messageText,
          translatorNeeded: contactProfile.translatorNeeded,
        },
        contactProfile,
      });

      if (appointmentOfferData && appointmentOfferData.slots && appointmentOfferData.slots.length > 0) {
        const slotsText = appointmentOfferData.slots
          .map((slot, idx) => `${idx + 1}. ${slot.displayText}`)
          .join("\n");

        // 📋 If times were already sent, use a shorter reminder message
        if (timesSent) {
          console.log("📅 Times already sent - sending short reminder");
          
          const reminderMessage = useEmojis
            ? `For sure — here were the times I mentioned:\n\n${slotsText}\n\nWhich one works?`
            : `For sure — here were the times I mentioned:\n\n${slotsText}\n\nWhich one works?`;
          
          await sendConversationMessage({
            contactId,
            body: reminderMessage,
            channelContext,
          });
          
          return res.status(200).json({ success: true, message: "Times reminder sent" });
        }

        // Check if consult has already been explained (to avoid repetition)
        const consultExplainedAlready = hasConsultBeenExplained(freshContact);
        console.log(`📋 Consult explained already: ${consultExplainedAlready}`);
        
        // Build message parts based on what's already been explained
        let messageParts = [];
        let depositUrlToStore = storedDepositUrl;
        let needsConsultExplained = false;
        
        if (!alreadyPaid && !alreadySent) {
          // First time sending deposit link - generate it
          console.log("💳 Generating deposit link for booking intent...");
          try {
            const { url: depositUrl, paymentLinkId } = await createDepositLinkForContact({
              contactId,
              amountCents: DEPOSIT_CONFIG.DEFAULT_AMOUNT_CENTS,
              description: DEPOSIT_CONFIG.DEFAULT_DESCRIPTION,
            });

            if (depositUrl) {
              depositUrlToStore = depositUrl;
              
              // Store deposit-related fields immediately (success path)
              await updateSystemFields(contactId, {
                deposit_link_sent: true,
                deposit_link_url: depositUrl,
                square_payment_link_id: paymentLinkId,
                last_phase_update_at: new Date().toISOString(),
              });

              // 🔁 Sync pipeline: deposit link sent → DEPOSIT_PENDING
              try {
                await syncOpportunityStageFromContact(contactId, { aiPhase: AI_PHASES.QUALIFICATION });
                console.log("🏗️ Pipeline stage synced after deposit link generation (booking intent path)");
              } catch (oppErr) {
                console.error("❌ Error syncing opportunity stage after deposit link generation:", oppErr.message || oppErr);
              }

              if (!consultExplainedAlready) {
                // FULL explanation (only first time)
                messageParts.push("We start with a quick 15–30 min consult to dial in your design, size, and placement.");
                messageParts.push("To hold a spot, we do a $100 refundable deposit that goes straight toward your tattoo.");
                needsConsultExplained = true;
              } else {
                // SHORT reference (consult already explained, maybe by AI)
                messageParts.push("Same quick consult we mentioned — we'll go over your idea, placement, and details.");
              }
              
              // Add times
              messageParts.push(`Here are the times I've got:\n${slotsText}`);
              
              // Add deposit link
              messageParts.push(`Here's your deposit link: ${depositUrl}`);
            }
          } catch (depositErr) {
            console.error("❌ Error creating deposit link:", depositErr.message || depositErr);
            // Still send times even if deposit link fails (user saw them, so mark times_sent)
            // But DON'T set deposit fields or consult_explained (we didn't explain it)
            messageParts.push(`Got you — here are the times we've got open:\n${slotsText}`);
            messageParts.push("Which one works for you?");
            // Note: times_sent will be set at the end (line 1788) even on error
            // This prevents re-showing times on next booking intent, but allows retry of deposit
          }
        } else if (alreadySent && !alreadyPaid) {
          // Deposit link already sent - short reminder with times
          messageParts.push(`Got you — here are the times:\n${slotsText}`);
          
          if (storedDepositUrl) {
            messageParts.push(useEmojis
              ? `Once the deposit comes through I'll lock in your spot 🙌\nDeposit link: ${storedDepositUrl}`
              : `Once the deposit comes through I'll lock in your spot.\nDeposit link: ${storedDepositUrl}`);
          } else {
            messageParts.push(useEmojis
              ? `Once the deposit comes through I'll lock in your spot 🙌`
              : `Once the deposit comes through I'll lock in your spot.`);
          }
        } else {
          // Deposit already paid - just send times
          messageParts.push(`Here are the times I've got:\n${slotsText}`);
          messageParts.push("Which one works for you?");
        }

        const combinedMessage = messageParts.join("\n\n");

        await sendConversationMessage({
          contactId,
          body: combinedMessage,
          channelContext,
        });
        console.log("📅 Times sent directly (bypassed AI)");
        
        // Mark times as sent (even if deposit failed - user saw them, prevents re-showing)
        // Mark consult explained ONLY if we actually explained it this turn
        // This ensures:
        // - User doesn't see times again on next booking intent (times_sent = true)
        // - Deposit can retry on next booking intent (deposit_link_sent not set on error)
        // - Consult explanation only marked if we actually sent it (needsConsultExplained)
        const fieldsToUpdate = {
          times_sent: true, // Always set - user saw times regardless of deposit success/failure
          ai_phase: AI_PHASES.CLOSING,
          last_phase_update_at: new Date().toISOString(),
        };
        if (needsConsultExplained) {
          // Only set if we actually explained consult this turn (not on error path)
          fieldsToUpdate.consult_explained = true;
        }
        await updateSystemFields(contactId, fieldsToUpdate);
      }

      return res.status(200).json({ success: true, message: "Booking intent handled directly" });
    } catch (bookingErr) {
      console.error("❌ Error handling booking intent:", bookingErr.message || bookingErr);
      skipAIEntirely = false;
    }
  }

  // If we already handled booking intent or slot selection, we've returned above
  // From here on, we only call AI if skipAIEntirely is false

  try {
    // Check if consult has been explained (to pass to AI for prompt enforcement)
    const consultExplainedAlready = hasConsultBeenExplained(freshContact);
    
    const { aiResult, ai_phase: newAiPhaseFromAI, lead_temperature: newLeadTempFromAI } =
      await handleInboundMessage({
        contact: freshContact,
        aiPhase: systemState.currentPhase || "intake",
        leadTemperature: systemState.leadTemperature,
        latestMessageText: messageText,
        contactProfile,
        consultExplained: consultExplainedAlready, // Pass to AI for prompt enforcement
      });

    const meta = aiResult?.meta || {};
    const fieldUpdates = aiResult?.field_updates || {};

    // Note: Time selection and booking intent are now handled BEFORE we reach here
    // If we're here, the user didn't ask for times or select a slot, so we use AI response

    console.log("🧠 AI DECISION SUMMARY", cleanLogObject({
      aiPhaseFromAI: meta.aiPhase,
      leadTemperatureFromAI: meta.leadTemperature,
      wantsDepositLink: meta.wantsDepositLink,
      wantsAppointmentOffer: meta.wantsAppointmentOffer,
      consultMode: meta.consultMode,
      depositPushedThisTurn: meta.depositPushedThisTurn,
      mentionDecoyOffered: meta.mentionDecoyOffered,
      field_updates: fieldUpdates,
      bubblesPreview: Array.isArray(aiResult?.bubbles)
        ? aiResult.bubbles.map((b) => (b || "").slice(0, 80))
        : [],
    }, ["wantsDepositLink", "wantsAppointmentOffer", "depositPushedThisTurn", "mentionDecoyOffered"]));

    // Log cleaned AI result (remove empty fields but keep all decisions)
    const cleanedAiResult = cleanLogObject(aiResult, [
      "meta", "bubbles", "language", "internal_notes", "depositLinkMessage"
    ]);
    console.log("🤖 AI DM suggestion:", JSON.stringify(cleanedAiResult, null, 2));

    // Send AI bubbles
    if (aiResult && Array.isArray(aiResult.bubbles)) {
      let bubblesToSend = aiResult.bubbles
        .map((b) => (b || "").trim())
        .filter(Boolean);

      // 🔢 BUBBLE LIMITS: First message up to 3, subsequent messages max 2
      const isFirstMessage = systemState.currentPhase === AI_PHASES.INTAKE;
      const maxBubbles = isFirstMessage ? 3 : 2;
      if (bubblesToSend.length > maxBubbles) {
        console.log(`📝 Limiting bubbles from ${bubblesToSend.length} to ${maxBubbles}`);
        bubblesToSend = bubblesToSend.slice(0, maxBubbles);
      }

      // 🔒 VALIDATION: Remove bubbles that claim to send deposit link if backend won't actually send it
      // Check if any bubble claims to send a deposit link
      const depositLinkClaimPatterns = [
        /(sent|sending|sending you|here's|here is).*deposit.*link/i,
        /deposit.*link.*(sent|sending|here)/i,
        /just sent.*deposit/i,
      ];
      
      const claimsToSendLink = bubblesToSend.some(bubble => 
        depositLinkClaimPatterns.some(pattern => pattern.test(bubble))
      );
      
      if (claimsToSendLink) {
        // Verify backend will actually create/send the link
        const willCreateLink = aiResult.meta?.wantsDepositLink === true && 
          !alreadyPaid && 
          !alreadySent;
        
        if (!willCreateLink) {
          console.warn("⚠️ AI claimed to send deposit link but backend won't create it - removing claim from bubbles");
          // Remove bubbles that claim to send the link
          bubblesToSend = bubblesToSend.filter(bubble => 
            !depositLinkClaimPatterns.some(pattern => pattern.test(bubble))
          );
        }
      }

      // If we're about to send a deposit link this turn,
      // keep the conversation tight: only send the first bubble.
      if (aiResult.meta?.wantsDepositLink && bubblesToSend.length > 1) {
        bubblesToSend = bubblesToSend.slice(0, 1);
      }

      // 📱 Strip emojis if channel doesn't support them (SMS)
      if (!useEmojis) {
        bubblesToSend = bubblesToSend.map(text => stripEmojis(text));
      }

      if (bubblesToSend.length === 0) {
        console.warn("⚠️ AI bubbles were empty after trimming, nothing sent.");
      } else {
        for (let i = 0; i < bubblesToSend.length; i++) {
          // 🔄 Check if this generation is still current before sending each bubble
          if (!isGenerationCurrent(contactId, currentGenerationId)) {
            console.log(`⏹️ Generation ${currentGenerationId} superseded - canceling remaining bubbles`);
            break;
          }

          const text = bubblesToSend[i];

          // Only wait before bubble #2 and beyond (more human)
          if (i > 0) {
            const delayMs = calculateDelayForText(text);
            console.log(`⏱ Waiting ${delayMs}ms before sending bubble ${i + 1}...`);
            await sleep(delayMs);

            // Check again after delay in case new message came in
            if (!isGenerationCurrent(contactId, currentGenerationId)) {
              console.log(`⏹️ Generation ${currentGenerationId} superseded during delay - canceling remaining bubbles`);
              break;
            }
          }

          await sendConversationMessage({
            contactId,
            body: text,
            channelContext,
          });
        }
        console.log("📤 Sent AI bubbles to GHL conversation.");

        // Update system fields from AI meta if present
        if (meta.aiPhase || meta.leadTemperature) {
          const updateFields = {};
          if (meta.aiPhase) updateFields.ai_phase = meta.aiPhase;
          if (meta.leadTemperature) updateFields.lead_temperature = meta.leadTemperature;
          updateFields.last_phase_update_at = new Date().toISOString();
          
          // If AI explained the consult/deposit this turn, mark it as explained
          if (meta.depositPushedThisTurn === true && !consultExplainedAlready) {
            updateFields.consult_explained = true;
            console.log("📋 AI explained consult this turn - marking consult_explained = true");
          }

          console.log("🧠 Updating contact system fields from AI meta:", {
            ai_phase: meta.aiPhase,
            lead_temperature: meta.leadTemperature,
            consult_explained: updateFields.consult_explained,
          });

          await updateSystemFields(contactId, updateFields);
        }

        // Apply field_updates from AI response
        if (fieldUpdates && Object.keys(fieldUpdates).length > 0) {
          console.log("🧾 Applying AI field_updates to GHL:", fieldUpdates);
          try {
            await updateTattooFields(contactId, fieldUpdates);
          } catch (err) {
            console.error("❌ Failed to update tattoo-related fields from AI:", err.message);
          }
        } else {
          console.log("ℹ️ No field_updates from AI to apply this turn.");
        }

        // Note: Time selection and appointment creation are now handled BEFORE AI is called
        // If user shows booking intent or selects a slot, we return early and never reach here

        // 💳 If AI wants to send a deposit link, and one isn't already sent/paid, create it
        try {
          const wantsDepositLink = aiResult?.meta?.wantsDepositLink === true;

          // Check if deposit already paid or sent from contact's system fields
          const contactCf = freshContact?.customField || freshContact?.customFields || {};
          const alreadyPaid =
            aiResult?.meta?.depositPaid === true ||
            contactCf?.deposit_paid === "Yes";

          const alreadySent =
            aiResult?.meta?.depositLinkSent === true ||
            contactCf?.deposit_link_sent === "Yes";

          if (wantsDepositLink && !alreadyPaid && !alreadySent) {
            console.log("💳 AI requested deposit link. Creating Square link for contact:", {
              contactId,
            });

            const { url: depositUrl, paymentLinkId } =
              await createDepositLinkForContact({
                contactId,
                amountCents: DEPOSIT_CONFIG.DEFAULT_AMOUNT_CENTS,
                description: DEPOSIT_CONFIG.DEFAULT_DESCRIPTION,
              });

            if (!depositUrl) {
              console.warn("⚠️ Square did not return a deposit URL");
            } else {
              // Store system fields so AI / dashboard can see it
              await updateSystemFields(contactId, {
                deposit_link_sent: true,
                square_payment_link_id: paymentLinkId,
                last_phase_update_at: new Date().toISOString(),
              });

              // Send the link to the lead using the existing outbound message helper
              const linkMessage =
                aiResult?.meta?.depositLinkMessage ||
                "Perfect, here's your secure deposit link to lock in your session:\n" +
                  depositUrl;

              await sendConversationMessage({
                contactId,
                body: linkMessage,
                channelContext,
              });

              console.log("💳 Deposit link sent to lead and system fields updated");

              // 🔁 Sync pipeline: deposit link sent via AI flow → DEPOSIT_PENDING
              try {
                await syncOpportunityStageFromContact(contactId, { aiPhase: AI_PHASES.CLOSING });
                console.log("🏗️ Pipeline stage synced after deposit link send (AI flow)");
              } catch (oppErr) {
                console.error("❌ Error syncing opportunity stage after AI deposit link send:", oppErr.message || oppErr);
              }
            }
          } else {
            console.log("ℹ️ No deposit link created (either not requested, already sent, or already paid).", {
              wantsDepositLink,
              alreadyPaid,
              alreadySent,
            });
          }
        } catch (err) {
          console.error("❌ Error while handling AI deposit link logic:", err);
        }
      }
    } else {
      console.warn("⚠️ AI result did not contain bubbles array, nothing sent.");
    }
  } catch (err) {
    console.error(
      "❌ Error generating or sending AI DM suggestion:",
      err.response?.data || err.message || err
    );
  }

  res.status(200).send("OK");
});



// Test route to generate a Square sandbox deposit link
app.get("/payments/test-link", async (req, res) => {
  try {
    // If ?contactId=... is provided, we'll use it.
    // Otherwise we fall back to a fake test contact id.
    const contactId =
      req.query.contactId || `test-contact-${Date.now()}`;

    const { url, paymentLinkId } = await createDepositLinkForContact({
      contactId,
      amountCents: DEPOSIT_CONFIG.DEFAULT_AMOUNT_CENTS,
      description: "Test Studio AZ Tattoo Deposit (Sandbox)",
    });

    if (!url) {
      return res
        .status(500)
        .json({ error: "No URL returned from createDepositLinkForContact" });
    }

    console.log("🧪 Test payment link created:", {
      contactId,
      url,
      paymentLinkId,
    });

    return res.json({
      message: "Sandbox test payment link created",
      contactId,
      paymentLinkId,
      url,
    });
  } catch (err) {
    console.error("❌ Error in /payments/test-link:", err);
    return res.status(500).json({
      error: "Failed to create test payment link",
      details: err.message,
    });
  }
});

// Create/update contact when the widget does the background "partial" save
app.post("/lead/partial", async (req, res) => {
  console.log("🔹 /lead/partial hit");
  console.log("Payload:", JSON.stringify(req.body, null, 2));

  try {
    const { contactId, contact } = await upsertContactFromWidget(
      req.body,
      "partial"
    );

    const preferredArtist = extractPreferredArtistFromPayload(req.body);
    const assignedArtist = await ensureArtistAssignment(contactId, {
      contact,
      preferredArtist,
    });

    console.log("✅ Partial upsert complete:", {
      contactId,
      firstName: contact?.firstName || contact?.first_name,
      lastName: contact?.lastName || contact?.last_name,
      email: contact?.email,
      phone: contact?.phone,
      tags: contact?.tags,
      assignedArtist,
    });

    return res.json({
      ok: true,
      mode: "partial",
      contactId,
      assignedArtist,
    });
  } catch (err) {
    console.error(
      "❌ Error in /lead/partial:",
      err.response?.status,
      err.response?.data || err.message
    );
    return res.status(500).json({
      ok: false,
      error: "Failed to upsert contact (partial)",
    });
  }
});

// Create/update contact when the widget is fully submitted ("final" step)

app.post("/lead/final", upload.array("files"), async (req, res) => {
  console.log("🔸 /lead/final hit");
  console.log("Content-Type:", req.headers["content-type"]);

  const hasFiles = req.files && req.files.length > 0;
  console.log(
    "📎 Final lead files:",
    hasFiles ? req.files.map((f) => f.originalname) : "none"
  );

  let payload;

  try {
    if (req.is("multipart/form-data")) {
      // multipart: expect JSON string in req.body.data
      if (req.body && req.body.data) {
        payload = JSON.parse(req.body.data);
      } else {
        console.warn("⚠️ Multipart request but no req.body.data – using empty object");
        payload = {};
      }
    } else if (req.is("application/json")) {
      // pure JSON
      payload = req.body || {};
    } else {
      // fallback
      payload = req.body || {};
    }
  } catch (err) {
    console.error("❌ Failed to parse final lead payload:", err.message);
    return res.status(400).json({ ok: false, error: "Invalid payload" });
  }

  console.log("Payload (final lead):", JSON.stringify(payload, null, 2));

  // Safety: don't even hit GHL if we have no email/phone
  if (!payload.email && !payload.phone) {
    console.error("❌ Final lead missing email/phone");
    return res
      .status(400)
      .json({ ok: false, error: "Email or phone is required" });
  }

  try {
    // 1️⃣ Upsert contact with full info, ensure 'consultation request' tag, etc.
    const { contactId, contact } = await upsertContactFromWidget(payload, "final");

    const preferredArtist = extractPreferredArtistFromPayload(payload);
    const assignedArtist = await ensureArtistAssignment(contactId, {
      contact,
      preferredArtist,
    });

    console.log("✅ Final upsert complete:", {
      contactId,
      firstName: contact?.firstName || contact?.first_name,
      lastName: contact?.lastName || contact?.last_name,
      email: contact?.email,
      phone: contact?.phone,
      assignedArtist,
    });

    // 2️⃣ Upload files to custom file field, if any
    if (hasFiles) {
      try {
        await uploadFilesToTattooCustomField(contactId, req.files);
      } catch (err) {
        console.error(
          "⚠️ Failed to upload files to GHL custom field:",
          err.response?.data || err.message
        );
      }
    }

    return res.json({ ok: true, contactId, assignedArtist });
  } catch (err) {
    console.error(
      "❌ Error in /lead/final:",
      err.response?.data || err.message
    );
    return res
      .status(500)
      .json({ ok: false, error: "Failed to upsert contact (final)" });
  }
});




const PORT = process.env.PORT || 3000;
// Error handling middleware (must be last)
app.use(notFoundHandler); // 404 handler
app.use(errorHandler); // General error handler

app.listen(PORT, () => {
  console.log(`AI Setter server listening on port ${PORT}`);
});
