/**
 * Workspaces Routes (Workspace Restructure, WR-02a)
 *
 * A workspace is the OUTER container in the hierarchy (workspace ⊃ project ⊃
 * chat). It bundles shared instructions (+ reference files, arriving in WR-02b)
 * that get layered into any conversation under it — before the project context
 * and the persona prompt. Its Drive folder is `Tessera/<Workspace>/`, with each
 * project nested as a subfolder.
 *
 * Workspace CRUD:
 * - GET    /api/workspaces            - List the user's workspaces (+ project counts)
 * - POST   /api/workspaces            - Create a workspace (+ its Drive folder)
 * - GET    /api/workspaces/:id        - Get a single workspace
 * - PUT    /api/workspaces/:id        - Update name/instructions
 * - DELETE /api/workspaces/:id        - Delete (chats reparent to unfiled; projects removed)
 *
 * Nested projects:
 * - GET    /api/workspaces/:id/projects - List the projects in this workspace
 *
 * Projects are created/updated via /api/projects (a project references its
 * workspace by id); listing them per-workspace lives here for the drill-in nav.
 *
 * Drive folder creation is BEST-EFFORT: if Drive isn't connected (e.g. the
 * dev-login stub user), the workspace is still created as a DB container and its
 * folder is self-healed later when a project/file first needs it. This keeps the
 * hierarchy usable — and verifiable via dev-login — without Drive.
 */

const express = require('express');

const dal = require('../db/dal');
const drive = require('../utils/drive');
const { authenticate } = require('../middleware/authenticate');
const { asyncHandler } = require('../middleware/errorHandler');
const AppError = require('../utils/AppError');
const { logger } = require('../utils/logger');

const router = express.Router();

router.use(authenticate);

// Field length caps (mirror projects.js so the two containers validate alike).
const MAX_NAME_LENGTH = 100;
const MAX_INSTRUCTIONS_LENGTH = 16000;

// =============================================================================
// FORMATTER (snake_case DB row -> camelCase API; hide internal Drive id)
// =============================================================================

function formatWorkspace(w) {
  const formatted = {
    id: w.id,
    userId: w.user_id,
    name: w.name,
    instructions: w.instructions,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
  };
  if (w.project_count !== undefined) {
    formatted.projectCount = w.project_count;
  }
  return formatted;
}

// Re-export the project formatter shape for the nested-list endpoint without
// importing the projects router (avoids a route<->route dependency).
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

// =============================================================================
// VALIDATION / LOADERS
// =============================================================================

function validateName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    throw AppError.validation('Workspace name is required');
  }
  const trimmed = name.trim();
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw AppError.validation(`Workspace name must be ${MAX_NAME_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

function validateInstructions(instructions) {
  if (typeof instructions !== 'string') {
    throw AppError.validation('Instructions must be a string');
  }
  if (instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    throw AppError.validation(`Instructions must be ${MAX_INSTRUCTIONS_LENGTH} characters or fewer.`);
  }
  return instructions;
}

/**
 * Load a workspace owned by the user, or throw NOT_FOUND.
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

// =============================================================================
// WORKSPACE CRUD
// =============================================================================

/**
 * GET /api/workspaces
 * List the user's workspaces, newest first, with project counts.
 */
router.get('/', asyncHandler(async (req, res) => {
  const workspaces = dal.listWorkspacesByUser(req.user.userId);
  res.json(workspaces.map(formatWorkspace));
}));

/**
 * POST /api/workspaces
 * Create a workspace and (best-effort) its backing Drive folder.
 * Body: { name, instructions? }
 */
router.post('/', asyncHandler(async (req, res) => {
  const name = validateName(req.body.name);
  const instructions = req.body.instructions !== undefined
    ? validateInstructions(req.body.instructions)
    : '';

  // Best-effort Drive folder: a workspace is a useful DB container even without
  // Drive; the folder is self-healed later (createProject / file upload).
  let driveFolderId = '';
  try {
    const auth = drive.getAuthForUser(req.user.userId);
    driveFolderId = await drive.ensureWorkspaceFolder(auth, name);
  } catch (err) {
    logger.warn(
      { userId: req.user.userId, code: err.code },
      'Drive unavailable creating workspace folder; will self-heal on first project/file'
    );
  }

  const workspace = dal.createWorkspace(req.user.userId, { name, instructions, driveFolderId });

  logger.info({ userId: req.user.userId, workspaceId: workspace.id }, 'Workspace created');
  res.status(201).json(formatWorkspace(workspace));
}));

/**
 * GET /api/workspaces/:id
 * Get a single workspace's metadata.
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const workspace = requireWorkspace(req.params.id, req.user.userId);
  res.json(formatWorkspace(workspace));
}));

/**
 * PUT /api/workspaces/:id
 * Update name and/or instructions. Does NOT rename the Drive folder (an
 * internal, ID-addressed storage detail the user never browses by name).
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

  const workspace = dal.updateWorkspace(req.params.id, req.user.userId, updateData);
  if (!workspace) {
    throw AppError.notFound('Workspace');
  }
  res.json(formatWorkspace(workspace));
}));

/**
 * DELETE /api/workspaces/:id
 * Delete the workspace. Its projects (and their files) are removed; its chats
 * survive as unfiled (handled in the DAL, transactionally). The workspace Drive
 * folder is moved to the trash (recoverable) — trashing the parent also trashes
 * the nested project subfolders and files. Best-effort: a Drive failure must not
 * strand an undeletable workspace.
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const workspace = requireWorkspace(req.params.id, req.user.userId);

  if (workspace.drive_folder_id) {
    try {
      const auth = drive.getAuthForUser(req.user.userId);
      await drive.trashFile(auth, workspace.drive_folder_id);
    } catch (err) {
      logger.warn(
        { userId: req.user.userId, workspaceId: workspace.id, code: err.code },
        'Could not trash workspace Drive folder during delete; removing DB rows anyway'
      );
    }
  }

  dal.deleteWorkspace(req.params.id, req.user.userId);

  logger.info({ userId: req.user.userId, workspaceId: workspace.id }, 'Workspace deleted');
  res.json({ deleted: true });
}));

// =============================================================================
// NESTED PROJECTS (list only — create/update/delete live in /api/projects)
// =============================================================================

/**
 * GET /api/workspaces/:id/projects
 * List the projects nested under this workspace (with file counts).
 */
router.get('/:id/projects', asyncHandler(async (req, res) => {
  requireWorkspace(req.params.id, req.user.userId);
  const projects = dal.listProjectsByWorkspace(req.params.id, req.user.userId);
  res.json(projects.map(formatProject));
}));

module.exports = router;
