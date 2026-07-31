/**
 * Resizable textarea wiring — the themed bottom drag-bar that replaces the
 * native corner grip.
 *
 * Lives in components/ because four different views now render one (persona
 * system prompt, container Instructions, preset block text, model prefill) and
 * a view should not have to import another view to get it. Pair it with the
 * `.textarea-resizable` wrapper markup:
 *
 *   <div class="textarea-resizable">
 *     <textarea id="…"></textarea>
 *     <div class="textarea-resize-handle" aria-hidden="true" title="Drag to resize"></div>
 *   </div>
 *
 * The handle resizes the textarea IMMEDIATELY BEFORE it, so the two must stay
 * siblings in that order.
 */

import { UiPrefs } from '../ui-prefs.js';

/**
 * Wire every unwired `.textarea-resize-handle` on the page.
 *
 * Idempotent (skips already-wired handles): called once at init for the static
 * forms, and again whenever a view renders a fresh handle. Dragged heights
 * persist in UiPrefs keyed by the textarea's id, so a re-rendered textarea
 * keeps its size — give the textarea an id if you want that.
 */
export function setupTextareaResizers() {
    const MIN_H = 80;
    const MAX_H = 600;
    const savedHeights = UiPrefs.get('textareaHeights') || {};
    document.querySelectorAll('.textarea-resize-handle').forEach(handle => {
        const ta = handle.previousElementSibling;
        if (!ta || ta.tagName !== 'TEXTAREA') return;
        if (handle.dataset.resizerWired) return;
        handle.dataset.resizerWired = 'true';

        if (ta.id && savedHeights[ta.id]) {
            ta.style.height = `${Math.max(MIN_H, Math.min(MAX_H, savedHeights[ta.id]))}px`;
        }

        let dragging = false;
        let startY = 0;
        let startH = 0;

        handle.addEventListener('pointerdown', (e) => {
            dragging = true;
            startY = e.clientY;
            startH = ta.getBoundingClientRect().height;
            handle.classList.add('dragging');
            try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
            e.preventDefault();
        });

        handle.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const h = Math.max(MIN_H, Math.min(MAX_H, startH + (e.clientY - startY)));
            ta.style.height = `${h}px`;
        });

        const end = (e) => {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('dragging');
            try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
            if (ta.id) {
                const heights = { ...(UiPrefs.get('textareaHeights') || {}) };
                heights[ta.id] = Math.round(ta.getBoundingClientRect().height);
                UiPrefs.set('textareaHeights', heights);
            }
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    });
}
