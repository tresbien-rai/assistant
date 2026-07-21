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

module.exports = { formatFileSize, formatFileRevision };
