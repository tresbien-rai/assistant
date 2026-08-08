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

/**
 * Total tokens actually billed across every recorded call, both directions,
 * or null when nothing has been recorded.
 *
 * The emptiness test is `byModel.length`, NOT `!usage.total`: summariseUsage
 * always returns a `total` object, so a chat with no rows has a truthy `total`
 * whose byModel is `[]` and whose reduce is 0. Treating that as a real zero
 * showed a hard "0 tokens billed" for every brand-new chat and every chat
 * predating capture — asserted as exact, and suppressing the estimate that
 * used to render there.
 */
export function totalRecordedTokens(usage) {
    if (!usage || !usage.total || !usage.total.byModel || usage.total.byModel.length === 0) return null;
    return usage.total.byModel.reduce(
        (n, m) => n + (m.inputTokens || 0) + (m.outputTokens || 0) + (m.cacheRead || 0) + (m.cacheWrite || 0),
        0
    );
}

/**
 * The old `chars/4` figure, used only while no provider call has been
 * recorded for this chat.
 *
 * Note this is NOT the hybrid the design doc §5 describes (measured prefix +
 * estimated tail). Once any usage exists the recorded total replaces this
 * outright, so during a live turn the counter sits at the pre-turn total and
 * steps up when the read returns. Stated plainly rather than implied: the
 * hybrid is a later refinement, and a docstring claiming one thing while the
 * code does another is worse than the simpler behaviour.
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
    // The tooltip names what the figure combines. A bare "tokens billed" hides
    // that this one number folds input, output and cache across every model
    // used — and rates differ per model and per class, so it cannot be priced
    // as it stands. The breakdown is where a priceable figure lives.
    const models = state.usage.total.byModel.length;
    elements.statusTokens.textContent = `${partial ? '≥' : ''}${formatNumber(recorded)}`;
    elements.statusTokens.title = [
        partial
            ? 'At least this many tokens — a stopped turn left one count unsettled.'
            : 'All tokens billed for this chat: input, output and cache combined',
        models > 1 ? `, across ${models} models` : '',
        '. Click for the per-model breakdown.',
    ].join('');
}
