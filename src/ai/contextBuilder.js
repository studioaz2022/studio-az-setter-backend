const { SYSTEM_FIELDS, TATTOO_FIELDS } = require("../config/constants");

/**
 * Normalize display name to snake_case key.
 * "Tattoo Placement" -> "tattoo_placement"
 * "How Soon Is Client Deciding?" -> "how_soon_is_client_deciding"
 */
function normalizeDisplayName(displayName) {
  if (!displayName || typeof displayName !== "string") return null;
  return displayName
    .toLowerCase()
    .replace(/[?!.,]/g, "")
    .replace(/\s+/g, "_")
    .trim();
}

/**
 * Normalize custom fields from various GHL formats to a key-value object.
 * Handles:
 * - Already normalized object: { tattoo_placement: "forearm" }
 * - Array format: [{ id: "xxx", value: "forearm" }]
 * - Array-like object: { "0": { id: "xxx", value: "forearm" } }
 * - Display name keys: { "Tattoo Placement": "forearm" }
 */
function normalizeCustomFields(cfRaw) {
  if (!cfRaw) return {};

  let normalized = {};

  // Check if it's an array
  if (Array.isArray(cfRaw)) {
    for (const entry of cfRaw) {
      if (!entry) continue;
      const key =
        entry.key ||
        entry.fieldKey ||
        entry.customFieldKey ||
        entry.customFieldId ||
        entry.id;
      if (key && entry.value !== undefined) {
        const snakeKey = normalizeDisplayName(String(key));
        normalized[snakeKey || key] = entry.value;
      }
    }
    return normalized;
  }

  // Check if it's an array-like object with numeric keys
  const keys = Object.keys(cfRaw);
  const isArrayLike = keys.length > 0 && keys.every((k) => /^\d+$/.test(k));

  if (isArrayLike) {
    for (const key of keys) {
      const entry = cfRaw[key];
      if (!entry || typeof entry !== "object") continue;
      const fieldKey =
        entry.key ||
        entry.fieldKey ||
        entry.customFieldKey ||
        entry.customFieldId ||
        entry.id;
      if (fieldKey && entry.value !== undefined) {
        const snakeKey = normalizeDisplayName(String(fieldKey));
        normalized[snakeKey || fieldKey] = entry.value;
      }
    }
    return normalized;
  }

  // It's a regular object - normalize display name keys to snake_case
  for (const [key, value] of Object.entries(cfRaw)) {
    if (value === undefined || value === null || value === "") continue;

    // Skip nested objects (like location, contact, etc.)
    if (typeof value === "object" && !Array.isArray(value)) continue;

    const snakeKey = normalizeDisplayName(key);
    if (snakeKey) {
      normalized[snakeKey] = value;
    } else {
      normalized[key] = value;
    }
  }

  return normalized;
}

function buildAllowedFieldSet() {
  const canonicalKeys = [
    ...Object.values(TATTOO_FIELDS || {}),
    ...Object.values(SYSTEM_FIELDS || {}),
    "tattoo_size",
    "tattoo_size_notes",
    "tattoo_title",
    "tattoo_summary",
    "tattoo_placement",
    "tattoo_style",
    "tattoo_color_preference",
    "how_soon_is_client_deciding",
    "lead_temperature",
    "consultation_type",
    "consultation_type_locked",
    "consult_explained",
    "translator_needed",
    "translator_confirmed",
    "translator_explained",
    "hold_appointment_id",
    "last_sent_slots",
    "times_sent",
    "deposit_link_url",
    "last_seen_fields_snapshot",
  ];

  const normalized = canonicalKeys
    .map((k) => normalizeDisplayName(k))
    .filter(Boolean);

  return new Set(normalized);
}

const ALLOWED_FIELD_KEYS = buildAllowedFieldSet();

/**
 * Extract custom fields from webhook payload (display names or snake_case).
 * More reliable than getContact() array format.
 */
function extractCustomFieldsFromPayload(payload = {}) {
  if (!payload || typeof payload !== "object") return {};

  const customFields = {};

  const maybeStore = (rawKey, value) => {
    const snakeKey = normalizeDisplayName(rawKey);
    if (!snakeKey) return;
    const keep =
      ALLOWED_FIELD_KEYS.has(snakeKey) ||
      snakeKey.includes("tattoo") ||
      snakeKey.includes("deposit") ||
      snakeKey.includes("consult") ||
      snakeKey.includes("translator") ||
      snakeKey.includes("slot") ||
      snakeKey.includes("hold");
    if (keep) {
      customFields[snakeKey] = value;
    }
  };

  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null || value === "") continue;

    // Nested object that looks like a custom field payload
    if (typeof value === "object" && !Array.isArray(value)) {
      if (value.value !== undefined) {
        const fieldKey =
          value.key ||
          value.fieldKey ||
          value.customFieldKey ||
          value.customFieldId ||
          value.id ||
          key;
        maybeStore(fieldKey, value.value);
      }
      continue;
    }

    // Array payloads (rare) - attempt to normalize
    if (Array.isArray(value)) {
      const normalized = normalizeCustomFields(value);
      Object.assign(customFields, normalized);
      continue;
    }

    maybeStore(key, value);
  }

  return customFields;
}

/**
 * Merge webhook custom fields into contact and ensure normalized flat shape.
 */
function buildEffectiveContact(contactRaw = {}, payloadCustomFields = {}) {
  const normalizedFromContact = normalizeCustomFields(
    contactRaw.customField || contactRaw.customFields || {}
  );
  const normalizedFromPayload = normalizeCustomFields(payloadCustomFields);

  const mergedCf = { ...normalizedFromContact, ...normalizedFromPayload };

  return {
    ...contactRaw,
    customField: mergedCf,
    customFields: mergedCf,
  };
}

/**
 * Build the contactProfile object passed to the LLM prompts.
 */
function buildContactProfile(
  canonicalState = {},
  { changedFields = {}, derivedPhase = null, intents = {} } = {}
) {
  const lastSeenSnapshot = canonicalState.lastSeenSnapshot || {};

  return {
    tattooPlacement: canonicalState.tattooPlacement || null,
    tattooSummary: canonicalState.tattooSummary || null,
    tattooSize: canonicalState.tattooSize || null,
    tattooSizeNotes: canonicalState.tattooSizeNotes || null,
    timeline: canonicalState.timeline || null,
    consultationType: canonicalState.consultationType || null,
    consultationTypeLocked: !!canonicalState.consultationTypeLocked,
    consultExplained: !!canonicalState.consultExplained,
    translatorNeeded: !!canonicalState.translatorNeeded,
    translatorConfirmed: !!canonicalState.translatorConfirmed,
    languageBarrierExplained: !!canonicalState.languageBarrierExplained,
    depositLinkSent: !!canonicalState.depositLinkSent,
    depositPaid: !!canonicalState.depositPaid,
    lastSeenFieldsSnapshot: lastSeenSnapshot,
    changedFieldsThisTurn: changedFields || {},
    derivedPhase: derivedPhase || null,
    languagePreference: canonicalState.languagePreference || null,
    isReturningClient: !!canonicalState.isReturningClient,
    previousArtistName: canonicalState.previousArtistName || canonicalState.inquiredTechnician || null,
    tattooDescriptionAcknowledged:
      changedFields.tattooSummary !== undefined
        ? true
        : !!lastSeenSnapshot.tattooSummary,
    intents: intents || {},
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSATION THREAD FORMATTING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Format GHL messages into a conversation thread for the LLM
 * 
 * @param {Array} messages - Raw GHL messages (newest first from API by default)
 * @param {object} options - Formatting options
 * @param {number} options.recentCount - Number of recent messages to keep in full detail (default 20)
 * @param {boolean} options.includeTimestamps - Include timestamps in formatted messages (default true)
 * @param {number} options.maxTotalMessages - Max messages to process (default 50)
 * @param {object} options.crmFields - CRM fields for image context correlation
 * @returns {object} { thread: string[], summary: string|null, totalCount: number, imageContext: object, handoffContext: object }
 */
function formatThreadForLLM(messages, {
  recentCount = 20,
  includeTimestamps = true,
  maxTotalMessages = 50,
  crmFields = {},
} = {}) {
  if (!messages || messages.length === 0) {
    return {
      thread: [],
      summary: null,
      totalCount: 0,
      imageContext: null,
      handoffContext: { wasHumanHandling: false, lastHumanMessageDate: null },
    };
  }

  // Reverse to chronological order (oldest first) and cap total
  const chronological = [...messages].reverse().slice(-maxTotalMessages);
  const totalCount = chronological.length;

  // Split into older (to summarize) and recent (keep full)
  const recentMessages = chronological.slice(-recentCount);
  const olderMessages = chronological.slice(0, -recentCount);

  // Format recent messages as conversation turns
  const thread = recentMessages.map((msg) => {
    const role = msg.direction === "inbound" ? "LEAD" : "STUDIO";
    
    let timestamp = "";
    if (includeTimestamps && msg.dateAdded) {
      try {
        const date = new Date(msg.dateAdded);
        timestamp = ` [${date.toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}]`;
      } catch {
        // Ignore timestamp formatting errors
      }
    }

    // Handle attachments (images)
    let content = msg.body || "";
    const attachmentCount = msg.attachments?.length || 0;
    
    if (attachmentCount > 0 && !content) {
      content = `[Sent ${attachmentCount} image${attachmentCount > 1 ? "s" : ""}]`;
    } else if (attachmentCount > 0) {
      content += ` [+ ${attachmentCount} image${attachmentCount > 1 ? "s" : ""}]`;
    }

    // Skip empty messages
    if (!content.trim()) {
      return null;
    }

    return `${role}${timestamp}: ${content}`;
  }).filter(Boolean);

  // Generate summary of older messages if any exist
  const summary = olderMessages.length > 0 
    ? generateThreadSummary(olderMessages) 
    : null;

  // Build image context from CRM fields and thread attachments
  const imageContext = buildImageContext(chronological, crmFields);

  // Detect if human was recently handling this conversation
  const handoffContext = detectHandoffContext(messages);

  // Build returning client context if they have previous tattoos with us
  const returningClientContext = buildReturningClientContext(crmFields);

  return {
    thread,
    summary,
    totalCount,
    hasOlderMessages: olderMessages.length > 0,
    imageContext,
    handoffContext,
    returningClientContext,
  };
}

/**
 * Build context for returning clients who have completed previous tattoos
 * 
 * @param {object} crmFields - CRM fields including previous_conversation_summary
 * @returns {object|null} Returning client context or null if not returning
 */
function buildReturningClientContext(crmFields = {}) {
  const isReturning = crmFields.returning_client === true || 
                      crmFields.returning_client === "Yes" ||
                      crmFields.returning_client === "yes";
  
  if (!isReturning && !crmFields.previous_conversation_summary) {
    return null;
  }

  const totalTattoos = parseInt(crmFields.total_tattoos_completed || "0", 10) || 0;

  return {
    isReturningClient: true,
    totalPreviousTattoos: totalTattoos,
    previousConversationSummary: crmFields.previous_conversation_summary || null,
  };
}

/**
 * Generate a compact summary of older messages for LLM context
 * 
 * @param {Array} olderMessages - Messages older than the recent window
 * @returns {string} Compact summary string
 */
function generateThreadSummary(olderMessages) {
  if (!olderMessages || olderMessages.length === 0) {
    return null;
  }

  const inboundCount = olderMessages.filter((m) => m.direction === "inbound").length;
  const outboundCount = olderMessages.filter((m) => m.direction === "outbound").length;

  // Extract key topics mentioned in older messages
  const allText = olderMessages.map((m) => m.body || "").join(" ").toLowerCase();

  const topics = [];
  
  // Scheduling/appointments
  if (allText.includes("cita") || allText.includes("appointment") || allText.includes("schedule") || allText.includes("time")) {
    topics.push("appointment scheduling");
  }
  
  // Aftercare/healing
  if (allText.includes("dolor") || allText.includes("pain") || allText.includes("heal") || allText.includes("curar") || allText.includes("cicatriz")) {
    topics.push("aftercare/healing");
  }
  
  // Pricing
  if (allText.includes("precio") || allText.includes("price") || allText.includes("cost") || allText.includes("cuanto") || allText.includes("deposit")) {
    topics.push("pricing/deposit");
  }
  
  // Photos shared
  const hasPhotos = olderMessages.some((m) => m.attachments?.length > 0);
  if (hasPhotos || allText.includes("foto") || allText.includes("photo") || allText.includes("imagen") || allText.includes("image")) {
    topics.push("reference photos shared");
  }
  
  // Design/style discussion
  if (allText.includes("diseño") || allText.includes("design") || allText.includes("style") || allText.includes("estilo")) {
    topics.push("design discussion");
  }
  
  // Size/placement
  if (allText.includes("size") || allText.includes("tamaño") || allText.includes("placement") || allText.includes("ubicación") || allText.includes("brazo") || allText.includes("arm")) {
    topics.push("size/placement");
  }
  
  // Consult/consultation
  if (allText.includes("consult") || allText.includes("consulta") || allText.includes("video") || allText.includes("llamada")) {
    topics.push("consultation");
  }

  // Get date range
  const dates = olderMessages
    .map((m) => m.dateAdded)
    .filter(Boolean)
    .sort();
  
  let dateRange = "";
  if (dates.length > 0) {
    try {
      const startDate = new Date(dates[0]).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const endDate = new Date(dates[dates.length - 1]).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      dateRange = startDate === endDate ? startDate : `${startDate} - ${endDate}`;
    } catch {
      // Ignore date formatting errors
    }
  }

  const topicsStr = topics.length > 0 ? topics.join(", ") : "general conversation";
  const dateStr = dateRange ? ` from ${dateRange}` : "";

  return `[Earlier: ${olderMessages.length} messages${dateStr}. Topics: ${topicsStr}. ${inboundCount} from lead, ${outboundCount} from studio.]`;
}

/**
 * Build image context by correlating attachments with CRM fields
 * 
 * @param {Array} messages - All messages in chronological order
 * @param {object} crmFields - CRM fields containing image descriptions
 * @returns {object|null} Image context object or null if no images
 */
function buildImageContext(messages, crmFields = {}) {
  // Count total images in conversation
  const totalImages = messages.reduce((count, msg) => {
    return count + (msg.attachments?.length || 0);
  }, 0);

  if (totalImages === 0 && !crmFields.tattoo_photo_description && !crmFields.tattoo_ideasreferences) {
    return null;
  }

  // Get recent image attachments (URLs for reference, though we won't fetch them)
  const recentImageMessages = messages
    .filter((m) => m.attachments?.length > 0)
    .slice(-5); // Last 5 messages with images

  const imageContext = {
    totalImagesInThread: totalImages,
    hasReferencePhotos: totalImages > 0 || !!crmFields.tattoo_ideasreferences,
  };

  // CRM field takes priority for understanding what images mean
  if (crmFields.tattoo_photo_description) {
    imageContext.photoDescription = crmFields.tattoo_photo_description;
  }

  // Include tattoo summary as additional context for what the photos relate to
  if (crmFields.tattoo_summary) {
    imageContext.tattooSummary = crmFields.tattoo_summary;
  }

  // Note if lead came from React form with pre-uploaded references
  if (crmFields.tattoo_ideasreferences) {
    imageContext.hasFormUploadedReferences = true;
    imageContext.formReferencesField = "tattoo_ideasreferences";
  }

  // Track when images were sent
  if (recentImageMessages.length > 0) {
    const leadImages = recentImageMessages.filter((m) => m.direction === "inbound").length;
    const studioImages = recentImageMessages.filter((m) => m.direction === "outbound").length;
    
    if (leadImages > 0) {
      imageContext.leadSentImages = leadImages;
    }
    if (studioImages > 0) {
      imageContext.studioSentImages = studioImages;
    }
  }

  return imageContext;
}

/**
 * Detect if a human rep was recently working this conversation (for handoff context)
 * 
 * @param {Array} messages - Raw GHL messages (newest first)
 * @returns {object} Handoff context with wasHumanHandling flag
 */
function detectHandoffContext(messages) {
  if (!messages || messages.length === 0) {
    return {
      wasHumanHandling: false,
      lastHumanMessageDate: null,
      humanUserId: null,
      recentHumanMessageCount: 0,
    };
  }

  // Look at recent outbound messages (last 10) to see if human was handling
  // Human messages have source: "app" vs bot messages have source: "workflow" or "api"
  const recentOutbound = messages
    .filter((m) => m.direction === "outbound")
    .slice(0, 10);

  const humanMessages = recentOutbound.filter((m) => {
    const source = (m.source || "").toLowerCase();
    // "app" = sent from GHL mobile/web app by human
    // "workflow" or "api" = automated/bot
    return source === "app";
  });

  const wasHumanHandling = humanMessages.length >= 2; // At least 2 recent human messages
  const lastHumanMessage = humanMessages[0]; // Most recent human message

  return {
    wasHumanHandling,
    lastHumanMessageDate: lastHumanMessage?.dateAdded || null,
    humanUserId: lastHumanMessage?.userId || null,
    recentHumanMessageCount: humanMessages.length,
  };
}

/**
 * Generate a comprehensive summary of an entire conversation thread for archival.
 * Used when a tattoo cycle is completed (lead marked as "won") to preserve
 * context for when the client returns for future tattoos.
 * 
 * @param {Array} messages - All messages from GHL (any order, will be sorted)
 * @param {object} crmFields - Current CRM field values to include in summary
 * @param {object} options - Additional context options
 * @returns {string} Comprehensive summary suitable for storage in GHL custom field
 */
function generateComprehensiveConversationSummary(messages, crmFields = {}, options = {}) {
  if (!messages || messages.length === 0) {
    return "[No conversation history to summarize]";
  }

  // Sort messages chronologically (oldest first)
  const sortedMessages = [...messages].sort((a, b) => {
    const dateA = new Date(a.dateAdded || 0);
    const dateB = new Date(b.dateAdded || 0);
    return dateA - dateB;
  });

  const totalCount = sortedMessages.length;
  const inboundCount = sortedMessages.filter((m) => m.direction === "inbound").length;
  const outboundCount = sortedMessages.filter((m) => m.direction === "outbound").length;

  // Get date range
  let dateRange = "";
  try {
    const firstDate = new Date(sortedMessages[0]?.dateAdded);
    const lastDate = new Date(sortedMessages[sortedMessages.length - 1]?.dateAdded);
    const formatDate = (d) => d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    dateRange = `${formatDate(firstDate)} to ${formatDate(lastDate)}`;
  } catch {
    dateRange = "dates unknown";
  }

  // Analyze conversation content
  const allText = sortedMessages.map((m) => m.body || "").join(" ").toLowerCase();
  
  // Detect topics discussed
  const topicsDiscussed = [];
  if (allText.includes("cita") || allText.includes("appointment") || allText.includes("schedule")) {
    topicsDiscussed.push("appointment scheduling");
  }
  if (allText.includes("deposit") || allText.includes("depósito") || allText.includes("payment")) {
    topicsDiscussed.push("deposit/payment");
  }
  if (allText.includes("consult") || allText.includes("consulta") || allText.includes("video")) {
    topicsDiscussed.push("consultation");
  }
  if (allText.includes("dolor") || allText.includes("pain") || allText.includes("heal") || allText.includes("aftercare")) {
    topicsDiscussed.push("aftercare");
  }
  if (allText.includes("price") || allText.includes("precio") || allText.includes("cost") || allText.includes("cuanto")) {
    topicsDiscussed.push("pricing");
  }
  if (allText.includes("reschedule") || allText.includes("cancel") || allText.includes("cambiar")) {
    topicsDiscussed.push("reschedule/changes");
  }

  // Count images shared
  const totalImages = sortedMessages.reduce((count, m) => count + (m.attachments?.length || 0), 0);

  // Detect communication patterns
  const humanHandledCount = sortedMessages.filter((m) => 
    m.direction === "outbound" && (m.source || "").toLowerCase() === "app"
  ).length;
  const botHandledCount = outboundCount - humanHandledCount;

  // Build the summary
  const summaryParts = [];

  // Header with dates and stats
  summaryParts.push(`[PREVIOUS TATTOO CYCLE: ${dateRange}]`);
  summaryParts.push(`Messages: ${totalCount} total (${inboundCount} from client, ${outboundCount} from studio)`);
  
  if (humanHandledCount > 0) {
    summaryParts.push(`Handling: ${botHandledCount} AI, ${humanHandledCount} human rep`);
  }

  // Tattoo details from CRM
  const tattooDetails = [];
  if (crmFields.tattoo_summary) tattooDetails.push(`Tattoo: ${crmFields.tattoo_summary}`);
  if (crmFields.tattoo_placement) tattooDetails.push(`Placement: ${crmFields.tattoo_placement}`);
  if (crmFields.tattoo_style) tattooDetails.push(`Style: ${crmFields.tattoo_style}`);
  if (crmFields.tattoo_size) tattooDetails.push(`Size: ${crmFields.tattoo_size}`);
  if (crmFields.tattoo_color_preference) tattooDetails.push(`Color: ${crmFields.tattoo_color_preference}`);
  
  if (tattooDetails.length > 0) {
    summaryParts.push(`Details: ${tattooDetails.join("; ")}`);
  }

  // Topics and engagement
  if (topicsDiscussed.length > 0) {
    summaryParts.push(`Topics discussed: ${topicsDiscussed.join(", ")}`);
  }

  if (totalImages > 0) {
    summaryParts.push(`Reference images shared: ${totalImages}`);
  }

  // Artist info
  if (crmFields.assigned_artist || crmFields.inquired_technician) {
    summaryParts.push(`Artist: ${crmFields.assigned_artist || crmFields.inquired_technician}`);
  }

  // Consultation type
  if (crmFields.consultation_type) {
    summaryParts.push(`Consult type: ${crmFields.consultation_type}`);
  }

  // Language preference
  if (crmFields.language_preference) {
    summaryParts.push(`Language: ${crmFields.language_preference}`);
  }

  // Completion info from options
  if (options.completedAt) {
    summaryParts.push(`Completed: ${options.completedAt}`);
  }

  // Add any special notes
  if (options.notes) {
    summaryParts.push(`Notes: ${options.notes}`);
  }

  // Join all parts
  return summaryParts.join(" | ");
}

/**
 * Append a new summary to existing previous summaries (for clients with multiple tattoos)
 * 
 * @param {string} existingSummary - Existing previous_conversation_summary value
 * @param {string} newSummary - New summary to append
 * @returns {string} Combined summary with clear separation
 */
function appendToConversationHistory(existingSummary, newSummary) {
  if (!existingSummary || existingSummary.trim() === "") {
    return newSummary;
  }

  // Add separator and append
  return `${existingSummary}\n---\n${newSummary}`;
}

module.exports = {
  normalizeDisplayName,
  normalizeCustomFields,
  extractCustomFieldsFromPayload,
  buildEffectiveContact,
  buildContactProfile,
  // Thread formatting exports
  formatThreadForLLM,
  generateThreadSummary,
  buildImageContext,
  detectHandoffContext,
  buildReturningClientContext,
  // Archival exports
  generateComprehensiveConversationSummary,
  appendToConversationHistory,
};

