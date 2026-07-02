/**
 * Migration 002 — Active model layer (WR-12, model/persona de-sync)
 *
 * Adds `settings.current_model_config` (JSON TEXT, nullable): the user-level
 * "active model layer" — provider + model + params — that every chat send
 * uses. Personas keep their own model_config; a per-persona mode flag inside
 * that JSON ('shared' | 'fixed') decides whether activating the persona loads
 * its config into the layer. See docs/MODEL_DESYNC_DESIGN.md.
 *
 * No backfill: the column stays NULL and the client seeds the layer from the
 * active persona's config on first load after the upgrade, so nothing visibly
 * changes at the moment of deploy.
 *
 * Idempotent: ADD COLUMN is guarded by inspecting the current columns.
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
  // No settings table = nothing to migrate: in production schema.sql runs
  // before migrations and creates it WITH the column; test fixtures may omit
  // tables they don't exercise.
  if (!hasTable(db, 'settings')) return;
  if (!hasColumn(db, 'settings', 'current_model_config')) {
    db.exec(`ALTER TABLE settings ADD COLUMN current_model_config TEXT`);
  }
}

module.exports = { up };
