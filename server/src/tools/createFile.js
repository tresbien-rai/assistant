/**
 * create_file Executor (Track A, P2-03)
 *
 * Writes model-authored text content to the user's Google Drive and records
 * it, so the user can download it from the conversation.
 *
 * Destination (decision 1 in docs/PHASE2_TASKS.md):
 *   active project folder → active workspace folder → Tessera/Downloads/
 * recorded in project_files / workspace_files / user_files respectively.
 *
 * Semantics (decision 6):
 * - The FILENAME EXTENSION is validated against the same allow-list as user
 *   uploads (config.projectFiles.acceptedExtensions); mime_type is advisory.
 * - Content is a UTF-8 string capped at config.projectFiles.maxFileBytes.
 * - A duplicate filename in the destination scope is OVERWRITTEN: the new
 *   bytes are uploaded first, the row is repointed (keeping its id, so
 *   existing download links serve the new content), then the old Drive file
 *   is deleted best-effort.
 *
 * Returns { content, isError?, display? }: `content` is what the model reads;
 * `display` extras (fileId, url, destination) merge into the tool event the
 * frontend renders as a chip/attachment (P2-05b).
 *
 * Validation failures RETURN isError results (the model can correct itself);
 * unexpected failures (Drive down, etc.) THROW and the loop converts them.
 */

const path = require('node:path');

const config = require('../config');
const { isTextAuthorableExtension } = require('../utils/fileUploads');
const { formatFileSize } = require('../utils/format');
const { resolveFileStore, resolveToolDriveAuth } = require('./fileStore');
const { writeContentToStore } = require('./storeWriter');
const { logger } = require('../utils/logger');

// A well-formed `type/subtype` MIME (RFC 2045 token chars only). Anything with
// a CR/LF, space, or `;` fails — this is what keeps a model-supplied mime_type
// out of the response Content-Type header downstream (files.js), where a raw
// newline would otherwise throw ERR_INVALID_CHAR on download.
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;

// Extension → MIME for common text types; fallback text/plain. mime_type from
// the model wins when provided (advisory but usually right).
const MIME_BY_EXTENSION = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

/**
 * Validate the filename: non-empty, no path tricks, allow-listed extension.
 * @param {*} filename
 * @returns {{ok: true, ext: string, name: string} | {ok: false, reason: string}}
 */
function validateFilename(filename) {
  if (typeof filename !== 'string' || !filename.trim()) {
    return { ok: false, reason: 'filename is required.' };
  }
  const name = filename.trim();
  if (name.length > 200) {
    return { ok: false, reason: 'filename is too long (max 200 characters).' };
  }
  // No folders, no traversal, no control characters — Drive has no real
  // paths, but the name is echoed into queries, headers, and the UI.
  if (/[/\\]/.test(name) || name.includes('..') || /[\u0000-\u001f]/.test(name)) {
    return { ok: false, reason: 'filename must be a plain file name without folders or path separators.' };
  }
  const ext = path.extname(name).toLowerCase();
  if (!ext) {
    return { ok: false, reason: 'filename needs a text-type extension, e.g. "notes.md" or "data.csv".' };
  }
  if (!isTextAuthorableExtension(ext)) {
    return { ok: false, reason: `the "${ext}" extension is not supported. Use a text-based type like .md, .txt, .csv, or a code extension.` };
  }
  return { ok: true, ext, name };
}

/**
 * Resolve the MIME type: a well-formed model-supplied mime_type wins; otherwise
 * derive from the extension; else text/plain. A malformed value (spaces, `;`,
 * CR/LF — e.g. a header-injection attempt) is dropped, never stored.
 * @param {*} inputMime
 * @param {string} ext - lowercased extension incl. leading dot
 * @returns {string}
 */
function resolveMime(inputMime, ext) {
  if (typeof inputMime === 'string') {
    const m = inputMime.trim();
    if (MIME_RE.test(m)) return m;
  }
  return MIME_BY_EXTENSION[ext] || 'text/plain';
}

/**
 * Execute one create_file call.
 * @param {{filename?: string, content?: string, mime_type?: string}} input
 * @param {Object} ctx - ToolContext ({ userId, workspace, project, conversationId })
 * @returns {Promise<{content: string, isError?: boolean, display?: Object}>}
 */
async function executeCreateFile(input, ctx) {
  const check = validateFilename(input.filename);
  if (!check.ok) {
    return { content: `Cannot create the file: ${check.reason}`, isError: true };
  }
  const filename = check.name;

  if (typeof input.content !== 'string') {
    return { content: 'Cannot create the file: content must be a string of the complete file text.', isError: true };
  }
  const bytes = Buffer.from(input.content, 'utf8');
  if (bytes.length > config.projectFiles.maxFileBytes) {
    const mb = config.projectFiles.maxFileBytes / (1024 * 1024);
    return {
      content: `Cannot create the file: content is ${(bytes.length / (1024 * 1024)).toFixed(1)}MB but the limit is ${mb}MB. Split it into smaller files.`,
      isError: true,
    };
  }

  const mimeType = resolveMime(input.mime_type, check.ext);

  // Drive-less users (e.g. dev login) get a readable failure, not a crash.
  const { auth, unavailable } = resolveToolDriveAuth(ctx.userId);
  if (unavailable) return { content: `Cannot create the file: ${unavailable}`, isError: true };

  const store = resolveFileStore(ctx);

  // Overwrite-on-duplicate (decision 6) via the shared write path, which also
  // appends the file_revisions row (FC-02). create_file doesn't hold the prior
  // content, so a fresh file logs as 'create' (all-additions) and a same-name
  // replacement logs as 'overwrite' — storeWriter derives the op.
  const { record, overwritten } = await writeContentToStore(auth, store, {
    filename,
    mimeType,
    bytes,
    userId: ctx.userId,
    revision: { author: 'model', conversationId: ctx.conversationId || null },
  });

  const url = store.urlFor(record.id);
  const sizeLabel = formatFileSize(bytes.length);

  logger.info(
    { userId: ctx.userId, destination: store.kind, fileId: record.id, sizeBytes: bytes.length, overwritten },
    'create_file executed'
  );

  return {
    content: `${overwritten ? 'Updated' : 'Created'} "${filename}" (${sizeLabel}, ${mimeType}) in ${store.label}. The user can download it at ${url} — you can reference this link in your reply as a markdown link.`,
    display: {
      fileId: record.id,
      url,
      destination: store.kind,
      sizeBytes: bytes.length,
      mimeType,
      overwritten,
    },
  };
}

module.exports = { executeCreateFile, _validateFilename: validateFilename };
