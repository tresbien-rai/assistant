/**
 * Shared store write path (file tools + user saves)
 *
 * The ONE way text content is written into a file store — used by the
 * create_file and edit_file executors and by the routes' user-save endpoints
 * (PUT .../content, edit-in-context slice 3). Lives apart from the executors
 * so they stay peers (no executor-to-executor imports), and apart from
 * fileStore.js, which is contracted as pure routing with no I/O.
 *
 * Semantics:
 * - Upload the new bytes FIRST — a failure leaves any existing file untouched.
 * - A same-name row in the store is repointed (its id — and thus any shared
 *   download link — stays stable); otherwise a new row is added.
 * - The replaced Drive file is deleted best-effort.
 * - Every write mints a NEW Drive file id, which is what invalidates
 *   projectContext's per-Drive-id text cache — read_file and context
 *   injection never serve stale content after an overwrite or edit.
 */

const path = require('node:path');

const config = require('../config');
const drive = require('../utils/drive');
const { isTextAuthorableExtension } = require('../utils/fileUploads');
const { logger } = require('../utils/logger');

/**
 * Write text content into a store under a filename, overwriting any existing
 * same-name file.
 * @param {Object} auth - Drive auth for the user
 * @param {Object} store - FileStore (resolveFileStore / resolveReadStores)
 * @param {{filename: string, mimeType: string, bytes: Buffer, userId: string}} params
 * @returns {Promise<{record: Object, overwritten: boolean}>}
 */
async function writeContentToStore(auth, store, { filename, mimeType, bytes, userId }) {
  // Safety net: callers pre-check with friendlier wording, but the shared
  // write path is where the cap must actually hold — a future writer that
  // skips its own check still can't upload past the limit.
  if (bytes.length > config.projectFiles.maxFileBytes) {
    throw new Error(`File content exceeds the ${config.projectFiles.maxFileBytes / (1024 * 1024)}MB limit.`);
  }

  const folderId = await store.ensureFolder(auth);

  const uploaded = await drive.uploadFile(auth, {
    name: filename,
    mimeType,
    parentId: folderId,
    data: bytes,
  });

  const existing = store.findByName(filename);
  let record;
  let overwritten = false;
  if (existing) {
    record = store.updateContent(existing.id, {
      mimeType,
      sizeBytes: bytes.length,
      driveFileId: uploaded.id,
    });
    overwritten = true;
    if (existing.drive_file_id && existing.drive_file_id !== uploaded.id) {
      try {
        await drive.deleteFile(auth, existing.drive_file_id);
      } catch (err) {
        logger.warn(
          { userId, fileId: existing.id, msg: err.message },
          'Failed to delete replaced Drive file; orphan left on Drive'
        );
      }
    }
  } else {
    record = store.add({
      filename,
      mimeType,
      sizeBytes: bytes.length,
      driveFileId: uploaded.id,
    });
  }

  return { record, overwritten };
}

/**
 * Validate and save user-supplied text over an EXISTING file row (the file
 * panel's Save button). Same write mechanics as the tools (upload-first,
 * stable row id, cache invalidation via the new Drive id), with the checks a
 * route needs mapped to a { ok, reason } result instead of a throw.
 *
 * Known v1 limitation (deliberate): there is no revision precondition — a
 * save is last-write-wins. The client warns about same-session conflicts,
 * but a second tab/device can silently overwrite. The upgrade path is an
 * If-Match-style check on the row's drive_file_id (client sends the id it
 * last read; mismatch → 409) threaded through the GET/PUT content routes.
 *
 * @param {Object} auth - Drive auth for the user
 * @param {Object} store - FileStore for the container the row lives in
 * @param {Object} file - the existing file row (project/workspace/user_files)
 * @param {*} content - user-supplied replacement text
 * @param {string} userId
 * @returns {Promise<{ok: true, record: Object} | {ok: false, reason: string}>}
 */
async function saveTextOverFile(auth, store, file, content, userId) {
  if (typeof content !== 'string') {
    return { ok: false, reason: 'content must be a string of the complete file text.' };
  }
  const ext = path.extname(file.filename || '').toLowerCase();
  if (!isTextAuthorableExtension(ext)) {
    return { ok: false, reason: 'This file type cannot be edited as text.' };
  }
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > config.projectFiles.maxFileBytes) {
    const mb = config.projectFiles.maxFileBytes / (1024 * 1024);
    return { ok: false, reason: `Content is too large (limit ${mb}MB).` };
  }

  const { record } = await writeContentToStore(auth, store, {
    filename: file.filename,
    mimeType: file.mime_type || 'text/plain',
    bytes,
    userId,
  });

  logger.info(
    { userId, destination: store.kind, fileId: record.id, sizeBytes: bytes.length },
    'User saved file content'
  );

  return { ok: true, record };
}

module.exports = { writeContentToStore, saveTextOverFile };
