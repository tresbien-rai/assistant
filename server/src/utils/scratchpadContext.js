/**
 * Scratchpad injection (SCRATCHPAD_DESIGN.md, SP-02)
 *
 * Builds the `<scratchpad>` block appended to the last user message when the
 * scratchpad is active and non-empty. Unlike the active-file block (FC-03b),
 * this is NOT recency-windowed: the scratchpad is the always-current shared
 * artifact, so its full content rides EVERY turn it is non-empty. The changelog
 * shows the last few diffs (Decision 7) so the model sees the recent arc of the
 * back-and-forth, not just the latest edit.
 *
 * Empty-skip (Decision 5): an empty pad injects nothing — no "the scratchpad is
 * empty" filler. The tools are still advertised (so the model can start one).
 *
 * DB-resident, no Drive: any failure would be a programming error, not an
 * environment one, so there is no best-effort Drive degrade like activeFiles has.
 */

const config = require('../config');
const dal = require('../db/dal');

// Cap the injected content so a large pad can't dominate the prompt (the churn
// principle is the real defence; this is a hard ceiling). Reuses the read_file cap.
const MAX_CONTENT_CHARS = config.projectFiles.toolReadMaxChars;

/** Human "N turns ago" phrase for a change, or '' when the turn is unknown. */
function whenPhrase(age) {
  if (age == null) return '';
  if (age <= 0) return 'this turn';
  if (age === 1) return '1 turn ago';
  return `${age} turns ago`;
}

/**
 * Build the `<scratchpad>` block for a conversation, or null when the pad is
 * absent/empty (empty-skip).
 * @param {string|null} conversationId
 * @param {number} currentTurn - user-message count of the request being assembled
 * @param {number} [diffCount] - how many recent diffs to include (Decision 7)
 * @returns {string|null}
 */
function resolveScratchpadBlock(conversationId, currentTurn, diffCount = config.scratchpad.injectDiffCount) {
  if (!conversationId) return null;

  const pad = dal.getScratchpad(conversationId);
  if (!pad || !pad.content || pad.content.trim() === '') return null; // empty-skip

  let content = pad.content;
  let truncatedNote = '';
  if (content.length > MAX_CONTENT_CHARS) {
    content = content.slice(0, MAX_CONTENT_CHARS);
    truncatedNote = ' note="truncated"';
  }

  // Recent changes, newest first (listScratchpadRevisions is oldest-first).
  const revs = dal.listScratchpadRevisions(pad.id);
  const recent = revs.slice(Math.max(0, revs.length - diffCount)).reverse();
  const changeSections = recent
    .filter((rev) => rev.diff && rev.diff.length > 0)
    .map((rev) => {
      const who = rev.author === 'user' ? 'the user' : 'you';
      const when = rev.turn == null ? '' : whenPhrase(currentTurn - rev.turn);
      return (
        `<change by="${who}"${when ? ` when="${when}"` : ''}>\n` +
        `${rev.diff}\n` +
        `</change>`
      );
    });

  return [
    '<scratchpad>',
    "The shared scratchpad's current content is below — the live state of your and the user's shared thinking. Keep developing it here (write_scratchpad / edit_scratchpad), replacing and trimming in place rather than appending. In your reply, discuss and point to it rather than restating its contents. Recent changes follow so you can see the back-and-forth.",
    '',
    `<current_content${truncatedNote}>`,
    content,
    '</current_content>',
    ...(changeSections.length
      ? ['', '<recent_changes>', changeSections.join('\n'), '</recent_changes>']
      : []),
    '</scratchpad>',
  ].join('\n');
}

module.exports = { resolveScratchpadBlock };
