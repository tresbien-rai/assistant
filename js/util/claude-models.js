/**
 * Which request parameters a Claude model accepts, decided from its id.
 *
 * The client copy of the rule in server/src/providers/anthropic.js
 * (`isCurrentGenerationModel` / `acceptsPrefill`), which is what actually
 * shapes the request. The server can't import a browser module (it is
 * CommonJS on Node 20), so this file mirrors it, and
 * server/src/providers/test-modelparams.js loads THIS file and checks both
 * agree on every id it knows — change one and that test makes you change the
 * other. Dependency-free on purpose: the test imports it as-is.
 */

const CLAUDE_ID = /^claude-[a-z]+-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;

/**
 * Parse `claude-<family>-<major>[-<minor>][-<date>]` into its version.
 * Old `claude-3-5-sonnet-…` naming and custom ids don't parse → null.
 * @param {string} model
 * @returns {{major: number, minor: number} | null}
 */
function claudeVersion(model) {
    const m = CLAUDE_ID.exec(String(model || ''));
    if (!m) return null;
    return { major: Number(m[1]), minor: m[2] === undefined ? 0 : Number(m[2]) };
}

function atLeast(model, major, minor) {
    const v = claudeVersion(model);
    return Boolean(v) && (v.major > major || (v.major === major && v.minor >= minor));
}

/**
 * Claude 4.7 and later (Opus 4.7/4.8/5/5.5, Sonnet 5/5.5, Haiku 5.5, Fable):
 * no temperature / top_p / top_k, and thinking is adaptive only (no budget).
 * @param {string} model
 * @returns {boolean}
 */
export function isCurrentGenerationModel(model) {
    return atLeast(model, 4, 7);
}

/**
 * Prefill (a trailing assistant message) is rejected with a 400 from Claude
 * 4.6 on.
 * @param {string} model
 * @returns {boolean}
 */
export function acceptsPrefill(model) {
    return !atLeast(model, 4, 6);
}
