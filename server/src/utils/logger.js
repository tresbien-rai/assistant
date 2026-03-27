/**
 * Logger Module
 *
 * Provides structured logging using pino with:
 * - JSON output in production
 * - Pretty-printed output in development
 * - Automatic sensitive data redaction
 * - Request context support
 */

const pino = require('pino');
const config = require('../config');

// Paths/keys that should never be logged
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'apiKey',
  'api_key',
  'password',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'driveToken',
  'drive_token',
  'driveRefresh',
  'drive_refresh',
  'encryptedKey',
  'encrypted_key',
  'secret',
  'credential',
  'credentials',
  '*.apiKey',
  '*.api_key',
  '*.password',
  '*.token',
  '*.secret',
];

// Create the base logger
const logger = pino({
  level: config.isDev ? 'debug' : 'info',

  // Redact sensitive fields
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },

  // Use pino-pretty in development
  transport: config.isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,

  // Base context for all logs
  base: {
    env: config.nodeEnv,
  },

  // Timestamp format
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Create a child logger with request context
 * @param {Object} req - Express request object
 * @returns {pino.Logger} Child logger with request context
 */
function createRequestLogger(req) {
  return logger.child({
    requestId: req.id,
    method: req.method,
    path: req.path,
    userId: req.user?.userId,
  });
}

/**
 * Sanitize an object for logging (deep clone with sensitive fields removed)
 * Use this when you need to log an object that might contain sensitive data
 * @param {Object} obj - Object to sanitize
 * @returns {Object} Sanitized copy
 */
function sanitize(obj) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  const sensitiveKeys = new Set([
    'apikey', 'api_key', 'apiKey',
    'password', 'secret', 'token',
    'authorization', 'cookie',
    'accesstoken', 'access_token', 'accessToken',
    'refreshtoken', 'refresh_token', 'refreshToken',
    'drivetoken', 'drive_token', 'driveToken',
    'driverefresh', 'drive_refresh', 'driveRefresh',
    'encryptedkey', 'encrypted_key', 'encryptedKey',
    'credential', 'credentials',
  ]);

  const sanitized = Array.isArray(obj) ? [] : {};

  for (const [key, value] of Object.entries(obj)) {
    if (sensitiveKeys.has(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]';
    } else if (value && typeof value === 'object') {
      sanitized[key] = sanitize(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Log an error with full context
 * @param {Error} err - The error to log
 * @param {Object} [context] - Additional context
 */
function logError(err, context = {}) {
  const logData = {
    err: {
      message: err.message,
      stack: err.stack,
      code: err.code,
      statusCode: err.statusCode,
    },
    ...sanitize(context),
  };

  if (err.statusCode && err.statusCode < 500) {
    logger.warn(logData, `Client error: ${err.message}`);
  } else {
    logger.error(logData, `Server error: ${err.message}`);
  }
}

module.exports = {
  logger,
  createRequestLogger,
  sanitize,
  logError,
};
