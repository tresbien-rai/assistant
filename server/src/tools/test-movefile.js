/**
 * move_file Executor Test (File Collaboration, FC-05)
 *
 * Runs the real executor against the app DB with Drive monkeypatched (no
 * network): promoting a chat file into a project (row moves, Drive file
 * reparented, source row + revisions removed), destination validation,
 * not-found / already-there guards, overwrite of a same-name destination file,
 * and the Drive-less degrade. Cleans up after itself.
 *
 * Run with: node src/tools/test-movefile.js
 */

const assert = require('node:assert');
const { getDb, closeDb } = require('../db/connection');
const dal = require('../db/dal');
const drive = require('../utils/drive');
const { executeCreateFile } = require('./createFile');
const { executeMoveFile } = require('./moveFile');

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

// --- Drive mock: record reparents/trashes, mint upload ids ------------------
let uploadSeq = 0;
const moved = [];   // { fileId, destFolder }
const trashed = [];
let driveConnected = true;
const realDrive = { ...drive };
function installDriveMock() {
  drive.getAuthForUser = () => {
    if (!driveConnected) { const e = new Error('no drive'); e.code = 'DRIVE_ERROR'; throw e; }
    return { mock: true };
  };
  drive.ensureProjectFolderId = async () => 'folder_project';
  drive.ensureWorkspaceFolderId = async () => 'folder_workspace';
  drive.ensureDownloadsFolder = async () => 'folder_downloads';
  drive.ensureConversationFolder = async () => 'folder_conversation';
  drive.uploadFile = async (auth, { name }) => ({ id: `drive_${++uploadSeq}`, name });
  drive.moveFileToFolder = async (auth, fileId, destFolder) => { moved.push({ fileId, destFolder }); return true; };
  drive.trashFile = async (auth, fileId) => { trashed.push(fileId); return true; };
  drive.deleteFile = async () => true;
}
function restoreDrive() { Object.assign(drive, realDrive); }

(async () => {
  console.log('='.repeat(60));
  console.log('move_file Executor Test (FC-05)');
  console.log('='.repeat(60));

  const db = getDb();
  let userId;
  installDriveMock();

  try {
    const user = dal.createUser({ googleId: `mv-${Date.now()}`, email: 'mv@test.local' });
    userId = user.id;
    const workspace = dal.createWorkspace(userId, { name: 'WS', instructions: '' });
    const project = dal.createProject(userId, { workspaceId: workspace.id, name: 'PROJ', instructions: '' });
    const convProject = dal.createConversation(userId, { title: 'P', projectId: project.id, workspaceId: workspace.id });
    const convUnfiled = dal.createConversation(userId, { title: 'U' });

    const projectCtx = { userId, workspace, project, conversationId: convProject.id, turnOrdinal: 1 };
    const unfiledCtx = { userId, workspace: null, project: null, conversationId: convUnfiled.id, turnOrdinal: 1 };

    console.log('\n1. Promote a chat file into the project...');
    await check('moves the row + reparents Drive file + clears source row & revisions', async () => {
      const created = await executeCreateFile({ filename: 'notes.md', content: '# Notes' }, projectCtx);
      assert.ok(!created.isError, created.content);
      const src = dal.getConversationFileByName(convProject.id, 'notes.md');
      const srcDriveId = src.drive_file_id;
      assert.ok(dal.listFileRevisions('conversation', src.id).length >= 1, 'source had a revision');
      moved.length = 0;

      const res = await executeMoveFile({ filename: 'notes.md', destination: 'project' }, projectCtx);
      assert.ok(!res.isError, res.content);
      assert.strictEqual(res.display.from, 'conversation');
      assert.strictEqual(res.display.destination, 'project');

      // Source gone, destination present with the SAME Drive id.
      assert.strictEqual(dal.getConversationFileByName(convProject.id, 'notes.md'), undefined, 'source row removed');
      const proj = dal.getProjectFileByName(project.id, 'notes.md');
      assert.ok(proj, 'project row created');
      assert.strictEqual(proj.drive_file_id, srcDriveId, 'kept the same Drive file id');
      assert.strictEqual(res.display.url, `/api/projects/${project.id}/files/${proj.id}/content`);

      // Drive reparented into the project folder; source revisions cleared.
      assert.ok(moved.some((m) => m.fileId === srcDriveId && m.destFolder === 'folder_project'), 'reparented on Drive');
      assert.strictEqual(dal.listFileRevisions('conversation', src.id).length, 0, 'source revisions cleared');
    });

    console.log('\n2. Guards...');
    await check('destination not reachable from an unfiled chat -> isError', async () => {
      await executeCreateFile({ filename: 'draft.md', content: 'x' }, unfiledCtx);
      const res = await executeMoveFile({ filename: 'draft.md', destination: 'project' }, unfiledCtx);
      assert.ok(res.isError);
      assert.match(res.content, /not in a project/);
    });

    await check('missing source file -> isError', async () => {
      const res = await executeMoveFile({ filename: 'ghost.md', destination: 'project' }, projectCtx);
      assert.ok(res.isError);
      assert.match(res.content, /No file named/);
    });

    await check('already in the destination -> isError', async () => {
      // notes.md now lives in the project; moving it there again is a no-op.
      const res = await executeMoveFile({ filename: 'notes.md', destination: 'project' }, projectCtx);
      assert.ok(res.isError);
      assert.match(res.content, /already in/);
    });

    await check('invalid destination -> isError', async () => {
      await executeCreateFile({ filename: 'thing.md', content: 'x' }, projectCtx);
      const res = await executeMoveFile({ filename: 'thing.md', destination: 'nowhere' }, projectCtx);
      assert.ok(res.isError);
      assert.match(res.content, /destination/);
    });

    console.log('\n3. Overwrite a same-name file in the destination...');
    await check('destination clash is overwritten (old Drive file trashed)', async () => {
      // Seed a curated project file, then create a chat file of the same name.
      dal.addProjectFile(project.id, { filename: 'dup.md', mimeType: 'text/markdown', sizeBytes: 3, driveFileId: 'old_proj_dup' });
      const created = await executeCreateFile({ filename: 'dup.md', content: 'chat version' }, projectCtx);
      assert.ok(!created.isError);
      const chatDup = dal.getConversationFileByName(convProject.id, 'dup.md');
      trashed.length = 0;

      const res = await executeMoveFile({ filename: 'dup.md', destination: 'project' }, projectCtx);
      assert.ok(!res.isError, res.content);
      assert.strictEqual(res.display.overwritten, true);
      // Exactly one project dup.md, now pointing at the chat file's Drive id.
      const rows = dal.listProjectFiles(project.id).filter((f) => f.filename === 'dup.md');
      assert.strictEqual(rows.length, 1, 'one dup.md remains');
      assert.strictEqual(rows[0].drive_file_id, chatDup.drive_file_id, 'points at the promoted file');
      assert.ok(trashed.includes('old_proj_dup'), 'old destination Drive file trashed');
    });

    console.log('\n4. Drive-less degrade...');
    await check('no Drive connection -> friendly isError, not a crash', async () => {
      // Seed the source row directly (create_file also needs Drive).
      dal.addConversationFile(convProject.id, { filename: 'seed.md', mimeType: 'text/markdown', sizeBytes: 1, driveFileId: 'd_seed' });
      driveConnected = false;
      const res = await executeMoveFile({ filename: 'seed.md', destination: 'project' }, projectCtx);
      driveConnected = true;
      assert.ok(res.isError);
      assert.match(res.content, /Google Drive/);
    });

  } catch (err) {
    console.error('\n✗ move_file test crashed:', err);
    failures++;
  } finally {
    restoreDrive();
    if (userId) db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    closeDb();
  }

  console.log('\n' + '='.repeat(60));
  console.log(failures === 0 ? 'All move_file executor tests passed!' : `${failures} assertion(s) FAILED`);
  console.log('='.repeat(60) + '\n');
  process.exit(failures === 0 ? 0 : 1);
})();
