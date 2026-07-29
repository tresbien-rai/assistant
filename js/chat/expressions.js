/**
 * The expression protocol (R-05, moved verbatim from main.js).
 *
 * A reply may declare its expression with a leading `[expression: name]` tag.
 * This module owns that contract end to end: detecting the tag, stripping it
 * before display, the partial-tag handling the streaming path needs so a tag
 * split across chunks is never shown to the user, and settling the reserved
 * `generating` state back to a real pose when the turn ends.
 *
 * Expressions are declared by the model, never inferred from the text — the
 * keyword-matching fallback was removed deliberately.
 */

import { state } from '../state.js';
import { CONFIG } from '../config.js';
import { getActivePersona } from '../state.js';
import { updateFloatingAvatar } from '../avatar.js';
import { updateStatusBar } from '../status-bar.js';

// ===== Expression Detection =====
/**
 * Resolve the expression a response declares.
 *
 * Declaration is the ONLY signal. The old keyword fallback was removed: it
 * matched substrings anywhere in the reply, so 'sorry', 'unfortunately' and
 * 'difficult' pushed the avatar to `sad` constantly during ordinary work talk,
 * and which expression won depended on insertion order in the expression map.
 * A missed tag now just holds the current expression — stale beats wrong.
 *
 * @param {string} text - The full response text
 * @returns {string} The expression name to display
 */
export function detectExpression(text) {
    const persona = getActivePersona();
    const expressions = persona ? persona.expressions : CONFIG.defaultExpressions;

    // The generating slot is the UI's own state, so a model that declares it
    // is ignored.
    const tagMatch = text.match(/\[expression:\s*([\w -]+)\]/i);
    if (tagMatch) {
        const exprName = tagMatch[1].trim().toLowerCase();
        if (expressions[exprName] && exprName !== CONFIG.generatingExpression) {
            return exprName;
        }
    }

    // Nothing declared: hold the current expression, except settle the
    // transient generating state back to neutral.
    return state.currentExpression === CONFIG.generatingExpression ? 'neutral' : state.currentExpression;
}

/**
 * Drop the avatar out of the `generating` state after a failed or abandoned
 * request. Without this the pulse runs forever: nothing else clears it, since
 * the settled expression is normally applied when a response finalizes.
 * No-op if the avatar has already moved on.
 */
export function settleGeneratingExpression() {
    if (state.currentExpression === CONFIG.generatingExpression) {
        setExpression('neutral');
    }
}

export function stripExpressionTag(text) {
    return text.replace(/\[expression:\s*\w+\]\s*/gi, '').trim();
}

/**
 * Strip prefill text from the start of a response
 * @param {string} text - The full response text
 * @param {string} prefill - The prefill text to strip
 * @returns {string} Text with prefill removed
 */
export function stripPrefillText(text, prefill) {
    if (!prefill || !text) return text;
    const trimmedPrefill = prefill.trim();
    const trimmedText = text.trimStart();
    if (trimmedText.startsWith(trimmedPrefill)) {
        return trimmedText.slice(trimmedPrefill.length).trimStart();
    }
    return text;
}

export async function setExpression(exprName) {
    const persona = getActivePersona();
    const expressions = persona ? persona.expressions : CONFIG.defaultExpressions;

    if (expressions[exprName]) {
        state.currentExpression = exprName;
        await updateFloatingAvatar();
        updateStatusBar();
    }
}

// A leading "[expression: name]" is a control token, not content: it must set
// the avatar and then never reach the screen. Since chunks arrive split at
// arbitrary boundaries, the opening of a stream can be an INCOMPLETE tag
// ("[expr"), so we withhold display until we know whether it will close into
// one. This matches the tag against a growing prefix of the expected shape.
export const TAG_OPEN = '[expression:';

export const LEADING_EXPRESSION_TAG = /^\[expression:\s*([\w -]+)\]\s*/i;

// Stop waiting if an unclosed tag runs longer than any real name would — a
// malformed opener must never buffer the whole response.
export const MAX_TAG_NAME_LENGTH = 40;

/**
 * Could `text` still grow into a complete leading expression tag?
 * Two phases: still typing out "[expression:" itself, or past the opener and
 * accumulating a plausible name that hasn't closed yet.
 * @param {string} text
 * @returns {boolean}
 */
export function isPartialExpressionTag(text) {
    const lower = text.toLowerCase();
    if (lower.length < TAG_OPEN.length) return TAG_OPEN.startsWith(lower);
    if (!lower.startsWith(TAG_OPEN)) return false;
    const name = text.slice(TAG_OPEN.length);
    // A ']' here means the full-tag regex already declined it — malformed.
    return !name.includes(']') && name.length <= MAX_TAG_NAME_LENGTH && /^[\w -]*$/.test(name);
}

/**
 * Decide what of the stream so far is safe to render.
 * @param {string} text - Accumulated text (prefill already stripped)
 * @returns {{ display: string, expression: string|null, pending: boolean }}
 *   `pending` means "still might become a tag — render nothing yet".
 */
export function splitLeadingExpressionTag(text) {
    const done = text.match(LEADING_EXPRESSION_TAG);
    if (done) {
        return { display: text.slice(done[0].length), expression: done[1].trim().toLowerCase(), pending: false };
    }
    if (isPartialExpressionTag(text)) {
        return { display: '', expression: null, pending: true };
    }
    return { display: text, expression: null, pending: false };
}
