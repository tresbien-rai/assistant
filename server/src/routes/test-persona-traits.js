/**
 * Persona traits — server validation test (PT-04)
 *
 * The server never assembles a persona prompt (the client does, in
 * js/persona-sections.js), so it only checks the SHAPE and SIZE of what a
 * persona stores as `traits`. Two paths do that:
 *   1. validatePersonaTraits (routes/personas.js) — strict, for the write
 *      route: anything malformed is a 400.
 *   2. validateBundle (utils/personaBundle.js) — tolerant, for `.tessera`
 *      imports: malformed entries are dropped one by one and the import still
 *      succeeds, because a bundle is a file from any version of Tessera.
 *
 * Run with: node src/routes/test-persona-traits.js
 */

const assert = require('node:assert');
const { validatePersonaTraits } = require('./personas');
const { validateBundle, BUNDLE_FORMAT, BUNDLE_VERSION, BUNDLE_KIND_PERSONA } = require('../utils/personaBundle');

console.log('='.repeat(60));
console.log('Persona Traits Validation Test (PT-04)');
console.log('='.repeat(60));

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
const rejects = (traits) => assert.throws(() => validatePersonaTraits(traits), /./);

console.log('\n1. the write route (strict)...');

check('accepts library picks and customised picks, in order', () => {
  const traits = { personality: [{ id: 'calm' }, { id: 'doting', text: 'Fusses.' }], speech: [] };
  assert.deepStrictEqual(validatePersonaTraits(traits), traits);
});

check('strips fields other than id and text', () => {
  const out = validatePersonaTraits({ personality: [{ id: 'calm', label: 'Calm', extra: 1 }] });
  assert.deepStrictEqual(out, { personality: [{ id: 'calm' }] });
});

check('rejects a non-object, and a section that is not a list', () => {
  rejects(null);
  rejects([]);
  rejects('calm');
  rejects({ personality: 'calm' });
  rejects({ personality: { id: 'calm' } });
});

check('rejects bad ids', () => {
  rejects({ personality: [{}] });
  rejects({ personality: [{ id: 5 }] });
  rejects({ personality: [{ id: 'Calm' }] });
  rejects({ personality: [{ id: 'calm down' }] });
  rejects({ personality: [{ id: '' }] });
  rejects({ personality: ['calm'] });
});

check('a trait picked twice in one section keeps its first entry, not a 400', () => {
  const out = validatePersonaTraits({ personality: [{ id: 'calm', text: 'First.' }, { id: 'curious' }, { id: 'calm' }] });
  assert.deepStrictEqual(out, { personality: [{ id: 'calm', text: 'First.' }, { id: 'curious' }] });
});

check('rejects customised text that is not a string or is too long', () => {
  rejects({ personality: [{ id: 'calm', text: 5 }] });
  rejects({ personality: [{ id: 'calm', text: 'x'.repeat(2001) }] });
});

check('bounds the total customised text and the number of picks', () => {
  const longPicks = Array.from({ length: 13 }, (_, i) => ({ id: `t${i}`, text: 'x'.repeat(2000) }));
  rejects({ personality: longPicks });
  rejects({ personality: Array.from({ length: 65 }, (_, i) => ({ id: `t${i}` })) });
});

check('bounds the number of sections and the length of a section key', () => {
  const many = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`s${i}`, []]));
  rejects(many);
  rejects({ ['k'.repeat(41)]: [] });
  rejects(JSON.parse('{"__proto__": [{"id": "calm"}]}'));
});

console.log('\n2. bundle import (tolerant)...');

const bundle = (persona) => ({
  format: BUNDLE_FORMAT,
  version: BUNDLE_VERSION,
  kind: BUNDLE_KIND_PERSONA,
  persona: { name: 'Imported', ...persona },
});

check('a bundle from before PT-04 imports with no traits', () => {
  assert.deepStrictEqual(validateBundle(bundle({})).persona.traits, {});
});

check('picks and customised text survive an import', () => {
  const traits = { personality: [{ id: 'calm' }, { id: 'doting', text: 'Fusses.' }] };
  assert.deepStrictEqual(validateBundle(bundle({ traits })).persona.traits, traits);
});

check('an id this build does not know is kept, for a later version to use', () => {
  const traits = { personality: [{ id: 'from_the_future' }] };
  assert.deepStrictEqual(validateBundle(bundle({ traits })).persona.traits, traits);
});

check('malformed entries are dropped without failing the import', () => {
  const traits = {
    personality: [null, 'calm', { id: 'Bad Id' }, { id: 'calm' }, { id: 'calm' }, { id: 'curious', text: 7 }],
    speech: 'terse',
    relationship: [{ id: 'peer', text: '   ' }],
  };
  assert.deepStrictEqual(validateBundle(bundle({ traits })).persona.traits, {
    personality: [{ id: 'calm' }, { id: 'curious' }],
    relationship: [{ id: 'peer' }],
  });
});

check('a customised trait over the text budget keeps its pick, on library text', () => {
  const big = 'x'.repeat(2000);
  const personality = Array.from({ length: 13 }, (_, i) => ({ id: `t${i}`, text: big }));
  const out = validateBundle(bundle({ traits: { personality } })).persona.traits.personality;
  assert.strictEqual(out.length, 13);
  assert.deepStrictEqual(out[12], { id: 't12' });
  assert.strictEqual(out[11].text, big);
});

check('a __proto__ section key is ignored on import', () => {
  const traits = JSON.parse('{"__proto__": [{"id": "calm"}], "speech": [{"id": "terse"}]}');
  const out = validateBundle(bundle({ traits })).persona.traits;
  assert.deepStrictEqual(Object.keys(out), ['speech']);
  assert.strictEqual(Object.getPrototypeOf(out), Object.prototype);
});

check('nonsense in place of the traits object imports as no traits', () => {
  assert.deepStrictEqual(validateBundle(bundle({ traits: 'calm' })).persona.traits, {});
  assert.deepStrictEqual(validateBundle(bundle({ traits: [1, 2] })).persona.traits, {});
});

console.log('\n' + '='.repeat(60));
console.log(failures === 0 ? 'All persona traits validation tests passed!' : `${failures} assertion(s) FAILED`);
console.log('='.repeat(60) + '\n');
process.exit(failures === 0 ? 0 : 1);
