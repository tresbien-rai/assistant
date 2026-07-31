/**
 * The Personas view (R-04b, moved verbatim from main.js).
 *
 * The persona tile grid, the card menu, the persona popover, create/edit/delete,
 * and the `.tessera` bundle export/import — including the image normalisation
 * that shrinks avatars and expressions before they go into a bundle.
 *
 * The bundle exporter's blob helpers (`blobToBase64`, `downloadBlob`) moved to
 * util/blob.js once they had a second caller.
 */

import { state } from '../state.js';
import { elements } from '../dom.js';
import { API } from '../api-client.js';
import { CONFIG } from '../config.js';
import { navigate, updateUI } from '../shell.js';
import { getActivePersona } from '../state.js';
import {
    personaAvatarHTML, createPersona, applyPersonaModelSettings, hydratePersonas,
} from '../persona-helpers.js';
import { savePersonas } from '../settings-store.js';
import { renderConversationList, renderConversation } from './chats.js';
import { setActiveConversation, forgetConversationDraft } from '../active-conversation.js';
import { UiPrefs } from '../ui-prefs.js';
import { escapeHtml, formatFileSize } from '../util/format.js';
import { blobToBase64, downloadBlob } from '../util/blob.js';
import { positionPopover, attachPopoverOutsideClose } from '../components/menus.js';
import { showToast } from '../components/toast.js';
import { displayError } from '../components/errors.js';
import { confirmDialog } from '../components/dialogs.js';

/**
 * Switch the active persona (from the top-bar persona popover). With the home
 * chat list grouped by persona, this just sets the active persona, makes sure
 * its group is expanded, and shows the home view scrolled to that group.
 * @param {string} personaId
 */
export async function switchPersona(personaId) {
    if (!state.personas[personaId]) return;

    state.activePersonaId = personaId;
    applyPersonaModelSettings(getActivePersona()); // fixed mode loads its settings
    state.ui.collapsedPersonaGroups.delete(personaId);

    // Leaving any workspace so the persona's grouped chats are actually visible
    // (inside a workspace the list is workspace-scoped, not persona-grouped).
    if (state.activeProjectId) {
        state.activeProjectId = null;
        UiPrefs.set('activeProject', null);
    }

    savePersonas();
    await updateUI();
    navigate({ type: 'chats' });

    const groupEl = document.querySelector(`.persona-group[data-persona-id="${CSS.escape(personaId)}"]`);
    if (groupEl) groupEl.scrollIntoView({ block: 'nearest' });
}

/**
 * Edit a persona - switch to it and open settings tab
 * @param {string} personaId
 */
export function editPersona(personaId) {
    if (!state.personas[personaId]) return;

    state.activePersonaId = personaId;
    applyPersonaModelSettings(getActivePersona()); // fixed mode loads its settings
    savePersonas();
    updateUI();
    navigate({ type: 'persona-edit' });
}

/**
 * Top-bar persona button popover: edit the current persona, create a new one,
 * or jump to another persona's chats. Switching does NOT reassign the current
 * conversation — see docs/PHASE2_UX_DESIGN.md.
 * @param {HTMLElement} anchorEl
 */
export function showPersonaPopover(anchorEl) {
    const existing = document.querySelector('.context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu context-menu-wide';

    let html = '';
    html += `<button class="context-menu-item" data-action="edit">Edit persona</button>`;
    html += `<button class="context-menu-item" data-action="new">+ New persona</button>`;
    if (state.activePersonaId) {
        html += `<button class="context-menu-item danger" data-action="delete">Delete persona</button>`;
    }

    const personas = Object.values(state.personas)
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (personas.length > 0) {
        html += `<div class="context-menu-separator"></div>`;
        html += `<div class="context-menu-label">Switch persona</div>`;
        personas.forEach(p => {
            const active = p.id === state.activePersonaId ? ' active' : '';
            html += `<button class="context-menu-item${active}" data-persona-id="${escapeHtml(p.id)}">${escapeHtml(p.name || 'Untitled')}</button>`;
        });
    }
    menu.innerHTML = html;

    positionPopover(menu, anchorEl, 'left');

    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', () => {
            menu.remove();
            const action = item.dataset.action;
            if (action === 'edit') {
                if (state.activePersonaId) editPersona(state.activePersonaId);
            } else if (action === 'new') {
                startNewPersona();
            } else if (action === 'delete') {
                if (state.activePersonaId) deletePersonaPrompt(state.activePersonaId);
            } else if (item.dataset.personaId) {
                switchPersona(item.dataset.personaId);
            }
        });
    });

    attachPopoverOutsideClose(menu, anchorEl);
}

/**
 * Prompt to delete a persona
 * @param {string} personaId
 */
async function deletePersonaPrompt(personaId) {
    const persona = state.personas[personaId];
    if (!persona) return;

    // Count linked conversations
    const linkedConvos = Object.values(state.conversations).filter(c => c.personaId === personaId);

    let body = `"${persona.name}", its avatar, and its expressions will be deleted.`;
    if (linkedConvos.length > 0) {
        body += ` This also deletes ${linkedConvos.length} linked chat${linkedConvos.length !== 1 ? 's' : ''}.`;
    }
    body += " This can't be undone.";

    const ok = await confirmDialog({
        title: 'Delete persona?',
        body,
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;

    // Server-side delete cascades to linked conversations (and messages).
    // Backend refuses to delete the user's last persona — that surfaces as
    // a VALIDATION_ERROR, which we catch and show to the user.
    try {
        await API.personas.delete(personaId);
    } catch (err) {
        console.error('Failed to delete persona:', err);
        displayError(err, { action: 'delete persona' });
        return;
    }

    // Local cleanup mirrors the server cascade. Each cascaded chat's draft goes
    // with it — otherwise the draft store keeps an entry (and the File objects
    // and blob URLs it holds) keyed by an id that no longer resolves.
    linkedConvos.forEach(convo => {
        delete state.conversations[convo.id];
        forgetConversationDraft(convo.id);
    });
    delete state.personas[personaId];

    // If we deleted the active persona, switch to another.
    if (state.activePersonaId === personaId) {
        const remaining = Object.values(state.personas);
        state.activePersonaId = remaining.length > 0 ? remaining[0].id : null;
        applyPersonaModelSettings(getActivePersona()); // fixed mode loads its settings
    }

    // Clear the active conversation if the cascade took it. 'discard' rather than
    // 'stash': the open chat has just been deleted, so leaving its draft in the
    // composer would let a half-typed message be sent into an unrelated chat —
    // the same defect F-04 fixed for switching, which this path used to miss.
    if (state.activeConversationId && !state.conversations[state.activeConversationId]) {
        setActiveConversation(null, { outgoing: 'discard' });
    }

    // The persona editor always shows the active persona, which just got
    // deleted (or swapped) — fall back to the Personas list instead of
    // silently re-targeting the editor at another persona.
    if ((state.ui.mainView || {}).type === 'persona-edit') {
        state.ui.mainView = { type: 'personas' };
    }

    renderConversationList();
    renderConversation();
    await updateUI();
}

/**
 * Create a new persona and switch to editing it
 */
async function startNewPersona() {
    let id;
    try {
        id = await createPersona('New Persona');
    } catch (err) {
        console.error('Failed to create persona:', err);
        return;
    }
    editPersona(id);
}

/**
 * Main-area "Personas" section: a character-select grid of portrait tiles —
 * large 1:1 avatar, name, optional role chip, and the persona's tagline. Click
 * a tile to make it active (stays here); the ⋯ menu edits (→ persona editor)
 * or deletes. The top-bar persona popover still handles quick-switch.
 */
export function renderPersonasListMain() {
    const c = elements.messagesContainer;
    const personas = Object.values(state.personas)
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    const cards = personas.map(p => {
        const active = p.id === state.activePersonaId;
        const tagline = (p.tagline || '').trim();
        const role = (p.roleLabel || '').trim();
        return `
            <div class="persona-tile${active ? ' active' : ''}">
                <div class="persona-tile-open" data-persona-open="${escapeHtml(p.id)}" role="button" tabindex="0">
                    <div class="persona-tile-portrait">
                        ${personaAvatarHTML(p)}
                        ${active ? '<span class="persona-tile-active">Active</span>' : ''}
                    </div>
                    <div class="persona-tile-caption">
                        <span class="persona-tile-name">${escapeHtml(p.name || 'Untitled')}</span>
                        ${role ? `<span class="persona-tile-role">${escapeHtml(role)}</span>` : ''}
                        <span class="persona-tile-tagline${tagline ? '' : ' empty'}">${tagline ? escapeHtml(tagline) : 'Add a tagline'}</span>
                    </div>
                </div>
                <button class="project-menu-btn persona-tile-menu" data-persona-menu="${escapeHtml(p.id)}" title="Options">⋯</button>
            </div>`;
    }).join('');

    c.innerHTML = `
        <div class="section-view">
            <div class="section-head">
                <h1 class="section-title">Personas</h1>
                <div class="section-head-actions">
                    <button class="section-secondary-btn" id="personaImportBtn" type="button">Import</button>
                    <button class="section-new-btn" id="personaNewBtn" type="button">+ New persona</button>
                </div>
            </div>
            ${personas.length ? `<div class="persona-tile-grid">${cards}</div>` : `<p class="empty-state small">No personas yet.</p>`}
        </div>`;

    const nb = c.querySelector('#personaNewBtn');
    if (nb) nb.addEventListener('click', startNewPersona);
    const ib = c.querySelector('#personaImportBtn');
    if (ib) ib.addEventListener('click', promptPersonaImport);
    c.querySelectorAll('[data-persona-open]').forEach(el => {
        el.addEventListener('click', () => activatePersona(el.dataset.personaOpen));
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                activatePersona(el.dataset.personaOpen);
            }
        });
    });
    c.querySelectorAll('[data-persona-menu]').forEach(btn =>
        btn.addEventListener('click', (e) => { e.stopPropagation(); showPersonaCardMenu(btn, btn.dataset.personaMenu); }));
}

/** Make a persona active from the Personas section (stays on the section). */
export function activatePersona(personaId) {
    if (!state.personas[personaId]) return;
    state.activePersonaId = personaId;
    applyPersonaModelSettings(getActivePersona()); // fixed mode loads its settings
    savePersonas();
    updateUI(); // refreshes the section (Active badge) + header
}

const BUNDLE_FORMAT = 'tessera.bundle';

const BUNDLE_VERSION = 1;

/** Longest edge for normalized art. The UI never renders above 480px. */
const BUNDLE_IMAGE_MAX_EDGE = 512;

const BUNDLE_IMAGE_QUALITY = 0.82;

/**
 * Fetch an image URL and return it as `{ mimeType, data }` with base64 data.
 * Normalizes to WebP within BUNDLE_IMAGE_MAX_EDGE unless `fullQuality`, which
 * ships the original bytes untouched.
 * @param {string} url
 * @param {boolean} fullQuality
 * @returns {Promise<{mimeType: string, data: string}|null>} null if unavailable
 */
async function imageToBundleEntry(url, fullQuality) {
    let blob;
    try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) return null;
        blob = await res.blob();
    } catch {
        return null;
    }
    if (!blob || blob.size === 0) return null;

    if (!fullQuality) {
        try {
            blob = await normalizeImageBlob(blob);
        } catch {
            /* fall through and ship the original */
        }
    }
    const data = await blobToBase64(blob);
    return data ? { mimeType: blob.type || 'image/png', data } : null;
}

/**
 * Downscale a blob to fit BUNDLE_IMAGE_MAX_EDGE and re-encode as WebP.
 * Images already within bounds are still re-encoded — that's usually where
 * most of the size saving comes from.
 * @param {Blob} blob
 * @returns {Promise<Blob>}
 */
async function normalizeImageBlob(blob) {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, BUNDLE_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const out = await new Promise(r => canvas.toBlob(r, 'image/webp', BUNDLE_IMAGE_QUALITY));
    return out || blob;
}

/**
 * Build and download a `.tessera` bundle for a persona.
 *
 * The model pin and file-tools flag are deliberately left out: neither is the
 * exporter's decision to make about whoever imports this.
 * @param {string} personaId
 * @param {{fullQuality?: boolean}} [opts]
 */
async function exportPersona(personaId, opts = {}) {
    const persona = state.personas[personaId];
    if (!persona) return;
    const fullQuality = !!opts.fullQuality;

    showToast(`Preparing ${persona.name}…`);
    try {
        const cacheBust = persona.updatedAt ? `?v=${persona.updatedAt}` : '';
        const avatar = persona.avatarFilename
            ? await imageToBundleEntry(`${API.avatars.getUrl(persona.id)}${cacheBust}`, fullQuality)
            : null;

        const expressions = {};
        for (const [name, expr] of Object.entries(persona.expressions || {})) {
            if (name === CONFIG.generatingExpression) continue; // UI state, not character
            expressions[name] = {
                emoji: expr.emoji || '🙂',
                image: expr.imageKey
                    ? await imageToBundleEntry(`${API.avatars.getExpressionUrl(persona.id, name)}${cacheBust}`, fullQuality)
                    : null,
            };
        }

        const bundle = {
            format: BUNDLE_FORMAT,
            version: BUNDLE_VERSION,
            kind: 'persona',
            exportedAt: Date.now(),
            persona: {
                name: persona.name || 'Untitled',
                tagline: persona.tagline || '',
                roleLabel: persona.roleLabel || '',
                systemPrompt: persona.systemPrompt || '',
                avatar,
                expressions,
            },
        };

        const json = JSON.stringify(bundle, null, 2);
        const filename = `${(persona.name || 'persona').replace(/[^\w-]+/g, '_')}.tessera`;
        downloadBlob(new Blob([json], { type: 'application/json' }), filename);
        showToast(`Exported ${filename} (${formatFileSize(json.length)})`, { type: 'success' });
    } catch (err) {
        console.error('Failed to export persona:', err);
        displayError(err, { action: 'export this persona' });
    }
}

/**
 * Read a `.tessera` file and import it as a new persona. The file is parsed
 * here only to fail fast on malformed JSON — the server does the real
 * validation, since the file is untrusted.
 * @param {File} file
 */
async function importPersonaFromFile(file) {
    if (!file) return;
    let bundle;
    try {
        bundle = JSON.parse(await file.text());
    } catch {
        showToast("That file isn't a readable Tessera bundle", { type: 'warning' });
        return;
    }

    try {
        const created = await API.personas.import(bundle);
        hydratePersonas(await API.personas.list());
        renderPersonasListMain();
        showToast(`Imported "${created.name}"`, { type: 'success' });
    } catch (err) {
        console.error('Failed to import persona:', err);
        displayError(err, { action: 'import this persona' });
    }
}

/** Open a file picker and import the chosen `.tessera` bundle. */
function promptPersonaImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.tessera,application/json';
    input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (file) importPersonaFromFile(file);
    });
    input.click();
}

function showPersonaCardMenu(anchorEl, personaId) {
    const existing = document.querySelector('.context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = `
        <button class="context-menu-item" data-action="edit">Edit</button>
        <button class="context-menu-item" data-action="export">Export…</button>
        <button class="context-menu-item" data-action="export-full">Export (full quality)</button>
        <button class="context-menu-item danger" data-action="delete">Delete</button>
    `;
    positionPopover(menu, anchorEl, 'right');

    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', () => {
            menu.remove();
            const action = item.dataset.action;
            if (action === 'edit') editPersona(personaId);
            else if (action === 'export') exportPersona(personaId);
            else if (action === 'export-full') exportPersona(personaId, { fullQuality: true });
            else if (action === 'delete') deletePersonaPrompt(personaId);
        });
    });
    attachPopoverOutsideClose(menu, anchorEl);
}

