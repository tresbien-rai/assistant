/**
 * Cached DOM element references (R-02, moved verbatim from main.js).
 *
 * Evaluated at import time. Safe: the entry point is a `type="module"` script,
 * which is deferred, so the document is fully parsed before this runs — the
 * same guarantee the old classic script relied on.
 *
 * A leaf: every value here is a `document.getElementById` lookup. (Several keys
 * happen to share a name with a function elsewhere, e.g. `closeSidebar` — they
 * are element ids, not calls.)
 */

// ===== DOM Elements =====
export const elements = {
    // Sidebar
    sidebar: document.getElementById('sidebar'),
    openSidebar: document.getElementById('openSidebar'),
    closeSidebar: document.getElementById('closeSidebar'),

    // (The sidebar tabs are gone entirely. `chatsTab` and `projectsTab` stayed
    // here after the markup was removed, resolving to null on every load — a
    // trap for the first code to assume a cached ref is an element. The sidebar
    // is a section rail now; the router decides what the main area shows.)

    // Settings modal (relocated out of the sidebar)
    settingsModal: document.getElementById('settingsModal'),

    // Appearance controls
    paletteBase: document.getElementById('paletteBase'),
    paletteTint: document.getElementById('paletteTint'),
    paletteResetBtn: document.getElementById('paletteResetBtn'),
    devModeToggle: document.getElementById('devModeToggle'),
    enterBehaviourOptions: document.getElementById('enterBehaviourOptions'),

    // Request inspector (developer mode)
    viewRequestBtn: document.getElementById('viewRequestBtn'),
    requestInspectorModal: document.getElementById('requestInspectorModal'),
    closeRequestInspector: document.getElementById('closeRequestInspector'),
    requestInspectorJson: document.getElementById('requestInspectorJson'),
    requestInspectorMeta: document.getElementById('requestInspectorMeta'),
    copyRequestBtn: document.getElementById('copyRequestBtn'),

    // File panel (edit-in-context slice 1: viewer)
    filePanel: document.getElementById('filePanel'),
    filePanelBadge: document.getElementById('filePanelBadge'),
    filePanelName: document.getElementById('filePanelName'),
    filePanelRawToggle: document.getElementById('filePanelRawToggle'),
    filePanelHistoryBtn: document.getElementById('filePanelHistoryBtn'),
    filePanelEditBtn: document.getElementById('filePanelEditBtn'),
    filePanelDownload: document.getElementById('filePanelDownload'),
    filePanelClose: document.getElementById('filePanelClose'),
    filePanelBody: document.getElementById('filePanelBody'),
    filePanelFooter: document.getElementById('filePanelFooter'),
    filePanelConflict: document.getElementById('filePanelConflict'),
    filePanelCancelBtn: document.getElementById('filePanelCancelBtn'),
    filePanelSaveBtn: document.getElementById('filePanelSaveBtn'),
    filePanelLockNote: document.getElementById('filePanelLockNote'),
    filePanelBrowseBtn: document.getElementById('filePanelBrowseBtn'),
    filePanelScratchpadToggle: document.getElementById('filePanelScratchpadToggle'),
    // Files explorer top-bar button (CF-01b) — replaces the panel's right-edge
    // tab as the single entry point + unseen-activity indicator.
    filesExplorerBtn: document.getElementById('filesExplorerBtn'),
    filesExplorerDot: document.getElementById('filesExplorerDot'),
    filesExplorerCount: document.getElementById('filesExplorerCount'),

    // Name-only create modal (shared by workspace + project creation; the full
    // edit UI lives inline on the container page — WR-05).
    nameModal: document.getElementById('nameModal'),
    nameModalTitle: document.getElementById('nameModalTitle'),
    nameModalLabel: document.getElementById('nameModalLabel'),
    nameModalInput: document.getElementById('nameModalInput'),
    nameModalSaveBtn: document.getElementById('nameModalSaveBtn'),
    closeNameModal: document.getElementById('closeNameModal'),

    // Shared confirm dialog (replaces window.confirm — see confirmDialog()).
    confirmModal: document.getElementById('confirmModal'),
    confirmModalTitle: document.getElementById('confirmModalTitle'),
    confirmModalBody: document.getElementById('confirmModalBody'),
    confirmModalCancelBtn: document.getElementById('confirmModalCancelBtn'),
    confirmModalConfirmBtn: document.getElementById('confirmModalConfirmBtn'),

    // Top-bar breadcrumb indicator (No workspace / WS / WS › Project)
    workspaceBreadcrumb: document.getElementById('workspaceBreadcrumb'),

    // Settings inputs
    assistantName: document.getElementById('assistantName'),
    personaTagline: document.getElementById('personaTagline'),
    personaTaglineCount: document.getElementById('personaTaglineCount'),
    personaRoleLabel: document.getElementById('personaRoleLabel'),
    personaRoleLabelCount: document.getElementById('personaRoleLabelCount'),
    systemPrompt: document.getElementById('systemPrompt'),
    // Model parameter controls (temperature, prefill, thinking, safety, …) moved
    // to the per-model detail view (renderModelDetail, Slice 5) — rendered from
    // PROVIDERS descriptors, so no static element refs here.

    // Avatar settings
    avatarFileInput: document.getElementById('avatarFileInput'),
    avatarUploadBtn: document.getElementById('avatarUploadBtn'),
    avatarClearBtn: document.getElementById('avatarClearBtn'),
    avatarMoodBadge: document.getElementById('avatarMoodBadge'),
    avatarPreview: document.getElementById('avatarPreview'),
    avatarPreviewName: document.getElementById('avatarPreviewName'),
    avatarPreviewTagline: document.getElementById('avatarPreviewTagline'),
    avatarPreviewStatus: document.getElementById('avatarPreviewStatus'),
    showAvatar: document.getElementById('showAvatar'),
    activeFileTurns: document.getElementById('activeFileTurns'),

    // Expression settings
    expressionList: document.getElementById('expressionList'),
    addExpressionBtn: document.getElementById('addExpressionBtn'),
    
    // Expression modal
    expressionModal: document.getElementById('expressionModal'),
    closeExpressionModal: document.getElementById('closeExpressionModal'),
    expressionModalTitle: document.getElementById('expressionModalTitle'),
    expressionName: document.getElementById('expressionName'),
    expressionEmoji: document.getElementById('expressionEmoji'),
    expressionFileInput: document.getElementById('expressionFileInput'),
    expressionUploadBtn: document.getElementById('expressionUploadBtn'),
    expressionClearBtn: document.getElementById('expressionClearBtn'),
    expressionImagePreview: document.getElementById('expressionImagePreview'),
    saveExpressionBtn: document.getElementById('saveExpressionBtn'),
    deleteExpressionBtn: document.getElementById('deleteExpressionBtn'),

    // Model management
    modelModal: document.getElementById('modelModal'),
    closeModelModal: document.getElementById('closeModelModal'),
    modelModalProviders: document.getElementById('modelModalProviders'),
    fetchModelsBtn: document.getElementById('fetchModelsBtn'),
    fetchModelsHelp: document.getElementById('fetchModelsHelp'),
    modalKeyBtn: document.getElementById('modalKeyBtn'),
    availableModelsGrid: document.getElementById('availableModelsGrid'),
    newModelId: document.getElementById('newModelId'),
    newModelName: document.getElementById('newModelName'),
    addModelBtn: document.getElementById('addModelBtn'),

    // Chat area
    chatArea: document.getElementById('chatArea'),
    dragOverlay: document.getElementById('dragOverlay'),
    messagesContainer: document.getElementById('messagesContainer'),
    settingsView: document.getElementById('settingsView'),
    personaEditView: document.getElementById('personaEditView'),
    modelsView: document.getElementById('modelsView'),
    inputContainer: document.getElementById('inputContainer'),
    messageInput: document.getElementById('messageInput'),
    sendButton: document.getElementById('sendButton'),
    stopButton: document.getElementById('stopButton'),
    attachButton: document.getElementById('attachButton'),
    fileAttachInput: document.getElementById('fileAttachInput'),
    attachmentPreviewArea: document.getElementById('attachmentPreviewArea'),
    composerModelButton: document.getElementById('composerModelButton'),
    composerModelName: document.getElementById('composerModelName'),
    toolsToggleBtn: document.getElementById('toolsToggleBtn'),
    personaToolsBase: document.getElementById('personaToolsBase'),
    
    // Status bar
    headerAssistantName: document.getElementById('headerAssistantName'),
    modelIndicator: document.getElementById('modelIndicator'),
    personaButton: document.getElementById('personaButton'),
    modelButton: document.getElementById('modelButton'),
    statusTokens: document.getElementById('statusTokens'),
    avatarToggleBtn: document.getElementById('avatarToggleBtn'),
    
    // Floating avatar
    floatingAvatar: document.getElementById('floatingAvatar'),
    avatarImage: document.getElementById('avatarImage'),
    avatarSizeSlider: document.getElementById('avatarSizeSlider'),
    avatarSizeValue: document.getElementById('avatarSizeValue'),
    avatarEmoji: document.getElementById('avatarEmoji'),
    avatarImg: document.getElementById('avatarImg'),
    floatingAvatarName: document.getElementById('floatingAvatarName'),

    // Prompt presets (AP-02, Settings → Advanced)
    presetList: document.getElementById('presetList'),
    createPresetBtn: document.getElementById('createPresetBtn'),
    importPresetBtn: document.getElementById('importPresetBtn'),
    presetListPanel: document.getElementById('presetListPanel'),
    presetEditor: document.getElementById('presetEditor'),
    composerPresetButton: document.getElementById('composerPresetButton'),
    promptInspector: document.getElementById('promptInspector'),
    refreshInspectorBtn: document.getElementById('refreshInspectorBtn'),
    personaPresetSelect: document.getElementById('personaPresetSelect'),

    // Error display system (P0-17)
    toastContainer: document.getElementById('toastContainer'),
    criticalBanner: document.getElementById('criticalBanner'),
    criticalBannerMessage: document.getElementById('criticalBannerMessage'),
    criticalBannerAction: document.getElementById('criticalBannerAction'),
    criticalBannerDismiss: document.getElementById('criticalBannerDismiss')
};

/**
 * Pin the message thread to the bottom. Lives here rather than with the chat
 * code because it is a bare DOM operation on a cached element, and both the
 * thread and components/errors.js need it.
 */
export function scrollToBottom() {
    elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
}
