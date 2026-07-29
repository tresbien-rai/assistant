/**
 * The application state object (R-02, moved verbatim from main.js).
 *
 * Rule 1 of the refactor: this is the only source of truth. Modules import
 * `state` and mutate its PROPERTIES — the binding itself is never reassigned
 * (checked: 97 property writes, zero reassignments), which is what makes a
 * shared live binding safe here.
 */

import { CONFIG, getDefaultModelConfig } from './config.js';

// ===== State Management =====
export const state = {
    // Authenticated user (set after API.auth.status() / API.auth.me())
    // null when unauthenticated. Shape: { id, email, displayName }.
    user: null,
    // App-level preferences from API.settings.get(). Model params live on
    // each catalog model's profile (customModels[provider][i].params).
    settings: {
        avatarSize: CONFIG.defaults.avatarSize,
        avatarPosition: CONFIG.defaults.avatarPosition,
        showAvatar: CONFIG.defaults.showAvatar,
        // User-defined models keyed by provider — persisted server-side as
        // part of the settings row. Each entry is { id, name, params? } where
        // `params` is the model's own profile (full modelParams bag, prefill
        // included) — the "engine" settings that load when it's selected.
        customModels: {
            anthropic: [],
            google: [],
            openai: []
        },
        // Models catalog "daily drivers" filter (Models tab redesign): an array
        // of provider ids the catalog shows, or null for "All". Persisted in the
        // settings row. The provider chips (a later slice) are the only writer.
        catalogProviders: null
    },
    // The active model layer (WR-12): provider + model + params that every
    // chat send and the model/params UI use. User-level, persisted in
    // settings.currentModelConfig. Effectively "the loaded model profile" —
    // switching models saves/loads profiles (docs/MODEL_PROFILES_DESIGN.md);
    // fixed-mode personas pin a model (docs/MODEL_DESYNC_DESIGN.md). Seeded
    // in init(); the default here only covers pre-hydration.
    currentModelConfig: getDefaultModelConfig(),
    // Per-provider key presence metadata from API.apiKeys.list().
    // Never the keys themselves — the backend never returns plaintext.
    apiKeyStatus: {
        anthropic: { hasKey: false, updatedAt: null },
        google: { hasKey: false, updatedAt: null },
        openai: { hasKey: false, updatedAt: null }
    },
    // Personas stored by ID for multi-persona support (from API.personas.list).
    personas: {},
    activePersonaId: null,
    // Conversations stored by ID. Metadata loaded eagerly via
    // API.conversations.list(); messages are loaded lazily via
    // API.conversations.get(id) when the conversation becomes active.
    conversations: {},
    activeConversationId: null,
    // Workspaces stored by ID (from API.workspaces.list). Outer container in the
    // hierarchy workspace ⊃ project ⊃ chat. Metadata only.
    workspaces: {},
    activeWorkspaceId: null,
    // Projects stored by ID (from API.projects.list). Metadata only — file lists
    // are fetched on demand via API.projects.files.list(id). Each has a workspaceId.
    projects: {},
    activeProjectId: null,
    // UI state (session-local, no server source)
    ui: {
        // Main-area router (WR-07): the single content surface shows exactly one
        // view. The sidebar is a section rail that navigates between these.
        //   { type: 'chats' }                 unfiled chats list
        //   { type: 'workspaces' }            all workspaces list
        //   { type: 'workspace', id }         a workspace page (instr/files/projects/chats)
        //   { type: 'project', id }           a project page
        //   { type: 'chat', id }              an open conversation
        // Settings/Personas are reached via the rail too (interim: modal/popover).
        mainView: { type: 'chats' },
        // Persona group ids collapsed in the chats list (session-only).
        collapsedPersonaGroups: new Set()
    },
    currentExpression: 'neutral',
    isLoading: false,
    currentPrefill: '',  // Tracks active prefill for response stripping
    lastRequestModel: null, // Model id of the in-flight/last request, for the per-message tag (WR-14)
    estimatedTokens: 0,
    tempExpressionBlob: null, // Blob waiting to be saved when expression is saved
    tempExpressionPreviewUrl: '', // Object URL for preview in modal
    tempExpressionCleared: false, // Flag indicating user explicitly cleared the image
    // Streaming state. abortController is no longer needed in the frontend —
    // api-client.js manages its own AbortController for the chat stream, and
    // stopGeneration() just calls API.chat.abort().
    // F-03: the in-flight reply is described by state, not by a DOM pointer.
    // `streamingConversationId` says which chat the turn belongs to; the bubble
    // is re-derived from the DOM when it is needed (js/chat/thread.js).
    streamingConversationId: null,
    streamingAccumulator: '',
    streamingGeneratedImages: [],
    // Track A tool activity for the in-flight turn: the tool_activity payloads
    // seen so far, which finalizeStreamingMessage turns into the message's
    // persisted chip/card attachments.
    streamingToolEvents: [],
    // Attachment state
    pendingAttachments: [], // Array of { id, file, previewUrl, type, mimeType, fileName, fileSize }
    // The per-chat file-tools choice made on a chat that does not exist yet
    // (the composer toggle flipped before the first send). createConversation
    // applies and clears it. undefined = no pending choice; true/false = forced.
    pendingToolsOverride: undefined
};

/**
 * Get the currently active persona object
 * @returns {Object|null} The active persona or null if none
 */
export function getActivePersona() {
    if (!state.activePersonaId) {
        return null;
    }
    return state.personas[state.activePersonaId] || null;
}
