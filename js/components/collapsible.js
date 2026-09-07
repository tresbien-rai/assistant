/**
 * Collapsible list sections.
 *
 * The Chats view already had one shape for a long list — a header you can
 * collapse, with the "+ New chat" action at the TOP where you land rather than
 * below however many rows happen to exist. Container pages (workspace and
 * project) had another: no collapsing, and the action stranded at the bottom,
 * so starting a new chat in a busy workspace meant scrolling past everything
 * first. This is that first shape, factored out so both use it.
 *
 * TWO THINGS TO KNOW BEFORE CHANGING THIS:
 *
 * 1. **The head is a `<div>`, not a `<button>`.** It contains a toggle button
 *    AND an action button, and a button inside a button is invalid HTML — the
 *    browser closes the outer one early, which silently drops the action from
 *    the accessibility tree and breaks its click target.
 *
 * 2. **Toggling is local DOM, never a re-render.** The container page holds an
 *    editable Instructions textarea whose unsaved text lives only in the DOM,
 *    so re-rendering the page to collapse a list underneath it would throw the
 *    user's typing away. (The Chats view can re-render safely — it has no
 *    unsaved state — but doing it the same way everywhere means one less rule
 *    to remember.)
 *
 * Collapse state is in-memory only, matching how the persona groups have
 * always behaved: a fresh load shows everything expanded.
 */

import { state } from '../state.js';
import { escapeHtml } from '../util/format.js';

/** Shares `.group-chevron` with the persona groups, so both rotate identically. */
const chevron = (collapsed) =>
    `<svg class="group-chevron${collapsed ? ' collapsed' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

/** Is this section currently collapsed? */
export function isSectionCollapsed(key) {
    return state.ui.collapsedSections.has(key);
}

/**
 * The head of a collapsible section: chevron + label + count on the left, an
 * optional action button on the right.
 *
 * @param {Object} opts
 * @param {string} opts.key - stable id for the collapse state, e.g. `ws:<id>:chats`
 * @param {string} opts.label - section label
 * @param {number} [opts.count] - item count, omitted when undefined
 * @param {string} [opts.action] - raw HTML for the right-hand action button
 * @returns {string}
 */
export function sectionHeadHTML({ key, label, count, action = '' }) {
    const collapsed = isSectionCollapsed(key);
    const countHTML = typeof count === 'number'
        ? `<span class="cp-section-count">${count}</span>` : '';
    return `
        <div class="cp-section-head">
            <button class="cp-section-toggle" type="button"
                    data-section-key="${escapeHtml(key)}"
                    aria-expanded="${collapsed ? 'false' : 'true'}">
                ${chevron(collapsed)}
                <span class="cp-section-label">${escapeHtml(label)}</span>
                ${countHTML}
            </button>
            ${action}
        </div>`;
}

/**
 * The body wrapper. Capped in CSS so one long list cannot push every other
 * section off the page; it scrolls inside itself instead.
 */
export function sectionBodyHTML(key, inner) {
    return `<div class="cp-section-body" data-section-body="${escapeHtml(key)}"${isSectionCollapsed(key) ? ' hidden' : ''}>${inner}</div>`;
}

/**
 * Wire every collapsible head inside `root`. Idempotent per render: call it
 * once after writing the markup.
 */
export function wireSectionToggles(root) {
    root.querySelectorAll('.cp-section-toggle').forEach((toggle) => {
        toggle.addEventListener('click', () => {
            const key = toggle.dataset.sectionKey;
            const body = root.querySelector(`[data-section-body="${CSS.escape(key)}"]`);
            const collapsed = !isSectionCollapsed(key);

            if (collapsed) state.ui.collapsedSections.add(key);
            else state.ui.collapsedSections.delete(key);

            toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            toggle.querySelector('.group-chevron')?.classList.toggle('collapsed', collapsed);
            if (body) body.hidden = collapsed;
        });
    });
}
