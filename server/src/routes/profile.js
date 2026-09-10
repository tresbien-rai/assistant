/**
 * User Profile Routes (UP-01, docs/PROFILE_DESIGN.md tier 1)
 *
 * The user's own description of themselves — the layer that tells a persona who
 * it is talking to. Read and written as ONE document; see upsertUserProfile for
 * why there is no partial patch.
 *
 * Endpoints:
 * - GET /api/profile          - the authenticated user's profile (empty if never written)
 * - PUT /api/profile          - replace it wholesale
 * - GET /api/profile/suggested - the seed sections offered for a blank profile
 *
 * Nothing here reaches the model yet. UP-03 adds the `profile` system block
 * that renders it into the prompt; until then this is storage and an API, so it
 * can ship and be filled in before it has anywhere to go.
 */

const express = require('express');
const dal = require('../db/dal');
const { authenticate } = require('../middleware/authenticate');
const { asyncHandler } = require('../middleware/errorHandler');
const {
  validateProfile,
  profileTextLength,
  SUGGESTED_SECTIONS,
  MAX_PREFERRED_NAME_CHARS,
  MAX_SECTIONS,
  MAX_TITLE_CHARS,
  MAX_BODY_CHARS,
  MAX_PROFILE_CHARS,
} = require('../utils/userProfile');

const router = express.Router();

// All routes require authentication. The profile is as personal as data here
// gets, and every DAL call is scoped by req.user.userId — never by anything the
// client sends.
router.use(authenticate);

/**
 * The caps, so the editor can enforce the same limits the server does instead of
 * hardcoding a second copy that drifts. Served alongside the suggestions since a
 * client that wants one always wants the other.
 */
const LIMITS = {
  preferredNameChars: MAX_PREFERRED_NAME_CHARS,
  sections: MAX_SECTIONS,
  titleChars: MAX_TITLE_CHARS,
  bodyChars: MAX_BODY_CHARS,
  profileChars: MAX_PROFILE_CHARS,
};

/**
 * GET /api/profile
 * The authenticated user's profile. Returns an empty profile rather than 404
 * when they have never written one — "no profile" is a state, not an error.
 *
 * `textLength` is what would actually reach the model (enabled sections only),
 * so the editor can show the running cost of a layer that is paid on every turn
 * of every conversation.
 */
router.get('/', asyncHandler(async (req, res) => {
  const profile = dal.getUserProfile(req.user.userId);
  res.json({ ...profile, textLength: profileTextLength(profile) });
}));

/**
 * PUT /api/profile
 * Replace the profile wholesale. Validation is strict and throws
 * AppError.validation, which the error handler turns into a 400 the client
 * surfaces verbatim — the messages name the specific limit that was exceeded.
 */
router.put('/', asyncHandler(async (req, res) => {
  const validated = validateProfile(req.body);
  const profile = dal.upsertUserProfile(req.user.userId, validated);
  res.json({ ...profile, textLength: profileTextLength(profile) });
}));

/**
 * GET /api/profile/suggested
 * The seed sections a blank profile is offered, plus the server's limits.
 *
 * Served rather than hardcoded in the client so the suggestions can be reworded
 * — they are prompt-adjacent copy, and the wording is the thing most likely to
 * need tuning once real profiles exist.
 */
router.get('/suggested', asyncHandler(async (req, res) => {
  res.json({ sections: SUGGESTED_SECTIONS, limits: LIMITS });
}));

module.exports = router;
