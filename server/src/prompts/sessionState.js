/**
 * The `<session_state>` block (SS-02, docs/SESSION_STATE_DESIGN.md).
 *
 * What the model is told about the state of its own workspace — and crucially
 * about ABSENCE. Before this, an empty scratchpad, a conversation with no
 * files, and a chat belonging to no container were all the same thing from
 * inside the prompt: silence. The model could not tell "there is nothing there"
 * from "I wasn't told", so it either called tools to discover state it could
 * have been handed, or referred to project files that could not exist.
 *
 * TWO RULES hold this together:
 *
 * 1. STABLE KEYS. All four lines are always present, whether or not they have
 *    values. A key that disappears when empty recreates the exact ambiguity
 *    this block exists to remove.
 *
 * 2. COUNTS, NOT NAMES. The `<available_files>` manifest
 *    (utils/projectContext.js) already lists names, and loaded files have their
 *    content injected outright. Repeating names here would duplicate one and
 *    contradict the other as soon as they disagree. This block answers "is
 *    there anything, and where does it live"; the manifest answers "what
 *    exactly".
 */

const dal = require('../db/dal');
const { logger } = require('../utils/logger');

/** Digit grouping so counts read cleanly: 1240 -> "1,240". */
function group(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * One container line. Names the container, and says explicitly when it has no
 * instructions — silence there would let the model infer that instructions
 * exist but were withheld from it.
 */
function containerLine(label, container) {
  if (!container) return `${label}: none`;
  const name = (container.name || '').trim() || 'untitled';
  const hasInstructions = ((container.instructions || '').trim()) !== '';
  return `${label}: "${name}"${hasInstructions ? '' : ' (no instructions set)'}`;
}

/**
 * Count the files the model could actually reach, by scope.
 * Best-effort: a DB hiccup must degrade this block, never fail the request.
 */
function countFiles(conversationId, workspace, project) {
  const safe = (fn, ...args) => {
    try {
      const rows = fn(...args);
      return Array.isArray(rows) ? rows.length : 0;
    } catch (err) {
      logger.warn({ msg: err.message }, 'session_state file count failed');
      return null;
    }
  };
  return {
    conversation: conversationId ? safe(dal.listConversationFiles, conversationId) : 0,
    project: project ? safe(dal.listProjectFiles, project.id) : 0,
    workspace: workspace ? safe(dal.listWorkspaceFiles, workspace.id) : 0,
  };
}

/** "2 in this conversation, 5 in the project" / "none". */
function filesLine(counts) {
  const parts = [];
  if (counts.conversation) parts.push(`${group(counts.conversation)} in this conversation`);
  if (counts.project) parts.push(`${group(counts.project)} in the project`);
  if (counts.workspace) parts.push(`${group(counts.workspace)} in the workspace`);
  if (parts.length === 0) return 'Files: none';
  return `Files: ${parts.join(', ')}`;
}

/**
 * The scratchpad line. Says empty when empty — the whole point, since
 * resolveScratchpadBlock omits itself entirely for an empty pad, so nothing
 * else in the prompt would mention it.
 *
 * When it has content, points at the block that carries it rather than
 * repeating any of it.
 */
function scratchpadLine(conversationId, scratchpadEnabled) {
  if (!scratchpadEnabled) return 'Scratchpad: not available in this conversation';
  if (!conversationId) return 'Scratchpad: empty';
  let pad = null;
  try {
    pad = dal.getScratchpad(conversationId);
  } catch (err) {
    logger.warn({ msg: err.message }, 'session_state scratchpad lookup failed');
    return 'Scratchpad: empty';
  }
  const content = (pad && pad.content) || '';
  if (content.trim() === '') return 'Scratchpad: empty';
  return `Scratchpad: ${group(content.length)} characters (current content below)`;
}

/**
 * Build the `<session_state>` block.
 *
 * Ordered outermost-first (workspace, project, then what lives inside this
 * conversation), matching how the app nests them.
 *
 * @param {Object} opts
 * @param {Object|null} opts.workspace - workspaces row, or null
 * @param {Object|null} opts.project - projects row, or null
 * @param {string|null} opts.conversationId
 * @param {boolean} opts.scratchpadEnabled - whether the pad is active this request
 * @returns {string} the block, always non-empty
 */
function buildSessionState({ workspace = null, project = null, conversationId = null, scratchpadEnabled = false } = {}) {
  const counts = countFiles(conversationId, workspace, project);
  return [
    '<session_state>',
    containerLine('Workspace', workspace),
    containerLine('Project', project),
    scratchpadLine(conversationId, scratchpadEnabled),
    filesLine(counts),
    '</session_state>',
  ].join('\n');
}

module.exports = { buildSessionState };
