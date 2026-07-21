/**
 * move_file Executor (File Collaboration, FC-05)
 *
 * Relocates a file between scopes — chiefly to PROMOTE a file the chat created
 * (conversation scope) into the curated project/workspace knowledge base, or out
 * to the user's Downloads. The model calls this when a scratch file has earned a
 * permanent home; the user's uploaded/curated files thereby stay intentional.
 *
 * Mechanics (a metadata + Drive-parent move, NOT a content rewrite):
 * - The source is found across the conversation's read stores (same search as
 *   read_file / edit_file). The destination is named explicitly and validated
 *   against what the chat can reach (e.g. "project" only from a project chat).
 * - The Drive file is reparented into the destination folder (same Drive id), so
 *   its bytes physically leave the source folder — critical, since deleting the
 *   source chat later trashes whatever is still in its `Chats/<id>/` folder.
 * - The destination DB row is created (same drive_file_id) and the source row is
 *   deleted; the source file's revision log is cleared (it has no cascade for
 *   most scopes). A move is not a content edit, so it logs no revision.
 * - A same-name file already in the destination is overwritten (its Drive file
 *   trashed, its row removed), mirroring create_file's overwrite semantics.
 *
 * Returns { content, isError?, display? } like the other executors: validation /
 * not-found / unreachable-destination RETURN isError results; unexpected
 * failures (Drive down mid-move) THROW and the loop converts them.
 */

const dal = require('../db/dal');
const drive = require('../utils/drive');
const {
  resolveReadStores,
  resolveDestinationStore,
  findAcrossStores,
  resolveToolDriveAuth,
} = require('./fileStore');
const { logger } = require('../utils/logger');

const VALID_DESTINATIONS = ['project', 'workspace', 'downloads', 'conversation'];

/**
 * Execute one move_file call.
 * @param {{filename?: string, destination?: string}} input
 * @param {Object} ctx - ToolContext ({ userId, workspace, project, conversationId })
 * @returns {Promise<{content: string, isError?: boolean, display?: Object}>}
 */
async function executeMoveFile(input, ctx) {
  const filename = typeof input.filename === 'string' ? input.filename.trim() : '';
  if (!filename) {
    return { content: 'move_file needs a "filename". Use list_files to see what is available.', isError: true };
  }

  const destination = typeof input.destination === 'string' ? input.destination.trim().toLowerCase() : '';
  if (!VALID_DESTINATIONS.includes(destination)) {
    return {
      content: `move_file needs a "destination" of ${VALID_DESTINATIONS.slice(0, 3).join(', ')}. Use "project" or "workspace" to promote a chat file into the shared files.`,
      isError: true,
    };
  }

  // Resolve the destination first — a bad/unavailable target is the model's to
  // fix, and there's no point locating the source if we can't place it.
  const dest = resolveDestinationStore(ctx, destination);
  if (dest.unavailable) {
    return { content: `Cannot move the file: ${dest.unavailable}`, isError: true };
  }
  const destStore = dest.store;

  // Locate the source across the readable scopes (most specific first).
  const hit = findAcrossStores(resolveReadStores(ctx), filename);
  if (!hit) {
    return {
      content: `No file named "${filename}" is available in this conversation. Use list_files to see the exact names.`,
      isError: true,
    };
  }
  if (hit.store.kind === destStore.kind) {
    return { content: `"${filename}" is already in ${destStore.label}.`, isError: true };
  }
  if (!hit.file.drive_file_id) {
    return { content: `"${filename}" has no stored content to move.`, isError: true };
  }

  // Drive-less users (e.g. dev login) get a readable failure, not a crash.
  const { auth, unavailable } = resolveToolDriveAuth(ctx.userId);
  if (unavailable) return { content: `Cannot move the file: ${unavailable}`, isError: true };

  const destFolderId = await destStore.ensureFolder(auth);

  // Overwrite a same-name file in the destination (mirrors create_file).
  const clash = destStore.findByName(filename);
  let overwritten = false;
  if (clash) {
    if (clash.drive_file_id) {
      try {
        await drive.trashFile(auth, clash.drive_file_id);
      } catch (err) {
        logger.warn({ userId: ctx.userId, fileId: clash.id, msg: err.message }, 'move_file: could not trash overwritten destination file');
      }
    }
    destStore.remove(clash.id);
    dal.deleteFileRevisions(destStore.kind, clash.id);
    overwritten = true;
  }

  // Reparent the Drive bytes into the destination folder (keeps the Drive id).
  await drive.moveFileToFolder(auth, hit.file.drive_file_id, destFolderId);

  const record = destStore.add({
    filename,
    mimeType: hit.file.mime_type || 'text/plain',
    sizeBytes: hit.file.size_bytes || 0,
    driveFileId: hit.file.drive_file_id,
  });

  // Drop the source row + its now-orphaned revision log (a move isn't an edit).
  hit.store.remove(hit.file.id);
  dal.deleteFileRevisions(hit.store.kind, hit.file.id);

  const url = destStore.urlFor(record.id);
  logger.info(
    { userId: ctx.userId, from: hit.store.kind, to: destStore.kind, fileId: record.id, overwritten },
    'move_file executed'
  );

  const overwriteNote = overwritten ? ` (replaced an existing "${filename}" there)` : '';
  return {
    content: `Moved "${filename}" from ${hit.store.label} to ${destStore.label}${overwriteNote}. The user can download it at ${url} — you can reference this link in your reply as a markdown link.`,
    display: {
      fileId: record.id,
      url,
      from: hit.store.kind,
      destination: destStore.kind,
      overwritten,
    },
  };
}

module.exports = { executeMoveFile };
