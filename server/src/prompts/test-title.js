/**
 * Chat naming (AX-02, docs) — the pure half.
 *
 * `sanitizeTitle` exists because models do not obey "reply with the title and
 * nothing else": they quote it, label it, bold it, announce it, and end it with
 * a period. Each of those is a check here, and each one was a real output shape
 * before it was a test.
 *
 * `fallbackTitle` matters more than it looks — it is what runs for every user
 * without an aux model or an API key, so it is the DEFAULT experience, not an
 * error path.
 *
 * Run with: node src/prompts/test-title.js
 */

const assert = require('node:assert');
const {
  buildTitleRequest, sanitizeTitle, fallbackTitle, MAX_TITLE_CHARS, MAX_FALLBACK_CHARS,
} = require('./title');

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

console.log('='.repeat(60));
console.log('Chat naming (AX-02)');
console.log('='.repeat(60));

console.log('\nWhat models actually return...');

check('strips wrapping quotes, straight and curly', () => {
  assert.strictEqual(sanitizeTitle('"Redis cache eviction"'), 'Redis cache eviction');
  assert.strictEqual(sanitizeTitle('“Redis cache eviction”'), 'Redis cache eviction');
  assert.strictEqual(sanitizeTitle("'Redis cache eviction'"), 'Redis cache eviction');
  assert.strictEqual(sanitizeTitle('""Doubled up""'), 'Doubled up');
});

check('strips a "Title:" label', () => {
  assert.strictEqual(sanitizeTitle('Title: Build pipeline fix'), 'Build pipeline fix');
  assert.strictEqual(sanitizeTitle('Chat title - Build pipeline fix'), 'Build pipeline fix');
});

check('strips markdown emphasis', () => {
  assert.strictEqual(sanitizeTitle('**Novel outline**'), 'Novel outline');
  assert.strictEqual(sanitizeTitle('`config parsing`'), 'config parsing');
});

check('drops a trailing period but keeps a question mark', () => {
  assert.strictEqual(sanitizeTitle('Debugging the parser.'), 'Debugging the parser');
  // A question can be the subject; the '?' is part of the label, not noise.
  assert.strictEqual(sanitizeTitle('Why is the build slow?'), 'Why is the build slow?');
});

check('steps past an announcement line', () => {
  // "Sure! Here is a title:" is a preamble, not a title. Taking line one here
  // labelled the chat with the model's throat-clearing.
  assert.strictEqual(
    sanitizeTitle('Sure! Here is a title:\n\nDatabase migration plan'),
    'Database migration plan'
  );
});

check('a single line ending in ":" is still used, not discarded', () => {
  // The step-past rule must not eat the only thing we have.
  assert.strictEqual(sanitizeTitle('Notes:'), 'Notes');
});

check('collapses newlines and runs of whitespace', () => {
  assert.strictEqual(sanitizeTitle('  Redis    cache  '), 'Redis cache');
});

check('unusable output reads as empty, which means "fall back"', () => {
  for (const bad of ['', '   ', '\n\n', null, undefined, '""']) {
    assert.strictEqual(sanitizeTitle(bad), '', `expected '' for ${JSON.stringify(bad)}`);
  }
});

check('a rambling reply is capped', () => {
  const long = 'A very long title that just keeps going and going well past anything that would fit in a list row';
  const out = sanitizeTitle(long);
  assert.ok(out.length <= MAX_TITLE_CHARS + 1, `got ${out.length} chars: ${out}`);
});

console.log('\nThe no-model fallback...');

check('takes the opening words of the first message', () => {
  assert.strictEqual(
    fallbackTitle('Help me design a Redis cache eviction strategy for a high traffic API'),
    'Help me design a Redis cache eviction strategy…'
  );
});

check('short input is used whole, with no ellipsis', () => {
  assert.strictEqual(fallbackTitle('hi'), 'hi');
  assert.strictEqual(fallbackTitle('Fix the login bug'), 'Fix the login bug');
});

check('CJK is cut by length, not by looking for a space', () => {
  // The reason truncate() only honours word boundaries when one is nearby:
  // Korean/Japanese/Chinese run long stretches with no spaces, so backing up
  // to "the last space" either finds nothing or throws the string away. This
  // input has an early space and then a long unbroken run.
  const korean = '안녕 나이26세전후의인물설정을도와줘명문대졸업후실무2~3년차인캐릭터야빠르게부탁해';
  const out = fallbackTitle(korean);
  assert.ok(out.length > 20, `hard-cut expected, got ${out.length} chars: ${out}`);
  assert.ok(out.length <= MAX_FALLBACK_CHARS + 1, `too long: ${out}`);
  assert.ok(out.startsWith('안녕 나이26'), `must keep the opening: ${out}`);
});

check('a range with tildes survives intact', () => {
  // Same content class as the strikethrough fix — these must not be mangled.
  assert.strictEqual(fallbackTitle('2~3년차'), '2~3년차');
});

check('nothing to work with reads as empty', () => {
  for (const bad of ['', '   ', null, undefined]) {
    assert.strictEqual(fallbackTitle(bad), '');
  }
});

console.log('\nThe request we send...');

check('includes the reply, because the opener is often too thin', () => {
  const { messages } = buildTitleRequest('can you help me with something?', 'Sure — what is the Redis TTL?');
  const text = messages[0].content;
  assert.ok(text.includes('can you help me with something?'));
  assert.ok(text.includes('Redis TTL'), 'the reply is what reveals the subject');
});

check('omits the reply section entirely when there is no reply', () => {
  const { messages } = buildTitleRequest('first message', '');
  assert.ok(!messages[0].content.includes('Assistant'), 'no empty reply section');
});

check('clips a huge opener rather than re-sending it', () => {
  const { messages } = buildTitleRequest('x'.repeat(50000), 'y'.repeat(50000));
  assert.ok(messages[0].content.length < 2500, `sent ${messages[0].content.length} chars`);
});

check('asks as a labelling task, not a continuation', () => {
  // One user turn, not a replayed exchange — otherwise the aux model is
  // tempted to ANSWER the question instead of naming it.
  const { messages, system } = buildTitleRequest('What is 2+2?', '4');
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].role, 'user');
  assert.ok(/same language/i.test(system), 'must ask for the conversation\'s language');
});

console.log('\n' + '='.repeat(60));
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('All chat-naming tests passed!');
console.log('='.repeat(60));
