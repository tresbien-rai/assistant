/**
 * edit_file Executor Test (edit-in-context slice 2)
 *
 * Runs the real executor against the app DB with the Drive module
 * monkeypatched (no network). The mock stores uploaded content in memory so
 * edits can read back what create_file wrote: exact-match replacement,
 * uniqueness enforcement, replace_all, read-store search (project chat edits
 * an inherited workspace file), validation failures, and the Drive-less
 * degrade. Cleans up after itself.
 *
 * Run with: node src/tools/test-editfile.js
 */

const assert = require('node:assert');
const { getDb, closeDb } = require('../db/connection');
const dal = require('../db/dal');
const drive = require('../utils/drive');
const config = require('../config');
const { executeCreateFile } = require('./createFile');
const { executeEditFile } = require('./editFile');

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
const contents = new Map(); // driveFileId -> string content
const deletedIds = [];
let driveConnected = true;

const realDrive = { ...drive };
function installDriveMock() {
  drive.getAuthForUser = () => {
    if (!driveConnected) {
      const err = new Error('Drive not connected');
      err.code = 'DRIVE_ERROR';
      throw err;
    }
    return { mock: true };
  };
  drive.ensureProjectFolderId = async () => 'folder_project';
  drive.ensureWorkspaceFolderId = async () => 'folder_workspace';
  drive.ensureDownloadsFolder = async () => 'folder_downloads';
  drive.uploadFile = async (auth, { name, data }) => {
    const id = `drive_${++uploadSeq}`;
    contents.set(id, Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    return { id, name };
  };
  // edit_file reads via projectContext.extractFileText, which downloads
  // through downloadFileBytes (and caches by Drive id — safe here too, since
  // every mock write mints a new id).
  drive.downloadFileBytes = async (auth, fileId) => {
    if (!contents.has(fileId)) throw new Error(`no such mock file ${fileId}`);
    return Buffer.from(contents.get(fileId), 'utf8');
  };
  drive.deleteFile = async (auth, fileId) => { deletedIds.push(fileId); return true; };
}
function restoreDrive() {
  Object.assign(drive, realDrive);
}

(async () => {
  console.log('='.repeat(60));
  console.log('edit_file Executor Test (slice 2)');
  console.log('='.repeat(60));

  const db = getDb();
  let userId;
  installDriveMock();

  try {
    const user = dal.createUser({ googleId: `ef-test-${Date.now()}`, email: 'ef@test.local' });
    userId = user.id;
    const workspace = dal.createWorkspace(userId, { name: 'WS', instructions: '' });
    const project = dal.createProject(userId, { workspaceId: workspace.id, name: 'PROJ', instructions: '' });

    const projectCtx = { userId, workspace, project, conversationId: 'c1' };
    const workspaceCtx = { userId, workspace, project: null, conversationId: 'c2' };
    const unfiledCtx = { userId, workspace: null, project: null, conversationId: 'c3' };

    console.log('\n1. Basic edit (unique match)...');

    await check('edits content in place, keeps row id + url, deletes old Drive file', async () => {
      const created = await executeCreateFile(
        { filename: 'story.md', content: '# Title\n\nThe quick brown fox.\nThe end.' },
        projectCtx
      );
      assert.ok(!created.isError);
      const createdDriveId = `drive_${uploadSeq}`;

      const res = await executeEditFile(
        { filename: 'story.md', old_text: 'quick brown fox', new_text: 'slow green turtle' },
        projectCtx
      );
      assert.ok(!res.isError, res.content);
      assert.strictEqual(res.display.overwritten, true);
      assert.strictEqual(res.display.destination, 'project');
      // Same row id → same download URL as the created file.
      assert.strictEqual(res.display.fileId, created.display.fileId);
      assert.strictEqual(res.display.url, created.display.url);
      // New Drive file holds the edited content; the old one was deleted.
      const row = dal.getProjectFile(res.display.fileId, project.id);
      assert.strictEqual(contents.get(row.drive_file_id), '# Title\n\nThe slow green turtle.\nThe end.');
      assert.ok(deletedIds.includes(createdDriveId), 'replaced Drive file should be deleted');
      // Row size matches the new content.
      assert.strictEqual(row.size_bytes, Buffer.byteLength('# Title\n\nThe slow green turtle.\nThe end.'));
    });

    await check('new_text with $-patterns is inserted verbatim', async () => {
      await executeCreateFile({ filename: 'money.txt', content: 'price: OLD' }, projectCtx);
      const res = await executeEditFile(
        { filename: 'money.txt', old_text: 'OLD', new_text: "$& costs $$5 or $'" },
        projectCtx
      );
      assert.ok(!res.isError, res.content);
      const row = dal.getProjectFileByName(project.id, 'money.txt');
      assert.strictEqual(contents.get(row.drive_file_id), "price: $& costs $$5 or $'");
    });

    console.log('\n2. Uniqueness + replace_all...');

    await check('ambiguous old_text without replace_all is an isError naming the count', async () => {
      await executeCreateFile({ filename: 'dup.txt', content: 'aaa bbb aaa bbb aaa' }, projectCtx);
      const res = await executeEditFile({ filename: 'dup.txt', old_text: 'aaa', new_text: 'X' }, projectCtx);
      assert.ok(res.isError);
      assert.ok(res.content.includes('3 times'), res.content);
    });

    await check('replace_all replaces every occurrence and reports the count', async () => {
      const res = await executeEditFile(
        { filename: 'dup.txt', old_text: 'aaa', new_text: 'X', replace_all: true },
        projectCtx
      );
      assert.ok(!res.isError, res.content);
      assert.strictEqual(res.display.replacements, 3);
      const row = dal.getProjectFileByName(project.id, 'dup.txt');
      assert.strictEqual(contents.get(row.drive_file_id), 'X bbb X bbb X');
    });

    await check('overlapping occurrences are counted for the uniqueness guard', async () => {
      await executeCreateFile({ filename: 'fruit.txt', content: 'banana' }, projectCtx);
      // "ana" occurs twice in "banana" (overlapping) — split-based counting
      // would report 1 and silently half-edit; the guard must reject.
      const res = await executeEditFile({ filename: 'fruit.txt', old_text: 'ana', new_text: 'X' }, projectCtx);
      assert.ok(res.isError);
      assert.ok(res.content.includes('2 times'), res.content);
    });

    await check('old_text not found is an isError telling the model to re-read', async () => {
      const res = await executeEditFile({ filename: 'dup.txt', old_text: 'zzz', new_text: 'X' }, projectCtx);
      assert.ok(res.isError);
      assert.ok(res.content.includes('not found'), res.content);
    });

    console.log('\n3. Read-store search (project chat edits inherited workspace file)...');

    await check('file living only in the workspace is edited there from a project chat', async () => {
      await executeCreateFile({ filename: 'shared.md', content: 'workspace copy v1' }, workspaceCtx);
      const res = await executeEditFile({ filename: 'shared.md', old_text: 'v1', new_text: 'v2' }, projectCtx);
      assert.ok(!res.isError, res.content);
      assert.strictEqual(res.display.destination, 'workspace');
      const row = dal.getWorkspaceFileByName(workspace.id, 'shared.md');
      assert.strictEqual(contents.get(row.drive_file_id), 'workspace copy v2');
    });

    console.log('\n4. Validation failures...');

    await check('missing file is an isError suggesting list_files', async () => {
      const res = await executeEditFile({ filename: 'ghost.md', old_text: 'a', new_text: 'b' }, unfiledCtx);
      assert.ok(res.isError);
      assert.ok(res.content.includes('list_files'), res.content);
    });

    await check('identical old_text/new_text is an isError', async () => {
      const res = await executeEditFile({ filename: 'dup.txt', old_text: 'same', new_text: 'same' }, projectCtx);
      assert.ok(res.isError);
    });

    await check('empty old_text is an isError', async () => {
      const res = await executeEditFile({ filename: 'dup.txt', old_text: '', new_text: 'x' }, projectCtx);
      assert.ok(res.isError);
    });

    await check('non-text file type (.pdf) is an isError', async () => {
      dal.addProjectFile(project.id, {
        filename: 'doc.pdf', mimeType: 'application/pdf', sizeBytes: 10, driveFileId: 'drive_pdf',
      });
      contents.set('drive_pdf', '%PDF-fake');
      const res = await executeEditFile({ filename: 'doc.pdf', old_text: 'a', new_text: 'b' }, projectCtx);
      assert.ok(res.isError);
      assert.ok(res.content.includes('not a text-editable'), res.content);
    });

    await check('result exceeding the size cap is an isError and leaves content untouched', async () => {
      await executeCreateFile({ filename: 'small.txt', content: 'seed' }, projectCtx);
      const huge = 'x'.repeat(config.projectFiles.maxFileBytes + 10);
      const res = await executeEditFile({ filename: 'small.txt', old_text: 'seed', new_text: huge }, projectCtx);
      assert.ok(res.isError);
      const row = dal.getProjectFileByName(project.id, 'small.txt');
      assert.strictEqual(contents.get(row.drive_file_id), 'seed');
    });

    console.log('\n5. Drive-less degrade...');

    await check('no Drive connection is a friendly isError, not a crash', async () => {
      driveConnected = false;
      const res = await executeEditFile({ filename: 'dup.txt', old_text: 'X', new_text: 'Y' }, projectCtx);
      driveConnected = true;
      assert.ok(res.isError);
      assert.ok(res.content.includes('Google Drive'), res.content);
    });
  } catch (err) {
    console.error('\n✗ Executor test crashed:', err);
    failures++;
  } finally {
    restoreDrive();
    if (userId) db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    closeDb();
  }

  console.log('\n' + '='.repeat(60));
  if (failures === 0) {
    console.log('All edit_file executor tests passed!');
  } else {
    console.log(`${failures} assertion(s) FAILED`);
  }
  console.log('='.repeat(60) + '\n');
  process.exit(failures === 0 ? 0 : 1);
})();
