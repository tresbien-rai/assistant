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

// Avatar size/position accept EITHER a named preset OR a free value:
//   size:     a preset name, or a numeric px string in [32, 480]
//   position: a preset corner, or "x,y" where x,y are 0..100 (% of available travel)
// Stored as text in the existing columns — no schema change needed.
const AVATAR_SIZE_MIN = 32;
const AVATAR_SIZE_MAX = 480;

function isValidAvatarSize(v) {
  if (typeof v !== 'string') return false;
  if (VALID_AVATAR_SIZES.includes(v)) return true;
  const n = Number(v);
  return Number.isFinite(n) && n >= AVATAR_SIZE_MIN && n <= AVATAR_SIZE_MAX;
}

function isValidAvatarPosition(v) {
  if (typeof v !== 'string') return false;
  if (VALID_AVATAR_POSITIONS.includes(v)) return true;
  const parts = v.split(',');
  if (parts.length !== 2) return false;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 100 && y >= 0 && y <= 100;
}

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

  // Validate avatarSize if provided (preset name or numeric px string)
  if (avatarSize !== undefined && !isValidAvatarSize(avatarSize)) {
    throw AppError.validation(
      `Invalid avatarSize: ${avatarSize}. Must be a preset (${VALID_AVATAR_SIZES.join(', ')}) or a number ${AVATAR_SIZE_MIN}-${AVATAR_SIZE_MAX}.`
    );
  }

  // Validate avatarPosition if provided (preset corner or "x,y" percentages)
  if (avatarPosition !== undefined && !isValidAvatarPosition(avatarPosition)) {
    throw AppError.validation(
      `Invalid avatarPosition: ${avatarPosition}. Must be a preset (${VALID_AVATAR_POSITIONS.join(', ')}) or "x,y" with x,y in 0-100.`
    );
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
