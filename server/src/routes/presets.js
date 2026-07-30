/**
 * Prompt Preset Routes (AP-02, docs/ADVANCED_PROMPTS_PLAN.md)
 *
 * CRUD over the user's prompt presets — the override sets for the platform
 * prompt layer that AP-01 resolves and composes.
 *
 * Endpoints:
 * - GET    /api/presets            - List the user's presets (newest first)
 * - GET    /api/presets/defaults   - The built-in block text + macro reference
 * - GET    /api/presets/:id        - One preset
 * - POST   /api/presets            - Create (optionally cloning another)
 * - PUT    /api/presets/:id        - Update name and/or blocks
 * - DELETE /api/presets/:id        - Delete, clearing every pointer at it
 *
 * The editor needs the BUILT-IN text to show as each block's placeholder, which
 * is what /defaults is for. It is a static, per-deployment payload — no user
 * data — so it is one fetch rather than something baked into every preset (that
 * would be the "presets store copies" mistake Decision D2 exists to avoid).
 */

const express = require('express');
const dal = require('../db/dal');
const { authenticate } = require('../middleware/authenticate');
const { asyncHandler } = require('../middleware/errorHandler');
const AppError = require('../utils/AppError');
const {
  defaultBlocks,
  normalizeBlocks,
  validateBlocks,
  validateName,
  MAX_BLOCK_CHARS,
  MAX_PRESET_CHARS,
  SYSTEM_BLOCK_IDS,
  MESSAGE_BLOCK_IDS,
  MACRO_REFERENCE,
} = require('../prompts/presets');
const { BUILTIN_BLOCK_TEXT } = require('../prompts/tessera');

const router = express.Router();

// A ceiling on presets per user. Not policy — a guard against a runaway client
// loop filling the table.
const MAX_PRESETS = 32;

router.use(authenticate);

/** Throw a validation AppError when a {ok,error} result failed. */
function assertValid(result) {
  if (!result.ok) throw AppError.validation(result.error);
}

/**
 * GET /api/presets/defaults
 * The built-in block text, block metadata, and macro reference — everything the
 * editor needs to render placeholders and a "reset to built-in" affordance.
 *
 * Declared BEFORE /:id so "defaults" isn't swallowed as a preset id.
 */
router.get('/defaults', asyncHandler(async (req, res) => {
  res.json({
    blocks: BUILTIN_BLOCK_TEXT,
    systemBlockIds: SYSTEM_BLOCK_IDS,
    messageBlockIds: MESSAGE_BLOCK_IDS,
    defaults: defaultBlocks(),
    macros: MACRO_REFERENCE,
    limits: { blockChars: MAX_BLOCK_CHARS, presetChars: MAX_PRESET_CHARS, presets: MAX_PRESETS },
  });
}));

/**
 * GET /api/presets
 * The user's presets, newest first. Blocks are normalized on the way out so the
 * client never has to reason about partial or legacy shapes.
 */
router.get('/', asyncHandler(async (req, res) => {
  const presets = dal.listPromptPresets(req.user.userId);
  res.json(presets.map((p) => ({ ...p, blocks: normalizeBlocks(p.blocks) })));
}));

/**
 * GET /api/presets/:id
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const preset = dal.getPromptPreset(req.params.id, req.user.userId);
  if (!preset) throw AppError.notFound('Preset');
  res.json({ ...preset, blocks: normalizeBlocks(preset.blocks) });
}));

/**
 * POST /api/presets
 * Body: { name, blocks? } or { name, cloneFrom? }
 *
 * `cloneFrom` copies another of the user's presets — "duplicate" in the UI. It
 * resolves server-side rather than having the client round-trip the blocks,
 * so duplicating can't be used to write blocks that never passed validation.
 */
router.post('/', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { name, blocks, cloneFrom } = req.body;

  assertValid(validateName(name));

  if (dal.listPromptPresets(userId).length >= MAX_PRESETS) {
    throw AppError.validation(`You already have the maximum of ${MAX_PRESETS} presets.`);
  }

  let source = blocks;
  if (cloneFrom) {
    const original = dal.getPromptPreset(cloneFrom, userId);
    if (!original) throw AppError.notFound('Preset to duplicate');
    source = original.blocks;
  }
  if (source !== undefined) assertValid(validateBlocks(source));

  const preset = dal.createPromptPreset(userId, {
    name: name.trim(),
    blocks: normalizeBlocks(source),
  });
  res.status(201).json(preset);
}));

/**
 * PUT /api/presets/:id
 * Body: { name?, blocks? } — partial update.
 */
router.put('/:id', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { name, blocks } = req.body;

  if (name === undefined && blocks === undefined) {
    throw AppError.validation('Nothing to update.');
  }
  if (name !== undefined) assertValid(validateName(name));
  if (blocks !== undefined) assertValid(validateBlocks(blocks));

  const data = {};
  if (name !== undefined) data.name = name.trim();
  if (blocks !== undefined) data.blocks = normalizeBlocks(blocks);

  const preset = dal.updatePromptPreset(req.params.id, userId, data);
  if (!preset) throw AppError.notFound('Preset');
  res.json(preset);
}));

/**
 * DELETE /api/presets/:id
 * The DAL clears the conversation + user-default pointers at it, so anything
 * that used it falls back to the next level down rather than to a dead id.
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const deleted = dal.deletePromptPreset(req.params.id, req.user.userId);
  if (!deleted) throw AppError.notFound('Preset');
  res.json({ success: true });
}));

module.exports = router;
