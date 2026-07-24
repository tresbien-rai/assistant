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
const { resolveActiveFileBlock, appendToLastUserMessage } = require('../utils/activeFiles');
const { resolveScratchpadBlock } = require('../utils/scratchpadContext');
const { TOOL_DEFINITIONS, SCRATCHPAD_TOOL_DEFINITIONS } = require('../tools/definitions');
const config = require('../config');
const { buildSystemPrompt } = require('../prompts/tessera');
const { executeToolCall } = require('../tools');
const AppError = require('../utils/AppError');
const { logger } = require('../utils/logger');

// Tool-loop iteration cap (Track A): each iteration is one provider round
// trip; a healthy exchange needs 2-3, so 5 means something is looping.
const MAX_TOOL_ITERATIONS = 5;

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
 * Resolve the conversation/workspace/project ROWS for a chat request.
 *
 * The chat route is otherwise stateless about conversations, so the client
 * passes either a `conversationId` (preferred — the container is resolved from
 * the conversation row) or explicit `workspaceId`/`projectId` (e.g. a new chat
 * not yet persisted). Both are always re-loaded user-scoped, so the client can
 * never inject another user's container or arbitrary file contents.
 *
 * Split from resolveRequestContext (P2-02) because the tool loop needs the
 * rows themselves: the conversation for the tools toggle, the workspace +
 * project as file destinations.
 *
 * @param {Object} req - Express request (req.user, req.body)
 * @returns {{ conversation: Object|null, workspace: Object|null, project: Object|null }}
 */
function resolveRequestContainers(req) {
  const userId = req.user.userId;
  // Guard the types: these come straight from the request body, and passing a
  // non-string to better-sqlite3 throws (TypeError) rather than simply missing.
  const conversationId = typeof req.body.conversationId === 'string' ? req.body.conversationId : null;
  const projectId = typeof req.body.projectId === 'string' ? req.body.projectId : null;
  const workspaceId = typeof req.body.workspaceId === 'string' ? req.body.workspaceId : null;

  let conversation = null;
  let workspace = null;
  let project = null;

  if (conversationId) {
    // Metadata-only lookup — we just need the container ids, not the messages.
    conversation = dal.getConversationMeta(conversationId, userId) || null;
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

  return { conversation, workspace: workspace || null, project: project || null };
}

/**
 * Assemble the layered context block for a chat request (workspace first,
 * then project — see WORKSPACE_RESTRUCTURE.md). Layering: workspace context
 * frames everything, then project context. Since FC-03a this block is injected
 * as a synthetic user turn (not the system prompt) by assembleProviderInput.
 * A project-level chat inherits both; a workspace-level chat only the
 * workspace; an unfiled chat neither.
 *
 * Per-file context toggles (CT-02) are applied inside the assemblers: they need
 * the conversation (to resolve per-chat overrides) and whether file tools are
 * advertised (to decide whether naming a disabled file in `<available_files>`
 * is actionable or just noise).
 *
 * @param {Object} req - Express request (req.user, req.body)
 * @param {Object} [containers] - resolveRequestContainers(req) result, when
 *   the caller already resolved it (avoids double lookups)
 * @param {boolean} [toolsEnabled] - whether file tools are advertised this
 *   request; defaults to false, which suppresses the manifest
 * @returns {Promise<{ text: string, warning: string|null }|null>} null when
 *   there is nothing to inject
 */
async function resolveRequestContext(req, containers = null, toolsEnabled = false) {
  const userId = req.user.userId;
  const resolved = containers || resolveRequestContainers(req);
  const { workspace, project } = resolved;
  const toggleOpts = { conversationId: resolved.conversation?.id || null, toolsEnabled };

  const blocks = [];
  const warnings = [];

  if (workspace) {
    const wc = await assembleWorkspaceContext(userId, workspace, toggleOpts);
    if (wc?.text) blocks.push(wc.text);
    if (wc?.warning) warnings.push(wc.warning);
  }
  if (project) {
    const pc = await assembleProjectContext(userId, project, toggleOpts);
    if (pc?.text) blocks.push(pc.text);
    if (pc?.warning) warnings.push(pc.warning);
  }

  if (blocks.length === 0) return null;
  return { text: blocks.join('\n\n'), warning: warnings.length > 0 ? warnings.join(' ') : null };
}

// The synthetic assistant turn that follows the injected knowledge base, so the
// model treats the reference material as already-received context and replies to
// the real latest user message instead of to the KB block.
const CONTEXT_ACK = "Understood — I'll use the reference material above as background for our conversation.";

/**
 * Assemble the final (system, messages) for a provider call (File Collaboration,
 * FC-03a). The workspace/project knowledge base no longer rides in the system
 * prompt; it becomes a synthetic **user** turn carrying the context blocks plus
 * a short **assistant** acknowledgement, prepended to the messages. This keeps
 * the persona system prompt stable and cacheable across conversations, and keeps
 * user-uploaded file *data* in the lower-authority user role rather than the
 * system role (better instruction-hierarchy hygiene). The synthetic turns are
 * assembled per request and are never persisted.
 *
 * @param {{text: string}|null} requestContext - resolveRequestContext result
 * @param {string} [systemPrompt] - the persona prompt (goes *after* the Tessera
 *   base layer, which carries the platform preamble + expression protocol)
 * @param {Array} [messages] - the raw conversation messages
 * @param {string[]} [expressionNames] - the persona's expression names, so the
 *   base layer can name the ones that actually exist
 * @returns {{ system: string|undefined, messages: Array }}
 */
function assembleProviderInput(requestContext, systemPrompt, messages = [], expressionNames = [], scratchpadEnabled = false) {
  const contextMessages = requestContext?.text
    ? [
        { role: 'user', content: requestContext.text },
        { role: 'assistant', content: CONTEXT_ACK },
      ]
    : [];
  return {
    system: buildSystemPrompt(systemPrompt, expressionNames, { scratchpad: scratchpadEnabled }),
    messages: [...contextMessages, ...messages],
  };
}

/** The conversation turn of a request = its user-message count (FC-03b). */
function countUserTurns(messages) {
  return messages.filter((m) => m && m.role === 'user').length;
}

/**
 * Full request assembly shared by every endpoint (FC-03a + FC-03b): resolve the
 * KB context, append the recency-scoped active-file block to the last user
 * message, then fold the KB into synthetic leading turns. Returns everything the
 * callers need: the final `system`/`messages`, the KB `requestContext` (for the
 * warning header), and `currentTurn` (stamped onto tool writes this request).
 *
 * `toolsEnabled` is resolved HERE rather than by each endpoint (CT-02) because
 * the KB assembly needs it — the `<available_files>` manifest is only emitted
 * when the model actually has read_file to call. It is returned alongside
 * `scratchpadEnabled` so the endpoints use one resolution rather than repeating
 * it and risking drift.
 *
 * @returns {Promise<{ system: string|undefined, messages: Array, requestContext: object|null, currentTurn: number, toolsEnabled: boolean, scratchpadEnabled: boolean }>}
 */
async function assembleChatRequest(req, containers, { systemPrompt, messages, expressionNames }) {
  const userId = req.user.userId;
  const toolsEnabled = resolveToolsEnabled(userId, containers.conversation);
  const requestContext = await resolveRequestContext(req, containers, toolsEnabled);

  const currentTurn = countUserTurns(messages);
  const conversationId = containers.conversation?.id || null;
  let activeFileTurns = 1;
  try {
    activeFileTurns = dal.getSettingsByUser(userId).activeFileTurns;
  } catch (err) {
    logger.warn({ userId, msg: err.message }, 'Could not load activeFileTurns; using default');
  }
  const activeBlock = await resolveActiveFileBlock(userId, conversationId, currentTurn, activeFileTurns);
  let trailingMessages = activeBlock ? appendToLastUserMessage(messages, activeBlock) : messages;

  // Scratchpad (SP-02): injected in full every turn it is active + non-empty
  // (NOT recency-windowed like active files). Gated on the same enabled flag the
  // endpoints use to advertise the scratchpad tools, so a disabled pad neither
  // injects nor tempts the model.
  const scratchpadEnabled = resolveScratchpadEnabled(userId, containers.conversation);
  if (scratchpadEnabled) {
    const scratchpadBlock = resolveScratchpadBlock(conversationId, currentTurn, config.scratchpad.injectDiffCount);
    if (scratchpadBlock) trailingMessages = appendToLastUserMessage(trailingMessages, scratchpadBlock);
  }

  const { system, messages: assembled } =
    assembleProviderInput(requestContext, systemPrompt, trailingMessages, expressionNames, scratchpadEnabled);
  return { system, messages: assembled, requestContext, currentTurn, toolsEnabled, scratchpadEnabled };
}

/**
 * Resolve whether file tools are enabled for this request (Track A).
 * Precedence: conversation override (tools_enabled 1/0) → persona base
 * (model_config.toolsEnabled) → false. Resolved SERVER-SIDE only — the
 * client never passes a tools flag and the routes never forward one, so
 * tools cannot be injected via the request body.
 *
 * A request without a persisted conversation (e.g. a preview for a fresh
 * chat) has no override or persona to consult → tools off.
 *
 * @param {string} userId
 * @param {Object|null} conversation - conversations row (snake_case)
 * @returns {boolean}
 */
/**
 * Build the runToolLoop inputs shared by the JSON and SSE endpoints, so the
 * two branches can't drift (same params contract, same tool context).
 * @param {Object} req - Express request (req.user)
 * @param {Object} containers - resolveRequestContainers(req) result
 * @param {Object} chatParams - { model, messages, systemPrompt, modelParams, attachments }
 * @returns {{ params: Object, toolContext: Object }}
 */
function buildToolLoopInvocation(req, containers, chatParams, turnOrdinal = null) {
  return {
    params: chatParams,
    toolContext: {
      userId: req.user.userId,
      workspace: containers.workspace,
      project: containers.project,
      conversationId: containers.conversation?.id || null,
      // Turn a tool write is stamped with (FC-03b) = the user-message count of
      // THIS request, so the file is live on the next turn. Computed from the
      // raw messages (before the KB synthetic turn is prepended).
      turnOrdinal,
    },
  };
}

function resolveToolsEnabled(userId, conversation) {
  if (!conversation) return false;
  if (conversation.tools_enabled === 0) return false;
  if (conversation.tools_enabled === 1) return true;
  if (!conversation.persona_id) return false;
  const persona = dal.getPersonaById(conversation.persona_id, userId);
  return persona?.modelConfig?.toolsEnabled === true;
}

/**
 * Resolve whether the scratchpad is active for this request (SP-02). Gated
 * independently of file tools (Decision 3). Precedence:
 *   conversation override (scratchpad_enabled 1/0)
 *   → persona base (model_config.scratchpadEnabled)
 *   → AUTO-ARM: a non-empty pad means the user is already using it (Decision 2).
 * Server-side only, like resolveToolsEnabled. "Active" means the scratchpad
 * tools are advertised and the pad is injected when non-empty.
 * @param {string} userId
 * @param {Object|null} conversation - conversations row (snake_case)
 * @returns {boolean}
 */
function resolveScratchpadEnabled(userId, conversation) {
  if (!conversation) return false;
  if (conversation.scratchpad_enabled === 0) return false;
  if (conversation.scratchpad_enabled === 1) return true;
  if (conversation.persona_id) {
    const persona = dal.getPersonaById(conversation.persona_id, userId);
    if (persona?.modelConfig?.scratchpadEnabled === true) return true;
  }
  // Auto-arm: using the feature (a non-empty pad) enables it, without needing
  // an explicit toggle. The explicit toggle (above) covers the cold-start case
  // of drafting into an empty pad, and staying armed after a clear.
  const pad = dal.getScratchpad(conversation.id);
  return !!(pad && pad.content && pad.content.trim() !== '');
}

/**
 * The tool set advertised to the model for this request: file tools when the
 * file-tools toggle is on, scratchpad tools when the scratchpad is active — each
 * independently. Empty array = no tool loop.
 * @param {boolean} toolsEnabled
 * @param {boolean} scratchpadEnabled
 * @returns {Array}
 */
function resolveAdvertisedTools(toolsEnabled, scratchpadEnabled) {
  return [
    ...(toolsEnabled ? TOOL_DEFINITIONS : []),
    ...(scratchpadEnabled ? SCRATCHPAD_TOOL_DEFINITIONS : []),
  ];
}

/**
 * The Track A tool loop (decision 3 in docs/PHASE2_TASKS.md): repeatedly call
 * the provider NON-streaming; when the model requests tools, execute them and
 * continue with the raw assistant message + a tool-result message appended
 * (raw-message discipline — decision 4); stop at the first response with no
 * tool calls, which is the final answer.
 *
 * Ordering invariant: results[i] must answer calls[i] — Gemini pairs
 * same-name parallel responses by order alone. Tools execute sequentially to
 * keep that trivially true.
 *
 * Abort: checked between the provider round trip and tool execution, and
 * between tools — a tool has side effects, so nothing executes after the
 * client disconnects. An abort mid-provider-fetch surfaces as AbortError and
 * is converted to `{ aborted: true }`.
 *
 * @param {Object} opts
 * @param {Object} opts.providerModule - Must implement chatRaw/formatChatResult
 *   + the tool contract (formatTools/extractToolCalls/buildToolResultMessage)
 * @param {string} opts.apiKey
 * @param {Object} opts.params - { model, messages, systemPrompt, modelParams, attachments }
 *   (NO prefill — skipped when tools are on, decision 5)
 * @param {Object} opts.toolContext - { userId, workspace, project, conversationId }
 * @param {AbortSignal} [opts.signal]
 * @param {(event: Object) => void} [opts.onEvent] - Called after each tool
 *   executes, with { tool, filename?, ok } (compact — no file contents)
 * @returns {Promise<{ result?: Object, toolEvents: Array, aborted?: boolean }>}
 */
async function runToolLoop({ providerModule, apiKey, params, toolContext, signal, onEvent = () => {} }) {
  const messages = [...params.messages];
  const toolEvents = [];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    let data;
    try {
      data = await providerModule.chatRaw(
        apiKey,
        // `params.tools` is the resolved set (file tools and/or scratchpad tools,
        // gated independently by the caller). Prefill is always dropped in the loop.
        { ...params, messages, prefill: undefined, tools: params.tools || TOOL_DEFINITIONS },
        signal
      );
    } catch (err) {
      if (err.name === 'AbortError') return { aborted: true, toolEvents };
      throw err;
    }

    const extraction = providerModule.extractToolCalls(data);
    if (!extraction) {
      return { result: providerModule.formatChatResult(data, params.model), toolEvents };
    }

    if (signal?.aborted) return { aborted: true, toolEvents };

    messages.push(extraction.rawAssistantMessage);

    const results = [];
    for (const call of extraction.calls) {
      let result;
      try {
        result = await executeToolCall(call, toolContext);
      } catch (err) {
        // Executor failures feed back to the model as an error result — a
        // broken tool must never break the conversation.
        logger.error({ userId: toolContext.userId, tool: call.name, msg: err.message }, 'Tool executor threw');
        result = { content: `Tool ${call.name} failed: ${err.message}`, isError: true };
      }
      results.push(result);

      const event = {
        tool: call.name,
        ...(typeof call.input?.filename === 'string' ? { filename: call.input.filename } : {}),
        ok: !result.isError,
        // Executors may attach display extras (e.g. a download URL, P2-03).
        ...(result.display || {}),
      };
      toolEvents.push(event);
      onEvent(event);

      if (signal?.aborted) return { aborted: true, toolEvents };
    }

    messages.push(providerModule.buildToolResultMessage(extraction.calls, results));
  }

  throw AppError.provider(
    `The model kept calling tools without finishing (limit: ${MAX_TOOL_ITERATIONS} rounds). Try rephrasing the request.`
  );
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
  const { provider, model, messages, systemPrompt, modelParams, prefill, attachments, expressionNames } = req.body;

  validateChatRequest(req.body);

  // Get user's API key for this provider
  const apiKey = getDecryptedApiKey(req.user.userId, provider);

  // Get provider module
  const providerModule = getProvider(provider);

  // Assemble the request (FC-03a KB relocation + FC-03b active-file injection).
  const containers = resolveRequestContainers(req);
  const { system: effectiveSystemPrompt, messages: effectiveMessages, requestContext, currentTurn, toolsEnabled, scratchpadEnabled } =
    await assembleChatRequest(req, containers, { systemPrompt, messages, expressionNames });
  const advertisedTools = resolveAdvertisedTools(toolsEnabled, scratchpadEnabled);

  logger.info({
    userId: req.user.userId,
    provider,
    model,
    messageCount: messages.length,
    projectContext: Boolean(requestContext?.text),
    toolsEnabled,
    scratchpadEnabled,
  }, 'Chat request');

  let result;
  if (advertisedTools.length > 0) {
    // Tool loop (prefill intentionally dropped — decision 5). Runs whenever any
    // tools are advertised (file tools and/or scratchpad). Abort on client
    // disconnect so no tool executes for an abandoned request.
    const abortController = new AbortController();
    req.on('close', () => abortController.abort());

    const { params: loopParams, toolContext } = buildToolLoopInvocation(req, containers, {
      model, messages: effectiveMessages, systemPrompt: effectiveSystemPrompt, modelParams, attachments,
      tools: advertisedTools,
    }, currentTurn);
    const { result: loopResult, toolEvents, aborted } = await runToolLoop({
      providerModule,
      apiKey,
      params: loopParams,
      toolContext,
      signal: abortController.signal,
    });
    if (aborted) {
      res.end();
      return;
    }
    result = { ...loopResult, toolEvents };
  } else {
    // Call provider's chat method
    result = await providerModule.chat(apiKey, {
      model,
      messages: effectiveMessages,
      systemPrompt: effectiveSystemPrompt,
      modelParams,
      prefill,
      attachments,
    });
  }

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
  const { provider, model, messages, systemPrompt, modelParams, prefill, attachments, expressionNames } = req.body;

  validateChatRequest(req.body);

  // Get user's API key for this provider
  const apiKey = getDecryptedApiKey(req.user.userId, provider);

  // Get provider module
  const providerModule = getProvider(provider);

  if (!providerModule.stream) {
    throw AppError.validation(`Streaming not supported for provider: ${provider}`);
  }

  // Assemble the request (FC-03a KB relocation + FC-03b active-file injection).
  // Resolved before any SSE headers are sent so the warning header is valid.
  const containers = resolveRequestContainers(req);
  const { system: effectiveSystemPrompt, messages: effectiveMessages, requestContext, currentTurn, toolsEnabled, scratchpadEnabled } =
    await assembleChatRequest(req, containers, { systemPrompt, messages, expressionNames });
  const advertisedTools = resolveAdvertisedTools(toolsEnabled, scratchpadEnabled);

  if (requestContext?.warning) {
    res.setHeader('X-Project-Context-Warning', encodeURIComponent(requestContext.warning));
  }

  logger.info({
    userId: req.user.userId,
    provider,
    model,
    messageCount: messages.length,
    projectContext: Boolean(requestContext?.text),
    toolsEnabled,
    scratchpadEnabled,
  }, 'Stream request');

  // Set up abort handling for client disconnect
  const abortController = new AbortController();

  req.on('close', () => {
    logger.debug({ userId: req.user.userId }, 'Client disconnected from stream');
    abortController.abort();
  });

  if (advertisedTools.length > 0) {
    // Tools-on turns (file tools and/or scratchpad) run the NON-streaming loop
    // and deliver everything as synthetic SSE over this same channel (decision
    // 3): tool-activity events while tools run, then the final answer as ONE
    // provider-native-shaped chunk so the existing client accumulator renders it
    // unchanged, then a done event carrying the full tool-event list (P2-05b).
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const writeEvent = (eventName, payload) => {
      if (res.writableEnded) return;
      if (eventName) res.write(`event: ${eventName}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      const { params: loopParams, toolContext } = buildToolLoopInvocation(req, containers, {
        model, messages: effectiveMessages, systemPrompt: effectiveSystemPrompt, modelParams, attachments,
        tools: advertisedTools,
      }, currentTurn);
      const { result, toolEvents, aborted } = await runToolLoop({
        providerModule,
        apiKey,
        params: loopParams,
        toolContext,
        signal: abortController.signal,
        onEvent: (ev) => writeEvent('tool-activity', { type: 'tool_activity', ...ev }),
      });

      if (!aborted) {
        // Final answer as one provider-native-shaped chunk. The shape lives
        // in the provider module (tool contract) so chat.js stays
        // provider-agnostic — Phase 3's OpenAI just implements the same fn.
        const finalEvent = providerModule.formatFinalSseEvent(result);
        writeEvent(finalEvent.event, finalEvent.data);
        writeEvent('done', { type: 'tool_loop_done', toolEvents });
      }
    } catch (err) {
      // SSE headers are already sent, so the HTTP error path can't run.
      // Emit the provider-style error payload the client's mid-stream error
      // handler (C7) already understands, then end.
      logger.error({ userId: req.user.userId, provider, msg: err.message }, 'Tool loop failed');
      writeEvent('error', {
        type: 'error',
        error: { type: err.code || 'TOOL_LOOP_ERROR', message: err.message },
      });
    }
    res.end();
    return;
  }

  // Call provider's stream method
  await providerModule.stream(apiKey, {
    model,
    messages: effectiveMessages,
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
  const { provider, model, messages = [], systemPrompt, modelParams, prefill, attachments, expressionNames } = req.body;

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

  // Identical context assembly to the real chat path — including the tools
  // toggle, so the inspector shows the tool definitions (and the skipped
  // prefill) exactly as a real tools-on send would build them, plus the KB
  // relocation and active-file injection.
  const containers = resolveRequestContainers(req);
  const { system: effectiveSystemPrompt, messages: effectiveMessages, requestContext, toolsEnabled, scratchpadEnabled } =
    await assembleChatRequest(req, containers, { systemPrompt, messages, expressionNames });
  const advertisedTools = resolveAdvertisedTools(toolsEnabled, scratchpadEnabled);
  const anyTools = advertisedTools.length > 0;

  const body = providerModule.buildRequestBody({
    model,
    messages: effectiveMessages,
    systemPrompt: effectiveSystemPrompt,
    modelParams,
    prefill: anyTools ? undefined : prefill,
    attachments,
    ...(anyTools ? { tools: advertisedTools } : {}),
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
    toolsEnabled,
    scratchpadEnabled,
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
  assembleProviderInput,
  // Exported for headless tool-loop tests (P2-02).
  resolveRequestContainers,
  resolveToolsEnabled,
  resolveScratchpadEnabled,
  resolveAdvertisedTools,
  runToolLoop,
};
