/**
 * Conversation Drive cleanup Test (File Collaboration)
 *
 * Runs the real `trashConversationFiles` orchestrator against the app DB with
 * the Drive module monkeypatched (no network): the folder-level trash path, the
 * per-file fallback when the folder can't be resolved, the no-op skip for a
 * file-less chat, and the Drive-down degrade (never throws, DB delete still
 * proceeds). Also confirms the `conversation_files` rows cascade away with the
 * conversation. Cleans up after itself.
 *
 * Run with: node src/tools/test-convdelete.js
 */

const assert = require('node:assert');
const { getDb, closeDb } = require('../db/connection');
const dal = require('../db/dal');
const drive = require('../utils/drive');
const { trashConversationFiles } = require('./conversationCleanup');

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

// --- Drive mock: record trashed ids; folder id + connectivity configurable ---
let trashedIds = [];
let authCalls = 0;
let driveConnected = true;
let folderIdToReturn = null; // what findConversationFolder resolves to

const realDrive = { ...drive };
function installDriveMock() {
  drive.getAuthForUser = () => {
    authCalls += 1;
    if (!driveConnected) {
      const err = new Error('Drive not connected');
      err.code = 'DRIVE_ERROR';
      throw err;
    }
    return { mock: true };
  };
  drive.findConversationFolder = async () => folderIdToReturn;
  drive.trashFile = async (auth, fileId) => { trashedIds.push(fileId); return true; };
}
function restoreDrive() {
  Object.assign(drive, realDrive);
}

function resetMockState() {
  trashedIds = [];
  authCalls = 0;
  driveConnected = true;
  folderIdToReturn = null;
}

// Seed a conversation with N created files (rows + fake Drive ids).
function seedConversation(userId, count) {
  const conv = dal.createConversation(userId, { title: 'C' });
  const driveIds = [];
  for (let i = 0; i < count; i++) {
    const driveFileId = `drive_${conv.id}_${i}`;
    driveIds.push(driveFileId);
    dal.addConversationFile(conv.id, {
      filename: `f${i}.md`, mimeType: 'text/markdown', sizeBytes: 10, driveFileId,
    });
  }
  return { conv, driveIds };
}

(async () => {
  console.log('='.repeat(60));
  console.log('Conversation Drive cleanup Test');
  console.log('='.repeat(60));

  const db = getDb();
  let userId;
  installDriveMock();

  try {
    const user = dal.createUser({ googleId: `cd-test-${Date.now()}`, email: 'cd@test.local' });
    userId = user.id;

    console.log('\n1. Cleanup paths...');

    await check('folder resolves -> trashes the folder once (recursively covers files)', async () => {
      resetMockState();
      folderIdToReturn = 'folder_chat_1';
      const { conv } = seedConversation(userId, 3);

      const summary = await trashConversationFiles(userId, conv.id);
      assert.strictEqual(summary.folder, true, 'should take the folder path');
      assert.strictEqual(summary.trashed, 3, 'reports the file count cleaned');
      assert.deepStrictEqual(trashedIds, ['folder_chat_1'], 'exactly the folder is trashed');
    });

    await check('folder missing -> falls back to trashing each file id', async () => {
      resetMockState();
      folderIdToReturn = null; // folder can't be resolved
      const { conv, driveIds } = seedConversation(userId, 2);

      const summary = await trashConversationFiles(userId, conv.id);
      assert.strictEqual(summary.folder, false, 'should take the fallback path');
      assert.strictEqual(summary.trashed, 2);
      assert.deepStrictEqual(trashedIds.sort(), driveIds.sort(), 'each file id trashed individually');
    });

    await check('file-less chat -> skipped, no Drive calls at all', async () => {
      resetMockState();
      const conv = dal.createConversation(userId, { title: 'empty' });

      const summary = await trashConversationFiles(userId, conv.id);
      assert.strictEqual(summary.skipped, true);
      assert.strictEqual(authCalls, 0, 'must not even build Drive auth for a file-less chat');
      assert.strictEqual(trashedIds.length, 0);
    });

    console.log('\n2. Resilience...');

    await check('Drive disconnected -> never throws, reports error, no crash', async () => {
      resetMockState();
      driveConnected = false;
      folderIdToReturn = 'folder_chat_x';
      const { conv } = seedConversation(userId, 2);

      const summary = await trashConversationFiles(userId, conv.id);
      assert.strictEqual(summary.error, 'DRIVE_ERROR', 'swallows the Drive error');
      assert.strictEqual(trashedIds.length, 0, 'nothing trashed when Drive is down');
    });

    console.log('\n3. DB rows cascade away with the conversation...');

    await check('deleteConversation removes the conversation_files rows', async () => {
      resetMockState();
      folderIdToReturn = 'folder_chat_c';
      const { conv } = seedConversation(userId, 2);
      assert.strictEqual(dal.listConversationFiles(conv.id).length, 2, 'seeded rows present');

      // The route calls these in order; assert the DB result of the second.
      await trashConversationFiles(userId, conv.id);
      const deleted = dal.deleteConversation(conv.id, userId);

      assert.strictEqual(deleted, true);
      assert.strictEqual(dal.listConversationFiles(conv.id).length, 0, 'file rows cascade-deleted');
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
    console.log('All conversation cleanup tests passed!');
  } else {
    console.log(`${failures} assertion(s) FAILED`);
  }
  console.log('='.repeat(60) + '\n');
  process.exit(failures === 0 ? 0 : 1);
})();
