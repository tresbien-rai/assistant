/**
 * Chat Routes
 *
 * Proxies chat requests to AI providers (Anthropic, Google, OpenAI).
 * Uses the user's stored API keys for authentication with providers.
 *
 * Endpoints:
 * - POST /api/chat - Non-streaming chat completion
 * - POST /api/chat/stream - Streaming chat completion (SSE)
 * - GET /api/models/:provider - Fetch available models from provider
 */

const express = require('express');
const { authenticate } = require('../middleware/authenticate');
const { asyncHandler } = require('../middleware/errorHandler');
const { getDecryptedApiKey } = require('./apiKeys');
const AppError = require('../utils/AppError');
const { logger } = require('../utils/logger');

// Provider modules
const anthropic = require('../providers/anthropic');

const router = express.Router();
const modelsRouter = express.Router();

// Provider dispatch map - add new providers here
const providers = {
  anthropic,
  // google and openai will be added in future tasks
};

// Valid provider names
const VALID_PROVIDERS = ['anthropic', 'google', 'openai'];

/**
 * Validate provider name
 * @param {string} provider - Provider name to validate
 * @throws {AppError} If provider is invalid
 */
function validateProvider(provider) {
  if (!provider) {
    throw AppError.validation('Provider is required');
  }
  if (!VALID_PROVIDERS.includes(provider)) {
    throw AppError.validation(
      `Invalid provider: ${provider}. Must be one of: ${VALID_PROVIDERS.join(', ')}`
    );
  }
}

/**
 * Validate chat request body
 * @param {Object} body - Request body
 * @throws {AppError} If validation fails
 */
function validateChatRequest(body) {
  const { provider, model, messages } = body;

  validateProvider(provider);

  if (!model || typeof model !== 'string') {
    throw AppError.validation('Model is required');
  }

  if (!messages || !Array.isArray(messages)) {
    throw AppError.validation('Messages array is required');
  }

  if (messages.length === 0) {
    throw AppError.validation('Messages array cannot be empty');
  }

  // Validate each message has role and content
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg.role || (msg.role !== 'user' && msg.role !== 'assistant')) {
      throw AppError.validation(`Message ${i} has invalid role. Must be 'user' or 'assistant'.`);
    }
    if (msg.content === undefined || msg.content === null) {
      throw AppError.validation(`Message ${i} is missing content.`);
    }
  }
}

/**
 * Get provider module
 * @param {string} provider - Provider name
 * @returns {Object} Provider module
 * @throws {AppError} If provider not implemented
 */
function getProvider(provider) {
  const providerModule = providers[provider];
  if (!providerModule) {
    throw AppError.validation(
      `Provider '${provider}' is not yet implemented. Available providers: ${Object.keys(providers).join(', ')}`
    );
  }
  return providerModule;
}

// All routes require authentication
router.use(authenticate);

/**
 * POST /api/chat
 * Non-streaming chat completion
 *
 * Body: {
 *   provider: string ('anthropic', 'google', 'openai'),
 *   model: string (e.g., 'claude-3-5-sonnet-20241022'),
 *   messages: Array<{ role: 'user' | 'assistant', content: string | Array }>,
 *   systemPrompt?: string,
 *   modelParams?: {
 *     maxTokens?: number,
 *     temperature?: number,
 *     topP?: number,
 *     topK?: number,
 *     temperatureEnabled?: boolean,
 *     topPEnabled?: boolean,
 *     topKEnabled?: boolean,
 *     stopSequences?: string[],
 *     anthropic?: { thinkingEnabled?: boolean, thinkingBudget?: number }
 *   },
 *   prefill?: string,
 *   attachments?: Array
 * }
 *
 * Response: {
 *   text: string,
 *   model: string,
 *   usage?: object,
 *   stopReason?: string
 * }
 */
router.post('/', asyncHandler(async (req, res) => {
  const { provider, model, messages, systemPrompt, modelParams, prefill, attachments } = req.body;

  validateChatRequest(req.body);

  // Get user's API key for this provider
  const apiKey = getDecryptedApiKey(req.user.userId, provider);

  // Get provider module
  const providerModule = getProvider(provider);

  logger.info({
    userId: req.user.userId,
    provider,
    model,
    messageCount: messages.length,
  }, 'Chat request');

  // Call provider's chat method
  const result = await providerModule.chat(apiKey, {
    model,
    messages,
    systemPrompt,
    modelParams,
    prefill,
    attachments,
  });

  res.json(result);
}));

/**
 * POST /api/chat/stream
 * Streaming chat completion via Server-Sent Events
 *
 * Same body as /api/chat
 * Response: SSE stream with provider's native event format
 */
router.post('/stream', asyncHandler(async (req, res) => {
  const { provider, model, messages, systemPrompt, modelParams, prefill, attachments } = req.body;

  validateChatRequest(req.body);

  // Get user's API key for this provider
  const apiKey = getDecryptedApiKey(req.user.userId, provider);

  // Get provider module
  const providerModule = getProvider(provider);

  if (!providerModule.stream) {
    throw AppError.validation(`Streaming not supported for provider: ${provider}`);
  }

  logger.info({
    userId: req.user.userId,
    provider,
    model,
    messageCount: messages.length,
  }, 'Stream request');

  // Set up abort handling for client disconnect
  const abortController = new AbortController();

  req.on('close', () => {
    logger.debug({ userId: req.user.userId }, 'Client disconnected from stream');
    abortController.abort();
  });

  // Call provider's stream method
  await providerModule.stream(apiKey, {
    model,
    messages,
    systemPrompt,
    modelParams,
    prefill,
    attachments,
  }, res, abortController.signal);
}));

// =============================================================================
// Models Router (mounted separately at /api/models)
// =============================================================================

// Models router also requires authentication
modelsRouter.use(authenticate);

/**
 * GET /api/models/:provider
 * Fetch available models from a provider
 *
 * Response: Array of model objects (format varies by provider)
 */
modelsRouter.get('/:provider', asyncHandler(async (req, res) => {
  const { provider } = req.params;

  validateProvider(provider);

  // Get user's API key for this provider
  const apiKey = getDecryptedApiKey(req.user.userId, provider);

  // Get provider module
  const providerModule = getProvider(provider);

  if (!providerModule.listModels) {
    throw AppError.validation(`Model listing not supported for provider: ${provider}`);
  }

  logger.info({ userId: req.user.userId, provider }, 'Models list request');

  const models = await providerModule.listModels(apiKey);

  res.json(models);
}));

module.exports = {
  chatRouter: router,
  modelsRouter,
};
