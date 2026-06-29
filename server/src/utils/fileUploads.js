/**
 * Shared file-upload middleware
 *
 * One multer config + error translator used by every route that accepts a
 * user file upload (project files, workspace files). Files are held in memory
 * and forwarded straight to Google Drive, never written to local disk. The
 * accepted types and size cap come from `config.projectFiles` (shared by both
 * project and workspace uploads — same constraints).
 */

const path = require('node:path');
const multer = require('multer');

const config = require('../config');
const AppError = require('./AppError');

// Accepted upload extensions as a lowercase Set for O(1) lookup.
const ACCEPTED_EXTENSIONS = new Set(config.projectFiles.acceptedExtensions);

// In-memory storage — bytes are streamed on to Drive, not persisted to disk.
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

module.exports = { upload, handleUploadError, ACCEPTED_EXTENSIONS };
