/**
 * create_file Executor Test (Track A, P2-03)
 *
 * Runs the real executor against the app DB with the Drive module
 * monkeypatched (no network): destination routing (all chats -> the chat's own
 * conversation scope, FC-01), overwrite-on-duplicate, validation failures, and
 * the Drive-less degrade. Cleans up after itself.
 *
 * Run with: node src/tools/test-createfile.js
 */

const assert = require('node:assert');
const { getDb, closeDb } = require('../db/connection');
const dal = require('../db/dal');
const drive = require('../utils/drive');
const config = require('../config');
const { executeCreateFile } = require('./createFile');

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

// --- Drive mock: capture uploads/deletes, hand back incrementing ids --------
let uploadSeq = 0;
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
  drive.ensureConversationFolder = async () => 'folder_conversation';
  drive.uploadFile = async ({ name }) => ({ id: `drive_${++uploadSeq}`, name });
  drive.deleteFile = async (auth, fileId) => { deletedIds.push(fileId); return true; };
}
function restoreDrive() {
  Object.assign(drive, realDrive);
}

(async () => {
  console.log('='.repeat(60));
  console.log('create_file Executor Test (P2-03)');
  console.log('='.repeat(60));

  const db = getDb();
  let userId;
  installDriveMock();

  try {
    const user = dal.createUser({ googleId: `cf-test-${Date.now()}`, email: 'cf@test.local' });
    userId = user.id;
    const workspace = dal.createWorkspace(userId, { name: 'WS', instructions: '' });
    const project = dal.createProject(userId, { workspaceId: workspace.id, name: 'PROJ', instructions: '' });

    // FC-01: created files land in the CHAT's own scope, so the ToolContext
    // needs a real conversation id (conversation_files has an FK to it). One
    // conversation per chat home so the "regardless of home" claim is exercised.
    const convProject = dal.createConversation(userId, { title: 'P', projectId: project.id, workspaceId: workspace.id });
    const convWorkspace = dal.createConversation(userId, { title: 'W', workspaceId: workspace.id });
    const convUnfiled = dal.createConversation(userId, { title: 'U' });

    const projectCtx = { userId, workspace, project, conversationId: convProject.id };
    const workspaceCtx = { userId, workspace, project: null, conversationId: convWorkspace.id };
    const unfiledCtx = { userId, workspace: null, project: null, conversationId: convUnfiled.id };

    console.log('\n1. Destination routing (all chats -> conversation scope)...');

    await check('project chat -> conversation_files + conversation url', async () => {
      const res = await executeCreateFile({ filename: 'notes.md', content: '# Hi' }, projectCtx);
      assert.ok(!res.isError, 'should succeed');
      assert.strictEqual(res.display.destination, 'conversation');
      const files = dal.listConversationFiles(convProject.id);
      assert.strictEqual(files.length, 1);
      assert.strictEqual(files[0].filename, 'notes.md');
      assert.strictEqual(files[0].mime_type, 'text/markdown');
      assert.strictEqual(res.display.url, `/api/conversations/${convProject.id}/files/${files[0].id}/content`);
      // NOT the curated project knowledge base.
      assert.strictEqual(dal.listProjectFiles(project.id).length, 0, 'project files untouched');
    });

    await check('workspace chat -> conversation_files (not workspace files)', async () => {
      const res = await executeCreateFile({ filename: 'shared.txt', content: 'x' }, workspaceCtx);
      assert.strictEqual(res.display.destination, 'conversation');
      const files = dal.listConversationFiles(convWorkspace.id);
      assert.strictEqual(files.length, 1);
      assert.strictEqual(res.display.url, `/api/conversations/${convWorkspace.id}/files/${files[0].id}/content`);
      assert.strictEqual(dal.listWorkspaceFiles(workspace.id).length, 0, 'workspace files untouched');
    });

    await check('unfiled chat -> conversation_files (not user/Downloads files)', async () => {
      const res = await executeCreateFile({ filename: 'draft.md', content: 'y' }, unfiledCtx);
      assert.strictEqual(res.display.destination, 'conversation');
      const files = dal.listConversationFiles(convUnfiled.id);
      assert.strictEqual(files.length, 1);
      assert.strictEqual(res.display.url, `/api/conversations/${convUnfiled.id}/files/${files[0].id}/content`);
      assert.strictEqual(dal.listUserFiles(userId).length, 0, 'Downloads files untouched');
    });

    console.log('\n2. Overwrite-on-duplicate (within the same chat)...');

    await check('same filename repoints the SAME row + deletes old Drive file', async () => {
      const first = dal.getConversationFileByName(convProject.id, 'notes.md');
      const firstDriveId = first.drive_file_id;
      deletedIds.length = 0;
      const res = await executeCreateFile({ filename: 'notes.md', content: '# Updated' }, projectCtx);
      assert.ok(res.display.overwritten, 'flagged overwritten');
      const rows = dal.listConversationFiles(convProject.id).filter((f) => f.filename === 'notes.md');
      assert.strictEqual(rows.length, 1, 'still exactly one row for the name');
      assert.strictEqual(rows[0].id, first.id, 'row id preserved (download links keep working)');
      assert.notStrictEqual(rows[0].drive_file_id, firstDriveId, 'points at new Drive file');
      assert.ok(deletedIds.includes(firstDriveId), 'old Drive file deleted');
    });

    console.log('\n3. Validation failures return isError (model can self-correct)...');

    const bad = [
      ['missing filename', { content: 'x' }],
      ['path traversal', { filename: '../secret.md', content: 'x' }],
      ['folder separator', { filename: 'sub/dir.md', content: 'x' }],
      ['no extension', { filename: 'README', content: 'x' }],
      ['disallowed extension', { filename: 'app.exe', content: 'x' }],
      ['pdf rejected (not text-authorable)', { filename: 'doc.pdf', content: 'x' }],
      ['non-string content', { filename: 'a.md', content: { not: 'string' } }],
    ];
    for (const [label, input] of bad) {
      await check(label, async () => {
        const res = await executeCreateFile(input, unfiledCtx);
        assert.ok(res.isError, 'should be an error result');
        assert.ok(!res.display, 'no file recorded');
      });
    }

    await check('valid name with spaces + hyphens is accepted', async () => {
      const res = await executeCreateFile({ filename: 'my data-2024.csv', content: 'a,b' }, unfiledCtx);
      assert.ok(!res.isError, `should accept: ${res.content}`);
      assert.strictEqual(res.display.mimeType, 'text/csv');
    });

    await check('oversize content rejected', async () => {
      const big = 'x'.repeat(config.projectFiles.maxFileBytes + 1);
      const res = await executeCreateFile({ filename: 'big.txt', content: big }, unfiledCtx);
      assert.ok(res.isError, 'should reject oversize');
    });

    console.log('\n4. Drive not connected -> readable isError, not a crash...');
    await check('drive-less user gets a clear error result', async () => {
      driveConnected = false;
      const res = await executeCreateFile({ filename: 'x.md', content: 'y' }, unfiledCtx);
      assert.ok(res.isError, 'should be an error');
      assert.match(res.content, /Google Drive is not connected/);
      driveConnected = true;
    });

    console.log('\n5. mime_type override + sanitization...');
    await check('explicit well-formed mime_type wins over extension default', async () => {
      const res = await executeCreateFile(
        { filename: 'weird.txt', content: 'x', mime_type: 'application/json' },
        unfiledCtx
      );
      assert.strictEqual(res.display.mimeType, 'application/json');
    });

    await check('malformed mime_type (header injection) is dropped for the extension default', async () => {
      const res = await executeCreateFile(
        { filename: 'inject.txt', content: 'x', mime_type: 'text/plain\r\nX-Injected: 1' },
        unfiledCtx
      );
      assert.ok(!res.isError, 'still creates the file');
      assert.strictEqual(res.display.mimeType, 'text/plain', 'falls back to extension MIME');
    });

    await check('mime_type with a parameter/semicolon is rejected too', async () => {
      const res = await executeCreateFile(
        { filename: 'param.txt', content: 'x', mime_type: 'text/plain; charset=utf-8' },
        unfiledCtx
      );
      assert.strictEqual(res.display.mimeType, 'text/plain');
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
    console.log('All create_file executor tests passed!');
  } else {
    console.log(`${failures} assertion(s) FAILED`);
  }
  console.log('='.repeat(60) + '\n');
  process.exit(failures === 0 ? 0 : 1);
})();
