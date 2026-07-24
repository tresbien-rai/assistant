/**
 * Migration 010 — Per-file context toggles (CT-01)
 *
 * Adds the container-level default and the chat-file inject mode that
 * docs/CONTEXT_TOGGLES_DESIGN.md builds on:
 *
 *   - `project_files.enabled`      INTEGER, default 1 — is this knowledge file
 *   - `workspace_files.enabled`    INTEGER, default 1   loaded into chats?
 *   - `conversation_files.inject_mode` TEXT, nullable — NULL/'auto' = the
 *     existing recency window, 'pin' = inject every turn, 'mute' = never.
 *
 * The `enabled` columns are added WITH a default of 1 so every pre-existing row
 * backfills to today's behaviour (everything loaded). Reading code still treats
 * NULL as 1, so a row written by any path that ignores the column is also safe.
 *
 * The per-chat override table (`conversation_context_overrides`) is NOT created
 * here — it is brand new, so `CREATE TABLE IF NOT EXISTS` in schema.sql covers
 * both fresh and existing databases (user_files / WR-02b precedent).
 *
 * Idempotent: guarded by table + column existence (mirrors migrations 004/009).
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
  for (const table of ['project_files', 'workspace_files']) {
    if (!hasTable(db, table)) continue;
    if (!hasColumn(db, table, 'enabled')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN enabled INTEGER DEFAULT 1`);
    }
  }

  if (hasTable(db, 'conversation_files') && !hasColumn(db, 'conversation_files', 'inject_mode')) {
    db.exec(`ALTER TABLE conversation_files ADD COLUMN inject_mode TEXT`);
  }
}

module.exports = { up };
