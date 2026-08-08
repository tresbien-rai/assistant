/**
 * The status bar (R-05, moved verbatim from main.js).
 *
 * One line of chrome — the running token count. Its own module because both
 * the chat path and js/chat/expressions.js update it, and it cannot live in
 * dom.js: it needs `formatNumber` from the model layer, which already imports
 * dom.js.
 *
 * U-04: this used to show `chars/4` over message text alone, which omitted the
 * system prompt and the tool definitions — the two largest contributors. A
 * tools-on turn whose user message was "hi" really costs ~2,466 input tokens;
 * the old number showed roughly zero. It now prefers what the provider
 * actually billed (state.usage, from /api/conversations/:id/usage) and falls
 * back to an estimate only where no call has been recorded yet.
 */

import { state } from './state.js';
import { elements } from './dom.js';
import { formatNumber } from './model-layer.js';

/** Total tokens actually billed across every recorded call, both directions. */
export function totalRecordedTokens(usage) {
    if (!usage || !usage.total) return null;
    return usage.total.byModel.reduce(
        (n, m) => n + (m.inputTokens || 0) + (m.outputTokens || 0) + (m.cacheRead || 0) + (m.cacheWrite || 0),
        0
    );
}

/**
 * The tokens this conversation has spent since its last recorded call — the
 * part no provider has counted yet. Kept as `chars/4` because it is genuinely
 * an estimate; the large, stable part of the prompt comes from real usage.
 */
function unrecordedEstimate() {
    return state.estimatedTokens || 0;
}

// Slimmed to tokens only (WR-10): mood is the avatar itself, and the message
// count / session timer never informed a decision.
export function updateStatusBar() {
    if (!elements.statusTokens) return;

    const recorded = totalRecordedTokens(state.usage);
    const partial = Boolean(state.usage?.total?.outputPartial);

    if (recorded === null) {
        // No usage loaded (or a chat never sent): the old estimate is all we
        // have. The tilde is doing real work here — it says "approximate".
        elements.statusTokens.textContent = `~${formatNumber(unrecordedEstimate())}`;
        elements.statusTokens.title = 'Estimated — no provider call recorded for this chat yet.';
        return;
    }

    // A recorded total containing an interrupted round is a FLOOR, not a
    // total: the output count never settled. Marked so it is never read as
    // exact — under-reporting silently is the one thing this must not do.
    elements.statusTokens.textContent = `${partial ? '≥' : ''}${formatNumber(recorded)}`;
    elements.statusTokens.title = partial
        ? 'At least this many tokens — a stopped turn left one count unsettled. Click for the breakdown.'
        : 'Tokens billed for this chat. Click for the breakdown.';
}
