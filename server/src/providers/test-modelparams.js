/**
 * Model-parameter tests (F-01)
 *
 * Headless assertions over how buildRequestBody translates a model profile's
 * sampling parameters into each provider's native body. Pure unit tests — no
 * network, no DB.
 *
 * The reason this file exists: Anthropic rejects `temperature` and `top_p` in
 * the same request (Claude 4.5+), and the STOCK profile enables both, so every
 * Anthropic send failed with a 400 until the guard landed. See
 * docs/REFACTOR_PLAN.md (F-01).
 *
 * Run: node src/providers/test-modelparams.js (part of `npm test`).
 */

const assert = require('node:assert');

const anthropic = require('./anthropic');
const gemini = require('./gemini');

let failures = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`   ✓ ${label}`);
  } catch (err) {
    failures++;
    console.error(`   ✗ ${label}`);
    console.error(`     ${err.message}`);
  }
}

// The defaults a fresh model profile ships with (app.js CONFIG) — the exact
// combination that was failing.
const STOCK = {
  temperature: 1,
  topP: 0.95,
  topK: 40,
  maxTokens: 8192,
  stopSequences: [],
  temperatureEnabled: true,
  topPEnabled: true,
  topKEnabled: true,
};

const base = (modelParams) => ({
  model: 'claude-haiku-4-5-20251001',
  messages: [{ role: 'user', content: 'hi' }],
  modelParams,
});

console.log('='.repeat(60));
console.log('Model-parameter Test (F-01)');
console.log('='.repeat(60));

// ---------------------------------------------------------------------------
console.log('\n1. Anthropic: temperature and top_p are mutually exclusive...');

check('stock profile sends temperature, NOT top_p', () => {
  const body = anthropic.buildRequestBody(base(STOCK));
  assert.strictEqual(body.temperature, 1);
  assert.ok(!('top_p' in body), 'top_p must be absent when temperature is sent');
});

check('temperature disabled → top_p is sent instead', () => {
  const body = anthropic.buildRequestBody(base({ ...STOCK, temperatureEnabled: false }));
  assert.ok(!('temperature' in body));
  assert.strictEqual(body.top_p, 0.95);
});

check('both disabled → neither is sent', () => {
  const body = anthropic.buildRequestBody(
    base({ ...STOCK, temperatureEnabled: false, topPEnabled: false })
  );
  assert.ok(!('temperature' in body));
  assert.ok(!('top_p' in body));
});

check('temperature 0 still counts as set and still suppresses top_p', () => {
  // Guards the falsy trap: 0 is a legitimate temperature, so the check must be
  // `=== undefined`, not truthiness.
  const body = anthropic.buildRequestBody(base({ ...STOCK, temperature: 0 }));
  assert.strictEqual(body.temperature, 0);
  assert.ok(!('top_p' in body), 'temperature 0 must still suppress top_p');
});

check('absent temperature value (toggle on, no number) falls through to top_p', () => {
  const params = { ...STOCK };
  delete params.temperature;
  const body = anthropic.buildRequestBody(base(params));
  assert.ok(!('temperature' in body));
  assert.strictEqual(body.top_p, 0.95);
});

// ---------------------------------------------------------------------------
console.log('\n2. Anthropic: the guard touches nothing else...');

check('top_k rides alongside temperature (not mutually exclusive)', () => {
  const body = anthropic.buildRequestBody(base(STOCK));
  assert.strictEqual(body.top_k, 40);
});

check('top_k respects its own toggle', () => {
  const body = anthropic.buildRequestBody(base({ ...STOCK, topKEnabled: false }));
  assert.ok(!('top_k' in body));
});

check('stop_sequences unaffected', () => {
  const body = anthropic.buildRequestBody(base({ ...STOCK, stopSequences: ['END'] }));
  assert.deepStrictEqual(body.stop_sequences, ['END']);
});

check('max_tokens unaffected', () => {
  const body = anthropic.buildRequestBody(base(STOCK));
  assert.strictEqual(body.max_tokens, 8192);
});

check('streaming body is guarded identically', () => {
  const body = anthropic.buildRequestBody({ ...base(STOCK), stream: true });
  assert.strictEqual(body.stream, true);
  assert.strictEqual(body.temperature, 1);
  assert.ok(!('top_p' in body), 'the stream path must get the same guard');
});

// ---------------------------------------------------------------------------
console.log('\n3. Gemini: no such restriction — both still sent...');

check('gemini sends temperature AND topP together', () => {
  const body = gemini.buildRequestBody({
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'hi' }],
    modelParams: STOCK,
  });
  assert.strictEqual(body.generationConfig.temperature, 1);
  assert.strictEqual(body.generationConfig.topP, 0.95);
  assert.strictEqual(body.generationConfig.topK, 40);
});

// ---------------------------------------------------------------------------
console.log('');
if (failures > 0) {
  console.error(`${failures} model-parameter test(s) FAILED`);
  process.exit(1);
}
console.log('='.repeat(60));
console.log('All model-parameter tests passed!');
console.log('='.repeat(60));
