/**
 * Migration 005 — Turn ordinal on file revisions (File Collaboration, FC-03b)
 *
 * Adds `file_revisions.turn` (INTEGER, nullable): the conversation turn a
 * revision was made in, stamped as the count of user messages at write time.
 * The recency-scoped active-file injection compares it against the current turn
 * to decide which files are "live". `file_revisions` is created by schema.sql
 * (CREATE TABLE IF NOT EXISTS), so existing DBs need this ALTER; fresh installs
 * get the column from schema.sql.
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
  if (!hasTable(db, 'file_revisions')) return;
  if (!hasColumn(db, 'file_revisions', 'turn')) {
    db.exec(`ALTER TABLE file_revisions ADD COLUMN turn INTEGER`);
  }
}

module.exports = { up };
