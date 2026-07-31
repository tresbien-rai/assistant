/**
 * The Settings view: its tab strip, and the Advanced tab (AP-02).
 *
 * Settings used to be one long scroll of `.settings-section` blocks. Advanced
 * adds a whole surface of its own — prompt presets now, the block editor and the
 * prompt inspector next — which is more than a scroll can carry, so the sections
 * are grouped into tabs. The tab strip is built from the sections themselves
 * (each declares `data-settings-tab`), so adding a section to a tab is an
 * attribute, not a change here.
 *
 * Three layers live here, in order down the file (see docs/ADVANCED_PROMPTS_PLAN.md):
 *   AP-02  the preset lifecycle — create, duplicate, rename, delete, account default
 *   AP-03  the block editor behind a preset's Edit
 *   AP-04  selection — the composer pill + menu, and the persona editor's picker
 *
 * The AP-04 helpers mirror the server's resolvePromptPreset precedence. That
 * duplication is deliberate and load-bearing: the pill has to say what a send
 * will actually do. The server stays the authority — nothing here is trusted by
 * it — so the two are kept in step by the precedence test in
 * server/src/prompts/test-presets.js plus the end-to-end check in the PR.
 */

import { state } from '../state.js';
import { elements } from '../dom.js';
import { API } from '../api-client.js';
import { getActivePersona, getActiveConversation } from '../state.js';
import { escapeHtml } from '../util/format.js';
import { showToast } from '../components/toast.js';
import { displayError } from '../components/errors.js';
import { confirmDialog, promptName } from '../components/dialogs.js';
import { positionPopover, attachPopoverOutsideClose } from '../components/menus.js';
import { setupTextareaResizers } from '../components/textarea-resize.js';
// AP-04 only: the composer pill's menu can jump to this view, and the persona
// editor's picker writes through the persona save path like every other field.
import { navigate } from '../shell.js';
import { savePersonas } from '../settings-store.js';
// AP-05: the inspector runs the real assembly, which needs the active model.
import { getActiveModelConfig } from '../model-layer.js';
// AP-06: the .tesserapreset exporter's second call site for the shared helper.
import { downloadBlob } from '../util/blob.js';

/**
 * Sentinel meaning "the built-in layer, explicitly" — mirrors PRESET_NONE in
 * server/src/prompts/presets.js. null means "inherit the next level down", so
 * without this a chat could never opt OUT of a preset its persona supplies.
 */
export const PRESET_NONE = 'none';

// Tab id → label, in strip order. A section opts in with data-settings-tab.
const SETTINGS_TABS = [
    { id: 'appearance', label: 'Appearance' },
    { id: 'files', label: 'Files' },
    { id: 'advanced', label: 'Advanced' },
    { id: 'account', label: 'Account' },
];

const DEFAULT_TAB = 'appearance';

// Session-local: which tab is showing. Deliberately not persisted — Settings is
// somewhere you visit to do one thing, and landing back on Advanced days later
// because you once opened it is disorienting.
let activeTab = DEFAULT_TAB;

/**
 * Build the tab strip and wire it. Called once, after the settings body has been
 * re-parented into #settingsView (main.js), because it inserts the strip above
 * the sections it controls.
 */
export function setupSettingsTabs() {
    const body = elements.settingsView && elements.settingsView.querySelector('.settings-modal-body');
    if (!body) return;

    const strip = document.createElement('div');
    strip.className = 'settings-tabs';
    strip.setAttribute('role', 'tablist');
    strip.innerHTML = SETTINGS_TABS.map(t => `
        <button type="button" class="settings-tab" role="tab" data-tab="${t.id}"
                aria-selected="false">${escapeHtml(t.label)}</button>`).join('');
    body.parentNode.insertBefore(strip, body);

    strip.addEventListener('click', (e) => {
        const btn = e.target.closest('.settings-tab');
        if (btn) showSettingsTab(btn.dataset.tab);
    });

    showSettingsTab(activeTab);
}

/**
 * Show one tab: highlight it and reveal only the sections that belong to it.
 * A section with no `data-settings-tab` falls in the first tab rather than
 * vanishing — a new section is then visible-but-misfiled, which is noticed and
 * fixed, where invisible is not.
 * @param {string} tabId
 */
export function showSettingsTab(tabId) {
    const known = SETTINGS_TABS.some(t => t.id === tabId);
    activeTab = known ? tabId : DEFAULT_TAB;

    document.querySelectorAll('.settings-tab').forEach(btn => {
        const on = btn.dataset.tab === activeTab;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('#settingsView .settings-section').forEach(section => {
        const tab = section.dataset.settingsTab || DEFAULT_TAB;
        section.hidden = tab !== activeTab;
    });

    // Leaving Advanced with an edit still in its debounce window would let the
    // save land after the UI moved on; flush it while the editor is still here.
    if (activeTab !== 'advanced') flushPresetSave();

    // The list is fetched when its tab is first shown, not on boot: most
    // sessions never open Advanced, and presets aren't needed to send a message.
    if (activeTab === 'advanced') loadPresets();
}

// ===== Prompt presets =====

let presetsLoaded = false;
let presetsLoading = false;

/** Fetch the user's presets into state and render (once per session). */
export async function loadPresets({ force = false } = {}) {
    if (presetsLoading || (presetsLoaded && !force)) {
        renderPresetList();
        return;
    }
    presetsLoading = true;
    renderPresetList(); // shows the loading note
    try {
        const presets = await API.presets.list();
        state.presets = {};
        presets.forEach(p => { state.presets[p.id] = p; });
        presetsLoaded = true;
    } catch (err) {
        console.error('Failed to load prompt presets:', err);
        displayError(err, { action: 'load your prompt presets' });
    } finally {
        presetsLoading = false;
        renderPresetList();
        refreshPresetDependentUi();
    }
}

/** Presets newest-updated first — the order the server returns them in. */
function presetList() {
    return Object.values(state.presets).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * Repaint everything OUTSIDE the list that reads the preset set: the composer
 * pill and the persona editor's picker. Creating, deleting, or changing the
 * account default changes what those two say — the persona picker names the
 * account default in its "Inherit" row, so it goes stale otherwise.
 */
function refreshPresetDependentUi() {
    syncPresetPill();
    syncPersonaPresetControl();
}

/**
 * Render the preset list. The built-in layer is a row of its own rather than an
 * absence: "no preset" IS a choice (and the default one), so it needs to be
 * selectable and to show when it is active.
 */
export function renderPresetList() {
    const host = document.getElementById('presetList');
    if (!host) return;

    if (presetsLoading && !presetsLoaded) {
        host.innerHTML = '<p class="section-note">Loading presets…</p>';
        return;
    }

    const activeId = state.settings.defaultPresetId || null;
    const rows = [`
        <div class="preset-row${activeId === null ? ' active' : ''}" data-preset-id="">
            <div class="preset-row-main">
                <span class="preset-name">Built-in prompt</span>
                <span class="preset-note">Tessera's default prompt layer</span>
            </div>
            ${activeId === null
                ? '<span class="preset-badge">Default</span>'
                : '<button type="button" class="preset-action" data-action="use">Use</button>'}
        </div>`];

    for (const p of presetList()) {
        const isDefault = p.id === activeId;
        rows.push(`
        <div class="preset-row${isDefault ? ' active' : ''}" data-preset-id="${escapeHtml(p.id)}">
            <div class="preset-row-main">
                <span class="preset-name">${escapeHtml(p.name)}</span>
                <span class="preset-note">${describeOverrides(p)}</span>
            </div>
            ${isDefault
                ? '<span class="preset-badge">Default</span>'
                : '<button type="button" class="preset-action" data-action="use">Use</button>'}
            <button type="button" class="preset-action" data-action="edit">Edit</button>
            <button type="button" class="preset-action" data-action="rename">Rename</button>
            <button type="button" class="preset-action" data-action="duplicate">Duplicate</button>
            <button type="button" class="preset-action danger-quiet" data-action="delete">Delete</button>
        </div>`);
    }

    host.innerHTML = rows.join('');
}

/** "2 blocks edited · reordered", or "no changes yet" — what this preset does. */
function describeOverrides(preset) {
    const blocks = (preset.blocks && preset.blocks.blocks) || {};
    const edited = Object.values(blocks).filter(b => typeof b.text === 'string' && b.text !== '').length;
    const disabled = Object.values(blocks).filter(b => b.enabled === false).length;
    const bits = [];
    if (edited) bits.push(`${edited} block${edited === 1 ? '' : 's'} edited`);
    if (disabled) bits.push(`${disabled} off`);
    return bits.length ? escapeHtml(bits.join(' · ')) : 'No changes from the built-in yet';
}

/** Delegated handler for the preset list's buttons. */
export async function handlePresetListClick(e) {
    const btn = e.target.closest('.preset-action');
    if (!btn) return;
    const row = btn.closest('.preset-row');
    if (!row) return;
    const id = row.dataset.presetId || null;

    if (btn.dataset.action === 'use') return setDefaultPreset(id);
    if (!id) return; // the built-in row has no other actions
    if (btn.dataset.action === 'edit') return openPresetEditor(id);
    if (btn.dataset.action === 'rename') return renamePreset(id);
    if (btn.dataset.action === 'duplicate') return duplicatePreset(id);
    if (btn.dataset.action === 'delete') return deletePreset(id);
}

/**
 * Make a preset (or the built-in layer, for `null`) the account default.
 *
 * Optimistic: the row highlights immediately and rolls back if the write fails,
 * because the alternative is a click that appears to do nothing on a slow link.
 * @param {string|null} presetId
 */
export async function setDefaultPreset(presetId) {
    const previous = state.settings.defaultPresetId || null;
    if (previous === presetId) return;

    state.settings.defaultPresetId = presetId;
    renderPresetList();
    try {
        await API.settings.update({ defaultPresetId: presetId });
    } catch (err) {
        state.settings.defaultPresetId = previous;
        renderPresetList();
        displayError(err, { action: 'change your default preset' });
        return;
    }
    refreshPresetDependentUi();
    showToast(presetId
        ? `“${state.presets[presetId].name}” is now your default prompt.`
        : 'Back to the built-in prompt.');
}

/** Create an empty preset (all blocks inheriting the built-in) and select it. */
export async function createPreset() {
    const name = await promptName({
        title: 'New prompt preset',
        label: 'Preset name',
        placeholder: 'e.g. Roleplay',
        confirmLabel: 'Create',
    });
    if (!name) return;

    try {
        const preset = await API.presets.create({ name });
        state.presets[preset.id] = preset;
        renderPresetList();
        refreshPresetDependentUi(); // the first preset is what reveals the pill
        showToast(`Created “${preset.name}”. Open Edit to change its blocks.`);
    } catch (err) {
        displayError(err, { action: 'create the preset' });
    }
}

/** Copy a preset, blocks and all. The server does the copy — see the route. */
export async function duplicatePreset(presetId) {
    const original = state.presets[presetId];
    if (!original) return;
    const name = await promptName({
        title: 'Duplicate preset',
        label: 'Name for the copy',
        value: `${original.name} copy`,
        confirmLabel: 'Duplicate',
    });
    if (!name) return;

    try {
        const preset = await API.presets.create({ name, cloneFrom: presetId });
        state.presets[preset.id] = preset;
        renderPresetList();
        refreshPresetDependentUi();
        showToast(`Duplicated as “${preset.name}”.`);
    } catch (err) {
        displayError(err, { action: 'duplicate the preset' });
    }
}

export async function renamePreset(presetId) {
    const preset = state.presets[presetId];
    if (!preset) return;
    const name = await promptName({
        title: 'Rename preset',
        label: 'Preset name',
        value: preset.name,
        confirmLabel: 'Save',
    });
    if (!name || name === preset.name) return;

    try {
        const updated = await API.presets.update(presetId, { name });
        state.presets[presetId] = updated;
        renderPresetList();
        refreshPresetDependentUi(); // the name shows on the pill and the picker
    } catch (err) {
        displayError(err, { action: 'rename the preset' });
    }
}

/**
 * Delete a preset. The confirm names what else changes: the server clears every
 * pointer at it, so chats using it — and the account default, if it was this one
 * — fall back to the built-in layer. Silently reverting someone's prompt is
 * exactly the kind of thing they should be told before it happens, not after.
 */
export async function deletePreset(presetId) {
    const preset = state.presets[presetId];
    if (!preset) return;

    const wasDefault = state.settings.defaultPresetId === presetId;
    const ok = await confirmDialog({
        title: `Delete “${preset.name}”?`,
        body: wasDefault
            ? 'This is your default preset. Chats using it — and any new chat — will go back to the built-in prompt. This cannot be undone.'
            : 'Any chat using it will go back to the built-in prompt. This cannot be undone.',
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;

    try {
        await API.presets.delete(presetId);
    } catch (err) {
        displayError(err, { action: 'delete the preset' });
        return;
    }
    delete state.presets[presetId];
    if (wasDefault) state.settings.defaultPresetId = null;
    if (editingPresetId === presetId) closePresetEditor();
    renderPresetList();
    refreshPresetDependentUi();
    showToast(`Deleted “${preset.name}”.`);
}

// =============================================================================
// Block editor (AP-03)
// =============================================================================

/**
 * UI copy for each block. Lives here rather than coming from the server with the
 * text: the server owns what a block IS, the client owns how it is explained.
 *
 * `conditional` is the sentence that keeps Decision D3 honest on screen — these
 * blocks are sent only when something the preset does NOT control is true, and a
 * user editing the scratchpad wording deserves to know why it isn't showing up.
 */
const BLOCK_INFO = {
    orientation: {
        label: 'Orientation',
        description: 'What Tessera is, and that the text after it is a persona to embody.',
    },
    expressions: {
        label: 'Expression protocol',
        description: 'How to emit [expression: name] tags.',
        conditional: 'Sent only when the persona has expressions.',
    },
    scratchpad: {
        label: 'Scratchpad',
        description: 'How to use the shared scratchpad beside the chat.',
        conditional: 'Sent only when the scratchpad is active for the chat.',
    },
    persona: {
        label: 'Persona prompt',
        description: "The persona's own prompt. Position only — its text is edited on the persona.",
        positionOnly: true,
    },
    context_ack: {
        label: 'Context acknowledgement',
        description: "The assistant's one-line reply after workspace or project files are injected.",
        conditional: 'Sent only when the chat inherits knowledge files.',
    },
};

// The built-in text + macro reference from GET /api/presets/defaults. Static per
// deployment, so it is fetched once and kept for the session.
let presetDefaults = null;

let editingPresetId = null;
let saveTimer = null;

/** The preset being edited, or null. */
function editingPreset() {
    return editingPresetId ? state.presets[editingPresetId] : null;
}

/** Open the editor for a preset, fetching the built-in text if we lack it. */
export async function openPresetEditor(presetId) {
    if (!state.presets[presetId]) return;
    editingPresetId = presetId;
    showEditorPanel(true);
    elements.presetEditor.innerHTML = '<p class="section-note">Loading…</p>';

    if (!presetDefaults) {
        try {
            presetDefaults = await API.presets.defaults();
        } catch (err) {
            displayError(err, { action: 'load the built-in prompt text' });
            closePresetEditor();
            return;
        }
    }
    // The user may have navigated away while that was in flight.
    if (editingPresetId !== presetId) return;
    renderPresetEditor();
}

/** Back to the list. Any pending edit is flushed rather than dropped. */
export function closePresetEditor() {
    flushPresetSave();
    editingPresetId = null;
    showEditorPanel(false);
    renderPresetList();
}

function showEditorPanel(showEditor) {
    if (elements.presetEditor) elements.presetEditor.hidden = !showEditor;
    if (elements.presetListPanel) elements.presetListPanel.hidden = showEditor;
}

/** The blocks object being edited (normalized server-side on every write). */
function editingBlocks() {
    const preset = editingPreset();
    return preset && preset.blocks ? preset.blocks : null;
}

export function renderPresetEditor() {
    const preset = editingPreset();
    const blocks = editingBlocks();
    if (!elements.presetEditor || !preset || !blocks) return;

    const systemIds = presetDefaults.systemBlockIds;
    const order = blocks.order.filter(id => systemIds.includes(id));
    const messageIds = presetDefaults.messageBlockIds;

    elements.presetEditor.innerHTML = `
        <div class="preset-editor-head">
            <span class="cp-crumb" id="presetEditorBack">‹ Prompt presets</span>
            <span class="preset-editor-head-actions">
                <span class="preset-save-status" id="presetSaveStatus"></span>
                <button type="button" class="preset-action" id="presetExportBtn">Export</button>
            </span>
        </div>
        <h4 class="preset-editor-title">${escapeHtml(preset.name)}</h4>
        <p class="section-note">Leave a block empty to keep following the built-in text (shown greyed in the box). Drag a block, or use ↑ ↓, to change the order it is sent in.</p>

        <div class="preset-blocks" id="presetBlocks">
            ${order.map((id, i) => blockCardHTML(id, blocks.blocks[id], { index: i, count: order.length, draggable: true })).join('')}
        </div>

        <p class="preset-group-label">Not part of the system prompt</p>
        ${messageIds.map(id => blockCardHTML(id, blocks.blocks[id], { draggable: false })).join('')}

        <div class="preset-editor-preview">
            <button type="button" class="preset-action" id="presetPreviewBtn">Preview this preset</button>
            <div class="prompt-inspector" id="presetInspector"></div>
        </div>

        <details class="preset-macros">
            <summary>Macros you can use</summary>
            <ul>
                ${presetDefaults.macros.map(m => `
                    <li><code>{{${escapeHtml(m.name)}}}</code> — ${escapeHtml(m.description)}</li>`).join('')}
            </ul>
            <p class="section-note">An unknown macro is left as-is rather than blanked, so a typo shows up in the prompt instead of vanishing.</p>
        </details>`;

    elements.presetEditor.querySelector('#presetEditorBack')
        .addEventListener('click', closePresetEditor);
    elements.presetEditor.querySelector('#presetExportBtn').addEventListener('click', () => {
        flushPresetSave(); // export what is on screen, not the last autosave
        exportPreset(editingPresetId);
    });
    elements.presetEditor.querySelector('#presetPreviewBtn').addEventListener('click', () => {
        // Flush first: previewing text still sitting in the debounce window
        // would show the PREVIOUS save and quietly mislead.
        flushPresetSave();
        renderPromptInspector(document.getElementById('presetInspector'), { presetId: editingPresetId });
    });
    wireEditorEvents();
    setupTextareaResizers(); // each block card renders a fresh handle
    syncExpressionWarning();
}

/** One block card. `text: null` renders empty, with the built-in as placeholder. */
function blockCardHTML(id, block, { index = 0, count = 1, draggable }) {
    const info = BLOCK_INFO[id] || { label: id, description: '' };
    const overridden = typeof block.text === 'string' && block.text !== '';
    const builtIn = presetDefaults.blocks[id] || '';
    const stateLabel = block.enabled === false ? 'Off' : (overridden ? 'Edited' : 'Built-in');

    return `
    <div class="preset-block${block.enabled === false ? ' is-off' : ''}" data-block-id="${escapeHtml(id)}"${draggable ? ' draggable="true"' : ''}>
        <div class="preset-block-head">
            ${draggable ? '<span class="preset-block-grip" aria-hidden="true">⋮⋮</span>' : ''}
            <span class="preset-block-title">${escapeHtml(info.label)}</span>
            <span class="preset-block-state" data-state>${stateLabel}</span>
            ${draggable ? `
                <button type="button" class="preset-action" data-action="move-up" aria-label="Move up"${index === 0 ? ' disabled' : ''}>↑</button>
                <button type="button" class="preset-action" data-action="move-down" aria-label="Move down"${index === count - 1 ? ' disabled' : ''}>↓</button>` : ''}
            <button type="button" class="preset-action" data-action="reset"${overridden ? '' : ' disabled'}>Reset</button>
            <label class="preset-block-toggle">
                <input type="checkbox" data-action="toggle"${block.enabled === false ? '' : ' checked'}>
                <span>On</span>
            </label>
        </div>
        <p class="preset-block-desc">
            ${escapeHtml(info.description)}
            ${info.conditional ? `<em class="preset-block-cond">${escapeHtml(info.conditional)}</em>` : ''}
        </p>
        ${info.positionOnly ? '' : `
            <div class="textarea-resizable">
                <textarea id="presetText_${escapeHtml(id)}" class="preset-block-text" data-block-text rows="6"
                          maxlength="${presetDefaults.limits.blockChars}"
                          placeholder="${escapeHtml(builtIn)}">${escapeHtml(block.text || '')}</textarea>
                <div class="textarea-resize-handle" aria-hidden="true" title="Drag to resize"></div>
            </div>
            <p class="preset-block-warn" data-warn hidden></p>`}
    </div>`;
}

/** Wire the editor's controls. Re-run after every re-render. */
function wireEditorEvents() {
    const host = document.getElementById('presetBlocks');

    elements.presetEditor.querySelectorAll('.preset-block').forEach(card => {
        const id = card.dataset.blockId;

        const textarea = card.querySelector('[data-block-text]');
        if (textarea) {
            textarea.addEventListener('input', () => {
                const blocks = editingBlocks();
                if (!blocks) return;
                // '' and null mean the same thing to the composer — "use the
                // built-in" — so an emptied box is stored as null rather than as
                // an override that happens to be empty.
                blocks.blocks[id].text = textarea.value === '' ? null : textarea.value;
                refreshBlockChrome(card, id);
                if (id === 'expressions') syncExpressionWarning();
                queuePresetSave();
            });
        }

        card.querySelector('[data-action="toggle"]').addEventListener('change', (e) => {
            const blocks = editingBlocks();
            if (!blocks) return;
            blocks.blocks[id].enabled = e.target.checked;
            card.classList.toggle('is-off', !e.target.checked);
            refreshBlockChrome(card, id);
            queuePresetSave();
        });

        card.querySelector('[data-action="reset"]').addEventListener('click', () => {
            const blocks = editingBlocks();
            if (!blocks) return;
            blocks.blocks[id].text = null;
            if (textarea) textarea.value = '';
            refreshBlockChrome(card, id);
            if (id === 'expressions') syncExpressionWarning();
            queuePresetSave();
        });

        const up = card.querySelector('[data-action="move-up"]');
        const down = card.querySelector('[data-action="move-down"]');
        if (up) up.addEventListener('click', () => moveBlock(id, -1));
        if (down) down.addEventListener('click', () => moveBlock(id, 1));
    });

    if (host) wireBlockDragging(host);
}

/** Keep a card's state pill and Reset button in step with its data. */
function refreshBlockChrome(card, id) {
    const block = editingBlocks().blocks[id];
    const overridden = typeof block.text === 'string' && block.text !== '';
    const pill = card.querySelector('[data-state]');
    if (pill) pill.textContent = block.enabled === false ? 'Off' : (overridden ? 'Edited' : 'Built-in');
    const reset = card.querySelector('[data-action="reset"]');
    if (reset) reset.disabled = !overridden;
}

/**
 * Warn when a custom expression block drops `{{expressions}}` (Decision D5).
 * Deliberately a warning and not a block: removing the protocol is a legitimate
 * thing to want, and the app has no business refusing it — but doing it by
 * accident means the model is never told which expressions exist.
 */
function syncExpressionWarning() {
    const card = elements.presetEditor.querySelector('.preset-block[data-block-id="expressions"]');
    if (!card) return;
    const warn = card.querySelector('[data-warn]');
    const block = editingBlocks().blocks.expressions;
    const missing = typeof block.text === 'string' && block.text !== '' && !block.text.includes('{{expressions}}');
    warn.hidden = !missing;
    warn.textContent = missing
        ? 'No {{expressions}} in this block — the model won’t be told which expressions the persona has, so its tags will be guesses.'
        : '';
}

/** Move a block within the system-layer order and re-render. */
function moveBlock(id, delta) {
    const blocks = editingBlocks();
    if (!blocks) return;
    const order = blocks.order;
    const from = order.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) return;
    order.splice(to, 0, order.splice(from, 1)[0]);
    renderPresetEditor();
    queuePresetSave();
}

/**
 * Native HTML5 drag to reorder. The ↑/↓ buttons cover the same ground for
 * keyboards and touch, where this doesn't fire at all — drag is the affordance
 * this audience reaches for first, not the only way in.
 */
function wireBlockDragging(host) {
    let draggingId = null;

    host.addEventListener('dragstart', (e) => {
        const card = e.target.closest('.preset-block');
        if (!card) return;
        draggingId = card.dataset.blockId;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        // Firefox won't start a drag without data on the transfer.
        e.dataTransfer.setData('text/plain', draggingId);
    });

    host.addEventListener('dragover', (e) => {
        if (!draggingId) return;
        e.preventDefault(); // permits the drop
        const over = e.target.closest('.preset-block');
        if (!over || over.dataset.blockId === draggingId) return;
        const blocks = editingBlocks();
        const order = blocks.order;
        const from = order.indexOf(draggingId);
        const to = order.indexOf(over.dataset.blockId);
        if (from < 0 || to < 0) return;
        order.splice(to, 0, order.splice(from, 1)[0]);
        // Move the node itself rather than re-rendering mid-drag: a re-render
        // would destroy the element the browser is dragging.
        const dragged = host.querySelector(`.preset-block[data-block-id="${CSS.escape(draggingId)}"]`);
        if (from < to) over.after(dragged);
        else over.before(dragged);
    });

    host.addEventListener('drop', (e) => e.preventDefault());

    host.addEventListener('dragend', () => {
        if (!draggingId) return;
        draggingId = null;
        renderPresetEditor(); // resync the ↑/↓ disabled states
        queuePresetSave();
    });
}

// ===== Saving =====

function setSaveStatus(text) {
    const el = document.getElementById('presetSaveStatus');
    if (el) el.textContent = text;
}

/**
 * Debounced save, matching the rest of Settings (which auto-saves rather than
 * asking). Prompt text is typed in long runs, so the window is longer than the
 * settings tick — and every path that leaves the editor flushes it, so nothing
 * is lost to a fast exit.
 */
function queuePresetSave() {
    setSaveStatus('Saving…');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(savePreset, 800);
}

/** Write a pending edit immediately (leaving the editor, tab, or view). */
export function flushPresetSave() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    savePreset();
}

async function savePreset() {
    saveTimer = null;
    const preset = editingPreset();
    if (!preset) return;
    const id = preset.id;

    try {
        const updated = await API.presets.update(id, { blocks: preset.blocks });
        // Keep the local blocks object: replacing it wholesale would discard
        // keystrokes typed while the request was in flight.
        state.presets[id] = { ...updated, blocks: preset.blocks };
        if (editingPresetId === id) setSaveStatus('Saved');
    } catch (err) {
        if (editingPresetId === id) setSaveStatus('Not saved');
        displayError(err, { action: 'save the preset' });
    }
}

// =============================================================================
// Per-chat + per-persona selection (AP-04)
// =============================================================================

/**
 * These mirror the server's resolvePromptPreset precedence exactly:
 *
 *   chat override → persona base → account default → built-in
 *
 * with PRESET_NONE stopping the walk at any level. The UI has to agree with what
 * a send will actually do — a picker that says "Roleplay" while the server
 * resolves something else is worse than no picker at all. The server stays the
 * authority; this is a read-only mirror of the same rule.
 */

/** The persona's base preset choice: an id, PRESET_NONE, or null to inherit. */
export function personaPresetBase(persona) {
    const id = persona?.modelConfig?.presetId;
    return typeof id === 'string' && id ? id : null;
}

/** The active chat's override, including one chosen before the chat existed. */
export function getChatPresetOverride() {
    const convo = getActiveConversation();
    const value = convo ? convo.presetId : state.pendingPresetId;
    return typeof value === 'string' && value ? value : null;
}

/**
 * The preset that WILL be used for the active chat.
 * @returns {{id: string|null, source: 'chat'|'persona'|'account'|'builtin'}}
 *   `id` null means the built-in layer; `source` is which level decided.
 */
export function effectivePreset() {
    const chat = getChatPresetOverride();
    if (chat === PRESET_NONE) return { id: null, source: 'chat' };
    if (chat) return { id: chat, source: 'chat' };

    const base = personaPresetBase(getActivePersona());
    if (base === PRESET_NONE) return { id: null, source: 'persona' };
    if (base) return { id: base, source: 'persona' };

    const account = state.settings.defaultPresetId || null;
    if (account) return { id: account, source: 'account' };
    return { id: null, source: 'builtin' };
}

/** Display name for a preset id (or the built-in layer). */
export function presetLabel(id) {
    if (!id || id === PRESET_NONE) return 'Built-in prompt';
    const preset = state.presets[id];
    // A preset deleted elsewhere leaves a dangling id; the server falls back to
    // the built-in, so say that rather than showing a raw uuid.
    return preset ? preset.name : 'Built-in prompt';
}

/**
 * Reflect the effective preset on the composer pill.
 *
 * Hidden entirely when the user has no presets: until you make one there is
 * nothing to switch between, and an extra control in the composer would be pure
 * noise for the majority who never open Advanced.
 */
export function syncPresetPill() {
    const btn = elements.composerPresetButton;
    if (!btn) return;
    const any = Object.keys(state.presets).length > 0;
    btn.hidden = !any;
    if (!any) return;

    const { id, source } = effectivePreset();
    const label = presetLabel(id);
    const nameEl = btn.querySelector('.preset-pill-name');
    if (nameEl) nameEl.textContent = label;
    // The pill is filled only when THIS chat pins a preset — inherited state is
    // shown but not emphasised, the same distinction the tools toggle draws.
    btn.classList.toggle('pinned', source === 'chat');
    const from = {
        chat: 'this chat',
        persona: 'the persona',
        account: 'your account default',
        builtin: 'the default',
    };
    btn.title = `Prompt: ${label} (from ${from[source]}) — click to change for this chat`;
}

/** The quick-switch menu behind the composer pill. */
export function showPresetMenu(anchorEl) {
    const existing = document.querySelector('.context-menu, .key-popover');
    if (existing) existing.remove();

    const chat = getChatPresetOverride();
    const inherited = inheritedPreset();
    const menu = document.createElement('div');
    menu.className = 'context-menu context-menu-wide';

    const item = (value, label, note, active) => `
        <button class="context-menu-item${active ? ' active' : ''}" data-value="${escapeHtml(value)}">
            ${escapeHtml(label)}${note ? `<span class="preset-menu-note">${escapeHtml(note)}</span>` : ''}
        </button>`;

    let html = '<div class="context-menu-label">Prompt for this chat</div>';
    html += item('', `Inherit — ${presetLabel(inherited.id)}`,
        `from ${inherited.source === 'persona' ? 'the persona' : 'your account default'}`,
        chat === null);
    html += '<div class="context-menu-separator"></div>';
    html += item(PRESET_NONE, 'Built-in prompt', '', chat === PRESET_NONE);
    for (const p of presetList()) {
        html += item(p.id, p.name, '', chat === p.id);
    }
    html += '<div class="context-menu-separator"></div>';
    html += '<button class="context-menu-item" data-action="manage">Manage presets…</button>';
    menu.innerHTML = html;

    positionPopover(menu, anchorEl, 'right');
    menu.querySelectorAll('.context-menu-item').forEach(el => {
        el.addEventListener('click', () => {
            menu.remove();
            if (el.dataset.action === 'manage') {
                navigate({ type: 'settings' });
                showSettingsTab('advanced');
                return;
            }
            setChatPreset(el.dataset.value || null);
        });
    });
    attachPopoverOutsideClose(menu, anchorEl);
}

/** What this chat would fall back to with no override of its own. */
function inheritedPreset() {
    const base = personaPresetBase(getActivePersona());
    if (base === PRESET_NONE) return { id: null, source: 'persona' };
    if (base) return { id: base, source: 'persona' };
    return { id: state.settings.defaultPresetId || null, source: 'account' };
}

/**
 * Pin (or clear) the active chat's preset. Stashed as pending for a chat that
 * doesn't exist yet — createConversation applies it, exactly as the file-tools
 * override works.
 * @param {string|null} value - a preset id, PRESET_NONE, or null to inherit
 */
export async function setChatPreset(value) {
    const convo = getActiveConversation();
    if (!convo) {
        state.pendingPresetId = value;
        syncPresetPill();
        return;
    }
    const previous = convo.presetId ?? null;
    convo.presetId = value;
    syncPresetPill();
    try {
        await API.conversations.update(convo.id, { presetId: value });
    } catch (err) {
        convo.presetId = previous;
        syncPresetPill();
        displayError(err, { action: 'change this chat’s prompt preset' });
    }
}

// ===== Persona default =====

/** Fill the persona editor's preset select and reflect the persona's choice. */
export function syncPersonaPresetControl() {
    const select = elements.personaPresetSelect;
    if (!select) return;
    const current = personaPresetBase(getActivePersona());
    const accountLabel = presetLabel(state.settings.defaultPresetId || null);

    select.innerHTML = [
        `<option value="">Inherit — ${escapeHtml(accountLabel)} (account default)</option>`,
        `<option value="${PRESET_NONE}">Built-in prompt</option>`,
        ...presetList().map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`),
    ].join('');
    select.value = current || '';
    // A preset deleted elsewhere leaves an id with no <option>; the select would
    // show blank, so fall back to the inherit row it now behaves as.
    if (select.value !== (current || '')) select.value = '';
}

/** Persona editor: set this persona's base preset (absent = inherit). */
export function setPersonaPresetBase(value) {
    const persona = getActivePersona();
    if (!persona) return;
    persona.modelConfig = { ...persona.modelConfig };
    if (value) persona.modelConfig.presetId = value;
    else delete persona.modelConfig.presetId;
    persona.updatedAt = Date.now();
    savePersonas();
    syncPresetPill();
}

// =============================================================================
// Prompt inspector (AP-05)
// =============================================================================

/**
 * Why a block was left out, in the user's terms. The server sends stable codes;
 * the sentences live here with the rest of the UI copy.
 *
 * This is the half of the inspector that earns its keep: "my scratchpad wording
 * isn't showing up" is answered by a line that says the pad is off for this
 * chat, not by staring at the assembled prompt looking for something absent.
 */
const EXCLUSION_REASONS = {
    disabled: 'turned off in this preset',
    'no-expressions': 'the persona has no expressions',
    'scratchpad-inactive': 'the scratchpad is off for this chat',
    'no-persona-prompt': 'the persona has no prompt text',
    'no-context': 'this chat has no workspace or project files',
    empty: 'the text is empty',
};

const SOURCE_LABELS = {
    'built-in': 'Built-in',
    preset: 'Preset',
    persona: 'Persona',
};

/**
 * Render the assembled-prompt inspector into `host`.
 *
 * Runs the REAL assembly through /api/chat/preview — the same endpoint and the
 * same code path a send uses — rather than composing anything client-side. The
 * point of the inspector is to show what will actually happen, so re-deriving
 * it here would defeat it.
 *
 * @param {HTMLElement} host
 * @param {Object} [options]
 * @param {string} [options.presetId] - preview THIS preset (the editor's
 *   "Preview" button) instead of whatever the active chat resolves to
 */
export async function renderPromptInspector(host, { presetId } = {}) {
    if (!host) return;
    host.innerHTML = '<p class="section-note">Assembling…</p>';

    const cfg = getActiveModelConfig();
    let result;
    try {
        result = await API.chat.preview({
            provider: cfg.provider,
            model: cfg.model,
            // One representative user turn: the assembly appends per-turn blocks
            // to the LAST user message, so an empty thread would under-report.
            messages: [{ role: 'user', content: '…' }],
            systemPrompt: getActivePersona()?.systemPrompt || '',
            expressionNames: Object.keys(getActivePersona()?.expressions || {}),
            conversationId: state.activeConversationId || undefined,
            ...(presetId ? { presetId } : {}),
        });
    } catch (err) {
        host.innerHTML = '<p class="section-note">Could not assemble the prompt.</p>';
        displayError(err, { action: 'preview the prompt' });
        return;
    }

    const blocks = Array.isArray(result.promptBlocks) ? result.promptBlocks : [];
    const included = blocks.filter(b => b.included);
    const excluded = blocks.filter(b => !b.included);
    const total = included.reduce((n, b) => n + b.chars, 0);

    host.innerHTML = `
        <p class="section-note">${describeInspectorContext(presetId)}</p>
        <div class="inspector-summary">
            <span><strong>${included.length}</strong> block${included.length === 1 ? '' : 's'}</span>
            <span><strong>${total.toLocaleString()}</strong> characters</span>
            <span>${result.presetApplied ? 'Preset applied' : 'Built-in prompt'}</span>
        </div>
        ${included.map(b => `
            <details class="inspector-block">
                <summary>
                    <span class="inspector-block-name">${escapeHtml(blockLabel(b.id))}</span>
                    <span class="inspector-source source-${escapeHtml(b.source)}">${escapeHtml(SOURCE_LABELS[b.source] || b.source)}</span>
                    <span class="inspector-chars">${b.chars.toLocaleString()}</span>
                </summary>
                <pre class="inspector-text">${escapeHtml(b.text || '')}</pre>
            </details>`).join('')}
        ${excluded.length === 0 ? '' : `
            <p class="preset-group-label">Not sent this time</p>
            <ul class="inspector-excluded">
                ${excluded.map(b => `
                    <li><strong>${escapeHtml(blockLabel(b.id))}</strong> — ${escapeHtml(EXCLUSION_REASONS[b.reason] || b.reason)}</li>`).join('')}
            </ul>`}`;
}

/** Human label for a block id, reusing the editor's copy. */
function blockLabel(id) {
    return (BLOCK_INFO[id] || {}).label || id;
}

/** One line naming what this preview was assembled against. */
function describeInspectorContext(presetId) {
    const convo = getActiveConversation();
    const persona = getActivePersona();
    const where = convo
        ? `the open chat “${convo.title || 'Untitled'}”`
        : 'no open chat (so no persona or per-chat override applies)';
    const preset = presetId
        ? `Previewing “${presetLabel(presetId)}”`
        : `Previewing the prompt for ${where}`;
    return convo && persona
        ? `${preset}, persona “${persona.name}”. This is the real assembly, not an approximation.`
        : `${preset}. This is the real assembly, not an approximation.`;
}

// =============================================================================
// Export / import (AP-06)
// =============================================================================

// Mirrors the persona bundle's envelope (js/views/personas.js) so the two files
// are recognisably the same family. `kind` is what tells them apart — importing
// a persona bundle here should fail with a sentence, not a stack trace.
const PRESET_FORMAT = 'tessera.bundle';
const PRESET_VERSION = 1;

/**
 * Download a preset as a `.tesserapreset` file.
 *
 * Only the name and blocks travel. Not the id (the importer mints its own), not
 * whether it was your default (that is the importer's choice, not the
 * exporter's), and no user content beyond the prompt text you wrote.
 * @param {string} presetId
 */
export function exportPreset(presetId) {
    const preset = state.presets[presetId];
    if (!preset) return;

    const bundle = {
        format: PRESET_FORMAT,
        version: PRESET_VERSION,
        kind: 'preset',
        exportedAt: Date.now(),
        preset: {
            name: preset.name || 'Untitled',
            blocks: preset.blocks,
        },
    };

    const json = JSON.stringify(bundle, null, 2);
    const filename = `${(preset.name || 'preset').replace(/[^\w-]+/g, '_')}.tesserapreset`;
    downloadBlob(new Blob([json], { type: 'application/json' }), filename);
    showToast(`Exported ${filename}`, { type: 'success' });
}

/** Open a file picker and import the chosen `.tesserapreset`. */
export function promptPresetImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.tesserapreset,.json,application/json';
    input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (file) importPresetFromFile(file);
    });
    input.click();
}

/**
 * Read a `.tesserapreset` and create a preset from it.
 *
 * Parsed here only to fail fast with a readable message — the file is untrusted,
 * so the SERVER does the real validation (same validateBlocks the editor writes
 * through). Anything malformed inside `blocks` is either rejected there or
 * normalised away, so a hand-edited file can't smuggle in a block that the
 * composer would then have to cope with.
 * @param {File} file
 */
export async function importPresetFromFile(file) {
    let bundle;
    try {
        bundle = JSON.parse(await file.text());
    } catch {
        showToast("That file isn't a readable Tessera preset.", { type: 'warning' });
        return;
    }
    if (!bundle || bundle.kind !== 'preset' || !bundle.preset) {
        showToast(
            bundle && bundle.kind === 'persona'
                ? 'That is a persona bundle — import it from the Personas section.'
                : "That file isn't a Tessera preset.",
            { type: 'warning' }
        );
        return;
    }

    try {
        const preset = await API.presets.create({
            name: uniquePresetName(bundle.preset.name || 'Imported preset'),
            blocks: bundle.preset.blocks,
        });
        state.presets[preset.id] = preset;
        renderPresetList();
        refreshPresetDependentUi();
        showToast(`Imported “${preset.name}”.`, { type: 'success' });
    } catch (err) {
        console.error('Failed to import preset:', err);
        displayError(err, { action: 'import this preset' });
    }
}

/**
 * A name that doesn't collide with an existing preset. Importing the same file
 * twice is a normal thing to do (a tweak, a shared file re-downloaded), and two
 * rows with identical names would be indistinguishable in every picker.
 */
function uniquePresetName(name) {
    const taken = new Set(Object.values(state.presets).map(p => p.name));
    if (!taken.has(name)) return name;
    for (let n = 2; n < 100; n++) {
        const candidate = `${name} (${n})`;
        if (!taken.has(candidate)) return candidate;
    }
    return `${name} (${Date.now()})`;
}
