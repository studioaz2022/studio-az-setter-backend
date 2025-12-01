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
};

