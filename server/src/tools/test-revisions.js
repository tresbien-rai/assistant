/**
 * File Revisions Test (File Collaboration, FC-02)
 *
 * Exercises the change log written by the shared store path: create_file,
 * edit_file, and a user save each append a file_revisions row with the right
 * author / op / diff, revisions are ordered and share the stable file id, and a
 * deleted conversation cascades its revisions away. Drive is monkeypatched with
 * an in-memory content store (no network). Cleans up after itself.
 *
 * Run with: node src/tools/test-revisions.js
 */

const assert = require('node:assert');
const { getDb, closeDb } = require('../db/connection');
const dal = require('../db/dal');
const drive = require('../utils/drive');
const { unifiedDiff } = require('../utils/diff');
const { executeCreateFile } = require('./createFile');
const { executeEditFile } = require('./editFile');
const { resolveFileStore } = require('./fileStore');
const { saveTextOverFile } = require('./storeWriter');

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`   ✓ ${label}`);
  } catch (err) {
    console.log(`   ✗ ${label}`);
    console.log(`      ${err.message}`);
    failures++;
  }
}

// --- Drive mock: in-memory content store keyed by minted file ids -----------
let uploadSeq = 0;
const contents = new Map();
const realDrive = { ...drive };
function installDriveMock() {
  drive.getAuthForUser = () => ({ mock: true });
  drive.ensureConversationFolder = async () => 'folder_conversation';
  drive.ensureProjectFolderId = async () => 'folder_project';
  drive.uploadFile = async (auth, { name, data }) => {
    const id = `drive_${++uploadSeq}`;
    contents.set(id, Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    return { id, name };
  };
  drive.downloadFileBytes = async (auth, fileId) => {
    if (!contents.has(fileId)) throw new Error(`no such mock file ${fileId}`);
    return Buffer.from(contents.get(fileId), 'utf8');
  };
  drive.deleteFile = async () => true;
}
function restoreDrive() {
  Object.assign(drive, realDrive);
}

(async () => {
  console.log('='.repeat(60));
  console.log('File Revisions Test (FC-02)');
  console.log('='.repeat(60));

  const db = getDb();
  let userId;
  installDriveMock();

  try {
    const user = dal.createUser({ googleId: `rev-test-${Date.now()}`, email: 'rev@test.local' });
    userId = user.id;
    const workspace = dal.createWorkspace(userId, { name: 'WS', instructions: '' });
    const project = dal.createProject(userId, { workspaceId: workspace.id, name: 'PROJ', instructions: '' });
    const conv = dal.createConversation(userId, { title: 'C', projectId: project.id, workspaceId: workspace.id });
    const ctx = { userId, workspace, project, conversationId: conv.id };

    const revs = () => {
      const f = dal.getConversationFileByName(conv.id, 'doc.md');
      return f ? dal.listFileRevisions('conversation', f.id) : [];
    };

    console.log('\n1. create_file logs a "create" revision (all-additions diff)...');
    await check('one revision, author=model op=create, diff adds the content', async () => {
      const res = await executeCreateFile({ filename: 'doc.md', content: 'v1 line' }, ctx);
      assert.ok(!res.isError, res.content);
      const list = revs();
      assert.strictEqual(list.length, 1, 'exactly one revision');
      assert.strictEqual(list[0].author, 'model');
      assert.strictEqual(list[0].op, 'create');
      assert.strictEqual(list[0].scope, 'conversation');
      assert.strictEqual(list[0].conversation_id, conv.id);
      assert.match(list[0].diff, /\+v1 line/);
      assert.strictEqual(list[0].size_bytes, Buffer.byteLength('v1 line'));
      assert.ok(list[0].drive_file_id, 'records the new Drive id');
    });

    console.log('\n2. edit_file logs an "edit" revision with a real old→new diff...');
    await check('second revision, op=edit, diff shows - old / + new', async () => {
      const res = await executeEditFile({ filename: 'doc.md', old_text: 'v1', new_text: 'v2' }, ctx);
      assert.ok(!res.isError, res.content);
      const list = revs();
      assert.strictEqual(list.length, 2, 'two revisions now');
      const latest = list[list.length - 1];
      assert.strictEqual(latest.author, 'model');
      assert.strictEqual(latest.op, 'edit');
      assert.match(latest.diff, /-v1 line/);
      assert.match(latest.diff, /\+v2 line/);
    });

    console.log('\n3. re-creating the same file logs an "overwrite"...');
    await check('third revision, op=overwrite, same file id throughout', async () => {
      const res = await executeCreateFile({ filename: 'doc.md', content: 'wholesale replacement' }, ctx);
      assert.ok(!res.isError, res.content);
      const list = revs();
      assert.strictEqual(list.length, 3);
      assert.strictEqual(list[list.length - 1].op, 'overwrite');
      // The stable row id means all revisions share one file_id.
      const ids = new Set(list.map((r) => r.file_id));
      assert.strictEqual(ids.size, 1, 'all revisions point at the one file row');
    });

    console.log('\n4. a user save logs a user-authored revision...');
    await check('fourth revision, author=user, diff reflects the user edit', async () => {
      const store = resolveFileStore({ userId, conversationId: conv.id });
      const row = dal.getConversationFileByName(conv.id, 'doc.md');
      const result = await saveTextOverFile(
        drive.getAuthForUser(userId), store, row, 'user hand-edited this', userId,
        { conversationId: conv.id }
      );
      assert.strictEqual(result.ok, true, result.reason);
      const list = revs();
      assert.strictEqual(list.length, 4);
      const latest = list[list.length - 1];
      assert.strictEqual(latest.author, 'user');
      assert.strictEqual(latest.op, 'edit');
      assert.match(latest.diff, /-wholesale replacement/);
      assert.match(latest.diff, /\+user hand-edited this/);
    });

    console.log('\n5. revisions are ordered oldest-first...');
    await check('created_at is non-decreasing across the log', async () => {
      const list = revs();
      const ops = list.map((r) => r.op);
      assert.deepStrictEqual(ops, ['create', 'edit', 'overwrite', 'edit']);
      for (let i = 1; i < list.length; i++) {
        assert.ok(list[i].created_at >= list[i - 1].created_at, 'non-decreasing timestamps');
      }
    });

    console.log('\n6. a revision-log failure never breaks the write...');
    await check('addFileRevision throwing still returns a successful create', async () => {
      const orig = dal.addFileRevision;
      dal.addFileRevision = () => { throw new Error('boom'); };
      try {
        const res = await executeCreateFile({ filename: 'safe.md', content: 'still saved' }, ctx);
        assert.ok(!res.isError, 'write succeeds despite the logging failure');
        const f = dal.getConversationFileByName(conv.id, 'safe.md');
        assert.ok(f && f.drive_file_id, 'the file was still written');
      } finally {
        dal.addFileRevision = orig;
      }
    });

    console.log('\n7. deleting the conversation cascades its revisions away...');
    await check('no file_revisions rows remain for the deleted chat', async () => {
      const before = db.prepare('SELECT COUNT(*) c FROM file_revisions WHERE conversation_id = ?').get(conv.id).c;
      assert.ok(before >= 4, `expected revisions before delete, got ${before}`);
      dal.deleteConversation(conv.id, userId);
      const after = db.prepare('SELECT COUNT(*) c FROM file_revisions WHERE conversation_id = ?').get(conv.id).c;
      assert.strictEqual(after, 0, 'revisions cascade-deleted with the conversation');
    });

    console.log('\n8. diff util edge cases...');
    await check('identical content yields an empty diff', () => {
      assert.strictEqual(unifiedDiff('same\ntext', 'same\ntext'), '');
    });
    await check('oversized input degrades to a summary, not a crash', () => {
      const big = Array.from({ length: 6000 }, (_, i) => `line ${i}`).join('\n');
      const out = unifiedDiff('', big, { maxChars: 20000 });
      assert.match(out, /diff omitted — file too large/);
    });

    console.log('\n9. FC-04: a project list-edit logs a user revision + delete cleans up...');
    await check('user save on a project file (no chat) logs a null-conversation user revision', async () => {
      const workspace = dal.createWorkspace(userId, { name: 'WS', instructions: '' });
      const project = dal.createProject(userId, { workspaceId: workspace.id, name: 'PROJ', instructions: '' });
      const pstore = resolveFileStore({ userId, project, workspace: null });
      contents.set('seed_proj', 'original text');
      const prow = pstore.add({ filename: 'spec.md', mimeType: 'text/markdown', sizeBytes: 13, driveFileId: 'seed_proj' });

      const res = await saveTextOverFile(drive.getAuthForUser(userId), pstore, prow, 'edited by hand', userId, {});
      assert.strictEqual(res.ok, true, res.reason);

      const revs = dal.listFileRevisions('project', prow.id);
      assert.strictEqual(revs.length, 1, 'one project revision');
      assert.strictEqual(revs[0].author, 'user');
      assert.strictEqual(revs[0].op, 'edit');
      assert.strictEqual(revs[0].conversation_id, null, 'no chat context → null conversation');
      assert.match(revs[0].diff, /-original text/);
      assert.match(revs[0].diff, /\+edited by hand/);

      // FC-04 cleanup: this scope has no cascade, so delete removes revisions.
      const removed = dal.deleteFileRevisions('project', prow.id);
      assert.strictEqual(removed, 1);
      assert.strictEqual(dal.listFileRevisions('project', prow.id).length, 0);
    });

  } catch (err) {
    console.error('\n✗ Revisions test crashed:', err);
    failures++;
  } finally {
    restoreDrive();
    if (userId) db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    closeDb();
  }

  console.log('\n' + '='.repeat(60));
  if (failures === 0) {
    console.log('All file-revision tests passed!');
  } else {
    console.log(`${failures} assertion(s) FAILED`);
  }
  console.log('='.repeat(60) + '\n');
  process.exit(failures === 0 ? 0 : 1);
})();
