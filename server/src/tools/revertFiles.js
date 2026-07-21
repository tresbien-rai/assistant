/**
 * Re-roll file rollback (File Collaboration, FC-06a)
 *
 * When a user re-rolls / edits-and-resends / regenerates a turn, the messages
 * after it are discarded — but any files the MODEL changed during those turns
 * were already mutated on Drive. Without this, the re-run would operate on the
 * already-edited file (edit_file's old_text no longer matches; the active-file
 * injection feeds the wrong content). This rolls those files back to their
 * pre-turn state.
 *
 * Keyed on the `turn` stamp every revision carries (FC-03b): re-rolling from
 * user-turn `fromTurn` undoes model-authored revisions with `turn >= fromTurn`.
 * For each affected file:
 *   - created during the undone span (a `create` at turn >= fromTurn) → delete
 *     it (it didn't exist before);
 *   - otherwise → restore the newest content SNAPSHOT (FC-06a) from before the
 *     turn, then drop the undone revisions.
 *
 * Deliberate scope: only MODEL changes are undone, so a user's own panel edit is
 * preserved. A `move_file` logs no revision, so a promotion isn't auto-reverted
 * (documented edge). A change older than the snapshot cap can't be rolled back —
 * it degrades to a warning rather than a wrong result. Restores write through
 * the shared path WITHOUT logging a revision (an undo isn't a new change).
 */

const dal = require('../db/dal');
const drive = require('../utils/drive');
const { resolveDestinationStore, resolveToolDriveAuth } = require('./fileStore');
const { writeContentToStore } = require('./storeWriter');
const { logger } = require('../utils/logger');

/**
 * Roll a conversation's model-authored file changes back to before `fromTurn`.
 * @param {Object} ctx - { userId, conversationId, project, workspace }
 * @param {number} fromTurn - the user-turn being re-rolled (undo turn >= this)
 * @returns {Promise<{reverted: number, deleted: number, warnings: string[]}>}
 */
async function revertConversationFiles(ctx, fromTurn) {
  const { userId, conversationId } = ctx;
  const result = { reverted: 0, deleted: 0, warnings: [] };
  if (!conversationId || !(fromTurn > 0)) return result;

  const revs = dal.listModelRevisionsFromTurn(conversationId, fromTurn);
  if (revs.length === 0) return result;

  // Group affected files; note any that were CREATED within the undone span.
  const byFile = new Map();
  for (const r of revs) {
    const key = `${r.scope}:${r.file_id}`;
    if (!byFile.has(key)) byFile.set(key, { scope: r.scope, fileId: r.file_id, createdInSpan: false });
    if (r.op === 'create') byFile.get(key).createdInSpan = true;
  }

  // Everything below touches Drive; without it, don't half-apply — warn and stop.
  const { auth, unavailable } = resolveToolDriveAuth(userId);
  if (unavailable) {
    result.warnings.push('Google Drive was unavailable, so file changes could not be rolled back.');
    return result;
  }

  for (const { scope, fileId, createdInSpan } of byFile.values()) {
    const dest = resolveDestinationStore(ctx, scope);
    if (dest.unavailable) {
      logger.warn({ userId, conversationId, scope, fileId }, 'revert: scope not reachable; skipping');
      continue;
    }
    const store = dest.store;
    const file = store.get(fileId);

    try {
      if (createdInSpan) {
        // Created during the undone turns → remove it (best-effort Drive trash).
        if (file && file.drive_file_id) {
          try { await drive.trashFile(auth, file.drive_file_id); }
          catch (err) { logger.warn({ userId, fileId, msg: err.message }, 'revert: could not trash created file'); }
        }
        if (file) store.remove(fileId);
        dal.deleteFileRevisions(scope, fileId);
        result.deleted += 1;
      } else {
        // Restore the newest snapshot from before the turn.
        const snap = dal.getSnapshotBeforeTurn(scope, fileId, fromTurn);
        if (!file) continue; // already gone
        if (!snap || snap.content == null) {
          result.warnings.push(`"${file.filename}" could not be rolled back (its earlier version is no longer stored).`);
          continue;
        }
        await writeContentToStore(auth, store, {
          filename: file.filename,
          mimeType: file.mime_type || 'text/plain',
          bytes: Buffer.from(snap.content, 'utf8'),
          userId,
          // No `revision`: a rollback is an undo, not a new change.
        });
        dal.deleteRevisionsFromTurn(scope, fileId, fromTurn);
        result.reverted += 1;
      }
    } catch (err) {
      // A single file's failure shouldn't abort the whole rollback.
      logger.error({ userId, conversationId, scope, fileId, msg: err.message }, 'revert: file rollback failed');
      result.warnings.push(`"${file ? file.filename : fileId}" could not be rolled back: ${err.message}`);
    }
  }

  logger.info({ userId, conversationId, fromTurn, ...result, warnings: result.warnings.length }, 'reverted conversation files');
  return result;
}

module.exports = { revertConversationFiles };
