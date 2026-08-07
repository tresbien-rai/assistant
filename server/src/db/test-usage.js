/**
 * Usage Measurement Test (U-01, docs/USAGE_MEASUREMENT_DESIGN.md)
 *
 * Covers the normalisers (including the Gemini thinking-sum trap), the
 * null-vs-zero distinction on thinking_tokens, per-round recording through the
 * real tool loop, and that a usage-write failure never costs the user a turn.
 *
 * Run with: node src/db/test-usage.js
 */

const assert = require('node:assert');
const { getDb, closeDb } = require('./connection');
const dal = require('./dal');
const anthropic = require('../providers/anthropic');
const gemini = require('../providers/gemini');

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
  console.log('Usage Measurement Test (U-01)');
  console.log('='.repeat(60));

  const db = getDb();
  let userId;

  try {
    const user = dal.createUser({ googleId: `usage-test-${Date.now()}`, email: 'usage@test.local' });
    userId = user.id;
    const conv = dal.createConversation(userId, { title: 'usage' });

    // -----------------------------------------------------------------------
    console.log('\n1. Anthropic normaliser...');

    await check('maps the four token classes', () => {
      const u = anthropic.extractUsage({ usage: {
        input_tokens: 2466, output_tokens: 51,
        cache_read_input_tokens: 1800, cache_creation_input_tokens: 640,
      } });
      assert.strictEqual(u.inputTokens, 2466);
      assert.strictEqual(u.outputTokens, 51);
      assert.strictEqual(u.cacheRead, 1800);
      assert.strictEqual(u.cacheWrite, 640);
    });

    await check('thinkingTokens is NULL, not 0 — "not reported" is not "none"', () => {
      const u = anthropic.extractUsage({ usage: { input_tokens: 10, output_tokens: 5 } });
      assert.strictEqual(u.thinkingTokens, null);
    });

    await check('a response with no usage yields null, not a row of zeroes', () => {
      assert.strictEqual(anthropic.extractUsage({}), null);
      assert.strictEqual(anthropic.extractUsage(null), null);
    });

    // -----------------------------------------------------------------------
    console.log('\n2. Gemini normaliser — the thinking-sum trap...');

    await check('outputTokens SUMS candidates + thoughts', () => {
      // Anthropic's output_tokens already includes thinking; Gemini's
      // candidatesTokenCount excludes it. Without the sum, every Gemini turn
      // with thinking on under-reports, by a margin that grows with level.
      const u = gemini.extractUsage({ usageMetadata: {
        promptTokenCount: 311, candidatesTokenCount: 1, thoughtsTokenCount: 190,
      } });
      assert.strictEqual(u.outputTokens, 191, 'must be 1 + 190, not 1');
      assert.strictEqual(u.inputTokens, 311);
    });

    await check('thinkingTokens keeps the split visible', () => {
      const u = gemini.extractUsage({ usageMetadata: {
        promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 190,
      } });
      assert.strictEqual(u.thinkingTokens, 190);
    });

    await check('thinking off → 0, and output is unchanged', () => {
      const u = gemini.extractUsage({ usageMetadata: {
        promptTokenCount: 10, candidatesTokenCount: 7,
      } });
      assert.strictEqual(u.outputTokens, 7);
      assert.strictEqual(u.thinkingTokens, 0);
    });

    await check('cachedContentTokenCount maps to cacheRead; no cache-write equivalent', () => {
      const u = gemini.extractUsage({ usageMetadata: {
        promptTokenCount: 100, candidatesTokenCount: 5, cachedContentTokenCount: 80,
      } });
      assert.strictEqual(u.cacheRead, 80);
      assert.strictEqual(u.cacheWrite, 0);
    });

    // -----------------------------------------------------------------------
    console.log('\n3. Both normalisers agree on what "output" means...');

    await check('same billed output, reported differently, normalises the same', () => {
      // 191 billed output tokens, of which 190 were thinking.
      const a = anthropic.extractUsage({ usage: { input_tokens: 1, output_tokens: 191 } });
      const g = gemini.extractUsage({ usageMetadata: {
        promptTokenCount: 1, candidatesTokenCount: 1, thoughtsTokenCount: 190,
      } });
      assert.strictEqual(a.outputTokens, g.outputTokens,
        'a cross-provider total is meaningless unless these agree');
    });

    // -----------------------------------------------------------------------
    console.log('\n4. Storage...');

    await check('a row round-trips, and raw is kept verbatim', () => {
      const raw = { input_tokens: 5, output_tokens: 2, service_tier: 'standard' };
      const row = dal.addUsageEvent({
        conversationId: conv.id, turn: 1, round: 0,
        provider: 'anthropic', model: 'claude-opus-4-20250514',
        ...anthropic.extractUsage({ usage: raw }),
      });
      assert.strictEqual(row.input_tokens, 5);
      assert.strictEqual(row.round, 0);
      assert.strictEqual(row.aborted, 0);
      // `raw` exists so a field we never normalised (service_tier here) is still
      // answerable later without new capture and a wait for fresh traffic.
      assert.strictEqual(JSON.parse(row.raw).service_tier, 'standard');
    });

    await check('thinking_tokens persists NULL rather than collapsing to 0', () => {
      const rows = dal.listUsageEvents(conv.id);
      assert.strictEqual(rows[0].thinking_tokens, null);
    });

    await check('rounds are ordered and distinguishable', () => {
      for (const r of [1, 2]) {
        dal.addUsageEvent({
          conversationId: conv.id, turn: 1, round: r,
          provider: 'anthropic', model: 'claude-opus-4-20250514',
          inputTokens: 2000 + r, outputTokens: 10,
        });
      }
      const rows = dal.listUsageEvents(conv.id);
      assert.strictEqual(rows.length, 3);
      assert.deepStrictEqual(rows.map((r) => r.round), [0, 1, 2]);
    });

    await check('markTurnAborted flags every round of that turn', () => {
      const n = dal.markTurnAborted(conv.id, 1);
      assert.strictEqual(n, 3);
      assert.ok(dal.listUsageEvents(conv.id).every((r) => r.aborted === 1));
    });

    await check('markTurnAborted is a no-op without a conversation or turn', () => {
      assert.strictEqual(dal.markTurnAborted(null, 1), 0);
      assert.strictEqual(dal.markTurnAborted(conv.id, null), 0);
    });

    await check('deleting the conversation cascades its usage away', () => {
      const other = dal.createConversation(userId, { title: 'doomed' });
      dal.addUsageEvent({
        conversationId: other.id, turn: 1, round: 0,
        provider: 'google', model: 'gemini-3.1-pro-preview', inputTokens: 9,
      });
      assert.strictEqual(dal.listUsageEvents(other.id).length, 1);
      db.prepare('DELETE FROM conversations WHERE id = ?').run(other.id);
      assert.strictEqual(dal.listUsageEvents(other.id).length, 0);
    });

    // -----------------------------------------------------------------------
    console.log('\n5. A usage-write failure never costs the user their turn...');

    await check('a throwing addUsageEvent is swallowed, and the turn still returns', async () => {
      const real = dal.addUsageEvent;
      dal.addUsageEvent = () => { throw new Error('disk on fire'); };
      try {
        // Drive the REAL loop through the real capture path with a provider
        // stub that returns a final answer immediately.
        const { _runToolLoop } = require('../routes/chat');
        const stub = {
          chatRaw: async () => ({ usage: { input_tokens: 1, output_tokens: 1 }, content: [] }),
          extractUsage: anthropic.extractUsage,
          extractToolCalls: () => null,
          formatChatResult: () => ({ text: 'done', model: 'm' }),
        };
        const out = await _runToolLoop({
          providerModule: stub, provider: 'anthropic', apiKey: 'k',
          params: { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] },
          toolContext: { conversationId: conv.id, turnOrdinal: 2, userId },
        });
        assert.strictEqual(out.result.text, 'done', 'the turn must survive the write failure');
      } finally {
        dal.addUsageEvent = real;
      }
    });

    console.log('');
    if (failures > 0) {
      console.error(`${failures} usage test(s) FAILED`);
      process.exitCode = 1;
    } else {
      console.log('='.repeat(60));
      console.log('All usage measurement tests passed!');
      console.log('='.repeat(60));
    }
  } finally {
    if (userId) {
      try { db.prepare('DELETE FROM users WHERE id = ?').run(userId); } catch { /* noop */ }
    }
    closeDb();
  }
})();
