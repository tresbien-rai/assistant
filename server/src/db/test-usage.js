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

    // -----------------------------------------------------------------------
    console.log('\n6. Review findings (D1–D3)...');

    await check('D2: inputTokens means UNCACHED input on BOTH providers', () => {
      // Anthropic's input_tokens excludes cached tokens; Gemini's
      // promptTokenCount includes them. Unadjusted, `input + cacheRead` would
      // double-count on one side only — the identical request reading 2005 vs
      // 4005. Both must describe the same 2,005-token prompt.
      const a = anthropic.extractUsage({ usage: {
        input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 2000,
      } });
      const g = gemini.extractUsage({ usageMetadata: {
        promptTokenCount: 2005, candidatesTokenCount: 1, cachedContentTokenCount: 2000,
      } });
      assert.strictEqual(a.inputTokens, 5);
      assert.strictEqual(g.inputTokens, 5, 'promptTokenCount must have cached subtracted');
      assert.strictEqual(a.inputTokens + a.cacheRead, g.inputTokens + g.cacheRead,
        'the classes must be addable to the same prompt size on both providers');
    });

    await check('D2: the subtraction is inert while nothing is cached', () => {
      const g = gemini.extractUsage({ usageMetadata: {
        promptTokenCount: 311, candidatesTokenCount: 1,
      } });
      assert.strictEqual(g.inputTokens, 311, 'no cache field → unchanged');
    });

    await check('D2: a provider reporting cached > prompt cannot go negative', () => {
      const g = gemini.extractUsage({ usageMetadata: {
        promptTokenCount: 10, candidatesTokenCount: 1, cachedContentTokenCount: 99,
      } });
      assert.strictEqual(g.inputTokens, 0);
    });

    await check('D1: an abort noticed between rounds still flags the turn', async () => {
      const { _runToolLoop } = require('../routes/chat');
      const conv2 = dal.createConversation(userId, { title: 'abort between rounds' });
      const ac = new AbortController();
      let call = 0;
      const stub = {
        // Round 0 returns a tool call; the executor "runs" and the user stops
        // mid-tool — no in-flight fetch to reject, so the AbortError catch
        // never fires and only the between-rounds guard can flag this.
        chatRaw: async () => {
          call++;
          return { usage: { input_tokens: 100, output_tokens: 5 }, content: [] };
        },
        extractUsage: anthropic.extractUsage,
        extractToolCalls: () => (call === 1
          ? { calls: [{ id: 't1', name: 'noop', input: {} }], rawAssistantMessage: { role: 'assistant', content: [] } }
          : null),
        buildToolResultMessage: () => ({ role: 'user', content: [] }),
        formatChatResult: () => ({ text: 'done', model: 'm' }),
      };
      const out = await _runToolLoop({
        providerModule: stub, provider: 'anthropic', apiKey: 'k',
        params: { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] },
        toolContext: { conversationId: conv2.id, turnOrdinal: 1, userId },
        signal: ac.signal,
        onEvent: () => { ac.abort(); },   // stop while the tool is running
      });
      assert.strictEqual(out.aborted, true);
      const rows = dal.listUsageEvents(conv2.id);
      assert.ok(rows.length > 0, 'round 0 completed and must be recorded');
      assert.ok(rows.every((r) => r.aborted === 1),
        'a stopped turn must not be presented as a completed one');
      db.prepare('DELETE FROM conversations WHERE id = ?').run(conv2.id);
    });

    await check('D3: the interrupted round is recorded from partialUsage, flagged partial', async () => {
      const { _runToolLoop } = require('../routes/chat');
      const conv3 = dal.createConversation(userId, { title: 'partial round' });
      const stub = {
        chatRaw: async () => {
          // What a provider does now: attach what it latched, then propagate.
          const err = new Error('aborted');
          err.name = 'AbortError';
          err.partialUsage = anthropic.extractUsage({ usage: { input_tokens: 2466, output_tokens: 12 } });
          throw err;
        },
        extractUsage: anthropic.extractUsage,
        extractToolCalls: () => null,
        formatChatResult: () => ({ text: '', model: 'm' }),
      };
      const out = await _runToolLoop({
        providerModule: stub, provider: 'anthropic', apiKey: 'k',
        params: { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] },
        toolContext: { conversationId: conv3.id, turnOrdinal: 1, userId },
      });
      assert.strictEqual(out.aborted, true);
      const rows = dal.listUsageEvents(conv3.id);
      assert.strictEqual(rows.length, 1, 'the interrupted round must not be dropped');
      assert.strictEqual(rows[0].input_tokens, 2466, 'input is exact even on an abort');
      assert.strictEqual(rows[0].output_partial, 1, 'output is a floor, not a total');
      assert.strictEqual(rows[0].aborted, 1);
      db.prepare('DELETE FROM conversations WHERE id = ?').run(conv3.id);
    });

    await check('D3: an abort with nothing latched records no row, and still flags', async () => {
      const { _runToolLoop } = require('../routes/chat');
      const conv4 = dal.createConversation(userId, { title: 'no partial' });
      const stub = {
        chatRaw: async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; },
        extractUsage: anthropic.extractUsage,
        extractToolCalls: () => null,
        formatChatResult: () => ({ text: '', model: 'm' }),
      };
      const out = await _runToolLoop({
        providerModule: stub, provider: 'anthropic', apiKey: 'k',
        params: { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] },
        toolContext: { conversationId: conv4.id, turnOrdinal: 1, userId },
      });
      assert.strictEqual(out.aborted, true);
      // No usage means no row — a row of zeroes would be a claim we can't make.
      assert.strictEqual(dal.listUsageEvents(conv4.id).length, 0);
      db.prepare('DELETE FROM conversations WHERE id = ?').run(conv4.id);
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
