/**
 * Naming a chat (AX-02).
 *
 * Everything here is pure — prompt text in, string out — so the interesting
 * decisions can be tested without a provider. The route owns dispatch; this
 * owns what we ask for and what we accept back.
 *
 * TWO RULES SHAPE ALL OF IT:
 *
 * 1. **Never fail.** A title is a nicety; a chat that will not save because
 *    naming threw is a disaster. Every path here has a defined answer for
 *    garbage input, and the caller falls back to `fallbackTitle` whenever the
 *    model route is unavailable or unusable.
 *
 * 2. **Never trust the model's formatting.** Asked for a short title, models
 *    return `"Quoted"`, `Title: X`, `**bold**`, a trailing period, or three
 *    paragraphs of explanation. `sanitizeTitle` assumes all of that.
 */

/** Titles are a list-row label, not a summary. */
const MAX_TITLE_CHARS = 60;

/** Longer than a title, short enough that the fallback stays a label. */
const MAX_FALLBACK_CHARS = 48;

/** How much of the exchange the aux model is shown. */
const MAX_PROMPT_USER_CHARS = 1200;
const MAX_PROMPT_REPLY_CHARS = 600;

/**
 * The system prompt for the naming call.
 *
 * "Same language as the conversation" is load-bearing, not politeness: a
 * Korean or Japanese chat titled in English reads as a bug to the person
 * scanning their own chat list.
 */
const TITLE_SYSTEM_PROMPT = [
  'You write short titles for chat conversations.',
  '',
  'Rules:',
  '- Reply with the title and nothing else. No quotes, no preamble, no explanation.',
  '- 2 to 6 words. Never a full sentence, and no trailing period.',
  '- Name the specific subject, not the activity. "Redis cache eviction", not "A question about code".',
  '- Write it in the same language the user is writing in.',
].join('\n');

/**
 * Collapse any run of whitespace (newlines included) to single spaces.
 * A title lives on one line of a list row, so this is the first thing that
 * happens to every candidate.
 */
function flatten(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

/**
 * Cut to `max` characters without splitting a word — where words exist.
 *
 * CJK is why the word-boundary logic is conditional: Korean, Japanese and
 * Chinese routinely run long stretches with no spaces, so "back up to the last
 * space" either finds nothing or throws most of the string away. When the
 * break would leave less than half the budget, this hard-cuts instead. Without
 * that, a Korean opener could be truncated to two characters.
 */
function truncate(text, max) {
  const flat = flatten(text);
  if (flat.length <= max) return flat;
  const slice = flat.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max / 2 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/**
 * Turn whatever the model said into a title, or '' if there is nothing usable.
 * '' is the caller's signal to fall back — it is a normal outcome, not an error.
 *
 * @param {string} raw - the model's reply
 * @returns {string}
 */
function sanitizeTitle(raw) {
  let text = String(raw == null ? '' : raw);

  // Pick the line the title is actually on.
  //
  // Usually the first non-empty one. But a model that ignores "reply with the
  // title and nothing else" tends to announce it first — "Sure! Here's a
  // title:" — and taking line one then labels the chat with the preamble. A
  // line ending in ':' is an announcement, not a title, so step past it.
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let idx = 0;
  while (idx < lines.length - 1 && /:$/.test(lines[idx])) idx++;
  text = flatten(lines[idx] || '');

  // "Title: X" / "Chat title - X" — a label the model added, not part of it.
  text = text.replace(/^(?:chat\s+)?title\s*[:\-–—]\s*/i, '');

  // Markdown emphasis a model reaches for when asked for something short.
  text = text.replace(/[*_`]+/g, '');

  // Matched wrapping quotes, straight or curly, possibly doubled up.
  let prev;
  do {
    prev = text;
    text = text.replace(/^["'“”‘’«»]+\s*(.*?)\s*["'“”‘’«»]+$/u, '$1').trim();
  } while (text !== prev);

  // Trailing sentence punctuation. A '?' is kept — a question can be the
  // subject ("Why is the build slow?"), where a period is only ever noise.
  text = text.replace(/[.,;:]+$/u, '').trim();

  if (!text) return '';
  return truncate(text, MAX_TITLE_CHARS);
}

/**
 * The no-model title: the opening words of the first user message.
 *
 * Used when there is no aux model, no API key, or the call failed. It is
 * genuinely useful rather than a placeholder — "Redis cache eviction stra…"
 * beats "New Chat" — which is what lets the whole feature degrade quietly.
 *
 * @param {string} firstUserMessage
 * @returns {string} a title, or '' when there is nothing to work with
 */
function fallbackTitle(firstUserMessage) {
  const flat = flatten(firstUserMessage);
  if (!flat) return '';
  return truncate(flat, MAX_FALLBACK_CHARS);
}

/**
 * The messages for the naming call: the opening exchange, truncated.
 *
 * The reply is included because the first message alone is often too thin to
 * name ("can you help me with something?"), and the model's answer is what
 * reveals the subject. Both are clipped — naming a chat must not re-send a
 * 40KB opener.
 *
 * @param {string} firstUserMessage
 * @param {string} [firstAssistantMessage]
 * @returns {{system: string, messages: Array<{role: string, content: string}>}}
 */
function buildTitleRequest(firstUserMessage, firstAssistantMessage = '') {
  const user = truncate(firstUserMessage, MAX_PROMPT_USER_CHARS);
  const reply = truncate(firstAssistantMessage, MAX_PROMPT_REPLY_CHARS);

  const parts = [`User's first message:\n${user}`];
  if (reply) parts.push(`Assistant's reply:\n${reply}`);
  parts.push('Title:');

  return {
    system: TITLE_SYSTEM_PROMPT,
    // One user turn rather than a replayed exchange: this is a labelling task
    // about a conversation, not a continuation of it, and the aux model should
    // not be tempted to answer the user's question instead of naming it.
    messages: [{ role: 'user', content: parts.join('\n\n') }],
  };
}

module.exports = {
  buildTitleRequest,
  sanitizeTitle,
  fallbackTitle,
  TITLE_SYSTEM_PROMPT,
  MAX_TITLE_CHARS,
  MAX_FALLBACK_CHARS,
};
