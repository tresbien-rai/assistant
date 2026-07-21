/**
 * User Files Routes (Track A, P2-03)
 *
 * Serves tool-created files that live in the user's `Tessera/Downloads/`
 * Drive folder (recorded in `user_files`). Project and workspace files keep
 * their existing container-scoped content endpoints; this is the equivalent
 * for the container-less "unfiled chat" case.
 *
 * Endpoints:
 * - GET /api/files            - List the user's Downloads files (metadata)
 * - GET /api/files/:id/content - Stream a file's bytes (download)
 * - PUT /api/files/:id/content - Replace a file's text (file-panel Save)
 *
 * Authentication is applied at the index.js mount level.
 */

const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const dal = require('../db/dal');
const drive = require('../utils/drive');
const AppError = require('../utils/AppError');
const { resolveFileStore } = require('../tools/fileStore');
const { saveTextOverFile } = require('../tools/storeWriter');
const { formatFileRevision } = require('../utils/format');

const router = express.Router();

/**
 * Format a user_files record for API response (snake_case → camelCase).
 * @param {Object} file - user_files row
 * @returns {Object}
 */
function formatFile(file) {
  return {
    id: file.id,
    filename: file.filename,
    mimeType: file.mime_type,
    sizeBytes: file.size_bytes,
    createdAt: file.created_at,
  };
}

/**
 * GET /api/files
 * List the user's Downloads files (metadata only, no Drive calls).
 */
router.get('/', asyncHandler(async (req, res) => {
  const files = dal.listUserFiles(req.user.userId);
  res.json(files.map(formatFile));
}));

/**
 * GET /api/files/:id/content
 * Stream a Downloads file's bytes with a download disposition, mirroring the
 * project/workspace content endpoints so the URL works as an <a href download>.
 */
router.get('/:id/content', asyncHandler(async (req, res) => {
  const file = dal.getUserFile(req.params.id, req.user.userId);
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
 * PUT /api/files/:id/content
 * Replace a Downloads file's text with user-edited content (the file panel's
 * Save). Body: { content: string }. Same write path as the file tools, so
 * the row id (and download URL) stays stable and read_file sees the new text.
 */
router.put('/:id/content', asyncHandler(async (req, res) => {
  const file = dal.getUserFile(req.params.id, req.user.userId);
  if (!file || !file.drive_file_id) {
    throw AppError.notFound('File');
  }

  const auth = drive.getAuthForUser(req.user.userId);
  const store = resolveFileStore({ userId: req.user.userId, project: null, workspace: null });
  // Log the edit as a user-authored revision (FC-04); no chat context here.
  const result = await saveTextOverFile(auth, store, file, req.body?.content, req.user.userId, {});
  if (!result.ok) {
    throw AppError.validation(result.reason);
  }
  res.json(formatFile(result.record));
}));

/**
 * GET /api/files/:id/revisions
 * A Downloads file's change history (File Collaboration, FC-04).
 */
router.get('/:id/revisions', asyncHandler(async (req, res) => {
  const file = dal.getUserFile(req.params.id, req.user.userId);
  if (!file) {
    throw AppError.notFound('File');
  }
  const revisions = dal.listFileRevisions('downloads', req.params.id);
  res.json(revisions.map(formatFileRevision));
}));

module.exports = router;
