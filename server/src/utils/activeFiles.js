/**
 * Active-file injection (File Collaboration, FC-03b)
 *
 * Surfaces the file(s) a chat is actively working on directly in the request, so
 * the model can discuss or continue editing "the document we just changed"
 * without spending a read_file round trip. Recency-scoped: a file is injected
 * only for the `activeFileTurns` turns following its last create/edit, then it
 * falls out and the model reads it on demand again.
 *
 * Scope: CONVERSATION files only. Project/workspace file content already rides in
 * the knowledge-base block, so re-injecting it here would duplicate tokens; only
 * chat-created files (which are otherwise tool-read) need full re-injection.
 *
 * Turn model: each revision is stamped with the user-message count at write time
 * (FC-03b). The request being assembled is turn `currentTurn` (its user-message
 * count). A file whose latest revision was stamped `turn` has age
 * `currentTurn - turn`; it is live when `1 <= age <= activeFileTurns`. (Age 0 —
 * a write during THIS turn's own tool loop — doesn't exist yet at assembly, and
 * would already be in the tool result anyway.)
 *
 * Inject modes (Context toggles, CT-02) override that window per file:
 *   'auto' (default) → the recency window described above
 *   'pin'            → injected EVERY turn regardless of age, and regardless of
 *                      `activeFileTurns` (pinning is an explicit per-file
 *                      instruction; the setting only governs the auto window)
 *   'mute'           → never injected, even immediately after an edit
 * Pinned files are selected first and take priority for the MAX_ACTIVE_FILES
 * slots, since they were chosen deliberately while the window is automatic.
 *
 * Best-effort: any failure (Drive down, a since-deleted file) degrades to
 * "no injection" — never an error. The model can always read_file instead.
 */

const config = require('../config');
const dal = require('../db/dal');
const drive = require('./drive');
const { extractFileText } = require('./projectContext');
const { resolveInjectMode } = require('./contextState');
const { logger } = require('./logger');

// Cap how many active files and how much of each we inject, so a burst of edits
// or a huge file can't blow up the prompt. Content reuses the read_file cap.
const MAX_ACTIVE_FILES = 5;
const MAX_CONTENT_CHARS = config.projectFiles.toolReadMaxChars;

/**
 * The latest revision per file (input is newest-first), keeping only files whose
 * latest change is inside the recency window.
 * @param {Array} revisionsNewestFirst
 * @param {number} currentTurn
 * @param {number} activeFileTurns
 * @param {{ limit?: number, isEligible?: (fileId: string) => boolean }} [opts]
 *   `isEligible` lets the caller exclude files handled elsewhere (pinned) or
 *   excluded outright (muted); `limit` caps how many slots remain.
 * @returns {Array} latest revision per in-window file, most-recent first
 */
function selectActiveRevisions(revisionsNewestFirst, currentTurn, activeFileTurns, opts = {}) {
  const limit = opts.limit ?? MAX_ACTIVE_FILES;
  const isEligible = opts.isEligible || (() => true);

  const seen = new Set();
  const active = [];
  if (limit <= 0) return active;

  for (const rev of revisionsNewestFirst) {
    if (seen.has(rev.file_id)) continue; // newest-first → first seen is the latest
    seen.add(rev.file_id);
    if (!isEligible(rev.file_id)) continue;
    if (rev.turn == null) continue;
    const age = currentTurn - rev.turn;
    if (age >= 1 && age <= activeFileTurns) active.push(rev);
    if (active.length >= limit) break;
  }
  return active;
}

/** The latest revision per file id, from a newest-first revision list. */
function latestRevisionByFile(revisionsNewestFirst) {
  const latest = new Map();
  for (const rev of revisionsNewestFirst) {
    if (!latest.has(rev.file_id)) latest.set(rev.file_id, rev);
  }
  return latest;
}

/** Human phrase for who/what/when a change was, for the injected header. */
function describeChange(rev, age) {
  const who = rev.author === 'user' ? 'the user' : 'you';
  const turns = age === 1 ? '1 turn ago' : `${age} turns ago`;
  return `${rev.op} by ${who}, ${turns}`;
}

/**
 * The `last_change` attribute for one injected file. A pinned file says so
 * first — the model should understand it is present because the user asked for
 * it, not because it was just touched — and still reports its last change when
 * there is one to report.
 * @param {Object|null} rev - the file's latest revision, if any
 * @param {number} currentTurn
 * @param {boolean} pinned
 * @returns {string}
 */
function describeInjectedFile(rev, currentTurn, pinned) {
  const change = rev && rev.turn != null ? describeChange(rev, currentTurn - rev.turn) : null;
  if (!pinned) return change || 'unchanged';
  return change ? `pinned by the user; last ${change}` : 'pinned by the user';
}

/**
 * Build the `<active_files>` block for a conversation, or null when there is
 * nothing live to inject.
 * @param {string} userId
 * @param {string|null} conversationId
 * @param {number} currentTurn - user-message count of the request being assembled
 * @param {number} activeFileTurns - the user's setting (0 disables injection)
 * @returns {Promise<string|null>}
 */
async function resolveActiveFileBlock(userId, conversationId, currentTurn, activeFileTurns) {
  if (!conversationId || !(currentTurn > 0)) return null;

  // Inject modes first (CT-02): pinned files bypass the recency window entirely,
  // muted files are excluded from it. Note this means a pinned file still
  // injects when activeFileTurns is 0 — that setting governs the AUTO window,
  // not an explicit per-file instruction.
  const files = dal.listConversationFiles(conversationId);
  const modes = new Map(files.map((f) => [f.id, resolveInjectMode(f)]));
  const pinnedFiles = files.filter((f) => modes.get(f.id) === 'pin').slice(0, MAX_ACTIVE_FILES);

  const revisions = dal.listConversationFileRevisions(conversationId);
  const latestRevs = latestRevisionByFile(revisions);

  const windowed = activeFileTurns > 0
    ? selectActiveRevisions(revisions, currentTurn, activeFileTurns, {
        limit: MAX_ACTIVE_FILES - pinnedFiles.length,
        // Pinned files are already in; muted files never are.
        isEligible: (fileId) => (modes.get(fileId) || 'auto') === 'auto',
      })
    : [];

  // Pinned first — deliberate choices outrank the automatic window.
  const entries = [
    ...pinnedFiles.map((file) => ({ file, rev: latestRevs.get(file.id) || null, pinned: true })),
    ...windowed.map((rev) => ({ file: null, fileId: rev.file_id, rev, pinned: false })),
  ];
  if (entries.length === 0) return null;

  let auth;
  try {
    auth = drive.getAuthForUser(userId);
  } catch (err) {
    // Drive-less (e.g. dev login): skip injection, the model can read_file.
    logger.warn({ userId, conversationId, code: err.code }, 'active-file injection skipped: Drive unavailable');
    return null;
  }

  const sections = [];
  for (const entry of entries) {
    const file = entry.file || dal.getConversationFile(entry.fileId, conversationId);
    if (!file || !file.drive_file_id) continue; // deleted/replaced since — skip

    let content;
    try {
      content = await extractFileText(auth, file);
    } catch (err) {
      logger.warn({ userId, conversationId, fileId: file.id, msg: err.message }, 'active-file injection: read failed; skipping file');
      continue;
    }

    let truncatedNote = '';
    if (content.length > MAX_CONTENT_CHARS) {
      content = content.slice(0, MAX_CONTENT_CHARS);
      truncatedNote = ' (truncated)';
    }

    const rev = entry.rev;
    // A pinned file's diff is only meaningful while it is fresh; an old diff
    // re-sent every turn is noise. Auto-window files are fresh by definition.
    const showDiff = rev?.diff && (!entry.pinned || (rev.turn != null && currentTurn - rev.turn <= (activeFileTurns || 1)));

    sections.push(
      `<file name="${file.filename}" last_change="${describeInjectedFile(rev, currentTurn, entry.pinned)}">\n` +
      `<current_content${truncatedNote ? ' note="truncated"' : ''}>\n${content}\n</current_content>\n` +
      (showDiff ? `<latest_diff>\n${rev.diff}\n</latest_diff>\n` : '') +
      `</file>`
    );
  }

  if (sections.length === 0) return null;

  return [
    '<active_files>',
    "The file(s) below are live in this conversation — either recently created/edited, or pinned by the user. Their full current saved content is shown so you can discuss or keep editing them without calling read_file, along with the diff of the most recent change where one is recent. Treat this as the authoritative current state.",
    '',
    sections.join('\n\n'),
    '</active_files>',
  ].join('\n');
}

/**
 * Append a text block to the last user message of a messages array, returning a
 * NEW array (never mutates the caller's messages). Handles both string content
 * and Anthropic-style content-block arrays. If there is no user message, returns
 * the array unchanged.
 * @param {Array} messages
 * @param {string} block
 * @returns {Array}
 */
function appendToLastUserMessage(messages, block) {
  if (!block) return messages;
  const idx = [...messages].reverse().findIndex((m) => m.role === 'user');
  if (idx === -1) return messages;
  const realIdx = messages.length - 1 - idx;
  const target = messages[realIdx];

  let newContent;
  if (typeof target.content === 'string') {
    newContent = `${target.content}\n\n${block}`;
  } else if (Array.isArray(target.content)) {
    newContent = [...target.content, { type: 'text', text: block }];
  } else {
    // Unexpected shape — leave it alone rather than risk corrupting the message.
    return messages;
  }

  const copy = messages.slice();
  copy[realIdx] = { ...target, content: newContent };
  return copy;
}

module.exports = {
  resolveActiveFileBlock,
  appendToLastUserMessage,
  // exported for tests
  _selectActiveRevisions: selectActiveRevisions,
  _describeInjectedFile: describeInjectedFile,
};
