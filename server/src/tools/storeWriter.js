/**
 * Shared store write path (file tools)
 *
 * The ONE way tool executors write text content into a file store, used by
 * create_file and edit_file (and any future mutator). Lives apart from the
 * executors so they stay peers (no executor-to-executor imports), and apart
 * from fileStore.js, which is contracted as pure routing with no I/O.
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

const drive = require('../utils/drive');
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

module.exports = { writeContentToStore };
