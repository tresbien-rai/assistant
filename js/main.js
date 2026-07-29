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
    confirmDialog, closeConfirmDialog, promptName, closeNameModal, submitNameModal,
} from './components/dialogs.js';
import { displayError } from './components/errors.js';
import {
    escapeHtml, formatFileSize, formatBytes, formatTimeAgo,
    getFileCategory, getFileIcon, getFileTypeLabel,
} from './util/format.js';
import { FilePanel } from './file-panel/index.js';
import { navigate, currentSection, registerShell } from './shell.js';
import {
    PROVIDERS, providerIconHtml, findModelProvider, getModelDisplayName, getCatalogEntry,
    getActiveModelConfig, personaModelMode, applyModelToLayer, loadModelProfileIntoLayer,
    mirrorLayerToModelProfile, mergeModelConfig, getModelParamsForEdit, getParamByPath,
    setParamByPath, paramVisible, descByPath, fmtParamValue, formatNumber,
    updateSendButtonState,
} from './model-layer.js';

// Register this file's shell implementations with the seam, before anything can
// call through it. Function declarations hoist, so they are already defined.
// R-04b moves these three into js/router.js and this call goes with them.
registerShell({
    renderShell, renderMainView, updateUI,
    updateSettingsUI, renderModelsCatalog, refreshAddModelModal,
});

// ===== Conversation Helpers =====

/**
 * Create a new conversation server-side and set it as active.
 * The server generates the id — callers must await this.
 * @param {string} [title] - Optional title, defaults to "New Chat"
 * @returns {Promise<string>} The server-generated conversation ID
 */
async function createConversation(title = 'New Chat', container = null) {
    // Container is explicit (caller decides the home): the Chats tab creates
    // unfiled chats; the Workspaces drill-in creates workspace-/project-level
    // ones. The server derives workspace_id from a project. Persona is always
    // the currently-active one (P2-U3b model).
    const target = container || {};
    const created = await API.conversations.create({
        personaId: state.activePersonaId,
        projectId: target.projectId || null,
        workspaceId: target.workspaceId || null,
        title,
    });
    state.conversations[created.id] = {
        id: created.id,
        title: created.title,
        personaId: created.personaId,
        projectId: created.projectId,
        workspaceId: created.workspaceId,
        toolsEnabled: created.toolsEnabled ?? null,
        scratchpadEnabled: created.scratchpadEnabled ?? null,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        messageCount: 0,
        messages: [],
    };
    state.activeConversationId = created.id;

    // Apply a per-chat file-tools override chosen BEFORE the chat was persisted
    // (the toggle was flipped on a fresh, unsaved chat).
    if (state.pendingToolsOverride != null) {
        const override = state.pendingToolsOverride;
        state.pendingToolsOverride = undefined;
        state.conversations[created.id].toolsEnabled = override;
        try {
            await API.conversations.update(created.id, { toolsEnabled: override });
        } catch (err) {
            console.error('Failed to persist pending tools override:', err);
        }
    }

    return created.id;
}

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

/**
 * Create a new persona server-side and set it as active.
 * Server generates the id — callers must await this.
 * @param {string} [name] - Optional name, defaults to "Assistant"
 * @returns {Promise<string>} The server-generated persona ID
 */
async function createPersona(name = CONFIG.defaults.assistantName) {
    // New personas are pure skin: shared model mode, no pin. Engine settings
    // (params, prefill) live on model profiles, not here.
    const modelConfig = {};
    const expressions = { ...CONFIG.defaultExpressions };

    const created = await API.personas.create({
        name,
        systemPrompt: CONFIG.defaults.systemPrompt,
        prefill: '',
        expressions,
        modelConfig,
    });

    state.personas[created.id] = {
        id: created.id,
        name: created.name,
        tagline: created.tagline || '',
        roleLabel: created.roleLabel || '',
        systemPrompt: created.systemPrompt || '',
        prefill: created.prefill || '',
        avatarFilename: created.avatarFilename || '',
        expressions: (created.expressions && typeof created.expressions === 'object')
            ? created.expressions
            : expressions,
        modelConfig: (created.modelConfig && typeof created.modelConfig === 'object')
            ? created.modelConfig
            : modelConfig,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
    };
    state.activePersonaId = created.id;
    return created.id;
}

// ===== Model profiles: the parts that touch a conversation =====
// The profile machinery itself now lives in js/model-layer.js; what stays here
// is the conversation-facing edge of it.

/**
 * Restore a chat's model on open: the model that produced its last assistant
 * reply (per-message tag, WR-14) becomes the active model again, profile and
 * all — so coming back to a conversation keeps the engine it was running on.
 * Skipped when the chat's persona pins a model (fixed mode wins), when the
 * chat has no tagged replies yet, or when the tagged model is no longer in
 * the catalog. Requires convo.messages to be loaded.
 */
function restoreConversationModel(convo) {
    if (!convo || !Array.isArray(convo.messages)) return;
    if (personaModelMode(getActivePersona()) === 'fixed') return;
    const lastTagged = [...convo.messages].reverse()
        .find(m => m.role === 'assistant' && m.model);
    if (!lastTagged) return;
    const provider = findModelProvider(lastTagged.model);
    if (!provider) return; // removed from the catalog — keep the current model
    if (applyModelToLayer(provider, lastTagged.model)) {
        persistSettings();
    }
}

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

/**
 * Keep the active fixed persona's pin pointing at the layer's current model.
 * A model/provider switch made while a fixed persona is active re-pins it
 * (last-used auto-save, same spirit as pre-profiles WR-12). State-only;
 * persistSettings()'s savePersonas ride-along persists it.
 */
function updateFixedPersonaPin() {
    const persona = getActivePersona();
    if (!persona || personaModelMode(persona) !== 'fixed') return;
    const layer = getActiveModelConfig();
    const cfg = persona.modelConfig || {};
    // `modelParams` present = legacy full snapshot → rewrite to a slim pin.
    if (cfg.provider === layer.provider && cfg.model === layer.model && !cfg.modelParams) return;
    persona.modelConfig = { mode: 'fixed', provider: layer.provider, model: layer.model };
    persona.updatedAt = Date.now();
}

/**
 * Apply a persona's model-settings mode on activation: 'fixed' selects its
 * pinned model (loading that model's profile); 'shared' leaves the layer
 * untouched.
 */
function applyPersonaModelSettings(persona) {
    if (!persona || personaModelMode(persona) !== 'fixed') return;
    const pin = persona.modelConfig || {};
    if (!pin.provider || !pin.model) return;
    // One-time legacy migration: pre-profiles fixed personas snapshotted full
    // params. Seed the pinned model's profile from them (unless it already
    // has one), fold in the persona's old prefill, then slim to a pure pin.
    if (pin.modelParams) {
        const entry = getCatalogEntry(pin.provider, pin.model);
        if (entry && !entry.params) {
            entry.params = JSON.parse(JSON.stringify(pin.modelParams));
            if (persona.prefill && entry.params.prefill === undefined) {
                entry.params.prefill = persona.prefill;
            }
        }
        persona.modelConfig = { mode: 'fixed', provider: pin.provider, model: pin.model };
        persona.updatedAt = Date.now();
    }
    applyModelToLayer(pin.provider, pin.model);
    persistSettings();
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

/**
 * Persist all personas to the server.
 * Fire-and-forget by design: most callers are UI handlers that don't need to
 * block on the round-trip; failures are logged but don't surface in P0-15
 * (toast UX comes in P0-17). Runs the updates in parallel.
 */
function savePersonas() {
    const personas = Object.values(state.personas);
    Promise.all(personas.map(p =>
        API.personas.update(p.id, {
            name: p.name,
            tagline: p.tagline || '',
            roleLabel: p.roleLabel || '',
            systemPrompt: p.systemPrompt,
            prefill: p.prefill,
            // avatarFilename is INTENTIONALLY omitted. It's owned by the avatar
            // endpoints (POST/DELETE /api/personas/:id/avatar) — including it
            // here would let the client's in-memory '1' sentinel from
            // handleAvatarUpload clobber the server's real filename, breaking
            // the avatar permanently on the next GET.
            expressions: p.expressions,
            modelConfig: p.modelConfig,
        }).catch(err => {
            console.error(`Failed to persist persona ${p.id}:`, err);
        })
    ));
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

function hydratePersonas(personas) {
    state.personas = {};
    for (const p of (personas || [])) {
        // Server returns `expressions` as a parsed object. Backfill defaults
        // when it is missing OR an empty object. Server-created default
        // personas (e.g. the one made during the OAuth callback) have no
        // expressions, which the DAL JSON-parses to `{}`. An empty object is
        // truthy, so without the key-count check the persona would run with no
        // expressions and the UI would crash reading e.g. expressions.neutral.emoji.
        const hasExpressions = p.expressions
            && typeof p.expressions === 'object'
            && Object.keys(p.expressions).length > 0;
        const expressions = hasExpressions
            ? p.expressions
            : { ...CONFIG.defaultExpressions };
        // The generating slot must always exist — otherwise setExpression()
        // silently no-ops while the model works and the slot never appears in
        // the expression editor. Personas predating it get it backfilled.
        // Note this deliberately leaves any existing `thinking` entry alone:
        // it used to be this reserved slot, and now demotes to an ordinary
        // expression, art and all.
        if (!expressions[CONFIG.generatingExpression]) {
            expressions[CONFIG.generatingExpression] = { ...CONFIG.defaultExpressions.generating };
        }
        state.personas[p.id] = {
            id: p.id,
            name: p.name,
            tagline: p.tagline || '',
            roleLabel: p.roleLabel || '',
            systemPrompt: p.systemPrompt || '',
            prefill: p.prefill || '',
            avatarFilename: p.avatarFilename || '',
            expressions,
            // Model profiles: a persona's modelConfig is a slim pin
            // ({ mode:'fixed', provider, model }) or {} for shared. Kept raw —
            // legacy full snapshots keep their modelParams so
            // applyPersonaModelSettings can seed the pinned model's profile
            // once, then slims them down.
            modelConfig: (p.modelConfig && typeof p.modelConfig === 'object') ? p.modelConfig : {},
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
        };
    }
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

function hydrateApiKeyStatus(apiKeyStatus) {
    // Server returns [{ provider, hasKey, updatedAt }]. Map to per-provider.
    for (const entry of (apiKeyStatus || [])) {
        if (state.apiKeyStatus[entry.provider]) {
            state.apiKeyStatus[entry.provider] = {
                hasKey: !!entry.hasKey,
                updatedAt: entry.updatedAt || null,
            };
        }
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

/**
 * Lazy-load a conversation's full message history. Idempotent: if messages
 * are already loaded (or being loaded), returns without an extra fetch.
 */
async function loadConversationMessages(conversationId) {
    const convo = state.conversations[conversationId];
    if (!convo) return;
    if (convo.messages !== undefined) return; // already loaded
    try {
        const full = await API.conversations.get(conversationId);
        convo.messages = (full && full.messages) || [];
    } catch (err) {
        console.error(`Failed to load messages for ${conversationId}:`, err);
        convo.messages = []; // surface as empty rather than retry-storming
    }
}

// ===== Settings Management =====

// ===== Real-Time Auto-Save =====
// Debounces the settings PUT so a slider drag or a fast typist doesn't churn
// /api/settings. API keys have their own explicit save path now (saveProviderKey
// from the provider key popover), not this settings tick.
let autoSaveTimeout = null;

/**
 * Debounced auto-save function
 * Saves settings after 300ms of no changes to avoid excessive writes
 */
function autoSaveSettings() {
    if (autoSaveTimeout) {
        clearTimeout(autoSaveTimeout);
    }
    autoSaveTimeout = setTimeout(() => {
        saveAllSettingsFromUI();
        persistSettings();
    }, 300);
}

/**
 * Set the Models catalog "daily drivers" provider filter and persist it
 * (debounced). `providers` is an array of provider ids, or null/[] for "All" —
 * an empty selection normalises to null so the catalog never renders blank
 * (docs/MODELS_TAB_REDESIGN.md). Plumbing only in this slice; the provider
 * chips are the caller in a later slice.
 * @param {string[] | null} providers
 */
function saveCatalogProviders(providers) {
    state.settings.catalogProviders =
        Array.isArray(providers) && providers.length ? providers : null;
    autoSaveSettings();
}

/**
 * Collect all current UI values into state
 */
function saveAllSettingsFromUI() {
    const persona = getActivePersona();

    // The active model/provider are no longer read from UI selects (removed in
    // Slice 4) — they're maintained directly in the layer by selectModel /
    // applyModelToLayer (catalog cards). The API key is provider-owned and saved
    // straight from its popover (saveProviderKey), not via this settings tick.

    // Avatar visibility is read here; size/position are kept authoritative in
    // state by their own controls (presets, the size slider, and drag), so we
    // don't read the preset buttons — that would clobber a free value.
    state.settings.showAvatar = elements.showAvatar.checked;

    // Model params are edited in the per-model detail view (Slice 5), which
    // writes them straight into the profile. This tick still mirrors the active
    // layer to its profile (so a detail-view edit to the active model persists)
    // and re-pins a fixed persona to the current model.
    mirrorLayerToModelProfile();
    updateFixedPersonaPin();

    // Persona settings (name, system prompt — prefill lives in model params now)
    if (persona) {
        persona.name = elements.assistantName.value || CONFIG.defaults.assistantName;
        persona.tagline = elements.personaTagline.value.trim();
        persona.roleLabel = elements.personaRoleLabel.value.trim();
        persona.systemPrompt = elements.systemPrompt.value || CONFIG.defaults.systemPrompt;
        persona.updatedAt = Date.now();
    }
}

/**
 * Save a provider's API key to the server (explicit, from the provider key
 * popover). Optimistically flips apiKeyStatus.hasKey so the catalog badge / send
 * button unlock immediately; on failure, resyncs from the server and toasts.
 * The key value never lives in `state` — it goes straight to the API.
 * @param {string} provider
 * @param {string} value - the plaintext key (non-empty)
 */
async function saveProviderKey(provider, value) {
    if (!provider || !value) return;
    // Optimistic: reflect a saved key in the catalog + chips right away.
    state.apiKeyStatus[provider] = { ...state.apiKeyStatus[provider], hasKey: true };
    renderModelsCatalog();
    updateSendButtonState();
    try {
        const result = await API.apiKeys.set(provider, value);
        state.apiKeyStatus[provider] = {
            hasKey: true,
            updatedAt: (result && result.updatedAt) || Date.now(),
        };
    } catch (err) {
        console.error(`Failed to persist API key for ${provider}:`, err);
        // Resync so the optimistic hasKey doesn't mislead about what's saved.
        try {
            hydrateApiKeyStatus(await API.apiKeys.list());
        } catch (refetchErr) {
            console.error('Failed to refetch apiKeyStatus:', refetchErr);
        }
        displayError(err, { action: `save your ${provider} API key` });
    }
    renderModelsCatalog();
    refreshAddModelModal(); // the key popover can be opened from inside the modal
    updateSendButtonState();
}

/**
 * Explicit user-initiated delete of a provider's stored API key (from the
 * provider key popover). Confirms first because it's destructive.
 * @param {string} provider
 */
async function clearStoredApiKey(provider) {
    if (!provider || !state.apiKeyStatus[provider]?.hasKey) return;

    const ok = await confirmDialog({
        title: 'Clear stored API key?',
        body: `Your saved ${provider} key will be removed from the server. You'll need to re-enter it before you can chat.`,
        confirmLabel: 'Clear key',
        danger: true,
    });
    if (!ok) return;

    try {
        await API.apiKeys.delete(provider);
    } catch (err) {
        console.error(`Failed to delete API key for ${provider}:`, err);
        displayError(err, { action: 'clear the saved key' });
        return;
    }

    state.apiKeyStatus[provider] = { hasKey: false, updatedAt: Date.now() };
    renderModelsCatalog(); // refresh the group-header badge + chip dot
    refreshAddModelModal();
    updateSendButtonState();
}

/**
 * Persist non-API-key settings (avatar prefs, customModels) AND the active
 * persona. Fire-and-forget; the auto-save debounce coalesces frequent edits.
 */
function persistSettings() {
    const settingsPayload = {
        avatarSize: state.settings.avatarSize,
        avatarPosition: state.settings.avatarPosition,
        showAvatar: state.settings.showAvatar,
        activeFileTurns: state.settings.activeFileTurns,
        customModels: state.settings.customModels,
        currentModelConfig: state.currentModelConfig, // the active layer (WR-12)
        catalogProviders: state.settings.catalogProviders, // Models catalog filter
    };
    API.settings.update(settingsPayload).catch(err => {
        console.error('Failed to persist settings:', err);
    });
    // Persona edits ride along on the same auto-save tick.
    if (getActivePersona()) {
        savePersonas();
    }
    updateSettingsUI();
}

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
 * Persist conversation metadata for the active conversation (title, personaId).
 * Fire-and-forget. Per-message persistence is NOT handled here — see
 * persistMessage() for that path. Most call sites just want "I tweaked the
 * conversation; flush it" and that's what this does.
 */
function saveConversations() {
    const id = state.activeConversationId;
    if (!id) return;
    const convo = state.conversations[id];
    if (!convo) return;
    API.conversations.update(id, {
        title: convo.title,
        personaId: convo.personaId,
    }).catch(err => {
        console.error(`Failed to persist conversation ${id}:`, err);
    });
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

/** Render one param control from its descriptor + current value. */
function renderParamControl(d, params) {
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
function renderModelDetail(provider, modelId) {
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
function wireParamControls(panel, provider, modelId, params, isActive) {
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
function renderModelsView() {
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
 * Remove a custom model from its provider's catalog.
 * @param {string} id - The model ID to remove
 * @param {string} provider - The provider that owns it (the catalog card knows it)
 */
function removeCustomModel(id, provider) {
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
function saveCustomModels() {
    API.settings.update({ customModels: state.settings.customModels }).catch(err => {
        console.error('Failed to persist custom models:', err);
    });
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
 * The provider the add-model modal is currently working on. Set from the modal's
 * chip row; every operation in the modal (fetch, manual add) is scoped to it.
 * Before Slice 7 the modal silently used the *active model's* provider, which
 * made adding a model for any other provider unreachable.
 */
let modelModalProvider = null;

/**
 * Provider chips inside the add-model modal — single-select, unlike the
 * catalog's multi-select filter chips (hence `.single` + role=radio).
 * `status: 'soon'` providers are shown but not selectable.
 */
function renderModelModalProviders() {
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
function selectModalProvider(provider) {
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
function renderFetchSection() {
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
function refreshAddModelModal() {
    if (!elements.modelModal?.classList.contains('visible')) return;
    renderModelModalProviders();
}

/**
 * Open the add-model modal.
 * @param {string} [provider] - Preselect this provider (a catalog group's
 *   "+ Add"); defaults to the active model's provider.
 */
function openModelModal(provider) {
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

/**
 * Back-compat shim: the old sidebar tabs ('chats' / 'projects') map to the
 * WR-07 main-area router sections.
 * @param {string} tabName - 'chats' or 'projects'
 */
function switchTab(tabName) {
    navigate({ type: tabName === 'projects' ? 'workspaces' : 'chats' });
}

/**
 * Inner avatar markup (img or emoji) for a persona. Shared by the persona-
 * grouped chat list and the workspace chat rows.
 * @param {Object} persona
 * @returns {string}
 */
function personaAvatarHTML(persona) {
    if (!persona) return `<span class="avatar-emoji">🤖</span>`;
    if (persona.avatarFilename) {
        // Cache-bust by updatedAt so a re-upload is reflected immediately.
        const cacheBust = persona.updatedAt ? `?v=${persona.updatedAt}` : '';
        const imageUrl = `${API.avatars.getUrl(persona.id)}${cacheBust}`;
        return `<img src="${imageUrl}" alt="${escapeHtml(persona.name || '')}">`;
    }
    const firstExpr = Object.values(persona.expressions || {})[0];
    const avatarEmoji = firstExpr?.emoji || '🤖';
    return `<span class="avatar-emoji">${avatarEmoji}</span>`;
}

/**
 * Markup for a single conversation row. `showPersonaAvatar` adds the owning
 * persona's avatar (used in the workspace list where personas are mixed; the
 * home list shows the avatar on the group header instead).
 * @param {Object} convo
 * @param {boolean} showPersonaAvatar
 * @returns {string}
 */
function conversationRowHTML(convo, showPersonaAvatar) {
    const timeAgo = formatTimeAgo(convo.updatedAt || convo.createdAt);
    const active = convo.id === state.activeConversationId ? 'active' : '';
    const avatar = showPersonaAvatar
        ? `<div class="conversation-persona-avatar">${personaAvatarHTML(state.personas[convo.personaId])}</div>`
        : '';
    return `
        <div class="conversation-item ${active}" data-conversation-id="${convo.id}">
            ${avatar}
            <div class="conversation-info" data-conversation-id="${convo.id}">
                <span class="conversation-title">${escapeHtml(convo.title || 'New Chat')}</span>
                <span class="conversation-time">${timeAgo}</span>
            </div>
            <button class="conversation-menu-btn" data-conversation-id="${convo.id}" title="Options">⋯</button>
        </div>
    `;
}

/**
 * Wire click + menu listeners for all conversation rows currently in `container`.
 * @param {HTMLElement} container
 */
function wireConversationRows(container) {
    container.querySelectorAll('.conversation-info').forEach(info => {
        info.addEventListener('click', () => switchConversation(info.dataset.conversationId));
    });
    container.querySelectorAll('.conversation-menu-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            showConversationMenu(btn, btn.dataset.conversationId);
        });
    });
}

/**
 * Refresh the chats list if it's the view currently showing in the main area.
 * (WR-07: the unfiled chat list lives in the main area, not the sidebar; many
 * callers poke this after a conversation mutation, so it no-ops when a different
 * view is open.)
 */
function renderConversationList() {
    if ((state.ui.mainView || {}).type === 'chats') renderChatsListMain();
}

/**
 * Home ("Chats") view: only UNFILED chats — those not in any workspace or
 * project — grouped by persona under collapsible headers ("chats with X").
 * Workspace/project chats live in their own container, never here (Workspace
 * Restructure: a chat appears in exactly one home, no cross-container leakage).
 * The active persona's group sorts first, the rest by most-recent activity.
 * @param {HTMLElement} container
 */
function renderGroupedChatList(container) {
    const all = Object.values(state.conversations)
        .filter(c => !c.projectId && !c.workspaceId);

    if (all.length === 0) {
        container.innerHTML = `<p class="empty-state small">No chats yet. Start a new one above.</p>`;
        return;
    }

    // Group conversations by persona, tracking each group's latest activity.
    const groups = new Map(); // personaId -> { convos: [], latest }
    for (const c of all) {
        const pid = c.personaId || '__none__';
        if (!groups.has(pid)) groups.set(pid, { convos: [], latest: 0 });
        const g = groups.get(pid);
        g.convos.push(c);
        g.latest = Math.max(g.latest, c.updatedAt || c.createdAt || 0);
    }

    // Order: active persona first, then by most-recent activity.
    const ordered = [...groups.entries()].sort((a, b) => {
        if (a[0] === state.activePersonaId) return -1;
        if (b[0] === state.activePersonaId) return 1;
        return b[1].latest - a[1].latest;
    });

    let html = '';
    for (const [pid, g] of ordered) {
        const persona = state.personas[pid];
        const name = persona ? (persona.name || 'Untitled') : 'No persona';
        const collapsed = state.ui.collapsedPersonaGroups.has(pid);
        const rows = g.convos
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            .map(c => conversationRowHTML(c, false))
            .join('');
        html += `
            <div class="persona-group" data-persona-id="${escapeHtml(pid)}">
                <button class="persona-group-header" data-persona-id="${escapeHtml(pid)}" type="button">
                    <svg class="group-chevron ${collapsed ? 'collapsed' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
                    <div class="conversation-persona-avatar">${personaAvatarHTML(persona)}</div>
                    <span class="persona-group-name">${escapeHtml(name)}</span>
                    <span class="persona-group-count">${g.convos.length}</span>
                </button>
                <div class="persona-group-body" ${collapsed ? 'hidden' : ''}>${rows}</div>
            </div>
        `;
    }
    container.innerHTML = html;

    // Collapse/expand on header click.
    container.querySelectorAll('.persona-group-header').forEach(header => {
        header.addEventListener('click', () => {
            const pid = header.dataset.personaId;
            if (state.ui.collapsedPersonaGroups.has(pid)) {
                state.ui.collapsedPersonaGroups.delete(pid);
            } else {
                state.ui.collapsedPersonaGroups.add(pid);
            }
            renderConversationList();
        });
    });

    wireConversationRows(container);
}

/**
 * Switch to a different conversation. Lazy-loads its messages on first
 * access — without this, renderConversation crashes on `messages.length`
 * because hydrateConversations seeds messages=undefined as a "not loaded"
 * sentinel for non-active conversations.
 * @param {string} conversationId
 */
async function switchConversation(conversationId) {
    if (!state.conversations[conversationId]) return;

    state.activeConversationId = conversationId;

    // Track the chat's container so breadcrumb + restore have context.
    const convo = state.conversations[conversationId];
    state.activeProjectId = convo.projectId || null;
    state.activeWorkspaceId = convo.workspaceId || (convo.projectId && state.projects[convo.projectId] ? state.projects[convo.projectId].workspaceId : null) || null;

    // Also switch to the persona that owns this conversation. activePersonaId
    // is session state — not persisted server-side — so no savePersonas() call
    // is needed (and including one would also re-PUT every persona, wasting
    // bandwidth and risking cross-write clobbers).
    if (convo.personaId && convo.personaId !== state.activePersonaId) {
        state.activePersonaId = convo.personaId;
        // A fixed-mode persona brings its own model settings along (WR-12).
        applyPersonaModelSettings(getActivePersona());
    }

    // Lazy-load messages if this is the first time we're activating this
    // conversation in the session.
    await loadConversationMessages(conversationId);

    // The chat also remembers its engine: reactivate the model that wrote its
    // last reply (unless the persona above pinned one — fixed mode wins).
    restoreConversationModel(convo);

    navigate({ type: 'chat', id: conversationId });
    updateUI();
}

/**
 * Show context menu for a conversation
 * @param {HTMLElement} anchorEl - The button that was clicked
 * @param {string} conversationId
 */
function showConversationMenu(anchorEl, conversationId) {
    // Remove any existing menu
    const existingMenu = document.querySelector('.context-menu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = `
        <button class="context-menu-item" data-action="rename">Rename</button>
        <button class="context-menu-item danger" data-action="delete">Delete</button>
    `;

    // Position the menu
    const rect = anchorEl.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${rect.left - 80}px`;

    document.body.appendChild(menu);

    // Handle menu item clicks
    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', () => {
            const action = item.dataset.action;
            menu.remove();

            if (action === 'rename') {
                renameConversationPrompt(conversationId);
            } else if (action === 'delete') {
                deleteConversationPrompt(conversationId);
            }
        });
    });

    // Close menu on outside click
    setTimeout(() => {
        document.addEventListener('click', function closeMenu(e) {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        });
    }, 0);
}

/**
 * Prompt to rename a conversation
 * @param {string} conversationId
 */
async function renameConversationPrompt(conversationId) {
    const convo = state.conversations[conversationId];
    if (!convo) return;

    const newTitle = await promptName({
        title: 'Rename chat',
        label: 'Chat name',
        value: convo.title || 'New Chat',
        confirmLabel: 'Rename',
    });
    if (!newTitle) return;

    // Prompting is async now — the chat may have been deleted meanwhile.
    if (!state.conversations[conversationId]) return;

    convo.title = newTitle;
    convo.updatedAt = Date.now();
    saveConversations();
    renderConversationList();
}

/**
 * Prompt to delete a conversation. Server delete first (so the local state
 * never goes out of sync with the server on failure), then local cleanup.
 * @param {string} conversationId
 */
async function deleteConversationPrompt(conversationId) {
    const convo = state.conversations[conversationId];
    if (!convo) return;

    const ok = await confirmDialog({
        title: 'Delete chat?',
        body: `"${convo.title || 'New Chat'}" and all of its messages will be deleted. This can't be undone.`,
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;

    try {
        await API.conversations.delete(conversationId);
    } catch (err) {
        console.error('Failed to delete conversation:', err);
        displayError(err, { action: 'delete conversation' });
        return;
    }

    delete state.conversations[conversationId];

    // If we deleted the active conversation, switch to another or clear.
    if (state.activeConversationId === conversationId) {
        const remaining = Object.values(state.conversations);
        if (remaining.length > 0) {
            const mostRecent = remaining.reduce((a, b) =>
                (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a
            );
            state.activeConversationId = mostRecent.id;
            // Lazy-load the newly-active conversation's messages.
            await loadConversationMessages(state.activeConversationId);
        } else {
            state.activeConversationId = null;
        }
    }

    renderConversationList();
    renderConversation();
}

/**
 * Create a new conversation and switch to it
 */
async function startNewConversation() {
    try {
        await createConversation('New Chat');
    } catch (err) {
        console.error('Failed to create conversation:', err);
        return;
    }
    state.activeProjectId = null;
    state.activeWorkspaceId = null;
    navigate({ type: 'chat', id: state.activeConversationId });
}

/**
 * Switch the active persona (from the top-bar persona popover). With the home
 * chat list grouped by persona, this just sets the active persona, makes sure
 * its group is expanded, and shows the home view scrolled to that group.
 * @param {string} personaId
 */
async function switchPersona(personaId) {
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
    await switchTab('chats');

    const groupEl = document.querySelector(`.persona-group[data-persona-id="${CSS.escape(personaId)}"]`);
    if (groupEl) groupEl.scrollIntoView({ block: 'nearest' });
}

/**
 * Edit a persona - switch to it and open settings tab
 * @param {string} personaId
 */
function editPersona(personaId) {
    if (!state.personas[personaId]) return;

    state.activePersonaId = personaId;
    applyPersonaModelSettings(getActivePersona()); // fixed mode loads its settings
    savePersonas();
    updateUI();
    navigate({ type: 'persona-edit' });
}

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

function selectModel(modelId, provider) {
    const layer = getActiveModelConfig();
    if (!applyModelToLayer(provider || layer.provider, modelId)) return;
    updateFixedPersonaPin();
    persistSettings();
    updateUI();
}

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

/**
 * Top-bar persona button popover: edit the current persona, create a new one,
 * or jump to another persona's chats. Switching does NOT reassign the current
 * conversation — see docs/PHASE2_UX_DESIGN.md.
 * @param {HTMLElement} anchorEl
 */
function showPersonaPopover(anchorEl) {
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

    // Local cleanup mirrors the server cascade.
    linkedConvos.forEach(convo => {
        delete state.conversations[convo.id];
    });
    delete state.personas[personaId];

    // If we deleted the active persona, switch to another.
    if (state.activePersonaId === personaId) {
        const remaining = Object.values(state.personas);
        state.activePersonaId = remaining.length > 0 ? remaining[0].id : null;
        applyPersonaModelSettings(getActivePersona()); // fixed mode loads its settings
    }

    // Clear active conversation if it was deleted by the cascade.
    if (state.activeConversationId && !state.conversations[state.activeConversationId]) {
        state.activeConversationId = null;
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

// ===== Workspace/project row helpers (shared by the main-area lists + pages) =====

const byUpdatedDesc = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);

function workspaceRowHTML(w) {
    const pc = w.projectCount || 0;
    const fc = w.fileCount || 0;
    const meta = `${pc} project${pc !== 1 ? 's' : ''} · ${fc} file${fc !== 1 ? 's' : ''}`;
    return `
        <div class="project-item" data-workspace-id="${w.id}">
            <div class="project-info ws-info" data-workspace-id="${w.id}">
                <span class="project-name">${escapeHtml(w.name || 'Untitled workspace')}</span>
                <span class="project-meta">${meta}</span>
            </div>
            <button class="project-menu-btn ws-menu-btn" data-workspace-id="${w.id}" title="Options">⋯</button>
        </div>
    `;
}

function projectRowHTML(p) {
    const count = p.fileCount || 0;
    const meta = `${count} file${count !== 1 ? 's' : ''}`;
    return `
        <div class="project-item" data-project-id="${p.id}">
            <div class="project-info" data-project-id="${p.id}">
                <span class="project-name">${escapeHtml(p.name || 'Untitled project')}</span>
                <span class="project-meta">${meta}</span>
            </div>
            <button class="project-menu-btn" data-project-id="${p.id}" title="Options">⋯</button>
        </div>
    `;
}

/**
 * Show the context menu for a project (Edit / Delete).
 * @param {HTMLElement} anchorEl
 * @param {string} projectId
 */
function showProjectMenu(anchorEl, projectId) {
    const existingMenu = document.querySelector('.context-menu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = `
        <button class="context-menu-item" data-action="edit">Edit</button>
        <button class="context-menu-item danger" data-action="delete">Delete</button>
    `;

    const rect = anchorEl.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${rect.left - 80}px`;

    document.body.appendChild(menu);

    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', () => {
            const action = item.dataset.action;
            menu.remove();
            if (action === 'edit') {
                editProject(projectId);
            } else if (action === 'delete') {
                deleteProjectPrompt(projectId);
            }
        });
    });

    setTimeout(() => {
        document.addEventListener('click', function closeMenu(e) {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        });
    }, 0);
}

/**
 * Create a new project (name-only step) nested under the given workspace, then
 * open its inline page so the user can fill in instructions/files.
 * @param {string} workspaceId - The owning workspace (defaults to the active one)
 */
async function startNewProjectIn(workspaceId) {
    const wsId = workspaceId || state.activeWorkspaceId || null;
    const name = await promptName({
        title: 'New project',
        label: 'Project name',
        placeholder: 'e.g., Q3 launch',
    });
    if (!name) return;

    let created;
    try {
        created = await API.projects.create({ name, workspaceId: wsId || undefined });
    } catch (err) {
        console.error('Failed to create project:', err);
        displayError(err, { action: 'create project' });
        return;
    }
    state.projects[created.id] = {
        id: created.id,
        workspaceId: created.workspaceId || null,
        name: created.name,
        instructions: created.instructions || '',
        fileCount: created.fileCount || 0,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
    };
    openContainerPage('project', created.id);
}

/**
 * Open a project's inline page to edit its name/instructions/files.
 * @param {string} projectId
 */
function editProject(projectId) {
    if (!state.projects[projectId]) return;
    openContainerPage('project', projectId);
}

/**
 * Confirm and delete a project. The backend moves its Drive folder to the trash
 * (recoverable) and removes the DB rows. Conversations that referenced the
 * project keep working — they just stop receiving its context.
 * @param {string} projectId
 */
async function deleteProjectPrompt(projectId) {
    const project = state.projects[projectId];
    if (!project) return;

    const count = project.fileCount || 0;
    let body = `"${project.name}" will be deleted.`;
    if (count > 0) {
        body += ` Its ${count} file${count !== 1 ? 's' : ''} will be moved to your Google Drive trash.`;
    }
    body += ' Chats in this project will keep working, but without its context.';

    const ok = await confirmDialog({
        title: 'Delete project?',
        body,
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;

    try {
        await API.projects.delete(projectId);
    } catch (err) {
        console.error('Failed to delete project:', err);
        displayError(err, { action: 'delete project' });
        return;
    }

    delete state.projects[projectId];

    // If we're viewing the deleted project's page, climb to its workspace.
    const v = state.ui.mainView || {};
    if (v.type === 'project' && v.id === projectId) {
        backToWorkspace();
    } else {
        renderMainView(); // refresh any list/page that showed it
        renderShell();
    }
}

// ===== Workspace create + edit =====
// Name + shared instructions + reference files are all edited inline on the
// workspace page (renderContainerPage). Creation is a name-only step that lands
// on that page.

/**
 * Create a new workspace (name-only step), then open its inline page so the user
 * can fill in shared instructions and add reference files.
 */
async function startNewWorkspace() {
    const name = await promptName({
        title: 'New workspace',
        label: 'Workspace name',
        placeholder: 'e.g., Vibe Coding',
    });
    if (!name) return;

    let created;
    try {
        created = await API.workspaces.create({ name });
    } catch (err) {
        console.error('Failed to create workspace:', err);
        displayError(err, { action: 'create workspace' });
        return;
    }
    state.workspaces[created.id] = {
        id: created.id,
        name: created.name,
        instructions: created.instructions || '',
        projectCount: created.projectCount || 0,
        fileCount: created.fileCount || 0,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
    };
    openContainerPage('workspace', created.id);
}

/**
 * Open a workspace's inline page to edit its name/instructions/files.
 * @param {string} workspaceId
 */
function editWorkspace(workspaceId) {
    if (!state.workspaces[workspaceId]) return;
    openContainerPage('workspace', workspaceId);
}

/**
 * Confirm and delete a workspace. The backend trashes its Drive folder (and
 * nested projects/files) and reparents its chats to unfiled (kept).
 * @param {string} workspaceId
 */
async function deleteWorkspacePrompt(workspaceId) {
    const ws = state.workspaces[workspaceId];
    if (!ws) return;

    const pc = ws.projectCount || 0;
    const fc = ws.fileCount || 0;
    let body = `"${ws.name}" will be deleted.`;
    if (pc > 0 || fc > 0) {
        body += ` Its ${pc} project${pc !== 1 ? 's' : ''} and ${fc} file${fc !== 1 ? 's' : ''} will be moved to your Google Drive trash.`;
    }
    body += ' Chats in this workspace become unfiled — kept, but without its context.';

    const ok = await confirmDialog({
        title: 'Delete workspace?',
        body,
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;

    try {
        await API.workspaces.delete(workspaceId);
    } catch (err) {
        console.error('Failed to delete workspace:', err);
        displayError(err, { action: 'delete workspace' });
        return;
    }

    // Mirror the server-side cascade locally: projects gone, chats unfiled.
    delete state.workspaces[workspaceId];
    for (const pid of Object.keys(state.projects)) {
        if (state.projects[pid].workspaceId === workspaceId) delete state.projects[pid];
    }
    for (const c of Object.values(state.conversations)) {
        if (c.workspaceId === workspaceId) {
            c.workspaceId = null;
            c.projectId = null;
        }
    }

    // If we're viewing this workspace's page (or one of its now-deleted
    // projects' pages), drop back to the workspaces list.
    const v = state.ui.mainView || {};
    const viewingDeleted =
        (v.type === 'workspace' && v.id === workspaceId) ||
        (v.type === 'project' && !state.projects[v.id]);

    if (state.activeWorkspaceId === workspaceId) {
        state.activeWorkspaceId = null;
        state.activeProjectId = null;
        UiPrefs.set('activeWorkspace', null);
        UiPrefs.set('activeProject', null);
    }

    if (viewingDeleted) {
        navigate({ type: 'workspaces' });
    } else {
        renderMainView();
        renderShell();
    }
}

// ===== Breadcrumb + container navigation (WR-07) =====
// The hierarchy is workspace ⊃ project ⊃ chat. activeWorkspaceId/activeProjectId
// track the container the current view is about (set by openContainerPage and on
// opening a chat) — used for restore and for where "New chat/project" land.

const BREADCRUMB_FOLDER_SVG = '<svg class="breadcrumb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>';

/** Shell-only refresh (rail highlight + contextual top bar + breadcrumb). */
function updateWorkspaceUI() {
    renderShell();
}

/**
 * Render the top-bar breadcrumb for the OPEN CHAT's container: "Chats" (unfiled)
 * / "<Workspace>" / "<Workspace> › <Project>". Shown only while a chat is open
 * (renderTopBar toggles visibility); segments navigate the main-area router.
 */
function renderBreadcrumb() {
    const el = elements.workspaceBreadcrumb;
    if (!el) return;

    const v = state.ui.mainView || {};
    const convo = v.type === 'chat' ? state.conversations[v.id] : null;
    if (!convo) { el.innerHTML = ''; el.classList.remove('active'); return; }

    const workspace = convo.workspaceId ? state.workspaces[convo.workspaceId] : null;
    const project = convo.projectId ? state.projects[convo.projectId] : null;

    let html = '';
    if (!workspace && !project) {
        html = `<span class="breadcrumb-seg" data-nav="chats">${BREADCRUMB_FOLDER_SVG}<span>Chats</span></span>`;
    } else {
        html = `<span class="breadcrumb-seg" data-nav="workspace">${BREADCRUMB_FOLDER_SVG}<span>${escapeHtml(workspace ? (workspace.name || 'Untitled workspace') : 'Workspace')}</span></span>`;
        if (project) {
            html += `<span class="breadcrumb-sep" aria-hidden="true">›</span>`;
            html += `<span class="breadcrumb-seg" data-nav="project"><span>${escapeHtml(project.name || 'Untitled project')}</span></span>`;
        }
    }
    el.innerHTML = html;
    el.classList.toggle('active', !!(workspace || project));

    el.querySelectorAll('[data-nav]').forEach(seg => {
        seg.addEventListener('click', () => {
            const nav = seg.dataset.nav;
            if (nav === 'project' && project) navigate({ type: 'project', id: project.id });
            else if (nav === 'workspace' && workspace) navigate({ type: 'workspace', id: workspace.id });
            else navigate({ type: 'chats' });
        });
    });
}

/** Open a workspace's page (its instructions/files/projects/chats). */
function enterWorkspace(workspaceId) {
    openContainerPage('workspace', workspaceId);
}

/** Open a project's page (its instructions/files/chats). */
function enterProject(projectId) {
    openContainerPage('project', projectId);
}

/** From a project, go up to its workspace page (or the workspaces list). */
function backToWorkspace() {
    if (state.activeWorkspaceId && state.workspaces[state.activeWorkspaceId]) {
        openContainerPage('workspace', state.activeWorkspaceId);
    } else {
        navigate({ type: 'workspaces' });
    }
}

/** Go to the workspaces list. */
function backToWorkspaces() {
    state.activeProjectId = null;
    state.activeWorkspaceId = null;
    UiPrefs.set('activeProject', null);
    UiPrefs.set('activeWorkspace', null);
    navigate({ type: 'workspaces' });
}

/**
 * Create a chat in the container of the current view (a workspace or project
 * page → workspace-/project-level; otherwise unfiled), then open it.
 */
async function startNewChatInContainer() {
    const v = state.ui.mainView || {};
    let container = null;
    if (v.type === 'project') container = { projectId: v.id };
    else if (v.type === 'workspace') container = { workspaceId: v.id };

    try {
        await createConversation('New Chat', container);
    } catch (err) {
        console.error('Failed to create conversation:', err);
        displayError(err, { action: 'create chat' });
        return;
    }
    navigate({ type: 'chat', id: state.activeConversationId });
}

/**
 * Context menu for a workspace row (Edit / Delete).
 * @param {HTMLElement} anchorEl
 * @param {string} workspaceId
 */
function showWorkspaceContextMenu(anchorEl, workspaceId) {
    const existing = document.querySelector('.context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = `
        <button class="context-menu-item" data-action="edit">Edit</button>
        <button class="context-menu-item danger" data-action="delete">Delete</button>
    `;

    positionPopover(menu, anchorEl, 'left');

    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', () => {
            menu.remove();
            if (item.dataset.action === 'edit') {
                editWorkspace(workspaceId);
            } else if (item.dataset.action === 'delete') {
                deleteWorkspacePrompt(workspaceId);
            }
        });
    });

    attachPopoverOutsideClose(menu, anchorEl);
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

/**
 * Back-compat shim. Older call sites call renderConversation() to mean "repaint
 * the main area"; route them through the view dispatcher (+ shell) so the rail
 * and top bar stay in sync.
 */
function renderConversation() {
    renderShell();
    renderMainView();
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

/** Main-area "Chats" section: unfiled chats grouped by persona + a New-chat action. */
function renderChatsListMain() {
    const c = elements.messagesContainer;
    c.innerHTML = `
        <div class="section-view">
            <div class="section-head">
                <h1 class="section-title">Chats</h1>
                <button class="section-new-btn" id="chatsNewBtn" type="button">+ New chat</button>
            </div>
            <div class="section-list" id="chatsListBody"></div>
        </div>`;
    renderGroupedChatList(c.querySelector('#chatsListBody'));
    const nb = c.querySelector('#chatsNewBtn');
    if (nb) nb.addEventListener('click', startNewConversation);
}

/** Main-area "Workspaces" section: the list of workspaces + a New-workspace action. */
function renderWorkspacesListMain() {
    const c = elements.messagesContainer;
    const workspaces = Object.values(state.workspaces).sort(byUpdatedDesc);
    const list = workspaces.length
        ? `<div class="drill-list">${workspaces.map(workspaceRowHTML).join('')}</div>`
        : `<p class="empty-state small">No workspaces yet. Create one to group projects and share instructions + files.</p>`;
    c.innerHTML = `
        <div class="section-view">
            <div class="section-head">
                <h1 class="section-title">Workspaces</h1>
                <button class="section-new-btn" id="wsNewBtn" type="button">+ New workspace</button>
            </div>
            ${list}
        </div>`;
    const nb = c.querySelector('#wsNewBtn');
    if (nb) nb.addEventListener('click', startNewWorkspace);
    c.querySelectorAll('.ws-info[data-workspace-id]').forEach(el =>
        el.addEventListener('click', () => navigate({ type: 'workspace', id: el.dataset.workspaceId })));
    c.querySelectorAll('.ws-menu-btn[data-workspace-id]').forEach(btn =>
        btn.addEventListener('click', (e) => { e.stopPropagation(); showWorkspaceContextMenu(btn, btn.dataset.workspaceId); }));
}

/**
 * Main-area "Personas" section: a character-select grid of portrait tiles —
 * large 1:1 avatar, name, optional role chip, and the persona's tagline. Click
 * a tile to make it active (stays here); the ⋯ menu edits (→ persona editor)
 * or deletes. The top-bar persona popover still handles quick-switch.
 */
function renderPersonasListMain() {
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

/**
 * Provider chips above the Models catalog (Layout B, Models tab redesign): an
 * "All" chip plus one per provider. The chips are the writer for the "daily
 * drivers" filter (state.settings.catalogProviders) — multi-select, "All" =
 * show every provider. A status dot shows API-key presence; 'soon' providers
 * render disabled. See docs/MODELS_TAB_REDESIGN.md.
 */
function renderProviderChips() {
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
function toggleProviderChip(chip) {
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
function renderModelsCatalog() {
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
function showProviderKeyPopover(anchorEl, provider) {
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
function showModelCardMenu(anchorEl, modelId, provider) {
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

/** Make a persona active from the Personas section (stays on the section). */
function activatePersona(personaId) {
    if (!state.personas[personaId]) return;
    state.activePersonaId = personaId;
    applyPersonaModelSettings(getActivePersona()); // fixed mode loads its settings
    savePersonas();
    updateUI(); // refreshes the section (Active badge) + header
}

/** Per-card context menu on the Personas section: Edit (→ Settings) / Delete. */
// ===== Persona export / import (`.tessera` bundles) =====
// A bundle is one self-contained JSON file: persona text plus its art inlined
// as base64. Built in the browser rather than on the server because <canvas>
// gives us resizing and WebP encoding for free — doing it server-side would
// mean adding a native image library (sharp) for what the browser already has.

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

// `blobToBase64` used to be declared here as well as further down (~line 9390).
// Two top-level function declarations of the same name are legal in a classic
// script — the later one silently wins — so this copy was already dead code and
// every caller, including the exporter below, has always run the other one. A
// module is strict, where the duplicate is a hard SyntaxError, so this copy is
// gone. No behaviour change: the surviving implementation is unmodified.

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
        showToast(`Exported ${filename} (${formatBytes(json.length)})`, { type: 'success' });
    } catch (err) {
        console.error('Failed to export persona:', err);
        displayError(err, { action: 'export this persona' });
    }
}

/**
 * Trigger a browser download for a blob.
 * @param {Blob} blob
 * @param {string} filename
 */
function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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

// ===== Inline container pages (workspace / project) =====
// A workspace/project page is a main-area router view (WR-07): renderMainView
// calls renderContainerPage for mainView {type:'workspace'|'project'}. The page
// edits name + instructions + files inline and lists the container's projects/
// chats. Entry points: the workspaces list, the in-chat breadcrumb, the project
// rows, and the name-only create step (which lands here after creating).

const CONTAINER_FOLDER_SVG = '<svg class="cp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>';
const CONTAINER_UPLOAD_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';

function openContainerPage(kind, id) {
    if (kind === 'workspace') {
        if (!state.workspaces[id]) return;
        state.activeWorkspaceId = id;
        state.activeProjectId = null;
        UiPrefs.set('activeWorkspace', id);
        UiPrefs.set('activeProject', null);
    } else {
        const project = state.projects[id];
        if (!project) return;
        state.activeProjectId = id;
        state.activeWorkspaceId = project.workspaceId || null;
        UiPrefs.set('activeProject', id);
        UiPrefs.set('activeWorkspace', state.activeWorkspaceId);
    }
    navigate({ type: kind, id });
}

/**
 * Render the inline container page (workspace or project) into the main area.
 * @param {'workspace'|'project'} kind
 * @param {string} id
 */
function renderContainerPage(kind, id) {
    const isWs = kind === 'workspace';
    const entity = isWs ? state.workspaces[id] : state.projects[id];
    if (!entity) return;
    const workspace = isWs ? entity : state.workspaces[entity.workspaceId];

    // Breadcrumb row at the top of the page (climbs out of the page).
    const crumbs = isWs
        ? `<span class="cp-crumb" data-nav="workspaces">‹ Workspaces</span>`
        : `<span class="cp-crumb" data-nav="workspace">‹ ${escapeHtml(workspace ? (workspace.name || 'Workspace') : 'Workspace')}</span>`;

    const instrPlaceholder = isWs
        ? 'Shared context injected into every chat in this workspace and its projects (optional).'
        : 'Context injected into every chat in this project — on top of its workspace (optional).';

    const inheritNote = (!isWs && workspace)
        ? `<p class="cp-inherit-note">Inherits <strong>${escapeHtml(workspace.name || 'workspace')}</strong> context (its instructions + files apply here too).</p>`
        : '';

    const listsHTML = isWs
        ? containerProjectsListHTML(entity) + containerChatsListHTML(kind, entity)
        : containerChatsListHTML(kind, entity);

    elements.messagesContainer.innerHTML = `
        <div class="container-page" data-kind="${kind}" data-id="${escapeHtml(id)}">
            <div class="cp-breadcrumb">${crumbs}</div>

            <div class="cp-head">
                ${CONTAINER_FOLDER_SVG}
                <input class="cp-name" id="cpName" type="text" maxlength="100" placeholder="${isWs ? 'Workspace name' : 'Project name'}">
            </div>
            ${inheritNote}

            <label class="cp-label" for="cpInstructions">Instructions</label>
            <div class="textarea-resizable">
                <textarea class="cp-instructions" id="cpInstructions" rows="8" placeholder="${instrPlaceholder}"></textarea>
                <div class="textarea-resize-handle" aria-hidden="true" title="Drag to resize"></div>
            </div>
            <div class="cp-save-row">
                <button class="cp-save-btn" id="cpSave" type="button" disabled>Save</button>
                <span class="cp-save-hint" id="cpSaveHint" aria-live="polite"></span>
            </div>

            <div class="cp-section">
                <div class="cp-section-label">Files</div>
                <div class="project-file-list" id="cpFileList"></div>
                <p class="empty-state small" id="cpNoFiles" hidden>No files yet.</p>
                <div class="file-upload-wrapper">
                    <input type="file" id="cpFileInput" class="file-input-hidden" multiple>
                    <button type="button" class="file-upload-btn" id="cpUploadBtn">${CONTAINER_UPLOAD_SVG} Upload files</button>
                </div>
                <p class="help-text">Text, code, and PDF files up to 10MB each.</p>
                <p class="help-text" id="cpFilesToggleHint" hidden>Unchecked files stay here but aren't loaded into chats. The assistant can still open one on request when file tools are on.</p>
            </div>

            ${listsHTML}
        </div>
    `;

    wireContainerPage(kind, id);
    setupTextareaResizers(); // the page's Instructions handle is freshly rendered
    loadContainerFiles(kind, id);
}

/** Projects list for a workspace page (each row opens that project's page). */
function containerProjectsListHTML(workspace) {
    const projects = Object.values(state.projects)
        .filter(p => p.workspaceId === workspace.id)
        .sort(byUpdatedDesc);

    let h = `<div class="cp-section"><div class="cp-section-label">Projects</div>`;
    if (projects.length > 0) {
        h += `<div class="drill-list">${projects.map(projectRowHTML).join('')}</div>`;
    } else {
        h += `<p class="empty-state small">No projects yet.</p>`;
    }
    h += `<button class="cp-add-btn" data-action="new-project" type="button">+ New project</button></div>`;
    return h;
}

/** Chats list for a container page (workspace-level or project-level chats). */
function containerChatsListHTML(kind, entity) {
    const chats = (kind === 'workspace'
        ? Object.values(state.conversations).filter(c => c.workspaceId === entity.id && !c.projectId)
        : Object.values(state.conversations).filter(c => c.projectId === entity.id)
    ).sort(byUpdatedDesc);

    const sectionLabel = kind === 'workspace' ? 'Chats here' : 'Chats';
    const addLabel = kind === 'workspace' ? '+ New chat here' : '+ New chat';

    let h = `<div class="cp-section"><div class="cp-section-label">${sectionLabel}</div>`;
    if (chats.length > 0) {
        h += `<div class="cp-row-list">` + chats.map(ch =>
            `<button class="cp-row" data-open-chat="${escapeHtml(ch.id)}" type="button">
                <span class="cp-row-name">${escapeHtml(ch.title || 'New Chat')}</span>
                <span class="cp-row-meta">${formatTimeAgo(ch.updatedAt || ch.createdAt)}</span>
            </button>`).join('') + `</div>`;
    } else {
        h += `<p class="empty-state small">No chats yet.</p>`;
    }
    h += `<button class="cp-add-btn" data-action="new-chat" type="button">${addLabel}</button></div>`;
    return h;
}

/** Wire the interactive elements of the currently-rendered container page. */
function wireContainerPage(kind, id) {
    const page = elements.messagesContainer.querySelector('.container-page');
    if (!page) return;
    const isWs = kind === 'workspace';
    const entity = isWs ? state.workspaces[id] : state.projects[id];
    if (!entity) return;

    const nameEl = page.querySelector('#cpName');
    const instrEl = page.querySelector('#cpInstructions');
    const saveBtn = page.querySelector('#cpSave');
    const hintEl = page.querySelector('#cpSaveHint');

    // Set values via property (avoids HTML-escaping pitfalls in attributes/body).
    if (nameEl) nameEl.value = entity.name || '';
    if (instrEl) instrEl.value = entity.instructions || '';

    const markDirty = () => { if (saveBtn) saveBtn.disabled = false; if (hintEl) hintEl.textContent = ''; };
    if (nameEl) {
        nameEl.addEventListener('input', markDirty);
        nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveBtn?.click(); } });
    }
    if (instrEl) instrEl.addEventListener('input', markDirty);
    if (saveBtn) saveBtn.addEventListener('click', () => saveContainerEdits(kind, id, { saveBtn, nameEl, instrEl, hintEl }));

    // Breadcrumb out of the page (into the main-area router).
    page.querySelectorAll('.cp-crumb[data-nav]').forEach(el => el.addEventListener('click', () => {
        const nav = el.dataset.nav;
        if (nav === 'workspace' && entity.workspaceId) {
            openContainerPage('workspace', entity.workspaceId);
        } else { // 'workspaces' — back to the workspaces list
            navigate({ type: 'workspaces' });
        }
    }));

    // Files.
    const uploadBtn = page.querySelector('#cpUploadBtn');
    const fileInput = page.querySelector('#cpFileInput');
    if (uploadBtn && fileInput) {
        uploadBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => uploadContainerFiles(kind, id, fileInput.files));
    }

    // Project rows (workspace page): open on the info area, ⋯ menu for edit/delete.
    page.querySelectorAll('.project-info[data-project-id]').forEach(el =>
        el.addEventListener('click', () => openContainerPage('project', el.dataset.projectId)));
    page.querySelectorAll('.project-menu-btn[data-project-id]').forEach(btn =>
        btn.addEventListener('click', (e) => { e.stopPropagation(); showProjectMenu(btn, btn.dataset.projectId); }));

    // Chat rows + add buttons.
    page.querySelectorAll('[data-open-chat]').forEach(b =>
        b.addEventListener('click', () => switchConversation(b.dataset.openChat)));
    page.querySelectorAll('[data-action="new-project"]').forEach(b =>
        b.addEventListener('click', () => startNewProjectIn(id)));
    page.querySelectorAll('[data-action="new-chat"]').forEach(b =>
        b.addEventListener('click', startNewChatInContainer));
}

/**
 * Persist the inline name + instructions edits for a container.
 * @param {'workspace'|'project'} kind
 * @param {string} id
 * @param {{saveBtn:HTMLElement, nameEl:HTMLInputElement, instrEl:HTMLTextAreaElement, hintEl:HTMLElement}} els
 */
async function saveContainerEdits(kind, id, els) {
    const { saveBtn, nameEl, instrEl, hintEl } = els;
    const name = (nameEl?.value || '').trim();
    const instructions = instrEl?.value || '';
    const label = kind === 'workspace' ? 'Workspace' : 'Project';

    if (!name) {
        showToast(`${label} name is required.`, { type: 'error' });
        nameEl?.focus();
        return;
    }

    if (saveBtn) saveBtn.disabled = true;
    try {
        if (kind === 'workspace') {
            const u = await API.workspaces.update(id, { name, instructions });
            state.workspaces[id] = { ...state.workspaces[id], name: u.name, instructions: u.instructions, updatedAt: u.updatedAt };
        } else {
            const u = await API.projects.update(id, { name, instructions });
            state.projects[id] = { ...state.projects[id], name: u.name, instructions: u.instructions, updatedAt: u.updatedAt };
        }
    } catch (err) {
        console.error('Failed to save container:', err);
        displayError(err, { action: 'save changes' });
        if (saveBtn) saveBtn.disabled = false;
        return;
    }

    if (hintEl) {
        hintEl.textContent = 'Saved';
        setTimeout(() => { if (hintEl.isConnected) hintEl.textContent = ''; }, 1500);
    }
    updateWorkspaceUI(); // refresh breadcrumb + sidebar names (leaves the page intact)
}

/** The files API namespace for a container kind. */
function containerFilesApi(kind) {
    return kind === 'workspace' ? API.workspaces.files : API.projects.files;
}

/**
 * Load and render the file list for the open container page, keeping the cached
 * file count (and the sidebar/breadcrumb meta) in sync.
 * @param {'workspace'|'project'} kind
 * @param {string} id
 */
async function loadContainerFiles(kind, id) {
    const listEl = document.getElementById('cpFileList');
    if (!listEl) return;

    let files;
    try {
        files = await containerFilesApi(kind).list(id);
    } catch (err) {
        console.error('Failed to load files:', err);
        displayError(err, { action: 'load files' });
        return;
    }

    // Keep the cached count current, then refresh the sidebar/breadcrumb meta.
    if (kind === 'workspace' && state.workspaces[id]) state.workspaces[id].fileCount = files.length;
    if (kind === 'project' && state.projects[id]) state.projects[id].fileCount = files.length;
    updateWorkspaceUI(); // sidebar/breadcrumb only — does not touch the main page

    if (!listEl.isConnected) return; // navigated away during the await
    listEl.innerHTML = '';
    const noEl = document.getElementById('cpNoFiles');
    // The toggle hint only makes sense once there are checkboxes to explain.
    const hintEl = document.getElementById('cpFilesToggleHint');
    if (hintEl) hintEl.hidden = files.length === 0;

    if (files.length === 0) {
        if (noEl) noEl.hidden = false;
        return;
    }
    if (noEl) noEl.hidden = true;

    files.forEach(f => {
        const row = document.createElement('div');
        // enabled is undefined on any response predating CT-03 — treat as on,
        // matching the server's "NULL means loaded" rule.
        const enabled = f.enabled !== false;
        row.className = `project-file-item${enabled ? '' : ' is-context-off'}`;
        const label = getFileTypeLabel(f.filename, f.mimeType);
        const href = containerFilesApi(kind).contentUrl(id, f.id);
        // Text files open in the file panel for view/edit/history (FC-04); PDFs
        // and other binaries are download-only.
        const viewable = !/\.pdf$/i.test(f.filename || '');
        row.innerHTML = `
            <input type="checkbox" class="project-file-toggle" ${enabled ? 'checked' : ''}
                   aria-label="Load ${escapeHtml(f.filename)} into chats" title="${CONTEXT_TOGGLE_TITLE}">
            <span class="project-file-badge">${escapeHtml(label)}</span>
            <span class="project-file-name${viewable ? ' clickable' : ''}" title="${escapeHtml(f.filename)}">${escapeHtml(f.filename)}</span>
            <span class="project-file-size">${escapeHtml(formatFileSize(f.sizeBytes))}</span>
            <a class="project-file-download" href="${href}" download title="Download">⤓</a>
            <button class="project-file-delete" type="button" title="Delete">✕</button>
        `;
        if (viewable) {
            row.querySelector('.project-file-name').addEventListener('click', () => {
                FilePanel.openStandalone({ fileName: f.filename, url: href, mimeType: f.mimeType, sizeBytes: f.sizeBytes });
            });
        }
        row.querySelector('.project-file-toggle')
            .addEventListener('change', (e) => toggleContainerFileContext(kind, id, f, e.target, row));
        row.querySelector('.project-file-delete')
            .addEventListener('click', () => deleteContainerFilePrompt(kind, id, f.id, f.filename));
        listEl.appendChild(row);
    });
}

/** Tooltip shared by every context-toggle checkbox. */
const CONTEXT_TOGGLE_TITLE =
    'Load this file into chats. Unchecking keeps the file but leaves its ' +
    'contents out of the conversation.';

/**
 * Flip a container file's context toggle (CT-03). Optimistic: the row updates
 * immediately and reverts if the server refuses, because the action is free to
 * undo and a round trip per click would feel broken.
 * @param {'workspace'|'project'} kind
 * @param {string} id - container id
 * @param {Object} file - the file row from the list
 * @param {HTMLInputElement} checkbox
 * @param {HTMLElement} row
 */
async function toggleContainerFileContext(kind, id, file, checkbox, row) {
    const enabled = checkbox.checked;
    row.classList.toggle('is-context-off', !enabled);
    checkbox.disabled = true;

    try {
        const updated = await containerFilesApi(kind).setEnabled(id, file.id, enabled);
        file.enabled = updated.enabled; // keep the cached row honest for re-renders
    } catch (err) {
        console.error('Failed to set file context toggle:', err);
        checkbox.checked = !enabled;
        row.classList.toggle('is-context-off', enabled);
        displayError(err, { action: 'update the file' });
    } finally {
        checkbox.disabled = false;
    }
}

/**
 * Upload one or more files to the open container, then refresh the list.
 * @param {'workspace'|'project'} kind
 * @param {string} id
 * @param {FileList|File[]} fileList
 */
async function uploadContainerFiles(kind, id, fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    const btn = document.getElementById('cpUploadBtn');
    const originalHTML = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.classList.add('is-uploading');
        btn.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span> Uploading…`;
    }

    let failures = 0;
    for (const file of files) {
        try {
            await containerFilesApi(kind).upload(id, file);
        } catch (err) {
            failures++;
            console.error('Failed to upload file:', file.name, err);
            displayError(err, { action: 'upload file' });
        }
    }

    if (btn && btn.isConnected) {
        btn.classList.remove('is-uploading');
        btn.innerHTML = originalHTML;
        btn.disabled = false;
    }
    const input = document.getElementById('cpFileInput');
    if (input) input.value = ''; // allow re-selecting the same file
    await loadContainerFiles(kind, id);

    const ok = files.length - failures;
    if (ok > 0) showToast(`Uploaded ${ok} file${ok !== 1 ? 's' : ''}.`, { type: 'success' });
}

/**
 * Confirm and delete a single container file (from Drive + DB), then refresh.
 * @param {'workspace'|'project'} kind
 * @param {string} id
 * @param {string} fileId
 * @param {string} filename
 */
async function deleteContainerFilePrompt(kind, id, fileId, filename) {
    const where = kind === 'workspace' ? 'workspace' : 'project';
    const ok = await confirmDialog({
        title: 'Delete file?',
        body: `"${filename}" will be removed from this ${where} and from your Google Drive.`,
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;
    try {
        await containerFilesApi(kind).delete(id, fileId);
    } catch (err) {
        console.error('Failed to delete file:', err);
        displayError(err, { action: 'delete file' });
        return;
    }
    await loadContainerFiles(kind, id);
}

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

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            // Remove data URL prefix (e.g., "data:image/png;base64,")
            const base64 = reader.result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
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

// Wire the themed bottom drag-bars that replace the native textarea grip.
// Each `.textarea-resize-handle` resizes the textarea immediately before it.
// Idempotent (skips already-wired handles): called once at init for the static
// forms, and again whenever a view renders a fresh handle (container pages).
// Dragged heights persist in UiPrefs (keyed by textarea id) so re-rendered
// textareas — e.g. container-page Instructions — keep their size, matching the
// static settings-modal ones.
function setupTextareaResizers() {
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
