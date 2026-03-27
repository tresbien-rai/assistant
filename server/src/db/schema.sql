-- =============================================================================
-- AI Assistant Database Schema
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
-- Chat sessions linked to a user and optionally a persona/project
CREATE TABLE IF NOT EXISTS conversations (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    persona_id      TEXT REFERENCES personas(id) ON DELETE SET NULL,
    project_id      TEXT,           -- Nullable, for Phase 1 (projects feature)
    title           TEXT DEFAULT 'New Chat',
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
    created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

-- Projects table (Phase 1)
-- Collections of files that provide context for conversations
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

-- Settings table
-- Per-user application settings
CREATE TABLE IF NOT EXISTS settings (
    id              TEXT PRIMARY KEY,
    user_id         TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    avatar_size     TEXT DEFAULT 'medium',
    avatar_position TEXT DEFAULT 'top-right',
    show_avatar     INTEGER DEFAULT 1,  -- SQLite boolean (0/1)
    custom_models   TEXT DEFAULT '{}',  -- JSON for custom model definitions
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
