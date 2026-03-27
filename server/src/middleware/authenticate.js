/**
 * Authentication Middleware
 *
 * Verifies JWT tokens from the Authorization header or cookies.
 * Attaches user info to req.user for downstream handlers.
 */

const jwt = require('jsonwebtoken');
const config = require('../config');
const AppError = require('../utils/AppError');

/**
 * Extract JWT token from request
 * Checks Authorization header first, then cookies
 * @param {Request} req - Express request object
 * @returns {string|null} The JWT token or null if not found
 */
function extractToken(req) {
  // Check Authorization header (Bearer token)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // Check cookies
  if (req.cookies && req.cookies.token) {
    return req.cookies.token;
  }

  // Check query parameter (for OAuth callback redirect)
  if (req.query && req.query.token) {
    return req.query.token;
  }

  return null;
}

/**
 * Authentication middleware
 * Verifies JWT and attaches user to request
 *
 * Usage: app.use('/api/protected', authenticate, routes);
 *
 * After this middleware, req.user contains:
 * - userId: string (database user ID)
 * - email: string
 * - displayName: string
 */
function authenticate(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    return next(AppError.auth('No authentication token provided'));
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret);

    // Attach user info to request
    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      displayName: decoded.displayName,
    };

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(AppError.auth('Your session has expired. Please sign in again.'));
    }

    if (err.name === 'JsonWebTokenError') {
      return next(AppError.auth('Invalid authentication token'));
    }

    return next(AppError.auth('Authentication failed'));
  }
}

/**
 * Optional authentication middleware
 * Attaches user if token is valid, but doesn't require it
 *
 * Usage: app.use(optionalAuth); // Makes req.user available if logged in
 */
function optionalAuth(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    req.user = null;
    return next();
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      displayName: decoded.displayName,
    };
  } catch {
    req.user = null;
  }

  next();
}

/**
 * Generate a JWT token for a user
 * @param {Object} user - User data to encode
 * @param {string} user.userId - Database user ID
 * @param {string} user.email - User's email
 * @param {string} user.displayName - User's display name
 * @returns {string} Signed JWT token
 */
function generateToken(user) {
  return jwt.sign(
    {
      userId: user.userId,
      email: user.email,
      displayName: user.displayName,
    },
    config.jwtSecret,
    {
      expiresIn: config.jwtExpiresIn,
    }
  );
}

/**
 * Verify a JWT token without middleware context
 * @param {string} token - JWT token to verify
 * @returns {Object|null} Decoded token payload or null if invalid
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

module.exports = {
  authenticate,
  optionalAuth,
  generateToken,
  verifyToken,
  extractToken,
};
