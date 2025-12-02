// logger.js
// Structured logging utility

const LOG_LEVELS = {
  ERROR: "error",
  WARN: "warn",
  INFO: "info",
  DEBUG: "debug",
};

const DEFAULT_LEVEL = process.env.LOG_LEVEL || LOG_LEVELS.INFO;

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
};

