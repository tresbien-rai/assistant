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
import { showToast } from '../components/toast.js';

/**
 * Load real usage for a conversation into state. Best-effort: this is a
 * read-only nicety, and a failure must leave the chat entirely usable.
 * @param {string} conversationId
 */
export async function loadUsage(conversationId) {
    if (!conversationId) { state.usage = null; return; }
    try {
        state.usage = await API.conversations.usage(conversationId);
    } catch {
        state.usage = null;   // null means "unknown", which the status bar renders as an estimate
    }
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
    return `
        <div class="usage-model">
            <div class="usage-model-name">${m.provider} · ${m.model}</div>
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

    const close = () => overlay.remove();
    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });

    document.body.appendChild(overlay);
    // Deferred so the browser paints the element before `visible` transitions
    // it — the modal-chrome rule from docs/CONFIRM_DIALOG_PLAN.md.
    requestAnimationFrame(() => overlay.classList.add('visible'));
}
