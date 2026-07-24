/**
 * Scratchpad tool executors (SCRATCHPAD_DESIGN.md, SP-01)
 *
 * The scratchpad is a per-conversation, DB-resident space the user and model
 * think in together — NOT a working file (no Drive). Its defining principle is
 * CHURN: content is replaced/overwritten in place, never appended, so it stays a
 * clean current artifact rather than a growing log.
 *
 * Two tools:
 * - write_scratchpad(content) — the PRIMARY tool: replace the whole pad.
 * - edit_scratchpad(old_text, new_text[, replace_all]) — surgical find/replace.
 *
 * Free-form overwriting is made safe by the append-only revision log
 * (scratchpad_revisions): every change snapshots + diffs, so nothing is lost and
 * any version is restorable (version rail, SP-03). No Drive, so no Drive-less
 * degrade path — these work on dev login.
 *
 * Returns { content, isError?, display? } like the file executors: validation
 * failures RETURN isError results (the model self-corrects); the write itself
 * only touches the DB, so there is no "unexpected failure that throws" path to
 * speak of.
 */

const config = require('../config');
const dal = require('../db/dal');
const { unifiedDiff } = require('../utils/diff');
const { logger } = require('../utils/logger');

/**
 * Count occurrences of `needle` in `haystack`, including overlapping ones, so a
 * self-overlapping old_text can't pass the uniqueness guard and leave a silent
 * half-edit (mirrors edit_file).
 */
function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return count;
}

/**
 * The one write path for the scratchpad (tools + user Save, SP-03). Computes the
 * old→new diff, replaces the content, appends a revision + snapshot, and prunes
 * old snapshots. Pure DB — no Drive.
 * @param {string} conversationId
 * @param {string} newContent
 * @param {Object} meta - { author: 'model'|'user', op: 'write'|'edit', turn?, oldContent? }
 * @returns {{ pad: Object, sizeBytes: number }}
 */
function applyScratchpadWrite(conversationId, newContent, meta) {
  const pad = dal.ensureScratchpad(conversationId);
  const oldContent = meta.oldContent != null ? meta.oldContent : pad.content;
  const bytes = Buffer.byteLength(newContent, 'utf8');

  const diff = unifiedDiff(oldContent || '', newContent, {
    maxChars: config.projectFiles.revisionDiffMaxChars,
  });

  dal.updateScratchpadContent(conversationId, newContent);
  dal.addScratchpadRevision({
    scratchpadId: pad.id,
    conversationId,
    author: meta.author,
    op: meta.op,
    diff,
    sizeBytes: bytes,
    turn: meta.turn == null ? null : meta.turn,
    content: newContent,
  });
  dal.pruneScratchpadSnapshots(pad.id, config.scratchpad.revisionSnapshotKeep);

  return { pad, sizeBytes: bytes };
}

/** A note appended to a successful result when the pad is getting large. */
function sizeWarning(bytes) {
  if (bytes <= config.scratchpad.warnBytes) return '';
  return ' Note: the scratchpad is getting large — remember it is a working space to churn, not a log to grow. Trim superseded content, or if it has become a finished artifact, consider saving it as a file with create_file.';
}

/**
 * write_scratchpad: replace the entire scratchpad.
 * @param {{content?: string}} input
 * @param {Object} ctx - ToolContext ({ userId, conversationId, turnOrdinal })
 */
async function executeWriteScratchpad(input, ctx) {
  if (!ctx.conversationId) {
    return { content: 'The scratchpad is only available inside a saved conversation.', isError: true };
  }
  if (typeof input.content !== 'string') {
    return { content: 'write_scratchpad needs "content" (a string; may be empty to clear the scratchpad).', isError: true };
  }

  const bytes = Buffer.byteLength(input.content, 'utf8');
  if (bytes > config.scratchpad.maxBytes) {
    const mb = (config.scratchpad.maxBytes / (1024 * 1024)).toFixed(1);
    return {
      content: `That scratchpad content is too large (${(bytes / (1024 * 1024)).toFixed(1)}MB; limit ${mb}MB). The scratchpad is for concise working notes — trim it, or save large finished content as a file with create_file.`,
      isError: true,
    };
  }

  const pad = dal.getScratchpad(ctx.conversationId);
  const oldContent = pad ? pad.content : '';
  if (input.content === oldContent) {
    return { content: 'The scratchpad already contains exactly that — nothing changed.' };
  }

  applyScratchpadWrite(ctx.conversationId, input.content, {
    author: 'model',
    op: 'write',
    turn: ctx.turnOrdinal,
    oldContent,
  });

  logger.info({ userId: ctx.userId, conversationId: ctx.conversationId, sizeBytes: bytes }, 'write_scratchpad executed');

  const desc = input.content.length === 0
    ? 'Cleared the scratchpad.'
    : `Updated the scratchpad (now ${input.content.length} characters). The user can see your change as a diff.`;
  return {
    content: desc + sizeWarning(bytes),
    display: { scratchpad: true, op: 'write', sizeBytes: bytes },
  };
}

/**
 * edit_scratchpad: surgical find-and-replace within the scratchpad.
 * @param {{old_text?: string, new_text?: string, replace_all?: boolean}} input
 * @param {Object} ctx - ToolContext
 */
async function executeEditScratchpad(input, ctx) {
  if (!ctx.conversationId) {
    return { content: 'The scratchpad is only available inside a saved conversation.', isError: true };
  }
  if (typeof input.old_text !== 'string' || input.old_text.length === 0) {
    return { content: 'edit_scratchpad needs a non-empty "old_text" — the exact current text to replace.', isError: true };
  }
  if (typeof input.new_text !== 'string') {
    return { content: 'edit_scratchpad needs "new_text" (a string; may be empty to delete old_text).', isError: true };
  }
  if (input.old_text === input.new_text) {
    return { content: 'old_text and new_text are identical — there is nothing to change.', isError: true };
  }
  const replaceAll = input.replace_all === true;

  const pad = dal.getScratchpad(ctx.conversationId);
  const current = pad ? pad.content : '';
  if (current.length === 0) {
    return { content: 'The scratchpad is empty. Use write_scratchpad to put content in it first.', isError: true };
  }

  const occurrences = countOccurrences(current, input.old_text);
  if (occurrences === 0) {
    return {
      content: 'old_text was not found in the scratchpad. It must match the current content exactly, including whitespace and line breaks.',
      isError: true,
    };
  }
  if (occurrences > 1 && !replaceAll) {
    return {
      content: `old_text appears ${occurrences} times in the scratchpad. Include more surrounding context so it matches exactly once, or set replace_all to true.`,
      isError: true,
    };
  }

  // Function replacer / split-join insert new_text verbatim (no $-pattern
  // interpretation), mirroring edit_file.
  let updated;
  let replacements = 1;
  if (replaceAll) {
    const parts = current.split(input.old_text);
    replacements = parts.length - 1;
    updated = parts.join(input.new_text);
  } else {
    updated = current.replace(input.old_text, () => input.new_text);
  }

  const bytes = Buffer.byteLength(updated, 'utf8');
  if (bytes > config.scratchpad.maxBytes) {
    const mb = (config.scratchpad.maxBytes / (1024 * 1024)).toFixed(1);
    return { content: `That edit would make the scratchpad too large (limit ${mb}MB).`, isError: true };
  }

  applyScratchpadWrite(ctx.conversationId, updated, {
    author: 'model',
    op: 'edit',
    turn: ctx.turnOrdinal,
    oldContent: current,
  });

  logger.info({ userId: ctx.userId, conversationId: ctx.conversationId, sizeBytes: bytes, replacements, replaceAll }, 'edit_scratchpad executed');

  const replacedNote = replaceAll && replacements > 1 ? ` (${replacements} occurrences)` : '';
  return {
    content: `Edited the scratchpad${replacedNote} — now ${updated.length} characters.` + sizeWarning(bytes),
    display: { scratchpad: true, op: 'edit', sizeBytes: bytes },
  };
}

/**
 * Roll the scratchpad back before a re-roll (SP-04, the DB-only analogue of
 * FC-06a's revertConversationFiles — which routes through Drive and bails when
 * it is unavailable, so the pad needs its own branch). Undoes MODEL pad writes
 * at/after `fromTurn` by restoring the newest snapshot from before the turn
 * (empty if the pad had no earlier content), then drops the undone revisions.
 *
 * Mirrors FC-06a's scope: a pad the model did NOT write to in the undone span is
 * left alone (nothing to undo), so a user's own edits outside a model-churned
 * span are preserved. Restoring writes NO new revision — an undo is not a change.
 *
 * @param {string} conversationId
 * @param {number} fromTurn
 * @returns {{ reverted: boolean }}
 */
function revertScratchpad(conversationId, fromTurn) {
  if (!conversationId || !(fromTurn > 0)) return { reverted: false };
  const pad = dal.getScratchpad(conversationId);
  if (!pad) return { reverted: false };

  // Only act if the model changed the pad in the undone span.
  const modelRevs = dal.getScratchpadModelRevisionsFromTurn(conversationId, fromTurn);
  if (modelRevs.length === 0) return { reverted: false };

  const snap = dal.getScratchpadSnapshotBeforeTurn(pad.id, fromTurn);
  const restored = snap && snap.content != null ? snap.content : '';
  dal.updateScratchpadContent(conversationId, restored); // no revision (undo, not a change)
  dal.deleteScratchpadRevisionsFromTurn(pad.id, fromTurn); // drop undone history

  logger.info({ conversationId, fromTurn, restoredChars: restored.length }, 'reverted scratchpad');
  return { reverted: true };
}

module.exports = {
  executeWriteScratchpad,
  executeEditScratchpad,
  applyScratchpadWrite,
  revertScratchpad,
  _countOccurrences: countOccurrences,
};
