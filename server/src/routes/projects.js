/**
 * Projects Routes (Phase 1)
 *
 * A project bundles instructions + files that get injected as context into any
 * conversation assigned to it (independent of persona). Files live on the user's
 * Google Drive under `AI Assistant/projects/{name}`; SQLite stores only metadata
 * + Drive file IDs.
 *
 * Project CRUD:
 * - GET    /api/projects            - List the user's projects (with file counts)
 * - POST   /api/projects            - Create a project (+ its Drive folder)
 * - GET    /api/projects/:id        - Get a single project
 * - PUT    /api/projects/:id        - Update name/instructions
 * - DELETE /api/projects/:id        - Delete project (+ trash its Drive folder)
 *
 * Project files:
 * - GET    /api/projects/:id/files            - List files (from SQLite)
 * - POST   /api/projects/:id/files            - Upload a file to Drive (+ record)
 * - DELETE /api/projects/:id/files/:fileId    - Delete from Drive + DB
 */

const path = require('node:path');
const express = require('express');
const multer = require('multer');

const config = require('../config');
const dal = require('../db/dal');
const drive = require('../utils/drive');
const { authenticate } = require('../middleware/authenticate');
const { asyncHandler } = require('../middleware/errorHandler');
const AppError = require('../utils/AppError');
const { logger } = require('../utils/logger');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Field length caps (DB columns are TEXT; these keep input sane)
const MAX_NAME_LENGTH = 100;
const MAX_INSTRUCTIONS_LENGTH = 16000;

// Accepted upload extensions as a lowercase Set for O(1) lookup.
const ACCEPTED_EXTENSIONS = new Set(config.projectFiles.acceptedExtensions);

// =============================================================================
// MULTER (in-memory — file bytes are forwarded straight to Drive, not to disk)
// =============================================================================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.projectFiles.maxFileBytes },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ACCEPTED_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      cb(AppError.validation(
        `Unsupported file type "${ext || file.originalname}". Allowed: text, code, and PDF files.`
      ));
    }
  },
});

/**
 * Translate multer errors (file too large, etc.) into AppErrors.
 */
function handleUploadError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const mb = config.projectFiles.maxFileBytes / (1024 * 1024);
      return next(AppError.validation(`File too large. Maximum size is ${mb}MB.`));
    }
    return next(AppError.validation(`Upload error: ${err.message}`));
  }
  // AppError (from fileFilter) or anything else: pass through.
  return next(err);
}

// =============================================================================
// FORMATTERS (snake_case DB rows -> camelCase API; hide internal Drive IDs)
// =============================================================================

function formatProject(p) {
  const formatted = {
    id: p.id,
    userId: p.user_id,
    name: p.name,
    instructions: p.instructions,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
  if (p.file_count !== undefined) {
    formatted.fileCount = p.file_count;
  }
  return formatted;
}

function formatFile(f) {
  return {
    id: f.id,
    projectId: f.project_id,
    filename: f.filename,
    mimeType: f.mime_type,
    sizeBytes: f.size_bytes,
    createdAt: f.created_at,
  };
}

/**
 * Load a project owned by the user, or throw NOT_FOUND.
 * @param {string} projectId
 * @param {string} userId
 * @returns {Object} The project row
 */
function requireProject(projectId, userId) {
  const project = dal.getProjectById(projectId, userId);
  if (!project) {
    throw AppError.notFound('Project');
  }
  return project;
}

/**
 * Validate and normalize a project name.
 * @param {*} name
 * @returns {string}
 */
function validateName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    throw AppError.validation('Project name is required');
  }
  const trimmed = name.trim();
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw AppError.validation(`Project name must be ${MAX_NAME_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

/**
 * Validate project instructions (optional).
 * @param {*} instructions
 * @returns {string}
 */
function validateInstructions(instructions) {
  if (typeof instructions !== 'string') {
    throw AppError.validation('Instructions must be a string');
  }
  if (instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    throw AppError.validation(`Instructions must be ${MAX_INSTRUCTIONS_LENGTH} characters or fewer.`);
  }
  return instructions;
}

// =============================================================================
// PROJECT CRUD
// =============================================================================

/**
 * GET /api/projects
 * List the user's projects, newest first, with file counts.
 */
router.get('/', asyncHandler(async (req, res) => {
  const projects = dal.listProjectsByUser(req.user.userId);
  res.json(projects.map(formatProject));
}));

/**
 * POST /api/projects
 * Create a project and its backing Drive folder.
 * Body: { name, instructions? }
 */
router.post('/', asyncHandler(async (req, res) => {
  const name = validateName(req.body.name);
  const instructions = req.body.instructions !== undefined
    ? validateInstructions(req.body.instructions)
    : '';

  // Create the Drive folder first so we can persist its id atomically with the
  // project row. getAuthForUser throws DRIVE_ERROR if Drive isn't connected.
  const auth = drive.getAuthForUser(req.user.userId);
  const { projectsId } = await drive.ensureAppFolders(auth);
  const driveFolderId = await drive.createFolder(auth, name, projectsId);

  const project = dal.createProject(req.user.userId, { name, instructions, driveFolderId });

  logger.info({ userId: req.user.userId, projectId: project.id }, 'Project created');
  res.status(201).json(formatProject(project));
}));

/**
 * GET /api/projects/:id
 * Get a single project's metadata.
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const project = requireProject(req.params.id, req.user.userId);
  res.json(formatProject(project));
}));

/**
 * PUT /api/projects/:id
 * Update name and/or instructions. Does NOT rename the Drive folder — it is an
 * internal, ID-addressed storage detail the user never browses by name.
 * Body: { name?, instructions? }
 */
router.put('/:id', asyncHandler(async (req, res) => {
  const updateData = {};
  if (req.body.name !== undefined) {
    updateData.name = validateName(req.body.name);
  }
  if (req.body.instructions !== undefined) {
    updateData.instructions = validateInstructions(req.body.instructions);
  }

  const project = dal.updateProject(req.params.id, req.user.userId, updateData);
  if (!project) {
    throw AppError.notFound('Project');
  }
  res.json(formatProject(project));
}));

/**
 * DELETE /api/projects/:id
 * Delete the project (DB rows cascade to project_files) and move its Drive
 * folder to the trash (recoverable). Trashing is best-effort: a Drive failure
 * must not strand the user with an undeletable project.
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const project = requireProject(req.params.id, req.user.userId);

  if (project.drive_folder_id) {
    try {
      const auth = drive.getAuthForUser(req.user.userId);
      await drive.trashFile(auth, project.drive_folder_id);
    } catch (err) {
      logger.warn(
        { userId: req.user.userId, projectId: project.id, code: err.code },
        'Could not trash project Drive folder during delete; removing DB rows anyway'
      );
    }
  }

  dal.deleteProject(req.params.id, req.user.userId);

  logger.info({ userId: req.user.userId, projectId: project.id }, 'Project deleted');
  res.json({ deleted: true });
}));

// =============================================================================
// PROJECT FILES
// =============================================================================

/**
 * GET /api/projects/:id/files
 * List a project's files from SQLite (no Drive calls).
 */
router.get('/:id/files', asyncHandler(async (req, res) => {
  requireProject(req.params.id, req.user.userId);
  const files = dal.listProjectFiles(req.params.id);
  res.json(files.map(formatFile));
}));

/**
 * POST /api/projects/:id/files
 * Upload a file (multipart field "file") to the project's Drive folder and
 * record its metadata.
 */
router.post('/:id/files', upload.single('file'), handleUploadError, asyncHandler(async (req, res) => {
  const project = requireProject(req.params.id, req.user.userId);

  if (!req.file) {
    throw AppError.validation('No file provided. Send a file in the "file" field.');
  }

  const auth = drive.getAuthForUser(req.user.userId);

  // Self-heal: a project should always have a folder, but recreate it if the id
  // is missing (e.g. an earlier create that failed after the DB insert).
  let folderId = project.drive_folder_id;
  if (!folderId) {
    const { projectsId } = await drive.ensureAppFolders(auth);
    folderId = await drive.createFolder(auth, project.name, projectsId);
    dal.updateProject(project.id, req.user.userId, { driveFolderId: folderId });
  }

  const uploaded = await drive.uploadFile(auth, {
    name: req.file.originalname,
    mimeType: req.file.mimetype,
    parentId: folderId,
    data: req.file.buffer,
  });

  const fileRecord = dal.addProjectFile(project.id, {
    filename: req.file.originalname,
    mimeType: req.file.mimetype,
    sizeBytes: req.file.size,
    driveFileId: uploaded.id,
  });

  logger.info(
    { userId: req.user.userId, projectId: project.id, fileId: fileRecord.id },
    'Project file uploaded'
  );
  res.status(201).json(formatFile(fileRecord));
}));

/**
 * DELETE /api/projects/:id/files/:fileId
 * Delete a file from Drive and remove its metadata row. Drive deletion is
 * best-effort so a Drive failure does not strand an undeletable file.
 */
router.delete('/:id/files/:fileId', asyncHandler(async (req, res) => {
  requireProject(req.params.id, req.user.userId);

  const file = dal.getProjectFile(req.params.fileId, req.params.id);
  if (!file) {
    throw AppError.notFound('File');
  }

  if (file.drive_file_id) {
    try {
      const auth = drive.getAuthForUser(req.user.userId);
      await drive.deleteFile(auth, file.drive_file_id);
    } catch (err) {
      logger.warn(
        { userId: req.user.userId, fileId: file.id, code: err.code },
        'Could not delete file from Drive; removing DB row anyway'
      );
    }
  }

  dal.deleteProjectFile(req.params.fileId, req.params.id);

  logger.info({ userId: req.user.userId, projectId: req.params.id, fileId: file.id }, 'Project file deleted');
  res.json({ deleted: true });
}));

module.exports = router;
