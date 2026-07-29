/**
 * Formatting and escaping helpers (R-03, moved verbatim from main.js).
 *
 * All pure functions of their arguments — the leaf the file panel and the views
 * stand on. Gathering them here from four different places in the old file
 * exposed two pairs of near-duplicates, which the cleanup slice then merged:
 * formatBytes folded into formatFileSize (one decimal place everywhere), and
 * formatRelativeTime into formatTimeAgo (one wording everywhere). Each pair did
 * almost the same job with different rounding and capitalisation, written months
 * apart, because nothing had ever put them side by side.
 */

// --- Sizes ---
/**
 * Format a byte count as a short human-readable size.
 *
 * NOTE: mirrors the server-side `formatFileSize` in
 * server/src/utils/format.js. The two are intentionally independent across
 * the client/server boundary (no shared bundle); keep their thresholds and
 * formatting in sync if either changes.
 * @param {number} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format a timestamp as relative time (e.g., "2 hours ago")
 * @param {number} timestamp
 * @returns {string}
 */
export function formatTimeAgo(timestamp) {
    if (!timestamp) return '';

    const now = Date.now();
    const diff = now - timestamp;

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;

    // Format as date for older items
    const date = new Date(timestamp);
    return date.toLocaleDateString();
}



// --- HTML escaping ---

/**
 * Escape HTML entities to prevent XSS
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// --- File type / category ---
export function getFileCategory(mimeType) {
    if (!mimeType) return 'document';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType === 'application/pdf' || mimeType === 'text/plain' || mimeType === 'text/csv' || mimeType === 'text/markdown') return 'document';
    if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') return 'code';
    return 'document';
}

export function getFileIcon(mimeType) {
    const category = getFileCategory(mimeType);
    switch (category) {
        case 'image': return '\u{1F5BC}';
        case 'audio': return '\u{1F3B5}';
        case 'code': return '\u{1F4BB}';
        case 'document': return '\u{1F4C4}';
        default: return '\u{1F4CE}';
    }
}

// Short uppercase label for an attachment's type badge — the file extension
// when it's a sane length, else a category fallback (IMG/AUDIO/CODE/DOC).
export function getFileTypeLabel(fileName, mimeType) {
    if (fileName && fileName.includes('.')) {
        const ext = fileName.split('.').pop();
        if (ext && ext.length >= 1 && ext.length <= 4 && /^[a-z0-9]+$/i.test(ext)) {
            return ext.toUpperCase();
        }
    }
    return ({ image: 'IMG', audio: 'AUDIO', code: 'CODE', document: 'DOC' })[getFileCategory(mimeType)] || 'FILE';
}
