/**
 * Personas Routes
 *
 * REST API endpoints for persona management.
 * A persona defines an AI character's name, system prompt, prefill, avatar,
 * expression set, and model configuration.
 *
 * Endpoints:
 * - GET    /api/personas      - List all personas for the user
 * - GET    /api/personas/:id  - Get a single persona
 * - POST   /api/personas      - Create a new persona
 * - PUT    /api/personas/:id  - Update a persona
 * - DELETE /api/personas/:id  - Delete a persona (cascades to conversations)
 */

const express = require('express');
const dal = require('../db/dal');
const { authenticate } = require('../middleware/authenticate');
const { asyncHandler } = require('../middleware/errorHandler');
const AppError = require('../utils/AppError');

const router = express.Router();

// Display-field caps. These are card-layout budgets, not data limits — a
// tagline that wraps to three lines breaks the tile grid, so we trim rather
// than reject (the client counts down to the same numbers).
const TAGLINE_MAX = 80;
const ROLE_LABEL_MAX = 24;

// All routes require authentication
router.use(authenticate);

/**
 * Validate + normalize one of the short display strings (tagline, roleLabel):
 * must be a string, trimmed, and truncated to `max`.
 * @param {*} value - Raw value from the request body
 * @param {string} field - Field name, for the error message
 * @param {number} max - Maximum length after trimming
 * @returns {string} The normalized value
 */
function normalizeDisplayField(value, field, max) {
  if (typeof value !== 'string') {
    throw AppError.validation(`${field} must be a string`);
  }
  return value.trim().slice(0, max);
}

/**
 * Format a persona record for API response
 * Converts snake_case DB fields to camelCase
 * @param {Object} persona - Persona record from DAL (with parsed JSON fields)
 * @returns {Object} Formatted persona object
 */
function formatPersona(persona) {
  return {
    id: persona.id,
    userId: persona.user_id,
    name: persona.name,
    tagline: persona.tagline || '',
    roleLabel: persona.role_label || '',
    systemPrompt: persona.system_prompt,
    prefill: persona.prefill,
    avatarFilename: persona.avatar_filename,
    expressions: persona.expressions,
    modelConfig: persona.modelConfig,
    createdAt: persona.created_at,
    updatedAt: persona.updated_at,
  };
}

/**
 * GET /api/personas
 * Returns all personas for the authenticated user, ordered by updatedAt desc.
 */
router.get('/', asyncHandler(async (req, res) => {
  const personas = dal.getPersonasByUser(req.user.userId);
  res.json(personas.map(formatPersona));
}));

/**
 * GET /api/personas/:id
 * Returns a single persona (only if owned by user).
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const persona = dal.getPersonaById(req.params.id, req.user.userId);

  if (!persona) {
    throw AppError.notFound('Persona');
  }

  res.json(formatPersona(persona));
}));

/**
 * POST /api/personas
 * Body: { name, systemPrompt?, prefill?, expressions?, modelConfig? }
 * Creates a persona linked to the authenticated user.
 */
router.post('/', asyncHandler(async (req, res) => {
  const { name, tagline, roleLabel, systemPrompt, prefill, expressions, modelConfig } = req.body;

  if (!name || typeof name !== 'string' || name.trim() === '') {
    throw AppError.validation('Name is required');
  }

  if (systemPrompt !== undefined && typeof systemPrompt !== 'string') {
    throw AppError.validation('systemPrompt must be a string');
  }
  if (prefill !== undefined && typeof prefill !== 'string') {
    throw AppError.validation('prefill must be a string');
  }
  if (expressions !== undefined && (typeof expressions !== 'object' || Array.isArray(expressions) || expressions === null)) {
    throw AppError.validation('expressions must be an object');
  }
  if (modelConfig !== undefined && (typeof modelConfig !== 'object' || Array.isArray(modelConfig) || modelConfig === null)) {
    throw AppError.validation('modelConfig must be an object');
  }

  const persona = dal.createPersona(req.user.userId, {
    name: name.trim(),
    tagline: tagline === undefined ? '' : normalizeDisplayField(tagline, 'tagline', TAGLINE_MAX),
    roleLabel: roleLabel === undefined ? '' : normalizeDisplayField(roleLabel, 'roleLabel', ROLE_LABEL_MAX),
    systemPrompt,
    prefill,
    expressions,
    modelConfig,
  });

  res.status(201).json(formatPersona(persona));
}));

/**
 * PUT /api/personas/:id
 * Body: partial update fields
 * Updates persona (only if owned by user) and bumps updatedAt.
 */
router.put('/:id', asyncHandler(async (req, res) => {
  const { name, tagline, roleLabel, systemPrompt, prefill, avatarFilename, expressions, modelConfig } = req.body;
  const updateData = {};

  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw AppError.validation('Name must be a non-empty string');
    }
    updateData.name = name.trim();
  }
  if (tagline !== undefined) {
    updateData.tagline = normalizeDisplayField(tagline, 'tagline', TAGLINE_MAX);
  }
  if (roleLabel !== undefined) {
    updateData.roleLabel = normalizeDisplayField(roleLabel, 'roleLabel', ROLE_LABEL_MAX);
  }
  if (systemPrompt !== undefined) {
    if (typeof systemPrompt !== 'string') {
      throw AppError.validation('systemPrompt must be a string');
    }
    updateData.systemPrompt = systemPrompt;
  }
  if (prefill !== undefined) {
    if (typeof prefill !== 'string') {
      throw AppError.validation('prefill must be a string');
    }
    updateData.prefill = prefill;
  }
  if (avatarFilename !== undefined) {
    if (typeof avatarFilename !== 'string') {
      throw AppError.validation('avatarFilename must be a string');
    }
    updateData.avatarFilename = avatarFilename;
  }
  if (expressions !== undefined) {
    if (typeof expressions !== 'object' || Array.isArray(expressions) || expressions === null) {
      throw AppError.validation('expressions must be an object');
    }
    updateData.expressions = expressions;
  }
  if (modelConfig !== undefined) {
    if (typeof modelConfig !== 'object' || Array.isArray(modelConfig) || modelConfig === null) {
      throw AppError.validation('modelConfig must be an object');
    }
    updateData.modelConfig = modelConfig;
  }

  const persona = dal.updatePersona(req.params.id, req.user.userId, updateData);

  if (!persona) {
    throw AppError.notFound('Persona');
  }

  res.json(formatPersona(persona));
}));

/**
 * DELETE /api/personas/:id
 * Deletes a persona and cascades to its conversations + messages.
 * Refuses to delete if it's the user's only persona.
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  // Verify the persona exists and belongs to the user before counting
  const persona = dal.getPersonaById(req.params.id, req.user.userId);
  if (!persona) {
    throw AppError.notFound('Persona');
  }

  // Block deleting the only persona, surfacing it as a 400 VALIDATION_ERROR
  const count = dal.countPersonasByUser(req.user.userId);
  if (count <= 1) {
    throw AppError.validation('Cannot delete the last remaining persona');
  }

  const deleted = dal.deletePersona(req.params.id, req.user.userId);

  if (!deleted) {
    throw AppError.notFound('Persona');
  }

  res.json({ deleted: true });
}));

module.exports = router;
