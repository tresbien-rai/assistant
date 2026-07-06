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
 *
 * Authentication is applied at the index.js mount level.
 */

const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const dal = require('../db/dal');
const drive = require('../utils/drive');
const AppError = require('../utils/AppError');

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

module.exports = router;
