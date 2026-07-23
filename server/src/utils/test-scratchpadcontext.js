/**
 * Scratchpad injection + gating test (SCRATCHPAD_DESIGN.md, SP-02)
 *
 * Covers resolveScratchpadBlock (the <scratchpad> block: empty-skip, full
 * content every turn, last-N diffs, truncation) and resolveScratchpadEnabled
 * (override / persona base / auto-arm on non-empty content). DB-only, no Drive.
 *
 * Run with: node src/utils/test-scratchpadcontext.js
 */

const assert = require('node:assert');
const { getDb, closeDb } = require('../db/connection');
const dal = require('../db/dal');
const config = require('../config');
const { resolveScratchpadBlock } = require('./scratchpadContext');
const { resolveScratchpadEnabled } = require('../routes/chat');
const { executeWriteScratchpad, executeEditScratchpad } = require('../tools/scratchpad');

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

// Snake-case conversation row (what the resolver reads), refetched after updates.
function row(conversationId, userId) {
  return dal.getConversationMeta(conversationId, userId);
}

(async () => {
  console.log('='.repeat(60));
  console.log('Scratchpad injection + gating test (SP-02)');
  console.log('='.repeat(60));

  const db = getDb();
  let userId;

  try {
    const user = dal.createUser({ googleId: `spc-test-${Date.now()}`, email: 'spc@test.local' });
    userId = user.id;

    console.log('\n1. resolveScratchpadBlock (injection)...');

    await check('no pad / empty pad → null (empty-skip)', async () => {
      const conv = dal.createConversation(userId, { title: 'empty' });
      assert.strictEqual(resolveScratchpadBlock(conv.id, 1), null, 'no pad → null');
      await executeWriteScratchpad({ content: '' }, { userId, conversationId: conv.id, turnOrdinal: 1 });
      assert.strictEqual(resolveScratchpadBlock(conv.id, 1), null, 'empty content → null');
    });

    await check('non-empty pad → block with full content', async () => {
      const conv = dal.createConversation(userId, { title: 'content' });
      await executeWriteScratchpad({ content: '# World\n- nobility\n- artisans' }, { userId, conversationId: conv.id, turnOrdinal: 1 });
      const block = resolveScratchpadBlock(conv.id, 2);
      assert.ok(block, 'block present');
      assert.match(block, /<scratchpad>/);
      assert.match(block, /<current_content>/);
      assert.match(block, /- nobility/);
      assert.match(block, /<recent_changes>/, 'includes the changelog');
    });

    await check('injects up to injectDiffCount recent diffs, newest first', async () => {
      const conv = dal.createConversation(userId, { title: 'diffs' });
      const c = { userId, conversationId: conv.id };
      // More writes than the diff window, so only the last N show.
      for (let i = 0; i < config.scratchpad.injectDiffCount + 2; i++) {
        await executeWriteScratchpad({ content: `line ${i}` }, { ...c, turnOrdinal: i + 1 });
      }
      const block = resolveScratchpadBlock(conv.id, config.scratchpad.injectDiffCount + 3);
      const changeCount = (block.match(/<change /g) || []).length;
      assert.strictEqual(changeCount, config.scratchpad.injectDiffCount, `exactly ${config.scratchpad.injectDiffCount} diffs`);
    });

    await check('a user-authored change is labelled "the user"', async () => {
      const conv = dal.createConversation(userId, { title: 'author' });
      // Simulate a user Save via the shared write path.
      const { applyScratchpadWrite } = require('../tools/scratchpad');
      applyScratchpadWrite(conv.id, 'user wrote this', { author: 'user', op: 'write', turn: 1 });
      const block = resolveScratchpadBlock(conv.id, 2);
      assert.match(block, /by="the user"/);
    });

    await check('oversized content is truncated with a note', async () => {
      const conv = dal.createConversation(userId, { title: 'trunc' });
      const big = 'x'.repeat(config.projectFiles.toolReadMaxChars + 500);
      await executeWriteScratchpad({ content: big }, { userId, conversationId: conv.id, turnOrdinal: 1 });
      const block = resolveScratchpadBlock(conv.id, 2);
      assert.match(block, /note="truncated"/);
      // The full oversized run must not survive: content is sliced to the cap,
      // and the changelog diff is separately bounded, so neither carries it.
      assert.ok(!block.includes('x'.repeat(config.projectFiles.toolReadMaxChars + 1)), 'oversized run does not survive');
    });

    console.log('\n2. resolveScratchpadEnabled (gating)...');

    await check('no conversation → false', () => {
      assert.strictEqual(resolveScratchpadEnabled(userId, null), false);
    });

    await check('explicit override on/off wins', async () => {
      const conv = dal.createConversation(userId, { title: 'override' });
      dal.updateConversation(conv.id, userId, { scratchpadEnabled: true });
      assert.strictEqual(resolveScratchpadEnabled(userId, row(conv.id, userId)), true, 'forced on');
      dal.updateConversation(conv.id, userId, { scratchpadEnabled: false });
      // Even with content, an explicit OFF wins (Decision 4: disabling stops it).
      await executeWriteScratchpad({ content: 'has content' }, { userId, conversationId: conv.id, turnOrdinal: 1 });
      assert.strictEqual(resolveScratchpadEnabled(userId, row(conv.id, userId)), false, 'forced off beats content');
    });

    await check('persona base enables when no override', async () => {
      const persona = dal.createPersona(userId, { name: 'Padder', modelConfig: { scratchpadEnabled: true } });
      const conv = dal.createConversation(userId, { title: 'persona', personaId: persona.id });
      assert.strictEqual(resolveScratchpadEnabled(userId, row(conv.id, userId)), true);
    });

    await check('auto-arm: a non-empty pad enables it with no toggle or persona base', async () => {
      const conv = dal.createConversation(userId, { title: 'autoarm' });
      assert.strictEqual(resolveScratchpadEnabled(userId, row(conv.id, userId)), false, 'empty → off');
      await executeWriteScratchpad({ content: 'the user started jotting' }, { userId, conversationId: conv.id, turnOrdinal: 1 });
      assert.strictEqual(resolveScratchpadEnabled(userId, row(conv.id, userId)), true, 'content → auto-armed');
    });

  } catch (err) {
    console.error('\n✗ SP-02 test crashed:', err);
    failures++;
  } finally {
    if (userId) db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    closeDb();
  }

  console.log('\n' + '='.repeat(60));
  if (failures === 0) {
    console.log('All scratchpad injection + gating tests passed!');
  } else {
    console.log(`${failures} assertion(s) FAILED`);
  }
  console.log('='.repeat(60) + '\n');
  process.exit(failures === 0 ? 0 : 1);
})();
