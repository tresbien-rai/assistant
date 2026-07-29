/**
 * The Models view (R-04b, moved verbatim from main.js).
 *
 * The provider chips, the model catalog, the per-model detail view with its
 * param controls, the add-model modal, and the provider key popover.
 *
 * It registers `renderModelsCatalog` and `refreshAddModelModal` with the shell
 * seam (see the foot of this file) so the settings store can repaint the
 * catalog after an API-key change without importing this module. Reads and
 * writes model state through js/model-layer.js; persists through
 * js/settings-store.js.
 */

import { state } from '../state.js';
import { elements } from '../dom.js';
import { API } from '../api-client.js';
import {
    PROVIDERS, providerIconHtml, getActiveModelConfig, getCatalogEntry, applyModelToLayer,
    getModelParamsForEdit, getParamByPath, setParamByPath,
    paramVisible, descByPath, fmtParamValue, } from '../model-layer.js';
import {
    persistSettings, autoSaveSettings, saveCatalogProviders, saveProviderKey,
    clearStoredApiKey, } from '../settings-store.js';
import { navigate, updateUI, registerShell } from '../shell.js';
import { loadModelProfileIntoLayer } from '../model-layer.js';
import { updateFixedPersonaPin } from '../settings-store.js';
import { escapeHtml } from '../util/format.js';
import { positionPopover, attachPopoverOutsideClose } from '../components/menus.js';

/** Render one param control from its descriptor + current value. */
export function renderParamControl(d, params) {
    const raw = getParamByPath(params, d.path);
    const v = raw === undefined ? d.default : raw;
    const enabled = d.enableKey ? (getParamByPath(params, d.enableKey) !== false) : true;
    const p = escapeHtml(d.path);
    const label = escapeHtml(d.label) + (d.unit ? ` <span class="param-unit">(${escapeHtml(d.unit)})</span>` : '');
    const enableBox = d.enableKey
        ? `<input type="checkbox" class="param-enable" data-enable="${escapeHtml(d.enableKey)}" ${enabled ? 'checked' : ''}> `
        : '';
    const help = d.help ? `<p class="param-help">${escapeHtml(d.help)}</p>` : '';
    const dis = enabled ? '' : 'disabled';
    let control = '';
    switch (d.control) {
        case 'range':
            control = `<div class="param-row">
                <div class="param-label">${enableBox}${label}<span class="param-val" data-valfor="${p}">${fmtParamValue(v, d)}</span></div>
                <input type="range" data-path="${p}" min="${d.min}" max="${d.max}" step="${d.step || 1}" value="${v}" ${dis}>
            </div>`;
            break;
        case 'number':
            control = `<div class="param-row param-row-inline">
                <div class="param-label">${enableBox}${label}</div>
                <input type="number" data-path="${p}" ${d.min !== undefined ? `min="${d.min}"` : ''} ${d.max !== undefined ? `max="${d.max}"` : ''} value="${v}" ${dis}>
            </div>`;
            break;
        case 'toggle':
            control = `<div class="param-row param-row-inline">
                <label class="param-label"><input type="checkbox" data-path="${p}" ${v ? 'checked' : ''}> ${label}</label>
            </div>`;
            break;
        case 'select': {
            const opts = (d.options || []).map(o => {
                const ov = typeof o === 'string' ? o : o.value;
                const ol = typeof o === 'string' ? (o.charAt(0).toUpperCase() + o.slice(1)) : o.label;
                return `<option value="${escapeHtml(ov)}" ${ov === v ? 'selected' : ''}>${escapeHtml(ol)}</option>`;
            }).join('');
            control = `<div class="param-row param-row-inline">
                <div class="param-label">${label}</div>
                <select data-path="${p}">${opts}</select>
            </div>`;
            break;
        }
        case 'textarea':
            control = `<div class="param-row">
                <div class="param-label">${label}</div>
                <textarea data-path="${p}" rows="3" placeholder="Text to start the reply with…">${escapeHtml(v || '')}</textarea>
            </div>`;
            break;
        case 'tags': {
            const tags = (Array.isArray(v) ? v : []).map((t, i) =>
                `<span class="param-tag" data-tagindex="${i}">${escapeHtml(t)}<span class="param-tag-x">×</span></span>`).join('');
            control = `<div class="param-row">
                <div class="param-label">${label}</div>
                <div class="param-tags" data-tagsfor="${p}">${tags}</div>
                <input type="text" class="param-tag-input" data-tagsinput="${p}" placeholder="Type and press Enter">
            </div>`;
            break;
        }
    }
    return control + help;
}

/**
 * Render the per-model detail view into #modelDetailPanel: header (back, name,
 * id, Active/Use), then Sampling and Behaviour groups built from the provider's
 * visible descriptors (Safety folded into a collapsible subgroup).
 */
export function renderModelDetail(provider, modelId) {
    const panel = document.getElementById('modelDetailPanel');
    if (!panel) return;
    const meta = PROVIDERS[provider];
    const entry = getCatalogEntry(provider, modelId);
    if (!meta || !entry) { navigate({ type: 'models' }); return; }
    const layer = getActiveModelConfig();
    const isActive = layer.provider === provider && layer.model === modelId;
    const params = getModelParamsForEdit(provider, modelId);

    const visible = meta.params.filter(d => paramVisible(d, params));
    let html = `
        <div class="model-detail-head">
            <button class="back-link" id="modelDetailBack" type="button">‹ Models</button>
            <div class="model-detail-title">
                <span class="model-detail-name">${escapeHtml(entry.name)}</span>
                ${isActive ? '<span class="persona-card-badge">Active</span>'
                           : '<button class="modal-btn primary" id="modelDetailUse" type="button">Use this model</button>'}
            </div>
            <p class="model-detail-sub">${escapeHtml(entry.id)} · ${escapeHtml(meta.label)}</p>
        </div>`;

    for (const [group, gLabel] of [['sampling', 'Sampling'], ['behaviour', 'Behaviour']]) {
        const descs = visible.filter(d => d.group === group);
        if (descs.length === 0) continue;
        html += `<div class="param-group-title">${gLabel}</div><div class="param-card">`;
        descs.filter(d => !d.subgroup).forEach(d => html += renderParamControl(d, params));
        const subs = [...new Set(descs.filter(d => d.subgroup).map(d => d.subgroup))];
        subs.forEach(sub => {
            html += `<details class="param-subgroup"><summary>${escapeHtml(sub.charAt(0).toUpperCase() + sub.slice(1))}</summary>`;
            descs.filter(d => d.subgroup === sub).forEach(d => html += renderParamControl(d, params));
            html += `</details>`;
        });
        html += `</div>`;
    }
    panel.innerHTML = html;

    document.getElementById('modelDetailBack').addEventListener('click', () => navigate({ type: 'models' }));
    const useBtn = document.getElementById('modelDetailUse');
    if (useBtn) useBtn.addEventListener('click', () => { selectModel(modelId, provider); renderModelsView(); });
    wireParamControls(panel, provider, modelId, params, isActive);
}

/**
 * Attach change handlers to a detail view's controls. Every edit writes through
 * the descriptor path into the params bag, then persists (debounced via
 * autoSaveSettings, which mirrors the active layer to its profile). Controls
 * that can change what's visible/enabled (selects, toggles, enable boxes, tags)
 * re-render the view; value-only controls (range/number/textarea) update live.
 */
export function wireParamControls(panel, provider, modelId, params, isActive) {
    const commit = () => autoSaveSettings();
    const rerender = () => renderModelDetail(provider, modelId);

    panel.querySelectorAll('input[type=range][data-path]').forEach(inp =>
        inp.addEventListener('input', () => {
            setParamByPath(params, inp.dataset.path, parseFloat(inp.value));
            const disp = panel.querySelector(`.param-val[data-valfor="${inp.dataset.path}"]`);
            if (disp) disp.textContent = fmtParamValue(parseFloat(inp.value), descByPath(provider, inp.dataset.path));
            commit();
        }));
    panel.querySelectorAll('input[type=number][data-path]').forEach(inp =>
        inp.addEventListener('input', () => {
            const n = parseFloat(inp.value);
            setParamByPath(params, inp.dataset.path, Number.isFinite(n) ? n : 0);
            commit();
        }));
    panel.querySelectorAll('input[type=checkbox][data-path]').forEach(inp =>
        inp.addEventListener('change', () => {
            setParamByPath(params, inp.dataset.path, inp.checked);
            commit(); rerender();
        }));
    panel.querySelectorAll('.param-enable[data-enable]').forEach(inp =>
        inp.addEventListener('change', () => {
            setParamByPath(params, inp.dataset.enable, inp.checked);
            commit(); rerender();
        }));
    panel.querySelectorAll('select[data-path]').forEach(sel =>
        sel.addEventListener('change', () => {
            setParamByPath(params, sel.dataset.path, sel.value);
            commit(); rerender();
        }));
    panel.querySelectorAll('textarea[data-path]').forEach(ta =>
        ta.addEventListener('input', () => {
            setParamByPath(params, ta.dataset.path, ta.value);
            commit();
        }));
    panel.querySelectorAll('.param-tag-input[data-tagsinput]').forEach(inp =>
        inp.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || !inp.value.trim()) return;
            e.preventDefault();
            const path = inp.dataset.tagsinput;
            const arr = [...(getParamByPath(params, path) || [])];
            if (!arr.includes(inp.value.trim())) arr.push(inp.value.trim());
            setParamByPath(params, path, arr);
            commit(); rerender();
        }));
    panel.querySelectorAll('.param-tags .param-tag').forEach(tag =>
        tag.addEventListener('click', () => {
            const path = tag.closest('[data-tagsfor]').dataset.tagsfor;
            const arr = [...(getParamByPath(params, path) || [])];
            arr.splice(parseInt(tag.dataset.tagindex, 10), 1);
            setParamByPath(params, path, arr);
            commit(); rerender();
        }));
}

/**
 * Models view dispatcher: the catalog (chips + cards) or a single model's detail
 * view, chosen by state.ui.mainView.detail.
 */
export function renderModelsView() {
    const catPanel = document.getElementById('modelsCatalogPanel');
    const detPanel = document.getElementById('modelDetailPanel');
    if (!catPanel || !detPanel) return;
    const detail = (state.ui.mainView || {}).detail;
    if (detail) {
        catPanel.hidden = true;
        detPanel.hidden = false;
        renderModelDetail(detail.provider, detail.model);
    } else {
        detPanel.hidden = true;
        catPanel.hidden = false;
        renderModelsCatalog();
    }
}

/**
 * Remove a custom model from its provider's catalog.
 * @param {string} id - The model ID to remove
 * @param {string} provider - The provider that owns it (the catalog card knows it)
 */
export function removeCustomModel(id, provider) {
    const modelConfig = getActiveModelConfig();
    const providerModels = state.settings.customModels[provider];
    if (!providerModels) return;
    const index = providerModels.findIndex(m => m.id === id);
    if (index === -1) return;

    providerModels.splice(index, 1);
    saveCustomModels();

    // If the removed model was the layer's selected one, fall back
    if (modelConfig.provider === provider && modelConfig.model === id) {
        modelConfig.model = providerModels.length > 0 ? providerModels[0].id : '';
        loadModelProfileIntoLayer();
        updateFixedPersonaPin();
        persistSettings();
    }
}

/**
 * Save custom models to storage
 */
/**
 * Persist customModels via /api/settings (it lives under settings server-side).
 * Fire-and-forget.
 */
export function saveCustomModels() {
    API.settings.update({ customModels: state.settings.customModels }).catch(err => {
        console.error('Failed to persist custom models:', err);
    });
}

/**
 * The provider the add-model modal is currently working on. Set from the modal's
 * chip row; every operation in the modal (fetch, manual add) is scoped to it.
 * Before Slice 7 the modal silently used the *active model's* provider, which
 * made adding a model for any other provider unreachable.
 */
export let modelModalProvider = null;

/**
 * Provider chips inside the add-model modal — single-select, unlike the
 * catalog's multi-select filter chips (hence `.single` + role=radio).
 * `status: 'soon'` providers are shown but not selectable.
 */
export function renderModelModalProviders() {
    const row = elements.modelModalProviders;
    if (!row) return;

    let html = '';
    for (const [id, meta] of Object.entries(PROVIDERS)) {
        const soon = meta.status === 'soon';
        const hasKey = !!state.apiKeyStatus[id]?.hasKey;
        const active = id === modelModalProvider;
        const trailing = soon
            ? '<span class="chip-soon">soon</span>'
            : `<span class="chip-dot${hasKey ? ' has-key' : ''}" title="${hasKey ? 'API key saved' : 'no API key'}"></span>`;
        html += `<button class="provider-chip${active ? ' active' : ''}${soon ? ' soon' : ''}" data-modal-provider="${id}"
                type="button" role="radio" aria-checked="${active}"${soon ? ' disabled' : ''}>
                ${providerIconHtml(id)}<span class="chip-label">${escapeHtml(meta.label)}</span>${trailing}
            </button>`;
    }
    row.innerHTML = html;

    row.querySelectorAll('[data-modal-provider]').forEach(btn =>
        btn.addEventListener('click', () => selectModalProvider(btn.dataset.modalProvider)));

    renderFetchSection();
}

/**
 * Switch the modal to another provider: the fetched grid belongs to the old
 * provider, so it's cleared. The manual-add fields are left alone — a half-typed
 * model id is still valid for the newly picked provider.
 * @param {string} provider
 */
export function selectModalProvider(provider) {
    if (!PROVIDERS[provider] || provider === modelModalProvider) return;
    modelModalProvider = provider;
    elements.availableModelsGrid.style.display = 'none';
    elements.availableModelsGrid.innerHTML = '';
    renderModelModalProviders();
}

/**
 * The primary slot + help text for the selected provider. The slot holds one
 * button, whichever action is actually available: Fetch when the provider has a
 * key, "Add <Provider> API key" when it doesn't — rather than a disabled Fetch
 * that can't do anything. Adding a model *manually* never needs a key, so the
 * missing key is stated, not forced (no auto-opening popover).
 *
 * The "not every provider" caveat is literal: the server rejects a provider
 * whose module has no listModels() (see server/src/routes/chat.js).
 */
export function renderFetchSection() {
    const provider = modelModalProvider;
    const meta = PROVIDERS[provider];
    const hasKey = !!state.apiKeyStatus[provider]?.hasKey;

    elements.fetchModelsBtn.hidden = !hasKey;
    elements.fetchModelsBtn.disabled = !hasKey;
    // "Add key" opens the same provider-key popover the catalog uses. It renders
    // at body level (z-index 1000) above the modal overlay (250), so it stacks.
    elements.modalKeyBtn.hidden = hasKey;
    elements.modalKeyBtn.textContent = `Add ${meta.label} API key`;

    elements.fetchModelsHelp.innerHTML = hasKey
        ? `Fetches the model list from ${escapeHtml(meta.label)}'s API. Not every provider offers a list endpoint — add the model manually below if this comes up empty.`
        : `No ${escapeHtml(meta.label)} API key saved. Add one to fetch the model list — or add a model manually below, which doesn't need a key.`;
}

/**
 * Re-render the add-model modal after an API key changed elsewhere (the key
 * popover writes through saveProviderKey/clearStoredApiKey). No-op when closed.
 */
export function refreshAddModelModal() {
    if (!elements.modelModal?.classList.contains('visible')) return;
    renderModelModalProviders();
}

/**
 * Open the add-model modal.
 * @param {string} [provider] - Preselect this provider (a catalog group's
 *   "+ Add"); defaults to the active model's provider.
 */
export function openModelModal(provider) {
    const preferred = PROVIDERS[provider] && PROVIDERS[provider].status !== 'soon'
        ? provider
        : getActiveModelConfig().provider;
    modelModalProvider = PROVIDERS[preferred] ? preferred : Object.keys(PROVIDERS)[0];

    elements.availableModelsGrid.style.display = 'none';
    elements.availableModelsGrid.innerHTML = '';
    elements.newModelId.value = '';
    elements.newModelName.value = '';
    renderModelModalProviders();

    elements.modelModal.classList.add('visible');
}

export function selectModel(modelId, provider) {
    const layer = getActiveModelConfig();
    if (!applyModelToLayer(provider || layer.provider, modelId)) return;
    updateFixedPersonaPin();
    persistSettings();
    updateUI();
}

/**
 * Provider chips above the Models catalog (Layout B, Models tab redesign): an
 * "All" chip plus one per provider. The chips are the writer for the "daily
 * drivers" filter (state.settings.catalogProviders) — multi-select, "All" =
 * show every provider. A status dot shows API-key presence; 'soon' providers
 * render disabled. See docs/MODELS_TAB_REDESIGN.md.
 */
export function renderProviderChips() {
    const row = document.getElementById('providerChips');
    if (!row) return;
    const selected = state.settings.catalogProviders;
    const isAll = !Array.isArray(selected) || selected.length === 0;

    let html = `<button class="provider-chip${isAll ? ' active' : ''}" data-chip="all" type="button">All</button>`;
    for (const [id, meta] of Object.entries(PROVIDERS)) {
        const soon = meta.status === 'soon';
        const hasKey = !!state.apiKeyStatus[id]?.hasKey;
        const active = !isAll && selected.includes(id);
        const trailing = soon
            ? '<span class="chip-soon">soon</span>'
            : `<span class="chip-dot${hasKey ? ' has-key' : ''}" title="${hasKey ? 'API key saved' : 'no API key'}"></span>`;
        html += `<button class="provider-chip${active ? ' active' : ''}${soon ? ' soon' : ''}" data-chip="${id}" type="button"${soon ? ' disabled' : ''}>
                ${providerIconHtml(id)}<span class="chip-label">${escapeHtml(meta.label)}</span>${trailing}
            </button>`;
    }
    row.innerHTML = html;

    row.querySelectorAll('[data-chip]').forEach(btn =>
        btn.addEventListener('click', () => toggleProviderChip(btn.dataset.chip)));
}

/**
 * Toggle a provider chip, persist, and re-render. "All" clears the filter to
 * null (show every provider). From "All", picking a provider narrows to just
 * it; within a subset, a provider is added or removed. Emptying the subset
 * falls back to "All" (saveCatalogProviders normalises []→null).
 * @param {string} chip - a provider id, or 'all'
 */
export function toggleProviderChip(chip) {
    const current = Array.isArray(state.settings.catalogProviders)
        ? [...state.settings.catalogProviders]
        : null;
    let next;
    if (chip === 'all') {
        next = null;
    } else if (current === null) {
        next = [chip];
    } else if (current.includes(chip)) {
        next = current.filter(p => p !== chip);
    } else {
        next = [...current, chip];
    }
    saveCatalogProviders(next); // updates state + debounced persist ([]→null)
    renderModelsCatalog();      // re-renders chips (below) + the filtered catalog
}

/**
 * Models & Providers catalog (WR-13): every added model, grouped by provider,
 * with the provider's API-key status in the group header. Clicking a card
 * makes that model the active layer's (provider switches along); the ⋯ menu
 * removes the model from the catalog. Filtered by the provider chips
 * (state.settings.catalogProviders); null/empty = show all.
 */
export function renderModelsCatalog() {
    const c = document.getElementById('modelsCatalog');
    if (!c) return;
    renderProviderChips(); // chips + catalog always render together, stay in sync
    const layer = getActiveModelConfig();
    const selected = state.settings.catalogProviders;
    const showAll = !Array.isArray(selected) || selected.length === 0;

    let html = '';
    for (const [provider, { label }] of Object.entries(PROVIDERS)) {
        if (!showAll && !selected.includes(provider)) continue;
        const models = state.settings.customModels[provider] || [];
        const hasKey = !!state.apiKeyStatus[provider]?.hasKey;
        const soon = PROVIDERS[provider].status === 'soon';
        const keyBtn = soon ? '' :
            `<button class="group-key-btn" data-key-provider="${provider}" type="button">${hasKey ? 'Manage key' : 'Add key'}</button>`;
        // Per-group add (Slice 7): opens the modal already pointed at this
        // provider, so "how do I add a Google model?" is answered in place.
        const addBtn = soon ? '' :
            `<button class="group-key-btn" data-add-provider="${provider}" type="button">+ Add</button>`;
        html += `
            <div class="model-group-head">
                <span class="model-group-name">${providerIconHtml(provider)}${label}</span>
                <span class="model-group-right">
                    <span class="model-key-badge${hasKey ? ' has-key' : ''}">${hasKey ? 'API key saved' : 'no API key'}</span>
                    ${keyBtn}
                    ${addBtn}
                </span>
            </div>`;
        if (models.length === 0) {
            html += `<p class="empty-state small">No ${label} models added.</p>`;
            continue;
        }
        models.forEach(m => {
            const active = provider === layer.provider && m.id === layer.model;
            html += `
                <div class="model-card${active ? ' active' : ''}">
                    <div class="model-card-open" data-model-select="${escapeHtml(m.id)}" data-provider="${provider}">
                        <div class="model-card-info">
                            <span class="model-card-name">${escapeHtml(m.name)}${active ? '<span class="persona-card-badge">Active</span>' : ''}</span>
                            <span class="model-card-sub">${escapeHtml(m.id)}</span>
                        </div>
                    </div>
                    <button class="project-menu-btn model-card-menu" data-model-menu="${escapeHtml(m.id)}" data-provider="${provider}" title="Options">⋯</button>
                </div>`;
        });
    }
    c.innerHTML = html;

    c.querySelectorAll('[data-model-select]').forEach(el =>
        el.addEventListener('click', () => {
            selectModel(el.dataset.modelSelect, el.dataset.provider);
            renderModelsCatalog(); // refresh the Active badge
        }));
    c.querySelectorAll('[data-model-menu]').forEach(btn =>
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            showModelCardMenu(btn, btn.dataset.modelMenu, btn.dataset.provider);
        }));
    c.querySelectorAll('[data-key-provider]').forEach(btn =>
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            showProviderKeyPopover(btn, btn.dataset.keyProvider);
        }));
    c.querySelectorAll('[data-add-provider]').forEach(btn =>
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openModelModal(btn.dataset.addProvider);
        }));
}

/**
 * Provider API-key editor popover (Models tab redesign, Slice 4). Anchored to a
 * provider's "Manage key"/"Add key" button on its catalog group header. The key
 * is provider-owned — one per provider, shared by all its models. The stored key
 * is never echoed back: the field starts empty (placeholder notes a saved key),
 * Save PUTs a new value, Clear deletes.
 * @param {HTMLElement} anchorEl
 * @param {string} provider
 */
export function showProviderKeyPopover(anchorEl, provider) {
    const existing = document.querySelector('.context-menu, .key-popover');
    if (existing) existing.remove();
    const meta = PROVIDERS[provider];
    if (!meta) return;
    const hasKey = !!state.apiKeyStatus[provider]?.hasKey;

    const pop = document.createElement('div');
    pop.className = 'key-popover';
    pop.innerHTML = `
        <div class="key-popover-title">${escapeHtml(meta.label)} API key</div>
        <div class="key-popover-field">
            <input type="password" class="key-popover-input" autocomplete="off" spellcheck="false"
                placeholder="${hasKey ? 'Key saved — paste to replace' : escapeHtml(meta.keyPlaceholder || 'API key')}">
            <button class="key-popover-eye" type="button">Show</button>
        </div>
        <p class="key-popover-help">Stored encrypted on the server. Shared by all ${escapeHtml(meta.label)} models.</p>
        <div class="key-popover-actions">
            ${hasKey ? '<button class="key-popover-clear" type="button">Clear</button>' : ''}
            <button class="key-popover-save" type="button">Save</button>
        </div>`;
    positionPopover(pop, anchorEl, 'right');

    const input = pop.querySelector('.key-popover-input');
    const save = () => {
        const value = input.value.trim();
        pop.remove();
        if (value) saveProviderKey(provider, value);
    };
    pop.querySelector('.key-popover-eye').addEventListener('click', (e) => {
        const showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        e.target.textContent = showing ? 'Show' : 'Hide';
        input.focus();
    });
    pop.querySelector('.key-popover-save').addEventListener('click', save);
    const clearBtn = pop.querySelector('.key-popover-clear');
    if (clearBtn) clearBtn.addEventListener('click', () => { pop.remove(); clearStoredApiKey(provider); });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
    });

    attachPopoverOutsideClose(pop, anchorEl);
    input.focus();
}

/** Per-card ⋯ menu on the Models section: Remove from catalog. */
export function showModelCardMenu(anchorEl, modelId, provider) {
    const existing = document.querySelector('.context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = `
        <button class="context-menu-item" data-action="edit">Edit settings</button>
        <button class="context-menu-item danger" data-action="remove">Remove</button>`;
    positionPopover(menu, anchorEl, 'right');

    menu.querySelector('[data-action="edit"]').addEventListener('click', () => {
        menu.remove();
        navigate({ type: 'models', detail: { provider, model: modelId } });
    });
    menu.querySelector('[data-action="remove"]').addEventListener('click', () => {
        menu.remove();
        removeCustomModel(modelId, provider);
        renderModelsCatalog();
    });
    attachPopoverOutsideClose(menu, anchorEl);
}

// Register the two region repaints the settings store reaches through the seam.
// Runs at import time, before main.js's own body — Object.assign merges, so this
// and main.js's registration coexist.
registerShell({ renderModelsCatalog, refreshAddModelModal });
