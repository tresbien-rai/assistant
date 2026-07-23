/**
 * User upload -> conversation working file test (CF-02)
 *
 * Exercises the write path behind POST /api/conversations/:id/files: a text
 * upload written into the conversation scope as a USER-authored revision stamped
 * at a given turn, so FC-03b injects it on the turn it was uploaded. Drive is
 * monkeypatched (no network). Cleans up after itself.
 *
 * Run with: node src/tools/test-convupload.js
 */

const assert = require('node:assert');
const { getDb, closeDb } = require('../db/connection');
const dal = require('../db/dal');
const drive = require('../utils/drive');
const { resolveFileStore } = require('./fileStore');
const { writeContentToStore } = require('./storeWriter');
const { validateFilename, resolveMime } = require('./createFile');

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

let uploadSeq = 0;
const deletedIds = [];
const realDrive = { ...drive };
function installDriveMock() {
  drive.getAuthForUser = () => ({ mock: true });
  drive.ensureConversationFolder = async () => 'folder_conversation';
  drive.uploadFile = async ({ name }) => ({ id: `drive_${++uploadSeq}`, name });
  drive.deleteFile = async (auth, fileId) => { deletedIds.push(fileId); return true; };
}
function restoreDrive() {
  Object.assign(drive, realDrive);
}

// Mirror the route: validate + resolveMime, then write to the conversation store
// with a user-authored revision stamped at the current user-message count.
async function uploadWorkingFile(userId, conversationId, filename, content, mimeType) {
  const check = validateFilename(filename);
  assert.ok(check.ok, `filename should validate: ${check.reason || ''}`);
  const bytes = Buffer.from(content, 'utf8');
  const store = resolveFileStore({ userId, conversationId });
  return writeContentToStore(drive.getAuthForUser(userId), store, {
    filename: check.name,
    mimeType: resolveMime(mimeType, check.ext),
    bytes,
    userId,
    revision: { author: 'user', conversationId, turn: dal.countUserMessages(conversationId) },
  });
}

(async () => {
  console.log('='.repeat(60));
  console.log('User upload -> conversation working file test (CF-02)');
  console.log('='.repeat(60));

  const db = getDb();
  let userId;
  installDriveMock();

  try {
    const user = dal.createUser({ googleId: `cu-test-${Date.now()}`, email: 'cu@test.local' });
    userId = user.id;
    const conv = dal.createConversation(userId, { title: 'C' });

    console.log('\n1. A text upload becomes a conversation working file...');
    await check('creates a conversation_files row', async () => {
      const { record, overwritten } = await uploadWorkingFile(userId, conv.id, 'notes.md', '# Hello');
      assert.ok(!overwritten, 'fresh file is not an overwrite');
      const files = dal.listConversationFiles(conv.id);
      assert.strictEqual(files.length, 1);
      assert.strictEqual(files[0].id, record.id);
      assert.strictEqual(files[0].filename, 'notes.md');
      assert.strictEqual(files[0].mime_type, 'text/markdown');
    });

    await check('logs a USER-authored create revision at the current turn (0)', async () => {
      const file = dal.getConversationFileByName(conv.id, 'notes.md');
      const revs = dal.listFileRevisions('conversation', file.id);
      assert.strictEqual(revs.length, 1, 'exactly one revision so far');
      assert.strictEqual(revs[0].author, 'user');
      assert.strictEqual(revs[0].op, 'create');
      assert.strictEqual(revs[0].turn, 0, 'stamped at the pre-message user count');
      assert.ok(revs[0].content != null, 'snapshot stored (restorable)');
    });

    console.log('\n2. The turn stamp tracks the user-message count...');
    await check('a later upload stamps the higher turn', async () => {
      // Simulate a couple of exchanges having happened.
      dal.createMessage(conv.id, { role: 'user', content: 'hi' });
      dal.createMessage(conv.id, { role: 'assistant', content: 'hello' });
      assert.strictEqual(dal.countUserMessages(conv.id), 1, 'one user message now');
      await uploadWorkingFile(userId, conv.id, 'second.txt', 'later');
      const file = dal.getConversationFileByName(conv.id, 'second.txt');
      const revs = dal.listFileRevisions('conversation', file.id);
      assert.strictEqual(revs[0].turn, 1, 'stamped at the current user count');
    });

    console.log('\n3. Re-uploading the same name overwrites (keeps the row + history)...');
    await check('same name repoints the row and logs an overwrite revision', async () => {
      const before = dal.getConversationFileByName(conv.id, 'notes.md');
      deletedIds.length = 0;
      const { record, overwritten } = await uploadWorkingFile(userId, conv.id, 'notes.md', '# Hello v2');
      assert.ok(overwritten, 'flagged overwritten');
      assert.strictEqual(record.id, before.id, 'row id preserved');
      assert.notStrictEqual(record.drive_file_id, before.drive_file_id, 'points at new Drive file');
      assert.ok(deletedIds.includes(before.drive_file_id), 'old Drive file deleted');
      // listFileRevisions is oldest-first (the panel reverses it for display).
      const revs = dal.listFileRevisions('conversation', before.id);
      assert.strictEqual(revs.length, 2, 'create + overwrite');
      const newest = revs[revs.length - 1];
      assert.strictEqual(newest.op, 'overwrite', 'newest is the overwrite');
      assert.strictEqual(newest.author, 'user');
    });

    console.log('\n4. PDF is rejected before any write (text-authorable only)...');
    await check('validateFilename rejects .pdf', async () => {
      const res = validateFilename('doc.pdf');
      assert.ok(!res.ok, 'pdf should not validate as text-authorable');
    });

  } catch (err) {
    console.error('\n✗ CF-02 upload test crashed:', err);
    failures++;
  } finally {
    restoreDrive();
    if (userId) db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    closeDb();
  }

  console.log('\n' + '='.repeat(60));
  if (failures === 0) {
    console.log('All CF-02 upload tests passed!');
  } else {
    console.log(`${failures} assertion(s) FAILED`);
  }
  console.log('='.repeat(60) + '\n');
  process.exit(failures === 0 ? 0 : 1);
})();
