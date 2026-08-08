/**
 * Usage breakdown (U-04, docs/USAGE_MEASUREMENT_DESIGN.md).
 *
 * Answers the question the status bar's single number cannot: WHERE the tokens
 * went. A tools-on turn is up to five provider calls, each re-sending the whole
 * history plus the ~2,000-token tool block, so "that turn was expensive" is
 * only actionable once you can see it was four rounds.
 *
 * TWO RULES the display follows, both from the design doc:
 *
 * 1. NEVER SUM ACROSS MODELS. Tessera reports tokens and never money, so a
 *    figure is only useful if the user can apply their own per-MTok rate to
 *    it. A conversation can switch model mid-way in one click, so a mixed
 *    total is a number nobody can price. Every row is per (provider, model).
 *
 * 2. A FLOOR IS NEVER SHOWN AS A TOTAL. An interrupted round's output count
 *    never settled, so anything containing one is marked `≥`.
 */

import { API } from '../api-client.js';
import { state } from '../state.js';
import { formatNumber } from '../model-layer.js';
import { escapeHtml } from '../util/format.js';
import { showToast } from '../components/toast.js';

// Monotonic request token. Two reads can be in flight (switch away and back,
// or a send finishing after a switch), and the LAST ONE STARTED is the only
// one whose answer is still wanted — arrival order does not imply recency.
let usageRequestSeq = 0;

/**
 * Load real usage for a conversation into state. Best-effort: this is a
 * read-only nicety, and a failure must leave the chat entirely usable.
 *
 * The staleness guard lives HERE, on the assignment, not at the call sites.
 * Guarding only the repaint leaves `state.usage` holding another chat's totals
 * — invisible until any of the several other `updateStatusBar()` callers
 * (every appended message, every expression tag mid-stream) paints it, at
 * which point one conversation's spend is shown as another's.
 *
 * @param {string} conversationId
 * @returns {Promise<boolean>} whether this response was the current one
 */
export async function loadUsage(conversationId) {
    const seq = ++usageRequestSeq;
    if (!conversationId) { state.usage = null; return true; }

    let result = null;
    try {
        result = await API.conversations.usage(conversationId);
    } catch {
        result = null;   // null means "unknown", which the status bar renders as an estimate
    }

    // Superseded while in flight, or the user has moved on: drop it on the
    // floor rather than overwrite fresher data.
    if (seq !== usageRequestSeq) return false;
    if (state.activeConversationId !== conversationId) return false;

    state.usage = result;
    return true;
}

/**
 * Forget the current conversation's usage. Called whenever the active
 * conversation changes, so a new or switched-to chat can never display the
 * previous one's total while its own is still loading (or, for a brand-new
 * chat, forever — nothing would ever load).
 */
export function clearUsage() {
    usageRequestSeq++;   // invalidate anything in flight
    state.usage = null;
}

/** `1,234` / `≥1,234` when a partial round is folded in. */
function count(n, partial) {
    return `${partial ? '≥' : ''}${formatNumber(n || 0)}`;
}

/** One (provider, model) line. Cache columns show only once caching exists. */
function modelRow(m) {
    const cache = (m.cacheRead || m.cacheWrite)
        ? `<span class="usage-cache">cache ${formatNumber(m.cacheRead)} read / ${formatNumber(m.cacheWrite)} written</span>`
        : '';
    const thinking = m.thinkingTokens != null
        ? `<span class="usage-thinking">${formatNumber(m.thinkingTokens)} thinking</span>`
        : '';
    // Escaped because the model id is free text from the add-model modal, not
    // a validated identifier. Exploitability is low — a usage row only exists
    // after a provider call succeeded — but escaping is the house convention,
    // and views/models.js documents a prior review finding this same class of
    // bug on this same seam.
    return `
        <div class="usage-model">
            <div class="usage-model-name">${escapeHtml(m.provider)} · ${escapeHtml(m.model)}</div>
            <div class="usage-model-figures">
                <span>${count(m.inputTokens)} in</span>
                <span>${count(m.outputTokens, m.outputPartial)} out</span>
                ${thinking}
                ${cache}
            </div>
        </div>`;
}

function turnRow(t) {
    const flags = [
        t.rounds > 1 ? `${t.rounds} rounds` : '1 round',
        t.aborted ? '<span class="usage-flag">stopped</span>' : '',
    ].filter(Boolean).join(' · ');
    return `
        <li class="usage-turn">
            <div class="usage-turn-head">
                <span class="usage-turn-n">Turn ${t.turn ?? '—'}</span>
                <span class="usage-turn-meta">${flags}</span>
            </div>
            ${t.byModel.map(modelRow).join('')}
        </li>`;
}

/**
 * Render the breakdown into a dialog. Reads `state.usage`, so the caller
 * refreshes it first if it may be stale.
 */
export function showUsagePanel() {
    // Never stack (the dialogs.js rule): the click handler awaits a network
    // read, so two quick clicks would otherwise append two overlays and only
    // the top one would ever be closed.
    if (document.querySelector('.usage-overlay')) return;

    const usage = state.usage;
    if (!usage || !usage.rounds || usage.rounds.length === 0) {
        // Said rather than shown as zeroes: a chat that predates usage capture
        // is not a chat that cost nothing, and the difference matters to
        // someone reconciling a bill.
        showToast(usage?.note || 'No provider calls recorded for this chat yet.', 'info');
        return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay usage-overlay';
    overlay.innerHTML = `
        <div class="modal-content usage-modal" role="dialog" aria-modal="true" aria-label="Token usage">
            <div class="modal-header">
                <h2>Token usage</h2>
                <button class="modal-close" type="button" aria-label="Close">×</button>
            </div>
            <div class="modal-body">
                <p class="usage-note">
                    Tokens only — apply your provider's per-million rate to price them.
                    Figures are grouped by model because rates differ.
                </p>
                <section class="usage-total">
                    <h3>This chat — ${usage.total.turns} turn${usage.total.turns === 1 ? '' : 's'},
                        ${usage.total.rounds} provider call${usage.total.rounds === 1 ? '' : 's'}</h3>
                    ${usage.total.byModel.map(modelRow).join('')}
                    ${usage.total.outputPartial
                        ? '<p class="usage-floor">≥ marks a figure held down by a stopped turn: those tokens were billed, but the final count never arrived.</p>'
                        : ''}
                </section>
                <section class="usage-turns">
                    <h3>By turn</h3>
                    <ul class="usage-turn-list">${usage.turns.map(turnRow).join('')}</ul>
                </section>
            </div>
        </div>`;

    // Same chrome contract as confirmDialog: remember focus, lock the page
    // behind the overlay, and unbind in the ONE close path. Binding the escape
    // listener so it only unbinds on Escape leaks it on every ×/backdrop close,
    // retaining the detached overlay with it.
    const previouslyFocused = document.activeElement;
    const prevOverflow = document.body.style.overflow;

    const onKeydown = (e) => {
        if (e.key === 'Escape') { close(); return; }
        if (e.key !== 'Tab') return;
        // Trap: without it, tabbing walks the page behind the overlay.
        const focusable = overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };

    function close() {
        document.removeEventListener('keydown', onKeydown);
        document.body.style.overflow = prevOverflow;
        overlay.remove();
        if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    }

    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKeydown);

    document.body.style.overflow = 'hidden';
    document.body.appendChild(overlay);
    // Deferred so the browser paints the element before `visible` transitions
    // it — the modal-chrome rule from docs/CONFIRM_DIALOG_PLAN.md.
    requestAnimationFrame(() => {
        overlay.classList.add('visible');
        overlay.querySelector('.modal-close').focus();
    });
}
