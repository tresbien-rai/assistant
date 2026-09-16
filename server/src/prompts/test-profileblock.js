/**
 * Profile prompt block test (UP-03, docs/PROFILE_DESIGN.md tier 1)
 *
 * Covers the three things that can go wrong once the profile reaches the model:
 *   1. Rendering — disabled sections must not leak, order must be the user's.
 *   2. Gating — the block has TWO distinct silences (no profile / persona
 *      opted out) and they must stay distinguishable, because they are the two
 *      answers to "why is my profile not in the prompt".
 *   3. Caching — the block sits in the system prompt, so it must be
 *      byte-identical between requests that differ only in volatile state.
 *
 * Run with: node src/prompts/test-profileblock.js
 */

const assert = require('node:assert');
const { renderProfile, resolveUserName } = require('./profile');
const { composeSystemPrompt, buildSystemPrompt, PROFILE_SECTION, PREFERENCES_SECTION } = require('./tessera');
const { normalizeProfile } = require('../utils/userProfile');

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

/** The block entry for `profile` out of a compose() call. */
function profileBlock(options) {
  return composeSystemPrompt('PERSONA', [], options).blocks.find((b) => b.id === 'profile');
}

const FULL = normalizeProfile({
  preferredName: 'Jack',
  sections: [
    { id: 'a', title: 'About me', body: 'I build things badly.', enabled: true },
    { id: 'b', title: 'Secret', body: 'Never send this.', enabled: false },
    { id: 'c', title: 'Work', body: 'Tessera.', enabled: true },
  ],
});

console.log('='.repeat(60));
console.log('Profile Prompt Block Test (UP-03)');
console.log('='.repeat(60));

console.log('\n1. renderProfile...');

check('an empty profile renders nothing at all', () => {
  assert.strictEqual(renderProfile(null), '');
  assert.strictEqual(renderProfile(normalizeProfile(null)), '');
  assert.strictEqual(renderProfile(normalizeProfile({ sections: [] })), '');
});

check('a disabled section never reaches the text', () => {
  const out = renderProfile(FULL);
  assert.ok(!out.includes('Secret'), 'title leaked');
  assert.ok(!out.includes('Never send this'), 'body leaked');
});

check('enabled sections render with their titles, in the user order', () => {
  const out = renderProfile(FULL);
  assert.ok(out.includes('### About me'));
  assert.ok(out.includes('### Work'));
  assert.ok(out.indexOf('About me') < out.indexOf('Work'), 'order is the user\'s');
});

check('the preferred name is stated', () => {
  assert.ok(renderProfile(FULL).includes('Jack'));
});

check('a titled section with no body still renders — naming a topic is information', () => {
  const p = normalizeProfile({ sections: [{ id: 'x', title: 'Health', body: '' }] });
  assert.ok(renderProfile(p).includes('Health'));
});

check('a section with neither title nor body is dropped', () => {
  const p = normalizeProfile({ sections: [{ id: 'x', title: '', body: '' }] });
  assert.strictEqual(renderProfile(p), '');
});

check('a name-only profile still renders', () => {
  const p = normalizeProfile({ preferredName: 'Jack', sections: [] });
  assert.ok(renderProfile(p).includes('Jack'));
});

console.log('\n2. resolveUserName...');

check('the preferred name wins over the account name', () => {
  assert.strictEqual(resolveUserName(FULL, 'Jonathan Smith'), 'Jack');
});

check('the account name is the fallback', () => {
  assert.strictEqual(resolveUserName(normalizeProfile(null), 'Jonathan Smith'), 'Jonathan Smith');
});

check('no profile and no account name is empty, never undefined', () => {
  assert.strictEqual(resolveUserName(null, undefined), '');
});

console.log('\n3. gating in the system prompt...');

check('included when enabled and non-empty', () => {
  const block = profileBlock({ profileEnabled: true, macros: { profileText: renderProfile(FULL) } });
  assert.strictEqual(block.included, true);
  assert.ok(block.text.includes('About me'));
  assert.ok(block.text.includes('The person you are talking to'), 'framing present');
});

check('persona opted out => profile-off, and NOTHING of the profile is emitted', () => {
  const text = buildSystemPrompt('PERSONA', [], {
    profileEnabled: false,
    macros: { profileText: renderProfile(FULL) },
  });
  assert.ok(!text.includes('Jack'), 'name leaked past an opted-out persona');
  assert.ok(!text.includes('About me'), 'section leaked past an opted-out persona');
  const block = profileBlock({ profileEnabled: false, macros: { profileText: renderProfile(FULL) } });
  assert.strictEqual(block.included, false);
  assert.strictEqual(block.reason, 'profile-off');
});

check('enabled but empty => no-profile, a DIFFERENT reason', () => {
  const block = profileBlock({ profileEnabled: true, macros: { profileText: '' } });
  assert.strictEqual(block.included, false);
  assert.strictEqual(block.reason, 'no-profile');
});

check('the two silences stay distinguishable', () => {
  // They are the two answers to "why is my profile not in the prompt". Collapse
  // them into one code and the inspector can only shrug.
  const off = profileBlock({ profileEnabled: false, macros: { profileText: renderProfile(FULL) } });
  const none = profileBlock({ profileEnabled: true, macros: { profileText: '' } });
  assert.notStrictEqual(off.reason, none.reason);
});

check('a preset may disable the block outright', () => {
  const preset = { order: ['orientation', 'profile', 'persona'], blocks: { profile: { enabled: false, text: null } } };
  const block = profileBlock({ profileEnabled: true, preset, macros: { profileText: renderProfile(FULL) } });
  assert.strictEqual(block.included, false);
  assert.strictEqual(block.reason, 'disabled');
});

check('a preset may reword the framing but not the content', () => {
  const preset = {
    order: ['orientation', 'profile', 'persona'],
    blocks: { profile: { enabled: true, text: 'WHO:\n{{profile}}' } },
  };
  const block = profileBlock({ profileEnabled: true, preset, macros: { profileText: renderProfile(FULL) } });
  assert.strictEqual(block.source, 'preset');
  assert.ok(block.text.startsWith('WHO:'), 'framing reworded');
  assert.ok(block.text.includes('### About me'), 'content unchanged');
  assert.ok(!block.text.includes('Secret'), 'a preset cannot resurrect a disabled section');
});

console.log('\n4. answer preferences (UP-04)...');

check('included when there is preferences text', () => {
  const block = composeSystemPrompt('PERSONA', [], {
    macros: { preferencesText: 'Keep it brief. British spelling.' },
  }).blocks.find((b) => b.id === 'preferences');
  assert.strictEqual(block.included, true);
  assert.ok(block.text.includes('Keep it brief'));
  assert.ok(block.text.includes('How they like to be answered'), 'framing present');
});

check('empty preferences => no-preferences, and no empty heading is emitted', () => {
  const out = composeSystemPrompt('PERSONA', [], { macros: { preferencesText: '' } });
  const block = out.blocks.find((b) => b.id === 'preferences');
  assert.strictEqual(block.included, false);
  assert.strictEqual(block.reason, 'no-preferences');
  assert.ok(!out.text.includes('How they like to be answered'));
});

check('preferences are INDEPENDENT of the profile switch', () => {
  // D3: they are different instructions and a persona may want one without the
  // other. A persona opted out of the profile still gets the preferences.
  const out = composeSystemPrompt('PERSONA', [], {
    profileEnabled: false,
    macros: { profileText: renderProfile(FULL), preferencesText: 'Keep it brief.' },
  });
  assert.ok(!out.text.includes('Jack'), 'profile still suppressed');
  assert.ok(out.text.includes('Keep it brief.'), 'preferences still sent');
});

check('profile and preferences render as two separate blocks, in order', () => {
  const ids = composeSystemPrompt('PERSONA', [], {
    profileEnabled: true,
    macros: { profileText: renderProfile(FULL), preferencesText: 'Keep it brief.' },
  }).blocks.filter((b) => b.included).map((b) => b.id);
  assert.deepStrictEqual(ids.slice(0, 3), ['orientation', 'profile', 'preferences']);
});

check('the framing says a live request beats a standing preference', () => {
  // Without this, "keep it brief" defeats "give me the long version" and the
  // model becomes impossible to steer.
  // Whitespace-collapsed: the phrase wraps across a line in the source, and a
  // test that breaks when the wording is re-wrapped is a test about formatting.
  assert.ok(/what they just asked for wins/i.test(PREFERENCES_SECTION.replace(/\s+/g, ' ')));
});

console.log('\n5. position + caching...');

check('built-in position is directly after the orientation', () => {
  const ids = composeSystemPrompt('PERSONA', [], {
    profileEnabled: true,
    macros: { profileText: renderProfile(FULL) },
  }).blocks.filter((b) => b.included).map((b) => b.id);
  assert.deepStrictEqual(ids.slice(0, 2), ['orientation', 'profile']);
});

check('the profile block is byte-identical across differing session state', () => {
  // It lives in the SYSTEM prompt, so any per-turn variation in it would
  // re-write the cached prefix on every message (docs/PROMPT_CACHING_DESIGN.md).
  const opts = (sessionState) => ({
    profileEnabled: true,
    sessionState,
    macros: { profileText: renderProfile(FULL) },
  });
  const a = buildSystemPrompt('PERSONA', [], opts('<session_state>files: 0</session_state>'));
  const b = buildSystemPrompt('PERSONA', [], opts('<session_state>files: 12</session_state>'));
  assert.strictEqual(a, b);
});

check('the built-in framing tells the model not to recite it', () => {
  // The behaviour this guards is real: given a block of facts about someone,
  // models tend to perform having read it. If this wording is ever dropped,
  // this test should fail loudly rather than the app quietly getting weird.
  assert.ok(/do not recite/i.test(PROFILE_SECTION.replace(/\s+/g, ' ')));
});

console.log('\n' + '='.repeat(60));
console.log(failures === 0 ? 'All profile block tests passed!' : `${failures} assertion(s) FAILED`);
console.log('='.repeat(60) + '\n');
process.exit(failures === 0 ? 0 : 1);
