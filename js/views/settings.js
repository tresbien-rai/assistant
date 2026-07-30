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
 * The preset list is the whole Advanced tab for now. Editing a preset's blocks
 * is AP-03; this slice is the lifecycle around them — create, duplicate, rename,
 * delete, and choose the account default. See docs/ADVANCED_PROMPTS_PLAN.md.
 */

import { state } from '../state.js';
import { elements } from '../dom.js';
import { API } from '../api-client.js';
import { escapeHtml } from '../util/format.js';
import { showToast } from '../components/toast.js';
import { displayError } from '../components/errors.js';
import { confirmDialog, promptName } from '../components/dialogs.js';

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
    }
}

/** Presets newest-updated first — the order the server returns them in. */
function presetList() {
    return Object.values(state.presets).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
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
        showToast(`Created “${preset.name}”. Editing its blocks comes next.`);
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
    renderPresetList();
    showToast(`Deleted “${preset.name}”.`);
}
