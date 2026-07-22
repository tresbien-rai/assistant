/**
 * Orphaned avatar cleanup Test
 *
 * Covers both layers of the orphaned-images fix against the app DB and the real
 * avatars directory, cleaning up after itself:
 *   - deletePersonaImages: removes a persona's avatar + all expression images
 *     (any extension), leaving other personas' files untouched.
 *   - sweepOrphanedAvatars: deletes an unreferenced file, while keeping a
 *     referenced file, a tmp_ upload, a dotfile, and a too-fresh file.
 *
 * Run with: node src/tools/test-avatarsweep.js
 */

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { getDb, closeDb } = require('../db/connection');
const dal = require('../db/dal');
const { AVATARS_DIR, deletePersonaImages } = require('../routes/avatars');
const { sweepOrphanedAvatars } = require('./avatarSweep');

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

// Track every file we create so teardown removes them all, even on failure.
const createdFiles = [];
function writeFile(name, { ageMs = 0 } = {}) {
  const full = path.join(AVATARS_DIR, name);
  fs.writeFileSync(full, 'x');
  if (ageMs > 0) {
    const when = (Date.now() - ageMs) / 1000; // seconds for utimes
    fs.utimesSync(full, when, when);
  }
  createdFiles.push(full);
  return full;
}
const exists = (name) => fs.existsSync(path.join(AVATARS_DIR, name));

(() => {
  console.log('='.repeat(60));
  console.log('Orphaned avatar cleanup Test');
  console.log('='.repeat(60));

  fs.mkdirSync(AVATARS_DIR, { recursive: true });
  const db = getDb();
  let userId;

  try {
    const user = dal.createUser({ googleId: `av-test-${Date.now()}`, email: 'av@test.local' });
    userId = user.id;

    console.log('\n1. deletePersonaImages...');

    check('removes avatar + all expression images, keeps other personas files', () => {
      const p = dal.createPersona(userId, { name: 'P' });
      const avatar = `${p.id}_avatar.png`;
      const exprHappy = `${p.id}_expr_happy.png`;
      const exprSad = `${p.id}_expr_sad.gif`; // different extension on purpose
      writeFile(avatar);
      writeFile(exprHappy);
      writeFile(exprSad);
      const foreign = writeFile(`someoneelse_avatar.png`);

      const deleted = deletePersonaImages(p.id);

      assert.strictEqual(deleted, 3, 'reports the three files it removed');
      assert.ok(!exists(avatar), 'avatar removed');
      assert.ok(!exists(exprHappy), 'happy expression removed');
      assert.ok(!exists(exprSad), 'sad expression (gif) removed');
      assert.ok(fs.existsSync(foreign), 'unrelated persona file untouched');
    });

    console.log('\n2. sweepOrphanedAvatars...');

    check('deletes unreferenced orphan; keeps referenced / tmp_ / dotfile / fresh', () => {
      // A persona that references an avatar + one expression image.
      const p = dal.createPersona(userId, { name: 'Q' });
      const refAvatar = `${p.id}_avatar.png`;
      const refExpr = `${p.id}_expr_happy.png`;
      dal.updatePersona(p.id, userId, {
        avatarFilename: refAvatar,
        expressions: { happy: { imageKey: refExpr } },
      });
      writeFile(refAvatar);
      writeFile(refExpr);

      // Guarded / target files — unique names so other DB rows can't reference them.
      const stamp = Date.now();
      const oldOrphan = `zz_orphan_old_${stamp}.png`;
      const freshOrphan = `zz_orphan_fresh_${stamp}.png`;
      const tmpUpload = `tmp_upload_${stamp}.png`;
      const dotfile = `.keep_${stamp}`;
      writeFile(oldOrphan, { ageMs: 10 * 60 * 1000 }); // 10 min old > 5 min grace
      writeFile(freshOrphan);                           // mtime ~now
      writeFile(tmpUpload, { ageMs: 10 * 60 * 1000 });  // old, but tmp_ prefix
      writeFile(dotfile, { ageMs: 10 * 60 * 1000 });    // old, but dotfile

      const result = sweepOrphanedAvatars(); // default 5-min grace

      assert.ok(!exists(oldOrphan), 'aged, unreferenced orphan is deleted');
      assert.ok(exists(refAvatar), 'referenced avatar is kept');
      assert.ok(exists(refExpr), 'referenced expression image is kept');
      assert.ok(exists(tmpUpload), 'in-flight tmp_ upload is kept');
      assert.ok(exists(dotfile), 'dotfile (e.g. .gitkeep) is kept');
      assert.ok(exists(freshOrphan), 'too-fresh orphan is kept (age guard)');
      assert.ok(result.deleted >= 1, 'summary counts at least the one deletion');
    });
  } catch (err) {
    console.error('\n✗ Test crashed:', err);
    failures++;
  } finally {
    for (const f of createdFiles) {
      try { fs.unlinkSync(f); } catch { /* already gone */ }
    }
    if (userId) {
      db.prepare('DELETE FROM personas WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
    closeDb();
  }

  console.log('\n' + '='.repeat(60));
  if (failures === 0) {
    console.log('All orphaned avatar cleanup tests passed!');
  } else {
    console.log(`${failures} assertion(s) FAILED`);
  }
  console.log('='.repeat(60) + '\n');
  process.exit(failures === 0 ? 0 : 1);
})();
