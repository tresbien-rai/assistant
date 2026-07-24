/**
 * Context state resolution (Context toggles, CT-01)
 *
 * The single place that answers "does this file ride in the prompt right now?"
 * — for knowledge files (workspace/project) and for chat working files. The DAL
 * stores three independent facts; this module applies the layering rules to
 * them, so the injection path (CT-02) and the API (CT-03/CT-04) can never
 * disagree about what a toggle means.
 *
 * Knowledge files resolve **chat override → container default → on**:
 *
 *   conversation_context_overrides row?  → use it        (source: 'chat')
 *   else project_files/workspace_files.enabled           (source: 'container')
 *   else on                                              (source: 'container')
 *
 * `enabled` is read as "NULL or 1 → on, 0 → off", so a pre-migration row, or one
 * written by any path that ignores the column, defaults to today's behaviour
 * (everything loaded). That is deliberate: a file that silently stops working
 * after upload is a worse surprise than a visible truncation warning.
 *
 * Chat working files are not always-injected — they ride the recency window in
 * activeFiles.js — so their control is a MODE, not a boolean:
 *
 *   'auto' (default) → the existing recency window
 *   'pin'            → injected every turn regardless of age
 *   'mute'           → never injected, even right after an edit
 *
 * Nothing here reads or writes the database beyond one override lookup per
 * conversation, and nothing here is aware of Drive: it is pure resolution over
 * rows the caller already has.
 */

/** Knowledge-file scopes that participate in per-chat overrides. */
const KNOWLEDGE_SCOPES = ['workspace', 'project'];

/** Valid chat-file inject modes, in cycle order (the UI cycles in this order). */
const INJECT_MODES = ['auto', 'pin', 'mute'];

/** The mode stored as NULL. */
const DEFAULT_INJECT_MODE = 'auto';

/**
 * A knowledge file's container-level default, tolerant of NULL/undefined.
 * @param {Object} file - project_files or workspace_files row
 * @returns {boolean}
 */
function containerDefaultEnabled(file) {
  return !(file && file.enabled === 0);
}

/**
 * Index a conversation's override rows for O(1) lookup while resolving a list.
 * @param {Array} overrides - listConversationContextOverrides() rows
 * @returns {Map<string, boolean>} keyed `${scope}:${fileId}`
 */
function indexOverrides(overrides) {
  const map = new Map();
  for (const row of overrides || []) {
    map.set(`${row.scope}:${row.file_id}`, row.enabled === 1);
  }
  return map;
}

/**
 * Resolve one knowledge file against a pre-indexed override map.
 * @param {Map<string, boolean>} overrideMap - from indexOverrides()
 * @param {'workspace'|'project'} scope
 * @param {Object} file - the file row
 * @returns {{ enabled: boolean, source: 'chat'|'container' }} `source` is what
 *   lets the UI show "this row disagrees with the default" and offer a reset.
 */
function resolveWithOverrides(overrideMap, scope, file) {
  const override = overrideMap.get(`${scope}:${file.id}`);
  if (override !== undefined) return { enabled: override, source: 'chat' };
  return { enabled: containerDefaultEnabled(file), source: 'container' };
}

/**
 * Resolve a whole knowledge-file list for a conversation (one DB read).
 *
 * Pass `conversationId = null` for a context with no chat (e.g. the container
 * page, or a chat that hasn't been persisted yet) — every file then resolves to
 * its container default.
 *
 * @param {Object} dal - the DAL module (injected so this stays trivially testable)
 * @param {string|null} conversationId
 * @param {'workspace'|'project'} scope
 * @param {Array} files - project_files or workspace_files rows
 * @returns {Array<{ file: Object, enabled: boolean, source: 'chat'|'container' }>}
 *   in the same order as `files`
 */
function resolveKnowledgeFiles(dal, conversationId, scope, files) {
  const list = files || [];
  if (list.length === 0) return [];

  const overrideMap = conversationId
    ? indexOverrides(dal.listConversationContextOverrides(conversationId))
    : new Map();

  return list.map((file) => ({ file, ...resolveWithOverrides(overrideMap, scope, file) }));
}

/**
 * Split a knowledge-file list into what gets injected and what only gets named
 * in the `<available_files>` manifest (CT-02). Thin wrapper over
 * resolveKnowledgeFiles, but it is the shape the context assembler wants.
 *
 * @param {Object} dal
 * @param {string|null} conversationId
 * @param {'workspace'|'project'} scope
 * @param {Array} files
 * @returns {{ loaded: Array, notLoaded: Array }} both arrays hold file rows
 */
function partitionKnowledgeFiles(dal, conversationId, scope, files) {
  const loaded = [];
  const notLoaded = [];
  for (const entry of resolveKnowledgeFiles(dal, conversationId, scope, files)) {
    (entry.enabled ? loaded : notLoaded).push(entry.file);
  }
  return { loaded, notLoaded };
}

/**
 * A chat working file's inject mode, tolerant of NULL and of any unrecognised
 * value (which resolves to 'auto' rather than dropping the file — a bad string
 * in the column must never make a file silently invisible).
 * @param {Object} file - conversation_files row
 * @returns {'auto'|'pin'|'mute'}
 */
function resolveInjectMode(file) {
  const mode = file && file.inject_mode;
  return INJECT_MODES.includes(mode) ? mode : DEFAULT_INJECT_MODE;
}

/**
 * Validate a client-supplied inject mode.
 * @param {any} mode
 * @returns {boolean}
 */
function isValidInjectMode(mode) {
  return INJECT_MODES.includes(mode);
}

/**
 * Validate a client-supplied knowledge scope.
 * @param {any} scope
 * @returns {boolean}
 */
function isKnowledgeScope(scope) {
  return KNOWLEDGE_SCOPES.includes(scope);
}

module.exports = {
  KNOWLEDGE_SCOPES,
  INJECT_MODES,
  DEFAULT_INJECT_MODE,
  containerDefaultEnabled,
  resolveKnowledgeFiles,
  partitionKnowledgeFiles,
  resolveInjectMode,
  isValidInjectMode,
  isKnowledgeScope,
  // exported for tests
  _indexOverrides: indexOverrides,
};
