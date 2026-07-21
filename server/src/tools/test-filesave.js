/**
 * saveTextOverFile Test (edit-in-context slice 3)
 *
 * Runs the shared user-save write path against the app DB with the Drive
 * module monkeypatched (no network): saving over conversation / project /
 * workspace / user files (row id + URL stable, old Drive file replaced), and
 * the validation failures the PUT routes map to 400s (non-string content,
 * non-editable type, size cap). Each store kind is built exactly as its route
 * builds it (resolveFileStore with the matching ctx). Cleans up after itself.
 *
 * Run with: node src/tools/test-filesave.js
 */

const assert = require('node:assert');
const { getDb, closeDb } = require('../db/connection');
const dal = require('../db/dal');
const drive = require('../utils/drive');
const config = require('../config');
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
const deletedIds = [];

const realDrive = { ...drive };
function installDriveMock() {
  drive.getAuthForUser = () => ({ mock: true });
  drive.ensureProjectFolderId = async () => 'folder_project';
  drive.ensureWorkspaceFolderId = async () => 'folder_workspace';
  drive.ensureDownloadsFolder = async () => 'folder_downloads';
  drive.ensureConversationFolder = async () => 'folder_conversation';
  drive.uploadFile = async (auth, { name, data }) => {
    const id = `drive_${++uploadSeq}`;
    contents.set(id, Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    return { id, name };
  };
  drive.deleteFile = async (auth, fileId) => { deletedIds.push(fileId); return true; };
}
function restoreDrive() {
  Object.assign(drive, realDrive);
}

(async () => {
  console.log('='.repeat(60));
  console.log('saveTextOverFile Test (slice 3)');
  console.log('='.repeat(60));

  const db = getDb();
  let userId;
  installDriveMock();

  try {
    const user = dal.createUser({ googleId: `fs-test-${Date.now()}`, email: 'fs@test.local' });
    userId = user.id;
    const workspace = dal.createWorkspace(userId, { name: 'WS', instructions: '' });
    const project = dal.createProject(userId, { workspaceId: workspace.id, name: 'PROJ', instructions: '' });
    const auth = { mock: true };

    const conv = dal.createConversation(userId, { title: 'C', projectId: project.id, workspaceId: workspace.id });

    // Build each store kind the way its route does: conversation saves pass a
    // conversationId (FC-01), while project/workspace/Downloads saves pass the
    // container (and no conversationId).
    const stores = [
      ['conversation', resolveFileStore({ userId, conversationId: conv.id })],
      ['project', resolveFileStore({ userId, project, workspace: null })],
      ['workspace', resolveFileStore({ userId, workspace, project: null })],
      ['downloads', resolveFileStore({ userId })],
    ];

    console.log('\n1. Saving over each store kind...');

    for (const [label, store] of stores) {
      await check(`${label}: save replaces content, keeps row id, deletes old Drive file`, async () => {
        // Seed an initial file directly in this store (stands in for a prior
        // write), then save user text over it via the shared path.
        const seedDriveId = `seed_${label}`;
        contents.set(seedDriveId, 'model version');
        const before = store.add({
          filename: 'save.md', mimeType: 'text/markdown',
          sizeBytes: Buffer.byteLength('model version'), driveFileId: seedDriveId,
        });
        const oldDriveId = before.drive_file_id;

        const result = await saveTextOverFile(auth, store, before, 'user version', userId);
        assert.strictEqual(result.ok, true, result.reason);

        const after = store.findByName('save.md');
        assert.strictEqual(after.id, before.id, 'row id must be stable');
        assert.notStrictEqual(after.drive_file_id, oldDriveId, 'a new Drive id must be minted');
        assert.strictEqual(contents.get(after.drive_file_id), 'user version');
        assert.ok(deletedIds.includes(oldDriveId), 'old Drive file should be deleted');
        assert.strictEqual(after.size_bytes, Buffer.byteLength('user version'));
      });
    }

    console.log('\n2. Validation failures (mapped to 400s by the routes)...');

    const store = resolveFileStore({ userId, project, workspace: null });
    const row = dal.getProjectFileByName(project.id, 'save.md');

    await check('non-string content is rejected', async () => {
      const result = await saveTextOverFile(auth, store, row, { nope: true }, userId);
      assert.strictEqual(result.ok, false);
      assert.ok(result.reason.includes('string'), result.reason);
    });

    await check('non-text-editable file type (.pdf) is rejected', async () => {
      const pdfRow = dal.addProjectFile(project.id, {
        filename: 'doc.pdf', mimeType: 'application/pdf', sizeBytes: 10, driveFileId: 'drive_pdf_x',
      });
      const result = await saveTextOverFile(auth, store, pdfRow, 'text', userId);
      assert.strictEqual(result.ok, false);
      assert.ok(result.reason.includes('cannot be edited'), result.reason);
    });

    await check('oversized content is rejected and leaves the file untouched', async () => {
      const huge = 'x'.repeat(config.projectFiles.maxFileBytes + 10);
      const result = await saveTextOverFile(auth, store, row, huge, userId);
      assert.strictEqual(result.ok, false);
      const after = dal.getProjectFileByName(project.id, 'save.md');
      assert.strictEqual(contents.get(after.drive_file_id), 'user version');
    });
  } catch (err) {
    console.error('\n✗ Test crashed:', err);
    failures++;
  } finally {
    restoreDrive();
    if (userId) db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    closeDb();
  }

  console.log('\n' + '='.repeat(60));
  if (failures === 0) {
    console.log('All saveTextOverFile tests passed!');
  } else {
    console.log(`${failures} assertion(s) FAILED`);
  }
  console.log('='.repeat(60) + '\n');
  process.exit(failures === 0 ? 0 : 1);
})();
