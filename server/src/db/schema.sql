-- =============================================================================
-- Tessera Database Schema
-- =============================================================================
-- All tables use TEXT UUIDs for primary keys (generated via crypto.randomUUID)
-- All timestamps are INTEGER Unix milliseconds
-- All tables include user_id for multi-user data isolation
-- =============================================================================

-- Users table
-- Stores authenticated users with their Google OAuth info and Drive tokens
CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    google_id       TEXT UNIQUE NOT NULL,
    email           TEXT,
    display_name    TEXT,
    drive_token     TEXT,           -- Encrypted access token
    drive_refresh   TEXT,           -- Encrypted refresh token
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);

-- Personas table
-- Customizable AI personalities with their own model configurations
CREATE TABLE IF NOT EXISTS personas (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    system_prompt   TEXT DEFAULT '',
    prefill         TEXT DEFAULT '',
    avatar_filename TEXT DEFAULT '',
    expressions     TEXT DEFAULT '{}',   -- JSON: { "happy": { "emoji": "😊", "imageKey": "..." }, ... }
    model_config    TEXT DEFAULT '{}',   -- JSON: { "provider": "anthropic", "model": "...", "modelParams": {...} }
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_personas_user_id ON personas(user_id);

-- Conversations table
-- Chat sessions linked to a user and optionally a persona/project/workspace.
-- A chat lives in exactly one home: unfiled (neither workspace_id nor
-- project_id), workspace-level (workspace_id only), or project-level (both, with
-- workspace_id = the project's workspace).
-- NOTE: the `workspace_id` column is added by migration 001 (nullable); the
-- migration backfills it from each conversation's project.
CREATE TABLE IF NOT EXISTS conversations (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    persona_id      TEXT REFERENCES personas(id) ON DELETE SET NULL,
    project_id      TEXT,           -- Nullable, for Phase 1 (projects feature)
    title           TEXT DEFAULT 'New Chat',
    tools_enabled   INTEGER,        -- Track A composer override: NULL = inherit persona, 1 = on, 0 = off (migration 004 backfills old DBs)
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_persona_id ON conversations(persona_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at);

-- Messages table
-- Individual messages within a conversation
CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,      -- 'user' or 'assistant'
    content         TEXT DEFAULT '',
    attachments     TEXT DEFAULT '[]',  -- JSON array of attachment metadata
    model           TEXT,               -- model id that generated an assistant message (WR-14); NULL for user/legacy rows
    created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

-- Workspaces table (Workspace Restructure)
-- Outer container above projects: shared/general instructions + reference files.
-- Holds projects and can hold workspace-level chats directly.
-- Hierarchy: workspace ⊃ project ⊃ chat (plus unfiled chats with neither).
CREATE TABLE IF NOT EXISTS workspaces (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    instructions    TEXT DEFAULT '',
    drive_folder_id TEXT DEFAULT '',
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspaces_user_id ON workspaces(user_id);

-- Workspace files table (Workspace Restructure, WR-02b)
-- Metadata for a workspace's shared reference files (bytes live in Drive under
-- `Tessera/<Workspace>/`). Mirrors project_files but scoped to a workspace.
CREATE TABLE IF NOT EXISTS workspace_files (
    id              TEXT PRIMARY KEY,
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    filename        TEXT NOT NULL,
    mime_type       TEXT DEFAULT '',
    size_bytes      INTEGER DEFAULT 0,
    drive_file_id   TEXT DEFAULT '',
    created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspace_files_workspace_id ON workspace_files(workspace_id);

-- Projects table (Phase 1; nested under a workspace by the Workspace Restructure)
-- Collections of files that provide context for conversations.
-- NOTE: the `workspace_id` column is added by migration 001 (ADD COLUMN can't be
-- expressed idempotently here). It is required going forward; the migration
-- backfills existing rows onto a per-user default "General" workspace.
CREATE TABLE IF NOT EXISTS projects (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    instructions    TEXT DEFAULT '',
    drive_folder_id TEXT DEFAULT '',
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);

-- Project files table (Phase 1)
-- Metadata for files stored in Google Drive
CREATE TABLE IF NOT EXISTS project_files (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    filename        TEXT NOT NULL,
    mime_type       TEXT DEFAULT '',
    size_bytes      INTEGER DEFAULT 0,
    drive_file_id   TEXT DEFAULT '',
    created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_files_project_id ON project_files(project_id);

-- User files (Track A, P2-03): tool-created files from UNFILED chats, stored in
-- the user's Tessera/Downloads/ Drive folder. Mirrors project_files but is
-- scoped directly to the user (no container). New table => created here by
-- CREATE TABLE IF NOT EXISTS on boot; no migration needed (WR-02b precedent).
CREATE TABLE IF NOT EXISTS user_files (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename        TEXT NOT NULL,
    mime_type       TEXT DEFAULT '',
    size_bytes      INTEGER DEFAULT 0,
    drive_file_id   TEXT DEFAULT '',
    created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_files_user_id ON user_files(user_id);

-- Conversation files (File Collaboration, FC-01): tool-created files are scoped
-- to the CHAT that made them, regardless of the chat's home (unfiled, workspace,
-- or project). This keeps chat scratch output out of the always-injected
-- project/workspace knowledge base. Bytes live in Drive under
-- `Tessera/Chats/<conversationId>/`. Mirrors user_files but scoped to a
-- conversation. New table => created by CREATE TABLE IF NOT EXISTS on boot; no
-- migration needed (user_files/WR-02b precedent).
-- `last_touched_turn` is reserved for FC-03 (recency-scoped live injection); it
-- is written now so no later migration is needed, and stays NULL until FC-03.
CREATE TABLE IF NOT EXISTS conversation_files (
    id                TEXT PRIMARY KEY,
    conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    filename          TEXT NOT NULL,
    mime_type         TEXT DEFAULT '',
    size_bytes        INTEGER DEFAULT 0,
    drive_file_id     TEXT DEFAULT '',
    last_touched_turn INTEGER,
    created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_files_conversation_id ON conversation_files(conversation_id);

-- File revisions (File Collaboration, FC-02): an append-only change log across
-- every file scope. Each create_file / edit_file / user panel Save appends one
-- row with a bounded unified diff, who made it, and the message/turn it belongs
-- to. Feeds the change history the user browses AND (FC-03) the diff injected
-- alongside the active file. New table => created on boot; no migration needed.
--
-- `scope` is the FileStore kind ('conversation'|'project'|'workspace'|'downloads');
-- `file_id` is the row id in the matching *_files table. There is no single FK
-- for file_id (it spans four tables), but `conversation_id` carries an FK so a
-- deleted chat's revisions cascade away — it is nullable for future
-- (FC-04) panel edits made outside any chat, which simply won't cascade.
CREATE TABLE IF NOT EXISTS file_revisions (
    id              TEXT PRIMARY KEY,
    scope           TEXT NOT NULL,
    file_id         TEXT NOT NULL,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
    message_id      TEXT,
    author          TEXT NOT NULL,      -- 'model' | 'user'
    op              TEXT NOT NULL,      -- 'create' | 'overwrite' | 'edit'
    diff            TEXT DEFAULT '',    -- bounded unified diff (old -> new)
    size_bytes      INTEGER DEFAULT 0,
    drive_file_id   TEXT DEFAULT '',
    turn            INTEGER,            -- conversation turn (user-msg count) at write time (FC-03b)
    created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_revisions_file ON file_revisions(scope, file_id);
CREATE INDEX IF NOT EXISTS idx_file_revisions_conversation_id ON file_revisions(conversation_id);

-- Settings table
-- Per-user application settings
CREATE TABLE IF NOT EXISTS settings (
    id              TEXT PRIMARY KEY,
    user_id         TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    avatar_size     TEXT DEFAULT 'medium',
    avatar_position TEXT DEFAULT 'top-right',
    show_avatar     INTEGER DEFAULT 1,  -- SQLite boolean (0/1)
    custom_models   TEXT DEFAULT '{}',  -- JSON for custom model definitions
    current_model_config TEXT,          -- JSON: the active model layer (WR-12); NULL until the client seeds it
    active_file_turns INTEGER DEFAULT 1, -- turns a file stays live in context after a change (FC-03b)
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_settings_user_id ON settings(user_id);

-- API Keys table
-- Encrypted API keys for AI providers
CREATE TABLE IF NOT EXISTS api_keys (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider        TEXT NOT NULL,      -- 'anthropic', 'google', 'openai'
    encrypted_key   TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    UNIQUE(user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_provider ON api_keys(user_id, provider);
