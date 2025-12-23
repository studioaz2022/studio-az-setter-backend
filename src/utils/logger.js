// logger.js
// Structured logging utility with compact mode for efficient debugging
//
// Set LOG_COMPACT=true in environment for condensed logs optimized for AI debugging
// Compact logs preserve all decision-making context while removing noise

const LOG_LEVELS = {
  ERROR: "error",
  WARN: "warn",
  INFO: "info",
  DEBUG: "debug",
};

const DEFAULT_LEVEL = process.env.LOG_LEVEL || LOG_LEVELS.INFO;
const COMPACT_MODE = process.env.LOG_COMPACT === "true";

// ═══════════════════════════════════════════════════════════════════════════
// COMPACT LOGGING UTILITIES
// Designed to preserve AI decision context while minimizing verbosity
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Shorten a contact ID for display (first 8 chars)
 */
function shortId(id) {
  if (!id) return "???";
  return id.length > 10 ? id.slice(0, 8) + "…" : id;
}

/**
 * Truncate a string to max length with ellipsis
 */
function truncate(str, maxLen = 80) {
  if (!str) return "";
  const s = String(str).replace(/\n/g, " ").trim();
  return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
}

/**
 * Extract only TRUE intents from intents object
 * Returns array of intent names (without _intent suffix)
 */
function activeIntents(intents) {
  if (!intents) return [];
  return Object.entries(intents)
    .filter(([k, v]) => v === true && k.endsWith("_intent"))
    .map(([k]) => k.replace("_intent", ""));
}

/**
 * Compact representation of canonical state - only non-null values
 */
function compactCanonical(canonical) {
  if (!canonical) return {};
  const compact = {};
  const importantFields = [
    "tattooPlacement", "tattooSize", "tattooSummary", "timeline",
    "consultationType", "depositPaid", "depositLinkSent", "holdAppointmentId"
  ];
  importantFields.forEach(f => {
    if (canonical[f] != null && canonical[f] !== "" && canonical[f] !== false) {
      compact[f] = canonical[f];
    }
  });
  // Always show depositPaid if true
  if (canonical.depositPaid) compact.depositPaid = true;
  return compact;
}

/**
 * Compact thread stats
 */
function compactThread(thread) {
  if (!thread) return "no thread";
  const parts = [`${thread.totalCount || 0} msgs`];
  if (thread.summary) parts.push("summary✓");
  if (thread.imageContext) parts.push("img✓");
  if (thread.handoffContext?.wasHumanHandling) parts.push("human✓");
  return parts.join(" | ");
}

/**
 * Compact field updates - just the keys that were set
 */
function compactUpdates(updates) {
  if (!updates) return [];
  return Object.entries(updates)
    .filter(([k, v]) => v != null && v !== "")
    .map(([k, v]) => {
      const val = typeof v === "string" ? truncate(v, 25) : v;
      return `${k}=${val}`;
    });
}

/**
 * Log incoming message in compact format
 * Preserves: contact, channel, message, relevant fields, thread context
 */
function logIncomingMessage({ contactId, contactName, channel, message, customFields, threadContext }) {
  if (!COMPACT_MODE) return false; // Signal caller to use verbose logging
  
  console.log(`\n═══ MSG IN [${shortId(contactId)}] ${contactName || "?"} (${channel || "?"}) ═══`);
  console.log(`   "${truncate(message, 100)}"`);
  
  // Show only relevant custom fields (exclude noisy ones)
  const relevantFields = {};
  const skipFields = ["attributionSource", "lastAttributionSource", "location", "contact", "customData", "workflow"];
  Object.entries(customFields || {}).forEach(([k, v]) => {
    if (v != null && v !== "" && !skipFields.includes(k) && !k.match(/^[a-z0-9]{20,}$/i)) {
      relevantFields[k] = truncate(String(v), 30);
    }
  });
  if (Object.keys(relevantFields).length > 0) {
    console.log(`   fields: ${JSON.stringify(relevantFields)}`);
  }
  
  if (threadContext) {
    console.log(`   thread: ${compactThread(threadContext)}`);
  }
  
  return true; // Signal we handled logging
}

/**
 * Log AI routing decision
 * Preserves: phase transition, active intents, handler selection, reason
 */
function logRouting({ phaseBefore, phaseAfter, intents, canonical, handler, reason }) {
  if (!COMPACT_MODE) return false;
  
  const active = activeIntents(intents);
  const phaseStr = phaseBefore === phaseAfter ? phaseAfter : `${phaseBefore}→${phaseAfter}`;
  
  console.log(`═══ ROUTING ═══`);
  console.log(`   phase: ${phaseStr} | handler: ${handler} | reason: ${reason}`);
  if (active.length > 0) {
    console.log(`   intents: [${active.join(", ")}]`);
  }
  
  // Show objection details if detected
  if (intents?.objection_intent && intents?.objection_type) {
    console.log(`   🚨 objection: ${intents.objection_type} (${intents.objection_data?.category || "?"})`);
  }
  
  const state = compactCanonical(canonical);
  if (Object.keys(state).length > 0) {
    console.log(`   state: ${JSON.stringify(state)}`);
  }
  
  return true;
}

/**
 * Log AI response
 * Preserves: bubbles (full text), meta flags, field updates, timing
 */
function logAIResponse({ bubbles, meta, fieldUpdates, timing, handler, reason }) {
  if (!COMPACT_MODE) return false;
  
  const timingStr = timing ? ` [${timing}ms]` : "";
  console.log(`═══ AI RESPONSE${timingStr} handler=${handler || "ai"} ═══`);
  
  // Show each bubble (important for debugging AI output)
  (bubbles || []).forEach((b, i) => {
    console.log(`   → "${truncate(b, 120)}"`);
  });
  
  // Show meta flags that are set
  if (meta) {
    const flags = [];
    if (meta.aiPhase) flags.push(`phase:${meta.aiPhase}`);
    if (meta.leadTemperature) flags.push(`temp:${meta.leadTemperature}`);
    if (meta.wantsDepositLink) flags.push("wantsDeposit✓");
    if (meta.depositPushedThisTurn) flags.push("depositPushed✓");
    if (meta.wantsAppointmentOffer) flags.push("wantsAppt✓");
    if (meta.consultMode) flags.push(`mode:${meta.consultMode}`);
    if (flags.length > 0) {
      console.log(`   meta: { ${flags.join(", ")} }`);
    }
  }
  
  // Show field updates
  const updates = compactUpdates(fieldUpdates);
  if (updates.length > 0) {
    console.log(`   updates: { ${updates.join(", ")} }`);
  }
  
  return true;
}

/**
 * Log message sending result
 */
function logSendResult({ sent, total, channel, contactId }) {
  if (!COMPACT_MODE) return false;
  console.log(`═══ SEND ═══ ✓ ${sent}/${total} → ${channel || "?"} [${shortId(contactId)}]`);
  return true;
}

/**
 * Log Square payment event
 */
function logSquareEvent({ event, orderId, contactId, amount, status }) {
  if (!COMPACT_MODE) return false;
  console.log(`💳 SQUARE: ${event} order=${shortId(orderId)} contact=${shortId(contactId)} $${(amount || 0) / 100} ${status || ""}`);
  return true;
}

/**
 * Log deterministic response (bypassed AI)
 */
function logDeterministic({ intent, response, depositLink, slots }) {
  if (!COMPACT_MODE) return false;
  console.log(`═══ DETERMINISTIC [${intent}] ═══`);
  if (response) console.log(`   → "${truncate(response, 120)}"`);
  if (depositLink) console.log(`   💳 deposit link: ${depositLink}`);
  if (slots?.length) console.log(`   📅 slots offered: ${slots.length}`);
  return true;
}

/**
 * Check if a log level should be output
 */
function shouldLog(level) {
  const levels = [LOG_LEVELS.ERROR, LOG_LEVELS.WARN, LOG_LEVELS.INFO, LOG_LEVELS.DEBUG];
  const currentIndex = levels.indexOf(DEFAULT_LEVEL);
  const messageIndex = levels.indexOf(level);
  return messageIndex <= currentIndex;
}

/**
 * Clean log object by removing null, undefined, empty strings, empty arrays, and empty objects
 * Preserves important decision-making fields even if they're falsy
 */
function cleanLogObject(obj, preserveFields = []) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    const cleaned = obj
      .map(item => cleanLogObject(item, preserveFields))
      .filter(item => item !== null && item !== undefined && item !== "");
    return cleaned.length > 0 ? cleaned : undefined;
  }

  if (typeof obj !== "object") {
    return obj;
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    // Always preserve important fields even if they're falsy
    if (preserveFields.includes(key)) {
      cleaned[key] = value;
      continue;
    }

    // Skip null, undefined, empty strings
    if (value === null || value === undefined || value === "") {
      continue;
    }

    // Recursively clean nested objects/arrays
    const cleanedValue = cleanLogObject(value, preserveFields);
    
    // Skip if cleaned value is undefined, empty array, or empty object
    if (cleanedValue === undefined) {
      continue;
    }
    if (Array.isArray(cleanedValue) && cleanedValue.length === 0) {
      continue;
    }
    if (typeof cleanedValue === "object" && Object.keys(cleanedValue).length === 0) {
      continue;
    }

    cleaned[key] = cleanedValue;
  }

  return cleaned;
}

/**
 * Format log entry with timestamp and level
 */
function formatLog(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  return {
    timestamp,
    level,
    message,
    ...data,
  };
}

/**
 * Log error
 */
function error(message, data = {}) {
  if (shouldLog(LOG_LEVELS.ERROR)) {
    const logEntry = formatLog(LOG_LEVELS.ERROR, message, data);
    console.error(JSON.stringify(logEntry));
  }
}

/**
 * Log warning
 */
function warn(message, data = {}) {
  if (shouldLog(LOG_LEVELS.WARN)) {
    const logEntry = formatLog(LOG_LEVELS.WARN, message, data);
    console.warn(JSON.stringify(logEntry));
  }
}

/**
 * Log info
 */
function info(message, data = {}) {
  if (shouldLog(LOG_LEVELS.INFO)) {
    const logEntry = formatLog(LOG_LEVELS.INFO, message, data);
    console.log(JSON.stringify(logEntry));
  }
}

/**
 * Log debug
 */
function debug(message, data = {}) {
  if (shouldLog(LOG_LEVELS.DEBUG)) {
    const logEntry = formatLog(LOG_LEVELS.DEBUG, message, data);
    console.log(JSON.stringify(logEntry));
  }
}

module.exports = {
  error,
  warn,
  info,
  debug,
  LOG_LEVELS,
  cleanLogObject,
  // Compact logging utilities
  COMPACT_MODE,
  shortId,
  truncate,
  activeIntents,
  compactCanonical,
  compactThread,
  compactUpdates,
  logIncomingMessage,
  logRouting,
  logAIResponse,
  logSendResult,
  logSquareEvent,
  logDeterministic,
};

