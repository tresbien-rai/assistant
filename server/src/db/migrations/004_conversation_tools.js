/**
 * Migration 004 — Per-conversation tools override (Track A, P2-02)
 *
 * Adds `conversations.tools_enabled` (INTEGER, nullable tri-state): the
 * composer's file-tools override for this conversation. NULL = inherit the
 * persona's base setting (model_config.toolsEnabled), 1 = on, 0 = off.
 * See "Decisions" (2) in docs/PHASE2_TASKS.md.
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
  if (!hasTable(db, 'conversations')) return;
  if (!hasColumn(db, 'conversations', 'tools_enabled')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN tools_enabled INTEGER`);
  }
}

module.exports = { up };
