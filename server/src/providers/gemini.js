/**
 * Gemini Provider Module
 *
 * Handles communication with Google's Gemini API for chat completions.
 * Supports both streaming and non-streaming responses.
 */

const AppError = require('../utils/AppError');
const { logger } = require('../utils/logger');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Build request headers for Gemini API
 * @param {string} apiKey - The user's Google API key
 * @returns {Object} Headers object
 */
function buildHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey,
  };
}

/**
 * Build the request body for Gemini API
 * @param {Object} params - Chat parameters
 * @returns {Object} Request body
 */
function buildRequestBody(params) {
  const { messages, systemPrompt, modelParams, prefill, tools } = params;

  // Convert messages to Google format: 'assistant' -> 'model', 'user' -> 'user'
  const contents = messages.map(msg => {
    // Already-native message (raw model reply or functionResponse turn from
    // the tool loop): pass its parts through VERBATIM so functionCall parts
    // keep their thoughtSignature (raw-message discipline, Track A).
    if (Array.isArray(msg.parts)) {
      return {
        role: msg.role === 'assistant' || msg.role === 'model' ? 'model' : 'user',
        parts: msg.parts,
      };
    }
    // If content is an array (with attachments), convert to parts format
    if (Array.isArray(msg.content)) {
      const parts = msg.content.map(item => {
        if (item.type === 'text') {
          return { text: item.text };
        } else if (item.type === 'image') {
          // Convert Anthropic-flavored image block to Gemini's inline_data.
          return {
            inline_data: {
              mime_type: item.source?.media_type || 'image/png',
              data: item.source?.data || '',
            },
          };
        } else if (item.type === 'document') {
          // PDFs (Anthropic-flavored 'document' block) go inline for Gemini.
          // Previously fell through to String(item) → '[object Object]'.
          return {
            inline_data: {
              mime_type: item.source?.media_type || 'application/pdf',
              data: item.source?.data || '',
            },
          };
        } else if (item.type === 'audio') {
          // Gemini supports audio via inline_data; Anthropic doesn't, so this
          // block only reaches here when the frontend emits it for Gemini.
          return {
            inline_data: {
              mime_type: item.source?.media_type || 'audio/wav',
              data: item.source?.data || '',
            },
          };
        }
        return { text: String(item) };
      });
      return {
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts,
      };
    }

    // Simple text content
    return {
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    };
  });

  // Add prefill as model message if provided
  if (prefill && prefill.trim()) {
    contents.push({ role: 'model', parts: [{ text: prefill.trim() }] });
  }

  // Build generationConfig with only enabled parameters
  const generationConfig = {
    maxOutputTokens: modelParams?.maxTokens || 4096,
  };

  if (modelParams?.temperatureEnabled !== false && modelParams?.temperature !== undefined) {
    generationConfig.temperature = modelParams.temperature;
  }
  if (modelParams?.topPEnabled !== false && modelParams?.topP !== undefined) {
    generationConfig.topP = modelParams.topP;
  }
  if (modelParams?.topKEnabled !== false && modelParams?.topK !== undefined) {
    generationConfig.topK = modelParams.topK;
  }
  if (modelParams?.stopSequences && modelParams.stopSequences.length > 0) {
    generationConfig.stopSequences = modelParams.stopSequences;
  }

  // Add thinkingConfig if enabled
  if (modelParams?.google?.thinkingLevel && modelParams.google.thinkingLevel !== 'off') {
    generationConfig.thinkingConfig = {
      thinkingLevel: modelParams.google.thinkingLevel,
    };
  }

  const body = {
    contents,
    generationConfig,
  };

  // Add system instruction if provided
  if (systemPrompt) {
    body.systemInstruction = {
      parts: [{ text: systemPrompt }],
    };
  }

  // Advertise tools (Track A). `tools` arrives in the provider-neutral shape
  // from tools/definitions.js and is translated to functionDeclarations.
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = formatTools(tools);
  }

  // Add safety settings if configured
  if (modelParams?.google) {
    const safetySettings = [];
    if (modelParams.google.safetyHarassment) {
      safetySettings.push({
        category: 'HARM_CATEGORY_HARASSMENT',
        threshold: modelParams.google.safetyHarassment,
      });
    }
    if (modelParams.google.safetyHate) {
      safetySettings.push({
        category: 'HARM_CATEGORY_HATE_SPEECH',
        threshold: modelParams.google.safetyHate,
      });
    }
    if (modelParams.google.safetySexual) {
      safetySettings.push({
        category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        threshold: modelParams.google.safetySexual,
      });
    }
    if (modelParams.google.safetyDangerous) {
      safetySettings.push({
        category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
        threshold: modelParams.google.safetyDangerous,
      });
    }
    if (safetySettings.length > 0) {
      body.safetySettings = safetySettings;
    }
  }

  return body;
}

// =============================================================================
// Tool contract (Track A, P2-01) — formatTools / extractToolCalls /
// buildToolResultMessage. Mirrors providers/anthropic.js so the chat loop
// stays provider-agnostic. See "Decisions" in docs/PHASE2_TASKS.md.
// =============================================================================

/**
 * Convert a JSON Schema fragment to Gemini's Schema shape. Gemini's `type`
 * field is a proto enum (STRING / OBJECT / ...), so JSON Schema's lowercase
 * types are uppercased recursively; other fields pass through.
 * @param {Object} schema
 * @returns {Object}
 */
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type' && typeof value === 'string') {
      out.type = value.toUpperCase();
    } else if (key === 'properties' && value && typeof value === 'object') {
      out.properties = {};
      for (const [prop, sub] of Object.entries(value)) {
        out.properties[prop] = toGeminiSchema(sub);
      }
    } else if (key === 'items') {
      out.items = toGeminiSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Translate provider-neutral tool definitions into Gemini's `tools` param
 * (a single functionDeclarations group). A no-argument tool omits
 * `parameters` entirely — Gemini rejects an OBJECT schema with no properties.
 * @param {Array} defs - tools/definitions.js TOOL_DEFINITIONS
 * @returns {Array} Gemini tools array
 */
function formatTools(defs) {
  return [{
    functionDeclarations: defs.map((d) => {
      const decl = { name: d.name, description: d.description };
      if (d.input_schema && Object.keys(d.input_schema.properties || {}).length > 0) {
        decl.parameters = toGeminiSchema(d.input_schema);
      }
      return decl;
    }),
  }];
}

/**
 * Extract function calls from a non-streaming generateContent response.
 *
 * Gemini has no per-call ids, so stable synthetic ids (`name_index`) are
 * minted for dispatch. The raw candidate parts are returned as
 * `rawAssistantMessage` and must be replayed VERBATIM in the continuation
 * request — Gemini 2.5's functionCall parts carry a `thoughtSignature` that
 * the API requires back (raw-message discipline).
 *
 * @param {Object} data - Parsed generateContent response JSON
 * @returns {{ calls: Array<{id: string, name: string, input: Object}>,
 *             rawAssistantMessage: {role: 'model', parts: Array} } | null}
 *          null when the response contains no function calls (final answer).
 */
function extractToolCalls(data) {
  const parts = data.candidates?.[0]?.content?.parts || [];
  const calls = [];
  parts.forEach((part, i) => {
    if (part.functionCall) {
      calls.push({
        id: `${part.functionCall.name}_${i}`,
        name: part.functionCall.name,
        input: part.functionCall.args || {},
      });
    }
  });
  if (calls.length === 0) return null;
  return { calls, rawAssistantMessage: { role: 'model', parts } };
}

/**
 * Build the user-role continuation message carrying function responses.
 * Handles parallel calls: all results return in ONE message, ordered like
 * `calls`. Gemini matches responses by function NAME (it has no call ids) —
 * so when the SAME function is called twice in one turn, pairing relies
 * entirely on order. The loop must keep results[i] answering calls[i]; this
 * function preserves that order into the parts array.
 * @param {Array<{id, name, input}>} calls - From extractToolCalls
 * @param {Array<{content: string, isError?: boolean}>} results - results[i] answers calls[i]
 * @returns {{role: 'user', parts: Array}} Message for the continuation request
 */
function buildToolResultMessage(calls, results) {
  if (results.length !== calls.length) {
    // A mismatch is a tool-loop programming error; fail loudly with a clear
    // message instead of a TypeError deep in the map below.
    throw new Error(`buildToolResultMessage: ${calls.length} calls but ${results.length} results`);
  }
  return {
    role: 'user',
    parts: calls.map((call, i) => ({
      functionResponse: {
        name: call.name,
        response: results[i].isError
          ? { error: results[i].content }
          : { output: results[i].content },
      },
    })),
  };
}

/**
 * Shape the tool loop's final answer as ONE synthetic provider-native SSE
 * payload (P2-02, decision 3): the client's existing Gemini stream parser
 * consumes it with zero changes (text + any generated images as parts).
 * Part of the tool contract so chat.js never needs provider-shape knowledge.
 * @param {{text: string, generatedImages?: Array}} result - formatChatResult output
 * @returns {{event: string|null, data: Object}}
 */
function formatFinalSseEvent(result) {
  const parts = [
    { text: result.text },
    ...(result.generatedImages || []).map((img) => ({
      inlineData: { mimeType: img.mimeType, data: img.base64Data },
    })),
  ];
  return { event: null, data: { candidates: [{ content: { parts } }] } };
}

/**
 * Map Gemini API errors to AppError
 * @param {Response} response - Fetch response
 * @param {Object} errorData - Parsed error response
 * @returns {AppError}
 */
function mapApiError(response, errorData) {
  const status = response.status;
  const errorMessage = errorData?.error?.message || `Gemini API error (${status})`;
  const errorStatus = errorData?.error?.status;

  switch (errorStatus) {
    case 'INVALID_ARGUMENT':
      if (errorMessage.includes('API key')) {
        return AppError.provider('Invalid Google API key. Please check your key in Settings.', { provider: 'google', status: errorStatus });
      }
      return AppError.validation(errorMessage, { provider: 'google', status: errorStatus });
    case 'PERMISSION_DENIED':
      return AppError.provider('API key does not have permission. Enable the Generative Language API in Google Cloud Console.', { provider: 'google', status: errorStatus });
    case 'RESOURCE_EXHAUSTED': {
      const retryAfter = parseInt(response.headers.get('retry-after'), 10) || 60;
      const rateLimitError = AppError.rateLimited(retryAfter);
      rateLimitError.message = 'Rate limit exceeded. Please wait and try again.';
      return rateLimitError;
    }
    case 'NOT_FOUND':
      return AppError.validation(`Model not found. ${errorMessage}`, { provider: 'google', status: errorStatus });
    default:
      break;
  }

  // HTTP status code fallback
  switch (status) {
    case 400:
      return AppError.validation(errorMessage, { provider: 'google' });
    case 401:
    case 403:
      return AppError.provider('Invalid or unauthorized Google API key.', { provider: 'google' });
    case 429: {
      const retryAfter = parseInt(response.headers.get('retry-after'), 10) || 60;
      const rateLimitErr = AppError.rateLimited(retryAfter);
      rateLimitErr.message = errorMessage;
      return rateLimitErr;
    }
    case 500:
    case 502:
    case 503:
      return AppError.provider('Gemini API is temporarily unavailable. Please try again later.', { provider: 'google' });
    default:
      return AppError.provider(errorMessage, { provider: 'google', status });
  }
}

/**
 * Parse multimodal response from Gemini (text + generated images)
 * @param {Object} candidate - The response candidate from Gemini API
 * @returns {Object} { text: string, generatedImages: Array }
 */
function parseMultimodalResponse(candidate) {
  const result = {
    text: '',
    generatedImages: [],
  };

  if (!candidate?.content?.parts) {
    logger.debug({ finishReason: candidate?.finishReason }, 'Gemini response has no content parts');
    return result;
  }

  const textParts = [];

  for (const part of candidate.content.parts) {
    if (part.text) {
      textParts.push(part.text);
    } else if (part.inlineData) {
      result.generatedImages.push({
        mimeType: part.inlineData.mimeType,
        base64Data: part.inlineData.data,
      });
    }
  }

  result.text = textParts.join('');
  return result;
}

/**
 * Non-streaming request returning the RAW parsed generateContent response.
 * The tool loop (P2-02) needs the native shape for extractToolCalls; chat()
 * wraps this for the plain no-tools path.
 * @param {string} apiKey - User's Google API key
 * @param {Object} params - Chat parameters (may include tools + raw parts messages)
 * @param {AbortSignal} [signal] - Optional abort signal for cancellation
 * @returns {Promise<Object>} Parsed response JSON
 */
async function chatRaw(apiKey, params, signal) {
  const headers = buildHeaders(apiKey);
  const body = buildRequestBody(params);
  const { model } = params;

  const endpoint = `${GEMINI_API_BASE}/${model}:generateContent`;

  logger.debug({ model, messageCount: body.contents.length }, 'Gemini chat request');

  const response = await fetch(endpoint, {
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
 * Reduce a raw generateContent response to the app's chat-result shape.
 * @param {Object} data - Parsed generateContent response JSON
 * @param {string} model - The model the request was made with (Gemini doesn't echo it)
 * @returns {{text: string, model: string, generatedImages: Array, stopReason?: string, usage?: Object}}
 */
function formatChatResult(data, model) {
  // Extract content from Gemini response format
  const candidate = data.candidates?.[0];
  if (!candidate) {
    throw AppError.provider('No response candidates received from Gemini', { provider: 'google' });
  }

  // Parse multimodal response (text + generated images)
  const parsed = parseMultimodalResponse(candidate);

  // Handle responses with no content at all
  if (!parsed.text && parsed.generatedImages.length === 0) {
    throw AppError.provider('No content received from Gemini', { provider: 'google' });
  }

  return {
    text: parsed.text,
    model,
    generatedImages: parsed.generatedImages,
    stopReason: candidate.finishReason,
    usage: data.usageMetadata ? {
      promptTokens: data.usageMetadata.promptTokenCount,
      completionTokens: data.usageMetadata.candidatesTokenCount,
      totalTokens: data.usageMetadata.totalTokenCount,
    } : undefined,
  };
}

async function chat(apiKey, params) {
  return formatChatResult(await chatRaw(apiKey, params), params.model);
}

/**
 * Streaming chat completion
 * Pipes SSE events to the Express response
 * @param {string} apiKey - User's Google API key
 * @param {Object} params - Chat parameters
 * @param {Response} res - Express response object
 * @param {AbortSignal} [signal] - Optional abort signal for cancellation
 */
async function stream(apiKey, params, res, signal) {
  const headers = buildHeaders(apiKey);
  const body = buildRequestBody(params);
  const { model } = params;

  const endpoint = `${GEMINI_API_BASE}/${model}:streamGenerateContent?alt=sse`;

  logger.debug({ model, messageCount: body.contents.length }, 'Gemini stream request');

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // Handle abort during fetch
    if (err.name === 'AbortError') {
      logger.debug('Gemini stream fetch aborted by client');
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
      logger.debug('Gemini stream aborted by client');
    } else {
      logger.error({ err }, 'Error reading Gemini stream');
      throw err;
    }
  } finally {
    res.end();
  }
}

/**
 * Fetch available models from Google
 * @param {string} apiKey - User's Google API key
 * @returns {Promise<Array>} List of available models
 */
async function listModels(apiKey) {
  const endpoint = GEMINI_API_BASE;

  const response = await fetch(endpoint, {
    method: 'GET',
    headers: buildHeaders(apiKey),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw mapApiError(response, errorData);
  }

  const data = await response.json();

  // Filter to models that support generateContent and transform to consistent format
  const models = (data.models || [])
    .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
    .map(m => ({
      id: m.name.replace('models/', ''),
      name: m.displayName || m.name.replace('models/', ''),
      description: m.description,
      inputTokenLimit: m.inputTokenLimit,
      outputTokenLimit: m.outputTokenLimit,
      supportedGenerationMethods: m.supportedGenerationMethods,
    }));

  return models;
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
