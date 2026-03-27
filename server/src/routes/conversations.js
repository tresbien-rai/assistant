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
const { authenticate } = require('../middleware/authenticate');
const { asyncHandler } = require('../middleware/errorHandler');
const AppError = require('../utils/AppError');

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
    title: conversation.title,
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
    createdAt: message.created_at,
  };
}

// =============================================================================
// CONVERSATION ENDPOINTS
// =============================================================================

/**
 * GET /api/conversations
 * Returns all conversations for the authenticated user
 * Query params: ?personaId=xxx (optional filter)
 * Ordered by updatedAt descending
 * Includes message count per conversation
 */
router.get('/', asyncHandler(async (req, res) => {
  const { personaId, limit, offset } = req.query;

  const options = {};
  if (personaId) {
    options.personaId = personaId;
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
 * POST /api/conversations
 * Creates a new conversation linked to the authenticated user
 * Body: { personaId, title?, projectId? }
 */
router.post('/', asyncHandler(async (req, res) => {
  const { personaId, title, projectId } = req.body;

  // Validate personaId is provided
  if (!personaId) {
    throw AppError.validation('personaId is required');
  }

  // Verify the persona exists and belongs to the user
  const persona = dal.getPersonaById(personaId, req.user.userId);
  if (!persona) {
    throw AppError.validation('Invalid personaId: persona not found');
  }

  const conversation = dal.createConversation(req.user.userId, {
    personaId,
    title: title || 'New Chat',
    projectId: projectId || null,
  });

  res.status(201).json(formatConversation(conversation));
}));

/**
 * PUT /api/conversations/:id
 * Updates conversation metadata (only if owned by user)
 * Body: { title?, personaId? }
 */
router.put('/:id', asyncHandler(async (req, res) => {
  const { title, personaId } = req.body;
  const updateData = {};

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

  const conversation = dal.updateConversation(req.params.id, req.user.userId, updateData);

  if (!conversation) {
    throw AppError.notFound('Conversation');
  }

  res.json(formatConversation(conversation));
}));

/**
 * DELETE /api/conversations/:id
 * Deletes a conversation and all its messages (cascade)
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const deleted = dal.deleteConversation(req.params.id, req.user.userId);

  if (!deleted) {
    throw AppError.notFound('Conversation');
  }

  res.json({ deleted: true });
}));

// =============================================================================
// MESSAGE ENDPOINTS
// =============================================================================

/**
 * POST /api/conversations/:id/messages
 * Appends a message to the conversation
 * Updates conversation's updatedAt
 * Body: { role, content, attachments? }
 */
router.post('/:id/messages', asyncHandler(async (req, res) => {
  const conversationId = req.params.id;
  const { role, content, attachments } = req.body;

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

  const message = dal.createMessage(conversationId, {
    role,
    content,
    attachments: attachments || [],
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

module.exports = router;
