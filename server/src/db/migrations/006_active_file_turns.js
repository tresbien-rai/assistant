/**
 * Migration 006 — activeFileTurns setting (File Collaboration, FC-03b)
 *
 * Adds `settings.active_file_turns` (INTEGER, default 1): how many turns a file
 * stays live in context after it is created/edited before it falls out to
 * tool-read. 1 = live for the single exchange immediately after the change.
 * `settings` predates this, so existing rows need the ALTER; fresh installs get
 * it from schema.sql.
 *
 * Idempotent: guarded by table + column existence.
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
  if (!hasTable(db, 'settings')) return;
  if (!hasColumn(db, 'settings', 'active_file_turns')) {
    db.exec(`ALTER TABLE settings ADD COLUMN active_file_turns INTEGER DEFAULT 1`);
  }
}

module.exports = { up };
