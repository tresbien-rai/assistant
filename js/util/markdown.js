/**
 * Markdown rendering (R-01, moved verbatim from app.js).
 *
 * Reads `marked` and `hljs` off `window` — they are classic CDN scripts loaded
 * before the module entry point in index.html, so they are defined by the time
 * this module is evaluated. `marked.setOptions` runs at import time, exactly as
 * it used to run at this point in the old single-file script.
 *
 * `ICON_SVG` and `messageActionsHTML` live here because they always have —
 * `ICON_SVG.copy` is used by the code-block renderer below. They are really
 * chat-surface helpers and are expected to move to `chat/thread.js` in R-05.
 */

// ===== Markdown Rendering =====

/**
 * Configure marked.js for Markdown rendering with syntax highlighting
 */
marked.setOptions({
    breaks: true,       // Convert \n to <br> in paragraphs
    gfm: true,          // GitHub Flavored Markdown
    headerIds: false,   // Don't add IDs to headers (cleaner output)
    mangle: false       // Don't escape email addresses
});

/**
 * Custom renderer to add syntax highlighting to code blocks
 */
const markedRenderer = new marked.Renderer();

// Override code block rendering to use highlight.js
markedRenderer.code = function(code, language) {
    // Handle the case where marked passes an object instead of separate params
    if (typeof code === 'object') {
        language = code.lang;
        code = code.text;
    }

    const validLanguage = language && hljs.getLanguage(language);
    const highlighted = validLanguage
        ? hljs.highlight(code, { language }).value
        : hljs.highlightAuto(code).value;

    const langClass = validLanguage ? ` class="language-${language}"` : '';
    // Wrap in a positioned container so a copy button can float in the corner.
    // The button carries no code payload itself — the click handler reads the
    // raw text from the sibling <code> element's textContent (markup stripped).
    return `<div class="code-block"><button class="code-copy-btn" type="button" data-action="copy-code" title="Copy code" aria-label="Copy code">${ICON_SVG.copy}</button><pre><code${langClass}>${highlighted}</code></pre></div>`;
};

// Make links open in new tab
markedRenderer.link = function(href, title, text) {
    // Handle the case where marked passes an object
    if (typeof href === 'object') {
        text = href.text;
        title = href.title;
        href = href.href;
    }

    const titleAttr = title ? ` title="${title}"` : '';
    return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
};

marked.setOptions({ renderer: markedRenderer });

/**
 * Render Markdown content to HTML
 * @param {string} content - Raw markdown text
 * @returns {string} - HTML string
 */
export function renderMarkdown(content) {
    if (!content) return '';
    return marked.parse(content);
}

// Feather-style SVG icons for message action buttons — consistent with the
// app's other SVG buttons (send/attach/gear). stroke=currentColor so they
// inherit the theme text color and the hover color.
export const ICON_SVG = {
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>',
    rerun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>',
    delete: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>',
};

// Single source of truth for the per-message action buttons (was duplicated in
// the streaming and static render paths). rerunTitle differs by role.
export function messageActionsHTML(rerunTitle) {
    return `
        <button class="message-action-btn" data-action="copy" title="Copy" aria-label="Copy">${ICON_SVG.copy}</button>
        <button class="message-action-btn" data-action="edit" title="Edit" aria-label="Edit">${ICON_SVG.edit}</button>
        <button class="message-action-btn" data-action="rerun" title="${rerunTitle}" aria-label="${rerunTitle}">${ICON_SVG.rerun}</button>
        <button class="message-action-btn danger" data-action="delete" title="Delete" aria-label="Delete">${ICON_SVG.delete}</button>
    `;
}
