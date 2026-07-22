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

/**
 * Whether a file with this extension can be authored/edited as a text string
 * by the file tools. PDFs are accepted as USER uploads (readable via
 * read_file's extraction) but cannot be written from text — the single
 * policy shared by create_file and edit_file.
 * @param {string} ext - lowercased extension including the leading dot
 * @returns {boolean}
 */
function isTextAuthorableExtension(ext) {
  return ext !== '.pdf' && ACCEPTED_EXTENSIONS.has(ext);
}

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
 * Recover UTF-8 filenames mangled by multipart parsing.
 *
 * multer/busboy decodes the multipart `filename` field as latin1, so any name
 * with non-ASCII characters (Korean, accented Latin, etc.) arrives as mojibake.
 * Browsers actually send the raw UTF-8 bytes, so re-decoding latin1→utf8
 * recovers the original name; pure-ASCII names round-trip unchanged. Run this
 * immediately after `upload.single(...)`, before the filename is stored or sent
 * on to Drive. Placed before `handleUploadError` in the chain so it is skipped
 * (as a normal 3-arg middleware) when multer itself errored.
 */
function fixUploadedFilename(req, res, next) {
  const decode = (name) =>
    typeof name === 'string' ? Buffer.from(name, 'latin1').toString('utf8') : name;
  if (req.file) {
    req.file.originalname = decode(req.file.originalname);
  }
  if (Array.isArray(req.files)) {
    for (const f of req.files) f.originalname = decode(f.originalname);
  }
  next();
}

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

module.exports = { upload, fixUploadedFilename, handleUploadError, ACCEPTED_EXTENSIONS, isTextAuthorableExtension };
