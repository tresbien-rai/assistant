/**
 * Stale Drive Folder Self-Heal Test
 *
 * A project/workspace row stores its Drive folder id. If the user deletes or
 * trashes that folder in Drive, every upload into it failed with a generic
 * "Could not access Google Drive" error. ensureProjectFolderId /
 * ensureWorkspaceFolderId now check the stored folder and re-create it when
 * it is gone. Runs against the app DB with googleapis' Drive client mocked
 * (no network). Cleans up after itself.
 *
 * Run with: node src/utils/test-folderheal.js
 */

const assert = require('node:assert');
const { google } = require('googleapis');
const { getDb, closeDb } = require('../db/connection');
const dal = require('../db/dal');
const drive = require('./drive');

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

// --- googleapis mock: a tiny in-memory Drive of folders ---------------------
// folders: id -> { name, parent, trashed }
const folders = new Map();
let seq = 0;
let outage = false;

function httpError(status) {
  const err = new Error(`HTTP ${status}`);
  err.response = { status };
  return err;
}

const fakeDrive = {
  files: {
    async get({ fileId }) {
      if (outage) throw httpError(500);
      const f = folders.get(fileId);
      if (!f) throw httpError(404);
      return { data: { id: fileId, trashed: f.trashed } };
    },
    async list({ q }) {
      const name = /name='([^']*)'/.exec(q)[1];
      const parent = /'([^']*)' in parents/.exec(q)[1];
      const hit = [...folders].find(([, f]) => f.name === name && f.parent === parent && !f.trashed);
      return { data: { files: hit ? [{ id: hit[0], name }] : [] } };
    },
    async create({ requestBody }) {
      const id = `folder_${++seq}`;
      folders.set(id, { name: requestBody.name, parent: requestBody.parents?.[0] || 'root', trashed: false });
      return { data: { id } };
    },
  },
};

const realGoogleDrive = google.drive;

(async () => {
  console.log('='.repeat(60));
  console.log('Stale Drive Folder Self-Heal Test');
  console.log('='.repeat(60));

  const db = getDb();
  let userId;
  google.drive = () => fakeDrive;
  const auth = { credentials: {} };

  try {
    const user = dal.createUser({ googleId: `fh-test-${Date.now()}`, email: 'fh@test.local' });
    userId = user.id;
    const workspace = dal.createWorkspace(userId, { name: 'WS', instructions: '' });
    const project = dal.createProject(userId, { workspaceId: workspace.id, name: 'PROJ', instructions: '' });

    let projectFolder;
    await check('no stored folder -> created and persisted', async () => {
      projectFolder = await drive.ensureProjectFolderId(auth, userId, dal.getProjectById(project.id, userId));
      assert.ok(folders.has(projectFolder));
      assert.strictEqual(dal.getProjectById(project.id, userId).drive_folder_id, projectFolder);
    });

    await check('live stored folder -> reused, nothing new created', async () => {
      const before = folders.size;
      const id = await drive.ensureProjectFolderId(auth, userId, dal.getProjectById(project.id, userId));
      assert.strictEqual(id, projectFolder);
      assert.strictEqual(folders.size, before);
    });

    await check('deleted project folder (404) -> re-created and persisted', async () => {
      folders.delete(projectFolder);
      const id = await drive.ensureProjectFolderId(auth, userId, dal.getProjectById(project.id, userId));
      assert.notStrictEqual(id, projectFolder);
      assert.ok(folders.has(id));
      assert.strictEqual(dal.getProjectById(project.id, userId).drive_folder_id, id);
      projectFolder = id;
    });

    await check('trashed project folder -> re-created', async () => {
      folders.get(projectFolder).trashed = true;
      const id = await drive.ensureProjectFolderId(auth, userId, dal.getProjectById(project.id, userId));
      assert.notStrictEqual(id, projectFolder);
      assert.strictEqual(folders.get(id).trashed, false);
      projectFolder = id;
    });

    await check('deleted workspace folder -> both re-created, project nests under the new one', async () => {
      const ws = dal.getWorkspaceById(workspace.id, userId);
      folders.delete(ws.drive_folder_id);
      folders.delete(projectFolder);
      const id = await drive.ensureProjectFolderId(auth, userId, dal.getProjectById(project.id, userId));
      const newWs = dal.getWorkspaceById(workspace.id, userId).drive_folder_id;
      assert.notStrictEqual(newWs, ws.drive_folder_id);
      assert.strictEqual(folders.get(id).parent, newWs);
    });

    await check('a Drive outage is NOT mistaken for a gone folder', async () => {
      const before = dal.getProjectById(project.id, userId).drive_folder_id;
      outage = true;
      await assert.rejects(
        drive.ensureProjectFolderId(auth, userId, dal.getProjectById(project.id, userId)),
        (err) => err.code === 'DRIVE_ERROR'
      );
      outage = false;
      assert.strictEqual(dal.getProjectById(project.id, userId).drive_folder_id, before);
    });
  } finally {
    google.drive = realGoogleDrive;
    if (userId) db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    closeDb();
  }

  console.log('\n' + '='.repeat(60));
  if (failures === 0) {
    console.log('All folder self-heal tests passed.');
  } else {
    console.log(`${failures} folder self-heal test(s) FAILED.`);
    process.exitCode = 1;
  }
})();
