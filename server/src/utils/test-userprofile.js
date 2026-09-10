/**
 * User Profile Test (UP-01, docs/PROFILE_DESIGN.md tier 1)
 *
 * Two parts:
 *   1. Pure shape handling (no DB): the tolerant normalizer degrades junk
 *      instead of throwing, the strict validator rejects it instead of
 *      reshaping it, and `profileTextLength` counts what would actually reach
 *      the model rather than what is stored.
 *   2. DAL round-trip on the app database: a user with no profile gets an empty
 *      one, an upsert persists and reads back, a second upsert REPLACES rather
 *      than merges, and deleting the user cascades the row away.
 *
 * UP-01 changes no behaviour — nothing renders the profile into a prompt until
 * UP-03. These tests pin the contract that slice will build on.
 *
 * Run with: node src/utils/test-userprofile.js
 */

const assert = require('node:assert');
const crypto = require('node:crypto');
const { getDb, closeDb } = require('../db/connection');
const dal = require('../db/dal');
const {
  emptyProfile,
  normalizeProfile,
  validateProfile,
  profileTextLength,
  SUGGESTED_SECTIONS,
  MAX_SECTIONS,
  MAX_TITLE_CHARS,
  MAX_BODY_CHARS,
  MAX_PREFERRED_NAME_CHARS,
} = require('./userProfile');

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

/** Assert that a function throws a VALIDATION_ERROR AppError. */
function rejects(label, fn) {
  check(label, () => {
    assert.throws(fn, (err) => err && err.code === 'VALIDATION_ERROR');
  });
}

const section = (over = {}) => ({ id: 'a', title: 'About me', body: 'Hello.', enabled: true, ...over });

console.log('='.repeat(60));
console.log('User Profile Test (UP-01)');
console.log('='.repeat(60));

// ---------------------------------------------------------------------------
// 1. Pure shape handling
// ---------------------------------------------------------------------------
console.log('\n1. normalize (tolerant read path)...');

check('null / junk degrades to an empty profile, never throws', () => {
  assert.deepStrictEqual(normalizeProfile(null), emptyProfile());
  assert.deepStrictEqual(normalizeProfile('nonsense'), emptyProfile());
  assert.deepStrictEqual(normalizeProfile(42), emptyProfile());
  assert.deepStrictEqual(normalizeProfile({ sections: 'not an array' }), emptyProfile());
});

check('non-object entries are skipped, not fatal', () => {
  const out = normalizeProfile({ sections: [null, 'x', section(), 7] });
  assert.strictEqual(out.sections.length, 1);
  assert.strictEqual(out.sections[0].title, 'About me');
});

check('a missing enabled flag means ENABLED', () => {
  // A section written before the toggle existed must keep reaching the model.
  const out = normalizeProfile({ sections: [{ id: 'a', title: 'T', body: 'B' }] });
  assert.strictEqual(out.sections[0].enabled, true);
});

check('enabled: false survives', () => {
  const out = normalizeProfile({ sections: [section({ enabled: false })] });
  assert.strictEqual(out.sections[0].enabled, false);
});

check('duplicate / missing ids are regenerated, sections are kept', () => {
  const out = normalizeProfile({
    sections: [section({ id: 'dup' }), section({ id: 'dup' }), section({ id: '' })],
  });
  assert.strictEqual(out.sections.length, 3, 'no section dropped');
  assert.strictEqual(new Set(out.sections.map((s) => s.id)).size, 3, 'ids unique');
});

check('over-long values are truncated, not rejected', () => {
  const out = normalizeProfile({
    preferredName: 'n'.repeat(500),
    sections: [section({ title: 't'.repeat(500), body: 'b'.repeat(99999) })],
  });
  assert.strictEqual(out.preferredName.length, MAX_PREFERRED_NAME_CHARS);
  assert.strictEqual(out.sections[0].title.length, MAX_TITLE_CHARS);
  assert.strictEqual(out.sections[0].body.length, MAX_BODY_CHARS);
});

check('section order is preserved', () => {
  const out = normalizeProfile({
    sections: [section({ id: '1', title: 'One' }), section({ id: '2', title: 'Two' })],
  });
  assert.deepStrictEqual(out.sections.map((s) => s.title), ['One', 'Two']);
});

console.log('\n2. validate (strict write path)...');

check('a well-formed profile passes through', () => {
  const out = validateProfile({ preferredName: ' Jack ', sections: [section()] });
  assert.strictEqual(out.preferredName, 'Jack', 'trimmed');
  assert.strictEqual(out.sections.length, 1);
});

check('an empty profile is valid', () => {
  assert.deepStrictEqual(validateProfile({}), { preferredName: '', sections: [] });
});

rejects('a non-object is rejected', () => validateProfile('nope'));
rejects('an array is rejected', () => validateProfile([]));
rejects('a non-string preferredName is rejected', () => validateProfile({ preferredName: 7 }));
rejects('an over-long preferredName is rejected', () =>
  validateProfile({ preferredName: 'n'.repeat(MAX_PREFERRED_NAME_CHARS + 1) }));
rejects('a non-array sections is rejected', () => validateProfile({ sections: {} }));
rejects('too many sections are rejected', () =>
  validateProfile({ sections: Array.from({ length: MAX_SECTIONS + 1 }, (_, i) => section({ id: `s${i}` })) }));
rejects('a section without a body is rejected', () => validateProfile({ sections: [{ title: 'T' }] }));
rejects('an over-long title is rejected', () =>
  validateProfile({ sections: [section({ title: 't'.repeat(MAX_TITLE_CHARS + 1) })] }));
rejects('an over-long body is rejected', () =>
  validateProfile({ sections: [section({ body: 'b'.repeat(MAX_BODY_CHARS + 1) })] }));
rejects('a non-boolean enabled is rejected', () =>
  validateProfile({ sections: [section({ enabled: 'yes' })] }));
rejects('duplicate ids are rejected on the write path', () =>
  validateProfile({ sections: [section({ id: 'dup' }), section({ id: 'dup' })] }));

check('the strict path REJECTS what the tolerant path repairs', () => {
  // The two halves of the contract: a client bug is an error, but a row already
  // in the database is never allowed to break a chat.
  const bad = { sections: [section({ id: 'dup' }), section({ id: 'dup' })] };
  assert.throws(() => validateProfile(bad));
  assert.strictEqual(normalizeProfile(bad).sections.length, 2);
});

console.log('\n3. textLength (what actually reaches the model)...');

check('counts enabled titles + bodies + the preferred name', () => {
  const profile = normalizeProfile({
    preferredName: 'Jack',                                    // 4
    sections: [section({ title: 'AB', body: 'CDE' })],        // 2 + 3
  });
  assert.strictEqual(profileTextLength(profile), 9);
});

check('disabled sections cost nothing', () => {
  const profile = normalizeProfile({
    preferredName: '',
    sections: [section({ id: 'a', enabled: false, title: 'AB', body: 'CDE' })],
  });
  assert.strictEqual(profileTextLength(profile), 0);
});

check('ids and JSON punctuation are not counted', () => {
  // The number exists to answer "is this too expensive to send every turn",
  // so it must not include bookkeeping the model never sees.
  const profile = normalizeProfile({ sections: [section({ id: 'a-very-long-uuid-like-id', title: '', body: 'X' })] });
  assert.strictEqual(profileTextLength(profile), 1);
});

console.log('\n4. suggested sections...');

check('every suggestion has a title and a placeholder, and no body', () => {
  assert.ok(SUGGESTED_SECTIONS.length > 0);
  for (const s of SUGGESTED_SECTIONS) {
    assert.ok(s.title && typeof s.title === 'string', 'title');
    assert.ok(s.placeholder && typeof s.placeholder === 'string', 'placeholder');
    assert.strictEqual(s.body, undefined, 'suggestions seed titles only, never words');
    assert.ok(s.title.length <= MAX_TITLE_CHARS, 'suggestion fits its own cap');
  }
});

// ---------------------------------------------------------------------------
// 5. DAL round-trip
// ---------------------------------------------------------------------------
console.log('\n5. DAL round-trip (app database)...');

let userId = null;
try {
  const user = dal.createUser({
    googleId: `up-${crypto.randomUUID()}`,
    email: 'profile-test@example.com',
    displayName: 'Profile Test',
  });
  userId = user.id;

  check('a user with no profile gets an empty one, not null', () => {
    const profile = dal.getUserProfile(userId);
    assert.strictEqual(profile.preferredName, '');
    assert.deepStrictEqual(profile.sections, []);
    assert.strictEqual(profile.updatedAt, null, 'never written');
  });

  check('upsert persists and reads back', () => {
    const written = dal.upsertUserProfile(userId, {
      preferredName: 'Jack',
      sections: [section({ id: 's1', title: 'About me', body: 'I write things.' })],
    });
    assert.strictEqual(written.preferredName, 'Jack');
    assert.strictEqual(written.sections[0].body, 'I write things.');
    assert.ok(written.updatedAt, 'stamped');

    const reread = dal.getUserProfile(userId);
    assert.deepStrictEqual(reread.sections, written.sections);
  });

  check('a second upsert REPLACES rather than merging', () => {
    // The whole point of a document write: a deleted section must actually go.
    dal.upsertUserProfile(userId, {
      preferredName: '',
      sections: [section({ id: 's2', title: 'Only me', body: 'Replaced.' })],
    });
    const profile = dal.getUserProfile(userId);
    assert.strictEqual(profile.sections.length, 1, 'old section gone');
    assert.strictEqual(profile.sections[0].id, 's2');
    assert.strictEqual(profile.preferredName, '', 'cleared, not retained');
  });

  check('a malformed stored row degrades instead of throwing', () => {
    getDb().prepare('UPDATE user_profile SET sections = ? WHERE user_id = ?').run('{not json', userId);
    const profile = dal.getUserProfile(userId);
    assert.deepStrictEqual(profile.sections, [], 'unparseable JSON reads as no sections');
  });

  check('deleting the user cascades the profile away', () => {
    getDb().prepare('DELETE FROM users WHERE id = ?').run(userId);
    const left = getDb()
      .prepare('SELECT COUNT(*) AS n FROM user_profile WHERE user_id = ?')
      .get(userId).n;
    assert.strictEqual(left, 0);
    userId = null;
  });
} catch (err) {
  console.error('\n✗ DAL section crashed:', err);
  failures++;
} finally {
  try {
    if (userId) getDb().prepare('DELETE FROM users WHERE id = ?').run(userId);
  } catch (err) {
    console.error('   (cleanup failed:', err.message, ')');
  }
  closeDb();
}

console.log('\n' + '='.repeat(60));
console.log(failures === 0 ? 'All user profile tests passed!' : `${failures} assertion(s) FAILED`);
console.log('='.repeat(60) + '\n');
process.exit(failures === 0 ? 0 : 1);
