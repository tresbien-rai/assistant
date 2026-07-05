/**
 * Anthropic Provider Module
 *
 * Handles communication with Anthropic's Claude API for chat completions.
 * Supports both streaming and non-streaming responses.
 */

const AppError = require('../utils/AppError');
const { logger } = require('../utils/logger');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Build request headers for Anthropic API
 * @param {string} apiKey - The user's Anthropic API key
 * @returns {Object} Headers object
 */
function buildHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
}

/**
 * Build the request body for Anthropic API
 * @param {Object} params - Chat parameters
 * @returns {Object} Request body
 */
function buildRequestBody(params) {
  const { model, messages, systemPrompt, modelParams, prefill, tools, stream = false } = params;

  // Build messages array, handling attachments in the content
  const formattedMessages = messages.map(msg => {
    // If content is already an array, use as-is. This is both the attachment
    // path AND the raw-replay path for the tool loop (assistant messages with
    // tool_use/thinking blocks, user messages with tool_result blocks) —
    // blocks must pass through VERBATIM (raw-message discipline, Track A).
    if (Array.isArray(msg.content)) {
      return { role: msg.role, content: msg.content };
    }
    // Otherwise, simple text content
    return { role: msg.role, content: msg.content };
  });

  // Add prefill as assistant message if provided
  if (prefill && prefill.trim()) {
    formattedMessages.push({ role: 'assistant', content: prefill.trim() });
  }

  const body = {
    model,
    messages: formattedMessages,
    max_tokens: modelParams?.maxTokens || 4096,
  };

  // Add system prompt if provided
  if (systemPrompt) {
    body.system = systemPrompt;
  }

  // Advertise tools (Track A). `tools` arrives in the provider-neutral shape
  // from tools/definitions.js — for Anthropic that IS the native shape.
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = formatTools(tools);
  }

  // Add stream flag
  if (stream) {
    body.stream = true;
  }

  // Add optional parameters if enabled
  if (modelParams) {
    if (modelParams.temperatureEnabled !== false && modelParams.temperature !== undefined) {
      body.temperature = modelParams.temperature;
    }
    if (modelParams.topPEnabled !== false && modelParams.topP !== undefined) {
      body.top_p = modelParams.topP;
    }
    if (modelParams.topKEnabled !== false && modelParams.topK !== undefined) {
      body.top_k = modelParams.topK;
    }
    if (modelParams.stopSequences && modelParams.stopSequences.length > 0) {
      body.stop_sequences = modelParams.stopSequences;
    }

    // Extended thinking configuration
    if (modelParams.anthropic?.thinkingEnabled) {
      body.thinking = {
        type: 'enabled',
        budget_tokens: modelParams.anthropic.thinkingBudget || 4000,
      };
    }
  }

  return body;
}

// =============================================================================
// Tool contract (Track A, P2-01) — formatTools / extractToolCalls /
// buildToolResultMessage. The chat loop (P2-02) stays provider-agnostic by
// only ever touching this trio; adding a provider means implementing the same
// three functions there. See "Decisions" in docs/PHASE2_TASKS.md.
// =============================================================================

/**
 * Translate provider-neutral tool definitions into Anthropic's `tools` param.
 * The neutral shape is Anthropic's shape (name / description / input_schema),
 * so this is a defensive copy of exactly those fields.
 * @param {Array} defs - tools/definitions.js TOOL_DEFINITIONS
 * @returns {Array} Anthropic tools array
 */
function formatTools(defs) {
  return defs.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

/**
 * Extract tool calls from a non-streaming Messages API response.
 *
 * Returns dispatch-shaped calls PLUS the raw assistant message. The loop must
 * replay `rawAssistantMessage` verbatim in the continuation request —
 * including thinking blocks (with signatures) and text — never rebuild it
 * from the dispatch shape (raw-message discipline).
 *
 * @param {Object} data - Parsed Messages API response JSON
 * @returns {{ calls: Array<{id: string, name: string, input: Object}>,
 *             rawAssistantMessage: {role: 'assistant', content: Array} } | null}
 *          null when the response contains no tool calls (final answer).
 */
function extractToolCalls(data) {
  const blocks = Array.isArray(data.content) ? data.content : [];
  const calls = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input || {} }));
  if (calls.length === 0) return null;
  return { calls, rawAssistantMessage: { role: 'assistant', content: blocks } };
}

/**
 * Build the user-role continuation message carrying tool results. Handles
 * parallel calls: all results return in ONE message, ordered like `calls`.
 * @param {Array<{id, name, input}>} calls - From extractToolCalls
 * @param {Array<{content: string, isError?: boolean}>} results - results[i] answers calls[i]
 * @returns {{role: 'user', content: Array}} Message for the continuation request
 */
function buildToolResultMessage(calls, results) {
  if (results.length !== calls.length) {
    // A mismatch is a tool-loop programming error; fail loudly with a clear
    // message instead of a TypeError deep in the map below.
    throw new Error(`buildToolResultMessage: ${calls.length} calls but ${results.length} results`);
  }
  return {
    role: 'user',
    content: calls.map((call, i) => ({
      type: 'tool_result',
      tool_use_id: call.id,
      content: results[i].content,
      ...(results[i].isError ? { is_error: true } : {}),
    })),
  };
}

/**
 * Shape the tool loop's final answer as ONE synthetic provider-native SSE
 * payload (P2-02, decision 3): the client's existing Anthropic stream parser
 * consumes it with zero changes. Part of the tool contract so chat.js never
 * needs provider-shape knowledge.
 * @param {{text: string}} result - formatChatResult output
 * @returns {{event: string|null, data: Object}}
 */
function formatFinalSseEvent(result) {
  return {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', delta: { type: 'text_delta', text: result.text } },
  };
}

/**
 * Map Anthropic API errors to AppError
 * @param {Response} response - Fetch response
 * @param {Object} errorData - Parsed error response
 * @returns {AppError}
 */
function mapApiError(response, errorData) {
  const status = response.status;
  const message = errorData?.error?.message || `Anthropic API error (${status})`;
  const errorType = errorData?.error?.type;

  switch (status) {
    case 400:
      return AppError.validation(message, { provider: 'anthropic', type: errorType });
    case 401:
      return AppError.provider('Invalid Anthropic API key. Please check your key in Settings.', { provider: 'anthropic' });
    case 403:
      return AppError.provider('Access denied by Anthropic API. Your API key may not have the required permissions.', { provider: 'anthropic' });
    case 429:
      // Extract retry-after if available
      const retryAfter = parseInt(response.headers.get('retry-after'), 10) || 60;
      const rateLimitError = AppError.rateLimited(retryAfter);
      rateLimitError.message = message;
      return rateLimitError;
    case 500:
    case 502:
    case 503:
      return AppError.provider('Anthropic API is temporarily unavailable. Please try again later.', { provider: 'anthropic' });
    default:
      return AppError.provider(message, { provider: 'anthropic', status });
  }
}

/**
 * Non-streaming request returning the RAW parsed Messages API response. The
 * tool loop (P2-02) needs the native shape for extractToolCalls; chat() wraps
 * this for the plain no-tools path.
 * @param {string} apiKey - User's Anthropic API key
 * @param {Object} params - Chat parameters (may include tools + raw messages)
 * @param {AbortSignal} [signal] - Optional abort signal for cancellation
 * @returns {Promise<Object>} Parsed response JSON
 */
async function chatRaw(apiKey, params, signal) {
  const headers = buildHeaders(apiKey);
  const body = buildRequestBody({ ...params, stream: false });

  logger.debug({ model: body.model, messageCount: body.messages.length }, 'Anthropic chat request');

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw mapApiError(response, errorData);
  }

  return response.json();
}

/**
 * Reduce a raw Messages API response to the app's chat-result shape.
 * @param {Object} data - Parsed Messages API response JSON
 * @returns {{text: string, model: string, usage?: Object, stopReason?: string}}
 */
function formatChatResult(data) {
  const textContent = data.content?.find(block => block.type === 'text');
  if (!textContent) {
    throw AppError.provider('No text response received from Anthropic', { provider: 'anthropic' });
  }

  return {
    text: textContent.text,
    model: data.model,
    usage: data.usage,
    stopReason: data.stop_reason,
  };
}

/**
 * Non-streaming chat completion
 * @param {string} apiKey - User's Anthropic API key
 * @param {Object} params - Chat parameters
 * @returns {Promise<Object>} Response object with text content
 */
async function chat(apiKey, params) {
  return formatChatResult(await chatRaw(apiKey, params));
}

/**
 * Streaming chat completion
 * Pipes SSE events to the Express response
 * @param {string} apiKey - User's Anthropic API key
 * @param {Object} params - Chat parameters
 * @param {Response} res - Express response object
 * @param {AbortSignal} [signal] - Optional abort signal for cancellation
 */
async function stream(apiKey, params, res, signal) {
  const headers = buildHeaders(apiKey);
  const body = buildRequestBody({ ...params, stream: true });

  logger.debug({ model: body.model, messageCount: body.messages.length }, 'Anthropic stream request');

  let response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // Handle abort during fetch
    if (err.name === 'AbortError') {
      logger.debug('Anthropic stream fetch aborted by client');
      if (!res.headersSent) {
        res.end();
      }
      return;
    }
    throw err;
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw mapApiError(response, errorData);
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Forward raw SSE chunks to client
      const chunk = decoder.decode(value, { stream: true });
      res.write(chunk);
    }
  } catch (err) {
    // Check if it's an abort error
    if (err.name === 'AbortError') {
      logger.debug('Anthropic stream aborted by client');
    } else {
      logger.error({ err }, 'Error reading Anthropic stream');
      throw err;
    }
  } finally {
    res.end();
  }
}

/**
 * Fetch available models from Anthropic
 * @param {string} apiKey - User's Anthropic API key
 * @returns {Promise<Array>} List of available models
 */
async function listModels(apiKey) {
  const headers = buildHeaders(apiKey);

  const response = await fetch(ANTHROPIC_MODELS_URL, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw mapApiError(response, errorData);
  }

  const data = await response.json();
  return data.data || [];
}

module.exports = {
  chat,
  chatRaw,
  formatChatResult,
  stream,
  listModels,
  // Exposed for the request inspector (P2-U4): builds the exact provider body
  // without sending it. The API key is never part of the body (it's a header).
  buildRequestBody,
  // Tool contract (Track A, P2-01) — consumed by the chat tool loop.
  formatTools,
  extractToolCalls,
  buildToolResultMessage,
  formatFinalSseEvent,
};
