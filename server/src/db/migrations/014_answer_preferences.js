/**
 * Migration 014 — Answer preferences (UP-04)
 *
 * Adds `user_profile.preferences` (TEXT, default ''): standing instructions for
 * HOW the user wants to be answered — "keep it brief", "British spelling",
 * "don't apologise".
 *
 * Why it lives on `user_profile` rather than `settings`: it is prompt content,
 * and `settings` is device-ish configuration that never reaches the model. Why
 * it is a separate COLUMN rather than another profile section: "who I am" and
 * "how to answer me" are different instructions, they get different UI surfaces
 * (Profile page vs Settings), and they render as two independently orderable
 * prompt blocks (docs/PROFILE_DESIGN.md, D3).
 *
 * The `user_profile` table itself is created by schema.sql's CREATE TABLE IF NOT
 * EXISTS, so this only has to catch databases that already ran UP-01 before this
 * column existed. Guarded by table + column existence (mirrors migration 013).
 */

/** @param {import('better-sqlite3').Database} db @param {string} table */
function hasColumn(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((col) => col.name === column);
}

/** @param {import('better-sqlite3').Database} db @param {string} table */
function hasTable(db, table) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
}

/** @param {import('better-sqlite3').Database} db */
function up(db) {
  if (!hasTable(db, 'user_profile')) return;
  if (!hasColumn(db, 'user_profile', 'preferences')) {
    db.exec(`ALTER TABLE user_profile ADD COLUMN preferences TEXT DEFAULT ''`);
  }
}

module.exports = { up };
