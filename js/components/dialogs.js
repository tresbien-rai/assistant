/**
 * In-app confirm and name-prompt dialogs (R-02, moved verbatim from main.js).
 *
 * These exist because native confirm()/prompt() can be permanently suppressed
 * by the browser, after which every guarded action silently does nothing.
 * See CLAUDE.md — nothing in this app may call the native dialogs.
 */

import { elements } from '../dom.js';
import { closeSidebar } from '../sidebar.js';

// ===== Confirm dialog =====
// Replaces window.confirm(). Browsers let users permanently suppress native
// dialogs ("prevent this page from creating additional dialogs"); once ticked,
// confirm() returns false forever and every guarded action silently does
// nothing. Promise-based — resolves true to proceed, false to cancel.
let _confirmResolve = null;
let _confirmLastFocus = null;
let _confirmPrevOverflow = '';

/**
 * Ask the user to confirm an action.
 * `title` and `body` are set as text, never HTML — they routinely interpolate
 * user-controlled names (personas, files, imported .tessera bundles).
 * @param {{title?:string, body?:string, confirmLabel?:string, cancelLabel?:string, danger?:boolean}} [opts]
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
    title = 'Are you sure?',
    body = '',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    danger = false,
} = {}) {
    // Never stack: a second call cancels whatever is already on screen.
    if (_confirmResolve) closeConfirmDialog(false);

    return new Promise(resolve => {
        _confirmResolve = resolve;
        _confirmLastFocus = document.activeElement;

        elements.confirmModalTitle.textContent = title;
        elements.confirmModalBody.textContent = body;
        elements.confirmModalBody.style.display = body ? '' : 'none';
        elements.confirmModalConfirmBtn.textContent = confirmLabel;
        elements.confirmModalCancelBtn.textContent = cancelLabel;
        elements.confirmModalConfirmBtn.classList.toggle('danger', danger);
        elements.confirmModalConfirmBtn.classList.toggle('primary', !danger);

        _confirmPrevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        elements.confirmModal.classList.add('visible');

        // Esc/Tab are handled on the document (capture) rather than on the
        // dialog, so they still work if focus is somehow outside it.
        document.addEventListener('keydown', _confirmKeydown, true);

        // Destructive actions focus Cancel, so a stray Enter can't destroy
        // anything; everything else focuses Confirm. Enter then activates the
        // focused button natively — no extra key handling needed.
        // The styles deliberately keep `visibility` out of this dialog's
        // transitions so the buttons are focusable in this same tick; the
        // next-frame retry is a backstop in case that ever regresses.
        const initial = danger ? elements.confirmModalCancelBtn : elements.confirmModalConfirmBtn;
        initial.focus();
        if (document.activeElement !== initial) {
            requestAnimationFrame(() => {
                if (_confirmResolve) initial.focus();
            });
        }
    });
}

/**
 * Key handling while the confirm dialog is open. Bound to the document in the
 * capture phase so it runs before anything underneath (the dialog can be opened
 * from inside another modal that has its own Esc handler).
 */
function _confirmKeydown(e) {
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeConfirmDialog(false);
        return;
    }
    if (e.key === 'Tab') {
        // Two focusable elements, so Tab just toggles. Starting from anywhere
        // else — including <body> — this pulls focus into the dialog rather
        // than letting it walk the page behind.
        e.preventDefault();
        e.stopPropagation();
        const next = document.activeElement === elements.confirmModalCancelBtn
            ? elements.confirmModalConfirmBtn
            : elements.confirmModalCancelBtn;
        next.focus();
    }
}

/** Close the confirm dialog, resolving the pending promise with `result`. */
export function closeConfirmDialog(result) {
    document.removeEventListener('keydown', _confirmKeydown, true);
    elements.confirmModal.classList.remove('visible');
    document.body.style.overflow = _confirmPrevOverflow;

    // Hand focus back to whatever opened the dialog, if it's still around.
    if (_confirmLastFocus?.isConnected) _confirmLastFocus.focus();
    _confirmLastFocus = null;

    const resolve = _confirmResolve;
    _confirmResolve = null;
    if (resolve) resolve(result);
}

// ===== Name modal =====
// Asks for a single line of text. Used to create containers (the caller then
// opens the new container's inline page to fill in the rest) and to rename a
// chat. Promise-based — resolves to the trimmed name, or null if cancelled.
// Also the replacement for window.prompt(), which browsers can suppress just
// like confirm() — see the note on confirmDialog().
let _namePromptResolve = null;

/**
 * Show the name modal and resolve with the entered name (or null).
 * @param {{title?:string, label?:string, placeholder?:string, value?:string, confirmLabel?:string}} [opts]
 * @returns {Promise<string|null>}
 */
export function promptName({ title = 'New', label = 'Name', placeholder = '', value = '', confirmLabel = 'Create' } = {}) {
    // If one is somehow already open, cancel it before reusing the modal.
    if (_namePromptResolve) closeNameModal(null);
    return new Promise(resolve => {
        _namePromptResolve = resolve;
        elements.nameModalTitle.textContent = title;
        elements.nameModalLabel.textContent = label;
        elements.nameModalInput.value = value;
        elements.nameModalInput.placeholder = placeholder;
        elements.nameModalSaveBtn.textContent = confirmLabel;
        closeSidebar(); // close the mobile drawer if open
        elements.nameModal.classList.add('visible');
        // Works because .modal-overlay flips visibility without waiting on the
        // transition — see the comment on .modal-overlay in styles.css.
        elements.nameModalInput.focus();
        // Renaming starts with the old name in place: select it so typing
        // replaces it, rather than landing the caret at position 0.
        if (value) elements.nameModalInput.select();
    });
}

/** Close the name modal, resolving the pending promise with `result`. */
export function closeNameModal(result = null) {
    elements.nameModal.classList.remove('visible');
    const resolve = _namePromptResolve;
    _namePromptResolve = null;
    if (resolve) resolve(result);
}

/** Submit the name modal (Create button / Enter): resolve with the trimmed name. */
export function submitNameModal() {
    const name = elements.nameModalInput.value.trim();
    if (!name) {
        elements.nameModalInput.focus();
        return;
    }
    closeNameModal(name);
}

/**
 * Open a container's inline page in the main area. Also syncs the active-
 * container navigation (breadcrumb + sidebar drill level) to match.
 * @param {'workspace'|'project'} kind
 * @param {string} id
 */
