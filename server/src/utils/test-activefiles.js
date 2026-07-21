/**
 * Active-file Injection Test (File Collaboration, FC-03b)
 *
 * Exercises turn stamping + the recency-scoped injection: a created/edited chat
 * file is stamped with the write turn, resolveActiveFileBlock injects its full
 * current content + latest diff only inside the activeFileTurns window, and the
 * append/windowing helpers behave. Drive is monkeypatched with an in-memory
 * content store. Cleans up after itself.
 *
 * Run with: node src/utils/test-activefiles.js
 */

const assert = require('node:assert');
const { getDb, closeDb } = require('../db/connection');
const dal = require('../db/dal');
const drive = require('../utils/drive');
const projectContext = require('../utils/projectContext');
const { executeCreateFile } = require('../tools/createFile');
const { executeEditFile } = require('../tools/editFile');
const {
  resolveActiveFileBlock,
  appendToLastUserMessage,
  _selectActiveRevisions,
} = require('./activeFiles');

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
  console.log('Active-file Injection Test (FC-03b)');
  console.log('='.repeat(60));

  const db = getDb();
  let userId;
  installDriveMock();
  const clearCache = () => projectContext._textCache.clear();

  try {
    console.log('\n1. appendToLastUserMessage (pure)...');
    await check('appends to a string user message', () => {
      const out = appendToLastUserMessage(
        [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'more' }],
        'BLOCK'
      );
      assert.strictEqual(out[2].content, 'more\n\nBLOCK');
      assert.strictEqual(out[0].content, 'hi', 'earlier user message untouched');
    });
    await check('appends a text block to array content', () => {
      const out = appendToLastUserMessage([{ role: 'user', content: [{ type: 'text', text: 'q' }] }], 'BLOCK');
      assert.deepStrictEqual(out[0].content[1], { type: 'text', text: 'BLOCK' });
    });
    await check('no user message → unchanged', () => {
      const msgs = [{ role: 'assistant', content: 'x' }];
      assert.strictEqual(appendToLastUserMessage(msgs, 'BLOCK'), msgs);
    });

    console.log('\n2. selectActiveRevisions windowing (pure)...');
    await check('keeps latest per file within [1, N]', () => {
      const revs = [
        { file_id: 'a', turn: 5 }, // age 1
        { file_id: 'b', turn: 4 }, // age 2
        { file_id: 'a', turn: 3 }, // older dup of a → ignored
        { file_id: 'c', turn: 1 }, // age 5 → out
        { file_id: 'd', turn: null }, // unstamped → out
      ];
      const picked = _selectActiveRevisions(revs, 6, 2).map((r) => r.file_id);
      assert.deepStrictEqual(picked, ['a', 'b']);
    });

    console.log('\n3. end-to-end injection window...');
    const user = dal.createUser({ googleId: `af-${Date.now()}`, email: 'af@test.local' });
    userId = user.id;
    const conv = dal.createConversation(userId, { title: 'C' });
    const ctx = (turn) => ({ userId, workspace: null, project: null, conversationId: conv.id, turnOrdinal: turn });

    await check('create_file stamps the write turn on its revision', async () => {
      const res = await executeCreateFile({ filename: 'notes.md', content: 'hello world' }, ctx(1));
      assert.ok(!res.isError, res.content);
      const f = dal.getConversationFileByName(conv.id, 'notes.md');
      const revs = dal.listFileRevisions('conversation', f.id);
      assert.strictEqual(revs[revs.length - 1].turn, 1, 'revision stamped with turn 1');
    });

    await check('live on the next turn (age 1, N=1): full content + diff injected', async () => {
      clearCache();
      const block = await resolveActiveFileBlock(userId, conv.id, 2, 1);
      assert.ok(block, 'expected a block');
      assert.match(block, /<active_files>/);
      assert.match(block, /name="notes\.md"/);
      assert.match(block, /hello world/, 'current content present');
      assert.match(block, /<latest_diff>/, 'latest diff present');
    });

    await check('falls out the turn after (age 2, N=1 → null)', async () => {
      clearCache();
      const block = await resolveActiveFileBlock(userId, conv.id, 3, 1);
      assert.strictEqual(block, null);
    });

    await check('a wider window keeps it (age 2, N=2 → injected)', async () => {
      clearCache();
      const block = await resolveActiveFileBlock(userId, conv.id, 3, 2);
      assert.ok(block && block.includes('notes.md'));
    });

    await check('activeFileTurns=0 disables injection', async () => {
      clearCache();
      assert.strictEqual(await resolveActiveFileBlock(userId, conv.id, 2, 0), null);
    });

    console.log('\n4. an edit refreshes current content + diff...');
    await check('edited content and the -old/+new diff are what get injected', async () => {
      const res = await executeEditFile({ filename: 'notes.md', old_text: 'world', new_text: 'there' }, ctx(2));
      assert.ok(!res.isError, res.content);
      clearCache();
      const block = await resolveActiveFileBlock(userId, conv.id, 3, 1); // edit at turn 2, now turn 3 → age 1
      assert.ok(block, 'expected a block after edit');
      assert.match(block, /hello there/, 'shows current (edited) content');
      assert.match(block, /-hello world/, 'diff shows the old line');
      assert.match(block, /\+hello there/, 'diff shows the new line');
    });

    console.log('\n5. injection is conversation-scoped (Drive-less → no crash)...');
    await check('Drive unavailable → null, never throws', async () => {
      const saved = drive.getAuthForUser;
      drive.getAuthForUser = () => { const e = new Error('no drive'); e.code = 'DRIVE_ERROR'; throw e; };
      try {
        clearCache();
        const block = await resolveActiveFileBlock(userId, conv.id, 3, 5);
        assert.strictEqual(block, null);
      } finally {
        drive.getAuthForUser = saved;
      }
    });

  } catch (err) {
    console.error('\n✗ Active-file test crashed:', err);
    failures++;
  } finally {
    restoreDrive();
    if (userId) db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    closeDb();
  }

  console.log('\n' + '='.repeat(60));
  console.log(failures === 0 ? 'All active-file injection tests passed!' : `${failures} assertion(s) FAILED`);
  console.log('='.repeat(60) + '\n');
  process.exit(failures === 0 ? 0 : 1);
})();
