/**
 * Small shared formatting helpers (server-side).
 *
 * NOTE: the frontend has its own `formatFileSize` (app.js) for attachment
 * cards. The two are intentionally independent across the client/server
 * boundary; keep their thresholds in sync if either changes.
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

module.exports = { formatFileSize };
