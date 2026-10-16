/**
 * The tool trail (TT-02, docs/design/TOOL_TRAIL_DESIGN.md).
 *
 * History keeps only each reply's final text, so on a later turn the model
 * sees its own "Created notes.md…" with nothing behind it, and current Claude
 * models conclude they made the result up. The trail is one line at the start
 * of each past assistant message naming the tools that reply ran — names,
 * targets and failures, never results — built from the tool attachments the
 * message already has saved.
 *
 * Pure functions of their arguments. A past message's trail depends only on
 * its saved attachments, so it renders byte-identical on every later request
 * and the cached history prefix survives (PROMPT_CACHING_DESIGN.md).
 */

export const TOOL_TRAIL_MAX = 12;

const TRAIL_TYPES = new Set(['tool_event', 'created_file']);

// A leading trail, possibly after whitespace. Used to keep a model that copies
// the line into its own reply from turning it into "evidence" next turn.
const LEADING_TRAILS = /^(?:\s*<tool_trail>[\s\S]*?<\/tool_trail>)+\s*/;

// Filenames are user/model-chosen: one line, and no angle brackets that could
// close the tag early.
function clean(s) {
    return String(s).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
}

function describe(att) {
    let entry = clean(att.tool || 'tool');
    const target = att.type === 'created_file' ? att.fileName : att.filename;
    if (target) entry += ` ${clean(target)}`;
    if (att.destination) entry += ` → ${clean(att.destination)}`;
    if (att.type === 'tool_event' && att.ok === false) entry += ' (failed)';
    return entry;
}

/**
 * Build the trail line for one saved assistant message.
 * @param {Array|undefined} attachments - the message's saved attachments
 * @returns {string} `<tool_trail>…</tool_trail>`, or '' when it ran no tools
 */
export function formatToolTrail(attachments) {
    if (!Array.isArray(attachments)) return '';
    const entries = attachments.filter(a => a && TRAIL_TYPES.has(a.type)).map(describe);
    if (entries.length === 0) return '';
    const shown = entries.slice(0, TOOL_TRAIL_MAX);
    if (entries.length > TOOL_TRAIL_MAX) shown.push(`+${entries.length - TOOL_TRAIL_MAX} more`);
    return `<tool_trail>${shown.join(' · ')}</tool_trail>`;
}

/**
 * The content to send for a past assistant message: its trail, then its text.
 * @param {string} content
 * @param {Array|undefined} attachments
 * @returns {string}
 */
export function withToolTrail(content, attachments) {
    const trail = formatToolTrail(attachments);
    return trail ? `${trail}\n${content}` : content;
}

/**
 * Remove any leading trail(s) a model wrote into its own reply.
 * @param {string} text
 * @returns {string}
 */
export function stripToolTrail(text) {
    return text.replace(LEADING_TRAILS, '');
}
