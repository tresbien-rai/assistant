/**
 * Avatar Routes
 *
 * Handles avatar and expression image upload, serving, and deletion.
 * Images are stored on the server filesystem at server/data/avatars/.
 *
 * Upload/delete endpoints (require auth):
 * - POST   /api/personas/:id/avatar                    - Upload main avatar
 * - DELETE /api/personas/:id/avatar                    - Remove main avatar
 * - POST   /api/personas/:id/expressions/:name/image   - Upload expression image
 * - DELETE /api/personas/:id/expressions/:name/image   - Remove expression image
 *
 * Serving endpoints (require auth):
 * - GET /api/avatars/:personaId/avatar                 - Serve avatar image
 * - GET /api/avatars/:personaId/expressions/:name      - Serve expression image
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const dal = require('../db/dal');
const { authenticate } = require('../middleware/authenticate');
const { asyncHandler } = require('../middleware/errorHandler');
const AppError = require('../utils/AppError');
const { logger } = require('../utils/logger');

// =============================================================================
// CONFIGURATION
// =============================================================================

const AVATARS_DIR = path.resolve(__dirname, '../../data/avatars');

// Ensure the avatars directory exists. multer's diskStorage does NOT create
// its destination, so an upload would fail with ENOENT (500) if it's missing.
// This matters in production: Railway mounts the persistent Volume at
// server/data, which shadows the repo's committed data/avatars/.gitkeep, so the
// subdirectory does not exist at boot until we create it here.
try {
  fs.mkdirSync(AVATARS_DIR, { recursive: true });
} catch (err) {
  logger.error({ err, dir: AVATARS_DIR }, 'Failed to ensure avatars directory exists');
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
];

// Map MIME types to file extensions
const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// =============================================================================
// MULTER SETUP
// =============================================================================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, AVATARS_DIR);
  },
  filename: (req, file, cb) => {
    // Temporary filename — will be renamed after validation
    const ext = MIME_TO_EXT[file.mimetype] || path.extname(file.originalname);
    cb(null, `tmp_${Date.now()}${ext}`);
  },
});

function fileFilter(req, file, cb) {
  if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new AppError(400, 'VALIDATION_ERROR', `Invalid file type: ${file.mimetype}. Only image files are allowed.`));
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE },
});

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get the avatar filename for a persona
 * @param {string} personaId
 * @param {string} ext - File extension including dot
 * @returns {string} Filename like "{personaId}_avatar.jpg"
 */
function avatarFilename(personaId, ext) {
  return `${personaId}_avatar${ext}`;
}

/**
 * Get the expression image filename
 * @param {string} personaId
 * @param {string} expressionName
 * @param {string} ext - File extension including dot
 * @returns {string} Filename like "{personaId}_expr_{name}.jpg"
 */
function expressionFilename(personaId, expressionName, ext) {
  return `${personaId}_expr_${expressionName}${ext}`;
}

/**
 * Find an existing file by its base name pattern (ignoring extension).
 * Used when we need to find/delete a file but don't know the extension.
 * @param {string} basePattern - Pattern like "{personaId}_avatar" or "{personaId}_expr_{name}"
 * @returns {string|null} Full path to the file, or null
 */
function findFileByPattern(basePattern) {
  try {
    const files = fs.readdirSync(AVATARS_DIR);
    const match = files.find(f => {
      const nameWithoutExt = f.substring(0, f.lastIndexOf('.'));
      return nameWithoutExt === basePattern;
    });
    return match ? path.join(AVATARS_DIR, match) : null;
  } catch {
    return null;
  }
}

/**
 * Delete a file if it exists (no error if missing)
 * @param {string} filePath
 */
function safeDelete(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn({ err, filePath }, 'Failed to delete avatar file');
    }
  }
}

/**
 * Verify a resolved file path is inside AVATARS_DIR (path traversal guard)
 * @param {string} filePath - Resolved file path to check
 * @throws {AppError} If path escapes the avatars directory
 */
function assertInsideAvatarsDir(filePath) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(AVATARS_DIR + path.sep) && resolved !== AVATARS_DIR) {
    logger.warn({ filePath, resolved, AVATARS_DIR }, 'Path traversal attempt blocked');
    throw AppError.notFound('Avatar');
  }
}

/**
 * Validate expression name (alphanumeric, hyphens, underscores)
 * @param {string} name
 * @throws {AppError} If name is invalid
 */
function validateExpressionName(name) {
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw AppError.validation('Expression name must contain only letters, numbers, hyphens, and underscores.');
  }
  if (name.length > 50) {
    throw AppError.validation('Expression name must be 50 characters or fewer.');
  }
}

/**
 * Handle multer errors with AppError
 */
function handleMulterError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(AppError.validation(`File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)}MB.`));
    }
    return next(AppError.validation(`Upload error: ${err.message}`));
  }
  if (err instanceof AppError) {
    return next(err);
  }
  next(err);
}

// =============================================================================
// UPLOAD / DELETE ROUTES (mounted at /api/personas)
// =============================================================================

const personaRouter = express.Router();
personaRouter.use(authenticate);

/**
 * POST /api/personas/:id/avatar
 * Upload or replace the main avatar image for a persona
 */
personaRouter.post('/:id/avatar', upload.single('avatar'), handleMulterError, asyncHandler(async (req, res) => {
  const { id: personaId } = req.params;
  const userId = req.user.userId;

  // Verify persona ownership
  const persona = dal.getPersonaById(personaId, userId);
  if (!persona) {
    // Clean up uploaded temp file
    if (req.file) safeDelete(req.file.path);
    throw AppError.notFound('Persona');
  }

  if (!req.file) {
    throw AppError.validation('No image file provided. Send a file in the "avatar" field.');
  }

  const ext = MIME_TO_EXT[req.file.mimetype] || path.extname(req.file.originalname);
  const finalName = avatarFilename(personaId, ext);
  const finalPath = path.join(AVATARS_DIR, finalName);

  // Delete any existing avatar (might have different extension)
  const existingBase = `${personaId}_avatar`;
  const existingPath = findFileByPattern(existingBase);
  if (existingPath && existingPath !== finalPath) {
    safeDelete(existingPath);
  }

  // Rename temp file to final name
  fs.renameSync(req.file.path, finalPath);

  // Update database
  dal.updatePersona(personaId, userId, { avatarFilename: finalName });

  logger.info({ personaId, filename: finalName }, 'Avatar uploaded');

  res.json({
    avatarUrl: `/api/avatars/${personaId}/avatar`,
  });
}));

/**
 * DELETE /api/personas/:id/avatar
 * Remove the main avatar image
 */
personaRouter.delete('/:id/avatar', asyncHandler(async (req, res) => {
  const { id: personaId } = req.params;
  const userId = req.user.userId;

  const persona = dal.getPersonaById(personaId, userId);
  if (!persona) {
    throw AppError.notFound('Persona');
  }

  // Find and delete the avatar file
  const existingPath = findFileByPattern(`${personaId}_avatar`);
  if (existingPath) {
    safeDelete(existingPath);
  }

  // Clear filename in database
  dal.updatePersona(personaId, userId, { avatarFilename: '' });

  logger.info({ personaId }, 'Avatar deleted');

  res.json({ deleted: true });
}));

/**
 * POST /api/personas/:id/expressions/:name/image
 * Upload or replace an expression image
 */
personaRouter.post('/:id/expressions/:name/image', upload.single('image'), handleMulterError, asyncHandler(async (req, res) => {
  const { id: personaId, name: exprName } = req.params;
  const userId = req.user.userId;

  validateExpressionName(exprName);

  const persona = dal.getPersonaById(personaId, userId);
  if (!persona) {
    if (req.file) safeDelete(req.file.path);
    throw AppError.notFound('Persona');
  }

  if (!req.file) {
    throw AppError.validation('No image file provided. Send a file in the "image" field.');
  }

  const ext = MIME_TO_EXT[req.file.mimetype] || path.extname(req.file.originalname);
  const finalName = expressionFilename(personaId, exprName, ext);
  const finalPath = path.join(AVATARS_DIR, finalName);

  // Delete any existing expression image (might have different extension)
  const existingBase = `${personaId}_expr_${exprName}`;
  const existingPath = findFileByPattern(existingBase);
  if (existingPath && existingPath !== finalPath) {
    safeDelete(existingPath);
  }

  // Rename temp file to final name
  fs.renameSync(req.file.path, finalPath);

  // Update expression's imageKey in persona's expressions JSON
  const expressions = persona.expressions || {};
  if (!expressions[exprName]) {
    expressions[exprName] = {};
  }
  expressions[exprName].imageKey = finalName;
  dal.updatePersona(personaId, userId, { expressions });

  logger.info({ personaId, expression: exprName, filename: finalName }, 'Expression image uploaded');

  res.json({
    imageUrl: `/api/avatars/${personaId}/expressions/${exprName}`,
  });
}));

/**
 * DELETE /api/personas/:id/expressions/:name/image
 * Remove an expression image
 */
personaRouter.delete('/:id/expressions/:name/image', asyncHandler(async (req, res) => {
  const { id: personaId, name: exprName } = req.params;
  const userId = req.user.userId;

  validateExpressionName(exprName);

  const persona = dal.getPersonaById(personaId, userId);
  if (!persona) {
    throw AppError.notFound('Persona');
  }

  // Find and delete the expression image file
  const existingPath = findFileByPattern(`${personaId}_expr_${exprName}`);
  if (existingPath) {
    safeDelete(existingPath);
  }

  // Clear imageKey in expression JSON
  const expressions = persona.expressions || {};
  if (expressions[exprName]) {
    expressions[exprName].imageKey = '';
    dal.updatePersona(personaId, userId, { expressions });
  }

  logger.info({ personaId, expression: exprName }, 'Expression image deleted');

  res.json({ deleted: true });
}));

// =============================================================================
// SERVING ROUTES (mounted at /api/avatars)
// =============================================================================

const servingRouter = express.Router();
servingRouter.use(authenticate);

/**
 * GET /api/avatars/:personaId/avatar
 * Serve the main avatar image
 */
servingRouter.get('/:personaId/avatar', asyncHandler(async (req, res) => {
  const { personaId } = req.params;
  const userId = req.user.userId;

  // Verify persona ownership
  const persona = dal.getPersonaById(personaId, userId);
  if (!persona) {
    throw AppError.notFound('Persona');
  }

  if (!persona.avatar_filename) {
    throw AppError.notFound('Avatar');
  }

  const filePath = path.join(AVATARS_DIR, persona.avatar_filename);
  assertInsideAvatarsDir(filePath);

  if (!fs.existsSync(filePath)) {
    // Database says there's an avatar but file is missing — clear the stale reference
    dal.updatePersona(personaId, userId, { avatarFilename: '' });
    throw AppError.notFound('Avatar');
  }

  // Cache for 1 hour, revalidate after
  res.set('Cache-Control', 'private, max-age=3600, must-revalidate');
  res.sendFile(filePath);
}));

/**
 * GET /api/avatars/:personaId/expressions/:name
 * Serve an expression image
 */
servingRouter.get('/:personaId/expressions/:name', asyncHandler(async (req, res) => {
  const { personaId, name: exprName } = req.params;
  const userId = req.user.userId;

  validateExpressionName(exprName);

  const persona = dal.getPersonaById(personaId, userId);
  if (!persona) {
    throw AppError.notFound('Persona');
  }

  const expressions = persona.expressions || {};
  const expr = expressions[exprName];

  if (!expr || !expr.imageKey) {
    throw AppError.notFound('Expression image');
  }

  const filePath = path.join(AVATARS_DIR, expr.imageKey);
  assertInsideAvatarsDir(filePath);

  if (!fs.existsSync(filePath)) {
    // Stale reference — clear it
    expressions[exprName].imageKey = '';
    dal.updatePersona(personaId, userId, { expressions });
    throw AppError.notFound('Expression image');
  }

  res.set('Cache-Control', 'private, max-age=3600, must-revalidate');
  res.sendFile(filePath);
}));

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  personaAvatarRouter: personaRouter,
  avatarServingRouter: servingRouter,
};
