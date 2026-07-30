/**
 * Prompt presets — the override layer over the built-in prompt blocks (AP-01).
 *
 * A preset is a named set of OVERRIDES, not a copy: every block whose `text` is
 * null renders from the built-in in ./tessera.js. That is what lets the built-in
 * wording keep improving for blocks a user never touched, and makes "reset to
 * built-in" the same operation as "never edited" (Decision D2 in
 * docs/ADVANCED_PROMPTS_PLAN.md).
 *
 * WHAT A PRESET CANNOT DO (D3): turn a capability on. Whether tools are
 * advertised, whether the scratchpad is injected, whether KB files are loaded is
 * resolved server-side from the conversation and persona, exactly as before. A
 * preset only changes how those things are WORDED and in what ORDER they appear.
 * Gating and phrasing stay separate on purpose — one source of truth for what
 * the model can actually do.
 *
 * This module is deliberately pure: block definitions, validation, macros, and
 * composition. It reads no database and knows nothing about requests; the DAL
 * lookup and precedence live with the other resolvers in routes/chat.js.
 */

const BLOCKS_VERSION = 1;

/**
 * The system-layer blocks, in their default order. Order here IS the built-in
 * order, so a preset that only edits text renders in the familiar sequence.
 *
 * `kind`:
 *   'text'    a section whose content comes from the built-in or an override
 *   'persona' the position marker for the persona's own prompt (its text comes
 *             from the persona record, never from the preset)
 */
const SYSTEM_BLOCK_IDS = ['orientation', 'expressions', 'scratchpad', 'persona'];

/**
 * `context_ack` is a block but NOT part of the system layer: it is the synthetic
 * assistant turn after injected KB context, so the assembly positions it, not
 * the user's `order`. Listed here so it is still editable and resettable.
 */
const MESSAGE_BLOCK_IDS = ['context_ack'];

const ALL_BLOCK_IDS = [...SYSTEM_BLOCK_IDS, ...MESSAGE_BLOCK_IDS];

// Guard rails against accidents (a runaway paste, a loop building a preset),
// not policy — a genuinely long prompt fits comfortably inside these.
const MAX_BLOCK_CHARS = 8000;
const MAX_PRESET_CHARS = 32000;
const MAX_NAME_CHARS = 80;

/** The preset every user starts from: built-in text, built-in order. */
function defaultBlocks() {
  const blocks = {};
  for (const id of ALL_BLOCK_IDS) {
    blocks[id] = { enabled: true, text: null };
  }
  return { version: BLOCKS_VERSION, order: [...SYSTEM_BLOCK_IDS], blocks };
}

/**
 * Coerce stored/incoming preset JSON into the shape the composer expects.
 *
 * Tolerant by design — this runs on data that may have been written by an older
 * version of the app, hand-edited, or imported from a file. Anything unrecognised
 * falls back to the built-in rather than throwing, so a malformed preset degrades
 * to "the default prompt" instead of breaking every chat the user owns.
 * `validateBlocks` is the strict counterpart, used on the WRITE path.
 *
 * @param {unknown} raw - parsed `prompt_presets.blocks` JSON, or null
 * @returns {{version: number, order: string[], blocks: Object}}
 */
function normalizeBlocks(raw) {
  const base = defaultBlocks();
  if (!raw || typeof raw !== 'object') return base;

  const out = { version: BLOCKS_VERSION, order: [], blocks: base.blocks };

  // Order: keep the user's sequence, drop unknown ids, then append any known
  // system block they don't mention (a block added by a later version must not
  // silently vanish from an older preset).
  const wanted = Array.isArray(raw.order) ? raw.order : base.order;
  const seen = new Set();
  for (const id of wanted) {
    if (SYSTEM_BLOCK_IDS.includes(id) && !seen.has(id)) {
      seen.add(id);
      out.order.push(id);
    }
  }
  for (const id of SYSTEM_BLOCK_IDS) {
    if (!seen.has(id)) out.order.push(id);
  }

  const rawBlocks = raw.blocks && typeof raw.blocks === 'object' ? raw.blocks : {};
  out.blocks = {};
  for (const id of ALL_BLOCK_IDS) {
    const b = rawBlocks[id] && typeof rawBlocks[id] === 'object' ? rawBlocks[id] : {};
    out.blocks[id] = {
      enabled: b.enabled !== false, // default on
      text: typeof b.text === 'string' ? b.text : null,
    };
  }
  return out;
}

/**
 * Strict validation for the write path (the AP-02 API + import).
 * @param {unknown} raw
 * @returns {{ok: true}|{ok: false, error: string}}
 */
function validateBlocks(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Preset blocks must be an object.' };
  }
  if (raw.order !== undefined) {
    if (!Array.isArray(raw.order)) return { ok: false, error: '"order" must be an array.' };
    for (const id of raw.order) {
      if (!SYSTEM_BLOCK_IDS.includes(id)) {
        return { ok: false, error: `Unknown block in "order": ${String(id)}` };
      }
    }
    if (new Set(raw.order).size !== raw.order.length) {
      return { ok: false, error: '"order" contains a duplicate block.' };
    }
  }
  if (raw.blocks !== undefined) {
    if (!raw.blocks || typeof raw.blocks !== 'object' || Array.isArray(raw.blocks)) {
      return { ok: false, error: '"blocks" must be an object.' };
    }
    let total = 0;
    for (const [id, b] of Object.entries(raw.blocks)) {
      if (!ALL_BLOCK_IDS.includes(id)) {
        return { ok: false, error: `Unknown block: ${id}` };
      }
      if (!b || typeof b !== 'object') {
        return { ok: false, error: `Block "${id}" must be an object.` };
      }
      if (b.enabled !== undefined && typeof b.enabled !== 'boolean') {
        return { ok: false, error: `Block "${id}": "enabled" must be true or false.` };
      }
      if (b.text !== undefined && b.text !== null) {
        if (typeof b.text !== 'string') {
          return { ok: false, error: `Block "${id}": "text" must be a string or null.` };
        }
        if (b.text.length > MAX_BLOCK_CHARS) {
          return { ok: false, error: `Block "${id}" is over the ${MAX_BLOCK_CHARS}-character limit.` };
        }
        total += b.text.length;
      }
      // The persona block is a position marker — its text lives on the persona.
      if (id === 'persona' && typeof b.text === 'string' && b.text.length > 0) {
        return { ok: false, error: 'The persona block holds no text of its own — edit the persona instead.' };
      }
    }
    if (total > MAX_PRESET_CHARS) {
      return { ok: false, error: `Preset is over the ${MAX_PRESET_CHARS}-character limit.` };
    }
  }
  return { ok: true };
}

/** Validate a preset name. @returns {{ok: true}|{ok: false, error: string}} */
function validateName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, error: 'Preset name is required.' };
  }
  if (name.length > MAX_NAME_CHARS) {
    return { ok: false, error: `Preset name is over the ${MAX_NAME_CHARS}-character limit.` };
  }
  return { ok: true };
}

// ===== Macros =====

/**
 * Expand `{{macro}}` references in one pass.
 *
 * Two deliberate properties:
 * - **Unknown macros are left verbatim.** Blanking text a user typed because we
 *   didn't recognise a name is worse than showing it back to them.
 * - **Non-recursive.** A replacement is never re-scanned, so no macro can expand
 *   into another one (or into itself).
 *
 * @param {string} text
 * @param {Object} values - macro name → string
 * @returns {string}
 */
function expandMacros(text, values) {
  if (typeof text !== 'string' || text === '') return '';
  return text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, name) => {
    const key = String(name).toLowerCase();
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
  });
}

/**
 * Build the macro table for one request. Everything is a string; a value with no
 * source resolves to '' rather than being left as a literal `{{char}}`, since an
 * empty name is a missing value, not an unrecognised macro.
 *
 * @param {Object} [ctx]
 * @param {string} [ctx.personaName]
 * @param {string} [ctx.userName]
 * @param {string[]} [ctx.expressionNames] - already sanitized
 * @param {string} [ctx.workspaceName]
 * @param {string} [ctx.projectName]
 * @param {string} [ctx.model]
 * @param {Date} [ctx.now]
 * @returns {Object}
 */
function buildMacroValues(ctx = {}) {
  const when = ctx.now instanceof Date ? ctx.now : new Date();
  return {
    char: ctx.personaName || '',
    user: ctx.userName || '',
    expressions: Array.isArray(ctx.expressionNames) ? ctx.expressionNames.join(', ') : '',
    workspace: ctx.workspaceName || '',
    project: ctx.projectName || '',
    model: ctx.model || '',
    date: when.toISOString().slice(0, 10),
    time: when.toISOString().slice(11, 16),
  };
}

/** Macro names + one-line descriptions, for the editor's reference list (AP-03). */
const MACRO_REFERENCE = [
  { name: 'char', description: "The active persona's name" },
  { name: 'user', description: 'Your display name' },
  { name: 'expressions', description: "The persona's expression names, comma-separated" },
  { name: 'workspace', description: "The chat's workspace name, if any" },
  { name: 'project', description: "The chat's project name, if any" },
  { name: 'model', description: 'The model id for this request' },
  { name: 'date', description: "Today's date (YYYY-MM-DD)" },
  { name: 'time', description: 'Current time (HH:MM, UTC)' },
];

module.exports = {
  BLOCKS_VERSION,
  SYSTEM_BLOCK_IDS,
  MESSAGE_BLOCK_IDS,
  ALL_BLOCK_IDS,
  MAX_BLOCK_CHARS,
  MAX_PRESET_CHARS,
  MAX_NAME_CHARS,
  defaultBlocks,
  normalizeBlocks,
  validateBlocks,
  validateName,
  expandMacros,
  buildMacroValues,
  MACRO_REFERENCE,
};
