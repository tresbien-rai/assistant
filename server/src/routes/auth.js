/**
 * Authentication Routes
 *
 * Handles Google OAuth 2.0 authentication flow:
 * - GET /api/auth/google - Redirect to Google consent screen
 * - GET /api/auth/google/callback - Handle OAuth callback
 * - GET /api/auth/me - Get current user info
 * - POST /api/auth/logout - Clear session
 */

const express = require('express');
const { google } = require('googleapis');
const config = require('../config');
const dal = require('../db/dal');
const { encrypt } = require('../utils/encryption');
const { authenticate, generateToken } = require('../middleware/authenticate');
const { asyncHandler } = require('../middleware/errorHandler');
const AppError = require('../utils/AppError');
const { logger } = require('../utils/logger');

const router = express.Router();

// Google OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  config.google.clientId,
  config.google.clientSecret,
  config.google.redirectUri
);

// OAuth scopes
const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive.file', // Access to files created/opened by the app
];

/**
 * GET /api/auth/google
 * Initiates the Google OAuth flow
 * Redirects user to Google's consent screen
 */
router.get('/google', (req, res) => {
  // Generate state for CSRF protection
  const state = crypto.randomUUID();

  // Store state in a short-lived cookie for verification
  res.cookie('oauth_state', state, {
    httpOnly: true,
    secure: !config.isDev,
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000, // 10 minutes
  });

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', // Get refresh token
    scope: SCOPES,
    state,
    prompt: 'consent', // Force consent to ensure we get refresh token
  });

  logger.info({ state }, 'Initiating Google OAuth flow');
  res.redirect(authUrl);
});

/**
 * GET /api/auth/google/callback
 * Handles the OAuth callback from Google
 * Exchanges auth code for tokens, creates/updates user, issues JWT
 */
router.get('/google/callback', asyncHandler(async (req, res) => {
  const { code, state, error } = req.query;

  // Check for OAuth errors
  if (error) {
    logger.warn({ error }, 'Google OAuth error');
    return res.redirect('/?error=oauth_denied');
  }

  // Verify state for CSRF protection
  const storedState = req.cookies?.oauth_state;
  if (!state || state !== storedState) {
    logger.warn({ state, storedState }, 'OAuth state mismatch');
    return res.redirect('/?error=invalid_state');
  }

  // Clear the state cookie
  res.clearCookie('oauth_state');

  if (!code) {
    return res.redirect('/?error=no_code');
  }

  try {
    // Exchange authorization code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    logger.info('OAuth tokens received');

    // Get user profile from Google
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();

    logger.info({ googleId: profile.id, email: profile.email }, 'User profile retrieved');

    // Encrypt Drive tokens for storage
    const encryptedAccessToken = tokens.access_token ? encrypt(tokens.access_token) : null;
    const encryptedRefreshToken = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;

    // Find or create user
    let user = dal.findUserByGoogleId(profile.id);

    if (user) {
      // Existing user - update Drive tokens
      logger.info({ userId: user.id }, 'Existing user logging in');
      dal.updateUserDriveTokens(user.id, {
        driveToken: encryptedAccessToken,
        driveRefresh: encryptedRefreshToken || user.drive_refresh, // Keep existing refresh if not provided
      });
      user = dal.findUserById(user.id);
    } else {
      // New user - create account
      logger.info({ email: profile.email }, 'Creating new user');

      user = dal.createUser({
        googleId: profile.id,
        email: profile.email,
        displayName: profile.name,
        driveToken: encryptedAccessToken,
        driveRefresh: encryptedRefreshToken,
      });

      // Create default persona for new user
      dal.createPersona(user.id, {
        name: 'Assistant',
        systemPrompt: 'You are a helpful AI assistant.',
        modelConfig: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          modelParams: {
            temperature: 1.0,
            maxTokens: 8192,
            streaming: true,
          },
        },
      });

      // Create default settings for new user
      dal.upsertSettings(user.id, {
        avatarSize: 'medium',
        avatarPosition: 'top-right',
        showAvatar: true,
      });

      logger.info({ userId: user.id }, 'New user created with default persona and settings');
    }

    // Generate JWT
    const token = generateToken({
      userId: user.id,
      email: user.email,
      displayName: user.display_name,
    });

    // Set token as httpOnly cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: !config.isDev,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    // Redirect to frontend with success
    // The frontend can read the cookie automatically for API calls
    res.redirect('/?auth=success');

  } catch (err) {
    logger.error({ err }, 'OAuth callback error');
    return res.redirect('/?error=oauth_failed');
  }
}));

/**
 * GET /api/auth/me
 * Returns the current authenticated user's info
 */
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const user = dal.findUserById(req.user.userId);

  if (!user) {
    throw AppError.auth('User not found');
  }

  res.json({
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    hasDriveAccess: Boolean(user.drive_token),
    createdAt: user.created_at,
  });
}));

/**
 * POST /api/auth/logout
 * Clears the authentication cookie
 */
router.post('/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: !config.isDev,
    sameSite: 'lax',
  });

  res.json({ success: true, message: 'Logged out successfully' });
});

/**
 * GET /api/auth/status
 * Check authentication status without requiring auth
 * Useful for the frontend to check if user is logged in
 */
router.get('/status', (req, res) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.json({ authenticated: false });
  }

  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, config.jwtSecret);

    res.json({
      authenticated: true,
      user: {
        // Use `id` to match /api/auth/me and the CLAUDE.md schema.
        // The JWT payload uses `userId` internally — that's an unrelated
        // naming inside the token itself.
        id: decoded.userId,
        email: decoded.email,
        displayName: decoded.displayName,
      },
    });
  } catch {
    res.json({ authenticated: false });
  }
});

module.exports = router;
