/**
 * Migration 011 — Prompt preset pointers (AP-01)
 *
 * The `prompt_presets` table itself is created on boot by schema.sql
 * (CREATE TABLE IF NOT EXISTS). What needs a migration is the two columns that
 * POINT at a preset on existing installs:
 *
 *   settings.default_preset_id      the user's default preset
 *   conversations.preset_id         a per-chat override of it
 *
 * Both nullable; NULL means "inherit the next level down", ending at the
 * built-in prompt layer. See docs/ADVANCED_PROMPTS_PLAN.md (Decision D4) for the
 * resolution order.
 *
 * No FK constraint on purpose: SQLite can't add one with ALTER TABLE, and the
 * DAL already has to tolerate a dangling id (a deleted preset must fall back to
 * the built-in rather than break the chat), so the constraint would buy nothing
 * the read path doesn't already do.
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
  if (hasTable(db, 'settings') && !hasColumn(db, 'settings', 'default_preset_id')) {
    db.exec(`ALTER TABLE settings ADD COLUMN default_preset_id TEXT`);
  }
  if (hasTable(db, 'conversations') && !hasColumn(db, 'conversations', 'preset_id')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN preset_id TEXT`);
  }
}

module.exports = { up };
