/**
 * API Client
 *
 * Frontend wrapper for all backend API calls. Exposes a single `window.API`
 * object that subsequent frontend tasks (P0-14 onward) will use to replace
 * direct localStorage / IndexedDB / external provider calls.
 *
 * Authentication is handled via an httpOnly `token` cookie set by the
 * backend after Google OAuth. Browsers attach the cookie automatically
 * when fetch is called with `credentials: 'include'`. The frontend never
 * sees or stores the JWT directly — this is more secure than a JS-readable
 * token because it cannot be exfiltrated via XSS.
 *
 * Errors thrown by this module have shape:
 *   { name: 'ApiError', status, code, message, details? }
 * where `code` matches the backend AppError codes (AUTH_ERROR,
 * PROVIDER_ERROR, VALIDATION_ERROR, NOT_FOUND, RATE_LIMITED, SERVER_ERROR).
 */
(function () {
  'use strict';

  // ===========================================================================
  // INTERNAL STATE
  // ===========================================================================

  // Tracks the in-flight streaming request so it can be aborted.
  let currentStreamController = null;

  // Optional caller-supplied handler invoked when any request returns 401.
  // Subsequent frontend tasks will wire this to a "show login screen" action.
  let on401Handler = null;

  // ===========================================================================
  // ERROR HANDLING
  // ===========================================================================

  /**
   * Build a structured Error from a failed HTTP response.
   * @param {number} status - HTTP status code
   * @param {Object} errorObj - Parsed error body (the `error` field)
   * @returns {Error}
   */
  function createApiError(status, errorObj) {
    const safe = errorObj || {};
    const err = new Error(safe.message || `Request failed with status ${status}`);
    err.name = 'ApiError';
    err.status = status;
    err.code = safe.code || 'UNKNOWN_ERROR';
    if (safe.details !== undefined) err.details = safe.details;
    if (safe.retryAfter !== undefined) err.retryAfter = safe.retryAfter;
    return err;
  }

  /**
   * Build a network-level error (e.g., fetch threw, no JSON body, etc.).
   * @param {string} message
   * @param {Error} [cause]
   */
  function createNetworkError(message, cause) {
    const err = new Error(message);
    err.name = 'ApiError';
    err.status = 0;
    err.code = 'NETWORK_ERROR';
    if (cause) err.cause = cause;
    return err;
  }

  // ===========================================================================
  // CORE REQUEST HELPER
  // ===========================================================================

  /**
   * Make an authenticated JSON request.
   * Returns parsed JSON, or null for 204 No Content.
   *
   * @param {string} method - HTTP method
   * @param {string} path - URL path (e.g., '/api/personas')
   * @param {Object} [options]
   * @param {*} [options.body] - JSON-serializable body or FormData
   * @param {Object} [options.headers]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<*>}
   */
  async function request(method, path, options) {
    const opts = options || {};
    const headers = Object.assign({}, opts.headers || {});

    const fetchOpts = {
      method,
      credentials: 'include',
      headers,
    };

    if (opts.signal) fetchOpts.signal = opts.signal;

    if (opts.body !== undefined && opts.body !== null) {
      if (opts.body instanceof FormData) {
        // Let the browser set Content-Type with boundary.
        fetchOpts.body = opts.body;
      } else {
        headers['Content-Type'] = 'application/json';
        fetchOpts.body = JSON.stringify(opts.body);
      }
    }

    let response;
    try {
      response = await fetch(path, fetchOpts);
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      throw createNetworkError('Network request failed', err);
    }

    if (response.status === 204) return null;

    if (!response.ok) {
      let errorBody = null;
      try {
        errorBody = await response.json();
      } catch {
        // Body wasn't JSON; fall through.
      }
      const apiError = createApiError(response.status, errorBody && errorBody.error);

      if (response.status === 401 && typeof on401Handler === 'function') {
        try {
          on401Handler(apiError);
        } catch {
          // Don't let the handler swallow the original error.
        }
      }

      throw apiError;
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return response.json();
    }
    // For non-JSON success responses (rare), return the Response itself.
    return response;
  }

  // ===========================================================================
  // SSE PARSER (for chat streaming)
  // ===========================================================================

  /**
   * Parse a single SSE event block (the text between two blank lines).
   * Per the spec: lines starting with `:` are comments; other lines are
   * `field: value`. Multiple `data:` lines are joined with newlines.
   *
   * @param {string} eventText
   * @returns {{event?: string, data?: string, id?: string, retry?: number}|null}
   */
  function parseSseEvent(eventText) {
    const event = {};
    const dataLines = [];
    const lines = eventText.split('\n');

    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line === '' || line.startsWith(':')) continue;

      const colonIdx = line.indexOf(':');
      const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
      let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'data') {
        dataLines.push(value);
      } else if (field === 'event') {
        event.event = value;
      } else if (field === 'id') {
        event.id = value;
      } else if (field === 'retry') {
        const n = Number(value);
        if (!Number.isNaN(n)) event.retry = n;
      }
    }

    if (dataLines.length === 0 && !event.event) return null;
    if (dataLines.length > 0) event.data = dataLines.join('\n');
    return event;
  }

  /**
   * Stream Server-Sent Events from a Response body, invoking onEvent for
   * each parsed event. Resolves when the stream ends; rejects on errors
   * other than abort.
   *
   * @param {Response} response
   * @param {(event: Object) => void} onEvent
   */
  async function consumeSseStream(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE events are delimited by a blank line. Normalize CRLF first.
        const normalized = buffer.replace(/\r\n/g, '\n');
        const parts = normalized.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          if (!part.trim()) continue;
          const event = parseSseEvent(part);
          if (event) onEvent(event);
        }
      }

      // Flush any trailing event without a terminating blank line.
      buffer += decoder.decode();
      if (buffer.trim()) {
        const event = parseSseEvent(buffer.replace(/\r\n/g, '\n'));
        if (event) onEvent(event);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* noop */ }
    }
  }

  // ===========================================================================
  // QUERY STRING HELPER
  // ===========================================================================

  function buildQuery(params) {
    if (!params) return '';
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      usp.set(k, String(v));
    }
    const s = usp.toString();
    return s ? `?${s}` : '';
  }

  // ===========================================================================
  // API SURFACE
  // ===========================================================================

  const API = {
    /**
     * Register a callback invoked when any request returns 401.
     * Used by P0-14 to redirect to the login screen.
     * @param {(error: Error) => void} handler
     */
    setOn401Handler(handler) {
      on401Handler = handler;
    },

    // -------------------------------------------------------------------------
    // AUTH
    // -------------------------------------------------------------------------
    auth: {
      /** URL that initiates the Google OAuth flow. Caller navigates to it. */
      getGoogleLoginUrl() {
        return '/api/auth/google';
      },

      /** Quick auth check without throwing for unauthenticated users. */
      status() {
        return request('GET', '/api/auth/status');
      },

      /** Get current user info. Throws AUTH_ERROR if not logged in. */
      me() {
        return request('GET', '/api/auth/me');
      },

      /** Clear the auth cookie on the server. */
      logout() {
        return request('POST', '/api/auth/logout');
      },

      /** Public auth capabilities (e.g. whether dev-login is available). */
      config() {
        return request('GET', '/api/auth/config');
      },

      /** DEV-ONLY: sign in as a local stub user. 404s unless the server has
       *  ALLOW_DEV_LOGIN enabled in development. */
      devLogin() {
        return request('POST', '/api/auth/dev-login');
      },
    },

    // -------------------------------------------------------------------------
    // PERSONAS
    // -------------------------------------------------------------------------
    personas: {
      list() {
        return request('GET', '/api/personas');
      },
      get(id) {
        return request('GET', `/api/personas/${encodeURIComponent(id)}`);
      },
      create(data) {
        return request('POST', '/api/personas', { body: data });
      },
      update(id, data) {
        return request('PUT', `/api/personas/${encodeURIComponent(id)}`, { body: data });
      },
      delete(id) {
        return request('DELETE', `/api/personas/${encodeURIComponent(id)}`);
      },
    },

    // -------------------------------------------------------------------------
    // CONVERSATIONS
    // -------------------------------------------------------------------------
    conversations: {
      list(filter) {
        // filter = { personaId?, limit?, offset? }
        return request('GET', `/api/conversations${buildQuery(filter)}`);
      },
      /** Returns the conversation with its full message history. */
      get(id) {
        return request('GET', `/api/conversations/${encodeURIComponent(id)}`);
      },
      create(data) {
        return request('POST', '/api/conversations', { body: data });
      },
      update(id, data) {
        return request('PUT', `/api/conversations/${encodeURIComponent(id)}`, { body: data });
      },
      delete(id) {
        return request('DELETE', `/api/conversations/${encodeURIComponent(id)}`);
      },
    },

    // -------------------------------------------------------------------------
    // FILES (Track A: tool-created files in the user's Drive Downloads folder)
    // -------------------------------------------------------------------------
    files: {
      /** Returns [{ id, filename, mimeType, sizeBytes, createdAt }]. */
      list() {
        return request('GET', '/api/files');
      },
      /** Same-origin download URL (cookie-authed <a href download>). */
      contentUrl(id) {
        return `/api/files/${encodeURIComponent(id)}/content`;
      },
      /**
       * Fetch a content URL's body as text (for the in-app file panel).
       * Accepts any of the three content-endpoint URLs (user/workspace/project
       * files) so callers can pass the URL already carried on an attachment.
       * Goes through request() for session-expiry (401) and network-error
       * handling.
       */
      async fetchText(contentUrl) {
        const res = await request('GET', contentUrl);
        return res.text();
      },
      /**
       * Save user-edited text over a file (the file panel's Save button).
       * Takes the same content URL as fetchText — PUT on it replaces the
       * file's content. Returns the updated file metadata.
       */
      saveText(contentUrl, content) {
        return request('PUT', contentUrl, { body: { content } });
      },
    },

    // -------------------------------------------------------------------------
    // PROJECTS
    // -------------------------------------------------------------------------
    // -------------------------------------------------------------------------
    // WORKSPACES (outer container: shared instructions + nested projects)
    // -------------------------------------------------------------------------
    workspaces: {
      /** Returns [{ id, name, instructions, projectCount, createdAt, updatedAt }]. */
      list() {
        return request('GET', '/api/workspaces');
      },
      get(id) {
        return request('GET', `/api/workspaces/${encodeURIComponent(id)}`);
      },
      /** data = { name, instructions? }. Best-effort creates the Drive folder. */
      create(data) {
        return request('POST', '/api/workspaces', { body: data });
      },
      /** data = { name?, instructions? }. */
      update(id, data) {
        return request('PUT', `/api/workspaces/${encodeURIComponent(id)}`, { body: data });
      },
      /** Deletes the workspace; its chats survive as unfiled, its projects are removed. */
      delete(id) {
        return request('DELETE', `/api/workspaces/${encodeURIComponent(id)}`);
      },
      /** Projects nested under this workspace: [{ id, workspaceId, name, fileCount, ... }]. */
      projects(id) {
        return request('GET', `/api/workspaces/${encodeURIComponent(id)}/projects`);
      },

      // Workspace reference files (stored on the user's Google Drive).
      files: {
        /** Returns [{ id, workspaceId, filename, mimeType, sizeBytes, createdAt }]. */
        list(workspaceId) {
          return request('GET', `/api/workspaces/${encodeURIComponent(workspaceId)}/files`);
        },
        /** Uploads a single file (multipart). @param {File|Blob} file */
        upload(workspaceId, file) {
          const fd = new FormData();
          fd.append('file', file);
          return request('POST', `/api/workspaces/${encodeURIComponent(workspaceId)}/files`, {
            body: fd,
          });
        },
        delete(workspaceId, fileId) {
          return request(
            'DELETE',
            `/api/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(fileId)}`
          );
        },
        /** URL for downloading a file's content (auth via cookie; use in <a download>). */
        contentUrl(workspaceId, fileId) {
          return `/api/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(fileId)}/content`;
        },
      },
    },

    projects: {
      /** Returns [{ id, workspaceId, name, instructions, fileCount, createdAt, updatedAt }]. */
      list() {
        return request('GET', '/api/projects');
      },
      get(id) {
        return request('GET', `/api/projects/${encodeURIComponent(id)}`);
      },
      /**
       * data = { name, instructions?, workspaceId? }. Creates the backing Drive
       * folder under the workspace. Omitting workspaceId lands the project in the
       * user's default "General" workspace.
       */
      create(data) {
        return request('POST', '/api/projects', { body: data });
      },
      /** data = { name?, instructions? }. */
      update(id, data) {
        return request('PUT', `/api/projects/${encodeURIComponent(id)}`, { body: data });
      },
      delete(id) {
        return request('DELETE', `/api/projects/${encodeURIComponent(id)}`);
      },

      // Project files (stored on the user's Google Drive).
      files: {
        /** Returns [{ id, projectId, filename, mimeType, sizeBytes, createdAt }]. */
        list(projectId) {
          return request('GET', `/api/projects/${encodeURIComponent(projectId)}/files`);
        },
        /** Uploads a single file (multipart). @param {File|Blob} file */
        upload(projectId, file) {
          const fd = new FormData();
          fd.append('file', file);
          return request('POST', `/api/projects/${encodeURIComponent(projectId)}/files`, {
            body: fd,
          });
        },
        delete(projectId, fileId) {
          return request(
            'DELETE',
            `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`
          );
        },
        /** URL for downloading a file's content (auth via cookie; use in <a download>). */
        contentUrl(projectId, fileId) {
          return `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/content`;
        },
      },
    },

    // -------------------------------------------------------------------------
    // MESSAGES
    // -------------------------------------------------------------------------
    messages: {
      create(conversationId, data) {
        return request(
          'POST',
          `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
          { body: data }
        );
      },
      update(conversationId, messageId, data) {
        return request(
          'PUT',
          `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
          { body: data }
        );
      },
      delete(conversationId, messageId) {
        return request(
          'DELETE',
          `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`
        );
      },
    },

    // -------------------------------------------------------------------------
    // SETTINGS
    // -------------------------------------------------------------------------
    settings: {
      get() {
        return request('GET', '/api/settings');
      },
      update(data) {
        return request('PUT', '/api/settings', { body: data });
      },
    },

    // -------------------------------------------------------------------------
    // API KEYS
    // -------------------------------------------------------------------------
    apiKeys: {
      /** Returns [{ provider, hasKey, updatedAt }]. Never includes key values. */
      list() {
        return request('GET', '/api/api-keys');
      },
      set(provider, key) {
        return request('PUT', `/api/api-keys/${encodeURIComponent(provider)}`, {
          body: { key },
        });
      },
      delete(provider) {
        return request('DELETE', `/api/api-keys/${encodeURIComponent(provider)}`);
      },
    },

    // -------------------------------------------------------------------------
    // CHAT
    // -------------------------------------------------------------------------
    chat: {
      /**
       * Non-streaming chat. Returns { text, model, usage?, stopReason? }.
       * @param {Object} params - { provider, model, messages, systemPrompt?,
       *                            modelParams?, prefill?, attachments? }
       */
      send(params) {
        return request('POST', '/api/chat', { body: params });
      },

      /**
       * Request inspector (P2-U4): returns the exact provider request body that
       * WOULD be sent (incl. assembled workspace context), without calling the
       * provider. Returns { provider, model, body, apiKeyLocation, contextWarning? }.
       * @param {Object} params - Same shape as send()
       */
      preview(params) {
        return request('POST', '/api/chat/preview', { body: params });
      },

      /**
       * Streaming chat. Invokes onEvent for each parsed SSE event with shape
       * { event?, data?, id?, retry? }. The data field is the raw string —
       * callers parse it as JSON if appropriate (provider-specific format).
       *
       * Only one stream may be in flight at a time. Starting a new one aborts
       * any existing one.
       *
       * @param {Object} params - Same as send()
       * @param {(event: Object) => void} onEvent
       * @returns {Promise<void>} Resolves when stream completes.
       */
      async stream(params, onEvent) {
        if (typeof onEvent !== 'function') {
          throw new TypeError('API.chat.stream requires an onEvent callback');
        }

        // Abort any existing stream first.
        if (currentStreamController) {
          try { currentStreamController.abort(); } catch { /* noop */ }
        }

        const controller = new AbortController();
        currentStreamController = controller;

        let response;
        try {
          response = await fetch('/api/chat/stream', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params),
            signal: controller.signal,
          });
        } catch (err) {
          currentStreamController = null;
          if (err && err.name === 'AbortError') throw err;
          throw createNetworkError('Stream request failed', err);
        }

        if (!response.ok) {
          currentStreamController = null;
          let errorBody = null;
          try { errorBody = await response.json(); } catch { /* noop */ }
          const apiError = createApiError(response.status, errorBody && errorBody.error);
          if (response.status === 401 && typeof on401Handler === 'function') {
            try { on401Handler(apiError); } catch { /* noop */ }
          }
          throw apiError;
        }

        // Surface the project-context budget/Drive warning (sent as a header on
        // the streaming response) as a synthetic event before the stream body.
        const ctxWarning = response.headers.get('X-Project-Context-Warning');
        if (ctxWarning) {
          try { onEvent({ event: 'project-context-warning', warning: decodeURIComponent(ctxWarning) }); } catch { /* noop */ }
        }

        try {
          await consumeSseStream(response, onEvent);
        } catch (err) {
          if (err && err.name === 'AbortError') {
            // Caller (or a newer stream) aborted us — silent.
            return;
          }
          throw err;
        } finally {
          if (currentStreamController === controller) {
            currentStreamController = null;
          }
        }
      },

      /** Abort the in-flight stream, if any. */
      abort() {
        if (currentStreamController) {
          try { currentStreamController.abort(); } catch { /* noop */ }
          currentStreamController = null;
        }
      },
    },

    // -------------------------------------------------------------------------
    // MODELS
    // -------------------------------------------------------------------------
    models: {
      /** Fetch the model list from the provider (uses the user's stored key). */
      list(provider) {
        return request('GET', `/api/models/${encodeURIComponent(provider)}`);
      },
    },

    // -------------------------------------------------------------------------
    // AVATARS
    // -------------------------------------------------------------------------
    avatars: {
      /**
       * Upload a persona's main avatar.
       * @param {string} personaId
       * @param {File|Blob} file
       * @returns {Promise<{avatarUrl: string}>}
       */
      upload(personaId, file) {
        const fd = new FormData();
        fd.append('avatar', file);
        return request('POST', `/api/personas/${encodeURIComponent(personaId)}/avatar`, {
          body: fd,
        });
      },

      delete(personaId) {
        return request('DELETE', `/api/personas/${encodeURIComponent(personaId)}/avatar`);
      },

      /** Returns a URL the browser can load via <img src>. */
      getUrl(personaId) {
        return `/api/avatars/${encodeURIComponent(personaId)}/avatar`;
      },

      /**
       * Upload an expression image for a persona.
       * @param {string} personaId
       * @param {string} expressionName
       * @param {File|Blob} file
       */
      uploadExpression(personaId, expressionName, file) {
        const fd = new FormData();
        fd.append('image', file);
        return request(
          'POST',
          `/api/personas/${encodeURIComponent(personaId)}/expressions/${encodeURIComponent(expressionName)}/image`,
          { body: fd }
        );
      },

      deleteExpression(personaId, expressionName) {
        return request(
          'DELETE',
          `/api/personas/${encodeURIComponent(personaId)}/expressions/${encodeURIComponent(expressionName)}/image`
        );
      },

      getExpressionUrl(personaId, expressionName) {
        return `/api/avatars/${encodeURIComponent(personaId)}/expressions/${encodeURIComponent(expressionName)}`;
      },
    },
  };

  // Expose globally for the non-module frontend.
  if (typeof window !== 'undefined') {
    window.API = API;
  }
  // Also export for module-aware environments (e.g., future bundling, tests).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API;
  }
})();
