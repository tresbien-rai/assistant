/**
 * Error Handler Middleware
 *
 * Centralized error handling for all Express routes.
 * Converts errors to structured JSON responses and logs appropriately.
 */

const AppError = require('../utils/AppError');
const { logError } = require('../utils/logger');
const config = require('../config');

/**
 * Error handler middleware
 * Must be registered LAST in the middleware chain
 */
function errorHandler(err, req, res, next) {
  // If headers already sent, delegate to Express default handler
  if (res.headersSent) {
    return next(err);
  }

  // Handle AppError (operational errors)
  if (err instanceof AppError) {
    logError(err, {
      requestId: req.id,
      userId: req.user?.userId,
      path: req.path,
      method: req.method,
    });

    // Set Retry-After header for rate limiting
    if (err.retryAfter) {
      res.set('Retry-After', String(err.retryAfter));
    }

    return res.status(err.statusCode).json(err.toJSON());
  }

  // Handle unexpected errors (programming errors, etc.)
  logError(err, {
    requestId: req.id,
    userId: req.user?.userId,
    path: req.path,
    method: req.method,
    body: req.body,
    query: req.query,
  });

  // Don't leak error details in production
  const message = config.isDev
    ? err.message
    : 'An unexpected error occurred. Please try again.';

  return res.status(500).json({
    error: {
      code: 'SERVER_ERROR',
      message,
      // Include stack trace only in development
      ...(config.isDev && { stack: err.stack }),
    },
  });
}

/**
 * 404 handler for API routes
 * Register AFTER all routes but BEFORE errorHandler
 */
function notFoundHandler(req, res, next) {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `API endpoint not found: ${req.method} ${req.path}`,
      },
    });
  }
  next();
}

/**
 * Async route wrapper to catch errors in async handlers
 * Usage: router.get('/path', asyncHandler(async (req, res) => { ... }))
 * @param {Function} fn - Async route handler
 * @returns {Function} Wrapped handler that catches errors
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  errorHandler,
  notFoundHandler,
  asyncHandler,
};
