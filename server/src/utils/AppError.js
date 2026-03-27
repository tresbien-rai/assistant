/**
 * AppError - Custom error class for structured API errors
 *
 * Provides consistent error responses across the application with:
 * - HTTP status codes
 * - Error codes for client-side handling
 * - User-facing messages
 * - Optional additional details
 */

class AppError extends Error {
  /**
   * Create an AppError
   * @param {number} statusCode - HTTP status code
   * @param {string} code - Error code (e.g., 'VALIDATION_ERROR')
   * @param {string} message - User-facing error message
   * @param {string|Object} [details] - Additional error details
   */
  constructor(statusCode, code, message, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true; // Distinguishes from programming errors

    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Convert to JSON for API response
   * @returns {Object} Structured error object
   */
  toJSON() {
    const error = {
      code: this.code,
      message: this.message,
    };

    if (this.details) {
      error.details = this.details;
    }

    return { error };
  }

  // ===========================================================================
  // Static Factory Methods
  // ===========================================================================

  /**
   * Authentication error (401)
   * Used for: expired sessions, invalid tokens, missing auth
   * @param {string} [message] - Custom message
   * @returns {AppError}
   */
  static auth(message = 'Authentication required. Please sign in.') {
    return new AppError(401, 'AUTH_ERROR', message);
  }

  /**
   * AI Provider error (502)
   * Used for: errors from Anthropic, Gemini, OpenAI APIs
   * @param {string} message - Error description
   * @param {string|Object} [details] - Provider-specific error details
   * @returns {AppError}
   */
  static provider(message = 'The AI provider returned an error.', details = null) {
    return new AppError(502, 'PROVIDER_ERROR', message, details);
  }

  /**
   * Google Drive error (502)
   * Used for: Drive API failures, token issues
   * @param {string} [message] - Custom message
   * @returns {AppError}
   */
  static drive(message = 'Could not access Google Drive. Please reconnect your account.') {
    return new AppError(502, 'DRIVE_ERROR', message);
  }

  /**
   * Rate limit error (429)
   * Used for: too many requests
   * @param {number} [retryAfter] - Seconds until retry is allowed
   * @returns {AppError}
   */
  static rateLimited(retryAfter = 60) {
    const error = new AppError(
      429,
      'RATE_LIMITED',
      'Too many requests. Please wait before trying again.',
      { retryAfter }
    );
    error.retryAfter = retryAfter;
    return error;
  }

  /**
   * Validation error (400)
   * Used for: invalid input, bad request format
   * @param {string} message - What was invalid
   * @param {Object} [details] - Field-specific errors
   * @returns {AppError}
   */
  static validation(message = 'Invalid request.', details = null) {
    return new AppError(400, 'VALIDATION_ERROR', message, details);
  }

  /**
   * Not found error (404)
   * Used for: resource doesn't exist or user doesn't have access
   * @param {string} [resource] - What wasn't found
   * @returns {AppError}
   */
  static notFound(resource = 'Resource') {
    return new AppError(404, 'NOT_FOUND', `${resource} not found.`);
  }

  /**
   * Forbidden error (403)
   * Used for: user doesn't have permission
   * @param {string} [message] - Custom message
   * @returns {AppError}
   */
  static forbidden(message = 'You do not have permission to perform this action.') {
    return new AppError(403, 'FORBIDDEN', message);
  }

  /**
   * Conflict error (409)
   * Used for: duplicate resources, state conflicts
   * @param {string} [message] - What conflicted
   * @returns {AppError}
   */
  static conflict(message = 'Resource already exists.') {
    return new AppError(409, 'CONFLICT', message);
  }

  /**
   * Server error (500)
   * Used for: unexpected errors, catch-all
   * @param {string} [message] - Custom message (don't expose internals!)
   * @returns {AppError}
   */
  static server(message = 'An unexpected error occurred. Please try again.') {
    return new AppError(500, 'SERVER_ERROR', message);
  }
}

module.exports = AppError;
