/**
 * Inline chat errors and the error dispatcher (R-03, moved verbatim from
 * main.js).
 *
 * `displayError()` is the single entry point: hand it any thrown error plus a
 * context hint and it routes to the right surface by ApiError code — a toast, a
 * critical banner, or an inline error turn in the thread via
 * `appendErrorMessage()`.
 */

import { elements, scrollToBottom } from '../dom.js';
import { state } from '../state.js';
import { showToast, showCriticalBanner } from './toast.js';

// `appendErrorMessage` is deliberately not exported: `displayError` is the only
// way in. The chat thread gains a legitimate reason to render one directly in
// R-05, and that is when it should become public.
function appendErrorMessage(error, opts = {}) {
    const isApiError = error && error.name === 'ApiError';
    const code = isApiError ? error.code : null;
    const message = (typeof error === 'string')
        ? error
        : (error && error.message) || 'An unexpected error occurred.';

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message error';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    // Headline with optional code badge.
    const headline = document.createElement('div');
    headline.className = 'error-headline';
    const headlineText = document.createElement('span');
    headlineText.textContent = 'Something went wrong';
    headline.appendChild(headlineText);
    if (code) {
        const badge = document.createElement('span');
        badge.className = 'error-code-badge';
        badge.textContent = code;
        headline.appendChild(badge);
    }
    contentDiv.appendChild(headline);

    // Human-readable message.
    const detail = document.createElement('p');
    detail.className = 'error-detail-text';
    detail.textContent = message;
    contentDiv.appendChild(detail);

    // Collapsible technical details (status + any structured details).
    if (isApiError && (error.status || error.details)) {
        const details = document.createElement('details');
        details.className = 'error-details';
        const summary = document.createElement('summary');
        summary.textContent = 'Technical details';
        details.appendChild(summary);
        const pre = document.createElement('pre');
        const techLines = [];
        if (error.status) techLines.push(`HTTP ${error.status}`);
        if (error.details) {
            try {
                techLines.push(typeof error.details === 'string'
                    ? error.details
                    : JSON.stringify(error.details, null, 2));
            } catch (_) { /* ignore serialization issues */ }
        }
        pre.textContent = techLines.join('\n');
        details.appendChild(pre);
        contentDiv.appendChild(details);
    }

    // Optional retry button.
    if (typeof opts.retryHandler === 'function') {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'error-retry-btn';
        retryBtn.type = 'button';
        retryBtn.textContent = 'Retry';
        // Not {once:true}: if a send is still in flight we keep the button (and
        // the error bubble) so the user can retry once it settles. Only remove
        // the bubble when we actually hand off to the retry handler — otherwise
        // a no-op retry (isLoading) would destroy the error + retry affordance.
        retryBtn.addEventListener('click', () => {
            if (state.isLoading) {
                showToast('Please wait for the current response to finish, then retry.', { type: 'warning' });
                return;
            }
            messageDiv.remove();
            opts.retryHandler();
        });
        contentDiv.appendChild(retryBtn);
    }

    messageDiv.appendChild(contentDiv);
    elements.messagesContainer.appendChild(messageDiv);
    scrollToBottom();
    return messageDiv;
}

/**
 * Central error dispatcher. Routes any caught error to the appropriate
 * presentation surface based on its ApiError code.
 * @param {Error} error - The caught error (ideally an ApiError).
 * @param {Object} [context]
 * @param {'chat'|'background'} [context.surface='background'] - Where the
 *        error originated. 'chat' allows inline rendering for provider errors.
 * @param {Function} [context.retryHandler] - Retry callback for chat errors.
 * @param {string} [context.action] - Short verb describing the failed action,
 *        e.g. "save settings", used to make toast text specific.
 */
export function displayError(error, context = {}) {
    // Swallow user-initiated aborts entirely — not an error to surface.
    if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERROR')) {
        return;
    }

    const surface = context.surface || 'background';
    const code = (error && error.name === 'ApiError') ? error.code : 'UNKNOWN_ERROR';
    const baseMsg = (error && error.message) || 'An unexpected error occurred.';
    const actionPrefix = context.action ? `Couldn't ${context.action}: ` : '';
    // retryAfter may legitimately be 0 (retry immediately); only fall back to
    // 60 when it's actually absent.
    const retrySecs = (error && typeof error.retryAfter === 'number') ? error.retryAfter : 60;

    // 401s are handled globally (the on401 handler reloads to the login
    // screen). Rendering a chat bubble that the imminent reload discards is
    // pointless, so AUTH_ERROR always takes the toast fallback regardless of
    // surface.
    if (code === 'AUTH_ERROR') {
        showToast('Your session has expired. Please sign in again.', {
            type: 'warning', key: 'auth-expired',
        });
        return;
    }

    // Chat-turn failures get a DURABLE inline error in the thread (with Retry),
    // whatever the code. The user's message is sitting there awaiting a reply,
    // so an auto-dismissing toast would lose that context once it fades. For
    // rate limits we additionally toast the wait time.
    if (surface === 'chat') {
        appendErrorMessage(error, { retryHandler: context.retryHandler });
        if (code === 'RATE_LIMITED') {
            showToast(`Rate limit reached. Try again in ${retrySecs}s.`, {
                type: 'warning', key: 'rate-limited',
            });
        }
        return;
    }

    // Background (non-chat) failures route by code to the right surface.
    switch (code) {
        case 'RATE_LIMITED':
            showToast(`Rate limit reached. Try again in ${retrySecs}s.`, {
                type: 'warning', key: 'rate-limited',
            });
            return;

        case 'VALIDATION_ERROR':
            showToast(`${actionPrefix}${baseMsg}`, { type: 'warning' });
            return;

        case 'DRIVE_ERROR':
            // Drive integration is Phase 1; banner path is dormant but wired.
            showCriticalBanner(`Google Drive error: ${baseMsg}`);
            return;

        case 'PROVIDER_ERROR':
        case 'NOT_FOUND':
        case 'SERVER_ERROR':
        case 'NETWORK_ERROR':
        default:
            showToast(`${actionPrefix}${baseMsg}`, { type: 'error' });
            return;
    }
}

