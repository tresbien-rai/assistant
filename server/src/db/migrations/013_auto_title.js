/**
 * Migration 013 — Automatic chat naming (AX-02)
 *
 * Adds `settings.auto_title` (INTEGER, default 1): whether a new chat is named
 * automatically after its first exchange.
 *
 * Defaults ON. A chat list of twenty rows all reading "New Chat" is the state
 * this replaces, and the fallback path needs no API key, so the feature is
 * useful to everyone from the first load. The toggle exists because with an aux
 * model set, naming spends money the user did not directly ask to spend.
 *
 * Idempotent: guarded by table + column existence (mirrors migration 012).
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
  if (!hasColumn(db, 'settings', 'auto_title')) {
    db.exec(`ALTER TABLE settings ADD COLUMN auto_title INTEGER DEFAULT 1`);
  }
}

module.exports = { up };
