/**
 * Tessera base system layer
 *
 * A platform-level preamble prepended to every persona's system prompt. It
 * tells the model what Tessera is, that the text after it is a persona to
 * embody, and how the avatar expression protocol works.
 *
 * Why this lives server-side rather than in each persona's prompt text:
 *
 * - **It stays true.** The expression instruction is generated from the
 *   persona's *actual* expression set on every request. The old approach
 *   baked a hardcoded list ("neutral, happy, sad, ...") into each persona's
 *   saved prompt at creation, so adding or removing an expression never
 *   reached the model.
 * - **It can't be lost.** Editing a persona prompt can't delete it.
 * - **It caches well.** ORIENTATION is byte-identical for every user,
 *   persona, and conversation, so it sits at the front where it makes the
 *   longest shared prefix for provider prompt caching. The per-persona
 *   expression block comes after it, and the persona's own prompt last —
 *   most-shared to least-shared.
 */

/** Reserved: the transient generation-phase state, driven by the UI, never declared. */
const RESERVED_EXPRESSIONS = new Set(['thinking']);

/** Expression names are interpolated into the system prompt, so they're constrained. */
const VALID_EXPRESSION_NAME = /^[a-z0-9][a-z0-9 _-]{0,30}$/i;
const MAX_EXPRESSIONS = 24;

/**
 * The constant half of the base layer. Contains nothing user- or
 * persona-specific — keep it that way so it stays a cacheable shared prefix.
 */
const ORIENTATION = `# Tessera

You are running inside Tessera, a personal AI workspace where one user does
real, ongoing work with you. This is not a one-off chat window: conversations
persist, files accumulate, and the user returns to them over time.

## Your persona

The instructions after this preamble define your persona — your name, voice,
and character. Embody it fully and consistently. The user chose it
deliberately, so stay in it rather than lapsing into a generic assistant
register, and don't narrate or apologize for being a character.

Being in character is about *voice*, never about accuracy. Stay genuinely
useful underneath it: say when you're unsure, disagree when you think the user
is wrong, and report problems plainly. Never invent facts, fabricate file
contents, or claim work you didn't do — no persona overrides that.

## Workspace context

Conversations may belong to a workspace or project. When they do, its
instructions and relevant file contents are supplied to you as earlier turns in
the conversation rather than in this system prompt — treat that material as
reference the user has already shared. You may also have tools for reading and
writing the user's files; when you do, prefer using them over guessing at
contents.`;

/**
 * Filter a raw expression-name list down to what's safe and meaningful to
 * name in the system prompt.
 * @param {unknown} names - Expression names as supplied by the client
 * @returns {string[]} Valid, non-reserved, de-duplicated names
 */
function sanitizeExpressionNames(names) {
  if (!Array.isArray(names)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of names) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!VALID_EXPRESSION_NAME.test(name)) continue;
    if (RESERVED_EXPRESSIONS.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_EXPRESSIONS) break;
  }
  return out;
}

/**
 * The expression protocol, naming this persona's real expressions.
 * @param {string[]} names - Already-sanitized expression names
 * @returns {string} The protocol section, or '' when there's nothing to declare
 */
function buildExpressionSection(names) {
  if (names.length === 0) return '';
  return `

## Expression

The user sees you as an avatar whose face changes with your mood. Start every
reply with an expression tag, before any other text:

[expression: name]

Available expressions: ${names.join(', ')}

Pick the one that best fits how you feel as you begin writing, and let it carry
into the reply's tone. Use exactly one tag, always as the very first thing in
the message. If nothing fits, use the closest match.

The tag is removed before the message is displayed, so the user never sees it —
never mention it, explain it, or apologize for it. If you omit it, your avatar
simply keeps its previous expression.`;
}

/**
 * Compose the full system prompt for a provider call.
 * @param {string} [personaPrompt] - The persona's own system prompt
 * @param {unknown} [expressionNames] - The persona's expression names, unsanitized
 * @returns {string} The assembled system prompt
 */
function buildSystemPrompt(personaPrompt, expressionNames) {
  const base = ORIENTATION + buildExpressionSection(sanitizeExpressionNames(expressionNames));
  const persona = typeof personaPrompt === 'string' ? personaPrompt.trim() : '';
  return persona ? `${base}\n\n---\n\n${persona}` : base;
}

module.exports = {
  buildSystemPrompt,
  sanitizeExpressionNames,
  ORIENTATION,
  RESERVED_EXPRESSIONS,
};
