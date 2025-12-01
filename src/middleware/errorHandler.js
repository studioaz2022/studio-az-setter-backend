// errorHandler.js
// Express error handling middleware

const logger = require("../utils/logger");

/**
 * Express error handling middleware
 * Should be added as the last middleware in Express app
 */
function errorHandler(err, req, res, next) {
  // Log the error
  logger.error("Express error handler caught error", {
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    body: req.body,
  });

  // Determine status code
  const statusCode = err.statusCode || err.status || 500;

  // Determine error message (don't expose internal errors in production)
  const isDevelopment = process.env.NODE_ENV === "development";
  const message = isDevelopment ? err.message : "Internal server error";

  // Send error response
  res.status(statusCode).json({
    error: {
      message,
      statusCode,
      ...(isDevelopment && { stack: err.stack }),
    },
  });
}

/**
 * 404 Not Found handler
 */
function notFoundHandler(req, res, next) {
  res.status(404).json({
    error: {
      message: "Route not found",
      statusCode: 404,
      path: req.path,
    },
  });
}

module.exports = {
  errorHandler,
  notFoundHandler,
};

