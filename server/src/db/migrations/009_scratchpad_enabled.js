/**
 * Migration 009 — Per-conversation scratchpad override (SP-02)
 *
 * Adds `conversations.scratchpad_enabled` (INTEGER, nullable tri-state): the
 * scratchpad toggle for this conversation. NULL = inherit the persona base
 * (model_config.scratchpadEnabled), then auto-arm when the pad is non-empty;
 * 1 = on, 0 = off. See docs/SCRATCHPAD_DESIGN.md (Decision 2).
 *
 * Idempotent: guarded by table + column existence (mirrors migration 004).
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
  if (!hasColumn(db, 'conversations', 'scratchpad_enabled')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN scratchpad_enabled INTEGER`);
  }
}

module.exports = { up };
