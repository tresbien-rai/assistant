/**
 * Conversation Drive cleanup (File Collaboration)
 *
 * When a conversation is deleted, its `conversation_files` rows cascade away
 * with it (FK ON DELETE CASCADE), but the files the chat created still live on
 * the user's Google Drive under `Tessera/Chats/<conversationId>/`. Left alone
 * they become untracked orphans (no DB row = no way to list/download/recover
 * them in-app). This module trashes them just before the DB rows disappear.
 *
 * Design decisions (confirmed with the human):
 *   - Trash (recoverable) rather than permanently delete or promote — mirrors
 *     project deletion (`routes/projects.js` DELETE), so a mis-deleted chat's
 *     files survive ~30 days in Drive's own trash.
 *   - Best-effort: Drive being down/disconnected must never block the DB
 *     deletion, so this never throws — it logs and returns a summary.
 */

const dal = require('../db/dal');
const drive = require('../utils/drive');
const { logger } = require('../utils/logger');

/**
 * Move a conversation's created files (and its `Chats/<id>/` folder) to Drive
 * trash. Call this BEFORE `dal.deleteConversation`, while the
 * `conversation_files` rows still exist. Never throws.
 *
 * @param {string} userId - The owning user's UUID (for Drive auth)
 * @param {string} conversationId - The conversation being deleted
 * @returns {Promise<{trashed: number, skipped?: boolean, folder?: boolean, error?: string}>}
 *   A summary: `skipped` when the chat created nothing (no Drive work done);
 *   `folder` whether the folder-level trash path was taken; `error` when a Drive
 *   failure was swallowed.
 */
async function trashConversationFiles(userId, conversationId) {
  const files = dal.listConversationFiles(conversationId);

  // No file rows means the lazily-created `Chats/<id>/` folder was never made,
  // so there is nothing on Drive to clean up — skip all API calls (and don't
  // touch Drive at all for the common file-less chat).
  if (files.length === 0) {
    return { trashed: 0, skipped: true };
  }

  try {
    const auth = drive.getAuthForUser(userId);
    const folderId = await drive.findConversationFolder(auth, conversationId);

    if (folderId) {
      // Trashing the folder recursively trashes the files inside it, so a single
      // call cleans up both the created files and the now-empty chat folder.
      await drive.trashFile(auth, folderId);
      return { trashed: files.length, folder: true };
    }

    // Fallback: the folder couldn't be resolved (user renamed/moved/removed it),
    // but we still hold each file's Drive id, so trash them individually. Each
    // is independent so one failure doesn't strand the rest.
    let trashed = 0;
    for (const file of files) {
      if (!file.drive_file_id) continue;
      try {
        await drive.trashFile(auth, file.drive_file_id);
        trashed += 1;
      } catch (err) {
        logger.warn(
          { userId, conversationId, code: err.code },
          'Could not trash a chat file during conversation delete'
        );
      }
    }
    return { trashed, folder: false };
  } catch (err) {
    // Drive disconnected / auth failure / API outage: log and move on so the
    // conversation still deletes.
    logger.warn(
      { userId, conversationId, code: err.code },
      'Could not trash chat Drive files during conversation delete; removing DB rows anyway'
    );
    return { trashed: 0, error: err.code || 'error' };
  }
}

module.exports = { trashConversationFiles };
