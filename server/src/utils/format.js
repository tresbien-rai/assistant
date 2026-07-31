/**
 * Small shared formatting helpers (server-side).
 *
 * NOTE: the frontend has its own `formatFileSize` (app.js, ~L3826) for
 * attachment cards. The two are intentionally independent across the
 * client/server boundary (no shared bundle); keep their thresholds and
 * formatting in sync if either changes.
 */

/**
 * Human-readable byte size: "820 B", "4.2 KB", "1.3 MB". Bounded precision so
 * float artifacts never reach the output.
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format a file_revisions row for API responses (File Collaboration, FC-04):
 * snake_case → camelCase, shared by every scope's revisions endpoint.
 * @param {Object} rev - file_revisions row
 * @returns {Object}
 */
function formatFileRevision(rev) {
  return {
    id: rev.id,
    author: rev.author,
    op: rev.op,
    diff: rev.diff,
    sizeBytes: rev.size_bytes,
    turn: rev.turn,
    // Whether this version's full content is still stored (FC-06b) — i.e. it can
    // be restored. The snapshot itself is not sent in the list (it can be large).
    hasSnapshot: rev.content != null,
    createdAt: rev.created_at,
  };
}

/**
 * Group digits so long counts stay readable in a tool result: 3860 -> "3,860".
 * @param {number} n
 * @returns {string}
 */
function groupDigits(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Describe what an edit actually DID, for the result an editing tool hands back
 * to the model (docs/SESSION_STATE_DESIGN.md, D1).
 *
 * A total size alone cannot confirm an edit landed — the same number before and
 * after reads identically — so the model had to re-read the file or pad to be
 * sure. The replacement count plus before -> after is that confirmation, and the
 * signed delta makes the direction obvious at a glance.
 *
 * Shared by edit_file and edit_scratchpad so the two report success the same
 * way; two editing tools with different success shapes is its own confusion.
 *
 * @param {number} replacements - how many sites were replaced
 * @param {number} before - size/length before the edit
 * @param {number} after - size/length after the edit
 * @param {'characters'|'bytes'} unit - 'bytes' formats via formatFileSize
 * @returns {string} e.g. "1 replacement, 3,860 -> 3,700 characters (-160)."
 */
function describeEdit(replacements, before, after, unit = 'characters') {
  const n = Math.max(1, Number(replacements) || 1);
  const plural = n === 1 ? 'replacement' : 'replacements';

  const delta = after - before;
  // U+2212 MINUS SIGN reads unambiguously next to a hyphenated filename.
  const sign = delta < 0 ? '−' : '+';
  const magnitude = Math.abs(delta);

  if (unit === 'bytes') {
    const change = delta === 0 ? 'no size change' : `${sign}${formatFileSize(magnitude)}`;
    return `${n} ${plural}, ${formatFileSize(before)} → ${formatFileSize(after)} (${change}).`;
  }
  const change = delta === 0 ? 'same length' : `${sign}${groupDigits(magnitude)}`;
  return `${n} ${plural}, ${groupDigits(before)} → ${groupDigits(after)} characters (${change}).`;
}

module.exports = { formatFileSize, formatFileRevision, describeEdit, groupDigits };
