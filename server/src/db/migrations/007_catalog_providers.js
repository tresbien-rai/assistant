/**
 * Migration 007 — catalogProviders setting (Models tab redesign, Slice 2)
 *
 * Adds `settings.catalog_providers` (TEXT, default NULL): the user's "daily
 * drivers" provider filter for the Models catalog. Stored as a JSON array of
 * provider ids (e.g. '["anthropic","google"]'); NULL means "All providers".
 * `settings` predates this, so existing rows need the ALTER; fresh installs get
 * it from schema.sql. NULL default means no backfill — existing users read as
 * "All" until they curate a subset.
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
  if (!hasColumn(db, 'settings', 'catalog_providers')) {
    db.exec(`ALTER TABLE settings ADD COLUMN catalog_providers TEXT DEFAULT NULL`);
  }
}

module.exports = { up };
