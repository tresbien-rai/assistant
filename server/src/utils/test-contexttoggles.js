/**
 * Context Toggle Injection Test (Context toggles, CT-02)
 *
 * CT-01 stored the state; this exercises the three places that now READ it:
 *   1. the knowledge-base assembler — disabled files are not downloaded, and
 *      their names appear in <available_files> only when file tools are on
 *   2. active-file injection — pin bypasses the recency window, mute overrides it
 *   3. list_files — not-loaded files say so, so the model isn't left guessing
 *
 * Drive is monkeypatched with an in-memory content store (same approach as
 * test-activefiles.js), so real file CONTENT can be asserted present/absent
 * rather than just the surrounding scaffolding. Cleans up after itself.
 *
 * Run with: node src/utils/test-contexttoggles.js
 */

const assert = require('node:assert');
const { getDb, closeDb } = require('../db/connection');
const dal = require('../db/dal');
const drive = require('./drive');
const projectContext = require('./projectContext');
const { resolveActiveFileBlock } = require('./activeFiles');
const { executeListFiles } = require('../tools/readFiles');
const { resolveRequestContext } = require('../routes/chat');

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

// --- Drive mock: in-memory content keyed by the drive id we assign ----------
const contents = new Map();
const realDrive = { ...drive };
function installDriveMock() {
  drive.getAuthForUser = () => ({ mock: true });
  drive.downloadFileBytes = async (auth, fileId) => {
    if (!contents.has(fileId)) throw new Error(`no such mock file ${fileId}`);
    return Buffer.from(contents.get(fileId), 'utf8');
  };
}
function restoreDrive() {
  Object.assign(drive, realDrive);
}

/** Register mock content and return the drive id to store on the row. */
let driveSeq = 0;
function mockDriveFile(text) {
  const id = `drv_${++driveSeq}`;
  contents.set(id, text);
  return id;
}

// The assembler caches extracted text per Drive id; toggling doesn't change a
// file's bytes, so the cache is fine in production — but between assertions we
// clear it so a miss is a real miss.
const clearCache = () => projectContext._textCache.clear();

const reqFor = (userId, body) => ({ user: { userId }, body });

(async () => {
  console.log('='.repeat(60));
  console.log('Context Toggle Injection Test (CT-02)');
  console.log('='.repeat(60));

  const db = getDb();
  let userId;
  installDriveMock();

  try {
    const user = dal.createUser({ googleId: `ctog-${Date.now()}`, email: 'ctog@test.local' });
    userId = user.id;

    const workspace = dal.createWorkspace(userId, { name: 'WS', instructions: 'WS_INSTRUCTIONS' });
    const wsChat = dal.createConversation(userId, { title: 'w', workspaceId: workspace.id });
    const otherChat = dal.createConversation(userId, { title: 'w2', workspaceId: workspace.id });

    const alpha = dal.addWorkspaceFile(workspace.id, {
      filename: 'alpha.md', driveFileId: mockDriveFile('ALPHA_CONTENT'),
    });
    const beta = dal.addWorkspaceFile(workspace.id, {
      filename: 'beta.md', driveFileId: mockDriveFile('BETA_CONTENT'),
    });

    const ctxFor = (chatId, toolsEnabled) =>
      resolveRequestContext(reqFor(userId, { conversationId: chatId }), null, toolsEnabled);

    // -----------------------------------------------------------------------
    console.log('\n1. baseline — everything enabled (CT-01 default)...');
    await check('both files inject their content', async () => {
      clearCache();
      const ctx = await ctxFor(wsChat.id, false);
      assert.match(ctx.text, /ALPHA_CONTENT/);
      assert.match(ctx.text, /BETA_CONTENT/);
      assert.match(ctx.text, /WS_INSTRUCTIONS/, 'instructions unaffected');
      assert.ok(!ctx.text.includes('<available_files>'), 'nothing to list');
    });

    // -----------------------------------------------------------------------
    console.log('\n2. container-level disable...');
    dal.setWorkspaceFileEnabled(beta.id, workspace.id, false);

    await check('disabled content is gone, enabled content stays', async () => {
      clearCache();
      const ctx = await ctxFor(wsChat.id, false);
      assert.match(ctx.text, /ALPHA_CONTENT/);
      assert.ok(!ctx.text.includes('BETA_CONTENT'), 'disabled file was not injected');
    });

    await check('tools OFF → no manifest (an unreachable name is just noise)', async () => {
      clearCache();
      const ctx = await ctxFor(wsChat.id, false);
      assert.ok(!ctx.text.includes('<available_files>'));
      assert.ok(!ctx.text.includes('beta.md'), 'the name is not mentioned at all');
    });

    await check('tools ON → manifest names it, content still absent', async () => {
      clearCache();
      const ctx = await ctxFor(wsChat.id, true);
      assert.match(ctx.text, /<available_files>/);
      assert.match(ctx.text, /beta\.md/);
      assert.match(ctx.text, /read_file/, 'tells the model how to get it');
      assert.ok(!ctx.text.includes('BETA_CONTENT'), 'named, not loaded');
      assert.ok(!ctx.text.includes('alpha.md') || ctx.text.includes('ALPHA_CONTENT'),
        'an enabled file is injected, not manifested');
    });

    await check('the manifest sits inside the container block', async () => {
      clearCache();
      const ctx = await ctxFor(wsChat.id, true);
      const openIdx = ctx.text.indexOf('<workspace_context>');
      const manifestIdx = ctx.text.indexOf('<available_files>');
      const closeIdx = ctx.text.indexOf('</workspace_context>');
      assert.ok(openIdx < manifestIdx && manifestIdx < closeIdx);
    });

    // -----------------------------------------------------------------------
    console.log('\n3. per-chat overrides beat the container default...');
    await check('chat re-enables a container-disabled file', async () => {
      dal.setConversationContextOverride(wsChat.id, 'workspace', beta.id, true);
      clearCache();
      const ctx = await ctxFor(wsChat.id, true);
      assert.match(ctx.text, /BETA_CONTENT/, 'override wins');
      assert.ok(!ctx.text.includes('<available_files>'), 'nothing left to manifest');
    });

    await check('the other chat still sees the container default', async () => {
      clearCache();
      const ctx = await ctxFor(otherChat.id, true);
      assert.ok(!ctx.text.includes('BETA_CONTENT'), 'override is per-chat');
      assert.match(ctx.text, /beta\.md/, 'and still manifested there');
    });

    await check('chat disables a container-enabled file', async () => {
      dal.setConversationContextOverride(wsChat.id, 'workspace', alpha.id, false);
      clearCache();
      const ctx = await ctxFor(wsChat.id, true);
      assert.ok(!ctx.text.includes('ALPHA_CONTENT'));
      assert.match(ctx.text, /alpha\.md/, 'manifested instead');
    });

    await check('clearing the override restores the container default', async () => {
      dal.clearConversationContextOverride(wsChat.id, 'workspace', alpha.id);
      dal.clearConversationContextOverride(wsChat.id, 'workspace', beta.id);
      clearCache();
      const ctx = await ctxFor(wsChat.id, false);
      assert.match(ctx.text, /ALPHA_CONTENT/);
      assert.ok(!ctx.text.includes('BETA_CONTENT'), 'back to the container default (off)');
    });

    // -----------------------------------------------------------------------
    console.log('\n4. a fully-disabled container...');
    const bare = dal.createWorkspace(userId, { name: 'BARE' }); // no instructions
    const bareChat = dal.createConversation(userId, { title: 'b', workspaceId: bare.id });
    const bareFile = dal.addWorkspaceFile(bare.id, {
      filename: 'hidden.md', driveFileId: mockDriveFile('HIDDEN_CONTENT'),
    });
    dal.setWorkspaceFileEnabled(bareFile.id, bare.id, false);

    await check('no instructions, all files off, tools off → no block at all', async () => {
      clearCache();
      const ctx = await resolveRequestContext(reqFor(userId, { conversationId: bareChat.id }), null, false);
      assert.strictEqual(ctx, null, 'nothing worth injecting');
    });

    await check('no instructions, all files off, tools ON → manifest-only block', async () => {
      clearCache();
      const ctx = await resolveRequestContext(reqFor(userId, { conversationId: bareChat.id }), null, true);
      assert.ok(ctx?.text, 'a block exists');
      assert.match(ctx.text, /hidden\.md/);
      assert.ok(!ctx.text.includes('HIDDEN_CONTENT'), 'name only');
    });

    // -----------------------------------------------------------------------
    console.log('\n5. manifest shape (pure)...');
    await check('names are capped with an overflow summary', () => {
      const cap = projectContext._MANIFEST_MAX_NAMES;
      const many = Array.from({ length: cap + 7 }, (_, i) => ({ filename: `f${i}.md` }));
      const text = projectContext._buildAvailableFilesSection({ name: 'W' }, many, 'workspace');
      assert.match(text, /and 7 more/);
      assert.ok(text.includes(`f${cap - 1}.md`), 'last named file is at the cap');
      assert.ok(!text.includes(`f${cap}.md`), 'past the cap it is summarised, not named');
    });

    await check('nothing disabled → no section', () => {
      assert.strictEqual(projectContext._buildAvailableFilesSection({ name: 'W' }, [], 'workspace'), null);
    });

    // -----------------------------------------------------------------------
    console.log('\n6. active-file inject modes (pin / mute)...');
    const chat = dal.createConversation(userId, { title: 'files' });
    const mkChatFile = (filename, text, turn) => {
      const f = dal.addConversationFile(chat.id, { filename, driveFileId: mockDriveFile(text), sizeBytes: text.length });
      dal.addFileRevision({
        scope: 'conversation', fileId: f.id, conversationId: chat.id,
        author: 'model', op: 'create', diff: `+${text}`, turn, driveFileId: f.drive_file_id,
      });
      return f;
    };
    // stale: written long ago, outside any sane window. fresh: written last turn.
    const stale = mkChatFile('stale.md', 'STALE_CONTENT', 1);
    const fresh = mkChatFile('fresh.md', 'FRESH_CONTENT', 9);

    await check('baseline: only the in-window file injects', async () => {
      clearCache();
      const block = await resolveActiveFileBlock(userId, chat.id, 10, 1);
      assert.match(block, /FRESH_CONTENT/);
      assert.ok(!block.includes('STALE_CONTENT'));
    });

    await check('pin injects a file far outside the window', async () => {
      dal.setConversationFileInjectMode(stale.id, chat.id, 'pin');
      clearCache();
      const block = await resolveActiveFileBlock(userId, chat.id, 10, 1);
      assert.match(block, /STALE_CONTENT/, 'pinned regardless of age');
      assert.match(block, /pinned by the user/, 'and says why it is here');
      assert.match(block, /FRESH_CONTENT/, 'window still works alongside it');
    });

    await check('pin survives activeFileTurns = 0 (which disables the auto window)', async () => {
      clearCache();
      const block = await resolveActiveFileBlock(userId, chat.id, 10, 0);
      assert.match(block, /STALE_CONTENT/, 'an explicit pin is not the auto window');
      assert.ok(!block.includes('FRESH_CONTENT'), 'the auto window really is off');
    });

    await check('a stale pin does not re-send its ancient diff every turn', async () => {
      clearCache();
      const block = await resolveActiveFileBlock(userId, chat.id, 10, 1);
      assert.ok(!block.includes('+STALE_CONTENT'), 'old diff suppressed');
      assert.match(block, /\+FRESH_CONTENT/, 'a fresh diff is still shown');
    });

    await check('mute excludes a file even immediately after an edit', async () => {
      dal.setConversationFileInjectMode(fresh.id, chat.id, 'mute');
      clearCache();
      const block = await resolveActiveFileBlock(userId, chat.id, 10, 1);
      assert.ok(!block.includes('FRESH_CONTENT'), 'muted beats the recency window');
      assert.match(block, /STALE_CONTENT/, 'the pin is unaffected');
    });

    await check('everything muted / nothing pinned → no block', async () => {
      dal.setConversationFileInjectMode(stale.id, chat.id, 'mute');
      clearCache();
      const block = await resolveActiveFileBlock(userId, chat.id, 10, 1);
      assert.strictEqual(block, null);
    });

    await check('back to auto restores the plain recency behaviour', async () => {
      dal.setConversationFileInjectMode(stale.id, chat.id, 'auto');
      dal.setConversationFileInjectMode(fresh.id, chat.id, 'auto');
      clearCache();
      const block = await resolveActiveFileBlock(userId, chat.id, 10, 1);
      assert.match(block, /FRESH_CONTENT/);
      assert.ok(!block.includes('STALE_CONTENT'));
    });

    // -----------------------------------------------------------------------
    console.log('\n7. list_files reports state...');
    await check('a disabled knowledge file is annotated, an enabled one is not', async () => {
      const res = await executeListFiles({}, { userId, workspace, project: null, conversationId: wsChat.id });
      assert.match(res.content, /alpha\.md/);
      assert.match(res.content, /beta\.md.*not loaded into this conversation/,
        'the model is told why it sees no content');
      assert.ok(!/alpha\.md.*not loaded/.test(res.content), 'enabled files carry no note');
      assert.strictEqual(res.display.notLoaded, 1);
    });

    await check('a per-chat override changes what list_files reports', async () => {
      dal.setConversationContextOverride(wsChat.id, 'workspace', beta.id, true);
      const res = await executeListFiles({}, { userId, workspace, project: null, conversationId: wsChat.id });
      assert.ok(!res.content.includes('not loaded into this conversation'));
      assert.strictEqual(res.display.notLoaded, undefined, 'omitted when everything is loaded');
      dal.clearConversationContextOverride(wsChat.id, 'workspace', beta.id);
    });

    await check('a muted chat file is annotated', async () => {
      dal.setConversationFileInjectMode(fresh.id, chat.id, 'mute');
      const res = await executeListFiles({}, { userId, workspace: null, project: null, conversationId: chat.id });
      assert.match(res.content, /fresh\.md.*muted/);
      assert.ok(!/stale\.md.*muted/.test(res.content), 'auto files carry no note');
    });

  } catch (err) {
    console.error('\n✗ Context toggle test crashed:', err);
    failures++;
  } finally {
    restoreDrive();
    clearCache();
    if (userId) db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    closeDb();
  }

  console.log('\n' + '='.repeat(60));
  console.log(failures === 0 ? 'All context toggle injection tests passed!' : `${failures} assertion(s) FAILED`);
  console.log('='.repeat(60) + '\n');
  process.exit(failures === 0 ? 0 : 1);
})();
