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
const dal = require('../db/dal');
const drive = require('../utils/drive');
const { isTextAuthorableExtension } = require('../utils/fileUploads');
const { unifiedDiff } = require('../utils/diff');
const { logger } = require('../utils/logger');

/**
 * Append a file_revisions row for a write, best-effort (File Collaboration,
 * FC-02). The diff is computed from `revision.oldText` (the caller passes it
 * when it already has the prior content — edit_file does; create_file passes ''
 * so a new file reads as all-additions). Op precedence: an explicit
 * `revision.op` wins; otherwise a same-name overwrite is 'overwrite' and a fresh
 * write is 'create'. A logging failure must NEVER break the write, so this
 * swallows its own errors.
 * @param {Object} params
 * @param {Object} params.store - the FileStore written to (kind + row id)
 * @param {Object} params.record - the *_files row that was written
 * @param {Buffer} params.bytes - the bytes written (UTF-8 text)
 * @param {boolean} params.overwritten - whether a same-name row was repointed
 * @param {Object} params.revision - { author, op?, conversationId?, messageId?, oldText? }
 */
function recordRevision({ store, record, bytes, overwritten, revision }) {
  try {
    const op = revision.op || (overwritten ? 'overwrite' : 'create');
    const diff = unifiedDiff(revision.oldText || '', bytes.toString('utf8'), {
      maxChars: config.projectFiles.revisionDiffMaxChars,
    });
    dal.addFileRevision({
      scope: store.kind,
      fileId: record.id,
      conversationId: revision.conversationId || null,
      messageId: revision.messageId || null,
      author: revision.author,
      op,
      diff,
      sizeBytes: bytes.length,
      driveFileId: record.drive_file_id,
    });
  } catch (err) {
    logger.warn({ fileId: record?.id, msg: err.message }, 'Failed to record file revision; write itself succeeded');
  }
}

/**
 * Write text content into a store under a filename, overwriting any existing
 * same-name file.
 * @param {Object} auth - Drive auth for the user
 * @param {Object} store - FileStore (resolveFileStore / resolveReadStores)
 * @param {Object} params
 * @param {string} params.filename
 * @param {string} params.mimeType
 * @param {Buffer} params.bytes
 * @param {string} params.userId
 * @param {Object} [params.revision] - when set, append a file_revisions row
 *   (FC-02): { author, op?, conversationId?, messageId?, oldText? }
 * @returns {Promise<{record: Object, overwritten: boolean}>}
 */
async function writeContentToStore(auth, store, { filename, mimeType, bytes, userId, revision }) {
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

  if (revision) recordRevision({ store, record, bytes, overwritten, revision });

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
 * @param {Object} file - the existing file row (conversation/project/workspace/user_files)
 * @param {*} content - user-supplied replacement text
 * @param {string} userId
 * @param {Object} [revisionMeta] - when it carries a conversationId, log a
 *   user-authored file_revisions row for this save (FC-02): { conversationId, messageId? }
 * @returns {Promise<{ok: true, record: Object} | {ok: false, reason: string}>}
 */
async function saveTextOverFile(auth, store, file, content, userId, revisionMeta = null) {
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

  // A user save is a first-class change (FC-02 decision 7): capture the prior
  // content so the revision carries a real old→new diff the model will see.
  // Best-effort — a failed download degrades to an all-additions diff, never a
  // failed save. Only logged when the save happens in a chat (conversationId).
  let revision;
  if (revisionMeta && revisionMeta.conversationId) {
    let oldText = '';
    if (file.drive_file_id) {
      try {
        // Read via downloadFileBytes (same entry the read/context path uses) so
        // the prior content is captured for the diff.
        const priorBytes = await drive.downloadFileBytes(auth, file.drive_file_id);
        oldText = priorBytes.toString('utf8');
      } catch (err) {
        logger.warn({ userId, fileId: file.id, msg: err.message }, 'Could not read prior content for revision diff');
      }
    }
    revision = {
      author: 'user',
      op: 'edit',
      conversationId: revisionMeta.conversationId,
      messageId: revisionMeta.messageId || null,
      oldText,
    };
  }

  const { record } = await writeContentToStore(auth, store, {
    filename: file.filename,
    mimeType: file.mime_type || 'text/plain',
    bytes,
    userId,
    revision,
  });

  logger.info(
    { userId, destination: store.kind, fileId: record.id, sizeBytes: bytes.length },
    'User saved file content'
  );

  return { ok: true, record };
}

module.exports = { writeContentToStore, saveTextOverFile };
