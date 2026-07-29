/**
 * The status bar (R-05, moved verbatim from main.js).
 *
 * One line of chrome — the running token estimate. Its own module because both
 * the chat path and js/chat/expressions.js update it, and it cannot live in
 * dom.js: it needs `formatNumber` from the model layer, which already imports
 * dom.js.
 */

import { state } from './state.js';
import { elements } from './dom.js';
import { formatNumber } from './model-layer.js';

// Slimmed to tokens only (WR-10): mood is the avatar itself, and the message
// count / session timer never informed a decision.
export function updateStatusBar() {
    elements.statusTokens.textContent = `~${formatNumber(state.estimatedTokens)}`;
}
