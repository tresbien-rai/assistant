/**
 * Migration 001 — Workspace Restructure foundation
 *
 * Introduces the two-level hierarchy (workspace ⊃ project ⊃ chat) at the data
 * layer:
 *   1. Adds `projects.workspace_id` and `conversations.workspace_id` (the
 *      `workspaces` table itself is created idempotently in schema.sql).
 *   2. Backfills existing data: every user who already has projects gets a
 *      default "General" workspace; all their projects attach to it, and each
 *      conversation inherits its project's workspace. Unfiled conversations
 *      (no project) stay unfiled.
 *
 * Idempotent: ADD COLUMN is guarded by inspecting the current columns, so a DB
 * that already has them (e.g. a fresh install whose schema.sql gained the
 * columns later) is left untouched. The backfill only touches rows whose
 * `workspace_id` is still NULL, so re-running is a no-op.
 */

const DEFAULT_WORKSPACE_NAME = 'General';

/** @param {import('better-sqlite3').Database} db @param {string} table */
function hasColumn(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((col) => col.name === column);
}

/** @param {import('better-sqlite3').Database} db */
function up(db) {
  // --- 1. Schema: add the workspace_id columns (if not already present) -------
  if (!hasColumn(db, 'projects', 'workspace_id')) {
    db.exec(`ALTER TABLE projects ADD COLUMN workspace_id TEXT`);
  }
  if (!hasColumn(db, 'conversations', 'workspace_id')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN workspace_id TEXT`);
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_workspace_id ON projects(workspace_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_workspace_id ON conversations(workspace_id)`);

  // --- 2. Backfill: a default "General" workspace per user with projects ------
  // Only users who own projects need a default workspace; users with only
  // unfiled chats keep no workspace.
  const usersWithProjects = db
    .prepare(`SELECT DISTINCT user_id FROM projects WHERE workspace_id IS NULL`)
    .all();

  const insertWorkspace = db.prepare(`
    INSERT INTO workspaces (id, user_id, name, instructions, drive_folder_id, created_at, updated_at)
    VALUES (?, ?, ?, '', '', ?, ?)
  `);
  const attachProjects = db.prepare(`
    UPDATE projects SET workspace_id = ? WHERE user_id = ? AND workspace_id IS NULL
  `);

  const crypto = require('node:crypto');

  for (const { user_id: userId } of usersWithProjects) {
    const now = Date.now();
    const workspaceId = crypto.randomUUID();
    insertWorkspace.run(workspaceId, userId, DEFAULT_WORKSPACE_NAME, now, now);
    attachProjects.run(workspaceId, userId);
  }

  // Inherit each project-level chat's workspace from its project. Unfiled chats
  // (project_id IS NULL) are left with workspace_id NULL.
  db.prepare(`
    UPDATE conversations
       SET workspace_id = (
         SELECT p.workspace_id FROM projects p WHERE p.id = conversations.project_id
       )
     WHERE project_id IS NOT NULL
       AND workspace_id IS NULL
  `).run();
}

module.exports = { up };
