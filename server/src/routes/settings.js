/**
 * Settings Routes
 *
 * Handles user settings for avatar display preferences and custom model lists.
 *
 * Endpoints:
 * - GET /api/settings - Get settings for authenticated user (returns defaults if none)
 * - PUT /api/settings - Update settings (partial update, upserts if none exist)
 */

const express = require('express');
const dal = require('../db/dal');
const { authenticate } = require('../middleware/authenticate');
const { asyncHandler } = require('../middleware/errorHandler');
const AppError = require('../utils/AppError');

const router = express.Router();

// Valid avatar sizes and positions for validation
const VALID_AVATAR_SIZES = ['small', 'medium', 'large', 'xlarge'];
const VALID_AVATAR_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

// All routes require authentication
router.use(authenticate);

/**
 * GET /api/settings
 * Returns settings for the authenticated user
 * If no settings exist, returns defaults
 */
router.get('/', asyncHandler(async (req, res) => {
  const settings = dal.getSettingsByUser(req.user.userId);
  res.json(settings);
}));

/**
 * PUT /api/settings
 * Update settings for the authenticated user
 * Accepts partial updates - only provided fields are updated
 * Creates settings record if none exists (upsert)
 */
router.put('/', asyncHandler(async (req, res) => {
  const { avatarSize, avatarPosition, showAvatar, customModels } = req.body;

  // Validate avatarSize if provided
  if (avatarSize !== undefined) {
    if (typeof avatarSize !== 'string' || !VALID_AVATAR_SIZES.includes(avatarSize)) {
      throw AppError.validation(
        `Invalid avatarSize: ${avatarSize}. Must be one of: ${VALID_AVATAR_SIZES.join(', ')}`
      );
    }
  }

  // Validate avatarPosition if provided
  if (avatarPosition !== undefined) {
    if (typeof avatarPosition !== 'string' || !VALID_AVATAR_POSITIONS.includes(avatarPosition)) {
      throw AppError.validation(
        `Invalid avatarPosition: ${avatarPosition}. Must be one of: ${VALID_AVATAR_POSITIONS.join(', ')}`
      );
    }
  }

  // Validate showAvatar if provided
  if (showAvatar !== undefined && typeof showAvatar !== 'boolean') {
    throw AppError.validation('showAvatar must be a boolean');
  }

  // Validate customModels if provided
  if (customModels !== undefined) {
    if (typeof customModels !== 'object' || customModels === null || Array.isArray(customModels)) {
      throw AppError.validation('customModels must be an object');
    }
  }

  // Build update data (only include fields that were provided)
  const updateData = {};
  if (avatarSize !== undefined) updateData.avatarSize = avatarSize;
  if (avatarPosition !== undefined) updateData.avatarPosition = avatarPosition;
  if (showAvatar !== undefined) updateData.showAvatar = showAvatar;
  if (customModels !== undefined) updateData.customModels = customModels;

  // Upsert settings
  const settings = dal.upsertSettings(req.user.userId, updateData);

  res.json(settings);
}));

module.exports = router;
