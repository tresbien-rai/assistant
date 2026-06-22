/**
 * Data Access Layer (DAL)
 *
 * Provides functions for all database operations, abstracting SQLite queries.
 * All functions that accept userId use it in WHERE clauses to enforce data isolation.
 */

const { getDb, generateId, now } = require('./connection');

// =============================================================================
// USERS
// =============================================================================

/**
 * Find a user by their Google ID
 * @param {string} googleId - The Google OAuth ID
 * @returns {Object|undefined} The user record or undefined
 */
function findUserByGoogleId(googleId) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId);
}

/**
 * Find a user by their internal ID
 * @param {string} userId - The user's UUID
 * @returns {Object|undefined} The user record or undefined
 */
function findUserById(userId) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

/**
 * Create a new user
 * @param {Object} data - User data
 * @param {string} data.googleId - Google OAuth ID
 * @param {string} [data.email] - User's email
 * @param {string} [data.displayName] - User's display name
 * @param {string} [data.driveToken] - Encrypted Drive access token
 * @param {string} [data.driveRefresh] - Encrypted Drive refresh token
 * @returns {Object} The created user record
 */
function createUser({ googleId, email, displayName, driveToken, driveRefresh }) {
  const db = getDb();
  const id = generateId();
  const timestamp = now();

  const stmt = db.prepare(`
    INSERT INTO users (id, google_id, email, display_name, drive_token, drive_refresh, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(id, googleId, email || null, displayName || null, driveToken || null, driveRefresh || null, timestamp, timestamp);

  return findUserById(id);
}

/**
 * Update a user's Drive tokens
 * @param {string} userId - The user's UUID
 * @param {Object} tokens - Token data
 * @param {string} [tokens.driveToken] - Encrypted Drive access token
 * @param {string} [tokens.driveRefresh] - Encrypted Drive refresh token
 * @returns {Object} The updated user record
 */
function updateUserDriveTokens(userId, { driveToken, driveRefresh }) {
  const db = getDb();
  const timestamp = now();

  const stmt = db.prepare(`
    UPDATE users SET drive_token = ?, drive_refresh = ?, updated_at = ?
    WHERE id = ?
  `);

  stmt.run(driveToken || null, driveRefresh || null, timestamp, userId);

  return findUserById(userId);
}

// =============================================================================
// PERSONAS
// =============================================================================

/**
 * Get all personas for a user
 * @param {string} userId - The user's UUID
 * @returns {Array} Array of persona records
 */
function getPersonasByUser(userId) {
  const db = getDb();
  const personas = db.prepare(`
    SELECT * FROM personas WHERE user_id = ? ORDER BY updated_at DESC
  `).all(userId);

  return personas.map(parsePersonaJson);
}

/**
 * Get a single persona by ID (only if owned by the user)
 * @param {string} personaId - The persona's UUID
 * @param {string} userId - The user's UUID
 * @returns {Object|undefined} The persona record or undefined
 */
function getPersonaById(personaId, userId) {
  const db = getDb();
  const persona = db.prepare(`
    SELECT * FROM personas WHERE id = ? AND user_id = ?
  `).get(personaId, userId);

  return persona ? parsePersonaJson(persona) : undefined;
}

/**
 * Create a new persona
 * @param {string} userId - The user's UUID
 * @param {Object} data - Persona data
 * @returns {Object} The created persona record
 */
function createPersona(userId, { name, systemPrompt, prefill, avatarFilename, expressions, modelConfig }) {
  const db = getDb();
  const id = generateId();
  const timestamp = now();

  const stmt = db.prepare(`
    INSERT INTO personas (id, user_id, name, system_prompt, prefill, avatar_filename, expressions, model_config, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    userId,
    name || 'New Persona',
    systemPrompt || '',
    prefill || '',
    avatarFilename || '',
    JSON.stringify(expressions || {}),
    JSON.stringify(modelConfig || {}),
    timestamp,
    timestamp
  );

  return getPersonaById(id, userId);
}

/**
 * Update a persona
 * @param {string} personaId - The persona's UUID
 * @param {string} userId - The user's UUID
 * @param {Object} data - Fields to update
 * @returns {Object|undefined} The updated persona record or undefined if not found
 */
function updatePersona(personaId, userId, data) {
  const db = getDb();
  const existing = getPersonaById(personaId, userId);
  if (!existing) return undefined;

  const timestamp = now();
  const updates = [];
  const values = [];

  if (data.name !== undefined) {
    updates.push('name = ?');
    values.push(data.name);
  }
  if (data.systemPrompt !== undefined) {
    updates.push('system_prompt = ?');
    values.push(data.systemPrompt);
  }
  if (data.prefill !== undefined) {
    updates.push('prefill = ?');
    values.push(data.prefill);
  }
  if (data.avatarFilename !== undefined) {
    updates.push('avatar_filename = ?');
    values.push(data.avatarFilename);
  }
  if (data.expressions !== undefined) {
    updates.push('expressions = ?');
    values.push(JSON.stringify(data.expressions));
  }
  if (data.modelConfig !== undefined) {
    updates.push('model_config = ?');
    values.push(JSON.stringify(data.modelConfig));
  }

  if (updates.length === 0) {
    return existing;
  }

  updates.push('updated_at = ?');
  values.push(timestamp);
  values.push(personaId);
  values.push(userId);

  const stmt = db.prepare(`
    UPDATE personas SET ${updates.join(', ')} WHERE id = ? AND user_id = ?
  `);

  stmt.run(...values);

  return getPersonaById(personaId, userId);
}

/**
 * Delete a persona and all its conversations
 * @param {string} personaId - The persona's UUID
 * @param {string} userId - The user's UUID
 * @returns {boolean} True if deleted, false if not found
 */
function deletePersona(personaId, userId) {
  const db = getDb();
  const existing = getPersonaById(personaId, userId);
  if (!existing) return false;

  // Check if this is the user's only persona
  const count = db.prepare('SELECT COUNT(*) as count FROM personas WHERE user_id = ?').get(userId);
  if (count.count <= 1) {
    throw new Error('Cannot delete the last remaining persona');
  }

  // Use a transaction to ensure atomicity
  const deleteTransaction = db.transaction(() => {
    // First, delete all conversations linked to this persona
    // (messages will cascade delete due to FK constraint on messages.conversation_id)
    db.prepare('DELETE FROM conversations WHERE persona_id = ? AND user_id = ?').run(personaId, userId);

    // Then delete the persona itself
    const stmt = db.prepare('DELETE FROM personas WHERE id = ? AND user_id = ?');
    return stmt.run(personaId, userId);
  });

  const result = deleteTransaction();
  return result.changes > 0;
}

/**
 * Count personas for a user
 * @param {string} userId - The user's UUID
 * @returns {number} Number of personas
 */
function countPersonasByUser(userId) {
  const db = getDb();
  const result = db.prepare('SELECT COUNT(*) as count FROM personas WHERE user_id = ?').get(userId);
  return result.count;
}

/**
 * Parse JSON fields in a persona record
 */
function parsePersonaJson(persona) {
  return {
    ...persona,
    expressions: JSON.parse(persona.expressions || '{}'),
    modelConfig: JSON.parse(persona.model_config || '{}'),
  };
}

// =============================================================================
// CONVERSATIONS
// =============================================================================

/**
 * Get all conversations for a user
 * @param {string} userId - The user's UUID
 * @param {Object} [options] - Query options
 * @param {string} [options.personaId] - Filter by persona ID
 * @param {number} [options.limit] - Limit results
 * @param {number} [options.offset] - Offset for pagination
 * @returns {Array} Array of conversation records with message counts
 */
function getConversationsByUser(userId, { personaId, limit, offset } = {}) {
  const db = getDb();

  let query = `
    SELECT c.*,
           (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count
    FROM conversations c
    WHERE c.user_id = ?
  `;
  const params = [userId];

  if (personaId) {
    query += ' AND c.persona_id = ?';
    params.push(personaId);
  }

  query += ' ORDER BY c.updated_at DESC';

  if (limit) {
    query += ' LIMIT ?';
    params.push(limit);
  }

  if (offset) {
    query += ' OFFSET ?';
    params.push(offset);
  }

  return db.prepare(query).all(...params);
}

/**
 * Get a single conversation's metadata (no messages), user-scoped.
 * Lightweight alternative to getConversationById for hot paths that only need
 * fields like project_id and don't want to load the full message history.
 * @param {string} conversationId - The conversation's UUID
 * @param {string} userId - The user's UUID
 * @returns {Object|undefined} The conversation row or undefined
 */
function getConversationMeta(conversationId, userId) {
  const db = getDb();
  return db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId);
}

/**
 * Get a single conversation by ID with all its messages
 * @param {string} conversationId - The conversation's UUID
 * @param {string} userId - The user's UUID
 * @returns {Object|undefined} The conversation with messages or undefined
 */
function getConversationById(conversationId, userId) {
  const db = getDb();

  const conversation = db.prepare(`
    SELECT * FROM conversations WHERE id = ? AND user_id = ?
  `).get(conversationId, userId);

  if (!conversation) return undefined;

  const messages = db.prepare(`
    SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC
  `).all(conversationId);

  return {
    ...conversation,
    messages: messages.map(parseMessageJson),
  };
}

/**
 * Create a new conversation
 * @param {string} userId - The user's UUID
 * @param {Object} data - Conversation data
 * @returns {Object} The created conversation record
 */
function createConversation(userId, { personaId, title, projectId }) {
  const db = getDb();
  const id = generateId();
  const timestamp = now();

  const stmt = db.prepare(`
    INSERT INTO conversations (id, user_id, persona_id, project_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(id, userId, personaId || null, projectId || null, title || 'New Chat', timestamp, timestamp);

  return getConversationById(id, userId);
}

/**
 * Update a conversation
 * @param {string} conversationId - The conversation's UUID
 * @param {string} userId - The user's UUID
 * @param {Object} data - Fields to update
 * @returns {Object|undefined} The updated conversation or undefined if not found
 */
function updateConversation(conversationId, userId, data) {
  const db = getDb();

  // Verify ownership
  const existing = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId);
  if (!existing) return undefined;

  const timestamp = now();
  const updates = [];
  const values = [];

  if (data.title !== undefined) {
    updates.push('title = ?');
    values.push(data.title);
  }
  if (data.personaId !== undefined) {
    updates.push('persona_id = ?');
    values.push(data.personaId);
  }
  if (data.projectId !== undefined) {
    updates.push('project_id = ?');
    values.push(data.projectId);
  }

  if (updates.length === 0) {
    return getConversationById(conversationId, userId);
  }

  updates.push('updated_at = ?');
  values.push(timestamp);
  values.push(conversationId);
  values.push(userId);

  const stmt = db.prepare(`
    UPDATE conversations SET ${updates.join(', ')} WHERE id = ? AND user_id = ?
  `);

  stmt.run(...values);

  return getConversationById(conversationId, userId);
}

/**
 * Delete a conversation and all its messages
 * @param {string} conversationId - The conversation's UUID
 * @param {string} userId - The user's UUID
 * @returns {boolean} True if deleted, false if not found
 */
function deleteConversation(conversationId, userId) {
  const db = getDb();

  const stmt = db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?');
  const result = stmt.run(conversationId, userId);

  return result.changes > 0;
}

/**
 * Touch a conversation's updated_at timestamp
 * @param {string} conversationId - The conversation's UUID
 */
function touchConversation(conversationId) {
  const db = getDb();
  const timestamp = now();
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(timestamp, conversationId);
}

// =============================================================================
// MESSAGES
// =============================================================================

/**
 * Get all messages for a conversation
 * @param {string} conversationId - The conversation's UUID
 * @param {string} userId - The user's UUID (for ownership verification)
 * @returns {Array} Array of message records
 */
function getMessagesByConversation(conversationId, userId) {
  const db = getDb();

  // Verify conversation ownership
  const conversation = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId);
  if (!conversation) return [];

  const messages = db.prepare(`
    SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC
  `).all(conversationId);

  return messages.map(parseMessageJson);
}

/**
 * Create a new message
 * @param {string} conversationId - The conversation's UUID
 * @param {Object} data - Message data
 * @returns {Object} The created message record
 */
function createMessage(conversationId, { role, content, attachments }) {
  const db = getDb();
  const id = generateId();
  const timestamp = now();

  const stmt = db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, attachments, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(id, conversationId, role, content || '', JSON.stringify(attachments || []), timestamp);

  // Touch the conversation's updated_at
  touchConversation(conversationId);

  return parseMessageJson(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
}

/**
 * Update a message's content
 * @param {string} messageId - The message's UUID
 * @param {Object} data - Fields to update
 * @returns {Object|undefined} The updated message or undefined if not found
 */
function updateMessage(messageId, { content }) {
  const db = getDb();

  const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!existing) return undefined;

  if (content !== undefined) {
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, messageId);
  }

  // Touch the conversation's updated_at
  touchConversation(existing.conversation_id);

  return parseMessageJson(db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId));
}

/**
 * Delete a message
 * @param {string} messageId - The message's UUID
 * @returns {boolean} True if deleted, false if not found
 */
function deleteMessage(messageId) {
  const db = getDb();

  const existing = db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(messageId);
  if (!existing) return false;

  const result = db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);

  if (result.changes > 0) {
    touchConversation(existing.conversation_id);
  }

  return result.changes > 0;
}

/**
 * Parse JSON fields in a message record
 */
function parseMessageJson(message) {
  return {
    ...message,
    attachments: JSON.parse(message.attachments || '[]'),
  };
}

// =============================================================================
// SETTINGS
// =============================================================================

/**
 * Get settings for a user
 * @param {string} userId - The user's UUID
 * @returns {Object} The settings record (or defaults if none exist)
 */
function getSettingsByUser(userId) {
  const db = getDb();

  const settings = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(userId);

  if (settings) {
    return parseSettingsJson(settings);
  }

  // Return defaults
  return {
    avatarSize: 'medium',
    avatarPosition: 'top-right',
    showAvatar: true,
    customModels: {},
  };
}

/**
 * Upsert settings for a user
 * @param {string} userId - The user's UUID
 * @param {Object} data - Settings to update
 * @returns {Object} The updated settings record
 */
function upsertSettings(userId, data) {
  const db = getDb();
  const timestamp = now();

  const existing = db.prepare('SELECT id FROM settings WHERE user_id = ?').get(userId);

  if (existing) {
    const updates = [];
    const values = [];

    if (data.avatarSize !== undefined) {
      updates.push('avatar_size = ?');
      values.push(data.avatarSize);
    }
    if (data.avatarPosition !== undefined) {
      updates.push('avatar_position = ?');
      values.push(data.avatarPosition);
    }
    if (data.showAvatar !== undefined) {
      updates.push('show_avatar = ?');
      values.push(data.showAvatar ? 1 : 0);
    }
    if (data.customModels !== undefined) {
      updates.push('custom_models = ?');
      values.push(JSON.stringify(data.customModels));
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?');
      values.push(timestamp);
      values.push(userId);

      db.prepare(`UPDATE settings SET ${updates.join(', ')} WHERE user_id = ?`).run(...values);
    }
  } else {
    const id = generateId();
    db.prepare(`
      INSERT INTO settings (id, user_id, avatar_size, avatar_position, show_avatar, custom_models, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      userId,
      data.avatarSize || 'medium',
      data.avatarPosition || 'top-right',
      data.showAvatar !== undefined ? (data.showAvatar ? 1 : 0) : 1,
      JSON.stringify(data.customModels || {}),
      timestamp,
      timestamp
    );
  }

  return getSettingsByUser(userId);
}

/**
 * Parse JSON fields in a settings record and convert to camelCase
 */
function parseSettingsJson(settings) {
  return {
    id: settings.id,
    userId: settings.user_id,
    avatarSize: settings.avatar_size,
    avatarPosition: settings.avatar_position,
    showAvatar: Boolean(settings.show_avatar),
    customModels: JSON.parse(settings.custom_models || '{}'),
    createdAt: settings.created_at,
    updatedAt: settings.updated_at,
  };
}

// =============================================================================
// API KEYS
// =============================================================================

/**
 * Get an encrypted API key for a user and provider
 * @param {string} userId - The user's UUID
 * @param {string} provider - The provider name ('anthropic', 'google', 'openai')
 * @returns {Object|undefined} The API key record or undefined
 */
function getApiKey(userId, provider) {
  const db = getDb();
  return db.prepare('SELECT * FROM api_keys WHERE user_id = ? AND provider = ?').get(userId, provider);
}

/**
 * Upsert an encrypted API key
 * @param {string} userId - The user's UUID
 * @param {string} provider - The provider name
 * @param {string} encryptedKey - The encrypted API key
 * @returns {Object} The API key record
 */
function upsertApiKey(userId, provider, encryptedKey) {
  const db = getDb();
  const timestamp = now();

  const existing = getApiKey(userId, provider);

  if (existing) {
    db.prepare(`
      UPDATE api_keys SET encrypted_key = ?, updated_at = ? WHERE user_id = ? AND provider = ?
    `).run(encryptedKey, timestamp, userId, provider);
  } else {
    const id = generateId();
    db.prepare(`
      INSERT INTO api_keys (id, user_id, provider, encrypted_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, userId, provider, encryptedKey, timestamp, timestamp);
  }

  return getApiKey(userId, provider);
}

/**
 * Delete an API key
 * @param {string} userId - The user's UUID
 * @param {string} provider - The provider name
 * @returns {boolean} True if deleted, false if not found
 */
function deleteApiKey(userId, provider) {
  const db = getDb();
  const result = db.prepare('DELETE FROM api_keys WHERE user_id = ? AND provider = ?').run(userId, provider);
  return result.changes > 0;
}

/**
 * Get all providers that have keys stored for a user
 * @param {string} userId - The user's UUID
 * @returns {Array} Array of { provider, hasKey: true, updatedAt }
 */
function getApiKeyProviders(userId) {
  const db = getDb();
  const keys = db.prepare('SELECT provider, updated_at FROM api_keys WHERE user_id = ?').all(userId);
  return keys.map(k => ({
    provider: k.provider,
    hasKey: true,
    updatedAt: k.updated_at,
  }));
}

// =============================================================================
// PROJECTS
// =============================================================================

/**
 * Create a new project
 * @param {string} userId - The user's UUID
 * @param {Object} data - Project data
 * @param {string} data.name - Project name
 * @param {string} [data.instructions] - Project instructions
 * @param {string} [data.driveFolderId] - Drive folder id backing this project
 * @returns {Object} The created project record
 */
function createProject(userId, { name, instructions, driveFolderId }) {
  const db = getDb();
  const id = generateId();
  const timestamp = now();

  const stmt = db.prepare(`
    INSERT INTO projects (id, user_id, name, instructions, drive_folder_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(id, userId, name || 'New Project', instructions || '', driveFolderId || '', timestamp, timestamp);

  return getProjectById(id, userId);
}

/**
 * Get all projects for a user
 * @param {string} userId - The user's UUID
 * @returns {Array} Array of project records (with file counts)
 */
function listProjectsByUser(userId) {
  const db = getDb();
  return db.prepare(`
    SELECT p.*,
           (SELECT COUNT(*) FROM project_files f WHERE f.project_id = p.id) as file_count
    FROM projects p
    WHERE p.user_id = ?
    ORDER BY p.updated_at DESC
  `).all(userId);
}

/**
 * Get a single project by ID (only if owned by the user)
 * @param {string} projectId - The project's UUID
 * @param {string} userId - The user's UUID
 * @returns {Object|undefined} The project record or undefined
 */
function getProjectById(projectId, userId) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM projects WHERE id = ? AND user_id = ?
  `).get(projectId, userId);
}

/**
 * Update a project
 * @param {string} projectId - The project's UUID
 * @param {string} userId - The user's UUID
 * @param {Object} data - Fields to update (name, instructions, driveFolderId)
 * @returns {Object|undefined} The updated project or undefined if not found
 */
function updateProject(projectId, userId, data) {
  const db = getDb();
  const existing = getProjectById(projectId, userId);
  if (!existing) return undefined;

  const timestamp = now();
  const updates = [];
  const values = [];

  if (data.name !== undefined) {
    updates.push('name = ?');
    values.push(data.name);
  }
  if (data.instructions !== undefined) {
    updates.push('instructions = ?');
    values.push(data.instructions);
  }
  if (data.driveFolderId !== undefined) {
    updates.push('drive_folder_id = ?');
    values.push(data.driveFolderId);
  }

  if (updates.length === 0) {
    return existing;
  }

  updates.push('updated_at = ?');
  values.push(timestamp);
  values.push(projectId);
  values.push(userId);

  db.prepare(`
    UPDATE projects SET ${updates.join(', ')} WHERE id = ? AND user_id = ?
  `).run(...values);

  return getProjectById(projectId, userId);
}

/**
 * Delete a project and its file metadata (project_files cascade via FK).
 * Trashing the backing Drive folder is the route's responsibility.
 * @param {string} projectId - The project's UUID
 * @param {string} userId - The user's UUID
 * @returns {boolean} True if deleted, false if not found
 */
function deleteProject(projectId, userId) {
  const db = getDb();
  const result = db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?').run(projectId, userId);
  return result.changes > 0;
}

// =============================================================================
// PROJECT FILES
// =============================================================================
//
// File functions are scoped by projectId. Callers MUST first verify the project
// belongs to the user (via getProjectById(projectId, userId)) before using these.

/**
 * Record a project file's metadata (the bytes live on Drive).
 * @param {string} projectId - The project's UUID
 * @param {Object} data - File metadata
 * @param {string} data.filename - Original filename
 * @param {string} [data.mimeType] - MIME type
 * @param {number} [data.sizeBytes] - File size in bytes
 * @param {string} [data.driveFileId] - Drive file id
 * @returns {Object} The created project_files record
 */
function addProjectFile(projectId, { filename, mimeType, sizeBytes, driveFileId }) {
  const db = getDb();
  const id = generateId();
  const timestamp = now();

  db.prepare(`
    INSERT INTO project_files (id, project_id, filename, mime_type, size_bytes, drive_file_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectId, filename, mimeType || '', sizeBytes || 0, driveFileId || '', timestamp);

  return db.prepare('SELECT * FROM project_files WHERE id = ?').get(id);
}

/**
 * List a project's files (metadata only, from SQLite — no Drive calls).
 * @param {string} projectId - The project's UUID
 * @returns {Array} Array of project_files records
 */
function listProjectFiles(projectId) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM project_files WHERE project_id = ? ORDER BY created_at ASC
  `).all(projectId);
}

/**
 * Get a single project file (scoped to its project).
 * @param {string} fileId - The file's UUID
 * @param {string} projectId - The project's UUID
 * @returns {Object|undefined} The project_files record or undefined
 */
function getProjectFile(fileId, projectId) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM project_files WHERE id = ? AND project_id = ?
  `).get(fileId, projectId);
}

/**
 * Delete a project file's metadata row (scoped to its project).
 * Removing the file from Drive is the route's responsibility.
 * @param {string} fileId - The file's UUID
 * @param {string} projectId - The project's UUID
 * @returns {boolean} True if deleted, false if not found
 */
function deleteProjectFile(fileId, projectId) {
  const db = getDb();
  const result = db.prepare('DELETE FROM project_files WHERE id = ? AND project_id = ?').run(fileId, projectId);
  return result.changes > 0;
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Users
  findUserByGoogleId,
  findUserById,
  createUser,
  updateUserDriveTokens,

  // Personas
  getPersonasByUser,
  getPersonaById,
  createPersona,
  updatePersona,
  deletePersona,
  countPersonasByUser,

  // Conversations
  getConversationsByUser,
  getConversationMeta,
  getConversationById,
  createConversation,
  updateConversation,
  deleteConversation,

  // Messages
  getMessagesByConversation,
  createMessage,
  updateMessage,
  deleteMessage,

  // Settings
  getSettingsByUser,
  upsertSettings,

  // API Keys
  getApiKey,
  upsertApiKey,
  deleteApiKey,
  getApiKeyProviders,

  // Projects
  createProject,
  listProjectsByUser,
  getProjectById,
  updateProject,
  deleteProject,

  // Project Files
  addProjectFile,
  listProjectFiles,
  getProjectFile,
  deleteProjectFile,
};
