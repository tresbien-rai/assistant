/**
 * Passthrough usage watcher test (U-02, docs/USAGE_MEASUREMENT_DESIGN.md)
 *
 * The watcher rides the toolless byte pipe, so the cases that matter are the
 * hostile ones: CRLF frames (the #170 bug that made Gemini a silent no-op),
 * frames split across chunk boundaries, and malformed input that must cost a
 * metric rather than the user's reply.
 *
 * Run with: node src/providers/test-usagewatcher.js
 */

const assert = require('node:assert');
const { anthropicUsageWatcher, geminiUsageWatcher } = require('./usageWatcher');
const anthropic = require('./anthropic');
const gemini = require('./gemini');

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

/** Feed a wire string one byte-slice at a time, to prove chunk-boundary safety. */
function pushInChunks(watcher, wire, size) {
  for (let i = 0; i < wire.length; i += size) watcher.push(wire.slice(i, i + size));
}

console.log('='.repeat(60));
console.log('Passthrough Usage Watcher Test (U-02)');
console.log('='.repeat(60));

// ---------------------------------------------------------------------------
console.log('\n1. Anthropic: input up front, output at the end...');

const A_WIRE = [
  `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 2466, output_tokens: 1, cache_read_input_tokens: 1800 } } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 214 } })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
].join('');

check('merges message_start and message_delta rather than taking either alone', () => {
  const w = anthropicUsageWatcher();
  w.push(A_WIRE);
  const u = w.usage();
  assert.strictEqual(u.input_tokens, 2466, 'input comes from message_start');
  assert.strictEqual(u.output_tokens, 214, 'output must SETTLE from message_delta, not stay at 1');
  assert.strictEqual(u.cache_read_input_tokens, 1800);
});

check('survives being split mid-frame across chunk boundaries', () => {
  for (const size of [1, 7, 64]) {
    const w = anthropicUsageWatcher();
    pushInChunks(w, A_WIRE, size);
    assert.strictEqual(w.usage().output_tokens, 214, `failed at chunk size ${size}`);
  }
});

check('feeds the real extractUsage normaliser', () => {
  const w = anthropicUsageWatcher();
  w.push(A_WIRE);
  const n = anthropic.extractUsage({ usage: w.usage() });
  assert.strictEqual(n.inputTokens, 2466);
  assert.strictEqual(n.outputTokens, 214);
  assert.strictEqual(n.thinkingTokens, null);
});

// ---------------------------------------------------------------------------
console.log('\n2. Gemini: CRLF frames — the #170 shape...');

const G_FRAMES = [
  { candidates: [{ content: { parts: [{ text: 'hi' }] } }], usageMetadata: { promptTokenCount: 311, candidatesTokenCount: 1, thoughtsTokenCount: 0 } },
  { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 311, candidatesTokenCount: 1, thoughtsTokenCount: 190 } },
];
// CRLF, because that is what Google actually sends. A watcher that searched for
// "\n\n" would find nothing here and silently report no usage at all.
const G_WIRE = G_FRAMES.map((f) => `data: ${JSON.stringify(f)}\r\n\r\n`).join('');

check('parses CRLF-delimited frames (LF-only search would find none)', () => {
  const w = geminiUsageWatcher();
  w.push(G_WIRE);
  assert.ok(w.usage(), 'no usage latched — the CRLF separator was missed');
  assert.strictEqual(w.usage().promptTokenCount, 311);
});

check('latches the LAST frame, which carries the settled totals', () => {
  const w = geminiUsageWatcher();
  w.push(G_WIRE);
  assert.strictEqual(w.usage().thoughtsTokenCount, 190, 'must not stop at the first frame');
});

check('survives a chunk boundary landing between the CR and the LF', () => {
  for (const size of [1, 3, 11]) {
    const w = geminiUsageWatcher();
    pushInChunks(w, G_WIRE, size);
    assert.strictEqual(w.usage().thoughtsTokenCount, 190, `failed at chunk size ${size}`);
  }
});

check('feeds the real extractUsage, including the thinking sum', () => {
  const w = geminiUsageWatcher();
  w.push(G_WIRE);
  const n = gemini.extractUsage({ usageMetadata: w.usage() });
  assert.strictEqual(n.outputTokens, 191, 'candidates + thoughts');
  assert.strictEqual(n.thinkingTokens, 190);
});

// ---------------------------------------------------------------------------
console.log('\n3. Hostile input costs a metric, never the stream...');

check('malformed JSON is skipped without throwing', () => {
  const w = anthropicUsageWatcher();
  w.push('data: {not json\n\n');
  w.push(A_WIRE);
  assert.strictEqual(w.usage().output_tokens, 214, 'a bad frame must not poison later good ones');
});

check('non-data lines, comments and blank frames are ignored', () => {
  const w = geminiUsageWatcher();
  w.push(': keep-alive comment\n\nevent: ping\n\n\n\n');
  w.push(G_WIRE);
  assert.strictEqual(w.usage().promptTokenCount, 311);
});

check('a stream carrying no usage at all reports null, not zeroes', () => {
  const w = anthropicUsageWatcher();
  w.push('event: ping\ndata: {"type":"ping"}\n\n');
  assert.strictEqual(w.usage(), null);
});

check('push never throws, whatever it is handed', () => {
  const w = anthropicUsageWatcher();
  for (const junk of ['', 'data:', 'data: \n\n', '\n\n\n\n', 'x'.repeat(5000)]) {
    w.push(junk);
  }
  assert.ok(true);
});

check('an unterminated frame does not grow the buffer without bound', () => {
  const w = geminiUsageWatcher();
  // 2 MB with no separator anywhere: the cap must discard rather than retain.
  w.push('data: ' + 'x'.repeat(2_000_000));
  w.push(G_WIRE);
  assert.strictEqual(w.usage().promptTokenCount, 311, 'recovers once real frames resume');
});

check('the cap never discards COMPLETE frames — chunking cannot change the answer', () => {
  // The cap must run AFTER draining, not before. Capping first throws away
  // frames that were ready to parse, and the damage is invisible: the same
  // bytes delivered as one big chunk versus many small ones would disagree,
  // and the bad case yields a plausible row with input_tokens 0 rather than an
  // honest null. Reachable whenever a single read exceeds the cap — likelier
  // on Gemini, whose frames carry whole candidate parts.
  // The pad must sit BETWEEN the frame carrying input and the one carrying
  // output: a cap that keeps only the tail then discards message_start, losing
  // input_tokens while message_delta survives — a row that looks complete.
  const A_START = A_WIRE.slice(0, A_WIRE.indexOf('event: content_block_delta'));
  const A_REST = A_WIRE.slice(A_WIRE.indexOf('event: content_block_delta'));
  const padded = A_START + `data: ${JSON.stringify({ type: 'x', pad: 'y'.repeat(1_100_000) })}\n\n` + A_REST;

  const oneChunk = anthropicUsageWatcher();
  oneChunk.push(padded);

  const many = anthropicUsageWatcher();
  pushInChunks(many, padded, 65536);

  assert.deepStrictEqual(oneChunk.usage(), many.usage(),
    'identical bytes must give identical usage regardless of chunk size');
  assert.strictEqual(oneChunk.usage().input_tokens, 2466, 'the real frames must survive the cap');
  assert.strictEqual(oneChunk.usage().output_tokens, 214);
});

// ---------------------------------------------------------------------------
console.log('\n4. An interrupted passthrough is a floor, not a total...');

check('a stop after message_start yields exact input and an unsettled output', () => {
  // What `stream()` returns when the user hits Stop mid-reply: message_start
  // arrived (input exact, output_tokens 1 as a placeholder), message_delta
  // never did. Recording that as a complete row is what design §8 forbids —
  // the route must flag it partial, and the two paths must agree.
  const w = anthropicUsageWatcher();
  w.push(A_WIRE.slice(0, A_WIRE.indexOf('event: content_block_delta')));
  const u = w.usage();
  assert.strictEqual(u.input_tokens, 2466, 'input is known up front and is exact');
  assert.strictEqual(u.output_tokens, 1, 'output never settled — a floor, not a total');
  const n = anthropic.extractUsage({ usage: u });
  assert.strictEqual(n.inputTokens, 2466);
});

check('a stop before any frame lands yields null rather than a row of zeroes', () => {
  const w = anthropicUsageWatcher();
  w.push('event: ping\n');   // truncated mid-frame
  assert.strictEqual(w.usage(), null);
});

console.log('');
if (failures > 0) {
  console.error(`${failures} usage-watcher test(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log('='.repeat(60));
  console.log('All passthrough usage watcher tests passed!');
  console.log('='.repeat(60));
}
