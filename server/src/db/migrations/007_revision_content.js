/**
 * Migration 007 — Revision content snapshots (File Collaboration, FC-06a)
 *
 * Adds `file_revisions.content` (TEXT, nullable): a full-text snapshot of the
 * file AS OF that revision, kept for the most recent N revisions per file
 * (older ones are pruned back to NULL). This is what lets a re-roll roll a
 * file back to its pre-turn state, and (FC-06b) lets the viewer show/compare/
 * restore whole versions. `file_revisions` is created by schema.sql, so
 * existing DBs need this ALTER; fresh installs get the column from schema.sql.
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
  if (!hasColumn(db, 'file_revisions', 'content')) {
    db.exec(`ALTER TABLE file_revisions ADD COLUMN content TEXT`);
  }
}

module.exports = { up };
