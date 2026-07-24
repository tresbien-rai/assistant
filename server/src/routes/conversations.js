/**
 * Conversations and Messages Routes
 *
 * REST API endpoints for conversation and message management.
 * Conversations contain messages between the user and AI personas.
 *
 * Endpoints:
 * - GET /api/conversations - List all conversations for the user
 * - GET /api/conversations/:id - Get a conversation with all messages
 * - POST /api/conversations - Create a new conversation
 * - PUT /api/conversations/:id - Update conversation metadata
 * - DELETE /api/conversations/:id - Delete a conversation and its messages
 * - POST /api/conversations/:id/messages - Add a message to a conversation
 * - PUT /api/conversations/:id/messages/:messageId - Update a message
 * - DELETE /api/conversations/:id/messages/:messageId - Delete a message
 */

const express = require('express');
const dal = require('../db/dal');
const drive = require('../utils/drive');
const { authenticate } = require('../middleware/authenticate');
const { asyncHandler } = require('../middleware/errorHandler');
const AppError = require('../utils/AppError');
const config = require('../config');
const { resolveFileStore, resolveToolDriveAuth } = require('../tools/fileStore');
const { saveTextOverFile, restoreFileRevision, writeContentToStore } = require('../tools/storeWriter');
const { validateFilename, resolveMime } = require('../tools/createFile');
const { applyScratchpadWrite } = require('../tools/scratchpad');
const { revertConversationFiles } = require('../tools/revertFiles');
const { formatFileRevision } = require('../utils/format');
const { trashConversationFiles } = require('../tools/conversationCleanup');

const router = express.Router();

// Maximum number of conversations that can be returned in a single request
const MAX_LIMIT = 100;

// All routes require authentication
router.use(authenticate);

/**
 * Format a conversation record for API response
 * Converts snake_case DB fields to camelCase
 * @param {Object} conversation - Conversation record from database
 * @returns {Object} Formatted conversation object
 */
function formatConversation(conversation) {
  const formatted = {
    id: conversation.id,
    userId: conversation.user_id,
    personaId: conversation.persona_id,
    projectId: conversation.project_id,
    workspaceId: conversation.workspace_id,
    title: conversation.title,
    // Track A file-tools override: null = inherit persona base, true/false = forced.
    toolsEnabled: conversation.tools_enabled === null || conversation.tools_enabled === undefined
      ? null
      : conversation.tools_enabled === 1,
    // Scratchpad override (SP-02): null = inherit persona base + auto-arm, true/false = forced.
    scratchpadEnabled: conversation.scratchpad_enabled === null || conversation.scratchpad_enabled === undefined
      ? null
      : conversation.scratchpad_enabled === 1,
    createdAt: conversation.created_at,
    updatedAt: conversation.updated_at,
  };

  // Include message count if present (from list queries)
  if (conversation.message_count !== undefined) {
    formatted.messageCount = conversation.message_count;
  }

  // Include messages if present (from get by ID)
  if (conversation.messages !== undefined) {
    formatted.messages = conversation.messages.map(formatMessage);
  }

  return formatted;
}

/**
 * Format a message record for API response
 * Converts snake_case DB fields to camelCase
 * @param {Object} message - Message record from database
 * @returns {Object} Formatted message object
 */
function formatMessage(message) {
  return {
    id: message.id,
    conversationId: message.conversation_id,
    role: message.role,
    content: message.content,
    attachments: message.attachments,
    model: message.model || null, // model id that generated it (WR-14); null for user/legacy rows
    createdAt: message.created_at,
  };
}

// =============================================================================
// CONVERSATION ENDPOINTS
// =============================================================================

/**
 * GET /api/conversations
 * Returns the user's conversations, ordered by updatedAt descending, with a
 * message count each.
 *
 * Container scoping (a chat lives in exactly one home — see WORKSPACE_RESTRUCTURE):
 *   ?unfiled=true            only unfiled chats (no workspace/project)
 *   ?projectId=xxx           only that project's chats
 *   ?workspaceId=xxx         that workspace's chats
 *     &workspaceLevelOnly=true   ...excluding project-level chats
 * Optional ?personaId=xxx filter combines with the above. Omit all for every chat.
 */
router.get('/', asyncHandler(async (req, res) => {
  const { personaId, unfiled, workspaceId, workspaceLevelOnly, projectId, limit, offset } = req.query;

  const options = {};
  if (personaId) {
    options.personaId = personaId;
  }
  if (unfiled === 'true') {
    options.unfiled = true;
  } else if (projectId) {
    options.projectId = projectId;
  } else if (workspaceId) {
    options.workspaceId = workspaceId;
    if (workspaceLevelOnly === 'true') {
      options.workspaceLevelOnly = true;
    }
  }
  if (limit) {
    const parsedLimit = parseInt(limit, 10);
    if (!isNaN(parsedLimit) && parsedLimit > 0) {
      options.limit = Math.min(parsedLimit, MAX_LIMIT);
    }
  }
  if (offset) {
    const parsedOffset = parseInt(offset, 10);
    if (!isNaN(parsedOffset) && parsedOffset >= 0) {
      options.offset = parsedOffset;
    }
  }

  const conversations = dal.getConversationsByUser(req.user.userId, options);
  res.json(conversations.map(formatConversation));
}));

/**
 * GET /api/conversations/:id
 * Returns a conversation with all its messages
 * Messages ordered by createdAt ascending
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const conversation = dal.getConversationById(req.params.id, req.user.userId);

  if (!conversation) {
    throw AppError.notFound('Conversation');
  }

  res.json(formatConversation(conversation));
}));

/**
 * Resolve a conversation's container ids from the requested project/workspace,
 * enforcing the hierarchy invariant: a project-level chat sets BOTH ids
 * (workspace_id = the project's workspace, derived server-side and never trusted
 * from the client); a workspace-level chat sets only workspace_id; an unfiled
 * chat sets neither. Verifies ownership and throws VALIDATION_ERROR otherwise.
 *
 * @param {string} userId
 * @param {{ projectId?: string|null, workspaceId?: string|null }} input
 * @returns {{ projectId: string|null, workspaceId: string|null }}
 */
function resolveContainerIds(userId, { projectId, workspaceId }) {
  if (projectId) {
    const project = dal.getProjectById(projectId, userId);
    if (!project) {
      throw AppError.validation('Invalid projectId: project not found');
    }
    return { projectId: project.id, workspaceId: project.workspace_id || null };
  }
  if (workspaceId) {
    const workspace = dal.getWorkspaceById(workspaceId, userId);
    if (!workspace) {
      throw AppError.validation('Invalid workspaceId: workspace not found');
    }
    return { projectId: null, workspaceId: workspace.id };
  }
  return { projectId: null, workspaceId: null };
}

/**
 * POST /api/conversations
 * Creates a new conversation linked to the authenticated user.
 * Body: { personaId, title?, projectId?, workspaceId? }
 * The chat's container is resolved with the hierarchy invariant (workspace
 * derived from the project when a project is given).
 */
router.post('/', asyncHandler(async (req, res) => {
  const { personaId, title, projectId, workspaceId } = req.body;

  // Validate personaId is provided
  if (!personaId) {
    throw AppError.validation('personaId is required');
  }

  // Verify the persona exists and belongs to the user
  const persona = dal.getPersonaById(personaId, req.user.userId);
  if (!persona) {
    throw AppError.validation('Invalid personaId: persona not found');
  }

  const container = resolveContainerIds(req.user.userId, { projectId, workspaceId });

  const conversation = dal.createConversation(req.user.userId, {
    personaId,
    title: title || 'New Chat',
    projectId: container.projectId,
    workspaceId: container.workspaceId,
  });

  res.status(201).json(formatConversation(conversation));
}));

/**
 * PUT /api/conversations/:id
 * Updates conversation metadata (only if owned by user)
 * Body: { title?, personaId?, projectId?, workspaceId?, toolsEnabled?, scratchpadEnabled? }
 * Moving a chat's container re-applies the hierarchy invariant (workspace_id is
 * derived from the project; clearing both unfiles the chat).
 */
router.put('/:id', asyncHandler(async (req, res) => {
  const { title, personaId, projectId, workspaceId, toolsEnabled, scratchpadEnabled } = req.body;
  const updateData = {};

  // Track A composer override: boolean forces on/off, null clears back to
  // inheriting the persona base.
  if (toolsEnabled !== undefined) {
    if (toolsEnabled !== null && typeof toolsEnabled !== 'boolean') {
      throw AppError.validation('toolsEnabled must be true, false, or null');
    }
    updateData.toolsEnabled = toolsEnabled;
  }

  // Scratchpad override (SP-02): boolean forces on/off, null clears back to
  // inheriting the persona base + auto-arm.
  if (scratchpadEnabled !== undefined) {
    if (scratchpadEnabled !== null && typeof scratchpadEnabled !== 'boolean') {
      throw AppError.validation('scratchpadEnabled must be true, false, or null');
    }
    updateData.scratchpadEnabled = scratchpadEnabled;
  }

  // Validate and collect fields to update
  if (title !== undefined) {
    if (typeof title !== 'string') {
      throw AppError.validation('Title must be a string');
    }
    updateData.title = title;
  }

  if (personaId !== undefined) {
    // Verify the persona exists and belongs to the user
    const persona = dal.getPersonaById(personaId, req.user.userId);
    if (!persona) {
      throw AppError.validation('Invalid personaId: persona not found');
    }
    updateData.personaId = personaId;
  }

  // Re-home the chat only if a container field was supplied. Both ids are set
  // together so the invariant can never be left half-applied.
  if (projectId !== undefined || workspaceId !== undefined) {
    const container = resolveContainerIds(req.user.userId, {
      projectId: projectId || null,
      workspaceId: workspaceId || null,
    });
    updateData.projectId = container.projectId;
    updateData.workspaceId = container.workspaceId;
  }

  const conversation = dal.updateConversation(req.params.id, req.user.userId, updateData);

  if (!conversation) {
    throw AppError.notFound('Conversation');
  }

  res.json(formatConversation(conversation));
}));

/**
 * DELETE /api/conversations/:id
 * Deletes a conversation and all its messages (cascade). The chat's created
 * files live on Drive under `Tessera/Chats/<id>/`; the DB rows cascade away but
 * the Drive files would be orphaned, so trash them (recoverable) first. Trashing
 * is best-effort — a Drive failure must not leave the user with an undeletable
 * conversation.
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  // Verify ownership/existence up front so we don't do Drive work for a chat
  // that isn't the user's (and can return the 404 the old flow returned).
  const conversation = dal.getConversationMeta(req.params.id, req.user.userId);
  if (!conversation) {
    throw AppError.notFound('Conversation');
  }

  await trashConversationFiles(req.user.userId, req.params.id);

  dal.deleteConversation(req.params.id, req.user.userId);

  res.json({ deleted: true });
}));

// =============================================================================
// MESSAGE ENDPOINTS
// =============================================================================

/**
 * POST /api/conversations/:id/messages
 * Appends a message to the conversation
 * Updates conversation's updatedAt
 * Body: { role, content, attachments?, model? }
 */
router.post('/:id/messages', asyncHandler(async (req, res) => {
  const conversationId = req.params.id;
  const { role, content, attachments, model } = req.body;

  // Verify the conversation exists and belongs to the user
  const conversation = dal.getConversationById(conversationId, req.user.userId);
  if (!conversation) {
    throw AppError.notFound('Conversation');
  }

  // Validate role
  if (!role || !['user', 'assistant'].includes(role)) {
    throw AppError.validation('Role must be either "user" or "assistant"');
  }

  // Validate content
  if (content === undefined || content === null) {
    throw AppError.validation('Content is required');
  }
  if (typeof content !== 'string') {
    throw AppError.validation('Content must be a string');
  }

  // Validate attachments if provided
  if (attachments !== undefined) {
    if (!Array.isArray(attachments)) {
      throw AppError.validation('Attachments must be an array');
    }
  }

  // Validate model if provided (the model id that generated this message, WR-14)
  if (model !== undefined && model !== null) {
    if (typeof model !== 'string' || model.length > 200) {
      throw AppError.validation('model must be a string (max 200 chars)');
    }
  }

  const message = dal.createMessage(conversationId, {
    role,
    content,
    attachments: attachments || [],
    model: model || null,
  });

  res.status(201).json(formatMessage(message));
}));

/**
 * PUT /api/conversations/:id/messages/:messageId
 * Updates a message's content (for edit feature)
 * Body: { content }
 */
router.put('/:id/messages/:messageId', asyncHandler(async (req, res) => {
  const { id: conversationId, messageId } = req.params;
  const { content } = req.body;

  // Verify the conversation exists and belongs to the user
  const conversation = dal.getConversationById(conversationId, req.user.userId);
  if (!conversation) {
    throw AppError.notFound('Conversation');
  }

  // Check if the message belongs to this conversation
  const existingMessage = conversation.messages.find(m => m.id === messageId);
  if (!existingMessage) {
    throw AppError.notFound('Message');
  }

  // Validate content
  if (content === undefined) {
    throw AppError.validation('Content is required for message update');
  }
  if (typeof content !== 'string') {
    throw AppError.validation('Content must be a string');
  }

  const message = dal.updateMessage(messageId, { content });

  if (!message) {
    throw AppError.notFound('Message');
  }

  res.json(formatMessage(message));
}));

/**
 * DELETE /api/conversations/:id/messages/:messageId
 * Deletes a single message
 */
router.delete('/:id/messages/:messageId', asyncHandler(async (req, res) => {
  const { id: conversationId, messageId } = req.params;

  // Verify the conversation exists and belongs to the user
  const conversation = dal.getConversationById(conversationId, req.user.userId);
  if (!conversation) {
    throw AppError.notFound('Conversation');
  }

  // Check if the message belongs to this conversation
  const existingMessage = conversation.messages.find(m => m.id === messageId);
  if (!existingMessage) {
    throw AppError.notFound('Message');
  }

  const deleted = dal.deleteMessage(messageId);

  if (!deleted) {
    throw AppError.notFound('Message');
  }

  res.json({ deleted: true });
}));

// =============================================================================
// CONVERSATION FILES (File Collaboration, FC-01)
// =============================================================================
//
// Files created by the file tools inside a chat live in this chat's own scope
// (conversation_files). These endpoints mirror the Downloads endpoints in
// routes/files.js, but scoped to a conversation the user owns, so a chat-created
// file is just as listable / downloadable / editable as the others. Every
// handler first verifies the conversation belongs to the user, then the file
// belongs to the conversation.

/**
 * Format a conversation_files record for API response (snake_case → camelCase).
 * @param {Object} file - conversation_files row
 * @returns {Object}
 */
function formatConversationFile(file) {
  return {
    id: file.id,
    filename: file.filename,
    mimeType: file.mime_type,
    sizeBytes: file.size_bytes,
    createdAt: file.created_at,
  };
}

/**
 * Load a conversation file after verifying both ownerships (user→conversation,
 * conversation→file). Throws NOT_FOUND if either check fails.
 * @returns {Object} the conversation_files row
 */
function requireConversationFile(userId, conversationId, fileId) {
  const conversation = dal.getConversationMeta(conversationId, userId);
  if (!conversation) {
    throw AppError.notFound('Conversation');
  }
  const file = dal.getConversationFile(fileId, conversationId);
  if (!file || !file.drive_file_id) {
    throw AppError.notFound('File');
  }
  return file;
}

/**
 * GET /api/conversations/:id/files
 * List a chat's created files (metadata only, no Drive calls).
 */
router.get('/:id/files', asyncHandler(async (req, res) => {
  const conversation = dal.getConversationMeta(req.params.id, req.user.userId);
  if (!conversation) {
    throw AppError.notFound('Conversation');
  }
  const files = dal.listConversationFiles(req.params.id);
  res.json(files.map(formatConversationFile));
}));

/**
 * POST /api/conversations/:id/files
 * Create a chat working file from a user-uploaded TEXT file (CF-02). The client
 * reads the file as text and posts { filename, content }; this writes it into
 * the conversation scope through the shared tool write path, so it becomes a
 * first-class working file — listed in the files explorer, edit_file/read_file
 * visible, and (via the user-authored revision stamped at the current turn)
 * injected into the very next request by the recency window (FC-03b).
 *
 * Text only: images and PDFs are not authorable as text and keep their existing
 * inline-attachment path client-side. Same extension allow-list + filename
 * validation as create_file (PDF excluded). Overwrite-on-duplicate matches the
 * tool: re-uploading a same-named file repoints the row (id + history kept).
 */
router.post('/:id/files', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const conversation = dal.getConversationMeta(req.params.id, userId);
  if (!conversation) {
    throw AppError.notFound('Conversation');
  }

  const check = validateFilename(req.body?.filename);
  if (!check.ok) {
    throw AppError.validation(check.reason);
  }
  if (typeof req.body?.content !== 'string') {
    throw AppError.validation('content must be a string of the complete file text.');
  }
  const bytes = Buffer.from(req.body.content, 'utf8');
  const mimeType = resolveMime(req.body?.mimeType, check.ext);

  // Drive-less users (e.g. dev login) get a clean error; the client then falls
  // back to the inline-attachment path so the file still reaches the model.
  const { auth, unavailable } = resolveToolDriveAuth(userId);
  if (unavailable) {
    throw AppError.validation(unavailable);
  }

  const store = resolveFileStore({ userId, conversationId: req.params.id });
  // Author 'user', op auto-derived (create vs overwrite). Turn = current
  // user-message count: this runs BEFORE the accompanying user message is
  // persisted, so the stamp is currentTurn-1 and FC-03b injects it on the turn
  // it is uploaded (age 1), then it falls out of the window as usual.
  const { record, overwritten } = await writeContentToStore(auth, store, {
    filename: check.name,
    mimeType,
    bytes,
    userId,
    revision: { author: 'user', conversationId: req.params.id, turn: dal.countUserMessages(req.params.id) },
  });

  res.status(201).json({ ...formatConversationFile(record), overwritten });
}));

/**
 * GET /api/conversations/:id/files/:fileId/content
 * Stream a chat file's bytes with a download disposition (so the URL works as
 * an <a href download> and as the file panel's fetch source).
 */
router.get('/:id/files/:fileId/content', asyncHandler(async (req, res) => {
  const file = requireConversationFile(req.user.userId, req.params.id, req.params.fileId);

  const auth = drive.getAuthForUser(req.user.userId);
  const bytes = await drive.downloadFileBytes(auth, file.drive_file_id);

  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  res.send(bytes);
}));

/**
 * POST /api/conversations/:id/files/revert
 * Roll back model-authored file changes at/after a turn (File Collaboration,
 * FC-06a) — called by the client BEFORE it re-rolls / edits-and-resends a turn,
 * so the re-run operates on the pre-turn file state. Body: { fromTurn: number }.
 */
router.post('/:id/files/revert', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const conversation = dal.getConversationMeta(req.params.id, userId);
  if (!conversation) {
    throw AppError.notFound('Conversation');
  }

  const fromTurn = Number(req.body?.fromTurn);
  if (!Number.isInteger(fromTurn) || fromTurn < 1) {
    throw AppError.validation('fromTurn must be a positive integer.');
  }

  // Resolve the conversation's containers so project/workspace-scoped edits made
  // from this chat can be rolled back too (mirrors the chat route's resolution).
  let project = null;
  let workspace = null;
  if (conversation.project_id) project = dal.getProjectById(conversation.project_id, userId);
  if (conversation.workspace_id) workspace = dal.getWorkspaceById(conversation.workspace_id, userId);
  if (project && !workspace && project.workspace_id) {
    workspace = dal.getWorkspaceById(project.workspace_id, userId);
  }

  const result = await revertConversationFiles(
    { userId, conversationId: req.params.id, project, workspace },
    fromTurn
  );
  res.json(result);
}));

/**
 * GET /api/conversations/:id/files/:fileId/revisions
 * The chat file's change history (File Collaboration, FC-04).
 */
router.get('/:id/files/:fileId/revisions', asyncHandler(async (req, res) => {
  requireConversationFile(req.user.userId, req.params.id, req.params.fileId);
  const revisions = dal.listFileRevisions('conversation', req.params.fileId);
  res.json(revisions.map(formatFileRevision));
}));

/**
 * POST /api/conversations/:id/files/:fileId/revisions/:revId/restore
 * Restore a chat file to a stored version (File Collaboration, FC-06b).
 */
router.post('/:id/files/:fileId/revisions/:revId/restore', asyncHandler(async (req, res) => {
  const file = requireConversationFile(req.user.userId, req.params.id, req.params.fileId);
  const auth = drive.getAuthForUser(req.user.userId);
  const store = resolveFileStore({ userId: req.user.userId, conversationId: req.params.id });
  const result = await restoreFileRevision(
    auth, store, file, req.params.revId, req.user.userId,
    { conversationId: req.params.id, turn: dal.countUserMessages(req.params.id) }
  );
  if (!result.ok) {
    if (result.notFound) throw AppError.notFound('Revision');
    throw AppError.validation(result.reason);
  }
  res.json(formatConversationFile(result.record));
}));

/**
 * PUT /api/conversations/:id/files/:fileId/content
 * Replace a chat file's text with user-edited content (the file panel's Save).
 * Body: { content: string }. Same write path as the file tools, so the row id
 * (and download URL) stays stable and read_file sees the new text.
 */
router.put('/:id/files/:fileId/content', asyncHandler(async (req, res) => {
  const file = requireConversationFile(req.user.userId, req.params.id, req.params.fileId);

  const auth = drive.getAuthForUser(req.user.userId);
  const store = resolveFileStore({ userId: req.user.userId, conversationId: req.params.id });
  // Log this as a user-authored revision in the chat (FC-02) so the model sees
  // the diff of what the user changed on its next turn. Stamp the current turn
  // (user-message count) so the recency-scoped injection (FC-03b) treats it the
  // same as a tool write from this turn.
  const result = await saveTextOverFile(
    auth, store, file, req.body?.content, req.user.userId,
    { conversationId: req.params.id, turn: dal.countUserMessages(req.params.id) }
  );
  if (!result.ok) {
    throw AppError.validation(result.reason);
  }
  res.json(formatConversationFile(result.record));
}));

// =============================================================================
// SCRATCHPAD (docs/SCRATCHPAD_DESIGN.md, SP-03a)
//
// User-facing endpoints for the per-conversation scratchpad. They follow the
// file panel's `/content` → `/revisions` URL convention deliberately, so the
// existing API.files.fetchText / saveText / revisions / restoreRevision client
// helpers (and the FilePanel that uses them) work on the scratchpad unchanged.
// The scratchpad is DB-resident (no Drive), so none of this needs Drive auth.
// =============================================================================

/** Owner check → the conversations row, or 404. */
function requireConversation(userId, conversationId) {
  const conversation = dal.getConversationMeta(conversationId, userId);
  if (!conversation) throw AppError.notFound('Conversation');
  return conversation;
}

/**
 * GET /api/conversations/:id/scratchpad/content
 * The scratchpad's current text (empty string when there is no pad yet).
 * Served as text/plain so API.files.fetchText reads it like a file body.
 */
router.get('/:id/scratchpad/content', asyncHandler(async (req, res) => {
  requireConversation(req.user.userId, req.params.id);
  const pad = dal.getScratchpad(req.params.id);
  res.type('text/plain; charset=utf-8').send(pad ? pad.content : '');
}));

/**
 * PUT /api/conversations/:id/scratchpad/content
 * A user Save of the scratchpad. Body: { content }. Writes through the shared
 * scratchpad path (author 'user'), logging a revision + snapshot stamped at the
 * current turn — so the model sees the diff of what the user changed next turn,
 * and (via auto-arm) a non-empty pad activates the scratchpad tools.
 */
router.put('/:id/scratchpad/content', asyncHandler(async (req, res) => {
  requireConversation(req.user.userId, req.params.id);
  const content = req.body?.content;
  if (typeof content !== 'string') {
    throw AppError.validation('content must be a string of the complete scratchpad text.');
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > config.scratchpad.maxBytes) {
    const mb = (config.scratchpad.maxBytes / (1024 * 1024)).toFixed(1);
    throw AppError.validation(`The scratchpad is too large (limit ${mb}MB). Trim it, or save finished content as a file.`);
  }

  const current = dal.getScratchpad(req.params.id);
  applyScratchpadWrite(req.params.id, content, {
    author: 'user',
    op: 'write',
    turn: dal.countUserMessages(req.params.id),
    oldContent: current ? current.content : '',
  });

  res.json({ sizeBytes: bytes, updatedAt: dal.getScratchpad(req.params.id).updated_at });
}));

/**
 * GET /api/conversations/:id/scratchpad/revisions
 * The scratchpad's change history (same shape as file revisions, so the version
 * rail renders it unchanged). Oldest-first; empty when there is no pad.
 */
router.get('/:id/scratchpad/revisions', asyncHandler(async (req, res) => {
  requireConversation(req.user.userId, req.params.id);
  const pad = dal.getScratchpad(req.params.id);
  const revisions = pad ? dal.listScratchpadRevisions(pad.id) : [];
  res.json(revisions.map(formatFileRevision));
}));

/**
 * POST /api/conversations/:id/scratchpad/revisions/:revId/restore
 * Restore the scratchpad to a stored version. Append-only: the restored content
 * is written back as a NEW revision (restoring is itself a change).
 */
router.post('/:id/scratchpad/revisions/:revId/restore', asyncHandler(async (req, res) => {
  requireConversation(req.user.userId, req.params.id);
  const pad = dal.getScratchpad(req.params.id);
  const rev = pad ? dal.getScratchpadRevisionById(req.params.revId) : null;
  if (!rev || rev.scratchpad_id !== pad.id) {
    throw AppError.notFound('Revision');
  }
  if (rev.content == null) {
    throw AppError.validation('That version is no longer stored, so it can’t be restored.');
  }

  applyScratchpadWrite(req.params.id, rev.content, {
    author: 'user',
    op: 'write',
    turn: dal.countUserMessages(req.params.id),
    oldContent: pad.content,
  });

  res.json({ sizeBytes: Buffer.byteLength(rev.content, 'utf8'), updatedAt: dal.getScratchpad(req.params.id).updated_at });
}));

module.exports = router;
