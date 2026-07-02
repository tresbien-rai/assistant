/**
 * Migration 003 — Per-message model tag (WR-14)
 *
 * Adds `messages.model` (TEXT, nullable): the model id that generated an
 * assistant message, recorded at send time by the client. Old messages stay
 * NULL and simply render without a tag. See docs/MODEL_DESYNC_DESIGN.md.
 *
 * Idempotent: guarded by table + column existence (test fixtures may omit
 * tables they don't exercise; fresh installs get the column from schema.sql).
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
  if (!hasTable(db, 'messages')) return;
  if (!hasColumn(db, 'messages', 'model')) {
    db.exec(`ALTER TABLE messages ADD COLUMN model TEXT`);
  }
}

module.exports = { up };
