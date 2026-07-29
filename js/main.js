/**
 * Tessera - Main Application Logic
 *
 * Features:
 * - Multi-provider API support (Claude, with OpenAI/Gemini coming)
 * - Customizable personas with system prompts
 * - Floating avatar with expression system
 * - Status bar with session info
 * - Settings persistence via the server API (api-client.js → /api/*)
 *
 * This is the ES module entry point (`<script type="module">` in index.html).
 * It is still the bulk of the frontend; docs/REFACTOR_PLAN.md (R-04, R-05)
 * carves the rest into `js/views/` and `js/chat/`. Nothing
 * here is global any more, so anything a sibling module needs must be exported
 * explicitly — that constraint is the point of the refactor.
 */

import { API } from './api-client.js';
import { CONFIG } from './config.js';
import { state, getActivePersona } from './state.js';
import { elements, scrollToBottom } from './dom.js';
import {
    UiPrefs, applyTheme, withThemeTransition, applyChatWidth, syncAppearanceControls,
} from './ui-prefs.js';
import { createSidebarOverlay, openSidebar, closeSidebar, setupSidebarResize } from './sidebar.js';
import { renderMarkdown, ICON_SVG, messageActionsHTML } from './util/markdown.js';
import { ImageStore } from './util/image-store.js';
import { positionPopover, attachPopoverOutsideClose } from './components/menus.js';
import { showToast, hideCriticalBanner } from './components/toast.js';
import {
    confirmDialog, closeConfirmDialog, closeNameModal, submitNameModal,
} from './components/dialogs.js';
import { displayError } from './components/errors.js';
import {
    escapeHtml, getFileCategory, getFileIcon, getFileTypeLabel,
} from './util/format.js';
import { FilePanel } from './file-panel/index.js';
import {
    applyPersonaModelSettings, hydratePersonas, } from './persona-helpers.js';
import {
    createConversation, restoreConversationModel, loadConversationMessages, saveConversations,
    switchConversation, renderChatsListMain, renderConversation,
    renderConversationList, } from './views/chats.js';
import {
    showPersonaPopover, renderPersonasListMain, blobToBase64,
} from './views/personas.js';
import {
    updateWorkspaceUI, renderBreadcrumb, renderWorkspacesListMain, openContainerPage,
    renderContainerPage, setupTextareaResizers,
} from './views/workspaces.js';
import {
    autoSaveSettings, savePersonas, hydrateApiKeyStatus,
} from './settings-store.js';
import {
    renderModelsView, saveCustomModels, modelModalProvider, openModelModal,
    selectModel, showProviderKeyPopover,
} from './views/models.js';
import { navigate, currentSection, registerShell, renderModelsCatalog } from './shell.js';
import {
    PROVIDERS, providerIconHtml, getModelDisplayName, getActiveModelConfig, personaModelMode, loadModelProfileIntoLayer,
    mirrorLayerToModelProfile, mergeModelConfig, formatNumber,
    updateSendButtonState,
} from './model-layer.js';

// Register this file's shell implementations with the seam, before anything can
// call through it. Function declarations hoist, so they are already defined.
// R-04b moves these three into js/router.js and this call goes with them.
// renderModelsCatalog and refreshAddModelModal are registered by
// js/views/models.js, which owns them.
registerShell({
    renderShell, renderMainView, updateUI, updateSettingsUI, renderChatThread,
});

// ===== Conversation Helpers =====

// ===== File-tools toggle (Track A, P2-05b) =====

/**
 * The persona's base file-tools setting (its default for new chats). Stored in
 * the persona's model_config JSON; absent = off.
 * @param {Object} persona
 * @returns {boolean}
 */
function personaToolsBase(persona) {
    return persona?.modelConfig?.toolsEnabled === true;
}

/**
 * The active chat's per-conversation file-tools override: the saved
 * conversation value, or the pending choice for a fresh unsaved chat.
 * true/false = forced, null/undefined = inherit the persona base.
 */
function getToolsOverride() {
    const convo = getActiveConversation();
    return convo ? convo.toolsEnabled : state.pendingToolsOverride;
}

/**
 * The EFFECTIVE file-tools state for the active chat: the per-conversation
 * override wins, else the active persona's base. Mirrors the server's
 * resolveToolsEnabled precedence so the UI matches what a send will do.
 * @returns {boolean}
 */
function effectiveToolsEnabled() {
    const override = getToolsOverride();
    if (override === true) return true;
    if (override === false) return false;
    return personaToolsBase(getActivePersona());
}

/** Whether the effective state comes from a per-chat override vs the persona base. */
function toolsOverrideActive() {
    const override = getToolsOverride();
    return override === true || override === false;
}

/**
 * Reflect the effective file-tools state on the composer toggle: filled when
 * on, muted when off, with a tooltip naming the source (persona default vs
 * this-chat override).
 */
function syncToolsToggle() {
    const btn = elements.toolsToggleBtn;
    if (!btn) return;
    const on = effectiveToolsEnabled();
    const overridden = toolsOverrideActive();
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    const source = overridden ? 'this chat' : 'persona default';
    btn.title = `File tools ${on ? 'on' : 'off'} (${source}) — click to turn ${on ? 'off' : 'on'}`;
}

/**
 * Composer toggle click: flip the EFFECTIVE state and pin it as a per-chat
 * override. Persisted immediately when the chat exists; stashed as pending for
 * a fresh chat (applied on createConversation).
 */
async function toggleChatTools() {
    const next = !effectiveToolsEnabled();
    const convo = getActiveConversation();
    if (convo) {
        convo.toolsEnabled = next;
        syncToolsToggle();
        FilePanel.onToolsToggled(next); // refresh the tools-off note if the panel is open (CT-06)
        try {
            await API.conversations.update(convo.id, { toolsEnabled: next });
        } catch (err) {
            console.error('Failed to save file-tools override:', err);
        }
    } else {
        state.pendingToolsOverride = next;
        syncToolsToggle();
    }
}

/**
 * Persona editor checkbox: set the active persona's base file-tools default.
 */
function setPersonaToolsBase(on) {
    const persona = getActivePersona();
    if (!persona) return;
    persona.modelConfig = { ...persona.modelConfig };
    if (on) persona.modelConfig.toolsEnabled = true;
    else delete persona.modelConfig.toolsEnabled;
    persona.updatedAt = Date.now();
    savePersonas();
    syncToolsToggle();
}

/** Reflect the active persona's base setting into the editor checkbox. */
function syncPersonaToolsBaseControl() {
    if (elements.personaToolsBase) {
        elements.personaToolsBase.checked = personaToolsBase(getActivePersona());
    }
}

/**
 * Get the currently active conversation object
 * @returns {Object|null} The active conversation or null if none
 */
function getActiveConversation() {
    if (!state.activeConversationId) {
        return null;
    }
    return state.conversations[state.activeConversationId] || null;
}

/**
 * Update a conversation with partial data
 * @param {string} id - The conversation ID to update
 * @param {Object} updates - Partial updates to apply
 */
function updateConversation(id, updates) {
    if (!state.conversations[id]) {
        console.warn(`Conversation ${id} not found`);
        return;
    }

    state.conversations[id] = {
        ...state.conversations[id],
        ...updates,
        updatedAt: Date.now()
    };

    saveConversations();
}

/**
 * Generate a title from the first user message
 * @param {string} content - The first message content
 * @returns {string} A truncated title
 */
function generateConversationTitle(content) {
    const maxLength = 50;
    const cleaned = content.trim().replace(/\s+/g, ' ');

    if (cleaned.length <= maxLength) {
        return cleaned;
    }

    return cleaned.substring(0, maxLength).trim() + '...';
}

// ===== Persona Helpers =====

// ===== Model profiles: the parts that touch a conversation =====
// The profile machinery itself now lives in js/model-layer.js; what stays here
// is the conversation-facing edge of it.

// ===== Persona model-settings mode (WR-12, reshaped by model profiles) =====
// A persona's modelConfig JSON is now a PIN, not a snapshot:
//   'shared' (default) — modelConfig is {}; the persona never touches the
//                        active layer. Pure skin.
//   'fixed'            — modelConfig is { mode:'fixed', provider, model }:
//                        activating the persona selects that model, which
//                        loads the model's own profile. The params live on
//                        the model, never on the persona.

/**
 * Deep-clone a persona's saved modelConfig into layer shape (no mode flag).
 * Legacy-seed helper: only used by init() to seed the layer on the first load
 * after the WR-12 de-sync upgrade, when personas still held full snapshots.
 */
function layerFromPersona(persona) {
    const cfg = mergeModelConfig(persona?.modelConfig);
    delete cfg.mode;
    return cfg;
}

/** Reflect the active persona's model-settings mode into the editor toggle. */
function syncPersonaModelModeControls() {
    const persona = getActivePersona();
    const mode = personaModelMode(persona);
    document.querySelectorAll('#personaModelModeOptions button').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.modelMode === mode);
    });
    const hint = document.getElementById('personaModelModeHint');
    if (hint) {
        if (mode === 'fixed') {
            const pinnedModel = persona?.modelConfig?.model || '';
            const label = pinnedModel ? getModelDisplayName(pinnedModel) : 'its pinned model';
            hint.textContent = `Fixed: activating this persona always loads ${label} and that model's saved parameters.`;
        } else {
            hint.textContent = 'Shared: this persona uses whatever model (and its saved parameters) is currently active.';
        }
    }
}

/**
 * Set the active persona's model-settings mode (from the editor toggle).
 * Flipping to 'fixed' pins the CURRENTLY selected model — the params stay on
 * the model's own profile, never on the persona. Flipping to 'shared' drops
 * the pin.
 */
function setPersonaModelMode(mode) {
    const persona = getActivePersona();
    if (!persona || personaModelMode(persona) === mode) return;
    if (mode === 'fixed') {
        const layer = getActiveModelConfig();
        persona.modelConfig = { mode: 'fixed', provider: layer.provider, model: layer.model };
    } else {
        persona.modelConfig = {};
    }
    persona.updatedAt = Date.now();
    savePersonas();
    syncPersonaModelModeControls();
}

/**
 * Update a persona with partial data
 * @param {string} id - The persona ID to update
 * @param {Object} updates - Partial updates to apply
 */
function updatePersona(id, updates) {
    if (!state.personas[id]) {
        console.warn(`Persona ${id} not found`);
        return;
    }

    state.personas[id] = {
        ...state.personas[id],
        ...updates,
        updatedAt: Date.now()
    };

    savePersonas();
}

// ===== Initialization =====
// init() is called by bootstrap() in the auth-gate block (P0-14) once the
// user is authenticated. It fetches all server-side state in parallel,
// hydrates the in-memory `state` object, then wires the UI.
async function init() {
    // Parallel fetch — these are independent endpoints.
    const [settings, personas, conversations, apiKeyStatus, workspaces, projects] = await Promise.all([
        API.settings.get(),
        API.personas.list(),
        API.conversations.list(),
        API.apiKeys.list(),
        // Workspaces + projects are non-essential to core chat — degrade to empty
        // on failure rather than blocking the whole app load (the others are
        // essential and intentionally fail-fast).
        API.workspaces.list().catch(err => {
            console.warn('Failed to load workspaces; continuing without them:', err);
            return [];
        }),
        API.projects.list().catch(err => {
            console.warn('Failed to load projects; continuing without them:', err);
            return [];
        }),
    ]);

    hydrateSettings(settings);
    hydratePersonas(personas);
    hydrateConversations(conversations);
    hydrateApiKeyStatus(apiKeyStatus);
    hydrateWorkspaces(workspaces);
    hydrateProjects(projects);

    // Pick the most recently updated persona/conversation as active.
    pickActivePersona();
    pickActiveConversation();

    // Seed the active model layer (WR-12) on first load after the de-sync
    // upgrade: adopt the active persona's saved config so nothing visibly
    // changes. Persisted immediately so the seed is stable across devices.
    if (!state.currentModelConfig) {
        state.currentModelConfig = layerFromPersona(getActivePersona());
        API.settings.update({ currentModelConfig: state.currentModelConfig }).catch(err => {
            console.error('Failed to persist seeded model layer:', err);
        });
    }

    // One-time migration (model profiles): prefill used to live on the
    // persona. When the saved layer predates the move, adopt the active
    // persona's prefill into the layer + the active model's profile so
    // existing setups keep responding the same after the upgrade.
    if (layerNeedsPrefillSeed && getActivePersona()?.prefill) {
        state.currentModelConfig.modelParams.prefill = getActivePersona().prefill;
        mirrorLayerToModelProfile();
        API.settings.update({
            currentModelConfig: state.currentModelConfig,
            customModels: state.settings.customModels,
        }).catch(err => {
            console.error('Failed to persist migrated prefill:', err);
        });
    }

    // Restore the entered container (device-local). A project implies its
    // workspace; otherwise restore a bare workspace. Stale ids are cleared. If
    // the picked conversation isn't in the restored container, drop it so the
    // container's view shows on load instead of an unrelated chat.
    restoreActiveContainer();

    // Fetch messages for the active conversation eagerly so the first
    // render isn't empty. Other conversations are lazy-loaded on switch.
    if (state.activeConversationId) {
        await loadConversationMessages(state.activeConversationId);
    }

    // Reload = reopening the chat: align the persona with the restored
    // conversation (pickActivePersona's most-recently-edited guess above is
    // only a fallback for when no chat is restored) and bring back the chat's
    // model — same behavior as switchConversation, so a reload never swaps
    // the persona or engine mid-conversation.
    const restoredConvo = getActiveConversation();
    if (restoredConvo) {
        if (restoredConvo.personaId && state.personas[restoredConvo.personaId]) {
            state.activePersonaId = restoredConvo.personaId;
            applyPersonaModelSettings(getActivePersona()); // fixed pin wins
        }
        restoreConversationModel(restoredConvo);
    }

    // (Appearance/layout prefs are applied early in bootstrap so they cover the
    // login screen too — no need to re-apply here.)

    // Wire UI after state is populated so listeners read coherent state.
    setupEventListeners();
    applyDevMode(); // reflect the device-local developer-mode pref
    await updateUI();
    createSidebarOverlay();

    // ImageStore is retained for transient pre-send attachment blobs only.
    // It is NOT required to run the app — avatars and all persisted data come
    // from the server. If IndexedDB is unavailable (private mode, or a privacy/
    // ad-block extension blocking site storage), degrade gracefully: the app
    // loads normally and only image attachments are disabled for the session.
    // Crashing init() here would log the user straight back out.
    try {
        await ImageStore.init();
        window.addEventListener('beforeunload', () => {
            ImageStore.revokeAllURLs();
        });
    } catch (err) {
        console.warn('ImageStore (IndexedDB) unavailable — image attachments disabled this session:', err);
        showToast(
            'Image attachments are unavailable because this browser is blocking local storage (often a privacy extension or private mode). The rest of the app works normally.',
            { type: 'warning', duration: 9000, key: 'imagestore-unavailable' }
        );
    }

    console.log('Tessera initialized!');
}

// ===== Server → state hydration =====

// True when the saved layer predates the prefill move into model params —
// init() then adopts the active persona's legacy prefill once.
let layerNeedsPrefillSeed = false;

function hydrateSettings(settings) {
    if (!settings) return;
    layerNeedsPrefillSeed = settings.currentModelConfig?.modelParams?.prefill === undefined;
    state.settings.avatarSize = settings.avatarSize || CONFIG.defaults.avatarSize;
    state.settings.avatarPosition = settings.avatarPosition || CONFIG.defaults.avatarPosition;
    state.settings.showAvatar = settings.showAvatar !== undefined ? settings.showAvatar : CONFIG.defaults.showAvatar;
    state.settings.activeFileTurns = settings.activeFileTurns !== undefined ? settings.activeFileTurns : CONFIG.defaults.activeFileTurns;
    // customModels arrives as an object keyed by provider (parsed JSON from
    // the server). Default empty arrays per provider if absent.
    const cm = settings.customModels || {};
    state.settings.customModels = {
        anthropic: Array.isArray(cm.anthropic) ? cm.anthropic : [],
        google: Array.isArray(cm.google) ? cm.google : [],
        openai: Array.isArray(cm.openai) ? cm.openai : [],
    };
    // Models catalog "daily drivers" filter. null (server default) = "All".
    state.settings.catalogProviders = Array.isArray(settings.catalogProviders)
        ? settings.catalogProviders
        : null;
    // The active model layer (WR-12). NULL sentinel = not yet seeded (first
    // load after the de-sync upgrade) — init() seeds it from the active
    // persona once personas are hydrated.
    state.currentModelConfig = settings.currentModelConfig
        ? (() => { const cfg = mergeModelConfig(settings.currentModelConfig); delete cfg.mode; return cfg; })()
        : null;
}

function hydrateConversations(conversations) {
    state.conversations = {};
    for (const c of (conversations || [])) {
        // List endpoint returns metadata only — messages are loaded lazily
        // via API.conversations.get(id). `messages: undefined` is the sentinel
        // for "not yet loaded"; `messages: []` is "loaded, empty".
        state.conversations[c.id] = {
            id: c.id,
            title: c.title,
            personaId: c.personaId,
            projectId: c.projectId,
            workspaceId: c.workspaceId,
            // Track A per-chat file-tools override: null = inherit persona base,
            // true/false = forced. Preserved so the composer toggle reflects it.
            toolsEnabled: c.toolsEnabled ?? null,
            // Scratchpad per-chat override (SP-03a): null = inherit persona base
            // + auto-arm, true/false = forced. Drives the panel's Active toggle.
            scratchpadEnabled: c.scratchpadEnabled ?? null,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            messageCount: c.messageCount || 0,
            messages: undefined,
        };
    }
}

function hydrateProjects(projects) {
    state.projects = {};
    for (const p of (projects || [])) {
        state.projects[p.id] = {
            id: p.id,
            workspaceId: p.workspaceId || null,
            name: p.name,
            instructions: p.instructions || '',
            fileCount: p.fileCount || 0,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
        };
    }
}

function hydrateWorkspaces(workspaces) {
    state.workspaces = {};
    for (const w of (workspaces || [])) {
        state.workspaces[w.id] = {
            id: w.id,
            name: w.name,
            instructions: w.instructions || '',
            projectCount: w.projectCount || 0,
            fileCount: w.fileCount || 0,
            createdAt: w.createdAt,
            updatedAt: w.updatedAt,
        };
    }
}

/**
 * Restore the device-local "entered container" on load. A saved project implies
 * its workspace; a bare saved workspace restores just that. Stale ids (deleted
 * since) are dropped. If the active conversation doesn't belong to the restored
 * container, it's cleared so the container's view shows instead of a stray chat.
 */
function restoreActiveContainer() {
    const savedProject = UiPrefs.get('activeProject');
    const savedWorkspace = UiPrefs.get('activeWorkspace');

    if (savedProject && state.projects[savedProject]) {
        state.activeProjectId = savedProject;
        state.activeWorkspaceId = state.projects[savedProject].workspaceId || null;
    } else if (savedWorkspace && state.workspaces[savedWorkspace]) {
        state.activeWorkspaceId = savedWorkspace;
        state.activeProjectId = null;
    } else {
        state.activeProjectId = null;
        state.activeWorkspaceId = null;
    }

    // Persist the reconciled state (clears any stale stored ids).
    UiPrefs.set('activeProject', state.activeProjectId);
    UiPrefs.set('activeWorkspace', state.activeWorkspaceId);

    const convo = getActiveConversation();
    if (convo) {
        const inContainer = state.activeProjectId
            ? convo.projectId === state.activeProjectId
            : (state.activeWorkspaceId ? convo.workspaceId === state.activeWorkspaceId : false);
        if (!inContainer && (state.activeProjectId || state.activeWorkspaceId)) {
            state.activeConversationId = null;
        }
    }

    // Initial main-area view (WR-07): resume the active chat, else the active
    // container page, else the Chats list.
    if (state.activeConversationId) {
        state.ui.mainView = { type: 'chat', id: state.activeConversationId };
    } else if (state.activeProjectId) {
        state.ui.mainView = { type: 'project', id: state.activeProjectId };
    } else if (state.activeWorkspaceId) {
        state.ui.mainView = { type: 'workspace', id: state.activeWorkspaceId };
    } else {
        state.ui.mainView = { type: 'chats' };
    }
}

function pickActivePersona() {
    const personas = Object.values(state.personas);
    if (personas.length === 0) {
        state.activePersonaId = null;
        return;
    }
    const mostRecent = personas.reduce((a, b) =>
        (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a
    );
    state.activePersonaId = mostRecent.id;
}

function pickActiveConversation() {
    const convos = Object.values(state.conversations);
    if (convos.length === 0) {
        state.activeConversationId = null;
        return;
    }
    const mostRecent = convos.reduce((a, b) =>
        (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a
    );
    state.activeConversationId = mostRecent.id;
}

// ===== Settings Management =====

/**
 * Update only settings-related UI elements (not conversation)
 * Used by auto-save to avoid re-rendering messages and causing flicker
 */
function updateSettingsUI() {
    const persona = getActivePersona();

    // Update header with assistant name
    const headerName = document.querySelector('.assistant-name');
    if (headerName) {
        headerName.textContent = persona ? persona.name : CONFIG.defaults.assistantName;
    }

    // Update model display
    const modelDisplay = document.querySelector('.model-display');
    if (modelDisplay) {
        const modelConfig = getActiveModelConfig();
        modelDisplay.textContent = modelConfig.model;
    }

    // Update status bar
    updateStatusBar();

    // Keep the Models catalog's key badges current while it's open (e.g. a
    // key was just typed — the optimistic hasKey update lands on this path).
    if ((state.ui.mainView || {}).type === 'models') renderModelsCatalog();
}

/**
 * Persist a single new message to the server. Returns the server-augmented
 * message (with the server-generated id) so callers can update state.
 * Throws on failure — the caller can decide whether to surface the error.
 */
async function persistMessage(conversationId, message) {
    return await API.messages.create(conversationId, {
        role: message.role,
        content: message.content,
        attachments: message.attachments || [],
        ...(message.model ? { model: message.model } : {}),
    });
}

// ===== UI Updates =====
async function updateUI() {
    const persona = getActivePersona();
    const modelConfig = getActiveModelConfig();

    // The active model/provider live on the layer; the old provider/model
    // <select>s and API-key field are gone (Slice 4). Switching is via catalog
    // cards; the key is provider-owned. Just keep the layer pointing at a valid
    // model (fall back if the active one was removed from its provider).
    ensureActiveModelValid();
    elements.assistantName.value = persona ? persona.name : CONFIG.defaults.assistantName;
    elements.personaTagline.value = persona ? (persona.tagline || '') : '';
    elements.personaRoleLabel.value = persona ? (persona.roleLabel || '') : '';
    syncPersonaFieldCounters();
    elements.systemPrompt.value = persona ? persona.systemPrompt : CONFIG.defaults.systemPrompt;
    elements.showAvatar.checked = state.settings.showAvatar;
    if (elements.activeFileTurns) elements.activeFileTurns.value = state.settings.activeFileTurns;

    // Model params are shown/edited in the per-model detail view (Slice 5), not
    // a static section here — nothing to load into on a general updateUI.

    // Reflect avatar size (presets + slider) and position (presets) into the UI.
    syncAvatarSizeControls();
    syncAvatarPositionControls();

    // Reflect appearance prefs (theme / accent / chat width) into the controls.
    syncAppearanceControls();

    // Reflect the active persona's model-settings mode (persona editor toggle).
    syncPersonaModelModeControls();
    // Reflect the persona's file-tools base default + the composer toggle
    // (effective state depends on both persona base and per-chat override).
    syncPersonaToolsBaseControl();
    syncToolsToggle();

    // Keep the Models catalog current (Active badge, key badges) while open.
    if ((state.ui.mainView || {}).type === 'models') renderModelsCatalog();

    // Update header
    elements.headerAssistantName.textContent = persona ? persona.name : CONFIG.defaults.assistantName;
    setModelIndicator(getModelDisplayName(modelConfig.model));
    syncPersonaEditTitle();

    // Reflect the active workspace in the top-bar chip + sidebar scope.
    updateWorkspaceUI();

    // Update avatar preview in settings (async - loads from IndexedDB)
    await updateAvatarPreview();

    // Update floating avatar (async - loads from IndexedDB)
    await updateFloatingAvatar();

    // Update avatar toggle button
    elements.avatarToggleBtn.classList.toggle('active', state.settings.showAvatar);

    // Update status bar
    updateStatusBar();

    // Update expression list (async - loads from IndexedDB)
    await renderExpressionList();

    // Update send button state
    updateSendButtonState();

    // Render conversation
    renderConversation();

    // Update sidebar lists
    renderConversationList();
}

// ===== Per-model detail view (Models tab redesign, Slice 5) =====
// The static Advanced Settings section is gone. A model's params are edited in a
// descriptor-driven detail view rendered from PROVIDERS[provider].params — the
// first real consumer of the param-descriptor engine set up in Slice 1. Provider
// alignment is by omission (a provider lists fewer descriptors); showWhen gates
// dependent params (Anthropic thinking budget, Gemini thinking mode); enableKey
// is the per-param on/off override for temp/topP/topK.

function updateAvatarPreview() {
    const preview = elements.avatarPreview;
    const name = elements.avatarPreviewName;
    const tagline = elements.avatarPreviewTagline;
    const status = elements.avatarPreviewStatus;
    const persona = getActivePersona();

    name.textContent = persona ? persona.name : CONFIG.defaults.assistantName;
    tagline.textContent = persona ? (persona.tagline || '') : '';

    if (persona && persona.avatarFilename) {
        // Cache-bust on updatedAt so re-uploads are immediately visible.
        const url = `${API.avatars.getUrl(persona.id)}?v=${persona.updatedAt || 0}`;
        preview.innerHTML = `<img src="${url}" alt="Avatar">`;
        status.textContent = 'Custom Avatar';
    } else {
        preview.textContent = '🤖';
        status.textContent = 'Default Avatar';
    }
}

/**
 * Refresh the "n/max" counters next to the tagline and role inputs. Both are
 * capped by `maxlength` on the input, so this only reports — it never trims.
 */
function syncPersonaFieldCounters() {
    const pairs = [
        [elements.personaTagline, elements.personaTaglineCount],
        [elements.personaRoleLabel, elements.personaRoleLabelCount],
    ];
    for (const [input, counter] of pairs) {
        if (!input || !counter) continue;
        counter.textContent = `${input.value.length}/${input.maxLength}`;
    }
}

// ===== Floating avatar size/position (named presets OR free values) =====
// avatarSize: a preset name OR a numeric px string. avatarPosition: a corner
// preset OR "x,y" where x,y are 0..100 fractions of the AVAILABLE travel
// (chat area minus the avatar), so a synced free position stays in-bounds
// across different screen sizes.
const AVATAR_PRESET_PX = { small: 80, medium: 120, large: 180, xlarge: 240 };
const AVATAR_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const AVATAR_SIZE_MIN = 32;
const AVATAR_SIZE_MAX = 480;
const AVATAR_FONT_RATIO = 0.025; // px → rem for the emoji (120px → 3rem, matches presets)

function isAvatarPreset(size) {
    return Object.prototype.hasOwnProperty.call(AVATAR_PRESET_PX, size);
}
function isAvatarCorner(pos) {
    return AVATAR_CORNERS.includes(pos);
}
function avatarSizeToPx(size) {
    if (isAvatarPreset(size)) return AVATAR_PRESET_PX[size];
    const n = parseInt(size, 10);
    if (!Number.isFinite(n)) return AVATAR_PRESET_PX.medium;
    return Math.max(AVATAR_SIZE_MIN, Math.min(AVATAR_SIZE_MAX, n));
}
function parseAvatarFreePos(pos) {
    if (typeof pos !== 'string') return null;
    const parts = pos.split(',');
    if (parts.length !== 2) return null;
    const x = parseFloat(parts[0]);
    const y = parseFloat(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) };
}

function applyAvatarSize(image, size) {
    if (isAvatarPreset(size)) {
        image.className = `avatar-image size-${size}`;
        image.style.width = '';
        image.style.height = '';
        image.style.fontSize = '';
    } else {
        const px = avatarSizeToPx(size);
        image.className = 'avatar-image';
        image.style.width = `${px}px`;
        image.style.height = `${px}px`;
        image.style.fontSize = `${px * AVATAR_FONT_RATIO}rem`;
    }
}

function applyAvatarPosition(avatar, pos) {
    const free = isAvatarCorner(pos) ? null : parseAvatarFreePos(pos);
    if (!free) {
        const corner = isAvatarCorner(pos) ? pos : CONFIG.defaults.avatarPosition;
        avatar.className = `floating-avatar ${corner}`;
        avatar.style.left = '';
        avatar.style.top = '';
        avatar.style.right = '';
        avatar.style.bottom = '';
        return;
    }
    avatar.className = 'floating-avatar';
    const chatArea = document.getElementById('chatArea');
    // Layout sizes (offset/client), NOT getBoundingClientRect(): the rect is
    // shrunk by the hidden state's scale(0.8) while the avatar is hidden or
    // still fading in, which overstates the available travel and pushes a
    // right/bottom-side avatar past the edge on show.
    const maxLeft = Math.max(0, chatArea.clientWidth - avatar.offsetWidth);
    const maxTop = Math.max(0, chatArea.clientHeight - avatar.offsetHeight);
    avatar.style.left = `${(free.x / 100) * maxLeft}px`;
    avatar.style.top = `${(free.y / 100) * maxTop}px`;
    avatar.style.right = 'auto';
    avatar.style.bottom = 'auto';
}

// Reflect the current avatar size into the preset buttons + the slider/value.
function syncAvatarSizeControls() {
    const size = state.settings.avatarSize;
    document.querySelectorAll('.size-preset-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.size === size);
    });
    const px = avatarSizeToPx(size);
    if (elements.avatarSizeSlider) elements.avatarSizeSlider.value = String(px);
    if (elements.avatarSizeValue) elements.avatarSizeValue.textContent = `${px}px`;
}

// Reflect the current avatar position into the corner preset buttons (none
// active when the avatar is freely placed).
function syncAvatarPositionControls() {
    const pos = state.settings.avatarPosition;
    document.querySelectorAll('.position-preset-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.position === pos);
    });
}

// ===== Avatar display setters =====
// Shared by the Settings "Avatar Display" controls and the top-bar avatar
// popover (WR-10). The sync helpers above match buttons by class, so both
// UIs stay consistent whichever one made the change.

async function setAvatarSize(size) {
    state.settings.avatarSize = size;
    syncAvatarSizeControls();
    await updateFloatingAvatar();
    autoSaveSettings();
}

async function setAvatarPosition(pos) {
    state.settings.avatarPosition = pos;
    syncAvatarPositionControls();
    await updateFloatingAvatar();
    autoSaveSettings();
}

async function setShowAvatar(show) {
    state.settings.showAvatar = show;
    elements.showAvatar.checked = show;
    await updateFloatingAvatar();
    elements.avatarToggleBtn.classList.toggle('active', show);
    autoSaveSettings();
}

// Drag the floating avatar (by its frame) to position it freely within the
// chat area. The result is stored as "x,y" % of available travel and saved.
function setupAvatarDrag() {
    const avatar = elements.floatingAvatar;
    if (!avatar) return;
    const frame = avatar.querySelector('.avatar-frame');
    const chatArea = document.getElementById('chatArea');
    if (!frame || !chatArea) return;

    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    frame.addEventListener('pointerdown', (e) => {
        if (!state.settings.showAvatar) return;
        dragging = true;
        moved = false;
        const aRect = avatar.getBoundingClientRect();
        const cRect = chatArea.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startLeft = aRect.left - cRect.left;
        startTop = aRect.top - cRect.top;
        avatar.classList.add('dragging');
        try { frame.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        e.preventDefault();
    });

    frame.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        moved = true;
        // Layout sizes for the travel bounds (transform-immune — see applyAvatarPosition).
        const maxLeft = Math.max(0, chatArea.clientWidth - avatar.offsetWidth);
        const maxTop = Math.max(0, chatArea.clientHeight - avatar.offsetHeight);
        const left = Math.max(0, Math.min(maxLeft, startLeft + (e.clientX - startX)));
        const top = Math.max(0, Math.min(maxTop, startTop + (e.clientY - startY)));
        // Drop any corner preset but keep the base + dragging classes.
        avatar.classList.remove('top-left', 'top-right', 'bottom-left', 'bottom-right');
        avatar.style.left = `${left}px`;
        avatar.style.top = `${top}px`;
        avatar.style.right = 'auto';
        avatar.style.bottom = 'auto';
    });

    const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        avatar.classList.remove('dragging');
        try { frame.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        if (!moved) return;
        const cRect = chatArea.getBoundingClientRect();
        const aRect = avatar.getBoundingClientRect();
        const maxLeft = Math.max(1, chatArea.clientWidth - avatar.offsetWidth);
        const maxTop = Math.max(1, chatArea.clientHeight - avatar.offsetHeight);
        const xPct = Math.max(0, Math.min(100, ((aRect.left - cRect.left) / maxLeft) * 100));
        const yPct = Math.max(0, Math.min(100, ((aRect.top - cRect.top) / maxTop) * 100));
        state.settings.avatarPosition = `${xPct.toFixed(2)},${yPct.toFixed(2)}`;
        syncAvatarPositionControls();
        autoSaveSettings();
    };
    frame.addEventListener('pointerup', endDrag);
    frame.addEventListener('pointercancel', endDrag);

    // Re-clamp a freely-placed avatar when the viewport size changes.
    window.addEventListener('resize', () => {
        if (!isAvatarCorner(state.settings.avatarPosition)) {
            applyAvatarPosition(avatar, state.settings.avatarPosition);
        }
    });
}

async function updateFloatingAvatar() {
    const avatar = elements.floatingAvatar;
    const image = elements.avatarImage;
    const persona = getActivePersona();
    const expressions = persona ? persona.expressions : CONFIG.defaultExpressions;

    // Size first, so the avatar has correct dimensions before we position it.
    applyAvatarSize(image, state.settings.avatarSize);

    // Position (preset corner OR free "x,y"). This resets the wrapper's
    // className, so apply the hidden state afterwards.
    applyAvatarPosition(avatar, state.settings.avatarPosition);
    // Floating avatar only appears in a chat view (WR-07b), and only if enabled.
    const inChat = (state.ui.mainView || {}).type === 'chat';
    avatar.classList.toggle('hidden', !state.settings.showAvatar || !inChat);

    // Built-in pulse while the model generates (P2-U2). Plays over a custom
    // generating image/gif too, and clears automatically when the expression
    // changes, since this runs on every setExpression().
    avatar.classList.toggle('generating', state.currentExpression === CONFIG.generatingExpression);

    // Update image or emoji.
    // Priority: expression image > default avatar > emoji.
    const currentExpr = expressions[state.currentExpression] || expressions.neutral;
    const cacheBust = persona && persona.updatedAt ? `?v=${persona.updatedAt}` : '';

    // Expression image URL — derive from persona id + expression name.
    let expressionImageUrl = null;
    if (persona && currentExpr && currentExpr.imageKey) {
        expressionImageUrl = `${API.avatars.getExpressionUrl(persona.id, state.currentExpression)}${cacheBust}`;
    }

    // Default avatar URL.
    let avatarImageUrl = null;
    if (persona && persona.avatarFilename) {
        avatarImageUrl = `${API.avatars.getUrl(persona.id)}${cacheBust}`;
    }

    const moodEmoji = (currentExpr && currentExpr.emoji) || '🤖';
    if (expressionImageUrl) {
        // The expression has art of its own — it already conveys the mood, so
        // no badge.
        elements.avatarEmoji.style.display = 'none';
        elements.avatarImg.style.display = 'block';
        elements.avatarImg.src = expressionImageUrl;
        elements.avatarMoodBadge.hidden = true;
    } else if (avatarImageUrl) {
        // Default avatar carries identity; the badge carries mood. Without it,
        // a persona with an avatar but no per-expression art would never
        // visibly change expression at all.
        elements.avatarEmoji.style.display = 'none';
        elements.avatarImg.style.display = 'block';
        elements.avatarImg.src = avatarImageUrl;
        elements.avatarMoodBadge.textContent = moodEmoji;
        elements.avatarMoodBadge.hidden = false;
    } else {
        // Nothing uploaded at all — the emoji IS the avatar, so no badge.
        elements.avatarEmoji.style.display = 'block';
        elements.avatarImg.style.display = 'none';
        elements.avatarEmoji.textContent = moodEmoji;
        elements.avatarMoodBadge.hidden = true;
    }

    // Update name and expression label
    elements.floatingAvatarName.textContent = persona ? persona.name : CONFIG.defaults.assistantName;
    elements.floatingAvatarExpression.textContent = state.currentExpression;
}

// Slimmed to tokens only (WR-10): mood is the avatar itself, and the message
// count / session timer never informed a decision.
function updateStatusBar() {
    elements.statusTokens.textContent = `~${formatNumber(state.estimatedTokens)}`;
}

/**
 * Display name for a per-message model tag (WR-14). Unlike
 * getModelDisplayName it searches EVERY provider's catalog — an old message
 * may have been generated under a different provider than the active one.
 */
function modelTagLabel(modelId) {
    for (const models of Object.values(state.settings.customModels)) {
        const m = (models || []).find(x => x.id === modelId);
        if (m) return m.name;
    }
    return modelId; // removed from the catalog — show the raw id
}

// ===== Expression Management =====
/**
 * Render the persona's expression set as a grid of face tiles. Image-first:
 * the art is the point, so each slot shows the actual expression image at a
 * size you can judge, reusing the persona-card portrait language. Slots with
 * no image show their emoji and read as "unfilled" so gaps are obvious.
 */
async function renderExpressionList() {
    const list = elements.expressionList;
    list.innerHTML = '';

    const persona = getActivePersona();
    const expressions = persona ? persona.expressions : CONFIG.defaultExpressions;

    const cacheBust = persona && persona.updatedAt ? `?v=${persona.updatedAt}` : '';
    const avatarUrl = persona && persona.avatarFilename
        ? `${API.avatars.getUrl(persona.id)}${cacheBust}`
        : null;
    for (const [name, expr] of Object.entries(expressions)) {
        const hasImage = !!(persona && expr.imageKey);
        // Three states worth distinguishing visually: has its own art, falls
        // back to the avatar + badge, or is a genuinely empty slot (dashed).
        const fallbackClass = hasImage ? '' : (avatarUrl ? ' fallback-avatar' : ' no-image');
        const item = document.createElement('div');
        item.className = `expression-slot${fallbackClass}`;
        item.setAttribute('role', 'button');
        item.tabIndex = 0;
        item.title = `Edit "${name}"`;
        item.onclick = () => openExpressionModal(name);
        item.onkeydown = (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openExpressionModal(name);
            }
        };

        // Mirrors exactly what the chat will render for this expression:
        // its own art if it has any, otherwise the default avatar wearing the
        // emoji as a mood badge, otherwise the bare emoji.
        let face;
        if (hasImage) {
            face = `<img src="${API.avatars.getExpressionUrl(persona.id, name)}${cacheBust}" alt="${escapeHtml(name)}">`;
        } else if (avatarUrl) {
            face = `<img src="${avatarUrl}" alt="${escapeHtml(name)}">
                    <span class="expression-slot-badge">${expr.emoji || '🙂'}</span>`;
        } else {
            face = `<span class="expression-slot-emoji">${expr.emoji || '🙂'}</span>`;
        }

        item.innerHTML = `
            <div class="expression-slot-face">${face}</div>
            <span class="expression-slot-name">${escapeHtml(name)}</span>
            ${name === CONFIG.generatingExpression ? '<span class="expression-slot-tag">auto</span>' : ''}
        `;

        list.appendChild(item);
    }
}

let editingExpression = null;

async function openExpressionModal(name = null) {
    editingExpression = name;

    // Reset temp state
    if (state.tempExpressionPreviewUrl) {
        URL.revokeObjectURL(state.tempExpressionPreviewUrl);
    }
    state.tempExpressionBlob = null;
    state.tempExpressionPreviewUrl = '';
    state.tempExpressionCleared = false;

    const persona = getActivePersona();
    const expressions = persona ? persona.expressions : {};

    if (name && expressions[name]) {
        const expr = expressions[name];
        elements.expressionModalTitle.textContent = 'Edit Expression';
        elements.expressionName.value = name;
        elements.expressionEmoji.value = expr.emoji;
        // The generating slot is the UI's own state, not a declarable mood —
        // its art is editable but the slot itself can't be removed.
        elements.deleteExpressionBtn.style.display =
            name === CONFIG.generatingExpression ? 'none' : 'block';

        // Server URL for the expression image (cache-busted).
        if (persona && expr.imageKey) {
            const cacheBust = persona.updatedAt ? `?v=${persona.updatedAt}` : '';
            const imageUrl = `${API.avatars.getExpressionUrl(persona.id, name)}${cacheBust}`;
            elements.expressionImagePreview.innerHTML = `<img src="${imageUrl}" alt="${name}">`;
        } else {
            elements.expressionImagePreview.innerHTML = '<span class="preview-placeholder">No image</span>';
        }
    } else {
        elements.expressionModalTitle.textContent = 'Add Expression';
        elements.expressionName.value = '';
        elements.expressionEmoji.value = '';
        elements.deleteExpressionBtn.style.display = 'none';
        elements.expressionImagePreview.innerHTML = '<span class="preview-placeholder">No image</span>';
    }

    elements.expressionModal.classList.add('visible');
}

function closeExpressionModal() {
    elements.expressionModal.classList.remove('visible');
    editingExpression = null;

    // Clean up temp resources
    if (state.tempExpressionPreviewUrl) {
        URL.revokeObjectURL(state.tempExpressionPreviewUrl);
    }
    state.tempExpressionBlob = null;
    state.tempExpressionPreviewUrl = '';
    state.tempExpressionCleared = false;
}

async function saveExpression() {
    const name = elements.expressionName.value.trim().toLowerCase();
    const emoji = elements.expressionEmoji.value.trim() || '😊';

    if (!name) {
        showToast('Please enter an expression name', { type: 'warning' });
        return;
    }
    // The name is interpolated into the model's expression protocol AND used as
    // a filename + URL segment by the avatar routes, so all three agree on this
    // charset. No spaces: the image endpoints reject them, which would leave the
    // expression permanently unable to hold art.
    if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(name)) {
        showToast('Use letters, numbers, - or _ (no spaces, max 31 characters)', { type: 'warning' });
        return;
    }
    if (name === CONFIG.generatingExpression && editingExpression !== CONFIG.generatingExpression) {
        showToast(`"${CONFIG.generatingExpression}" is reserved for the working-on-it state`, { type: 'warning' });
        return;
    }

    const persona = getActivePersona();
    if (!persona) {
        showToast('No active persona', { type: 'warning' });
        return;
    }

    const oldExpr = editingExpression ? persona.expressions[editingExpression] : null;
    const oldImageKey = oldExpr?.imageKey || '';
    const isRename = editingExpression && editingExpression !== name;

    // Build the new expressions object. imageKey is preserved from the old
    // entry unless the user uploaded a new image, cleared it, or renamed
    // (rename-with-image is not preserved in this iteration — user re-uploads).
    const newExpressions = { ...persona.expressions };
    if (isRename) delete newExpressions[editingExpression];
    const initialImageKey = state.tempExpressionCleared
        ? ''
        : (state.tempExpressionBlob || isRename ? '' : oldImageKey);
    newExpressions[name] = { emoji, imageKey: initialImageKey };

    try {
        // 1. Push the metadata change.
        await API.personas.update(persona.id, { expressions: newExpressions });

        // 2. Image-side operations.
        if (state.tempExpressionBlob) {
            const file = new File([state.tempExpressionBlob], `${name}.png`, {
                type: state.tempExpressionBlob.type || 'image/png',
            });
            await API.avatars.uploadExpression(persona.id, name, file);
        }
        if (isRename && oldImageKey) {
            // Old expression renamed; clean up its image file. (We don't
            // preserve it across rename — would require download + re-upload.)
            try {
                await API.avatars.deleteExpression(persona.id, editingExpression);
            } catch (e) { /* file may already be gone — non-fatal */ }
        } else if (state.tempExpressionCleared && oldImageKey) {
            await API.avatars.deleteExpression(persona.id, name);
        }

        // 3. Refetch persona so local state matches server's authoritative
        // imageKey values for each expression.
        const fresh = await API.personas.get(persona.id);
        state.personas[fresh.id] = {
            ...state.personas[fresh.id],
            ...fresh,
            expressions: (fresh.expressions && typeof fresh.expressions === 'object')
                ? fresh.expressions
                : newExpressions,
        };
    } catch (err) {
        console.error('Failed to save expression:', err);
        displayError(err, { action: 'save expression' });
        return;
    }

    await renderExpressionList();
    closeExpressionModal();
    await updateFloatingAvatar();
    updateSystemPromptExpressions();
}

async function deleteExpression() {
    if (!editingExpression) return;

    const persona = getActivePersona();
    if (!persona) return;

    if (Object.keys(persona.expressions).length <= 1) {
        showToast('You must have at least one expression', { type: 'warning' });
        return;
    }

    // Pin the name: confirming is async now, so don't trust the module-level
    // `editingExpression` to still point at the same thing afterwards.
    const name = editingExpression;
    const expr = persona.expressions[name];

    const ok = await confirmDialog({
        title: 'Delete expression?',
        body: expr?.imageKey
            ? `"${name}" and its uploaded image will be removed from this persona. This can't be undone.`
            : `"${name}" will be removed from this persona. This can't be undone.`,
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;

    // Local optimistic delete.
    const newExpressions = { ...persona.expressions };
    delete newExpressions[name];

    try {
        // 1. Persist expression-set change.
        await API.personas.update(persona.id, { expressions: newExpressions });
        // 2. Drop the server-side image file too (best-effort).
        if (expr?.imageKey) {
            try {
                await API.avatars.deleteExpression(persona.id, name);
            } catch (e) { /* file may already be gone — non-fatal */ }
        }
        // 3. Sync local state with the result.
        persona.expressions = newExpressions;
        persona.updatedAt = Date.now();
    } catch (err) {
        console.error('Failed to delete expression:', err);
        displayError(err, { action: 'delete expression' });
        return;
    }

    await renderExpressionList();
    closeExpressionModal();
}

function updateSystemPromptExpressions() {
    // This could automatically update the system prompt with available expressions
    // For now, we'll leave it manual since users customize their prompts
}

// ===== Model Management =====

/**
 * Fetch the available models from a provider's API. Not every provider offers a
 * list endpoint — the server throws VALIDATION_ERROR for one whose module has no
 * listModels(), which surfaces as a normal error toast.
 * @param {string} provider
 * @returns {Promise<Array>} Array of { id, display_name } objects
 */
async function fetchAvailableModels(provider) {
    if (!state.apiKeyStatus[provider]?.hasKey) {
        throw new Error('API key required to fetch models');
    }

    // Server proxies the request using the user's stored key and returns the
    // provider's raw model list. Different providers have slightly different
    // shapes (Anthropic: { id, display_name }; Gemini: { id, name, ... }) —
    // normalize for the existing renderer.
    const list = await API.models.list(provider);
    return list.map(m => ({
        id: m.id,
        display_name: m.display_name || m.displayName || m.name || m.id,
    }));
}

/**
 * Add a custom model to a provider's catalog.
 * @param {string} id - The model ID
 * @param {string} name - The display name
 * @param {string} provider - The provider that owns the model
 * @returns {boolean} True if added, false if already exists
 */
function addCustomModel(id, name, provider) {
    if (!id || !name || !provider) return false;

    const providerModels = state.settings.customModels[provider];
    if (!providerModels) return false;

    // Check if already exists
    const exists = providerModels.some(m => m.id === id);
    if (exists) return false;

    providerModels.push({ id, name });
    saveCustomModels();
    return true;
}

/**
 * Safety net (formerly folded into the model dropdown, removed in Slice 4): if
 * the active layer points at a model no longer in its provider's catalog — e.g.
 * it was removed while active — fall back to the provider's first model and load
 * that model's profile so its params come along. No-op when the active model is
 * valid or the provider has no models. The ensuing updateUI refreshes the
 * indicator, params UI, and catalog.
 */
function ensureActiveModelValid() {
    const modelConfig = getActiveModelConfig();
    const providerModels = state.settings.customModels[modelConfig.provider] || [];
    if (providerModels.length === 0) return;
    if (!providerModels.some(m => m.id === modelConfig.model)) {
        modelConfig.model = providerModels[0].id;
        loadModelProfileIntoLayer();
    }
}

/**
 * Refresh UI after the model catalog changes from the modal (add/remove): keep
 * the active model valid, then refresh the Models catalog, the model indicator,
 * and the send button. Replaces the old populateModelDropdown() refresh now that
 * the dropdown is gone (Slice 4).
 */
function refreshAfterModelChange() {
    ensureActiveModelValid();
    renderModelsCatalog();
    setModelIndicator(getModelDisplayName(getActiveModelConfig().model));
    updateSendButtonState();
}

/**
 * Render available models grid after fetching from API
 * @param {Array} models - Array of { id, display_name } from API
 * @param {string} provider - The provider they were fetched from
 */
function renderAvailableModelsGrid(models, provider) {
    const grid = elements.availableModelsGrid;
    const providerModels = state.settings.customModels[provider] || [];
    grid.innerHTML = '';
    grid.style.display = 'grid';

    if (models.length === 0) {
        grid.innerHTML = '<p class="help-text">No models available</p>';
        return;
    }

    models.forEach(model => {
        const alreadyAdded = providerModels.some(m => m.id === model.id);
        const card = document.createElement('div');
        card.className = `available-model-card ${alreadyAdded ? 'already-added' : ''}`;
        card.innerHTML = `
            <span class="available-model-name">${model.display_name}</span>
            <span class="available-model-id">${model.id}</span>
            <button class="add-available-model-btn" data-model-id="${model.id}" data-model-name="${model.display_name}" ${alreadyAdded ? 'disabled' : ''}>
                ${alreadyAdded ? 'Added' : '+ Add'}
            </button>
        `;
        grid.appendChild(card);
    });

    // Add click listeners for add buttons
    grid.querySelectorAll('.add-available-model-btn:not([disabled])').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const modelId = e.target.dataset.modelId;
            const modelName = e.target.dataset.modelName;
            if (addCustomModel(modelId, modelName, provider)) {
                refreshAfterModelChange();
                // Update the button
                e.target.textContent = 'Added';
                e.target.disabled = true;
                e.target.closest('.available-model-card').classList.add('already-added');
            }
        });
    });
}

/**
 * Close the model management modal
 */
function closeModelModal() {
    elements.modelModal.classList.remove('visible');
}

/**
 * Handle fetch models button click
 */
async function handleFetchModels() {
    const btn = elements.fetchModelsBtn;
    const originalText = btn.textContent;
    // Capture the provider: the user can switch chips while the request is in
    // flight, and the results belong to the provider that was asked.
    const provider = modelModalProvider;

    try {
        btn.disabled = true;
        btn.textContent = 'Fetching...';

        const models = await fetchAvailableModels(provider);
        if (provider !== modelModalProvider) return; // switched away mid-flight
        renderAvailableModelsGrid(models, provider);
    } catch (error) {
        console.error('Failed to fetch models:', error);
        displayError(error, { action: `fetch ${PROVIDERS[provider]?.label || provider} models` });
    } finally {
        btn.disabled = !state.apiKeyStatus[modelModalProvider]?.hasKey;
        btn.textContent = originalText;
    }
}

/**
 * Handle manual add model button click
 */
function handleAddModelManually() {
    const id = elements.newModelId.value.trim();
    const name = elements.newModelName.value.trim();

    if (!id) {
        showToast('Please enter a model ID', { type: 'warning' });
        return;
    }

    if (!name) {
        showToast('Please enter a display name', { type: 'warning' });
        return;
    }

    const provider = modelModalProvider;
    if (addCustomModel(id, name, provider)) {
        refreshAfterModelChange();
        elements.newModelId.value = '';
        elements.newModelName.value = '';
        // The modal no longer lists your models (the catalog does), so say so.
        showToast(`${name} added to ${PROVIDERS[provider]?.label || provider}`);

        // Update available grid if visible
        if (elements.availableModelsGrid.style.display !== 'none') {
            const addedCard = elements.availableModelsGrid.querySelector(`[data-model-id="${id}"]`);
            if (addedCard) {
                addedCard.textContent = 'Added';
                addedCard.disabled = true;
                addedCard.closest('.available-model-card')?.classList.add('already-added');
            }
        }
    } else {
        showToast('Model already exists', { type: 'warning' });
    }
}

// ===== Sidebar Tab Management =====

/** Keep the persona editor's page title in sync with the active persona's name. */
function syncPersonaEditTitle() {
    const title = document.getElementById('personaEditTitle');
    if (!title) return;
    const persona = getActivePersona();
    title.textContent = persona ? (persona.name || 'Untitled') : 'Persona';
}

// ===== Top-bar popovers (P2-U3a) =====
// The positioning/dismissal primitives these all call live in
// components/menus.js; what stays here is each menu's own content.

/**
 * Top-bar avatar options popover (WR-10): show/hide toggle + size and corner
 * presets, with a link to the full Avatar Display settings. Replaces the old
 * click-to-toggle behavior of the avatar button (and the top-bar gear — the
 * general Settings section lives on the rail now).
 */
function showAvatarMenu(anchorEl) {
    const existing = document.querySelector('.context-menu');
    if (existing) existing.remove();

    const sizes = [['small', 'S'], ['medium', 'M'], ['large', 'L'], ['xlarge', 'XL']];
    const corners = [['top-left', '↖'], ['top-right', '↗'], ['bottom-left', '↙'], ['bottom-right', '↘']];

    const menu = document.createElement('div');
    menu.className = 'context-menu avatar-menu';
    menu.innerHTML = `
        <button class="context-menu-item avatar-menu-toggle" data-avatar-show type="button">
            <span>Show floating avatar</span>
            <span class="avatar-menu-check${state.settings.showAvatar ? '' : ' off'}">✓</span>
        </button>
        <div class="context-menu-separator"></div>
        <div class="context-menu-label">Size</div>
        <div class="avatar-menu-row size-preset-buttons">
            ${sizes.map(([s, label]) =>
                `<button class="size-preset-btn${state.settings.avatarSize === s ? ' active' : ''}" data-size="${s}" type="button">${label}</button>`).join('')}
        </div>
        <div class="context-menu-label">Position</div>
        <div class="avatar-menu-row position-preset-buttons">
            ${corners.map(([pos, glyph]) =>
                `<button class="position-preset-btn${state.settings.avatarPosition === pos ? ' active' : ''}" data-position="${pos}" type="button" aria-label="Position ${pos}">${glyph}</button>`).join('')}
        </div>
        <div class="context-menu-separator"></div>
        <button class="context-menu-item" data-avatar-settings type="button">All avatar settings…</button>
    `;
    positionPopover(menu, anchorEl, 'right');

    // Controls act immediately and keep the popover open (it's a mini panel,
    // not a pick-one menu); only the settings link closes it.
    menu.querySelector('[data-avatar-show]').addEventListener('click', async () => {
        await setShowAvatar(!state.settings.showAvatar);
        menu.querySelector('.avatar-menu-check').classList.toggle('off', !state.settings.showAvatar);
    });
    menu.querySelectorAll('.size-preset-btn').forEach(btn =>
        btn.addEventListener('click', () => setAvatarSize(btn.dataset.size)));
    menu.querySelectorAll('.position-preset-btn').forEach(btn =>
        btn.addEventListener('click', () => setAvatarPosition(btn.dataset.position)));
    menu.querySelector('[data-avatar-settings]').addEventListener('click', () => {
        menu.remove();
        navigate({ type: 'settings' });
    });

    attachPopoverOutsideClose(menu, anchorEl);
}

// Provider registry — single source of truth for everything a provider carries:
// human label + tagline, availability, API-key placeholder, and the parameter
// descriptors the (future) per-model detail view renders from. Grew out of the
// old PROVIDER_LABELS map. Order here = display order in the model menu, catalog,
// and provider chips. See docs/MODELS_TAB_REDESIGN.md.
//
// A param descriptor drives one control:
//   path      location of the value in the model's params bag. A bare key sits
//             flat on modelParams ('temperature'); a dotted key nests under a
//             provider namespace the backend already reads
//             ('anthropic.thinkingBudget', 'google.thinkingLevel').
//   group     'sampling' | 'behaviour' — which detail-view section it lands in.
//   subgroup  optional finer grouping (e.g. 'safety' → a collapsible block).
//   control   'range' | 'number' | 'tags' | 'toggle' | 'select' | 'textarea'.
//   enableKey optional companion on/off key (advanced override) — temp/topP/topK.
//   showWhen  optional conditional visibility ({ path, eq }).
// Array order = render order. Params are NOT consumed yet (detail view is a later
// slice); defined here so the registry is the one place providers are described.

/**
 * Top-bar model button popover (WR-11): configured models grouped by provider,
 * with the provider's brand mark and a "no key" badge where no API key is
 * stored (models stay pickable — sending surfaces the missing-key error).
 * Picking a model sets provider+model together while retaining the persona.
 *
 * Slice 8 scopes the list by the saved "daily drivers" subset
 * (state.settings.catalogProviders) so quick-switch offers the same short list
 * the catalog defaults to. Two guardrails keep a *view* preference from
 * becoming a restriction: the active model's provider is always listed even
 * when the subset excludes it, and "Show all providers" reopens the menu
 * unfiltered for that viewing only — it never writes catalogProviders.
 *
 * @param {HTMLElement} anchorEl
 * @param {Object} [options]
 * @param {boolean} [options.showAll] - Ignore the subset for this opening only.
 */
function showModelMenu(anchorEl, { showAll = false } = {}) {
    const existing = document.querySelector('.context-menu');
    if (existing) existing.remove();

    const modelConfig = getActiveModelConfig();
    const selected = state.settings.catalogProviders;
    const noFilter = showAll || !Array.isArray(selected) || selected.length === 0;

    // Providers worth listing at all: an empty provider has nothing to switch to.
    const stocked = Object.keys(PROVIDERS)
        .filter(p => (state.settings.customModels[p] || []).length > 0);
    // Never hide the provider you're currently using.
    const visible = stocked.filter(p =>
        noFilter || selected.includes(p) || p === modelConfig.provider);
    const hiddenCount = stocked.length - visible.length;

    const menu = document.createElement('div');
    menu.className = 'context-menu context-menu-wide model-menu';

    let groups = '';
    for (const provider of visible) {
        const { label } = PROVIDERS[provider];
        const hasKey = !!state.apiKeyStatus[provider]?.hasKey;
        groups += `<div class="context-menu-label">
            ${providerIconHtml(provider)}<span class="model-menu-provider">${escapeHtml(label)}</span>
            ${hasKey ? '' : '<span class="model-menu-nokey">no key</span>'}
        </div>`;
        for (const m of state.settings.customModels[provider]) {
            const active = provider === modelConfig.provider && m.id === modelConfig.model;
            groups += `<button class="context-menu-item${active ? ' active' : ''}" data-model-id="${escapeHtml(m.id)}" data-provider="${provider}">${escapeHtml(m.name)}</button>`;
        }
    }

    // The groups scroll; the footer stays put. .context-menu has no max-height of
    // its own, so without this the menu runs off-screen as providers accumulate.
    let html = visible.length > 0
        ? `<div class="model-menu-scroll">${groups}</div>`
        : `<div class="context-menu-empty">No models configured</div>`;
    html += `<div class="context-menu-separator"></div>`;
    if (hiddenCount > 0) {
        html += `<button class="context-menu-item model-menu-more" data-action="showall">Show all providers (${hiddenCount} more)</button>`;
    }
    html += `<button class="context-menu-item" data-action="manage">Manage models…</button>`;
    menu.innerHTML = html;

    positionPopover(menu, anchorEl, 'right');

    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', () => {
            menu.remove();
            if (item.dataset.action === 'showall') {
                showModelMenu(anchorEl, { showAll: true }); // this opening only
                return;
            }
            if (item.dataset.action === 'manage') {
                navigate({ type: 'models' }); // the Models section (WR-13) is the catalog's home
                return;
            }
            if (item.dataset.modelId) {
                selectModel(item.dataset.modelId, item.dataset.provider);
            }
        });
    });

    attachPopoverOutsideClose(menu, anchorEl);
}

// ===== Workspace/project row helpers (shared by the main-area lists + pages) =====

// ===== Workspace create + edit =====
// Name + shared instructions + reference files are all edited inline on the
// workspace page (renderContainerPage). Creation is a name-only step that lands
// on that page.

// ===== Breadcrumb + container navigation (WR-07) =====
// The hierarchy is workspace ⊃ project ⊃ chat. activeWorkspaceId/activeProjectId
// track the container the current view is about (set by openContainerPage and on
// opening a chat) — used for restore and for where "New chat/project" land.

/** Open a workspace's page (its instructions/files/projects/chats). */
function enterWorkspace(workspaceId) {
    openContainerPage('workspace', workspaceId);
}

/** Open a project's page (its instructions/files/chats). */
function enterProject(projectId) {
    openContainerPage('project', projectId);
}

/** Go to the workspaces list. */
function backToWorkspaces() {
    state.activeProjectId = null;
    state.activeWorkspaceId = null;
    UiPrefs.set('activeProject', null);
    UiPrefs.set('activeWorkspace', null);
    navigate({ type: 'workspaces' });
}

// ===== Expression Detection =====
/**
 * Resolve the expression a response declares.
 *
 * Declaration is the ONLY signal. The old keyword fallback was removed: it
 * matched substrings anywhere in the reply, so 'sorry', 'unfortunately' and
 * 'difficult' pushed the avatar to `sad` constantly during ordinary work talk,
 * and which expression won depended on insertion order in the expression map.
 * A missed tag now just holds the current expression — stale beats wrong.
 *
 * @param {string} text - The full response text
 * @returns {string} The expression name to display
 */
function detectExpression(text) {
    const persona = getActivePersona();
    const expressions = persona ? persona.expressions : CONFIG.defaultExpressions;

    // The generating slot is the UI's own state, so a model that declares it
    // is ignored.
    const tagMatch = text.match(/\[expression:\s*([\w -]+)\]/i);
    if (tagMatch) {
        const exprName = tagMatch[1].trim().toLowerCase();
        if (expressions[exprName] && exprName !== CONFIG.generatingExpression) {
            return exprName;
        }
    }

    // Nothing declared: hold the current expression, except settle the
    // transient generating state back to neutral.
    return state.currentExpression === CONFIG.generatingExpression ? 'neutral' : state.currentExpression;
}

/**
 * Drop the avatar out of the `generating` state after a failed or abandoned
 * request. Without this the pulse runs forever: nothing else clears it, since
 * the settled expression is normally applied when a response finalizes.
 * No-op if the avatar has already moved on.
 */
function settleGeneratingExpression() {
    if (state.currentExpression === CONFIG.generatingExpression) {
        setExpression('neutral');
    }
}

function stripExpressionTag(text) {
    return text.replace(/\[expression:\s*\w+\]\s*/gi, '').trim();
}

/**
 * Strip prefill text from the start of a response
 * @param {string} text - The full response text
 * @param {string} prefill - The prefill text to strip
 * @returns {string} Text with prefill removed
 */
function stripPrefillText(text, prefill) {
    if (!prefill || !text) return text;
    const trimmedPrefill = prefill.trim();
    const trimmedText = text.trimStart();
    if (trimmedText.startsWith(trimmedPrefill)) {
        return trimmedText.slice(trimmedPrefill.length).trimStart();
    }
    return text;
}

async function setExpression(exprName) {
    const persona = getActivePersona();
    const expressions = persona ? persona.expressions : CONFIG.defaultExpressions;

    if (expressions[exprName]) {
        state.currentExpression = exprName;
        await updateFloatingAvatar();
        updateStatusBar();
    }
}

// ===== Main-area router (WR-07) =====
// The main area shows exactly one view, chosen by state.ui.mainView. The sidebar
// is a section rail that navigates between views. navigate() is the single entry
// point: it sets the view, repaints the shell (rail highlight + contextual top
// bar) and the main content, and closes the mobile drawer.
//
// `navigate()` and `currentSection()` now live in js/shell.js, and the three
// implementations below are registered there at import time (see the top of
// this file). Callers reach them through the seam so that a view never has to
// import the router — see js/shell.js for why. R-04b moves what remains of this
// section into js/router.js, which will do the registering instead.

/** Repaint the navigation shell: rail highlight + contextual top bar + chrome. */
function renderShell() {
    renderRail();
    renderTopBar();
    renderBreadcrumb();
    syncChatChrome();
}

/**
 * Show the message composer + floating avatar only in a chat view — they're
 * irrelevant (and visually noisy) on the lists / settings / container pages.
 */
function syncChatChrome() {
    const inChat = (state.ui.mainView || {}).type === 'chat';
    if (elements.inputContainer) elements.inputContainer.hidden = !inChat;
    if (elements.floatingAvatar) {
        elements.floatingAvatar.classList.toggle('hidden', !inChat || !state.settings.showAvatar);
    }
    // Reflect this chat's effective file-tools state on the composer toggle.
    if (inChat) syncToolsToggle();
    // The files explorer needs a saved conversation to list files for; a fresh
    // unsaved chat has no id yet (CF-01b).
    if (elements.filesExplorerBtn) {
        elements.filesExplorerBtn.disabled = !state.activeConversationId;
    }
    // File panel + explorer button follow the active chat (hidden while browsing).
    FilePanel.syncUi();
    // The not-loaded count badge tracks the active chat even with the panel
    // closed (CT-06). Fire-and-forget: it self-guards staleness.
    FilePanel.syncContextBadge();
}

/**
 * Render the active main-area view. Guards against views whose entity was
 * deleted by falling back to the owning list.
 */
function renderMainView() {
    const v = state.ui.mainView || { type: 'chats' };

    // Toggle the two persistent main-area panels: the messages/lists surface vs
    // the settings form (which lives in #settingsView so its inputs + listeners
    // survive — it is shown, not re-rendered).
    const isSettings = v.type === 'settings';
    const isPersonaEdit = v.type === 'persona-edit';
    const isModels = v.type === 'models';
    if (elements.settingsView) elements.settingsView.hidden = !isSettings;
    if (elements.personaEditView) elements.personaEditView.hidden = !isPersonaEdit;
    if (elements.modelsView) elements.modelsView.hidden = !isModels;
    if (elements.messagesContainer) elements.messagesContainer.hidden = isSettings || isPersonaEdit || isModels;
    if (isModels) {
        renderModelsView();
        return;
    }
    if (isPersonaEdit) {
        // The editor's inputs always edit the *active* persona (editPersona
        // activates before navigating); the title just needs to match it.
        if (!getActivePersona()) return navigate({ type: 'personas' });
        syncPersonaEditTitle();
        return;
    }
    if (isSettings) return;

    if (v.type === 'workspace') {
        if (!state.workspaces[v.id]) return navigate({ type: 'workspaces' });
        elements.messagesContainer.innerHTML = '';
        renderContainerPage('workspace', v.id);
        return;
    }
    if (v.type === 'project') {
        if (!state.projects[v.id]) return navigate({ type: 'workspaces' });
        elements.messagesContainer.innerHTML = '';
        renderContainerPage('project', v.id);
        return;
    }
    if (v.type === 'workspaces') {
        renderWorkspacesListMain();
        return;
    }
    if (v.type === 'personas') {
        renderPersonasListMain();
        return;
    }
    if (v.type === 'chat') {
        if (!state.conversations[v.id]) return navigate({ type: 'chats' });
        renderChatThread();
        return;
    }
    // 'chats' (default)
    renderChatsListMain();
}

/** Render the active conversation's message thread into the main area. */
function renderChatThread() {
    elements.messagesContainer.innerHTML = '';

    const activeConvo = getActiveConversation();
    const messages = activeConvo ? activeConvo.messages : [];
    const persona = getActivePersona();
    const assistantName = persona ? persona.name : CONFIG.defaults.assistantName;

    if (messages.length === 0) {
        const modelConfig = getActiveModelConfig();
        const provider = modelConfig.provider;
        const hasApiKey = !!state.apiKeyStatus[provider]?.hasKey;
        elements.messagesContainer.innerHTML = `
            <div class="welcome-message">
                <h1>Welcome!</h1>
                <p>${hasApiKey ? 'Start chatting with ' + assistantName + '!' : 'Add your API key in the Models tab (☰) to get started.'}</p>
            </div>
        `;
        return;
    }

    messages.forEach((msg, index) => {
        appendMessage(msg.role, msg.content, false, index, msg.attachments, msg.model || null);
    });

    scrollToBottom();
}

/** Highlight the rail item for the section the current view belongs to. */
function renderRail() {
    const section = currentSection();
    document.querySelectorAll('.rail-item[data-section]').forEach(b =>
        b.classList.toggle('active', b.dataset.section === section));
}

/**
 * Contextual top bar (WR-07, amended by P2-05a): in a chat show only the
 * workspace breadcrumb — the model chip lives in the composer's control row.
 * While browsing (composer hidden) show the persona selector (who the next
 * chat will be) plus the model button, since there's no composer to host it.
 */
function renderTopBar() {
    const inChat = (state.ui.mainView || {}).type === 'chat';
    if (elements.personaButton) elements.personaButton.hidden = inChat;
    if (elements.workspaceBreadcrumb) elements.workspaceBreadcrumb.hidden = !inChat;
    if (elements.modelButton) elements.modelButton.hidden = inChat;
    // Files explorer (CF-01b): per-conversation, so only in a chat.
    if (elements.filesExplorerBtn) elements.filesExplorerBtn.hidden = !inChat;
}

/** Update the model name shown on the top-bar button and the composer chip. */
function setModelIndicator(name) {
    if (elements.modelIndicator) elements.modelIndicator.textContent = name;
    if (elements.composerModelName) elements.composerModelName.textContent = name;
}

/** Per-card context menu on the Personas section: Edit (→ Settings) / Delete. */
// ===== Persona export / import (`.tessera` bundles) =====
// A bundle is one self-contained JSON file: persona text plus its art inlined
// as base64. Built in the browser rather than on the server because <canvas>
// gives us resizing and WebP encoding for free — doing it server-side would
// mean adding a native image library (sharp) for what the browser already has.

// `blobToBase64` used to be declared here as well as further down (~line 9390).
// Two top-level function declarations of the same name are legal in a classic
// script — the later one silently wins — so this copy was already dead code and
// every caller, including the exporter below, has always run the other one. A
// module is strict, where the duplicate is a hard SyntaxError, so this copy is
// gone. No behaviour change: the surviving implementation is unmodified.

// ===== Inline container pages (workspace / project) =====
// A workspace/project page is a main-area router view (WR-07): renderMainView
// calls renderContainerPage for mainView {type:'workspace'|'project'}. The page
// edits name + instructions + files inline and lists the container's projects/
// chats. Entry points: the workspaces list, the in-chat breadcrumb, the project
// rows, and the name-only create step (which lands here after creating).

async function appendMessage(role, content, save = true, explicitIndex = null, attachments = null, model = null) {
    const welcome = elements.messagesContainer.querySelector('.welcome-message');
    if (welcome) {
        welcome.remove();
    }

    // Which model generated this assistant message (WR-14): stored messages
    // pass theirs in; a fresh reply uses the model recorded at request time.
    const messageModel = role === 'assistant'
        ? (model || (save ? state.lastRequestModel : null))
        : null;

    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}`;

    // Add speaker label
    const labelDiv = document.createElement('div');
    labelDiv.className = 'message-label';
    if (role === 'user') {
        labelDiv.textContent = 'You';
    } else if (role === 'assistant') {
        const persona = getActivePersona();
        labelDiv.textContent = persona ? persona.name : CONFIG.defaults.assistantName;
        if (messageModel) {
            const tag = document.createElement('span');
            tag.className = 'message-model-tag';
            tag.textContent = modelTagLabel(messageModel);
            tag.title = messageModel; // full model id on hover
            labelDiv.appendChild(tag);
        }
    }
    messageDiv.appendChild(labelDiv);

    // Render attachments above text content if present
    if (attachments && attachments.length > 0) {
        const attachDiv = document.createElement('div');
        attachDiv.className = 'message-attachments';
        renderMessageAttachments(attachments, attachDiv);
        messageDiv.appendChild(attachDiv);
    }

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    // For assistant messages, strip expression tags before display
    const displayContent = role === 'assistant' ? stripExpressionTag(content) : content;
    // Render Markdown to HTML
    contentDiv.innerHTML = renderMarkdown(displayContent);

    messageDiv.appendChild(contentDiv);

    // Add message action buttons (not on error messages)
    if (role === 'user' || role === 'assistant') {
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'message-actions';
        const rerunTitle = role === 'user' ? 'Resend' : 'Regenerate';
        actionsDiv.innerHTML = messageActionsHTML(rerunTitle);
        messageDiv.appendChild(actionsDiv);
    }

    elements.messagesContainer.appendChild(messageDiv);

    if (save) {
        // Auto-create conversation if none exists. createConversation is now
        // async (server-generated id), so this whole branch awaits — callers
        // must therefore await appendMessage.
        if (!state.activeConversationId) {
            const title = role === 'user'
                ? generateConversationTitle(displayContent)
                : 'New Chat';
            try {
                await createConversation(title);
            } catch (err) {
                console.error('Auto-create conversation failed:', err);
                return; // can't persist a message without a conversation
            }
        }

        const activeConvo = getActiveConversation();
        if (activeConvo) {
            const msg = {
                role,
                content: displayContent,
                attachments: attachments || [],
                ...(messageModel ? { model: messageModel } : {}),
            };
            activeConvo.messages.push(msg);
            messageDiv.dataset.msgIndex = activeConvo.messages.length - 1;

            // Update title from first user message if still default.
            if (activeConvo.messages.length === 1 && role === 'user' && activeConvo.title === 'New Chat') {
                activeConvo.title = generateConversationTitle(displayContent);
                // Title changed; flush metadata to server.
                saveConversations();
            }
            activeConvo.updatedAt = Date.now();

            // Persist the message and AWAIT the result so msg.id is
            // populated before control returns. Edit/delete handlers depend
            // on msg.id to target the correct server row — a fire-and-forget
            // here let fast follow-up actions (click delete immediately
            // after send) see an undefined id and silently fail to delete
            // server-side, leaving zombie messages on reload.
            try {
                const saved = await persistMessage(activeConvo.id, msg);
                if (saved && saved.id) msg.id = saved.id;
            } catch (err) {
                console.error('Failed to persist message:', err);
            }
        }

        // Update token estimate (rough: 1 token ≈ 4 chars)
        state.estimatedTokens += Math.ceil(content.length / 4);
        updateStatusBar();
    } else {
        // When re-rendering (save=false), use explicit index
        if (explicitIndex !== null) {
            messageDiv.dataset.msgIndex = explicitIndex;
        }
    }

    scrollToBottom();
    return messageDiv;
}

// ===== Thread status chrome =====
// The typing indicator and the legacy showNotification() wrapper. They stay
// here rather than moving with components/errors.js because they write into
// the message thread — they belong with chat/ in R-05.

function showTypingIndicator() {
    const indicator = document.createElement('div');
    indicator.className = 'message assistant typing-indicator-container';
    indicator.id = 'typingIndicator';
    indicator.innerHTML = `
        <div class="typing-indicator">
            <span></span>
            <span></span>
            <span></span>
        </div>
    `;
    elements.messagesContainer.appendChild(indicator);
    scrollToBottom();
}

function hideTypingIndicator() {
    const indicator = document.getElementById('typingIndicator');
    if (indicator) {
        indicator.remove();
    }
}

// Thin wrapper kept for existing call sites; delegates to the P0-17 toast
// system. `type` accepts 'info' | 'success' | 'warning' | 'error'.
function showNotification(message, type = 'info') {
    showToast(message, { type });
}

// ===== Message Actions =====
function handleMessageAction(messageDiv, action, msgIndex) {
    switch (action) {
        case 'copy':
            copyMessageText(msgIndex);
            break;
        case 'edit':
            editMessageInPlace(messageDiv, msgIndex);
            break;
        case 'delete':
            deleteMessage(msgIndex);
            break;
        case 'rerun':
            rerunFromMessage(msgIndex);
            break;
    }
}

function copyMessageText(msgIndex) {
    const activeConvo = getActiveConversation();
    if (!activeConvo || !activeConvo.messages[msgIndex]) return;

    const text = activeConvo.messages[msgIndex].content;
    navigator.clipboard.writeText(text).then(() => {
        showNotification('Copied to clipboard');
    }).catch(err => {
        console.error('Failed to copy:', err);
    });
}

async function deleteMessage(msgIndex) {
    const activeConvo = getActiveConversation();
    if (!activeConvo || !activeConvo.messages[msgIndex]) return;

    const ok = await confirmDialog({
        title: 'Delete message?',
        body: "This message will be removed from the conversation. This can't be undone.",
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;

    // Confirming is async now — re-check that the message is still there and
    // that we're still looking at the same conversation.
    if (getActiveConversation() !== activeConvo || !activeConvo.messages[msgIndex]) return;

    const msg = activeConvo.messages[msgIndex];

    // Server-side delete first so failure can short-circuit before the local
    // mutation. If the message has no id yet, its persistMessage POST never
    // completed (e.g., still in flight / failed). In that case it doesn't
    // exist server-side and a local-only delete is correct.
    if (msg.id) {
        try {
            await API.messages.delete(activeConvo.id, msg.id);
        } catch (err) {
            console.error('Failed to delete message:', err);
            displayError(err, { action: 'delete message' });
            return;
        }
    }

    // Clean up any attachments from IndexedDB
    if (msg.attachments && msg.attachments.length > 0) {
        msg.attachments.forEach(att => {
            if (att.imageStoreKey) {
                ImageStore.delete(att.imageStoreKey);
            }
        });
    }

    activeConvo.messages.splice(msgIndex, 1);
    activeConvo.updatedAt = Date.now();
    saveConversations();
    renderConversation();
}

function editMessageInPlace(messageDiv, msgIndex) {
    const activeConvo = getActiveConversation();
    if (!activeConvo || !activeConvo.messages[msgIndex]) return;

    const msg = activeConvo.messages[msgIndex];
    const contentDiv = messageDiv.querySelector('.message-content');
    const actionsDiv = messageDiv.querySelector('.message-actions');

    // Hide actions while editing
    if (actionsDiv) actionsDiv.style.display = 'none';

    // Store original content for cancel
    const originalContent = msg.content;
    const originalHTML = contentDiv.innerHTML;

    // Replace content with textarea
    const editContainer = document.createElement('div');
    editContainer.className = 'message-edit-container';

    const textarea = document.createElement('textarea');
    textarea.className = 'message-edit-textarea';
    textarea.value = originalContent;

    const buttonsDiv = document.createElement('div');
    buttonsDiv.className = 'message-edit-actions';
    buttonsDiv.innerHTML = `
        <button class="message-edit-cancel">Cancel</button>
        <button class="message-edit-save">Save</button>
    `;

    editContainer.appendChild(textarea);
    editContainer.appendChild(buttonsDiv);

    contentDiv.replaceWith(editContainer);

    // Auto-resize textarea
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
    textarea.focus();

    // Save handler
    buttonsDiv.querySelector('.message-edit-save').addEventListener('click', async () => {
        const newContent = textarea.value.trim();
        if (!newContent) return;

        // Persist to server first. If the message hasn't been POSTed yet
        // (no id), there's nothing to update — the in-memory edit is enough
        // and the eventual persistMessage in appendMessage hasn't completed.
        if (msg.id) {
            try {
                await API.messages.update(activeConvo.id, msg.id, { content: newContent });
            } catch (err) {
                console.error('Failed to update message:', err);
                displayError(err, { action: 'save edit' });
                return;
            }
        }

        // Update conversation data
        msg.content = newContent;
        activeConvo.updatedAt = Date.now();
        saveConversations();

        // Restore content div with new content
        const newContentDiv = document.createElement('div');
        newContentDiv.className = 'message-content';
        newContentDiv.innerHTML = renderMarkdown(newContent);
        editContainer.replaceWith(newContentDiv);

        if (actionsDiv) actionsDiv.style.display = '';
    });

    // Cancel handler
    buttonsDiv.querySelector('.message-edit-cancel').addEventListener('click', () => {
        const restoredDiv = document.createElement('div');
        restoredDiv.className = 'message-content';
        restoredDiv.innerHTML = originalHTML;
        editContainer.replaceWith(restoredDiv);

        if (actionsDiv) actionsDiv.style.display = '';
    });
}

async function rerunFromMessage(msgIndex) {
    const activeConvo = getActiveConversation();
    if (!activeConvo || !activeConvo.messages[msgIndex]) return;
    if (state.isLoading) return;

    const msg = activeConvo.messages[msgIndex];

    // The turn being re-rolled = the user-message count up to (and including) it.
    // Any file the model changed at that turn or later is rolled back first
    // (FC-06a), so the re-run starts from the pre-turn file state rather than the
    // already-edited one.
    const fromTurn = activeConvo.messages.slice(0, msgIndex + 1).filter(m => m.role === 'user').length;
    await revertConversationFilesForRerun(activeConvo.id, fromTurn);

    if (msg.role === 'user') {
        // Truncate everything from this index onward, resend this user message.
        const textToResend = msg.content;
        const attachmentsToResend = msg.attachments || [];
        await truncateMessagesFrom(activeConvo, msgIndex);
        renderConversation();
        sendMessageFromText(textToResend, attachmentsToResend);
    } else if (msg.role === 'assistant') {
        // Find the preceding user message, remove from this assistant onward, resend.
        const precedingUserMsg = activeConvo.messages.slice(0, msgIndex).reverse().find(m => m.role === 'user');
        if (!precedingUserMsg) return;

        await truncateMessagesFrom(activeConvo, msgIndex);
        renderConversation();
        sendMessageFromText(precedingUserMsg.content, precedingUserMsg.attachments || []);
    }
}

/**
 * Roll back model file changes before a re-roll (FC-06a). Best-effort: a failure
 * must not block the re-run, and any files that couldn't be rolled back (e.g.
 * older than the stored snapshots) are surfaced as a warning toast.
 */
async function revertConversationFilesForRerun(conversationId, fromTurn) {
    try {
        const res = await API.conversations.revertFiles(conversationId, fromTurn);
        if (res && Array.isArray(res.warnings) && res.warnings.length > 0) {
            showToast(res.warnings.join(' '), { type: 'warning' });
        }
        // SP-04: the scratchpad may have been rolled back to its pre-turn state;
        // refresh it if it's open in view mode so the user sees the reverted pad.
        if (res && res.scratchpadReverted) FilePanel.refreshScratchpadFromActivity(conversationId);
    } catch (err) {
        console.error('Failed to roll back files before re-roll:', err);
    }
}

/**
 * Retry the most recent turn after a send failure. Finds the last user
 * message and re-runs generation from it (which truncates any partial reply
 * and resends). Used as the retry handler for inline chat errors (P0-17).
 */
function retryLastUserMessage() {
    const convo = getActiveConversation();
    if (!convo || state.isLoading) return;
    for (let i = convo.messages.length - 1; i >= 0; i--) {
        if (convo.messages[i].role === 'user') {
            rerunFromMessage(i);
            return;
        }
    }
}

/**
 * Delete every message from `fromIndex` onward — both locally and on the
 * server. Server deletes are issued in parallel; individual failures are
 * logged but don't block local truncation, since the user's mental model is
 * "this rerun replaces what came after."
 */
async function truncateMessagesFrom(convo, fromIndex) {
    const toDelete = convo.messages.slice(fromIndex).filter(m => m.id);
    convo.messages.splice(fromIndex);
    convo.updatedAt = Date.now();
    saveConversations();
    if (toDelete.length > 0) {
        await Promise.all(toDelete.map(m =>
            API.messages.delete(convo.id, m.id).catch(err => {
                console.error(`Failed to delete message ${m.id}:`, err);
            })
        ));
    }
}

async function sendMessageFromText(text, attachments = []) {
    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;
    if (!state.apiKeyStatus[provider]?.hasKey || state.isLoading) return;

    // Commit a dirty scratchpad draft first (Decision 11), same as sendMessage.
    await FilePanel.autoSaveScratchpadOnSend();

    state.isLoading = true;
    updateSendButtonState();

    await appendMessage('user', text, true, null, attachments.length > 0 ? attachments : null);
    showTypingIndicator();
    setExpression(CONFIG.generatingExpression); // held until the response completes

    try {
        let response;
        if (modelConfig.modelParams.streaming) {
            hideTypingIndicator();
            elements.sendButton.style.display = 'none';
            elements.stopButton.style.display = '';
            startStreamingMessage();
            // Pin the conversation id at send-time so a mid-stream switch
            // doesn't redirect the assistant reply.
            const targetConvoId = state.activeConversationId;
            try {
                // callAPIStreaming returns { text, generatedImages } always —
                // including on abort, since API.chat.stream swallows
                // AbortError and lets us finalize with the accumulator-so-far.
                response = await callAPIStreaming(text, attachments);
                await finalizeStreamingMessage(response.text || '', response.generatedImages || [], targetConvoId);
            } catch (error) {
                // Real error (network / 4xx / 5xx) — abort is no longer
                // surfaced here because API.chat.stream returns normally on
                // user-initiated abort.
                if (state.streamingMessageDiv) {
                    state.streamingMessageDiv.remove();
                    state.streamingMessageDiv = null;
                }
                throw error;
            } finally {
                if (elements.stopButton) elements.stopButton.style.display = 'none';
                if (elements.sendButton) elements.sendButton.style.display = '';
            }
        } else {
            response = await callAPI(text, attachments);
            hideTypingIndicator();

            let responseText = response.text || '';
            const responseAttachments = response.attachments || [];

            // Strip prefill from response
            if (state.currentPrefill) {
                responseText = stripPrefillText(responseText, state.currentPrefill);
                state.currentPrefill = '';
            }

            const detectedExpr = detectExpression(responseText);
            await setExpression(detectedExpr);
            await appendMessage('assistant', responseText, true, null, responseAttachments.length > 0 ? responseAttachments : null);
        }
    } catch (error) {
        hideTypingIndicator();
        settleGeneratingExpression();
        displayError(error, { surface: 'chat', retryHandler: retryLastUserMessage });
        console.error('API Error:', error);
    } finally {
        state.isLoading = false;
        updateSendButtonState();
    }
}

// Helper: render attachments in a message
/**
 * Normalize a server tool event (from the tool loop's SSE 'tool-activity'
 * events, or the non-streaming toolEvents array) into a persistable attachment
 * entry, so tool chips + created-file cards survive a reload via the message's
 * existing `attachments` JSON (no schema change — Track A decision).
 * @param {Object} ev - { tool, filename?, ok, + create_file display fields }
 * @returns {Object} attachment entry (type 'created_file' or 'tool_event')
 */
function toolEventToAttachment(ev) {
    // A download url on a successful event IS the "produced a file" signal —
    // read/list tools never carry one, and any future file-producing tool
    // gets a card without touching this list. The tool name is only a label.
    if (ev.ok === true && ev.url) {
        return {
            type: 'created_file',
            tool: ev.tool,
            fileName: ev.filename || 'file',
            url: ev.url,
            mimeType: ev.mimeType || '',
            sizeBytes: ev.sizeBytes || 0,
            overwritten: !!ev.overwritten,
        };
    }
    return { type: 'tool_event', tool: ev.tool, filename: ev.filename || null, ok: ev.ok !== false };
}

/**
 * Append the shared non-image file-card parts (type badge + icon + filename)
 * to `el`. Used by both the uploaded-file attachment card and the model-
 * created-file download card so the structure stays in sync.
 */
function appendFileCardParts(el, fileName, mimeType) {
    const badge = document.createElement('span');
    badge.className = 'att-badge';
    badge.textContent = getFileTypeLabel(fileName, mimeType);
    el.appendChild(badge);

    const iconDiv = document.createElement('div');
    iconDiv.className = 'att-icon';
    iconDiv.textContent = getFileIcon(mimeType);
    el.appendChild(iconDiv);

    const nameDiv = document.createElement('div');
    nameDiv.className = 'att-name';
    nameDiv.textContent = fileName || 'File';
    nameDiv.title = fileName || 'File';
    el.appendChild(nameDiv);
}

/**
 * Build a card for a model-created file (Track A). The card body is a real
 * <button> that opens the file in the file panel; the corner arrow is the
 * download link. They are DOM siblings (never nested interactives), so
 * keyboard activation and screen readers treat them as two distinct controls.
 */
function buildCreatedFileCard(att) {
    const el = document.createElement('div');
    el.className = 'message-attachment message-attachment--file tool-file-card';

    const view = document.createElement('button');
    view.type = 'button';
    view.className = 'tool-file-view';
    view.title = `View ${att.fileName || 'file'}`;
    appendFileCardParts(view, att.fileName, att.mimeType);
    view.addEventListener('click', () => FilePanel.open(att));
    el.appendChild(view);

    const dl = document.createElement('a');
    dl.className = 'tool-file-dl';
    dl.href = att.url;
    dl.setAttribute('download', att.fileName || 'file');
    dl.title = `Download ${att.fileName || 'file'}`;
    dl.innerHTML = '&#8681;'; // down arrow
    el.appendChild(dl);

    return el;
}

/** Build a compact chip describing a tool action (read/list, or a failure). */
function buildToolChip(att) {
    const chip = document.createElement('span');
    chip.className = 'tool-chip' + (att.ok === false ? ' is-error' : '');
    const name = att.filename ? `<code>${escapeHtml(att.filename)}</code>` : '';
    let label;
    if (att.ok === false) {
        label = `${escapeHtml(att.tool || 'tool')} failed${name ? ' — ' + name : ''}`;
    } else if (att.tool === 'read_file') {
        label = `Read ${name || 'a file'}`;
    } else if (att.tool === 'list_files') {
        label = 'Listed files';
    } else if (att.tool === 'create_file') {
        label = `Created ${name || 'a file'}`;
    } else if (att.tool === 'edit_file') {
        label = `Edited ${name || 'a file'}`;
    } else {
        label = escapeHtml(att.tool || 'Tool used');
    }
    chip.innerHTML = `<span class="tool-chip-icon" aria-hidden="true">${att.ok === false ? '⚠' : '✓'}</span> ${label}`;
    return chip;
}

/**
 * Append a live tool-activity chip/card to the in-progress streaming message
 * (converted to the same attachment shape used at reload, so live and reload
 * render identically). `convoId` is the conversation the stream was started
 * in, so the file panel ignores events from a chat the user has left.
 */
function renderLiveToolActivity(payload, convoId) {
    if (!state.streamingMessageDiv) return;
    let area = state.streamingMessageDiv.querySelector('.message-attachments');
    if (!area) {
        area = document.createElement('div');
        area.className = 'message-attachments';
        const contentDiv = state.streamingMessageDiv.querySelector('.message-content');
        state.streamingMessageDiv.insertBefore(area, contentDiv);
    }
    const att = toolEventToAttachment(payload);
    renderMessageAttachments([att], area);
    FilePanel.notifyActivity(att, convoId);
    // Scratchpad writes carry a `scratchpad` marker (no url → a plain chip):
    // refresh the pad if it's open so the user sees the model's edit live.
    if (payload && payload.scratchpad) FilePanel.refreshScratchpadFromActivity(convoId);
    scrollToBottom();
}

function renderMessageAttachments(attachments, containerDiv) {
    if (!attachments || attachments.length === 0) return;

    attachments.forEach(att => {
        // Track A tool artifacts: a created-file download card or an action chip.
        if (att.type === 'created_file') {
            containerDiv.appendChild(buildCreatedFileCard(att));
            return;
        }
        if (att.type === 'tool_event') {
            containerDiv.appendChild(buildToolChip(att));
            return;
        }

        const attEl = document.createElement('div');
        attEl.className = 'message-attachment';

        const isImage = (att.type === 'image' || att.type === 'generated') && att.imageStoreKey;

        if (isImage) {
            if (att.type === 'generated') {
                // The "AI Generated" badge is drawn via CSS ::before.
                attEl.classList.add('generated-image');
            } else {
                const badge = document.createElement('span');
                badge.className = 'att-badge';
                badge.textContent = getFileTypeLabel(att.fileName, att.mimeType);
                attEl.appendChild(badge);
            }

            const imgWrapper = document.createElement('div');
            imgWrapper.className = 'attachment-image-wrapper';

            const img = document.createElement('img');
            img.alt = att.fileName || (att.type === 'generated' ? 'Generated image' : 'Attached image');
            img.loading = 'lazy';
            ImageStore.get(att.imageStoreKey).then(url => {
                if (url) img.src = url;
            });
            imgWrapper.appendChild(img);

            if (att.type === 'generated') {
                const downloadBtn = document.createElement('button');
                downloadBtn.className = 'download-btn';
                downloadBtn.innerHTML = '&#8681;'; // Down arrow
                downloadBtn.title = 'Download image';
                downloadBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    downloadGeneratedImage(att);
                });
                imgWrapper.appendChild(downloadBtn);
            }

            attEl.appendChild(imgWrapper);

            // Filename caption for uploaded images (generated ones have no real name).
            if (att.fileName && att.type !== 'generated') {
                const nameDiv = document.createElement('div');
                nameDiv.className = 'att-name';
                nameDiv.textContent = att.fileName;
                nameDiv.title = att.fileName;
                attEl.appendChild(nameDiv);
            }
        } else {
            // Non-image file → compact card (type badge + icon + filename), no preview.
            attEl.classList.add('message-attachment--file');
            appendFileCardParts(attEl, att.fileName, att.mimeType);
        }

        containerDiv.appendChild(attEl);
    });
}

// ===== API Communication =====
async function sendMessage() {
    const userMessage = elements.messageInput.value.trim();
    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;
    const hasApiKey = !!state.apiKeyStatus[provider]?.hasKey;

    const hasAttachments = state.pendingAttachments.length > 0;
    if ((!userMessage && !hasAttachments) || !hasApiKey || state.isLoading) {
        return;
    }

    // Commit a dirty scratchpad draft first (Decision 11) so the model sees it
    // this turn, not stale content. Awaited before the request is built.
    await FilePanel.autoSaveScratchpadOnSend();

    elements.messageInput.value = '';
    elements.messageInput.style.height = 'auto';
    state.isLoading = true;
    updateSendButtonState();

    // CF-02: text uploads become chat WORKING FILES (created before the user
    // message so their revision is stamped at currentTurn-1 → FC-03b injects
    // them on this very turn). Images/audio/PDF stay on the inline path.
    // `inlineMeta` (blobs in IndexedDB, base64'd into the request) is what
    // callAPI* inlines; working files are injected server-side, not inlined.
    const pending = state.pendingAttachments;
    const textUploads = pending.filter(isTextWorkingFileUpload);
    const inlineUploads = pending.filter(a => !isTextWorkingFileUpload(a));
    state.pendingAttachments = [];
    renderAttachmentPreviews();

    // Working files need a saved conversation; create one first if this is the
    // opening message of a fresh chat.
    if (textUploads.length > 0 && !state.activeConversationId) {
        try {
            await createConversation(generateConversationTitle(userMessage || '(attached files)'));
        } catch (err) {
            console.error('Could not create conversation for working files:', err);
        }
    }

    let workingFileAtts = [];
    let inlineFallback = [];
    if (textUploads.length > 0 && state.activeConversationId) {
        const result = await createWorkingFilesFromUploads(state.activeConversationId, textUploads);
        workingFileAtts = result.created;
        inlineFallback = result.failed;
    } else {
        inlineFallback = textUploads; // no conversation → fall back to inline
    }

    // Inline attachments (images/audio/PDF + any working-file creation failures)
    // still go through IndexedDB.
    let inlineMeta = [];
    const toInline = [...inlineUploads, ...inlineFallback];
    if (toInline.length > 0) {
        inlineMeta = await storeAttachmentsToIndexedDB(toInline);
    }

    // The message records both: working files as file cards, inline ones as
    // their usual attachment metadata. Only inlineMeta is inlined into the
    // request content below.
    const messageAtts = [...workingFileAtts, ...inlineMeta];

    // Surface the newest working file in the panel/explorer, matching how a
    // model-created file behaves (auto-open or edge dot per filePanelMode).
    if (workingFileAtts.length > 0) {
        FilePanel.notifyActivity(workingFileAtts[workingFileAtts.length - 1], state.activeConversationId);
    }

    await appendMessage('user', userMessage || '(attached files)', true, null, messageAtts.length > 0 ? messageAtts : null);

    if (modelConfig.modelParams.streaming) {
        // Streaming path
        showTypingIndicator();
        elements.sendButton.style.display = 'none';
        elements.stopButton.style.display = '';

        try {
            hideTypingIndicator();
            startStreamingMessage();
            // Hold the generating state for the whole response;
            // finalizeStreamingMessage applies the declared expression at the end.
            setExpression(CONFIG.generatingExpression);
            // Pin the conversation id at send-time so a mid-stream switch
            // doesn't redirect the assistant reply.
            const targetConvoId = state.activeConversationId;

            // callAPIStreaming always returns { text, generatedImages }
            // — including on abort (api-client swallows AbortError and we
            // finalize with the accumulator-so-far).
            const result = await callAPIStreaming(userMessage, inlineMeta);
            await finalizeStreamingMessage(result.text || '', result.generatedImages || [], targetConvoId);
        } catch (error) {
            // Real error path; abort flows through normally now.
            if (state.streamingMessageDiv) {
                state.streamingMessageDiv.remove();
                state.streamingMessageDiv = null;
            }
            hideTypingIndicator();
            settleGeneratingExpression();
            displayError(error, { surface: 'chat', retryHandler: retryLastUserMessage });
            console.error('API Error:', error);
        } finally {
            state.isLoading = false;
            elements.sendButton.style.display = '';
            elements.stopButton.style.display = 'none';
            updateSendButtonState();
        }
    } else {
        // Non-streaming path
        showTypingIndicator();
        setExpression(CONFIG.generatingExpression); // restored from the response below

        try {
            const response = await callAPI(userMessage, inlineMeta);

            hideTypingIndicator();

            // callAPI now always returns { text, attachments? } — the
            // dual-shape handling from the old direct-fetch path is gone.
            let responseText = response.text || '';
            const responseAttachments = response.attachments || [];

            // Strip prefill from response
            if (state.currentPrefill) {
                responseText = stripPrefillText(responseText, state.currentPrefill);
                state.currentPrefill = '';
            }

            // Detect expression from response
            const detectedExpr = detectExpression(responseText);
            await setExpression(detectedExpr);

            // Strip expression tag and display (with any generated attachments)
            await appendMessage('assistant', responseText, true, null, responseAttachments.length > 0 ? responseAttachments : null);

        } catch (error) {
            hideTypingIndicator();
            settleGeneratingExpression();
            displayError(error, { surface: 'chat', retryHandler: retryLastUserMessage });
            console.error('API Error:', error);
        } finally {
            state.isLoading = false;
            updateSendButtonState();
        }
    }
}

/**
 * Build the body sent to /api/chat[/stream]. Shared by streaming and
 * non-streaming paths. The server uses the user's stored API key — the
 * frontend doesn't include one in the payload. The server-side providers
 * also append the prefill to messages when assembling the upstream request,
 * so the frontend must NOT push prefill into messages itself.
 */
function buildChatRequest() {
    const modelConfig = getActiveModelConfig();
    const persona = getActivePersona();
    const activeConvo = getActiveConversation();
    const conversationMessages = activeConvo ? activeConvo.messages : [];
    const systemPrompt = persona ? persona.systemPrompt : CONFIG.defaults.systemPrompt;
    // Prefill is an engine param: it rides on the model profile, not the persona.
    const prefillText = modelConfig.modelParams?.prefill?.trim() || '';

    // The model echoes back the prefill — track it so appendStreamChunk and
    // the non-streaming branch can strip it from displayed/persisted output.
    state.currentPrefill = prefillText;

    // Record which model this request uses so the assistant reply can be
    // tagged with it (WR-14) — read the layer NOW, not at append time, in
    // case the user switches models while the response streams.
    state.lastRequestModel = modelConfig.model;

    const messages = conversationMessages.map(msg => ({
        role: msg.role,
        content: msg.content,
    }));

    return {
        provider: modelConfig.provider,
        model: modelConfig.model,
        messages,
        systemPrompt,
        // The server's Tessera base layer names these in the expression
        // protocol, so the model is told the persona's REAL expression set
        // rather than a list frozen into the prompt text at creation.
        expressionNames: Object.keys(persona ? persona.expressions || {} : {}),
        modelParams: modelConfig.modelParams,
        ...(prefillText ? { prefill: prefillText } : {}),
        // Lets the server resolve this conversation's project and inject its
        // instructions + file context (P1-05). Harmless when there's no project.
        ...(state.activeConversationId ? { conversationId: state.activeConversationId } : {}),
        // When there's no conversation yet, still let the server resolve the
        // active workspace so the preview shows its injected context.
        ...(!state.activeConversationId && state.activeProjectId ? { projectId: state.activeProjectId } : {}),
    };
}

// ===== Request Inspector (P2-U4, developer mode) =====

/**
 * Reflect the device-local devMode pref: show/hide the top-bar "view request"
 * button and sync the settings toggle.
 */
function applyDevMode() {
    const on = !!UiPrefs.get('devMode');
    if (elements.viewRequestBtn) elements.viewRequestBtn.hidden = !on;
    if (elements.devModeToggle) elements.devModeToggle.checked = on;
}

/**
 * Build the same request params a send would, plus the current composer draft
 * as a trailing user message (so the preview reflects what the NEXT turn sends).
 * Note: delegates to buildChatRequest(), which sets state.currentPrefill as a
 * side effect — benign, since it's recomputed on every real send.
 */
function buildPreviewParams() {
    const params = buildChatRequest();
    const draft = elements.messageInput?.value.trim();
    if (draft) {
        params.messages = [...params.messages, { role: 'user', content: draft }];
    }
    return params;
}

/**
 * Open the request inspector: ask the server to assemble (but not send) the
 * exact provider request body, then show it as pretty-printed JSON.
 */
async function previewCurrentRequest() {
    let result;
    try {
        result = await API.chat.preview(buildPreviewParams());
    } catch (err) {
        console.error('Failed to preview request:', err);
        displayError(err, { action: 'preview the request' });
        return;
    }

    if (elements.requestInspectorMeta) {
        const warn = result.contextWarning ? ` · ⚠ ${result.contextWarning}` : '';
        elements.requestInspectorMeta.textContent =
            `POST to ${result.provider} · model ${result.model} · key ${result.apiKeyLocation}${warn}`;
    }
    if (elements.requestInspectorJson) {
        elements.requestInspectorJson.textContent = JSON.stringify(result.body, null, 2);
    }
    if (elements.requestInspectorModal) {
        elements.requestInspectorModal.classList.add('visible');
    }
}

function closeRequestInspectorModal() {
    if (elements.requestInspectorModal) {
        elements.requestInspectorModal.classList.remove('visible');
    }
}

/**
 * Non-streaming chat via the backend proxy. Server returns
 * { text, model, usage?, stopReason?, generatedImages? }.
 * Returns { text, attachments? } where attachments are stored generated
 * images (Gemini multimodal output).
 */
async function callAPI(userMessage, attachments = []) {
    const params = buildChatRequest();
    if (attachments.length > 0 && params.messages.length > 0) {
        const lastMsg = params.messages[params.messages.length - 1];
        if (lastMsg.role === 'user') {
            lastMsg.content = await buildAttachmentContentBlocks(lastMsg.content, attachments, params.provider);
        }
    }

    // Pinned before the await: if the user switches chats while the request
    // is in flight, the file panel must not react in the wrong conversation.
    const convoId = state.activeConversationId;
    const res = await API.chat.send(params);
    if (res.contextWarning) showProjectContextWarning(res.contextWarning);
    // Track A: a tools-on non-streaming turn returns the tool-event list; turn
    // it into chip/card attachments (same shape as the streaming path).
    const toolAttachments = (res.toolEvents || []).map(toolEventToAttachment);
    // Only the turn's last created file opens/alerts the panel — notifying
    // each one would fetch files that are immediately replaced on screen.
    const lastCreated = [...toolAttachments].reverse().find(a => a.type === 'created_file');
    if (lastCreated) FilePanel.notifyActivity(lastCreated, convoId);
    // If the model wrote to the scratchpad, refresh it if it's open (SP-03a).
    if ((res.toolEvents || []).some(ev => ev && ev.scratchpad)) FilePanel.refreshScratchpadFromActivity(convoId);
    const generatedAttachments = res.generatedImages
        ? await storeGeneratedImages(res.generatedImages)
        : [];
    return { text: res.text || '', attachments: [...toolAttachments, ...generatedAttachments] };
}

/**
 * Show a soft, deduplicated warning when a project's injected context was
 * truncated or partially unavailable (budget exceeded / Drive issue).
 * @param {string} message
 */
function showProjectContextWarning(message) {
    showToast(message, { type: 'warning', duration: 8000, key: 'project-context-warning' });
}

// ===== Streaming Support =====
/**
 * Streaming chat via /api/chat/stream. Server forwards the provider's native
 * SSE events; we parse the data JSON and dispatch on shape.
 * On abort (user clicked stop), API.chat.stream resolves normally — the
 * accumulator holds the partial text, which is what callers want.
 */
async function callAPIStreaming(userMessage, attachments = []) {
    const params = buildChatRequest();
    if (attachments.length > 0 && params.messages.length > 0) {
        const lastMsg = params.messages[params.messages.length - 1];
        if (lastMsg.role === 'user') {
            lastMsg.content = await buildAttachmentContentBlocks(lastMsg.content, attachments, params.provider);
        }
    }

    state.streamingAccumulator = '';
    state.streamingGeneratedImages = [];
    state.streamingToolEvents = [];

    // Pinned for the file panel: tool events arriving after the user switches
    // chats mid-stream must not open the panel in the wrong conversation.
    const convoId = state.activeConversationId;

    await API.chat.stream(params, (ev) => {
        // Synthetic event from the client (not provider SSE): project-context
        // budget/Drive warning surfaced from the response header.
        if (ev.event === 'project-context-warning') {
            if (ev.warning) showProjectContextWarning(ev.warning);
            return;
        }
        if (!ev.data) return;
        let payload;
        try { payload = JSON.parse(ev.data); } catch { return; }

        // Track A tool loop (tools-on turns run non-streaming server-side and
        // deliver activity as synthetic events, then the final answer as one
        // provider-native chunk handled below): render a chip per tool as it
        // runs; the done event's list is authoritative but matches what we
        // already collected, so finalize persists state.streamingToolEvents.
        if (payload.type === 'tool_activity') {
            state.streamingToolEvents.push(payload);
            renderLiveToolActivity(payload, convoId);
            return;
        }
        if (payload.type === 'tool_loop_done') {
            return;
        }

        // C7: providers can emit an error event *mid-stream* (e.g. Anthropic's
        // `{type:'error', error:{type,message}}` for overloaded_error, or a
        // bare `{error:{...}}` from Gemini). The HTTP response was 200, so this
        // is the only place we'd learn the turn failed. Synthesize an
        // ApiError-shaped object and throw — the throw rejects the stream
        // promise, which surfaces in the chat catch (partial bubble removed,
        // inline error + Retry shown).
        if (payload.type === 'error' || (payload.error && typeof payload.error === 'object')) {
            const provErr = payload.error || {};
            const err = new Error(provErr.message || 'The provider reported an error mid-response.');
            err.name = 'ApiError';
            err.code = 'PROVIDER_ERROR';
            err.status = 502;
            err.details = provErr.type ? { providerErrorType: provErr.type } : undefined;
            throw err;
        }

        if (params.provider === 'anthropic') {
            // Anthropic uses named SSE events; we dispatch on payload.type
            // (which mirrors event name) so we don't depend on the api-client
            // parsing the event line.
            if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta') {
                appendStreamChunk(payload.delta.text);
            }
        } else if (params.provider === 'google') {
            // Gemini sends unnamed events; text + inline image data live
            // under candidates[0].content.parts.
            const parts = payload.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
                if (part.text) {
                    appendStreamChunk(part.text);
                } else {
                    const inline = part.inlineData || part.inline_data;
                    if (inline) {
                        state.streamingGeneratedImages.push({
                            mimeType: inline.mimeType || inline.mime_type,
                            base64Data: inline.data,
                        });
                    }
                }
            }
        }
    });

    return {
        text: state.streamingAccumulator,
        generatedImages: state.streamingGeneratedImages,
        toolEvents: state.streamingToolEvents,
    };
}

/**
 * Store generated images from API response to IndexedDB
 * @param {Array} generatedImages - Array of { mimeType, base64Data }
 * @returns {Promise<Array>} - Array of attachment metadata
 */
async function storeGeneratedImages(generatedImages) {
    const attachments = [];

    for (const img of generatedImages) {
        const key = `gen_${crypto.randomUUID()}`;
        const extension = img.mimeType.split('/')[1] || 'png';
        const fileName = `generated_${Date.now()}.${extension}`;

        // Convert base64 to blob
        const byteCharacters = atob(img.base64Data);
        const byteArray = new Uint8Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            byteArray[i] = byteCharacters.charCodeAt(i);
        }
        const blob = new Blob([byteArray], { type: img.mimeType });

        await ImageStore.store(key, blob);

        attachments.push({
            id: crypto.randomUUID(),
            type: 'generated',
            mimeType: img.mimeType,
            fileName: fileName,
            fileSize: blob.size,
            imageStoreKey: key
        });
    }

    return attachments;
}

// ===== Streaming UI helpers =====
// These render and finalize the in-progress assistant message bubble while
// API.chat.stream forwards SSE events to callAPIStreaming.

function startStreamingMessage() {
    const welcome = elements.messagesContainer.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message assistant streaming';

    const labelDiv = document.createElement('div');
    labelDiv.className = 'message-label';
    const persona = getActivePersona();
    labelDiv.textContent = persona ? persona.name : CONFIG.defaults.assistantName;
    messageDiv.appendChild(labelDiv);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    // Pre-token placeholder: show the animated "typing" dots until the first
    // chunk arrives (appendStreamChunk overwrites this). The `awaiting-first-token`
    // class suppresses the trailing block cursor so we don't show both.
    messageDiv.classList.add('awaiting-first-token');
    contentDiv.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    messageDiv.appendChild(contentDiv);
    elements.messagesContainer.appendChild(messageDiv);

    state.streamingMessageDiv = messageDiv;
    state.streamingAccumulator = '';
    state.streamingDeclaredExpression = null;
    state.streamingGeneratedImages = [];
    state.streamingToolEvents = [];

    scrollToBottom();
}

// A leading "[expression: name]" is a control token, not content: it must set
// the avatar and then never reach the screen. Since chunks arrive split at
// arbitrary boundaries, the opening of a stream can be an INCOMPLETE tag
// ("[expr"), so we withhold display until we know whether it will close into
// one. This matches the tag against a growing prefix of the expected shape.
const TAG_OPEN = '[expression:';
const LEADING_EXPRESSION_TAG = /^\[expression:\s*([\w -]+)\]\s*/i;
// Stop waiting if an unclosed tag runs longer than any real name would — a
// malformed opener must never buffer the whole response.
const MAX_TAG_NAME_LENGTH = 40;

/**
 * Could `text` still grow into a complete leading expression tag?
 * Two phases: still typing out "[expression:" itself, or past the opener and
 * accumulating a plausible name that hasn't closed yet.
 * @param {string} text
 * @returns {boolean}
 */
function isPartialExpressionTag(text) {
    const lower = text.toLowerCase();
    if (lower.length < TAG_OPEN.length) return TAG_OPEN.startsWith(lower);
    if (!lower.startsWith(TAG_OPEN)) return false;
    const name = text.slice(TAG_OPEN.length);
    // A ']' here means the full-tag regex already declined it — malformed.
    return !name.includes(']') && name.length <= MAX_TAG_NAME_LENGTH && /^[\w -]*$/.test(name);
}

/**
 * Decide what of the stream so far is safe to render.
 * @param {string} text - Accumulated text (prefill already stripped)
 * @returns {{ display: string, expression: string|null, pending: boolean }}
 *   `pending` means "still might become a tag — render nothing yet".
 */
function splitLeadingExpressionTag(text) {
    const done = text.match(LEADING_EXPRESSION_TAG);
    if (done) {
        return { display: text.slice(done[0].length), expression: done[1].trim().toLowerCase(), pending: false };
    }
    if (isPartialExpressionTag(text)) {
        return { display: '', expression: null, pending: true };
    }
    return { display: text, expression: null, pending: false };
}

function appendStreamChunk(text) {
    state.streamingAccumulator += text;
    if (state.streamingMessageDiv) {
        const contentDiv = state.streamingMessageDiv.querySelector('.message-content');
        if (contentDiv) {
            let displayText = state.streamingAccumulator;
            if (state.currentPrefill) {
                displayText = stripPrefillText(displayText, state.currentPrefill);
            }

            const { display, expression, pending } = splitLeadingExpressionTag(displayText);
            // Still waiting to see if this is a tag — keep the typing dots up
            // rather than flashing a partial "[expre" on screen.
            if (pending) {
                scrollToBottom();
                return;
            }
            // The tag is parsed and stripped here but deliberately NOT applied
            // yet: the avatar holds the `generating` state for the whole
            // response, so "working on it" stays legible instead of flickering
            // for the four tokens it takes the tag to close. The declared
            // expression lands in finalizeStreamingMessage, which re-reads it
            // from the full text via detectExpression.
            if (expression) state.streamingDeclaredExpression = expression;

            // First real content: drop the pre-token placeholder state so the
            // trailing block cursor takes over from the typing dots.
            state.streamingMessageDiv.classList.remove('awaiting-first-token');
            contentDiv.innerHTML = renderMarkdown(display);
        }
        scrollToBottom();
    }
}

/**
 * Finalize the streaming assistant bubble.
 *
 * @param {string} fullText - the raw accumulator from the stream
 * @param {Array} generatedImages - Gemini multimodal images, if any
 * @param {string} [targetConvoId] - the conversation id this stream was
 *   started against. Pinning the convo here is critical: if the user
 *   switches to a different conversation mid-stream, `getActiveConversation()`
 *   would resolve to the NEW conversation at finalize-time, causing the
 *   assistant reply to be written to the wrong conversation server-side.
 *   Falls back to active for callers that don't pass it.
 */
async function finalizeStreamingMessage(fullText, generatedImages = [], targetConvoId = null) {
    if (!state.streamingMessageDiv) return;

    state.streamingMessageDiv.classList.remove('streaming');

    const detectedExpr = detectExpression(fullText);
    setExpression(detectedExpr);

    // Strip prefill + expression tag from the persisted/displayed text.
    let cleanText = fullText;
    if (state.currentPrefill) {
        cleanText = stripPrefillText(cleanText, state.currentPrefill);
        state.currentPrefill = '';
    }
    cleanText = stripExpressionTag(cleanText);

    // Assemble this turn's attachments: Track A tool artifacts (chips +
    // created-file cards) first, then any Gemini-generated images. Tool events
    // become persistable entries so they survive a reload.
    const toolAttachments = (state.streamingToolEvents || []).map(toolEventToAttachment);
    const imageAttachments = await storeGeneratedImages(generatedImages);
    const attachments = [...toolAttachments, ...imageAttachments];

    // Bail-out for empty results (e.g., user clicked Stop before any chunk
    // arrived). Persisting an empty assistant turn would pollute the
    // conversation context on the next send. Remove the empty bubble too.
    if (!cleanText.trim() && attachments.length === 0) {
        state.streamingMessageDiv.remove();
        state.streamingMessageDiv = null;
        state.streamingAccumulator = '';
        state.streamingGeneratedImages = [];
        state.streamingToolEvents = [];
        return;
    }

    // Reconcile the attachments row to the authoritative set: drop any live
    // tool chips rendered mid-stream and re-render everything once, so the DOM
    // matches exactly what a reload will produce from the persisted data.
    const liveArea = state.streamingMessageDiv.querySelector('.message-attachments');
    if (liveArea) liveArea.remove();
    if (attachments.length > 0) {
        const attachDiv = document.createElement('div');
        attachDiv.className = 'message-attachments';
        renderMessageAttachments(attachments, attachDiv);
        const contentDiv = state.streamingMessageDiv.querySelector('.message-content');
        if (contentDiv) state.streamingMessageDiv.insertBefore(attachDiv, contentDiv);
    }

    const contentDiv = state.streamingMessageDiv.querySelector('.message-content');
    if (contentDiv) {
        if (!cleanText && imageAttachments.length > 0) {
            contentDiv.innerHTML = '<em>Generated image(s)</em>';
        } else {
            contentDiv.innerHTML = renderMarkdown(cleanText);
        }
    }

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'message-actions';
    actionsDiv.innerHTML = messageActionsHTML('Regenerate');
    state.streamingMessageDiv.appendChild(actionsDiv);

    // Persist to server + local state. Awaits persistMessage so the server-
    // generated id is set on the local msg before any subsequent edit/delete.
    // Uses the convo this stream was started against (NOT the current active
    // convo) so a mid-stream conversation switch still writes the reply to
    // the original conversation.
    const targetConvo = targetConvoId
        ? state.conversations[targetConvoId]
        : getActiveConversation();
    if (targetConvo) {
        const msg = { role: 'assistant', content: cleanText, attachments };
        targetConvo.messages.push(msg);
        state.streamingMessageDiv.dataset.msgIndex = targetConvo.messages.length - 1;
        targetConvo.updatedAt = Date.now();
        try {
            const saved = await persistMessage(targetConvo.id, msg);
            if (saved && saved.id) msg.id = saved.id;
        } catch (err) {
            console.error('Failed to persist assistant message:', err);
        }
    }

    state.estimatedTokens += Math.ceil(fullText.length / 4);
    updateStatusBar();

    state.streamingMessageDiv = null;
    state.streamingAccumulator = '';
    state.streamingGeneratedImages = [];
    state.streamingToolEvents = [];
}

/**
 * Abort the in-flight chat stream. api-client.js handles the AbortController
 * lifecycle; callAPIStreaming returns the accumulator-so-far so partial text
 * is preserved as a normal completion.
 */
function stopGeneration() {
    API.chat.abort();
}

/**
 * Download a generated image from IndexedDB
 * @param {Object} attachment - The attachment metadata
 */
async function downloadGeneratedImage(attachment) {
    const blob = await ImageStore.getBlob(attachment.imageStoreKey);
    if (!blob) {
        console.error('Image not found for download');
        return;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = attachment.fileName || 'generated-image.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ===== File Attachment Handling =====

/**
 * Whether a pending attachment should become a chat WORKING FILE (CF-02) rather
 * than a static inline attachment. Text/code/markdown qualify; images, audio,
 * and PDFs do not (images are vision content; PDFs need a binary upload path,
 * deferred). Mirrors the server's text allow-list intent — `getFileCategory`
 * buckets PDF as 'document' alongside text, so PDF is excluded explicitly.
 */
function isTextWorkingFileUpload(att) {
    if (att.mimeType === 'application/pdf') return false;
    if (/\.pdf$/i.test(att.fileName || '')) return false;
    return att.type === 'code' || att.type === 'document';
}

/**
 * Turn text uploads into conversation working files (CF-02). Each is read as
 * text and POSTed to create a conversation file; on success it becomes a
 * 'created_file'-shaped attachment (same card + panel affordance as a
 * model-created file). On failure (Drive unavailable on dev login, transient
 * error) the upload is returned in `failed` so the caller can fall back to the
 * inline path — a file must never silently vanish.
 * @returns {Promise<{ created: Array, failed: Array }>}
 */
async function createWorkingFilesFromUploads(conversationId, uploads) {
    const created = [];
    const failed = [];
    for (const att of uploads) {
        try {
            const text = await att.file.text();
            const rec = await API.conversations.files.create(conversationId, {
                filename: att.fileName,
                content: text,
                mimeType: att.mimeType || undefined,
            });
            const url = API.conversations.files.contentUrl(conversationId, rec.id);
            created.push({
                type: 'created_file',
                fileName: rec.filename,
                url,
                mimeType: rec.mimeType || att.mimeType || '',
                sizeBytes: rec.sizeBytes || att.fileSize || 0,
            });
        } catch (err) {
            console.error('Failed to create working file from upload:', err);
            failed.push(att);
        }
    }
    return { created, failed };
}

function handleFileAttachment(files) {
    const maxFiles = CONFIG.attachments.maxAttachments;
    const currentCount = state.pendingAttachments.length;

    for (let i = 0; i < files.length; i++) {
        if (currentCount + i >= maxFiles) {
            showNotification(`Maximum ${maxFiles} files per message`);
            break;
        }

        const file = files[i];
        const category = getFileCategory(file.type);
        const maxSize = category === 'image' ? CONFIG.attachments.maxImageSize : CONFIG.attachments.maxFileSize;

        if (file.size > maxSize) {
            showNotification(`File "${file.name}" exceeds ${Math.round(maxSize / 1024 / 1024)}MB limit`);
            continue;
        }

        const id = crypto.randomUUID();
        const previewUrl = category === 'image' ? URL.createObjectURL(file) : null;

        state.pendingAttachments.push({
            id,
            file,
            previewUrl,
            type: category,
            mimeType: file.type || 'application/octet-stream',
            fileName: file.name,
            fileSize: file.size
        });
    }

    renderAttachmentPreviews();
    updateSendButtonState();
}

function renderAttachmentPreviews() {
    const area = elements.attachmentPreviewArea;
    if (!area) return;

    area.innerHTML = '';

    if (state.pendingAttachments.length === 0) {
        area.style.display = 'none';
        return;
    }

    area.style.display = 'flex';

    state.pendingAttachments.forEach(att => {
        const item = document.createElement('div');
        item.className = 'attachment-preview-item';

        const badge = document.createElement('span');
        badge.className = 'att-badge';
        badge.textContent = getFileTypeLabel(att.fileName, att.mimeType);
        item.appendChild(badge);

        if (att.type === 'image' && att.previewUrl) {
            const img = document.createElement('img');
            img.src = att.previewUrl;
            img.alt = att.fileName;
            item.appendChild(img);
        } else {
            const iconDiv = document.createElement('div');
            iconDiv.className = 'att-icon';
            iconDiv.textContent = getFileIcon(att.mimeType);
            item.appendChild(iconDiv);
        }

        const nameDiv = document.createElement('div');
        nameDiv.className = 'att-name';
        nameDiv.textContent = att.fileName;
        nameDiv.title = att.fileName;
        item.appendChild(nameDiv);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-attachment';
        removeBtn.textContent = '\u00D7';
        removeBtn.title = 'Remove';
        removeBtn.addEventListener('click', () => removeAttachment(att.id));
        item.appendChild(removeBtn);

        area.appendChild(item);
    });
}

function removeAttachment(id) {
    const idx = state.pendingAttachments.findIndex(a => a.id === id);
    if (idx === -1) return;

    const att = state.pendingAttachments[idx];
    if (att.previewUrl) {
        URL.revokeObjectURL(att.previewUrl);
    }

    state.pendingAttachments.splice(idx, 1);
    renderAttachmentPreviews();
    updateSendButtonState();
}

async function storeAttachmentsToIndexedDB(pendingAttachments) {
    const metadata = [];

    for (const att of pendingAttachments) {
        const storeKey = `attach_${crypto.randomUUID()}`;
        await ImageStore.store(storeKey, att.file);

        // Revoke preview URL
        if (att.previewUrl) {
            URL.revokeObjectURL(att.previewUrl);
        }

        metadata.push({
            id: att.id,
            type: att.type,
            mimeType: att.mimeType,
            fileName: att.fileName,
            fileSize: att.fileSize,
            imageStoreKey: storeKey
        });
    }

    return metadata;
}

/**
 * Build a content-block array (Anthropic-flavored) for a chat message that
 * includes attachments. The backend's Anthropic provider passes this through
 * verbatim; the Gemini provider translates it to Gemini's `parts` shape, so
 * a single client-side build path covers both providers.
 *
 * Note: base64 inflates payload size by ~33%. Express body limit is 10MB
 * server-side — large image batches may hit it. Multipart-upload support is
 * a future task.
 */
/**
 * Build content blocks for the user's message.
 *
 * @param {string} textContent
 * @param {Array} attachments
 * @param {string} [provider] - 'anthropic' | 'google' | 'openai'. Used only
 *   for audio gating today: Anthropic's API rejects audio content blocks,
 *   so we skip them for that provider. The block shape itself is
 *   Anthropic-flavored; the server-side Gemini provider translates it.
 */
async function buildAttachmentContentBlocks(textContent, attachments, provider) {
    const contentParts = [];

    for (const att of attachments) {
        const blob = await ImageStore.getBlob(att.imageStoreKey);
        if (!blob) continue;

        if (att.type === 'image') {
            const base64 = await blobToBase64(blob);
            contentParts.push({
                type: 'image',
                source: { type: 'base64', media_type: att.mimeType, data: base64 }
            });
        } else if (att.mimeType === 'application/pdf') {
            const base64 = await blobToBase64(blob);
            contentParts.push({
                type: 'document',
                source: { type: 'base64', media_type: att.mimeType, data: base64 }
            });
        } else if (att.type === 'audio') {
            // Anthropic doesn't accept audio content blocks at all — skip.
            // Gemini does, via inline_data; the server-side Gemini provider
            // translates this block.
            if (provider === 'google') {
                const base64 = await blobToBase64(blob);
                contentParts.push({
                    type: 'audio',
                    source: { type: 'base64', media_type: att.mimeType, data: base64 }
                });
            }
        } else if (att.type === 'code' || att.type === 'document') {
            // Read text files as text and include inline
            const text = await blob.text();
            contentParts.push({
                type: 'text',
                text: `[File: ${att.fileName}]\n${text}`
            });
        }
    }

    // Add the user's text message
    if (textContent) {
        contentParts.push({ type: 'text', text: textContent });
    }

    return contentParts;
}

// ===== Event Listeners =====
function setupEventListeners() {
    // Sidebar toggle
    elements.openSidebar.addEventListener('click', openSidebar);
    elements.closeSidebar.addEventListener('click', closeSidebar);

    // Sidebar resize (desktop drag handle)
    setupSidebarResize();

    // Resizable settings textboxes (themed bottom drag-bar)
    setupTextareaResizers();

    // Critical banner dismiss (P0-17)
    if (elements.criticalBannerDismiss) {
        elements.criticalBannerDismiss.addEventListener('click', hideCriticalBanner);
    }

    // Section rail → main-area router (Chats/Workspaces). Personas + Settings are
    // interim: they open the existing popover/modal until WR-07b/c make them
    // full main-area sections.
    document.querySelectorAll('.rail-item[data-section]').forEach(item => {
        item.addEventListener('click', (e) => {
            const section = item.dataset.section;
            if (section === 'chats') navigate({ type: 'chats' });
            else if (section === 'workspaces') navigate({ type: 'workspaces' });
            else if (section === 'personas') navigate({ type: 'personas' });
            else if (section === 'models') navigate({ type: 'models' });
            else if (section === 'settings') navigate({ type: 'settings' });
        });
    });

    // Settings section (WR-07b): re-parent the settings form out of #settingsModal
    // into the main-area panel #settingsView. All settings inputs are cached by id
    // and wired below, so moving the subtree keeps every ref + listener valid — the
    // settings form is now a router view, not a modal.
    const settingsBody = document.querySelector('#settingsModal .settings-modal-body');
    if (settingsBody && elements.settingsView) {
        const heading = document.createElement('h1');
        heading.className = 'settings-view-title';
        heading.textContent = 'Settings';
        elements.settingsView.appendChild(heading);
        elements.settingsView.appendChild(settingsBody);
        if (elements.settingsModal) elements.settingsModal.remove(); // discard the empty modal shell
    }

    // Persona editor (WR-08): pull the persona-identity sections (profile /
    // avatar image / expressions) out of the settings form into their own
    // main-area panel, reached from the Personas section. Same re-parenting
    // trick as above — inputs stay cached by id, listeners survive the move.
    if (elements.personaEditView) {
        elements.personaEditView.innerHTML = `
            <div class="settings-view-crumb"><span class="cp-crumb" id="personaEditBack">‹ Personas</span></div>
            <h1 class="settings-view-title" id="personaEditTitle">Persona</h1>`;
        const editorBody = document.createElement('div');
        editorBody.className = 'settings-modal-body';
        ['personaProfileSection', 'personaAvatarSection', 'personaExpressionsSection'].forEach(id => {
            const section = document.getElementById(id);
            if (section) editorBody.appendChild(section);
        });
        elements.personaEditView.appendChild(editorBody);
        document.getElementById('personaEditBack')
            .addEventListener('click', () => navigate({ type: 'personas' }));
    }

    // Models & Providers section (WR-13): a title row + the model catalog
    // (rendered per-visit by renderModelsCatalog) + the active-model/API-key
    // and advanced-params sections re-parented out of the settings form.
    // Same re-parenting trick — every input keeps its id-cached ref + listeners.
    if (elements.modelsView) {
        // Two sibling panels toggled by renderModelsView: the catalog (chips +
        // cards) and the per-model detail view (Slice 5). The static Advanced
        // Settings section is no longer re-parented in — it was retired.
        elements.modelsView.innerHTML = `
            <div class="models-catalog-panel" id="modelsCatalogPanel">
                <div class="models-head">
                    <h1 class="settings-view-title">Models</h1>
                    <button class="section-new-btn" id="modelsAddBtn" type="button">+ Add model</button>
                </div>
                <div class="provider-chips" id="providerChips"></div>
                <div class="models-catalog" id="modelsCatalog"></div>
            </div>
            <div class="model-detail-panel" id="modelDetailPanel" hidden></div>`;
        // No argument: the header button is provider-agnostic, so the modal
        // defaults to the active model's provider (a group's "+ Add" passes one).
        document.getElementById('modelsAddBtn').addEventListener('click', () => openModelModal());
    }
    if (elements.personaButton) {
        elements.personaButton.addEventListener('click', (e) => {
            e.stopPropagation();
            showPersonaPopover(elements.personaButton);
        });
    }
    // The model menu opens from either the top-bar button (browsing) or the
    // composer chip (in chat) — same menu, anchored to whichever was clicked.
    [elements.modelButton, elements.composerModelButton].forEach((btn) => {
        if (!btn) return;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            showModelMenu(btn);
        });
    });

    // Appearance: theme / accent / chat width (device-local, applied live)
    document.querySelectorAll('#themeOptions button').forEach(btn => {
        btn.addEventListener('click', () => {
            UiPrefs.set('theme', btn.dataset.themeName);
            withThemeTransition(() => applyTheme(btn.dataset.themeName));
            syncAppearanceControls();
        });
    });
    document.querySelectorAll('#chatWidthOptions button').forEach(btn => {
        btn.addEventListener('click', () => {
            UiPrefs.set('chatWidth', btn.dataset.chatWidth);
            applyChatWidth(btn.dataset.chatWidth);
            syncAppearanceControls();
        });
    });
    document.querySelectorAll('#filePanelModeOptions button').forEach(btn => {
        btn.addEventListener('click', () => {
            UiPrefs.set('filePanelMode', btn.dataset.filePanelMode);
            syncAppearanceControls();
        });
    });

    // File panel (viewer): close, raw/rendered toggle, and the edge tab.
    if (elements.filePanelClose) {
        elements.filePanelClose.addEventListener('click', () => FilePanel.close());
    }
    if (elements.filePanelRawToggle) {
        elements.filePanelRawToggle.addEventListener('click', () => FilePanel.toggleRaw());
    }
    if (elements.filePanelHistoryBtn) {
        elements.filePanelHistoryBtn.addEventListener('click', () => FilePanel.toggleHistory());
    }
    // CF-01b: the panel's browse toggle (list ⇄ file) and the top-bar entry point.
    if (elements.filePanelBrowseBtn) {
        elements.filePanelBrowseBtn.addEventListener('click', () => FilePanel.toggleExplorer());
    }
    // SP-03a: the scratchpad "active" toggle in the panel header.
    if (elements.filePanelScratchpadToggle) {
        elements.filePanelScratchpadToggle.addEventListener('click', () => FilePanel.toggleScratchpadEnabled());
    }
    if (elements.filesExplorerBtn) {
        elements.filesExplorerBtn.addEventListener('click', () => FilePanel.toggleExplorer());
        // Hover/focus reveals the not-loaded popover (CT-06); clicking still
        // opens the panel, so noticing and fixing are one gesture apart.
        elements.filesExplorerBtn.addEventListener('mouseenter', () => FilePanel.showContextPopover());
        elements.filesExplorerBtn.addEventListener('mouseleave', () => FilePanel.hideContextPopover());
        elements.filesExplorerBtn.addEventListener('focus', () => FilePanel.showContextPopover());
        elements.filesExplorerBtn.addEventListener('blur', () => FilePanel.hideContextPopover());
    }
    // File panel (user editing, slice 3): edit / save / cancel.
    if (elements.filePanelEditBtn) {
        elements.filePanelEditBtn.addEventListener('click', () => FilePanel.enterEdit());
    }
    if (elements.filePanelSaveBtn) {
        elements.filePanelSaveBtn.addEventListener('click', () => FilePanel.saveEdit());
    }
    if (elements.filePanelCancelBtn) {
        elements.filePanelCancelBtn.addEventListener('click', () => FilePanel.cancelEdit());
    }
    // Custom palette controls: touching any of them activates the Custom theme.
    const setCustomPalette = (patch) => {
        UiPrefs.set('customPalette', { ...UiPrefs.get('customPalette'), ...patch });
        UiPrefs.set('theme', 'custom');
        withThemeTransition(() => applyTheme('custom'));
        syncAppearanceControls();
    };
    if (elements.paletteBase) {
        elements.paletteBase.addEventListener('input', () => setCustomPalette({ base: elements.paletteBase.value }));
    }
    if (elements.paletteTint) {
        elements.paletteTint.addEventListener('input', () => setCustomPalette({ tint: Number(elements.paletteTint.value) }));
    }
    document.querySelectorAll('#paletteModeOptions button').forEach(btn => {
        btn.addEventListener('click', () => setCustomPalette({ mode: btn.dataset.paletteMode }));
    });
    if (elements.paletteResetBtn) {
        elements.paletteResetBtn.addEventListener('click', () => setCustomPalette({ ...UiPrefs.defaults.customPalette }));
    }

    // Developer mode + request inspector (P2-U4)
    if (elements.devModeToggle) {
        elements.devModeToggle.addEventListener('change', () => {
            UiPrefs.set('devMode', elements.devModeToggle.checked);
            applyDevMode();
        });
    }
    // Files-in-context: how many turns a changed file stays live (FC-03b).
    // Server-backed, so it rides the settings auto-save. Clamp to the same
    // 0–20 the API enforces and reflect the clamped value back in the field.
    if (elements.activeFileTurns) {
        elements.activeFileTurns.addEventListener('change', () => {
            let v = parseInt(elements.activeFileTurns.value, 10);
            if (!Number.isFinite(v)) v = CONFIG.defaults.activeFileTurns;
            v = Math.max(0, Math.min(20, v));
            elements.activeFileTurns.value = v;
            state.settings.activeFileTurns = v;
            autoSaveSettings();
        });
    }

    if (elements.viewRequestBtn) {
        elements.viewRequestBtn.addEventListener('click', previewCurrentRequest);
    }
    if (elements.closeRequestInspector) {
        elements.closeRequestInspector.addEventListener('click', closeRequestInspectorModal);
    }
    if (elements.requestInspectorModal) {
        elements.requestInspectorModal.addEventListener('click', (e) => {
            if (e.target === elements.requestInspectorModal) closeRequestInspectorModal();
        });
    }
    if (elements.copyRequestBtn) {
        elements.copyRequestBtn.addEventListener('click', () => {
            const text = elements.requestInspectorJson?.textContent || '';
            navigator.clipboard?.writeText(text).then(
                () => showToast('Request JSON copied.', { type: 'success' }),
                () => showToast('Copy failed.', { type: 'error' })
            );
        });
    }

    // Copy button on rendered code blocks (delegated — blocks are injected as
    // message HTML, so we can't bind them individually). Reads the raw code from
    // the sibling <code> element and briefly swaps the icon to a checkmark.
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.code-copy-btn');
        if (!btn) return;
        const codeEl = btn.parentElement?.querySelector('pre code');
        const text = codeEl ? codeEl.textContent : '';
        if (!text) return;
        navigator.clipboard?.writeText(text).then(() => {
            btn.classList.add('copied');
            btn.innerHTML = ICON_SVG.check;
            clearTimeout(btn._copyResetTimer);
            btn._copyResetTimer = setTimeout(() => {
                btn.classList.remove('copied');
                btn.innerHTML = ICON_SVG.copy;
            }, 1500);
        }, () => showToast('Copy failed.', { type: 'error' }));
    });

    // (The "+ New chat" button lives in the main-area Chats list, wired per
    // render in renderChatsListMain.)

    // Shared confirm dialog. No close ×: a confirm has exactly two exits.
    elements.confirmModalCancelBtn.addEventListener('click', () => closeConfirmDialog(false));
    elements.confirmModalConfirmBtn.addEventListener('click', () => closeConfirmDialog(true));
    elements.confirmModal.addEventListener('click', (e) => {
        if (e.target === elements.confirmModal) closeConfirmDialog(false);
    });
    // Esc and the Tab trap are bound to the document while the dialog is open —
    // see _confirmKeydown.

    // Name-only create modal (workspace + project creation). The create/edit
    // triggers live in the Workspaces drill-in and the inline container pages,
    // wired per-render. Container instructions/files are edited inline, not here.
    elements.closeNameModal.addEventListener('click', () => closeNameModal(null));
    elements.nameModalSaveBtn.addEventListener('click', submitNameModal);
    elements.nameModal.addEventListener('click', (e) => {
        if (e.target === elements.nameModal) closeNameModal(null);
    });
    elements.nameModalInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitNameModal(); }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && elements.nameModal.classList.contains('visible')) {
            closeNameModal(null);
        }
    });
    // The top-bar breadcrumb and inline container pages wire their own controls
    // per render (renderBreadcrumb / wireContainerPage).

    // Close any open context menus when clicking elsewhere
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.context-menu') && !e.target.closest('.conversation-menu-btn') && !e.target.closest('.persona-menu-btn') && !e.target.closest('.project-menu-btn')) {
            const existingMenu = document.querySelector('.context-menu');
            if (existingMenu) existingMenu.remove();
        }
    });

    // Persona model-settings mode toggle (persona editor, WR-12)
    document.querySelectorAll('#personaModelModeOptions button').forEach(btn => {
        btn.addEventListener('click', () => setPersonaModelMode(btn.dataset.modelMode));
    });

    // File-tools: composer per-chat toggle + persona base default (Track A).
    if (elements.toolsToggleBtn) {
        elements.toolsToggleBtn.addEventListener('click', toggleChatTools);
    }
    if (elements.personaToolsBase) {
        elements.personaToolsBase.addEventListener('change', () => setPersonaToolsBase(elements.personaToolsBase.checked));
    }

    // Provider/model switching and the API-key field moved out of Settings in
    // Slice 4 (catalog cards + provider key popover), so no listeners here.

    // Model parameter controls are wired per-instance by the detail view
    // (wireParamControls in renderModelDetail), not here — the static Advanced
    // Settings section was retired in Slice 5.

    // Persona settings - auto-save
    elements.assistantName.addEventListener('input', autoSaveSettings);
    elements.personaTagline.addEventListener('input', autoSaveSettings);
    elements.personaRoleLabel.addEventListener('input', autoSaveSettings);
    elements.systemPrompt.addEventListener('input', autoSaveSettings);
    // (prefill is a model param now — edited in the per-model detail view.)

    // API-key visibility toggle + clear now live in the provider key popover
    // (showProviderKeyPopover), wired per-instance when the popover opens.

    // Size / position preset buttons in Settings (the popover wires its own).
    document.querySelectorAll('.size-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => setAvatarSize(btn.dataset.size));
    });
    document.querySelectorAll('.position-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => setAvatarPosition(btn.dataset.position));
    });

    // Custom size slider — continuous scale beyond the presets.
    if (elements.avatarSizeSlider) {
        elements.avatarSizeSlider.addEventListener('input', async () => {
            state.settings.avatarSize = String(elements.avatarSizeSlider.value);
            syncAvatarSizeControls();
            await updateFloatingAvatar();
        });
        elements.avatarSizeSlider.addEventListener('change', () => autoSaveSettings());
    }

    // Drag the floating avatar to position it freely.
    setupAvatarDrag();

    // Show avatar checkbox - auto-save
    elements.showAvatar.addEventListener('change', () => {
        setShowAvatar(elements.showAvatar.checked);
    });

    // Avatar button in the top bar → options popover (WR-10)
    elements.avatarToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showAvatarMenu(elements.avatarToggleBtn);
    });
    
    // Avatar file upload
    elements.avatarUploadBtn.addEventListener('click', () => {
        elements.avatarFileInput.click();
    });
    
    elements.avatarFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            handleAvatarUpload(file);
        }
    });
    
    elements.avatarClearBtn.addEventListener('click', () => {
        clearAvatarImage();
    });
    
    // Expression modal
    elements.addExpressionBtn.addEventListener('click', () => openExpressionModal());
    elements.closeExpressionModal.addEventListener('click', closeExpressionModal);
    elements.saveExpressionBtn.addEventListener('click', saveExpression);
    elements.deleteExpressionBtn.addEventListener('click', deleteExpression);
    
    // Expression file upload
    elements.expressionUploadBtn.addEventListener('click', () => {
        elements.expressionFileInput.click();
    });
    
    elements.expressionFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            handleExpressionImageUpload(file);
        }
    });
    
    elements.expressionClearBtn.addEventListener('click', () => {
        clearExpressionImage();
    });
    
    // Close modal on overlay click
    elements.expressionModal.addEventListener('click', (e) => {
        if (e.target === elements.expressionModal) {
            closeExpressionModal();
        }
    });

    // Add-model modal ("+ Add model" in the Models view header, or a catalog
    // group's "+ Add", are the entries; the provider is picked inside).
    elements.closeModelModal.addEventListener('click', closeModelModal);
    elements.fetchModelsBtn.addEventListener('click', handleFetchModels);
    elements.addModelBtn.addEventListener('click', handleAddModelManually);
    elements.modalKeyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showProviderKeyPopover(elements.modalKeyBtn, modelModalProvider);
    });

    // Close model modal on overlay click
    elements.modelModal.addEventListener('click', (e) => {
        if (e.target === elements.modelModal) {
            closeModelModal();
        }
    });

    // Message action buttons (event delegation)
    elements.messagesContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.message-action-btn');
        if (!btn) return;
        const messageDiv = btn.closest('.message');
        if (!messageDiv) return;
        const action = btn.dataset.action;
        const msgIndex = parseInt(messageDiv.dataset.msgIndex, 10);
        if (isNaN(msgIndex)) return;
        handleMessageAction(messageDiv, action, msgIndex);
    });

    // Message input
    elements.messageInput.addEventListener('input', () => {
        updateSendButtonState();
        autoResizeTextarea(elements.messageInput);
    });

    elements.messageInput.addEventListener('keydown', (e) => {
        // Shift+Enter sends; plain Enter inserts a newline. This guards against
        // accidentally firing off a long, multi-paragraph message mid-thought.
        if (e.key === 'Enter' && e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Send button
    elements.sendButton.addEventListener('click', sendMessage);

    // Stop generation button
    elements.stopButton.addEventListener('click', stopGeneration);

    // File attachments
    elements.attachButton.addEventListener('click', () => {
        elements.fileAttachInput.click();
    });

    elements.fileAttachInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFileAttachment(e.target.files);
        }
        e.target.value = ''; // Reset so same file can be re-selected
    });

    // Drag and drop on chat area
    let dragCounter = 0;
    elements.chatArea.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter++;
        elements.dragOverlay.classList.add('visible');
    });

    elements.chatArea.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            elements.dragOverlay.classList.remove('visible');
        }
    });

    elements.chatArea.addEventListener('dragover', (e) => {
        e.preventDefault();
    });

    elements.chatArea.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCounter = 0;
        elements.dragOverlay.classList.remove('visible');
        if (e.dataTransfer.files.length > 0) {
            handleFileAttachment(e.dataTransfer.files);
        }
    });
    
    // Assistant name preview (avatar card + persona-editor page title)
    elements.assistantName.addEventListener('input', () => {
        const name = elements.assistantName.value || 'Assistant';
        elements.avatarPreviewName.textContent = name;
        const editTitle = document.getElementById('personaEditTitle');
        if (editTitle) editTitle.textContent = name;
    });

    // Tagline / role live-update the card preview + their counters. The values
    // themselves are persisted by autoSaveSettings (wired above with the rest
    // of the persona fields).
    elements.personaTagline.addEventListener('input', () => {
        elements.avatarPreviewTagline.textContent = elements.personaTagline.value.trim();
        syncPersonaFieldCounters();
    });
    elements.personaRoleLabel.addEventListener('input', syncPersonaFieldCounters);
}

// ===== File Upload Handlers =====

/**
 * Upload an avatar image to the server. Server stores under
 * data/avatars/{personaId}_avatar.{ext} and updates persona.avatarFilename.
 */
async function handleAvatarUpload(file) {
    if (!file.type.startsWith('image/')) {
        showToast('Please select an image file', { type: 'warning' });
        return;
    }
    // Backend enforces 5MB — match client-side for fast feedback.
    const maxSize = 5 * 1024 * 1024;
    if (file.size > maxSize) {
        showToast('Image is too large. Please select an image under 5MB.', { type: 'warning' });
        return;
    }

    const persona = getActivePersona();
    if (!persona) {
        showToast('No active persona', { type: 'warning' });
        return;
    }

    try {
        await API.avatars.upload(persona.id, file);
        // Server returns { avatarUrl } but not the filename — use a truthy
        // sentinel and bump updatedAt so the cache-busted <img src> reloads.
        persona.avatarFilename = '1';
        persona.updatedAt = Date.now();

        updateAvatarPreview();
        await updateFloatingAvatar();
        // Expression slots without art of their own render the default avatar
        // plus a mood badge, so they're stale the moment the avatar changes.
        await renderExpressionList();
        showNotification('Avatar uploaded!', 'success');
    } catch (error) {
        console.error('Failed to upload avatar:', error);
        displayError(error, { action: 'upload image' });
    }
}

/**
 * Remove the avatar image from the server.
 */
async function clearAvatarImage() {
    const persona = getActivePersona();
    if (!persona) return;

    try {
        if (persona.avatarFilename) {
            await API.avatars.delete(persona.id);
        }
        persona.avatarFilename = '';
        persona.updatedAt = Date.now();
    } catch (err) {
        console.error('Failed to delete avatar:', err);
        displayError(err, { action: 'remove avatar' });
        return;
    }

    updateAvatarPreview();
    await updateFloatingAvatar();
    // Slots falling back to the avatar revert to a bare emoji — repaint them.
    await renderExpressionList();
}

/**
 * Handle expression image upload - stores blob temporarily until expression is saved
 */
async function handleExpressionImageUpload(file) {
    // Validate file type
    if (!file.type.startsWith('image/')) {
        showToast('Please select an image file', { type: 'warning' });
        return;
    }

    // Validate file size (max 2MB for expressions with IndexedDB)
    const maxSize = 2 * 1024 * 1024;
    if (file.size > maxSize) {
        showToast('Image is too large. Please select an image under 2MB.', { type: 'warning' });
        return;
    }

    try {
        // Revoke old preview URL if exists
        if (state.tempExpressionPreviewUrl) {
            URL.revokeObjectURL(state.tempExpressionPreviewUrl);
        }

        const blob = await ImageStore.fileToBlob(file);
        state.tempExpressionBlob = blob;
        state.tempExpressionPreviewUrl = URL.createObjectURL(blob);

        // Update preview in modal
        elements.expressionImagePreview.innerHTML = `<img src="${state.tempExpressionPreviewUrl}" alt="Expression preview">`;

    } catch (error) {
        console.error('Failed to upload expression image:', error);
        displayError(error, { action: 'upload image' });
    }
}

/**
 * Clear the expression image in the modal
 */
function clearExpressionImage() {
    // Revoke preview URL if exists
    if (state.tempExpressionPreviewUrl) {
        URL.revokeObjectURL(state.tempExpressionPreviewUrl);
    }
    state.tempExpressionBlob = null;
    state.tempExpressionPreviewUrl = '';
    // Mark that user explicitly cleared the image (use special marker)
    state.tempExpressionCleared = true;
    elements.expressionImagePreview.innerHTML = '<span class="preview-placeholder">No image</span>';
}

// ===== Utility Functions =====
function autoResizeTextarea(textarea) {
    // Grow to fit content; CSS max-height caps it (then the textarea scrolls).
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
}

async function clearConversation() {
    const ok = await confirmDialog({
        title: 'Clear this conversation?',
        body: "Every message in this chat will be removed and the chat reset to a new one. This can't be undone.",
        confirmLabel: 'Clear',
        danger: true,
    });
    if (!ok) return;

    // Clear the active conversation's messages
    const activeConvo = getActiveConversation();
    if (activeConvo) {
        activeConvo.messages = [];
        activeConvo.title = 'New Chat';
        activeConvo.updatedAt = Date.now();
        saveConversations();
    }

    state.estimatedTokens = 0;
    state.currentExpression = 'neutral';
    renderConversation();
    updateStatusBar();
    await updateFloatingAvatar();
    closeSidebar();
}

// ===== Auth Gate (P0-14) =====
// Decides whether to show the login screen or the main app on page load.
// init() (P0-15) loads all data from the server before rendering — see init.

const OAUTH_ERROR_MESSAGES = {
    oauth_denied: 'Sign-in was cancelled. Please try again to continue.',
    invalid_state: 'Sign-in security check failed. Please try again.',
    no_code: 'Sign-in did not complete. Please try again.',
    oauth_failed: 'Sign-in failed. Please try again in a moment.',
    session_expired: 'Your session expired. Please sign in again.',
    init_failed: 'Could not load the app. Your browser data may be unavailable — try a different browser or clear this site\'s data.',
};

function showLoginScreen(errorMessage) {
    const loginScreen = document.getElementById('loginScreen');
    const appContainer = document.getElementById('appContainer');
    const errorEl = document.getElementById('loginError');

    if (errorEl) {
        if (errorMessage) {
            errorEl.textContent = errorMessage;
            errorEl.hidden = false;
        } else {
            errorEl.textContent = '';
            errorEl.hidden = true;
        }
    }

    if (appContainer) appContainer.hidden = true;
    if (loginScreen) loginScreen.hidden = false;
}

function showApp() {
    const loginScreen = document.getElementById('loginScreen');
    const appContainer = document.getElementById('appContainer');
    if (loginScreen) loginScreen.hidden = true;
    if (appContainer) appContainer.hidden = false;
    updateAccountInfo();
}

function updateAccountInfo() {
    const el = document.getElementById('accountInfo');
    if (!el) return;
    if (state.user) {
        const label = state.user.displayName || state.user.email || 'Signed in';
        el.textContent = state.user.email
            ? `${label} (${state.user.email})`
            : label;
    } else {
        el.textContent = 'Signed in';
    }
}

function handleLoginClick() {
    const btn = document.getElementById('googleSignInBtn');
    if (btn) btn.disabled = true;
    window.location.href = API.auth.getGoogleLoginUrl();
}

/**
 * DEV-ONLY: sign in as a local stub user via the dev-login bypass, then reload
 * so bootstrap picks up the new session. Only reachable when the server has
 * ALLOW_DEV_LOGIN enabled (the button is hidden otherwise).
 */
async function handleDevLoginClick() {
    const btn = document.getElementById('devLoginBtn');
    if (btn) btn.disabled = true;
    try {
        await API.auth.devLogin();
    } catch (err) {
        console.error('Dev login failed:', err);
        if (btn) btn.disabled = false;
        showLoginScreen('Dev login failed. Is ALLOW_DEV_LOGIN=true set on the server?');
        return;
    }
    // Full navigation so bootstrap re-runs against the new session cookie.
    window.location.href = '/?auth=success';
}

async function handleLogoutClick() {
    const btn = document.getElementById('logoutBtn');
    if (btn) btn.disabled = true;
    try {
        await API.auth.logout();
    } catch (err) {
        // Even if the server call fails, complete the logout client-side
        // by reloading. The cookie is httpOnly, so we can't clear it from
        // JS — but the reload at least resets all in-memory state.
        console.warn('Logout request failed:', err);
    }
    // Hard reload to fully tear down session-owned client state:
    // - Aborts any in-flight chat stream (fetch is cancelled on navigation)
    // - Drops in-memory state.personas / state.conversations / etc.
    // - Closes the ImageStore IndexedDB connection (and its blob URLs)
    // The server-side cookie has been cleared (or was already invalid),
    // so the reload lands on the login screen.
    window.location.href = '/';
}

/**
 * Parse and clear OAuth-related query params from the URL.
 * Returns an error message to display, if any.
 */
function consumeAuthCallbackParams() {
    const params = new URLSearchParams(window.location.search);
    const error = params.get('error');
    const authStatus = params.get('auth');

    if (!error && !authStatus) return null;

    // Strip auth-related params from the URL so refreshes don't re-process them.
    params.delete('auth');
    params.delete('error');
    const remaining = params.toString();
    const cleanUrl = window.location.pathname
        + (remaining ? `?${remaining}` : '')
        + window.location.hash;
    window.history.replaceState({}, document.title, cleanUrl);

    if (error) {
        return OAUTH_ERROR_MESSAGES[error] || 'Sign-in failed. Please try again.';
    }
    return null;
}

/**
 * Bootstrap entry point. Runs before init().
 * Decides between login screen and main app based on session state.
 */
async function bootstrap() {
    // Apply device-local appearance prefs (theme/accent/chat width/sidebar) as
    // early as possible so the login screen and app render in the chosen theme
    // without a flash of the default.
    UiPrefs.apply();

    // Wire static event listeners that exist regardless of auth state.
    const loginBtn = document.getElementById('googleSignInBtn');
    if (loginBtn) loginBtn.addEventListener('click', handleLoginClick);

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', handleLogoutClick);

    // Reveal the dev-login button only when the server reports the bypass is
    // enabled (development + ALLOW_DEV_LOGIN). Non-fatal: a failed probe just
    // leaves the button hidden, so normal Google sign-in is unaffected.
    try {
        const authConfig = await API.auth.config();
        if (authConfig && authConfig.devLogin) {
            const devBtn = document.getElementById('devLoginBtn');
            if (devBtn) {
                devBtn.hidden = false;
                devBtn.addEventListener('click', handleDevLoginClick);
            }
        }
    } catch (err) {
        console.warn('Auth config probe failed:', err);
    }

    // If any future API call returns 401 (e.g., JWT expired), kick back to login.
    // We navigate via window.location to fully reset client state — an in-place
    // transition would leave streams, intervals, and IndexedDB state running.
    API.setOn401Handler(() => {
        // Skip if there's no active session — this would otherwise loop while
        // we're already on the login screen (e.g., a stray pre-auth request).
        if (!state.user) return;
        state.user = null;
        window.location.href = '/?error=session_expired';
    });

    // Handle redirect from the OAuth callback. If there was an error, show it.
    const callbackError = consumeAuthCallbackParams();

    // Check session via the non-throwing status endpoint.
    let authenticated = false;
    try {
        const status = await API.auth.status();
        if (status && status.authenticated) {
            state.user = status.user;
            authenticated = true;
        }
    } catch (err) {
        // status() should not normally throw, but if it does (network blip),
        // fall through to the login screen.
        console.warn('Auth status check failed:', err);
    }

    if (authenticated) {
        showApp();
        try {
            await init();
        } catch (err) {
            // Common causes: IndexedDB blocked in private browsing, a failing
            // server fetch in one of the parallel /api/* calls during init.
            // Hide the now-broken app shell and surface a diagnostic prompt on
            // the login screen.
            // Clear the auth cookie so the user isn't stuck in a loop: with the
            // cookie intact, refreshing or signing in again auto-resumes the
            // same broken session because Google OAuth re-grants the existing
            // consent silently. Clearing forces an explicit re-auth and makes
            // a persistent browser-data issue visible rather than cyclic.
            console.error('App initialization failed:', err);
            state.user = null;
            try {
                await API.auth.logout();
            } catch (logoutErr) {
                console.warn('Failed to clear session after init failure:', logoutErr);
            }
            showLoginScreen(OAUTH_ERROR_MESSAGES.init_failed);
        }
    } else {
        showLoginScreen(callbackError);
    }
}

// ===== Test seam (F-02) =====
// The single, DELIBERATE handle the frontend smoke harness reaches through
// (`tests/frontend-smoke.js`). It exists so the harness never depends on
// incidental globals: today everything in this file happens to be global, but
// after the module refactor (docs/REFACTOR_PLAN.md, R-00…R-05) nothing will be.
// Keeping the harness pointed at ONE seam means it survives the extraction
// unchanged — and a slice that forgets to wire something here fails loudly
// instead of silently losing coverage. Nothing secret lives here; the browser
// console already has the same reach.
window.__tessera = {
    get state() { return state; },
    get elements() { return elements; },
    API,
    // Actions the harness drives. Getters, not values, so they keep resolving
    // to the live implementation as these move between modules.
    get sendMessage() { return sendMessage; },
    get switchConversation() { return switchConversation; },
    get navigate() { return navigate; },
    get getActiveModelConfig() { return getActiveModelConfig; },
};

// ===== Start the App =====
document.addEventListener('DOMContentLoaded', bootstrap);
