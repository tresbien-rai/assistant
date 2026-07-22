/**
 * Migration 008 — Persona tagline + role label
 *
 * Adds two short display fields to `personas`, both used by the persona card
 * grid (and the persona editor's Profile tab):
 *
 * - `tagline`    (TEXT, ''): a one-line, in-character intro shown under the
 *                name. Replaces the system-prompt snippet the card used to
 *                borrow, which always read as leaked config.
 * - `role_label` (TEXT, ''): an optional short role chip ("Researcher",
 *                "Editor") shown on the card next to the Active badge.
 *
 * Both are display-only — neither is sent to the model. Existing personas get
 * '' and fall back to the card's "Add a tagline" empty state.
 *
 * Idempotent: guarded by column existence.
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
  // `personas` comes from schema.sql; a DB that predates it (or the migration
  // test's bare fixture) has nothing to alter.
  if (!hasTable(db, 'personas')) return;
  if (!hasColumn(db, 'personas', 'tagline')) {
    db.exec(`ALTER TABLE personas ADD COLUMN tagline TEXT DEFAULT ''`);
  }
  if (!hasColumn(db, 'personas', 'role_label')) {
    db.exec(`ALTER TABLE personas ADD COLUMN role_label TEXT DEFAULT ''`);
  }
}

module.exports = { up };
