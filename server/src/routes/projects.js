/**
 * Projects Routes (Phase 1)
 *
 * A project bundles instructions + files that get injected as context into any
 * conversation assigned to it (independent of persona). Files live on the user's
 * Google Drive under `Tessera/projects/{name}`; SQLite stores only metadata
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

const express = require('express');

const dal = require('../db/dal');
const drive = require('../utils/drive');
const { upload, handleUploadError } = require('../utils/fileUploads');
const { authenticate } = require('../middleware/authenticate');
const { asyncHandler } = require('../middleware/errorHandler');
const AppError = require('../utils/AppError');
const { logger } = require('../utils/logger');
const { resolveFileStore } = require('../tools/fileStore');
const { saveTextOverFile } = require('../tools/storeWriter');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Field length caps (DB columns are TEXT; these keep input sane)
const MAX_NAME_LENGTH = 100;
const MAX_INSTRUCTIONS_LENGTH = 16000;

// =============================================================================
// FORMATTERS (snake_case DB rows -> camelCase API; hide internal Drive IDs)
// =============================================================================

function formatProject(p) {
  const formatted = {
    id: p.id,
    userId: p.user_id,
    workspaceId: p.workspace_id,
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

// Name of the per-user fallback workspace a project lands in when none is given
// (matches the backfill migration). Lets the legacy flat "create project" call
// keep working until the frontend passes an explicit workspaceId (WR-03).
const DEFAULT_WORKSPACE_NAME = 'General';

/**
 * Load a workspace owned by the user, or throw NOT_FOUND. (A project's workspace
 * must be one the caller owns — closes the WR-01 ownership gap on createProject.)
 * @param {string} workspaceId
 * @param {string} userId
 * @returns {Object} The workspace row
 */
function requireWorkspace(workspaceId, userId) {
  const workspace = dal.getWorkspaceById(workspaceId, userId);
  if (!workspace) {
    throw AppError.notFound('Workspace');
  }
  return workspace;
}

/**
 * Resolve the user's default "General" workspace, creating it (and best-effort
 * its Drive folder) if absent. Used when a project is created without an
 * explicit workspace.
 * @param {string} userId
 * @param {import('google-auth-library').OAuth2Client|null} auth - or null if Drive is unavailable
 * @returns {Promise<Object>} The default workspace row
 */
async function getOrCreateDefaultWorkspace(userId, auth) {
  const existing = dal.listWorkspacesByUser(userId).find((w) => w.name === DEFAULT_WORKSPACE_NAME);
  if (existing) return existing;

  let driveFolderId = '';
  if (auth) {
    try {
      driveFolderId = await drive.ensureWorkspaceFolder(auth, DEFAULT_WORKSPACE_NAME);
    } catch (err) {
      logger.warn({ userId, code: err.code }, 'Drive unavailable creating default workspace folder');
    }
  }
  return dal.createWorkspace(userId, { name: DEFAULT_WORKSPACE_NAME, instructions: '', driveFolderId });
}

// The row-aware folder helpers (ensureWorkspaceFolderId / ensureProjectFolderId)
// moved to utils/drive.js in P2-01 so the tool executors can share them.

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
 * Create a project nested under a workspace, plus (best-effort) its Drive folder
 * at `Tessera/<Workspace>/<Project>/`.
 * Body: { name, instructions?, workspaceId? }
 *
 * `workspaceId` is optional for back-compat: an explicit id must be one the user
 * owns; if omitted, the project lands in the user's default "General" workspace
 * (created on demand). Drive folder creation is best-effort — a project is a
 * useful DB container without Drive and self-heals its folder on first upload.
 */
router.post('/', asyncHandler(async (req, res) => {
  const name = validateName(req.body.name);
  const instructions = req.body.instructions !== undefined
    ? validateInstructions(req.body.instructions)
    : '';
  const workspaceId = typeof req.body.workspaceId === 'string' ? req.body.workspaceId : null;

  // Drive is optional here (dev-login has none); resolve auth best-effort.
  let auth = null;
  try {
    auth = drive.getAuthForUser(req.user.userId);
  } catch (err) {
    logger.warn(
      { userId: req.user.userId, code: err.code },
      'Drive unavailable creating project; folder will self-heal on first upload'
    );
  }

  // Own/resolve the workspace before creating the project (closes the WR-01
  // createProject ownership gap).
  const workspace = workspaceId
    ? requireWorkspace(workspaceId, req.user.userId)
    : await getOrCreateDefaultWorkspace(req.user.userId, auth);

  let driveFolderId = '';
  if (auth) {
    try {
      const workspaceFolderId = await drive.ensureWorkspaceFolderId(auth, req.user.userId, workspace);
      driveFolderId = await drive.createFolder(auth, name, workspaceFolderId);
    } catch (err) {
      logger.warn(
        { userId: req.user.userId, workspaceId: workspace.id, code: err.code },
        'Could not create project Drive folder; will self-heal on first upload'
      );
    }
  }

  const project = dal.createProject(req.user.userId, {
    workspaceId: workspace.id,
    name,
    instructions,
    driveFolderId,
  });

  logger.info(
    { userId: req.user.userId, projectId: project.id, workspaceId: workspace.id },
    'Project created'
  );
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
 * GET /api/projects/:id/files/:fileId/content
 * Stream a file's bytes from Drive (for download). Auth via cookie, so it can be
 * used directly as an <a href download>.
 */
router.get('/:id/files/:fileId/content', asyncHandler(async (req, res) => {
  requireProject(req.params.id, req.user.userId);

  const file = dal.getProjectFile(req.params.fileId, req.params.id);
  if (!file || !file.drive_file_id) {
    throw AppError.notFound('File');
  }

  const auth = drive.getAuthForUser(req.user.userId);
  const bytes = await drive.downloadFileBytes(auth, file.drive_file_id);

  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  res.send(bytes);
}));

/**
 * PUT /api/projects/:id/files/:fileId/content
 * Replace a project file's text with user-edited content (the file panel's
 * Save). Body: { content: string }. Same write path as the file tools, so
 * the row id (and download URL) stays stable and read_file sees the new text.
 */
router.put('/:id/files/:fileId/content', asyncHandler(async (req, res) => {
  const project = requireProject(req.params.id, req.user.userId);

  const file = dal.getProjectFile(req.params.fileId, req.params.id);
  if (!file || !file.drive_file_id) {
    throw AppError.notFound('File');
  }

  const auth = drive.getAuthForUser(req.user.userId);
  const store = resolveFileStore({ userId: req.user.userId, project, workspace: null });
  const result = await saveTextOverFile(auth, store, file, req.body?.content, req.user.userId);
  if (!result.ok) {
    throw AppError.validation(result.reason);
  }
  res.json(formatFile(result.record));
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

  // Self-heal: a project should always have a folder, but create it on demand if
  // the id is missing (best-effort create deferred it, or an earlier create
  // failed after the DB insert). Uses the workspace layout Tessera/<WS>/<Proj>/.
  const folderId = await drive.ensureProjectFolderId(auth, req.user.userId, project);

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
