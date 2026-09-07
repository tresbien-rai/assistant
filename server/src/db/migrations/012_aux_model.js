/**
 * Migration 012 — The aux model slot (AX-01)
 *
 * Adds `settings.aux_model` (TEXT, nullable): JSON `{provider, model}` naming a
 * second, usually cheaper model the app may delegate small background work to —
 * naming a new chat today, file digests later (docs/SESSION_STATE_DESIGN.md §7).
 *
 * NULL means "no aux model", which is the honest default: every consumer has to
 * work without one, because a user who never sets it must not lose a feature.
 *
 * Idempotent: guarded by table + column existence (mirrors migration 009).
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
  if (!hasColumn(db, 'settings', 'aux_model')) {
    db.exec(`ALTER TABLE settings ADD COLUMN aux_model TEXT DEFAULT NULL`);
  }
}

module.exports = { up };
