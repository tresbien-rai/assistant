/**
 * Scratchpad tool executors test (SCRATCHPAD_DESIGN.md, SP-01)
 *
 * Runs the real write_scratchpad / edit_scratchpad executors against the app DB.
 * No Drive (the scratchpad is DB-resident), so nothing is monkeypatched. Covers
 * the churn model (replace, not append), the revision log + snapshots, surgical
 * edits, validation failures, turn stamping, and the size guards. Cleans up.
 *
 * Run with: node src/tools/test-scratchpad.js
 */

const assert = require('node:assert');
const { getDb, closeDb } = require('../db/connection');
const dal = require('../db/dal');
const config = require('../config');
const { executeWriteScratchpad, executeEditScratchpad, applyScratchpadWrite, revertScratchpad } = require('./scratchpad');

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

(async () => {
  console.log('='.repeat(60));
  console.log('Scratchpad tool executors test (SP-01)');
  console.log('='.repeat(60));

  const db = getDb();
  let userId;

  try {
    const user = dal.createUser({ googleId: `sp-test-${Date.now()}`, email: 'sp@test.local' });
    userId = user.id;
    const conv = dal.createConversation(userId, { title: 'SP' });
    const ctx = { userId, conversationId: conv.id, turnOrdinal: 1 };

    console.log('\n1. write_scratchpad creates the pad + a revision...');
    await check('first write stores content + a model "write" revision at the turn', async () => {
      const res = await executeWriteScratchpad({ content: '# Kingdom\n- tier 1\n- tier 2' }, ctx);
      assert.ok(!res.isError, `should succeed: ${res.content}`);
      const pad = dal.getScratchpad(conv.id);
      assert.strictEqual(pad.content, '# Kingdom\n- tier 1\n- tier 2');
      const revs = dal.listScratchpadRevisions(pad.id);
      assert.strictEqual(revs.length, 1);
      assert.strictEqual(revs[0].author, 'model');
      assert.strictEqual(revs[0].op, 'write');
      assert.strictEqual(revs[0].turn, 1);
      assert.ok(revs[0].content != null, 'snapshot stored');
    });

    console.log('\n2. Churn: a second write REPLACES (does not append)...');
    await check('content is fully replaced, not accumulated', async () => {
      await executeWriteScratchpad({ content: '# Kingdom (revised)\n- nobility\n- commoners' }, { ...ctx, turnOrdinal: 2 });
      const pad = dal.getScratchpad(conv.id);
      assert.strictEqual(pad.content, '# Kingdom (revised)\n- nobility\n- commoners');
      assert.ok(!pad.content.includes('tier 1'), 'old content is gone (replaced, not appended)');
      const revs = dal.listScratchpadRevisions(pad.id);
      assert.strictEqual(revs.length, 2, 'a second revision was logged');
      assert.ok(revs[revs.length - 1].diff.length > 0, 'the write recorded a diff');
    });

    await check('writing identical content is a no-op (no new revision)', async () => {
      const pad = dal.getScratchpad(conv.id);
      const before = dal.listScratchpadRevisions(pad.id).length;
      const res = await executeWriteScratchpad({ content: pad.content }, ctx);
      assert.ok(!res.isError);
      assert.match(res.content, /nothing changed/i);
      assert.strictEqual(dal.listScratchpadRevisions(pad.id).length, before, 'no revision added');
    });

    console.log('\n3. edit_scratchpad: surgical find/replace...');
    await check('replaces a unique snippet in place', async () => {
      const res = await executeEditScratchpad({ old_text: 'commoners', new_text: 'artisans' }, ctx);
      assert.ok(!res.isError, `should succeed: ${res.content}`);
      const pad = dal.getScratchpad(conv.id);
      assert.ok(pad.content.includes('artisans') && !pad.content.includes('commoners'));
      const revs = dal.listScratchpadRevisions(pad.id);
      assert.strictEqual(revs[revs.length - 1].op, 'edit');
    });

    await check('ambiguous old_text (multiple matches, no replace_all) → isError', async () => {
      await executeWriteScratchpad({ content: 'x\nx\nx' }, ctx);
      const res = await executeEditScratchpad({ old_text: 'x', new_text: 'y' }, ctx);
      assert.ok(res.isError);
      assert.match(res.content, /appears 3 times/);
    });

    await check('replace_all replaces every occurrence', async () => {
      const res = await executeEditScratchpad({ old_text: 'x', new_text: 'y', replace_all: true }, ctx);
      assert.ok(!res.isError);
      assert.strictEqual(dal.getScratchpad(conv.id).content, 'y\ny\ny');
    });

    await check('old_text not found → isError', async () => {
      const res = await executeEditScratchpad({ old_text: 'nope', new_text: 'z' }, ctx);
      assert.ok(res.isError);
      assert.match(res.content, /not found/);
    });

    await check('edit on an empty pad → isError (use write first)', async () => {
      const conv2 = dal.createConversation(userId, { title: 'empty' });
      const res = await executeEditScratchpad({ old_text: 'a', new_text: 'b' }, { userId, conversationId: conv2.id, turnOrdinal: 1 });
      assert.ok(res.isError);
      assert.match(res.content, /empty/);
    });

    console.log('\n4. write empty clears the pad...');
    await check('empty content clears', async () => {
      const res = await executeWriteScratchpad({ content: '' }, ctx);
      assert.ok(!res.isError);
      assert.match(res.content, /[Cc]leared/);
      assert.strictEqual(dal.getScratchpad(conv.id).content, '');
    });

    console.log('\n5. Validation guards...');
    await check('no conversationId → isError (both tools)', async () => {
      const noConv = { userId, conversationId: null, turnOrdinal: 1 };
      assert.ok((await executeWriteScratchpad({ content: 'x' }, noConv)).isError);
      assert.ok((await executeEditScratchpad({ old_text: 'a', new_text: 'b' }, noConv)).isError);
    });

    await check('non-string content → isError', async () => {
      const res = await executeWriteScratchpad({ content: { not: 'a string' } }, ctx);
      assert.ok(res.isError);
    });

    console.log('\n6. Snapshot pruning keeps only the most recent N...');
    await check('older snapshots prune to NULL, diffs retained', async () => {
      const conv3 = dal.createConversation(userId, { title: 'prune' });
      const c3 = { userId, conversationId: conv3.id, turnOrdinal: 1 };
      const keep = config.scratchpad.revisionSnapshotKeep;
      for (let i = 0; i < keep + 3; i++) {
        await executeWriteScratchpad({ content: `version ${i}` }, c3);
      }
      const pad = dal.getScratchpad(conv3.id);
      const revs = dal.listScratchpadRevisions(pad.id);
      const withSnapshot = revs.filter((r) => r.content != null).length;
      assert.strictEqual(withSnapshot, keep, `exactly ${keep} snapshots kept`);
      assert.ok(revs.every((r) => typeof r.diff === 'string'), 'all revisions kept their diff');
    });

    console.log('\n7. Size guards (churn principle; cap is a runaway guard)...');
    await check('warning note when over the soft threshold, write still applies', async () => {
      const conv4 = dal.createConversation(userId, { title: 'warn' });
      const big = 'a'.repeat(config.scratchpad.warnBytes + 10);
      const res = await executeWriteScratchpad({ content: big }, { userId, conversationId: conv4.id, turnOrdinal: 1 });
      assert.ok(!res.isError, 'still succeeds (warn, not block)');
      assert.match(res.content, /getting large/);
      assert.strictEqual(dal.getScratchpad(conv4.id).content.length, big.length, 'the write applied');
    });

    await check('hard ceiling rejects a pathological write', async () => {
      const conv5 = dal.createConversation(userId, { title: 'huge' });
      const huge = 'a'.repeat(config.scratchpad.maxBytes + 1);
      const res = await executeWriteScratchpad({ content: huge }, { userId, conversationId: conv5.id, turnOrdinal: 1 });
      assert.ok(res.isError, 'rejected');
      assert.match(res.content, /too large/);
    });

    console.log('\n8. Re-roll revert (SP-04): undo model pad writes at/after a turn...');
    await check('restores the pre-turn snapshot and drops the undone revisions', async () => {
      const conv = dal.createConversation(userId, { title: 'revert' });
      // turn 1: user establishes content; turn 2 + 3: model churns it.
      applyScratchpadWrite(conv.id, 'USER baseline', { author: 'user', op: 'write', turn: 1 });
      await executeWriteScratchpad({ content: 'model v2' }, { userId, conversationId: conv.id, turnOrdinal: 2 });
      await executeWriteScratchpad({ content: 'model v3' }, { userId, conversationId: conv.id, turnOrdinal: 3 });

      const out = revertScratchpad(conv.id, 2); // re-roll from turn 2
      assert.ok(out.reverted, 'reverted');
      assert.strictEqual(dal.getScratchpad(conv.id).content, 'USER baseline', 'restored to the pre-turn (turn-1) state');
      const revs = dal.listScratchpadRevisions(dal.getScratchpad(conv.id).id);
      assert.ok(revs.every(r => r.turn < 2), 'revisions at/after turn 2 dropped');
      assert.strictEqual(revs.length, 1, 'only the turn-1 user revision remains');
    });

    await check('no-op when the model did not touch the pad in the span', async () => {
      const conv = dal.createConversation(userId, { title: 'revert-noop' });
      applyScratchpadWrite(conv.id, 'only user wrote', { author: 'user', op: 'write', turn: 3 });
      const out = revertScratchpad(conv.id, 2);
      assert.ok(!out.reverted, 'nothing model-authored to undo');
      assert.strictEqual(dal.getScratchpad(conv.id).content, 'only user wrote', 'user content preserved');
    });

    await check('restores to empty when the pad had no pre-turn content', async () => {
      const conv = dal.createConversation(userId, { title: 'revert-empty' });
      await executeWriteScratchpad({ content: 'model created it this turn' }, { userId, conversationId: conv.id, turnOrdinal: 2 });
      const out = revertScratchpad(conv.id, 2);
      assert.ok(out.reverted);
      assert.strictEqual(dal.getScratchpad(conv.id).content, '', 'no earlier snapshot → cleared');
    });

  } catch (err) {
    console.error('\n✗ Scratchpad test crashed:', err);
    failures++;
  } finally {
    if (userId) db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    closeDb();
  }

  console.log('\n' + '='.repeat(60));
  if (failures === 0) {
    console.log('All scratchpad executor tests passed!');
  } else {
    console.log(`${failures} assertion(s) FAILED`);
  }
  console.log('='.repeat(60) + '\n');
  process.exit(failures === 0 ? 0 : 1);
})();
