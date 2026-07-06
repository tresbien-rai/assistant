/**
 * create_file Executor Test (Track A, P2-03)
 *
 * Runs the real executor against the app DB with the Drive module
 * monkeypatched (no network): destination routing (project / workspace /
 * Downloads), overwrite-on-duplicate, validation failures, and the
 * Drive-less degrade. Cleans up after itself.
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

    const projectCtx = { userId, workspace, project, conversationId: 'c1' };
    const workspaceCtx = { userId, workspace, project: null, conversationId: 'c2' };
    const unfiledCtx = { userId, workspace: null, project: null, conversationId: 'c3' };

    console.log('\n1. Destination routing...');

    await check('project chat -> project_files + project url', async () => {
      const res = await executeCreateFile({ filename: 'notes.md', content: '# Hi' }, projectCtx);
      assert.ok(!res.isError, 'should succeed');
      assert.strictEqual(res.display.destination, 'project');
      const files = dal.listProjectFiles(project.id);
      assert.strictEqual(files.length, 1);
      assert.strictEqual(files[0].filename, 'notes.md');
      assert.strictEqual(files[0].mime_type, 'text/markdown');
      assert.strictEqual(res.display.url, `/api/projects/${project.id}/files/${files[0].id}/content`);
    });

    await check('workspace chat (no project) -> workspace_files', async () => {
      const res = await executeCreateFile({ filename: 'shared.txt', content: 'x' }, workspaceCtx);
      assert.strictEqual(res.display.destination, 'workspace');
      const files = dal.listWorkspaceFiles(workspace.id);
      assert.strictEqual(files.length, 1);
      assert.strictEqual(res.display.url, `/api/workspaces/${workspace.id}/files/${files[0].id}/content`);
    });

    await check('unfiled chat -> user_files + /api/files url', async () => {
      const res = await executeCreateFile({ filename: 'draft.md', content: 'y' }, unfiledCtx);
      assert.strictEqual(res.display.destination, 'downloads');
      const files = dal.listUserFiles(userId);
      assert.strictEqual(files.length, 1);
      assert.strictEqual(res.display.url, `/api/files/${files[0].id}/content`);
    });

    console.log('\n2. Overwrite-on-duplicate...');

    await check('same filename repoints the SAME row + deletes old Drive file', async () => {
      const first = dal.getProjectFileByName(project.id, 'notes.md');
      const firstDriveId = first.drive_file_id;
      deletedIds.length = 0;
      const res = await executeCreateFile({ filename: 'notes.md', content: '# Updated' }, projectCtx);
      assert.ok(res.display.overwritten, 'flagged overwritten');
      const rows = dal.listProjectFiles(project.id).filter((f) => f.filename === 'notes.md');
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

    console.log('\n5. mime_type override is honored...');
    await check('explicit mime_type wins over extension default', async () => {
      const res = await executeCreateFile(
        { filename: 'weird.txt', content: 'x', mime_type: 'application/json' },
        unfiledCtx
      );
      assert.strictEqual(res.display.mimeType, 'application/json');
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
