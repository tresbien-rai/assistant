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
const dal = require('../db/dal');
const { assembleProjectContext, assembleWorkspaceContext } = require('../utils/projectContext');
const AppError = require('../utils/AppError');
const { logger } = require('../utils/logger');

// Provider modules
const anthropic = require('../providers/anthropic');
const gemini = require('../providers/gemini');

const router = express.Router();
const modelsRouter = express.Router();

// Provider dispatch map - add new providers here
const providers = {
  anthropic,
  google: gemini,
  // openai will be added in future tasks
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

// Authentication is applied at the index.js mount level (along with rate limiters)
// so req.user is already available when requests reach this router.

/**
 * Resolve the workspace + project for a chat request and assemble their layered
 * context block (workspace first, then project — see WORKSPACE_RESTRUCTURE.md).
 *
 * The chat route is otherwise stateless about conversations, so the client
 * passes either a `conversationId` (preferred — the container is resolved from
 * the conversation row) or explicit `workspaceId`/`projectId` (e.g. a new chat
 * not yet persisted). Both are always re-loaded user-scoped, so the client can
 * never inject another user's container or arbitrary file contents.
 *
 * Layering: workspace context frames everything, then project context, then the
 * persona system prompt (added by applyRequestContext). A project-level chat
 * inherits both; a workspace-level chat only the workspace; an unfiled chat
 * neither. When a project is known but its workspace wasn't passed explicitly,
 * the workspace is derived from the project so inheritance always holds.
 *
 * @param {Object} req - Express request (req.user, req.body)
 * @returns {Promise<{ text: string, warning: string|null }|null>}
 */
async function resolveRequestContext(req) {
  const userId = req.user.userId;
  // Guard the types: these come straight from the request body, and passing a
  // non-string to better-sqlite3 throws (TypeError) rather than simply missing.
  const conversationId = typeof req.body.conversationId === 'string' ? req.body.conversationId : null;
  const projectId = typeof req.body.projectId === 'string' ? req.body.projectId : null;
  const workspaceId = typeof req.body.workspaceId === 'string' ? req.body.workspaceId : null;

  let workspace = null;
  let project = null;

  if (conversationId) {
    // Metadata-only lookup — we just need the container ids, not the messages.
    const conversation = dal.getConversationMeta(conversationId, userId);
    if (conversation) {
      if (conversation.project_id) project = dal.getProjectById(conversation.project_id, userId);
      if (conversation.workspace_id) workspace = dal.getWorkspaceById(conversation.workspace_id, userId);
    }
  } else {
    if (projectId) project = dal.getProjectById(projectId, userId);
    if (workspaceId) workspace = dal.getWorkspaceById(workspaceId, userId);
  }

  // Inheritance safety net: a project always carries its workspace context even
  // if the caller didn't name the workspace.
  if (project && !workspace && project.workspace_id) {
    workspace = dal.getWorkspaceById(project.workspace_id, userId);
  }

  const blocks = [];
  const warnings = [];

  if (workspace) {
    const wc = await assembleWorkspaceContext(userId, workspace);
    if (wc?.text) blocks.push(wc.text);
    if (wc?.warning) warnings.push(wc.warning);
  }
  if (project) {
    const pc = await assembleProjectContext(userId, project);
    if (pc?.text) blocks.push(pc.text);
    if (pc?.warning) warnings.push(pc.warning);
  }

  if (blocks.length === 0) return null;
  return { text: blocks.join('\n\n'), warning: warnings.length > 0 ? warnings.join(' ') : null };
}

/**
 * Combine the assembled workspace+project context (if any) with the persona's
 * system prompt. Container context goes FIRST so it frames the persona.
 * @param {{text: string}|null} requestContext
 * @param {string} [systemPrompt]
 * @returns {string|undefined}
 */
function applyRequestContext(requestContext, systemPrompt) {
  if (!requestContext?.text) return systemPrompt;
  return `${requestContext.text}\n\n${systemPrompt || ''}`.trim();
}

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

  // Inject workspace + project context (instructions + files) before the persona prompt.
  const requestContext = await resolveRequestContext(req);
  const effectiveSystemPrompt = applyRequestContext(requestContext, systemPrompt);

  logger.info({
    userId: req.user.userId,
    provider,
    model,
    messageCount: messages.length,
    projectContext: Boolean(requestContext?.text),
  }, 'Chat request');

  // Call provider's chat method
  const result = await providerModule.chat(apiKey, {
    model,
    messages,
    systemPrompt: effectiveSystemPrompt,
    modelParams,
    prefill,
    attachments,
  });

  if (requestContext?.warning) {
    result.contextWarning = requestContext.warning;
    res.setHeader('X-Project-Context-Warning', encodeURIComponent(requestContext.warning));
  }

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

  // Inject workspace + project context before the persona prompt.
  // Resolved before any SSE headers are sent so the warning header is valid.
  const requestContext = await resolveRequestContext(req);
  const effectiveSystemPrompt = applyRequestContext(requestContext, systemPrompt);

  if (requestContext?.warning) {
    res.setHeader('X-Project-Context-Warning', encodeURIComponent(requestContext.warning));
  }

  logger.info({
    userId: req.user.userId,
    provider,
    model,
    messageCount: messages.length,
    projectContext: Boolean(requestContext?.text),
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
    systemPrompt: effectiveSystemPrompt,
    modelParams,
    prefill,
    attachments,
  }, res, abortController.signal);
}));

/**
 * POST /api/chat/preview
 * Request inspector (P2-U4). Runs the SAME assembly as /api/chat — workspace
 * (project) context prepend + the provider-specific buildRequestBody — and
 * returns the EXACT provider request body WITHOUT calling the provider.
 *
 * The API key is sent as a request HEADER at call time, never in the body, so
 * this preview exposes nothing secret. The body does contain the assembled
 * system prompt + the user's own workspace file text, which is fine to show
 * the owner. No API key is fetched/decrypted here.
 *
 * Validation is intentionally lighter than the real chat path: an empty
 * messages array is allowed so the user can inspect the system prompt/params
 * of a fresh conversation.
 */
router.post('/preview', asyncHandler(async (req, res) => {
  const { provider, model, messages = [], systemPrompt, modelParams, prefill, attachments } = req.body;

  validateProvider(provider);
  if (!model || typeof model !== 'string') {
    throw AppError.validation('Model is required');
  }
  if (!Array.isArray(messages)) {
    throw AppError.validation('Messages must be an array');
  }

  const providerModule = getProvider(provider);
  if (typeof providerModule.buildRequestBody !== 'function') {
    throw AppError.validation(`Request preview not supported for provider: ${provider}`);
  }

  // Identical context assembly to the real chat path.
  const requestContext = await resolveRequestContext(req);
  const effectiveSystemPrompt = applyRequestContext(requestContext, systemPrompt);

  const body = providerModule.buildRequestBody({
    model,
    messages,
    systemPrompt: effectiveSystemPrompt,
    modelParams,
    prefill,
    attachments,
    stream: false,
  });

  logger.info({ userId: req.user.userId, provider, model }, 'Chat request preview');

  res.json({
    provider,
    model,
    // Exact JSON body that would be POSTed to the provider.
    body,
    // Surfaced so the UI can make clear the key isn't missing — it's just not
    // part of the body.
    apiKeyLocation: 'sent as a request header (never in the body)',
    ...(requestContext?.warning ? { contextWarning: requestContext.warning } : {}),
  });
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
  // Exported for headless context-layering tests.
  resolveRequestContext,
  applyRequestContext,
};
