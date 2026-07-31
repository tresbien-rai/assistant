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

/**
 * Reserved: the "working on it" state the UI drives while a response streams.
 * Never offered to the model. Note `thinking` is NOT reserved — it used to be
 * this slot, and is now an ordinary character expression (a hand-on-chin pose
 * is a perfectly good thing to declare).
 */
const RESERVED_EXPRESSIONS = new Set(['generating']);

// The preset layer (AP-01) supplies the override/normalisation rules and the
// macro expander. This module owns the TEXT; presets.js owns the SHAPE.
const { normalizeBlocks, expandMacros, buildMacroValues } = require('./presets');

/**
 * Expression names are interpolated into the system prompt, so they're
 * constrained. Deliberately matches `validateExpressionName` in
 * routes/avatars.js — names are also filenames and URL segments there, and a
 * name accepted here but rejected there would be an expression that can never
 * have art (spaces were exactly that bug).
 */
const VALID_EXPRESSION_NAME = /^[a-z0-9][a-z0-9_-]{0,30}$/i;
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
 *
 * `{{expressions}}` is a macro rather than an interpolation so a user-authored
 * override can place the list wherever they want it (AP-01). The names still
 * come from the persona's ACTUAL expression set on every request — that is the
 * whole reason this layer exists, and no preset can change it.
 */
const EXPRESSION_SECTION = `## Expression

The user sees you as an avatar whose face changes with your mood. Start every
reply with an expression tag, before any other text:

[expression: name]

Available expressions: {{expressions}}

Pick the one that best fits how you feel as you begin writing, and let it carry
into the reply's tone. Use exactly one tag, always as the very first thing in
the message. If nothing fits, use the closest match.

The tag is removed before the message is displayed, so the user never sees it —
never mention it, explain it, or apologize for it. If you omit it, your avatar
simply keeps its previous expression.`;

/**
 * The scratchpad collaboration nudge (SP-05). Included only when the scratchpad
 * is active for the request, so it costs nothing on ordinary chats. This is the
 * adoption lever — models default to putting substance in the chat reply, so it
 * has to be told to develop content IN the pad and to CHURN it rather than let
 * it grow. Lives here (the base-prompt layer) so the wording is iterated in one
 * place; the per-turn `<scratchpad>` block reinforces it with the live content.
 */
const SCRATCHPAD_SECTION = `## Scratchpad

This conversation has a shared scratchpad — a document beside the chat that both
you and the user edit directly (write_scratchpad replaces the whole thing;
edit_scratchpad changes part of it). Use it as the main place to develop
substantial or evolving content — outlines, drafts, structured notes, the current
state of a plan — rather than packing that content into long chat messages.

Keep it a clean, CURRENT artifact, not a log. Rework, trim, and REPLACE
superseded ideas in place instead of appending to them, so it stays focused and
does not grow unmanageably — this is the core of how the scratchpad differs from
a file you build up. In your chat replies, stay focused on reasoning and
discussion: explain what you changed and why, and point to the scratchpad rather
than restating its contents. The user edits it too, so treat their changes as
part of your shared thinking.`;

/**
 * The synthetic assistant turn that acknowledges injected workspace/project
 * context (FC-03a). A block like any other, so it is editable — it sits in the
 * MESSAGE layer rather than the system layer, which is why the assembly
 * positions it instead of the preset's `order`.
 */
const CONTEXT_ACK = "Understood — I'll use the reference material above as background for our conversation.";

/** Built-in text for every block, by id. `persona` has none — see below. */
const BUILTIN_BLOCK_TEXT = {
  orientation: ORIENTATION,
  expressions: EXPRESSION_SECTION,
  scratchpad: SCRATCHPAD_SECTION,
  context_ack: CONTEXT_ACK,
};

/** The text a block renders with: the preset's override, or the built-in. */
function blockText(preset, id) {
  const override = preset.blocks[id] && preset.blocks[id].text;
  return typeof override === 'string' ? override : (BUILTIN_BLOCK_TEXT[id] || '');
}

/**
 * Compose the full system prompt for a provider call.
 *
 * Blocks render in the preset's order, joined by a blank line. Three of them are
 * CONDITIONAL on things the preset does not control (D3): the expression section
 * needs the persona to actually have expressions, the scratchpad section needs
 * the pad to be active for this request, and the persona block needs the persona
 * to have a prompt. A preset can reword or reorder them; it cannot make one
 * appear when its condition is false.
 *
 * With no preset this is byte-identical to the pre-AP-01 output — see
 * prompts/test-presets.js, which pins that against a golden string.
 *
 * @param {string} [personaPrompt] - The persona's own system prompt
 * @param {unknown} [expressionNames] - The persona's expression names, unsanitized
 * @param {Object} [options]
 * @param {boolean} [options.scratchpad] - the scratchpad is active for this request (SP-05)
 * @param {Object} [options.preset] - resolved preset blocks; omit for the built-in layer
 * @param {Object} [options.macros] - buildMacroValues() input (persona name, model, …)
 * @returns {string} The assembled system prompt
 */
function buildSystemPrompt(personaPrompt, expressionNames, options = {}) {
  return composeSystemPrompt(personaPrompt, expressionNames, options).text;
}

/**
 * The composer behind buildSystemPrompt, with provenance (AP-05).
 *
 * Returns the same text plus a record of every block: whether it was included,
 * where its text came from, how big it was, and — the useful part when a prompt
 * isn't doing what you expect — WHY a block was left out. buildSystemPrompt is
 * a thin wrapper over this rather than a parallel implementation, so the
 * inspector can never describe an assembly that differs from the real one.
 *
 * `source`: 'preset' (an override), 'built-in', or 'persona' (the persona's own
 * prompt). `reason` on an excluded block is a stable code the client turns into
 * a sentence: disabled | no-expressions | scratchpad-inactive | no-persona-prompt | empty.
 *
 * @returns {{text: string, blocks: Array<Object>}}
 */
function composeSystemPrompt(personaPrompt, expressionNames, options = {}) {
  const preset = normalizeBlocks(options.preset);
  const names = sanitizeExpressionNames(expressionNames);
  // expressionNames is forced from the sanitized list: the macro must describe
  // the persona's real expression set, never whatever a caller passed in.
  const macros = buildMacroValues({ ...(options.macros || {}), expressionNames: names });
  const persona = typeof personaPrompt === 'string' ? personaPrompt.trim() : '';

  const parts = [];
  const blocks = [];
  const skip = (id, reason) => blocks.push({ id, included: false, reason, chars: 0 });

  for (const id of preset.order) {
    const block = preset.blocks[id];

    // Generated per request from live state, never stored (SS-02). Like the
    // persona block this is a POSITION marker: the preset decides where it
    // goes, not what it says.
    //
    // Deliberately ABOVE the enabled check — `state` is plumbing and cannot be
    // switched off (docs/SESSION_STATE_DESIGN.md, D3). A prompt that lies about
    // what exists is worse than one that stays quiet, and a disabled state
    // block would put the model back to guessing. The write path refuses to
    // disable it; this makes an already-stored `enabled: false` harmless too.
    if (id === 'state') {
      const text = typeof options.sessionState === 'string' ? options.sessionState.trim() : '';
      if (!text) {
        skip(id, 'no-session-state');
        continue;
      }
      parts.push(text);
      blocks.push({ id, included: true, source: 'generated', chars: text.length, text });
      continue;
    }

    if (!block || !block.enabled) {
      skip(id, 'disabled');
      continue;
    }

    if (id === 'persona') {
      if (!persona) {
        skip(id, 'no-persona-prompt');
        continue;
      }
      // The `---` rule separates the platform layer from the persona's own
      // words. Nothing to separate when the persona leads, so it is dropped.
      const span = parts.length === 0 ? persona : `---\n\n${persona}`;
      parts.push(span);
      // Reports the span actually emitted, separator included, so the char
      // counts add up to the prompt the model receives.
      blocks.push({ id, included: true, source: 'persona', chars: span.length, text: span });
      continue;
    }
    if (id === 'expressions' && names.length === 0) {
      skip(id, 'no-expressions');
      continue;
    }
    if (id === 'scratchpad' && !options.scratchpad) {
      skip(id, 'scratchpad-inactive');
      continue;
    }

    const overridden = typeof preset.blocks[id].text === 'string';
    const text = expandMacros(blockText(preset, id), macros).trim();
    if (!text) {
      skip(id, 'empty');
      continue;
    }
    parts.push(text);
    blocks.push({
      id,
      included: true,
      source: overridden ? 'preset' : 'built-in',
      chars: text.length,
      text,
    });
  }
  return { text: parts.join('\n\n'), blocks };
}

/**
 * The context acknowledgement text for this request (see CONTEXT_ACK).
 * @param {Object} [options] - { preset, macros }, as buildSystemPrompt takes
 * @returns {string} the ack, or '' when the block is disabled
 */
function buildContextAck(options = {}) {
  const preset = normalizeBlocks(options.preset);
  if (!preset.blocks.context_ack.enabled) return '';
  return expandMacros(blockText(preset, 'context_ack'), buildMacroValues(options.macros || {})).trim();
}

/**
 * The context-ack block's provenance entry (AP-05), in the same shape
 * composeSystemPrompt produces. It lives in the MESSAGE layer, so it is
 * described separately rather than appearing in the system-prompt list.
 *
 * @param {Object} [options] - { preset, macros }, as buildContextAck takes
 * @param {boolean} [hasContext] - whether this request injects KB context at all
 */
function describeContextAck(options = {}, hasContext = false) {
  const preset = normalizeBlocks(options.preset);
  const id = 'context_ack';
  if (!preset.blocks[id].enabled) return { id, included: false, reason: 'disabled', chars: 0 };
  if (!hasContext) return { id, included: false, reason: 'no-context', chars: 0 };
  const text = buildContextAck(options);
  if (!text) return { id, included: false, reason: 'empty', chars: 0 };
  return {
    id,
    included: true,
    source: typeof preset.blocks[id].text === 'string' ? 'preset' : 'built-in',
    chars: text.length,
    text,
  };
}

module.exports = {
  buildSystemPrompt,
  composeSystemPrompt,
  buildContextAck,
  describeContextAck,
  sanitizeExpressionNames,
  ORIENTATION,
  CONTEXT_ACK,
  BUILTIN_BLOCK_TEXT,
  RESERVED_EXPRESSIONS,
};
