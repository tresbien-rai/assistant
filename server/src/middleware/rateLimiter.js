/**
 * Rate Limiter Middleware
 *
 * Per-user rate limiting for chat proxy endpoints.
 * Uses express-rate-limit with in-memory store.
 *
 * Two limiters are applied to /api/chat* routes:
 * - chatMinuteLimit: 30 requests per minute
 * - chatHourLimit: 500 requests per hour
 */

const rateLimit = require('express-rate-limit');
const AppError = require('../utils/AppError');
const { logger } = require('../utils/logger');

/**
 * Key generator that uses the authenticated user's ID.
 * The authenticate middleware always runs before these rate limiters,
 * so req.user.userId is guaranteed to be set.
 * @param {Request} req - Express request
 * @returns {string} Rate limit key
 */
function keyGenerator(req) {
  return req.user.userId;
}

/**
 * Custom handler for when rate limit is exceeded.
 * Logs the event and throws an AppError.rateLimited error.
 * @param {Request} req - Express request
 * @param {Response} res - Express response
 * @param {Function} next - Express next function
 * @param {Object} options - Rate limit options
 */
function rateLimitHandler(req, res, next, options) {
  const retryAfter = Math.ceil(options.windowMs / 1000);

  logger.warn({
    userId: req.user?.userId,
    ip: req.ip,
    path: req.path,
    limit: options.limit,
    windowMs: options.windowMs,
  }, 'Rate limit exceeded');

  next(AppError.rateLimited(retryAfter));
}

/**
 * Chat minute rate limiter
 * 30 requests per 1-minute window, per user
 */
const chatMinuteLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  handler: rateLimitHandler,
});

/**
 * Chat hour rate limiter
 * 500 requests per 1-hour window, per user
 */
const chatHourLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 500,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  handler: rateLimitHandler,
});

module.exports = {
  chatMinuteLimit,
  chatHourLimit,
};
