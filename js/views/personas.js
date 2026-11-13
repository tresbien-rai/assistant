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
import { navigate, updateUI, mobileMenuButtonHTML, registerShell } from '../shell.js';
import { getActivePersona } from '../state.js';
import {
    PROVIDERS, providerIconHtml, personaModelMode, getActiveModelConfig, getCatalogEntry,
} from '../model-layer.js';
import {
    personaAvatarHTML, createPersona, applyPersonaModelSettings, hydratePersonas,
} from '../persona-helpers.js';
import { savePersonas, autoSaveSettings } from '../settings-store.js';
import { PERSONA_SECTIONS, AUTHORED_SECTION_IDS, sectionText } from '../persona-sections.js';
import { wireTraitEditor, syncTraitEditors } from './persona-traits-editor.js';
import { renderConversationList, renderConversation, startNewConversation } from './chats.js';
import { setActiveConversation, forgetConversationDraft } from '../active-conversation.js';
import { UiPrefs } from '../ui-prefs.js';
import { setupTextareaResizers } from '../components/textarea-resize.js';
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
    showPersonaEditorTab('identity');
}

/**
 * Top-bar persona button popover: edit the current persona, create a new one,
 * or jump to another persona's chats. Switching does NOT reassign the current
 * conversation — see docs/design/PHASE2_UX_DESIGN.md.
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
 * large 1:1 avatar, name, optional role chip, tagline, and visible Chat / Edit
 * actions. Click the card body to make a persona active; the ⋯ menu holds
 * Export and Delete. The top-bar persona popover still handles quick-switch.
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
                <div class="persona-tile-actions">
                    <button type="button" class="btn btn-sm btn-pill btn-soft-accent persona-tile-btn" data-persona-chat="${escapeHtml(p.id)}">Chat</button>
                    <button type="button" class="btn btn-sm btn-pill btn-secondary persona-tile-btn" data-persona-edit="${escapeHtml(p.id)}">Edit</button>
                </div>
                <button type="button" class="project-menu-btn persona-tile-menu" data-persona-menu="${escapeHtml(p.id)}" title="Options" aria-label="Persona options">⋯</button>
            </div>`;
    }).join('');

    c.innerHTML = `
        <div class="section-view">
            <div class="section-head">
                <div class="section-head-left">
                    ${mobileMenuButtonHTML()}
                    <h1 class="section-title">Personas</h1>
                </div>
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
    c.querySelectorAll('[data-persona-chat]').forEach(btn =>
        btn.addEventListener('click', (e) => { e.stopPropagation(); chatWithPersona(btn.dataset.personaChat); }));
    c.querySelectorAll('[data-persona-edit]').forEach(btn =>
        btn.addEventListener('click', (e) => { e.stopPropagation(); editPersona(btn.dataset.personaEdit); }));
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

/** Activate a persona and immediately start a new unfiled chat with it. */
export async function chatWithPersona(personaId) {
    if (!state.personas[personaId]) return;
    state.activePersonaId = personaId;
    applyPersonaModelSettings(getActivePersona());
    savePersonas();
    await startNewConversation();
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
                sections: persona.sections || {},
                traits: persona.traits || {},
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
        showToast(`That file isn't a readable ${CONFIG.brand} bundle`, { type: 'warning' });
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


// ===== Persona section fields (PS-02) =====
//
// The five named sections get their own textareas in the persona editor. They
// are BUILT from the vocabulary in js/persona-sections.js rather than written
// into index.html, so adding, renaming or reordering a section is a one-line
// change in one file and the editor follows automatically.
//
// `general` is deliberately NOT built here: it is the static `#systemPrompt`
// textarea, which writes the original column. Keeping it static keeps every
// existing DOM cache, listener and save path valid, and PS-01's whole point was
// that nothing about the legacy field had to move.

/** True once the fields exist, so a repaint sets values instead of rebuilding. */
let sectionFieldsBuilt = false;

/** The textarea for one section id. */
function sectionField(id) {
    return document.getElementById(`personaSection_${id}`);
}

/**
 * Build the section textareas once.
 *
 * Rebuilding on every sync would destroy the caret mid-word, the same trap the
 * Profile view avoids — so this runs once and `syncPersonaSectionFields` only
 * ever writes values afterwards.
 */
function buildPersonaSectionFields() {
    const host = elements.personaSectionFields;
    if (!host) return;
    // Each section (PT-05): its picked traits as tags, then one panel holding
    // the section's Prompt text — the trait sentences as assembled — with the
    // section's own textarea underneath as its next paragraph. The tags and
    // sentences are rendered by views/persona-traits-editor.js into the two
    // `data-trait-*` containers; the textarea stays here, untouched by it.
    host.innerHTML = AUTHORED_SECTION_IDS.map((id) => {
        const section = PERSONA_SECTIONS.find((s) => s.id === id);
        const sid = escapeHtml(id);
        return `
            <div class="persona-section">
                <label for="personaSection_${sid}">${escapeHtml(section.label)}</label>
                <p class="help-text">${escapeHtml(section.help)}</p>
                <div class="trait-tags" data-trait-tags="${sid}"></div>
                <div class="trait-panel">
                    <div class="trait-panel-cap">Prompt text</div>
                    <div class="trait-text" data-trait-text="${sid}"></div>
                    <div class="textarea-resizable">
                        <textarea id="personaSection_${sid}" class="persona-section-field"
                                  data-section-id="${sid}" rows="2"
                                  placeholder="${escapeHtml(section.placeholder)}"></textarea>
                        <div class="textarea-resize-handle" aria-hidden="true" title="Drag to resize"></div>
                    </div>
                </div>
            </div>`;
    }).join('');

    // One delegated listener rather than five: the fields never change identity,
    // but delegation keeps this correct if the vocabulary grows.
    host.addEventListener('input', (e) => {
        if (e.target.dataset.sectionId) autoSaveSettings();
    });
    wireTraitEditor(host);
    // The handles this just rendered are inert until wired. Built once, so
    // wired once; the call is idempotent regardless.
    setupTextareaResizers();
    sectionFieldsBuilt = true;
}

/**
 * Reflect a persona's sections into the editor fields.
 *
 * Skips whichever field currently has focus. Every other field in this editor
 * is written unconditionally on repaint, which is fine because a repaint does
 * not happen while typing — but this one is cheap insurance against that
 * assumption changing, and a persona prompt is a bad place to lose a sentence.
 *
 * @param {Object|null} persona
 */
export function syncPersonaSectionFields(persona) {
    if (!elements.personaSectionFields) return;
    if (!sectionFieldsBuilt) buildPersonaSectionFields();
    for (const id of AUTHORED_SECTION_IDS) {
        const field = sectionField(id);
        if (!field || field === document.activeElement) continue;
        field.value = persona ? sectionText(persona, id) : '';
    }
    syncTraitEditors(persona);
}

// ===== Persona editor layout: 3-tab strip, live WYSIWYG card & fixed-model picker (UIP-05) =====

const PERSONA_TABS = [
    { id: 'identity', label: 'Identity & Prompt' },
    { id: 'avatar', label: 'Avatar & Expressions' },
    { id: 'defaults', label: 'Defaults & Capabilities' },
];

const DEFAULT_PERSONA_TAB = 'identity';
let activePersonaTab = DEFAULT_PERSONA_TAB;
let personaEditorBuilt = false;

function resolveModelDisplayName(provider, modelId) {
    if (!modelId) return '';
    const list = (provider && state.settings.customModels[provider]) || [];
    const entry = list.find((m) => m.id === modelId);
    return entry ? entry.name : modelId;
}

function liveCardMarkup({ withAvatarAction = false } = {}) {
    return `
        <div class="persona-live-card">
            <div class="persona-live-card-head">
                <span>Live card preview</span>
                <span class="persona-live-art-type">Emoji</span>
            </div>
            <div class="persona-tile-portrait"></div>
            <div class="persona-tile-caption">
                <span class="persona-tile-name"></span>
                <span class="persona-tile-role" hidden></span>
                <span class="persona-tile-tagline"></span>
            </div>
            ${withAvatarAction ? '<button type="button" class="persona-live-card-btn" data-jump-avatar="1">Change portrait →</button>' : ''}
        </div>`;
}

/**
 * Re-parent the persona sections into `#personaEditView` under the UIP-05
 * 3-tab layout (`Identity & Prompt` | `Avatar & Expressions` | `Defaults & Capabilities`),
 * with a separate sibling WYSIWYG card beside Identity & Avatar on desktop and
 * Strip A above the tabs on phone.
 */
export function setupPersonaEditor() {
    const view = elements.personaEditView;
    if (!view || personaEditorBuilt) return;

    const identitySection = document.getElementById('personaIdentitySection');
    const promptSection = document.getElementById('personaPromptSection');
    const avatarSection = document.getElementById('personaAvatarSection');
    const expressionsSection = document.getElementById('personaExpressionsSection');
    const modelSection = document.getElementById('personaModelSection');
    const presetSection = document.getElementById('personaPresetSection');
    const capabilitiesSection = document.getElementById('personaCapabilitiesSection');

    view.innerHTML = `
        <div class="settings-view-crumb">${mobileMenuButtonHTML()}<button type="button" class="cp-crumb" id="personaEditBack">‹ Personas</button></div>
        <h1 class="settings-view-title" id="personaEditTitle">Persona</h1>
        <div class="persona-strip" id="personaPhoneStrip">
            <div class="persona-strip-port-col">
                <div class="persona-strip-port" id="personaStripPortrait"></div>
                <button type="button" class="persona-strip-edit-btn" id="personaStripActionBtn">Edit art →</button>
            </div>
            <div class="persona-strip-info-col">
                <div class="persona-strip-eyebrow">
                    <span>Live preview</span>
                    <span id="personaStripArtType">Emoji</span>
                </div>
                <div class="persona-strip-title-row">
                    <span class="persona-strip-name" id="personaStripName"></span>
                    <span class="persona-tile-role" id="personaStripRole" hidden></span>
                </div>
                <span class="persona-tile-tagline" id="personaStripTagline"></span>
                <div class="persona-strip-model-foot" id="personaStripModelFoot">
                    <span class="persona-strip-model-dot"></span>
                    <span id="personaStripModelLabel">Shared model</span>
                </div>
            </div>
        </div>
        <div class="settings-tabs" id="personaEditTabs" role="tablist">
            ${PERSONA_TABS.map((t) => `
                <button type="button" class="settings-tab" role="tab" data-tab="${t.id}"
                        aria-selected="false">${escapeHtml(t.label)}</button>`).join('')}
        </div>`;

    const editorBody = document.createElement('div');
    editorBody.className = 'settings-modal-body';

    // Tab 1 hero: Identity section on left, standalone WYSIWYG Persona Card on right.
    const identityHero = document.createElement('div');
    identityHero.className = 'persona-hero-row';
    identityHero.dataset.personaTab = 'identity';
    if (identitySection) identityHero.appendChild(identitySection);
    const identityAside = document.createElement('aside');
    identityAside.className = 'persona-live-aside';
    identityAside.id = 'personaIdentityAside';
    identityAside.innerHTML = liveCardMarkup({ withAvatarAction: true });
    identityHero.appendChild(identityAside);
    editorBody.appendChild(identityHero);

    if (promptSection) editorBody.appendChild(promptSection);

    // Tab 2 hero: Avatar upload on left, standalone WYSIWYG Persona Card on right.
    const avatarHero = document.createElement('div');
    avatarHero.className = 'persona-hero-row';
    avatarHero.dataset.personaTab = 'avatar';
    if (avatarSection) avatarHero.appendChild(avatarSection);
    const avatarAside = document.createElement('aside');
    avatarAside.className = 'persona-live-aside';
    avatarAside.id = 'personaAvatarAside';
    avatarAside.innerHTML = liveCardMarkup({ withAvatarAction: false });
    avatarHero.appendChild(avatarAside);
    editorBody.appendChild(avatarHero);

    if (expressionsSection) editorBody.appendChild(expressionsSection);
    if (modelSection) editorBody.appendChild(modelSection);
    if (presetSection) editorBody.appendChild(presetSection);
    if (capabilitiesSection) editorBody.appendChild(capabilitiesSection);

    view.appendChild(editorBody);

    document.getElementById('personaEditBack')
        ?.addEventListener('click', () => navigate({ type: 'personas' }));
    const tabList = document.getElementById('personaEditTabs');
    tabList?.addEventListener('click', (e) => {
        const btn = e.target.closest('.settings-tab');
        if (btn) showPersonaEditorTab(btn.dataset.tab);
    });
    tabList?.addEventListener('keydown', (e) => {
        const tabs = [...tabList.querySelectorAll('.settings-tab')];
        const idx = tabs.indexOf(e.target.closest('.settings-tab'));
        if (idx === -1) return;
        let next = -1;
        if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = tabs.length - 1;
        if (next === -1) return;
        e.preventDefault();
        tabs[next].focus();
        showPersonaEditorTab(tabs[next].dataset.tab);
    });
    document.getElementById('personaStripActionBtn')
        ?.addEventListener('click', () => {
            showPersonaEditorTab(activePersonaTab === 'avatar' ? 'identity' : 'avatar');
        });
    identityAside.querySelector('[data-jump-avatar]')
        ?.addEventListener('click', () => showPersonaEditorTab('avatar'));

    if (elements.personaFixedModelBtn) {
        elements.personaFixedModelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showPersonaFixedModelMenu(elements.personaFixedModelBtn);
        });
    }
    if (elements.personaEditModelsLink) {
        elements.personaEditModelsLink.addEventListener('click', () => {
            const persona = getActivePersona();
            const pin = persona?.modelConfig || {};
            const hasEntry = pin.provider && pin.model && getCatalogEntry(pin.provider, pin.model);
            navigate(hasEntry
                ? { type: 'models', detail: { provider: pin.provider, model: pin.model } }
                : { type: 'models' });
        });
    }

    personaEditorBuilt = true;
    showPersonaEditorTab(activePersonaTab);
    syncPersonaEditorPreview();
}

/** Switch the active tab inside `#personaEditView`. */
export function showPersonaEditorTab(tabId) {
    const known = PERSONA_TABS.some((t) => t.id === tabId);
    activePersonaTab = known ? tabId : DEFAULT_PERSONA_TAB;

    document.querySelectorAll('#personaEditTabs .settings-tab').forEach((btn) => {
        const on = btn.dataset.tab === activePersonaTab;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-selected', String(on));
        btn.tabIndex = on ? 0 : -1;
    });

    const body = elements.personaEditView?.querySelector('.settings-modal-body');
    if (body) {
        for (const child of body.children) {
            const tab = child.dataset.personaTab;
            if (tab) child.hidden = tab !== activePersonaTab;
        }
    }

    const actionBtn = document.getElementById('personaStripActionBtn');
    if (actionBtn) {
        actionBtn.textContent = activePersonaTab === 'avatar' ? 'Identity →' : 'Edit art →';
    }

    closePersonaFixedModelMenu();
}

/**
 * Sync both desktop sibling WYSIWYG cards and the Phone Strip A banner
 * with the active persona's live identity, portrait, and model-mode state.
 * @param {Object} [opts]
 * @param {boolean} [opts.fromInputs=false] - read live form inputs while typing
 */
export function syncPersonaEditorPreview({ fromInputs = false } = {}) {
    if (!personaEditorBuilt) return;
    const persona = getActivePersona();
    const rawName = fromInputs && elements.assistantName
        ? elements.assistantName.value
        : (persona ? persona.name : CONFIG.defaults.assistantName);
    const name = rawName || CONFIG.defaults.assistantName;
    const tagline = (fromInputs && elements.personaTagline
        ? elements.personaTagline.value
        : (persona?.tagline || '')).trim();
    const role = (fromInputs && elements.personaRoleLabel
        ? elements.personaRoleLabel.value
        : (persona?.roleLabel || '')).trim();

    const isActive = !!(persona && persona.id === state.activePersonaId);
    const hasCustom = !!(persona && persona.avatarFilename);
    const artTypeLabel = hasCustom ? 'Custom' : 'Emoji';
    const firstEmoji = Object.values(persona?.expressions || {})[0]?.emoji || '';
    const avatarKey = persona
        ? `${persona.id}|${persona.avatarFilename || ''}|${persona.updatedAt || 0}|${firstEmoji}|${isActive ? 1 : 0}`
        : 'none';
    const portraitInner = `${personaAvatarHTML(persona)}${isActive ? '<span class="persona-tile-active">Active</span>' : ''}`;

    document.querySelectorAll('#personaEditView .persona-live-card').forEach((card) => {
        const typeEl = card.querySelector('.persona-live-art-type');
        if (typeEl) typeEl.textContent = artTypeLabel;

        const portraitEl = card.querySelector('.persona-tile-portrait');
        if (portraitEl && portraitEl.dataset.avatarKey !== avatarKey) {
            portraitEl.dataset.avatarKey = avatarKey;
            portraitEl.innerHTML = portraitInner;
        }

        const nameEl = card.querySelector('.persona-tile-name');
        if (nameEl) nameEl.textContent = name;

        const roleEl = card.querySelector('.persona-tile-role');
        if (roleEl) {
            roleEl.textContent = role;
            roleEl.hidden = !role;
        }

        const tagEl = card.querySelector('.persona-tile-tagline');
        if (tagEl) {
            tagEl.textContent = tagline || 'Add a tagline';
            tagEl.classList.toggle('empty', !tagline);
        }
    });

    const stripPort = document.getElementById('personaStripPortrait');
    if (stripPort && stripPort.dataset.avatarKey !== avatarKey) {
        stripPort.dataset.avatarKey = avatarKey;
        stripPort.innerHTML = portraitInner;
    }
    const stripType = document.getElementById('personaStripArtType');
    if (stripType) stripType.textContent = artTypeLabel;
    const stripName = document.getElementById('personaStripName');
    if (stripName) stripName.textContent = name;
    const stripRole = document.getElementById('personaStripRole');
    if (stripRole) {
        stripRole.textContent = role;
        stripRole.hidden = !role;
    }
    const stripTag = document.getElementById('personaStripTagline');
    if (stripTag) {
        stripTag.textContent = tagline || 'Add a tagline';
        stripTag.classList.toggle('empty', !tagline);
    }

    const mode = personaModelMode(persona);
    const stripModelFoot = document.getElementById('personaStripModelFoot');
    const stripModelLabel = document.getElementById('personaStripModelLabel');
    if (stripModelFoot) stripModelFoot.classList.toggle('is-fixed', mode === 'fixed');
    if (stripModelLabel) {
        if (mode === 'fixed') {
            const pin = persona?.modelConfig || {};
            const label = resolveModelDisplayName(pin.provider || getActiveModelConfig().provider, pin.model);
            stripModelLabel.textContent = label ? `Fixed · ${label}` : 'Fixed model';
        } else {
            stripModelLabel.textContent = 'Shared model';
        }
    }
}

let fixedMenuCleanup = null;

/** Close any open Fixed-model menu popover and detach its global listeners. */
export function closePersonaFixedModelMenu() {
    if (fixedMenuCleanup) {
        const fn = fixedMenuCleanup;
        fixedMenuCleanup = null;
        fn();
    }
    const openMenu = document.querySelector('.context-menu[data-fixed-model-menu]');
    if (openMenu) openMenu.remove();
    if (elements.personaFixedModelBtn) {
        elements.personaFixedModelBtn.setAttribute('aria-expanded', 'false');
    }
}

/** Sync the inline Fixed-model picker inside `Defaults & Capabilities → Model`. */
export function syncPersonaFixedModelPicker() {
    const box = elements.personaFixedModelBox;
    if (!box) return;
    const persona = getActivePersona();
    const mode = personaModelMode(persona);
    box.hidden = mode !== 'fixed';
    if (mode !== 'fixed') {
        closePersonaFixedModelMenu();
        return;
    }

    const fallbackLayer = getActiveModelConfig();
    const provider = persona?.modelConfig?.provider || fallbackLayer.provider;
    const modelId = persona?.modelConfig?.model || fallbackLayer.model;

    if (elements.personaFixedProviderBadge) {
        elements.personaFixedProviderBadge.textContent = PROVIDERS[provider]?.label || provider || 'Model';
    }
    if (elements.personaFixedModelName) {
        elements.personaFixedModelName.textContent = modelId
            ? resolveModelDisplayName(provider, modelId)
            : 'Select a model';
    }
    if (elements.personaFixedModelNoKey) {
        const hasKey = !!(provider && state.apiKeyStatus[provider]?.hasKey);
        elements.personaFixedModelNoKey.hidden = !provider || hasKey;
    }
}

function setPersonaPinnedModel(provider, modelId) {
    const persona = getActivePersona();
    if (!persona || !provider || !modelId) return;
    persona.modelConfig = {
        ...(persona.modelConfig || {}),
        mode: 'fixed',
        provider,
        model: modelId,
    };
    persona.updatedAt = Date.now();
    // Apply immediately so the active model layer matches the chosen pin
    // (otherwise updateFixedPersonaPin on the next keystroke would overwrite it).
    applyPersonaModelSettings(persona);
    savePersonas();
    updateUI();
}

/**
 * Grouped model picker popover for Fixed mode inside the Persona Editor.
 * Mirrors the header/composer model menu without nesting row action menus.
 */
export function showPersonaFixedModelMenu(anchorEl, { showAll = false, toggle = true } = {}) {
    const existing = document.querySelector('.context-menu');
    const wasOwn = existing && existing.hasAttribute('data-fixed-model-menu');
    closePersonaFixedModelMenu();
    if (existing && !wasOwn) existing.remove();
    if (toggle && wasOwn) {
        return;
    }

    const persona = getActivePersona();
    const fallbackLayer = getActiveModelConfig();
    const pinnedProvider = persona?.modelConfig?.provider || fallbackLayer.provider;
    const pinnedModel = persona?.modelConfig?.model || fallbackLayer.model;

    const selected = state.settings.catalogProviders;
    const noFilter = showAll || !Array.isArray(selected) || selected.length === 0;
    const stocked = Object.keys(PROVIDERS)
        .filter((p) => (state.settings.customModels[p] || []).length > 0);
    const visible = stocked.filter((p) => noFilter || selected.includes(p) || p === pinnedProvider);
    const hiddenCount = stocked.length - visible.length;

    const menu = document.createElement('div');
    menu.className = 'context-menu context-menu-wide model-menu';
    menu.setAttribute('data-fixed-model-menu', '1');
    menu.setAttribute('role', 'menu');

    let groups = '';
    for (const provider of visible) {
        const { label } = PROVIDERS[provider];
        const hasKey = !!state.apiKeyStatus[provider]?.hasKey;
        groups += `<div class="context-menu-label">
            ${providerIconHtml(provider)}<span class="model-menu-provider">${escapeHtml(label)}</span>
            ${hasKey ? '' : '<span class="model-menu-nokey">no key</span>'}
        </div>`;
        for (const m of state.settings.customModels[provider]) {
            const active = provider === pinnedProvider && m.id === pinnedModel;
            groups += `<button type="button" class="context-menu-item${active ? ' active' : ''}" role="menuitemradio" aria-checked="${active}" data-model-id="${escapeHtml(m.id)}" data-provider="${escapeHtml(provider)}">
                <span class="model-menu-name">${escapeHtml(m.name)}</span>
            </button>`;
        }
    }

    let html = visible.length > 0
        ? `<div class="model-menu-scroll">${groups}</div>`
        : `<div class="context-menu-empty">No models configured</div>`;
    html += `<div class="context-menu-separator"></div>`;
    if (hiddenCount > 0) {
        html += `<button type="button" class="context-menu-item model-menu-more" role="menuitem" data-action="showall">Show all providers (${hiddenCount} more)</button>`;
    }
    html += `<button type="button" class="context-menu-item" role="menuitem" data-action="manage">Manage models…</button>`;
    menu.innerHTML = html;

    positionPopover(menu, anchorEl, 'left');
    anchorEl.setAttribute('aria-expanded', 'true');

    const onOutsideClick = (e) => {
        if (!menu.contains(e.target) && !anchorEl.contains(e.target)) {
            closePersonaFixedModelMenu();
        }
    };
    const onKeyDown = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closePersonaFixedModelMenu();
            anchorEl.focus();
            return;
        }
        const items = [...menu.querySelectorAll('.context-menu-item')];
        if (items.length === 0) return;
        const idx = items.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            items[(idx + 1) % items.length].focus();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            items[(idx <= 0 ? items.length : idx) - 1].focus();
        } else if (e.key === 'Home') {
            e.preventDefault();
            items[0].focus();
        } else if (e.key === 'End') {
            e.preventDefault();
            items[items.length - 1].focus();
        }
    };

    const timerId = setTimeout(() => {
        document.addEventListener('click', onOutsideClick);
    }, 0);
    document.addEventListener('keydown', onKeyDown);
    fixedMenuCleanup = () => {
        clearTimeout(timerId);
        document.removeEventListener('click', onOutsideClick);
        document.removeEventListener('keydown', onKeyDown);
    };

    menu.querySelectorAll('.context-menu-item').forEach((item) => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            closePersonaFixedModelMenu();
            if (item.dataset.action === 'showall') {
                showPersonaFixedModelMenu(anchorEl, { showAll: true, toggle: false });
                return;
            }
            if (item.dataset.action === 'manage') {
                navigate({ type: 'models' });
                return;
            }
            if (item.dataset.modelId && item.dataset.provider) {
                setPersonaPinnedModel(item.dataset.provider, item.dataset.modelId);
                anchorEl.focus();
            }
        });
    });

    const initialFocus = menu.querySelector('.context-menu-item.active') || menu.querySelector('.context-menu-item');
    if (initialFocus) initialFocus.focus({ preventScroll: true });
}

registerShell({ showPersonaPopover });
