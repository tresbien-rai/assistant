/**
 * Sidebar drawer + resize (R-02, moved verbatim from main.js).
 *
 * Its own module rather than part of dom.js to keep the dependency graph
 * acyclic: it needs both `elements` and `UiPrefs` (for the persisted width),
 * and ui-prefs.js already depends on dom.js. Sits between them, and
 * components/dialogs.js sits above it — dialogs close the mobile drawer.
 */

import { elements } from './dom.js';
import { UiPrefs } from './ui-prefs.js';

// ===== Sidebar Functions =====
export function createSidebarOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    overlay.id = 'sidebarOverlay';
    document.body.appendChild(overlay);
    
    overlay.addEventListener('click', closeSidebar);
}

export function openSidebar() {
    elements.sidebar.classList.add('open');
    const overlay = document.getElementById('sidebarOverlay');
    if (overlay) overlay.classList.add('visible');
}

export function closeSidebar() {
    elements.sidebar.classList.remove('open');
    const overlay = document.getElementById('sidebarOverlay');
    if (overlay) overlay.classList.remove('visible');
}

// Drag the handle on the sidebar's right edge to resize it (desktop only).
// Width is clamped, persisted per-device, and reset on double-click. Persists
// once at gesture end (not on every move) to avoid storage thrash.
export function setupSidebarResize() {
    const handle = document.getElementById('sidebarResizeHandle');
    if (!handle) return;

    const MIN_W = 240;
    const maxW = () => Math.min(640, Math.round(window.innerWidth * 0.5));
    const clamp = (w) => Math.max(MIN_W, Math.min(maxW(), Math.round(w)));

    let dragging = false;
    let startX = 0;
    let startW = 0;
    let currentW = UiPrefs.get('sidebarWidth') || 320;

    const applyLive = (w) => {
        currentW = clamp(w);
        document.documentElement.style.setProperty('--sidebar-width', `${currentW}px`);
    };

    handle.addEventListener('pointerdown', (e) => {
        dragging = true;
        startX = e.clientX;
        // Measure the rendered width (honors the min(var, 85vw) cap).
        startW = elements.sidebar.getBoundingClientRect().width;
        handle.classList.add('dragging');
        try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        e.preventDefault();
    });

    handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        applyLive(startW + (e.clientX - startX)); // drag right widens
    });

    const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove('dragging');
        try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        UiPrefs.set('sidebarWidth', currentW); // persist once, at gesture end
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);

    handle.addEventListener('dblclick', () => {
        applyLive(UiPrefs.defaults.sidebarWidth);
        UiPrefs.set('sidebarWidth', currentW);
    });
}

