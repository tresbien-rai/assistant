/**
 * Migration 015 — Segmented persona prompts (PS-01)
 *
 * Adds `personas.sections` (TEXT, default '{}'): a JSON object of authored
 * persona parts — personality, speech, expertise, relationship, backstory —
 * that assemble into the single persona prompt block alongside the existing
 * `system_prompt`, which keeps its meaning as the general-guidance section.
 *
 * Why segmentation: a lone "System Prompt" textarea is a blank page, and blank
 * pages are where people give up. Named boxes tell someone what is worth
 * writing without making them invent a structure first.
 *
 * NOTHING MIGRATES. Existing personas keep their `system_prompt` exactly as it
 * is and start with empty sections, so no data moves and nobody's character is
 * reshaped by an upgrade.
 *
 * Numbered 015, not 014: 014 was `014_answer_preferences`, built and then
 * reverted (#199 → #200). Databases that ran it still carry that id in
 * `schema_migrations`. Ids are full filenames so a second 014 would not
 * actually collide, but two different migrations sharing a number is the kind
 * of thing that costs someone an hour later.
 *
 * Idempotent: guarded by table + column existence (mirrors migration 013).
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
  if (!hasColumn(db, 'personas', 'sections')) {
    db.exec(`ALTER TABLE personas ADD COLUMN sections TEXT DEFAULT '{}'`);
  }
}

module.exports = { up };
