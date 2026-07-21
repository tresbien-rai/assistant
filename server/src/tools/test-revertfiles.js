/**
 * Re-roll File Rollback Test (File Collaboration, FC-06a)
 *
 * Exercises revertConversationFiles + the snapshot machinery: an edit is rolled
 * back to its pre-turn content, a file created in the undone turn is deleted,
 * user-only edits are preserved, a missing snapshot degrades to a warning, the
 * Drive-less path is safe, and snapshot pruning bounds stored content. Drive is
 * monkeypatched with an in-memory content store. Cleans up after itself.
 *
 * Run with: node src/tools/test-revertfiles.js
 */

const assert = require('node:assert');
const { getDb, closeDb } = require('../db/connection');
const dal = require('../db/dal');
const drive = require('../utils/drive');
const config = require('../config');
const { executeCreateFile } = require('./createFile');
const { executeEditFile } = require('./editFile');
const { saveTextOverFile } = require('./storeWriter');
const { resolveFileStore } = require('./fileStore');
const { revertConversationFiles } = require('./revertFiles');

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`   ✓ ${label}`); }
  catch (err) { console.log(`   ✗ ${label}`); console.log(`      ${err.message}`); failures++; }
}

// --- Drive mock: in-memory content keyed by minted file id ------------------
let uploadSeq = 0;
const contents = new Map();
const trashed = [];
let driveConnected = true;
const realDrive = { ...drive };
function installDriveMock() {
  drive.getAuthForUser = () => { if (!driveConnected) { const e = new Error('no drive'); e.code = 'DRIVE_ERROR'; throw e; } return { mock: true }; };
  drive.ensureConversationFolder = async () => 'folder_conversation';
  drive.uploadFile = async (auth, { name, data }) => { const id = `drive_${++uploadSeq}`; contents.set(id, Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); return { id, name }; };
  drive.downloadFileBytes = async (auth, fileId) => { if (!contents.has(fileId)) throw new Error(`no mock file ${fileId}`); return Buffer.from(contents.get(fileId), 'utf8'); };
  drive.deleteFile = async () => true;
  drive.trashFile = async (auth, fileId) => { trashed.push(fileId); return true; };
}
function restoreDrive() { Object.assign(drive, realDrive); }

// Read a conversation file's current content via its drive id.
function currentContent(convId, filename) {
  const f = dal.getConversationFileByName(convId, filename);
  return f ? contents.get(f.drive_file_id) : undefined;
}

(async () => {
  console.log('='.repeat(60));
  console.log('Re-roll File Rollback Test (FC-06a)');
  console.log('='.repeat(60));

  const db = getDb();
  let userId;
  installDriveMock();

  try {
    const user = dal.createUser({ googleId: `rv-${Date.now()}`, email: 'rv@test.local' });
    userId = user.id;
    const conv = dal.createConversation(userId, { title: 'C' });
    const ctx = (turn) => ({ userId, workspace: null, project: null, conversationId: conv.id, turnOrdinal: turn });
    const revertCtx = { userId, conversationId: conv.id, project: null, workspace: null };

    console.log('\n1. An edit is rolled back to its pre-turn content...');
    await check('revert restores the snapshot + drops the undone revision', async () => {
      await executeCreateFile({ filename: 'doc.md', content: 'version one' }, ctx(1));
      await executeEditFile({ filename: 'doc.md', old_text: 'one', new_text: 'two' }, ctx(2));
      assert.strictEqual(currentContent(conv.id, 'doc.md'), 'version two', 'edited before revert');
      const fileId = dal.getConversationFileByName(conv.id, 'doc.md').id;

      const res = await revertConversationFiles(revertCtx, 2);
      assert.strictEqual(res.reverted, 1, 'one file reverted');
      assert.strictEqual(currentContent(conv.id, 'doc.md'), 'version one', 'rolled back to pre-turn content');
      const revs = dal.listFileRevisions('conversation', fileId);
      assert.strictEqual(revs.length, 1, 'only the turn-1 create remains');
      assert.strictEqual(revs[0].op, 'create');
    });

    console.log('\n2. A file created in the undone turn is deleted...');
    await check('revert removes a file created at/after the turn (Drive trashed)', async () => {
      await executeCreateFile({ filename: 'fresh.md', content: 'brand new' }, ctx(3));
      const fileId = dal.getConversationFileByName(conv.id, 'fresh.md').id;
      const driveId = dal.getConversationFileByName(conv.id, 'fresh.md').drive_file_id;
      trashed.length = 0;

      const res = await revertConversationFiles(revertCtx, 3);
      assert.strictEqual(res.deleted, 1);
      assert.strictEqual(dal.getConversationFileByName(conv.id, 'fresh.md'), undefined, 'file removed');
      assert.strictEqual(dal.listFileRevisions('conversation', fileId).length, 0, 'revisions removed');
      assert.ok(trashed.includes(driveId), 'Drive file trashed');
    });

    console.log('\n3. User-only edits are preserved; a mixed turn reverts only the model file...');
    await check('model file rolled back, user-only file untouched', async () => {
      // Pre-existing files (created at turn 4).
      await executeCreateFile({ filename: 'A.md', content: 'A base' }, ctx(4));
      await executeCreateFile({ filename: 'B.md', content: 'B base' }, ctx(4));
      // Turn 5: model edits A; user edits B (a panel save carries a conversationId+turn).
      await executeEditFile({ filename: 'A.md', old_text: 'base', new_text: 'MODEL' }, ctx(5));
      const store = resolveFileStore({ userId, conversationId: conv.id });
      const bRow = dal.getConversationFileByName(conv.id, 'B.md');
      await saveTextOverFile(drive.getAuthForUser(userId), store, bRow, 'B USER EDIT', userId, { conversationId: conv.id, turn: 5 });
      assert.strictEqual(currentContent(conv.id, 'A.md'), 'A MODEL');
      assert.strictEqual(currentContent(conv.id, 'B.md'), 'B USER EDIT');

      const res = await revertConversationFiles(revertCtx, 5);
      assert.strictEqual(res.reverted, 1, 'only A reverted');
      assert.strictEqual(currentContent(conv.id, 'A.md'), 'A base', 'A rolled back');
      assert.strictEqual(currentContent(conv.id, 'B.md'), 'B USER EDIT', 'B (user-only) preserved');
    });

    console.log('\n4. Missing snapshot degrades to a warning (no wrong result)...');
    await check('a change older than the snapshots warns and leaves the file', async () => {
      await executeCreateFile({ filename: 'old.md', content: 'old base' }, ctx(6));
      await executeEditFile({ filename: 'old.md', old_text: 'base', new_text: 'edited' }, ctx(7));
      const fileId = dal.getConversationFileByName(conv.id, 'old.md').id;
      // Simulate the pre-turn snapshot having been pruned away.
      db.prepare(`UPDATE file_revisions SET content = NULL WHERE scope='conversation' AND file_id = ? AND turn = 6`).run(fileId);

      const res = await revertConversationFiles(revertCtx, 7);
      assert.strictEqual(res.reverted, 0);
      assert.strictEqual(res.warnings.length, 1, 'one warning');
      assert.match(res.warnings[0], /old\.md/);
      assert.strictEqual(currentContent(conv.id, 'old.md'), 'old edited', 'file left as-is');
    });

    console.log('\n5. No model changes at/after the turn -> no-op...');
    await check('revert with nothing to undo returns zeros', async () => {
      const res = await revertConversationFiles(revertCtx, 999);
      assert.deepStrictEqual({ r: res.reverted, d: res.deleted, w: res.warnings.length }, { r: 0, d: 0, w: 0 });
    });

    console.log('\n6. Drive-less -> warning, no changes...');
    await check('no Drive connection warns and rolls nothing back', async () => {
      await executeCreateFile({ filename: 'nd.md', content: 'x1' }, ctx(8));
      await executeEditFile({ filename: 'nd.md', old_text: 'x1', new_text: 'x2' }, ctx(9));
      driveConnected = false;
      const res = await revertConversationFiles(revertCtx, 9);
      driveConnected = true;
      assert.strictEqual(res.reverted, 0);
      assert.ok(res.warnings.some((w) => /Drive/.test(w)));
      assert.strictEqual(currentContent(conv.id, 'nd.md'), 'x2', 'unchanged');
    });

    console.log('\n7. Snapshot pruning bounds stored content...');
    await check('only the most recent N revisions keep content', async () => {
      const fid = 'prune-test-file';
      for (let i = 1; i <= 5; i++) {
        dal.addFileRevision({ scope: 'conversation', fileId: fid, conversationId: conv.id, author: 'model', op: 'edit', diff: '', sizeBytes: 2, driveFileId: `d${i}`, turn: i, content: `c${i}` });
      }
      dal.pruneRevisionSnapshots('conversation', fid, 2);
      const withContent = dal.listFileRevisions('conversation', fid).filter((r) => r.content != null);
      assert.strictEqual(withContent.length, 2, 'kept 2 snapshots');
      const kept = withContent.map((r) => r.content).sort();
      assert.deepStrictEqual(kept, ['c4', 'c5'], 'kept the two newest');
    });

    console.log('\n8. Snapshots are actually captured on a normal write...');
    await check('create_file stores a content snapshot within the size cap', async () => {
      await executeCreateFile({ filename: 'snap.md', content: 'snapshot me' }, ctx(10));
      const fileId = dal.getConversationFileByName(conv.id, 'snap.md').id;
      const rev = dal.listFileRevisions('conversation', fileId).slice(-1)[0];
      assert.strictEqual(rev.content, 'snapshot me');
      assert.ok(config.projectFiles.revisionSnapshotMaxBytes > 0);
    });

  } catch (err) {
    console.error('\n✗ Revert test crashed:', err);
    failures++;
  } finally {
    restoreDrive();
    if (userId) db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    closeDb();
  }

  console.log('\n' + '='.repeat(60));
  console.log(failures === 0 ? 'All re-roll rollback tests passed!' : `${failures} assertion(s) FAILED`);
  console.log('='.repeat(60) + '\n');
  process.exit(failures === 0 ? 0 : 1);
})();
