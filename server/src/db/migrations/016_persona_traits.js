/**
 * Migration 016 — Persona traits (PT-04)
 *
 * Adds `personas.traits` (TEXT, default '{}'): a JSON object of the ready-made
 * traits a persona has picked, per section, in pick order:
 *
 *   { "personality": [{ "id": "calm" }, { "id": "doting", "text": "…" }] }
 *
 * An entry without `text` follows the trait library (js/persona-traits.js);
 * one with `text` is customised and keeps its own wording. See
 * docs/design/PERSONA_TRAITS_DESIGN.md §3.
 *
 * NOTHING MIGRATES. `personas.sections` keeps its meaning as each section's
 * free text (the "Custom" entry), so every existing persona assembles exactly
 * as before with no picks.
 *
 * Idempotent: guarded by table + column existence (mirrors migration 015).
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
  if (!hasTable(db, 'personas')) return;
  if (!hasColumn(db, 'personas', 'traits')) {
    db.exec(`ALTER TABLE personas ADD COLUMN traits TEXT DEFAULT '{}'`);
  }
}

module.exports = { up };
