/**
 * Toasts and the critical banner (R-02, moved verbatim from main.js).
 *
 * The two error surfaces that are app chrome rather than chat content. The
 * other two members of the old "Error Display System" section —
 * `appendErrorMessage()` (inline chat errors) and `displayError()` (the
 * dispatcher) — stay in main.js: they write into the message thread and belong
 * with chat/ in R-05.
 */

import { elements } from '../dom.js';

// ===== Error Display System (P0-17): the two chrome-level surfaces =====
//
// Three presentation surfaces, chosen by severity/context:
//   - showToast()          : transient notifications (bottom-right, auto-dismiss)
//   - appendErrorMessage() : inline chat errors (tied to a conversation turn)
//   - showCriticalBanner() : persistent top banner for errors needing action
//
// displayError() is the central dispatcher: hand it any thrown error and a
// context hint, and it routes to the right surface based on the ApiError code.

// --- Toast manager ---
const TOAST_MAX = 3;
const TOAST_DEFAULT_MS = 5000;
const TOAST_DEDUPE_MS = 2000;
const _toastIcons = { error: '⛔', warning: '⚠️', success: '✓', info: 'ℹ️' };
// Tracks recently-shown toast keys to suppress duplicate spam.
const _recentToasts = new Map(); // key -> timestamp

/**
 * Show a transient toast notification.
 * @param {string} message - Text to display.
 * @param {Object} [opts]
 * @param {'error'|'warning'|'success'|'info'} [opts.type='info']
 * @param {number} [opts.duration] - ms before auto-dismiss; 0 = sticky. Defaults by type.
 * @param {string} [opts.key] - Dedupe key; defaults to type+message.
 * @returns {HTMLElement|null} The toast element (or null if deduped/suppressed).
 */
export function showToast(message, opts = {}) {
    const container = elements.toastContainer;
    if (!container) return null;

    const type = opts.type || 'info';
    const key = opts.key || `${type}:${message}`;
    const now = Date.now();

    // Prune dedupe entries older than the window so the Map can't grow
    // unbounded over a long session with many distinct messages.
    for (const [k, t] of _recentToasts) {
        if (now - t >= TOAST_DEDUPE_MS) _recentToasts.delete(k);
    }

    // Dedupe: skip if an identical toast fired within the dedupe window.
    const last = _recentToasts.get(key);
    if (last && now - last < TOAST_DEDUPE_MS) return null;
    _recentToasts.set(key, now);

    // Cap stacked toasts: drop the oldest *non-hiding* toast when over the
    // limit. Toasts mid-dismiss (class toast-hiding) linger ~300ms during the
    // fade; counting them would let the cap evict a fully-visible newer toast.
    let live = Array.from(container.children).filter(c => !c.classList.contains('toast-hiding'));
    while (live.length >= TOAST_MAX) {
        const oldest = live.shift();
        if (oldest) oldest.remove();
    }

    const duration = opts.duration !== undefined
        ? opts.duration
        : (type === 'error' ? 8000 : TOAST_DEFAULT_MS);

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = _toastIcons[type] || _toastIcons.info;

    const body = document.createElement('div');
    body.className = 'toast-body';
    const msg = document.createElement('div');
    msg.className = 'toast-message';
    msg.textContent = message;
    body.appendChild(msg);

    const dismiss = document.createElement('button');
    dismiss.className = 'toast-dismiss';
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Dismiss notification');
    dismiss.textContent = '×';

    let timer = null;
    const remove = () => {
        if (timer) clearTimeout(timer);
        if (!toast.parentNode) return;
        toast.classList.add('toast-hiding');
        toast.addEventListener('animationend', () => toast.remove(), { once: true });
        // Fallback in case animationend doesn't fire.
        setTimeout(() => { if (toast.parentNode) toast.remove(); }, 300);
    };
    dismiss.addEventListener('click', remove);

    toast.appendChild(icon);
    toast.appendChild(body);
    toast.appendChild(dismiss);
    container.appendChild(toast);

    if (duration > 0) {
        timer = setTimeout(remove, duration);
    }

    return toast;
}

/**
 * Show the persistent critical banner at the top of the page.
 * @param {string} message
 * @param {Object} [opts]
 * @param {string} [opts.actionLabel] - If set, shows an action button.
 * @param {Function} [opts.onAction] - Click handler for the action button.
 */
export function showCriticalBanner(message, opts = {}) {
    const banner = elements.criticalBanner;
    // Guard the inner nodes too — a partial HTML edit shouldn't turn an error
    // display into an uncaught TypeError.
    if (!banner || !elements.criticalBannerMessage) return;

    elements.criticalBannerMessage.textContent = message;

    const actionBtn = elements.criticalBannerAction;
    if (actionBtn && opts.actionLabel && typeof opts.onAction === 'function') {
        actionBtn.textContent = opts.actionLabel;
        actionBtn.hidden = false;
        // Replace handler by cloning to drop any prior listeners.
        const fresh = actionBtn.cloneNode(true);
        fresh.addEventListener('click', opts.onAction);
        actionBtn.parentNode.replaceChild(fresh, actionBtn);
        elements.criticalBannerAction = fresh;
    } else if (actionBtn) {
        actionBtn.hidden = true;
    }

    banner.hidden = false;
}

export function hideCriticalBanner() {
    if (elements.criticalBanner) elements.criticalBanner.hidden = true;
}

/**
 * Render an inline error message inside the chat thread.
 * @param {Error|string} error - An ApiError, generic Error, or plain string.
 * @param {Object} [opts]
 * @param {Function} [opts.retryHandler] - If set, renders a Retry button.
 */
