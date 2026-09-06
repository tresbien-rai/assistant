/**
 * Anthropic cache-breakpoint placement (PC-02, docs/PROMPT_CACHING_DESIGN.md)
 *
 * Asserts WHERE `cache_control` lands in the built request body — and, just as
 * importantly, where it does NOT.
 *
 * A breakpoint is only worth anything at a position some later request
 * reproduces byte for byte. Marking the wrong place is not a no-op: it bills
 * the 1.25x write premium every turn for an entry nothing can ever read. So the
 * negative assertions here (nothing on the newest user turn, nothing on a
 * prefill, nothing on a thinking block) carry as much weight as the positive
 * ones, and the last check walks two consecutive turns to prove the marked
 * position is actually reachable next time.
 *
 * Run with: node src/providers/test-cachecontrol.js
 */

const assert = require('node:assert');
const { buildRequestBody } = require('./anthropic');

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`   ✓ ${label}`);
  } catch (err) {
    console.log(`   ✗ ${label}`);
    console.log(`      ${err.message}`);
    failures++;
  }
}

const SYSTEM = '# Tessera\n\nYou are running inside Tessera.';
const build = (messages, extra = {}) =>
  buildRequestBody({ model: 'claude-opus-5', messages, systemPrompt: SYSTEM, ...extra });

/** Indices of messages carrying a breakpoint on any block. */
function markedIndices(body) {
  return body.messages
    .map((m, i) => (Array.isArray(m.content) && m.content.some((b) => b.cache_control) ? i : -1))
    .filter((i) => i >= 0);
}

/** Total breakpoints in the whole request — the API allows at most 4. */
function countBreakpoints(body) {
  const inSystem = Array.isArray(body.system)
    ? body.system.filter((b) => b.cache_control).length : 0;
  const inMessages = body.messages.reduce(
    (n, m) => n + (Array.isArray(m.content) ? m.content.filter((b) => b.cache_control).length : 0),
    0
  );
  return inSystem + inMessages;
}

/** The request with every marker stripped — what the prefix comparison is on. */
function stripped(body) {
  return body.messages.map((m) => ({
    role: m.role,
    content: Array.isArray(m.content)
      // eslint-disable-next-line no-unused-vars
      ? m.content.map(({ cache_control, ...rest }) => rest)
      : m.content,
  }));
}

// The message shapes the assembly really produces. The augmented user turn
// carries the blocks appended at send time and never persisted — which is the
// whole reason it must not be marked.
const AUGMENTED = 'Now hold it.\n\n<session_state>\nScratchpad: empty\n</session_state>';

console.log('='.repeat(60));
console.log('Anthropic cache breakpoints (PC-02)');
console.log('='.repeat(60));

console.log('\nThe system prompt...');

check('carries a breakpoint, in block form', () => {
  const body = build([{ role: 'user', content: 'hi' }]);
  assert.ok(Array.isArray(body.system), 'system is a block array');
  assert.strictEqual(body.system.length, 1);
  assert.strictEqual(body.system[0].type, 'text');
  assert.strictEqual(body.system[0].text, SYSTEM);
  assert.deepStrictEqual(body.system[0].cache_control, { type: 'ephemeral' });
});

check('is omitted entirely when there is no system prompt', () => {
  const body = buildRequestBody({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(body.system, undefined);
});

console.log('\nMessage placement...');

check('a first turn marks no message — there is no history to read back', () => {
  const body = build([{ role: 'user', content: AUGMENTED }]);
  assert.deepStrictEqual(markedIndices(body), []);
});

check('a later turn marks the end of the stable history, NOT the newest turn', () => {
  const body = build([
    { role: 'user', content: 'Plot a course.' },
    { role: 'assistant', content: 'Heading 041, mark.' },
    { role: 'user', content: AUGMENTED },
  ]);
  assert.deepStrictEqual(markedIndices(body), [1], 'only the last assistant message');
});

check('a tool round marks the history AND the tool-result tail', () => {
  const body = build([
    { role: 'user', content: 'Plot a course.' },
    { role: 'assistant', content: 'Heading 041, mark.' },
    { role: 'user', content: AUGMENTED },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  ]);
  assert.deepStrictEqual(markedIndices(body), [1, 4], 'stable history + the newest tool results');
});

check('a prefill is never marked', () => {
  // The next turn replaces the prefill's bytes with the real reply, so a marker
  // there is a write that can never be read.
  const body = build([
    { role: 'user', content: 'Plot a course.' },
    { role: 'assistant', content: 'Heading 041, mark.' },
    { role: 'user', content: AUGMENTED },
  ], { prefill: 'Certainly,' });
  assert.strictEqual(body.messages[body.messages.length - 1].role, 'assistant');
  assert.deepStrictEqual(markedIndices(body), [1], 'the prefill at index 3 is untouched');
});

check('a thinking block is stepped over, never marked', () => {
  const body = build([
    { role: 'user', content: 'Plot a course.' },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '…', signature: 'sig' },
      { type: 'text', text: 'Heading 041, mark.' },
    ] },
    { role: 'user', content: AUGMENTED },
  ]);
  const blocks = body.messages[1].content;
  assert.ok(!blocks[0].cache_control, 'the thinking block is left alone');
  assert.ok(blocks[1].cache_control, 'the text block after it carries the marker');
  assert.strictEqual(blocks[0].signature, 'sig', 'and the block is otherwise replayed verbatim');
});

check('a message with nothing markable is left unchanged', () => {
  const body = build([
    { role: 'user', content: 'Plot a course.' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '…', signature: 'sig' }] },
    { role: 'user', content: AUGMENTED },
  ]);
  assert.deepStrictEqual(markedIndices(body), [], 'skipped rather than guessed at');
});

console.log('\nInvariants...');

check('never more than the 4 breakpoints the API allows', () => {
  const body = build([
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: AUGMENTED },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  ]);
  assert.strictEqual(countBreakpoints(body), 3, 'system + history + tail, leaving one spare');
});

check('every message is in block form, whatever the caller passed', () => {
  const body = build([
    { role: 'user', content: 'a string' },
    { role: 'assistant', content: [{ type: 'text', text: 'already blocks' }] },
    { role: 'user', content: AUGMENTED },
  ]);
  for (const m of body.messages) {
    assert.ok(Array.isArray(m.content), `${m.role} content is a block array`);
  }
});

check('the caller\'s messages are not mutated', () => {
  const history = [
    { role: 'user', content: 'Plot a course.' },
    { role: 'assistant', content: [{ type: 'text', text: 'Heading 041, mark.' }] },
    { role: 'user', content: AUGMENTED },
  ];
  const before = JSON.stringify(history);
  build(history);
  assert.strictEqual(JSON.stringify(history), before, 'input untouched');
});

console.log('\nThe marked position is reachable on the next turn...');

check('turn N\'s breakpoint sits inside turn N+1\'s reproduced prefix', () => {
  // The property the whole feature rests on. Turn N marks index i; turn N+1
  // must reproduce messages 0..i unchanged, or that write is never read.
  const turnN = build([
    { role: 'user', content: 'Plot a course.' },
    { role: 'assistant', content: 'Heading 041, mark.' },
    { role: 'user', content: AUGMENTED },
  ]);
  const turnNext = build([
    { role: 'user', content: 'Plot a course.' },
    // The augmented turn comes back BARE — the blocks were never persisted.
    { role: 'assistant', content: 'Heading 041, mark.' },
    { role: 'user', content: 'Now hold it.' },
    { role: 'assistant', content: 'Holding.' },
    { role: 'user', content: 'Report.\n\n<session_state>\nScratchpad: 12 characters\n</session_state>' },
  ]);

  const marked = markedIndices(turnN);
  assert.deepStrictEqual(marked, [1]);
  const i = marked[0];

  // Markers are stripped before comparing: the marker moves every turn and is
  // explicitly not an invalidator. What must match is everything else.
  assert.deepStrictEqual(
    stripped(turnNext).slice(0, i + 1),
    stripped(turnN).slice(0, i + 1),
    'the bytes turn N cached are not reproduced on turn N+1'
  );

  // And the marker advances by one full turn, so reads grow rather than reset.
  assert.deepStrictEqual(markedIndices(turnNext), [3]);
});

console.log('\n' + '='.repeat(60));
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('All cache-breakpoint tests passed!');
console.log('='.repeat(60));
