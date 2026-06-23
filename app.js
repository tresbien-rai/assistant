/**
 * AI Assistant - Main Application Logic
 * 
 * Features:
 * - Multi-provider API support (Claude, with OpenAI/Gemini coming)
 * - Customizable personas with system prompts
 * - Floating avatar with expression system
 * - Status bar with session info
 * - Settings persistence via the server API (api-client.js → /api/*)
 */

// ===== Configuration =====
// Provider endpoints are gone from the frontend after P0-16 — all chat and
// model-list traffic goes through window.API → /api/chat[/stream] and
// /api/models/:provider, and the backend holds the keys.
const CONFIG = {
    defaults: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        assistantName: 'Assistant',
        systemPrompt: `You are a helpful, friendly assistant. You provide clear and concise answers while being warm and personable.

When responding, you may optionally include an expression tag like [expression: happy] at the start of your message to indicate your current mood. Available expressions: neutral, happy, sad, thinking, excited, confused.`,
        avatarSize: 'medium',
        avatarPosition: 'top-right',
        showAvatar: true
    },
    defaultExpressions: {
        neutral: { emoji: '😊', imageKey: '', keywords: [] },
        happy: { emoji: '😄', imageKey: '', keywords: ['happy', 'glad', 'wonderful', 'great', 'love', 'excited', 'awesome', 'fantastic'] },
        sad: { emoji: '😢', imageKey: '', keywords: ['sorry', 'unfortunately', 'sad', 'regret', 'apologize', 'difficult'] },
        thinking: { emoji: '🤔', imageKey: '', keywords: ['hmm', 'consider', 'perhaps', 'maybe', 'wondering', 'think', 'analyze'] },
        excited: { emoji: '🎉', imageKey: '', keywords: ['amazing', 'incredible', 'wow', 'excellent', 'brilliant', 'outstanding'] },
        confused: { emoji: '😕', imageKey: '', keywords: ['confused', 'unclear', 'not sure', 'don\'t understand', 'puzzled'] }
    },
    attachments: {
        maxImageSize: 20 * 1024 * 1024,  // 20MB for images
        maxFileSize: 10 * 1024 * 1024,   // 10MB for other files
        maxAttachments: 10,               // Max files per message
        supportedTypes: [
            'image/png', 'image/jpeg', 'image/gif', 'image/webp',
            'application/pdf', 'text/plain', 'text/csv', 'text/markdown',
            'text/javascript', 'text/html', 'text/css', 'application/json',
            'text/xml', 'application/xml', 'text/yaml',
            'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm'
        ]
    }
};

// ===== Markdown Rendering =====

/**
 * Configure marked.js for Markdown rendering with syntax highlighting
 */
marked.setOptions({
    breaks: true,       // Convert \n to <br> in paragraphs
    gfm: true,          // GitHub Flavored Markdown
    headerIds: false,   // Don't add IDs to headers (cleaner output)
    mangle: false       // Don't escape email addresses
});

/**
 * Custom renderer to add syntax highlighting to code blocks
 */
const markedRenderer = new marked.Renderer();

// Override code block rendering to use highlight.js
markedRenderer.code = function(code, language) {
    // Handle the case where marked passes an object instead of separate params
    if (typeof code === 'object') {
        language = code.lang;
        code = code.text;
    }

    const validLanguage = language && hljs.getLanguage(language);
    const highlighted = validLanguage
        ? hljs.highlight(code, { language }).value
        : hljs.highlightAuto(code).value;

    const langClass = validLanguage ? ` class="language-${language}"` : '';
    return `<pre><code${langClass}>${highlighted}</code></pre>`;
};

// Make links open in new tab
markedRenderer.link = function(href, title, text) {
    // Handle the case where marked passes an object
    if (typeof href === 'object') {
        text = href.text;
        title = href.title;
        href = href.href;
    }

    const titleAttr = title ? ` title="${title}"` : '';
    return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
};

marked.setOptions({ renderer: markedRenderer });

/**
 * Render Markdown content to HTML
 * @param {string} content - Raw markdown text
 * @returns {string} - HTML string
 */
function renderMarkdown(content) {
    if (!content) return '';
    return marked.parse(content);
}

// Feather-style SVG icons for message action buttons — consistent with the
// app's other SVG buttons (send/attach/gear). stroke=currentColor so they
// inherit the theme text color and the hover color.
const ICON_SVG = {
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>',
    rerun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>',
    delete: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>',
};

// Single source of truth for the per-message action buttons (was duplicated in
// the streaming and static render paths). rerunTitle differs by role.
function messageActionsHTML(rerunTitle) {
    return `
        <button class="message-action-btn" data-action="copy" title="Copy" aria-label="Copy">${ICON_SVG.copy}</button>
        <button class="message-action-btn" data-action="edit" title="Edit" aria-label="Edit">${ICON_SVG.edit}</button>
        <button class="message-action-btn" data-action="rerun" title="${rerunTitle}" aria-label="${rerunTitle}">${ICON_SVG.rerun}</button>
        <button class="message-action-btn danger" data-action="delete" title="Delete" aria-label="Delete">${ICON_SVG.delete}</button>
    `;
}

// ===== UI Preferences (device-local layout settings) =====
// Layout prefs (sidebar width, and later chat width / theme / avatar placement)
// are intentionally per-device, so they live in localStorage rather than the
// synced server settings — a phone and a desktop want different layouts.
// All access is guarded: if localStorage is blocked (privacy mode/extensions)
// we fall back to defaults and simply don't persist.
const UiPrefs = {
    KEY: 'ai_assistant_ui_prefs',
    defaults: {
        sidebarWidth: 320,        // px; desktop sidebar column width
        theme: 'midnight',        // midnight | light | slate
        accent: '',               // '' = use the theme's default accent
        chatWidth: 'comfortable', // narrow | comfortable | wide
    },
    _data: null,
    load() {
        if (this._data) return this._data;
        try {
            const raw = localStorage.getItem(this.KEY);
            this._data = raw ? { ...this.defaults, ...JSON.parse(raw) } : { ...this.defaults };
        } catch {
            this._data = { ...this.defaults };
        }
        return this._data;
    },
    get(key) { return this.load()[key]; },
    set(key, value) {
        this.load()[key] = value;
        try { localStorage.setItem(this.KEY, JSON.stringify(this._data)); } catch { /* storage blocked */ }
    },
    // Push current prefs into CSS custom properties / theme attribute on :root.
    apply() {
        const d = this.load();
        document.documentElement.style.setProperty('--sidebar-width', `${d.sidebarWidth}px`);
        applyTheme(d.theme);
        applyAccent(d.accent);
        applyChatWidth(d.chatWidth);
    },
};

// ===== Appearance: themes, accent color, chat width (device-local) =====
const THEMES = ['midnight', 'light', 'slate'];
const CHAT_WIDTHS = { narrow: 620, comfortable: 780, wide: 1040 };
const DEFAULT_ACCENT = '#6c63ff';

function hexToRgb(hex) {
    const h = String(hex || '').replace('#', '');
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    const n = parseInt(full, 16);
    if (!Number.isFinite(n) || full.length !== 6) return null;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
}
function shadeHex(hex, amount) {
    const c = hexToRgb(hex);
    if (!c) return hex;
    return rgbToHex(c.r + c.r * amount, c.g + c.g * amount, c.b + c.b * amount);
}

function applyTheme(name) {
    const theme = THEMES.includes(name) ? name : 'midnight';
    document.documentElement.setAttribute('data-theme', theme);
    applyCodeTheme(theme);
}

// Swap the highlight.js syntax theme: light tokens for the Light theme, dark
// tokens otherwise. Both stylesheets are preloaded; we just toggle `disabled`.
function applyCodeTheme(theme) {
    const dark = document.getElementById('hljsDark');
    const light = document.getElementById('hljsLight');
    if (!dark || !light) return;
    const useLight = theme === 'light';
    dark.disabled = useLight;
    light.disabled = !useLight;
}

// Run a theme/accent change wrapped in a short transition window so the palette
// cross-fades instead of snapping. Transitions are enabled only while the
// `theme-transition` class is present (see CSS), so normal interactions aren't
// affected, and we never add it on load (no flash).
function withThemeTransition(fn) {
    const root = document.documentElement;
    root.classList.add('theme-transition');
    fn();
    clearTimeout(withThemeTransition._t);
    withThemeTransition._t = setTimeout(() => root.classList.remove('theme-transition'), 480);
}

// Apply a custom accent (overrides the theme). Empty/invalid clears the override
// so the theme's default accent applies.
function applyAccent(hex) {
    const root = document.documentElement;
    const rgb = hex ? hexToRgb(hex) : null;
    if (!rgb) {
        root.style.removeProperty('--accent');
        root.style.removeProperty('--accent-hover');
        root.style.removeProperty('--accent-subtle');
        return;
    }
    root.style.setProperty('--accent', hex);
    root.style.setProperty('--accent-hover', shadeHex(hex, -0.15));
    root.style.setProperty('--accent-subtle', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.2)`);
}

function applyChatWidth(name) {
    const px = CHAT_WIDTHS[name] || CHAT_WIDTHS.comfortable;
    document.documentElement.style.setProperty('--chat-max-width', `${px}px`);
}

// Reflect current appearance prefs into the settings-modal controls.
function syncAppearanceControls() {
    const d = UiPrefs.load();
    const theme = THEMES.includes(d.theme) ? d.theme : 'midnight';
    const width = CHAT_WIDTHS[d.chatWidth] ? d.chatWidth : 'comfortable';
    document.querySelectorAll('#themeOptions button').forEach(b => {
        b.classList.toggle('active', b.dataset.themeName === theme);
    });
    document.querySelectorAll('#chatWidthOptions button').forEach(b => {
        b.classList.toggle('active', b.dataset.chatWidth === width);
    });
    if (elements.accentPicker) elements.accentPicker.value = d.accent || DEFAULT_ACCENT;
}

// ===== IndexedDB Image Store =====
// Retained ONLY for transient pre-send attachment blobs (state.pendingAttachments
// → IndexedDB → reload-resilient until send). Avatars and persona/expression
// images now live on the server (see API.avatars.*). To be removed in P0-16
// when the chat path also moves server-side.
// Usage:
//   await ImageStore.init()           - Initialize the database
//   await ImageStore.store(key, blob) - Store a blob with a unique key
//   await ImageStore.get(key)         - Get object URL for stored image
//   await ImageStore.delete(key)      - Delete an image
//   ImageStore.revokeURL(url)         - Clean up an object URL
const ImageStore = {
    dbName: 'ai_assistant_images',
    dbVersion: 1,
    storeName: 'images',
    db: null,
    urlCache: new Map(), // key -> objectURL mapping for cleanup

    /**
     * Initialize IndexedDB connection
     * @returns {Promise<IDBDatabase>}
     */
    async init() {
        if (this.db) return this.db;

        // IndexedDB can be entirely absent or blocked by the browser context
        // (private mode in some browsers, or privacy/ad-block extensions that
        // disable site storage). Guard so a missing global or a synchronous
        // throw from open() surfaces as a clean rejection instead of an
        // uncaught error that would abort app startup.
        if (typeof indexedDB === 'undefined' || !indexedDB) {
            throw new Error('IndexedDB is unavailable in this browser context');
        }

        return new Promise((resolve, reject) => {
            let request;
            try {
                request = indexedDB.open(this.dbName, this.dbVersion);
            } catch (err) {
                console.error('Failed to open IndexedDB:', err);
                reject(err);
                return;
            }

            request.onerror = () => {
                console.error('Failed to open IndexedDB:', request.error);
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                console.log('ImageStore: IndexedDB initialized');
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Create object store for images if it doesn't exist
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: 'key' });
                    console.log('ImageStore: Created images object store');
                }
            };
        });
    },

    /**
     * Store an image blob with a unique key
     * @param {string} key - Unique identifier (e.g., 'avatar_main', 'expr_happy')
     * @param {Blob} blob - Image blob to store
     * @returns {Promise<string>} - The key used for storage
     */
    async store(key, blob) {
        await this.init();

        // Revoke any existing URL for this key
        this.revokeURLForKey(key);

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);

            const request = store.put({ key, blob, timestamp: Date.now() });

            request.onsuccess = () => {
                console.log(`ImageStore: Stored image with key "${key}"`);
                resolve(key);
            };

            request.onerror = () => {
                console.error('ImageStore: Failed to store image:', request.error);
                reject(request.error);
            };
        });
    },

    /**
     * Get an image as an object URL
     * @param {string} key - The key to retrieve
     * @returns {Promise<string|null>} - Object URL or null if not found
     */
    async get(key) {
        if (!key) return null;
        await this.init();

        // Return cached URL if available
        if (this.urlCache.has(key)) {
            return this.urlCache.get(key);
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);

            const request = store.get(key);

            request.onsuccess = () => {
                if (request.result && request.result.blob) {
                    const url = URL.createObjectURL(request.result.blob);
                    this.urlCache.set(key, url);
                    resolve(url);
                } else {
                    resolve(null);
                }
            };

            request.onerror = () => {
                console.error('ImageStore: Failed to get image:', request.error);
                reject(request.error);
            };
        });
    },

    /**
     * Delete an image from storage
     * @param {string} key - The key to delete
     * @returns {Promise<void>}
     */
    async delete(key) {
        if (!key) return;
        await this.init();

        // Revoke the URL first
        this.revokeURLForKey(key);

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);

            const request = store.delete(key);

            request.onsuccess = () => {
                console.log(`ImageStore: Deleted image with key "${key}"`);
                resolve();
            };

            request.onerror = () => {
                console.error('ImageStore: Failed to delete image:', request.error);
                reject(request.error);
            };
        });
    },

    /**
     * Get the raw Blob from storage (for API uploads)
     * @param {string} key - The key to retrieve
     * @returns {Promise<Blob|null>} - The blob or null if not found
     */
    async getBlob(key) {
        if (!key) return null;
        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(key);

            request.onsuccess = () => {
                if (request.result && request.result.blob) {
                    resolve(request.result.blob);
                } else {
                    resolve(null);
                }
            };

            request.onerror = () => {
                reject(request.error);
            };
        });
    },

    /**
     * Check if a key exists in storage
     * @param {string} key - The key to check
     * @returns {Promise<boolean>}
     */
    async has(key) {
        if (!key) return false;
        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);

            const request = store.getKey(key);

            request.onsuccess = () => {
                resolve(request.result !== undefined);
            };

            request.onerror = () => {
                reject(request.error);
            };
        });
    },

    /**
     * Revoke an object URL and remove from cache
     * @param {string} key - The key whose URL should be revoked
     */
    revokeURLForKey(key) {
        if (this.urlCache.has(key)) {
            URL.revokeObjectURL(this.urlCache.get(key));
            this.urlCache.delete(key);
        }
    },

    /**
     * Revoke all cached object URLs (call on page unload or cleanup)
     */
    revokeAllURLs() {
        for (const url of this.urlCache.values()) {
            URL.revokeObjectURL(url);
        }
        this.urlCache.clear();
    },

    /**
     * Convert a Base64 data URL to a Blob
     * @param {string} dataUrl - Base64 data URL (e.g., "data:image/png;base64,...")
     * @returns {Blob}
     */
    dataUrlToBlob(dataUrl) {
        const parts = dataUrl.split(',');
        const mime = parts[0].match(/:(.*?);/)[1];
        const binaryString = atob(parts[1]);
        const bytes = new Uint8Array(binaryString.length);

        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        return new Blob([bytes], { type: mime });
    },

    /**
     * Convert a File to a Blob (strips File metadata, keeps just the data)
     * @param {File} file - File object from input
     * @returns {Promise<Blob>}
     */
    async fileToBlob(file) {
        return new Blob([await file.arrayBuffer()], { type: file.type });
    }
};

// ===== State Management =====
const state = {
    // Authenticated user (set after API.auth.status() / API.auth.me())
    // null when unauthenticated. Shape: { id, email, displayName }.
    user: null,
    // App-level preferences from API.settings.get(). Provider/model settings
    // live on each persona's modelConfig (not here).
    settings: {
        avatarSize: CONFIG.defaults.avatarSize,
        avatarPosition: CONFIG.defaults.avatarPosition,
        showAvatar: CONFIG.defaults.showAvatar,
        // User-defined models keyed by provider — persisted server-side as
        // part of the settings row.
        customModels: {
            anthropic: [],
            google: [],
            openai: []
        }
    },
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
    // Projects stored by ID (from API.projects.list). Metadata only — file lists
    // are fetched on demand via API.projects.files.list(id).
    projects: {},
    activeProjectId: null,
    // UI state (session-local, no server source)
    ui: {
        activeTab: 'chats',
        conversationFilter: 'active', // 'active' means filter by activePersonaId, or 'all'
        // Project modal mode: holds the id being edited, or null when creating.
        editingProjectId: null
    },
    currentExpression: 'neutral',
    isLoading: false,
    currentPrefill: '',  // Tracks active prefill for response stripping
    sessionStartTime: Date.now(),
    estimatedTokens: 0,
    tempExpressionBlob: null, // Blob waiting to be saved when expression is saved
    tempExpressionPreviewUrl: '', // Object URL for preview in modal
    tempExpressionCleared: false, // Flag indicating user explicitly cleared the image
    // Streaming state. abortController is no longer needed in the frontend —
    // api-client.js manages its own AbortController for the chat stream, and
    // stopGeneration() just calls API.chat.abort().
    streamingMessageDiv: null,
    streamingAccumulator: '',
    streamingGeneratedImages: [],
    // Attachment state
    pendingAttachments: [] // Array of { id, file, previewUrl, type, mimeType, fileName, fileSize }
};

// ===== Conversation Helpers =====

/**
 * Create a new conversation server-side and set it as active.
 * The server generates the id — callers must await this.
 * @param {string} [title] - Optional title, defaults to "New Chat"
 * @returns {Promise<string>} The server-generated conversation ID
 */
async function createConversation(title = 'New Chat') {
    const created = await API.conversations.create({
        personaId: state.activePersonaId,
        title,
    });
    state.conversations[created.id] = {
        id: created.id,
        title: created.title,
        personaId: created.personaId,
        projectId: created.projectId,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        messageCount: 0,
        messages: [],
    };
    state.activeConversationId = created.id;
    return created.id;
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
    const modelConfig = JSON.parse(JSON.stringify(getDefaultModelConfig()));
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

/**
 * Get the currently active persona object
 * @returns {Object|null} The active persona or null if none
 */
function getActivePersona() {
    if (!state.activePersonaId) {
        return null;
    }
    return state.personas[state.activePersonaId] || null;
}

/**
 * Get the model configuration for the active persona
 * Falls back to defaultModelConfig if persona has no modelConfig
 * @returns {Object} The model configuration (provider, model, modelParams)
 */
function getActiveModelConfig() {
    const persona = getActivePersona();
    if (persona?.modelConfig) {
        return persona.modelConfig;
    }
    // Fallback to default model config
    return getDefaultModelConfig();
}

/**
 * Get the default model configuration structure
 * @returns {Object} Default model config
 */
function getDefaultModelConfig() {
    return {
        provider: CONFIG.defaults.provider,
        model: CONFIG.defaults.model,
        modelParams: {
            temperature: 1.0,
            topP: 0.95,
            topK: 40,
            maxTokens: 4096,
            stopSequences: [],
            streaming: false,
            temperatureEnabled: true,
            topPEnabled: true,
            topKEnabled: true,
            anthropic: {
                thinkingEnabled: false,
                thinkingBudget: 4000
            },
            google: {
                thinkingLevel: 'off',
                safetyHarassment: 'BLOCK_MEDIUM_AND_ABOVE',
                safetyHate: 'BLOCK_MEDIUM_AND_ABOVE',
                safetySexual: 'BLOCK_MEDIUM_AND_ABOVE',
                safetyDangerous: 'BLOCK_MEDIUM_AND_ABOVE',
                mediaResolution: 'medium'
            }
        }
    };
}

/**
 * Save model configuration to the active persona
 * @param {Object} modelConfig - The model config to save
 */
function saveModelConfigToPersona(modelConfig) {
    const persona = getActivePersona();
    if (persona) {
        persona.modelConfig = modelConfig;
        persona.updatedAt = Date.now();
        savePersonas();
    }
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

// ===== DOM Elements =====
const elements = {
    // Sidebar
    sidebar: document.getElementById('sidebar'),
    openSidebar: document.getElementById('openSidebar'),
    closeSidebar: document.getElementById('closeSidebar'),

    // Sidebar tabs
    chatsTab: document.getElementById('chatsTab'),
    personasTab: document.getElementById('personasTab'),
    projectsTab: document.getElementById('projectsTab'),

    // Settings modal (relocated out of the sidebar)
    settingsModal: document.getElementById('settingsModal'),
    closeSettingsModal: document.getElementById('closeSettingsModal'),
    openSettingsBtn: document.getElementById('openSettingsBtn'),

    // Appearance controls
    accentPicker: document.getElementById('accentPicker'),
    accentResetBtn: document.getElementById('accentResetBtn'),

    // Chats tab elements
    personaFilter: document.getElementById('personaFilter'),
    newChatBtn: document.getElementById('newChatBtn'),
    conversationList: document.getElementById('conversationList'),
    noConversationsMessage: document.getElementById('noConversationsMessage'),

    // Personas tab elements
    newPersonaBtn: document.getElementById('newPersonaBtn'),
    personaList: document.getElementById('personaList'),

    // Projects tab elements
    newProjectBtn: document.getElementById('newProjectBtn'),
    projectList: document.getElementById('projectList'),
    noProjectsMessage: document.getElementById('noProjectsMessage'),

    // Project create/edit modal
    projectModal: document.getElementById('projectModal'),
    projectModalTitle: document.getElementById('projectModalTitle'),
    closeProjectModal: document.getElementById('closeProjectModal'),
    projectNameInput: document.getElementById('projectNameInput'),
    projectInstructionsInput: document.getElementById('projectInstructionsInput'),
    saveProjectBtn: document.getElementById('saveProjectBtn'),

    // Settings inputs
    providerSelect: document.getElementById('providerSelect'),
    modelSelect: document.getElementById('modelSelect'),
    apiKeyInput: document.getElementById('apiKeyInput'),
    toggleApiKey: document.getElementById('toggleApiKey'),
    clearApiKeyBtn: document.getElementById('clearApiKeyBtn'),
    assistantName: document.getElementById('assistantName'),
    systemPrompt: document.getElementById('systemPrompt'),
    prefillInput: document.getElementById('prefillInput'),

    // Model parameters (Advanced Settings)
    temperatureSlider: document.getElementById('temperatureSlider'),
    tempValue: document.getElementById('tempValue'),
    temperatureEnabled: document.getElementById('temperatureEnabled'),
    temperatureGroup: document.getElementById('temperatureGroup'),
    topPSlider: document.getElementById('topPSlider'),
    topPValue: document.getElementById('topPValue'),
    topPEnabled: document.getElementById('topPEnabled'),
    topPGroup: document.getElementById('topPGroup'),
    topKInput: document.getElementById('topKInput'),
    topKEnabled: document.getElementById('topKEnabled'),
    topKGroup: document.getElementById('topKGroup'),
    maxTokensInput: document.getElementById('maxTokensInput'),
    stopSequencesTags: document.getElementById('stopSequencesTags'),
    stopSequenceInput: document.getElementById('stopSequenceInput'),
    streamingToggle: document.getElementById('streamingToggle'),

    // Anthropic-specific params
    anthropicParams: document.getElementById('anthropicParams'),
    thinkingEnabledToggle: document.getElementById('thinkingEnabledToggle'),
    thinkingBudgetGroup: document.getElementById('thinkingBudgetGroup'),
    thinkingBudgetInput: document.getElementById('thinkingBudgetInput'),

    // Gemini-specific params
    geminiParams: document.getElementById('geminiParams'),
    thinkingLevelSelect: document.getElementById('thinkingLevelSelect'),
    mediaResolutionSelect: document.getElementById('mediaResolutionSelect'),
    safetyHarassmentSelect: document.getElementById('safetyHarassmentSelect'),
    safetyHateSelect: document.getElementById('safetyHateSelect'),
    safetySexualSelect: document.getElementById('safetySexualSelect'),
    safetyDangerousSelect: document.getElementById('safetyDangerousSelect'),

    // Avatar settings
    avatarFileInput: document.getElementById('avatarFileInput'),
    avatarUploadBtn: document.getElementById('avatarUploadBtn'),
    avatarClearBtn: document.getElementById('avatarClearBtn'),
    avatarPreview: document.getElementById('avatarPreview'),
    avatarPreviewName: document.getElementById('avatarPreviewName'),
    avatarPreviewStatus: document.getElementById('avatarPreviewStatus'),
    showAvatar: document.getElementById('showAvatar'),
    
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
    expressionKeywords: document.getElementById('expressionKeywords'),
    saveExpressionBtn: document.getElementById('saveExpressionBtn'),
    deleteExpressionBtn: document.getElementById('deleteExpressionBtn'),

    // Model management
    manageModelsBtn: document.getElementById('manageModelsBtn'),
    modelModal: document.getElementById('modelModal'),
    closeModelModal: document.getElementById('closeModelModal'),
    savedModelsList: document.getElementById('savedModelsList'),
    noModelsMessage: document.getElementById('noModelsMessage'),
    fetchModelsBtn: document.getElementById('fetchModelsBtn'),
    availableModelsGrid: document.getElementById('availableModelsGrid'),
    newModelId: document.getElementById('newModelId'),
    newModelName: document.getElementById('newModelName'),
    addModelBtn: document.getElementById('addModelBtn'),

    // Chat area
    chatArea: document.getElementById('chatArea'),
    dragOverlay: document.getElementById('dragOverlay'),
    messagesContainer: document.getElementById('messagesContainer'),
    messageInput: document.getElementById('messageInput'),
    sendButton: document.getElementById('sendButton'),
    stopButton: document.getElementById('stopButton'),
    attachButton: document.getElementById('attachButton'),
    fileAttachInput: document.getElementById('fileAttachInput'),
    attachmentPreviewArea: document.getElementById('attachmentPreviewArea'),
    
    // Status bar
    headerAssistantName: document.getElementById('headerAssistantName'),
    modelIndicator: document.getElementById('modelIndicator'),
    statusMood: document.getElementById('statusMood'),
    statusMessages: document.getElementById('statusMessages'),
    statusTokens: document.getElementById('statusTokens'),
    statusSession: document.getElementById('statusSession'),
    avatarToggleBtn: document.getElementById('avatarToggleBtn'),
    
    // Floating avatar
    floatingAvatar: document.getElementById('floatingAvatar'),
    avatarImage: document.getElementById('avatarImage'),
    avatarSizeSlider: document.getElementById('avatarSizeSlider'),
    avatarSizeValue: document.getElementById('avatarSizeValue'),
    avatarEmoji: document.getElementById('avatarEmoji'),
    avatarImg: document.getElementById('avatarImg'),
    floatingAvatarName: document.getElementById('floatingAvatarName'),
    floatingAvatarExpression: document.getElementById('floatingAvatarExpression'),

    // Error display system (P0-17)
    toastContainer: document.getElementById('toastContainer'),
    criticalBanner: document.getElementById('criticalBanner'),
    criticalBannerMessage: document.getElementById('criticalBannerMessage'),
    criticalBannerAction: document.getElementById('criticalBannerAction'),
    criticalBannerDismiss: document.getElementById('criticalBannerDismiss')
};

// ===== Initialization =====
// init() is called by bootstrap() in the auth-gate block (P0-14) once the
// user is authenticated. It fetches all server-side state in parallel,
// hydrates the in-memory `state` object, then wires the UI.
async function init() {
    // Parallel fetch — these are independent endpoints.
    const [settings, personas, conversations, apiKeyStatus, projects] = await Promise.all([
        API.settings.get(),
        API.personas.list(),
        API.conversations.list(),
        API.apiKeys.list(),
        // Projects are non-essential to core chat — degrade to empty on failure
        // rather than blocking the whole app load (the others are essential and
        // intentionally fail-fast).
        API.projects.list().catch(err => {
            console.warn('Failed to load projects; continuing without them:', err);
            return [];
        }),
    ]);

    hydrateSettings(settings);
    hydratePersonas(personas);
    hydrateConversations(conversations);
    hydrateApiKeyStatus(apiKeyStatus);
    hydrateProjects(projects);

    // Pick the most recently updated persona/conversation as active.
    pickActivePersona();
    pickActiveConversation();

    // Fetch messages for the active conversation eagerly so the first
    // render isn't empty. Other conversations are lazy-loaded on switch.
    if (state.activeConversationId) {
        await loadConversationMessages(state.activeConversationId);
    }

    // (Appearance/layout prefs are applied early in bootstrap so they cover the
    // login screen too — no need to re-apply here.)

    // Wire UI after state is populated so listeners read coherent state.
    setupEventListeners();
    await updateUI();
    createSidebarOverlay();
    startSessionTimer();

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

    console.log('AI Assistant initialized!');
}

// ===== Server → state hydration =====

function hydrateSettings(settings) {
    if (!settings) return;
    state.settings.avatarSize = settings.avatarSize || CONFIG.defaults.avatarSize;
    state.settings.avatarPosition = settings.avatarPosition || CONFIG.defaults.avatarPosition;
    state.settings.showAvatar = settings.showAvatar !== undefined ? settings.showAvatar : CONFIG.defaults.showAvatar;
    // customModels arrives as an object keyed by provider (parsed JSON from
    // the server). Default empty arrays per provider if absent.
    const cm = settings.customModels || {};
    state.settings.customModels = {
        anthropic: Array.isArray(cm.anthropic) ? cm.anthropic : [],
        google: Array.isArray(cm.google) ? cm.google : [],
        openai: Array.isArray(cm.openai) ? cm.openai : [],
    };
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
        state.personas[p.id] = {
            id: p.id,
            name: p.name,
            systemPrompt: p.systemPrompt || '',
            prefill: p.prefill || '',
            avatarFilename: p.avatarFilename || '',
            expressions,
            // Backfill missing modelConfig fields against the current default.
            // Personas created server-side may have a minimal modelConfig
            // (e.g., the OAuth callback's default-persona row only includes
            // a few params); the UI assumes the full set, so merge here.
            modelConfig: mergeModelConfig(p.modelConfig),
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
        };
    }
}

/**
 * Merge a (possibly incomplete) modelConfig from the server with the
 * frontend's default structure. Server-provided values win; missing fields
 * are filled from the default. Returns a brand-new object — never mutates
 * the default.
 */
function mergeModelConfig(serverConfig) {
    const defaults = getDefaultModelConfig();
    if (!serverConfig || typeof serverConfig !== 'object') return defaults;
    const incoming = serverConfig.modelParams || {};
    const incomingAnthropic = incoming.anthropic || {};
    const incomingGoogle = incoming.google || {};
    return {
        provider: serverConfig.provider || defaults.provider,
        model: serverConfig.model || defaults.model,
        modelParams: {
            ...defaults.modelParams,
            ...incoming,
            anthropic: { ...defaults.modelParams.anthropic, ...incomingAnthropic },
            google: { ...defaults.modelParams.google, ...incomingGoogle },
        },
    };
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
            name: p.name,
            instructions: p.instructions || '',
            fileCount: p.fileCount || 0,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
        };
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
// Two independent debounce timers so a fast typist filling in an API key
// doesn't churn /api/settings, and a slider drag on avatar size doesn't churn
// /api/api-keys/<provider>.
let autoSaveTimeout = null;
let apiKeySaveTimeout = null;
// Track which provider's key (if any) was edited since the last persist so we
// know what to POST after the debounce fires.
let pendingApiKeyProvider = null;
// Last typed-in key per provider, for change detection only. NOT used by any
// other code path — the chat path now uses the server-side stored key. This
// map persists for the session so we don't re-PUT an unchanged key on every
// autosave tick.
const lastTypedApiKey = { anthropic: '', google: '', openai: '' };

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
 * Collect all current UI values into state
 */
function saveAllSettingsFromUI() {
    const persona = getActivePersona();

    // Provider & model - save to active persona's modelConfig
    if (persona && persona.modelConfig) {
        persona.modelConfig.provider = elements.providerSelect.value;
        persona.modelConfig.model = elements.modelSelect.value;
    }

    // API key for current provider: store-only path. Scheduled for server
    // persistence on a separate debounce so /api/settings updates don't ping
    // the API-keys endpoint and vice versa. The key value itself never lives
    // in `state` — it's read from elements.apiKeyInput.value at debounce
    // fire-time. Optimistically update apiKeyStatus.hasKey so the send
    // button / fetch-models button unlock without waiting for the PUT.
    const currentProvider = persona?.modelConfig?.provider || CONFIG.defaults.provider;
    const inputKey = elements.apiKeyInput.value;
    // Only schedule a PUT for non-empty input. Empty input deliberately does
    // NOT auto-DELETE the server-stored key — a stray touch-then-clear would
    // otherwise silently destroy the saved key with no confirmation. Use
    // the explicit "Clear saved key" button (clearStoredApiKey) for that.
    if (inputKey.length > 0 && lastTypedApiKey[currentProvider] !== inputKey) {
        lastTypedApiKey[currentProvider] = inputKey;
        state.apiKeyStatus[currentProvider] = {
            ...state.apiKeyStatus[currentProvider],
            hasKey: true,
        };
        pendingApiKeyProvider = currentProvider;
        if (apiKeySaveTimeout) clearTimeout(apiKeySaveTimeout);
        apiKeySaveTimeout = setTimeout(persistPendingApiKey, 500);
    } else if (inputKey.length === 0) {
        // Keep lastTypedApiKey in sync with the visible state without firing
        // a destructive action.
        lastTypedApiKey[currentProvider] = '';
    }

    // Avatar visibility is read here; size/position are kept authoritative in
    // state by their own controls (presets, the size slider, and drag), so we
    // don't read the preset buttons — that would clobber a free value.
    state.settings.showAvatar = elements.showAvatar.checked;

    // Model parameters (save to active persona)
    saveModelParamsFromUI();

    // Persona settings (name, system prompt, prefill)
    if (persona) {
        persona.name = elements.assistantName.value || CONFIG.defaults.assistantName;
        persona.systemPrompt = elements.systemPrompt.value || CONFIG.defaults.systemPrompt;
        persona.prefill = elements.prefillInput.value || '';
        persona.updatedAt = Date.now();
    }
}

/**
 * Push the pending API-key PUT to the server. Only fires for non-empty
 * input — deletes are handled by clearStoredApiKey via the explicit
 * "Clear saved key" button, not by emptying the input.
 */
function persistPendingApiKey() {
    const provider = pendingApiKeyProvider;
    pendingApiKeyProvider = null;
    if (!provider) return;
    const value = lastTypedApiKey[provider] || '';
    if (!value) return; // empty input → no destructive action

    API.apiKeys.set(provider, value).then(result => {
        state.apiKeyStatus[provider] = {
            hasKey: true,
            updatedAt: (result && result.updatedAt) || Date.now(),
        };
    }).catch(async err => {
        console.error(`Failed to persist API key for ${provider}:`, err);
        // Resync from the server so the optimistic hasKey update doesn't
        // mislead the user about what's actually saved, AND clear
        // lastTypedApiKey so the user can re-attempt with the same value
        // (otherwise the equality guard in saveAllSettingsFromUI would
        // short-circuit a paste-and-retry).
        lastTypedApiKey[provider] = '';
        try {
            const list = await API.apiKeys.list();
            hydrateApiKeyStatus(list);
        } catch (refetchErr) {
            console.error('Failed to refetch apiKeyStatus:', refetchErr);
        }
        // Re-render to surface the failure to the user.
        updateApiKeyFieldForProvider(provider);
        updateSendButtonState();
        // C12: the save is debounced/async, so without an explicit signal the
        // user has no idea the key didn't stick. Toast it.
        displayError(err, { action: `save your ${provider} API key` });
    });
}

/**
 * Explicit user-initiated delete of the stored API key. Confirms first
 * because this is destructive.
 */
async function clearStoredApiKey() {
    const persona = getActivePersona();
    const provider = persona?.modelConfig?.provider || CONFIG.defaults.provider;
    if (!state.apiKeyStatus[provider]?.hasKey) return;

    if (!confirm(`Clear your saved ${provider} API key from the server? You'll need to re-enter it to chat.`)) {
        return;
    }

    try {
        await API.apiKeys.delete(provider);
    } catch (err) {
        console.error(`Failed to delete API key for ${provider}:`, err);
        displayError(err, { action: 'clear the saved key' });
        return;
    }

    state.apiKeyStatus[provider] = { hasKey: false, updatedAt: Date.now() };
    lastTypedApiKey[provider] = '';
    elements.apiKeyInput.value = '';
    updateApiKeyFieldForProvider(provider);
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
        customModels: state.settings.customModels,
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
    });
}

// ===== UI Updates =====
async function updateUI() {
    const persona = getActivePersona();
    const modelConfig = getActiveModelConfig();

    // Update form inputs - provider/model now from active persona's modelConfig
    elements.providerSelect.value = modelConfig.provider;
    populateModelDropdown(); // Populate from customModels based on persona's provider
    const currentProvider = modelConfig.provider;
    // The key value never lives in JS — the input starts empty. If a key is
    // already stored server-side, the placeholder reflects that (via
    // updateApiKeyFieldForProvider) so the user knows whether they need to
    // re-paste. Pasting (and blur/debounce) PUTs the new value.
    //
    // C10: don't clobber what the user is actively typing. If the field is
    // focused or a save is still pending, leave the value alone — updateUI can
    // fire from background refreshes (e.g. on401 resync) mid-edit.
    const apiKeyInputBusy = document.activeElement === elements.apiKeyInput
        || pendingApiKeyProvider !== null;
    if (!apiKeyInputBusy) {
        elements.apiKeyInput.value = '';
    }
    updateApiKeyFieldForProvider(currentProvider);
    elements.assistantName.value = persona ? persona.name : CONFIG.defaults.assistantName;
    elements.systemPrompt.value = persona ? persona.systemPrompt : CONFIG.defaults.systemPrompt;
    elements.prefillInput.value = persona ? (persona.prefill || '') : '';
    elements.showAvatar.checked = state.settings.showAvatar;

    // Load model parameters to UI (from active persona's modelConfig)
    loadModelParamsToUI();

    // Reflect avatar size (presets + slider) and position (presets) into the UI.
    syncAvatarSizeControls();
    syncAvatarPositionControls();

    // Reflect appearance prefs (theme / accent / chat width) into the controls.
    syncAppearanceControls();

    // Update header
    elements.headerAssistantName.textContent = persona ? persona.name : CONFIG.defaults.assistantName;
    elements.modelIndicator.textContent = getModelDisplayName(modelConfig.model);

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
    populatePersonaFilter();
    renderConversationList();
}

/**
 * Update API key field placeholder and label based on provider
 * @param {string} provider - The provider name
 */
function updateApiKeyFieldForProvider(provider) {
    const placeholders = {
        anthropic: 'sk-ant-...',
        google: 'AIza...',
        openai: 'sk-...'
    };

    const labels = {
        anthropic: 'Anthropic API Key',
        google: 'Google AI API Key',
        openai: 'OpenAI API Key'
    };

    // If a key is already stored server-side, surface that in the placeholder
    // so the user knows the input is empty by design (not because no key is
    // configured). Pasting overwrites.
    const hasKey = !!state.apiKeyStatus[provider]?.hasKey;
    elements.apiKeyInput.placeholder = hasKey
        ? 'Key saved — paste a new value to replace'
        : (placeholders[provider] || 'API Key');

    // The explicit Clear button is the ONLY way to delete a stored key —
    // emptying the input is a no-op.
    if (elements.clearApiKeyBtn) {
        elements.clearApiKeyBtn.hidden = !hasKey;
    }

    const labelElement = document.getElementById('apiKeyLabel');
    if (labelElement) {
        labelElement.textContent = labels[provider] || 'API Key';
    }
}

/**
 * Handle provider change - update UI and load provider-specific settings
 * @param {string} provider - The new provider
 */
function handleProviderChange(provider) {
    // Update provider in active persona's modelConfig.
    const persona = getActivePersona();
    if (persona && persona.modelConfig) {
        persona.modelConfig.provider = provider;
        persona.updatedAt = Date.now();
    }

    // Clear the key input on provider switch. We never want a previously-typed
    // plaintext key from one provider to leak into the form for another, and
    // the value never persists in JS state anyway.
    elements.apiKeyInput.value = '';

    // Update placeholder and label for the new provider.
    updateApiKeyFieldForProvider(provider);

    // Repopulate model dropdown with provider-specific models
    populateModelDropdown();

    // Update provider-specific parameter sections visibility
    updateProviderParamsVisibility();

    // Update send button state
    updateSendButtonState();

    // Sync to storage
    savePersonas();
}

// ===== Model Parameter Helpers =====

/**
 * Show/hide provider-specific parameter sections based on current provider
 */
function updateProviderParamsVisibility() {
    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;
    elements.anthropicParams.style.display = provider === 'anthropic' ? 'block' : 'none';
    elements.geminiParams.style.display = provider === 'google' ? 'block' : 'none';
}

/**
 * Load model parameters from state to UI controls
 */
function loadModelParamsToUI() {
    const modelConfig = getActiveModelConfig();
    const params = modelConfig.modelParams;

    // Common parameters
    elements.temperatureSlider.value = params.temperature * 100;
    elements.tempValue.textContent = params.temperature.toFixed(2);
    elements.topPSlider.value = params.topP * 100;
    elements.topPValue.textContent = params.topP.toFixed(2);
    elements.topKInput.value = params.topK;
    elements.maxTokensInput.value = params.maxTokens;
    elements.streamingToggle.checked = params.streaming;

    // Parameter enabled checkboxes
    elements.temperatureEnabled.checked = params.temperatureEnabled !== false;
    elements.topPEnabled.checked = params.topPEnabled !== false;
    elements.topKEnabled.checked = params.topKEnabled !== false;

    // Update disabled visual state
    updateParamGroupDisabledState();

    // Render stop sequences tags
    renderStopSequencesTags();

    // Anthropic-specific
    elements.thinkingEnabledToggle.checked = params.anthropic.thinkingEnabled;
    elements.thinkingBudgetInput.value = params.anthropic.thinkingBudget;
    elements.thinkingBudgetGroup.style.display = params.anthropic.thinkingEnabled ? 'block' : 'none';

    // Gemini-specific
    elements.thinkingLevelSelect.value = params.google.thinkingLevel || 'off';
    elements.mediaResolutionSelect.value = params.google.mediaResolution;
    elements.safetyHarassmentSelect.value = params.google.safetyHarassment;
    elements.safetyHateSelect.value = params.google.safetyHate;
    elements.safetySexualSelect.value = params.google.safetySexual;
    elements.safetyDangerousSelect.value = params.google.safetyDangerous;

    // Update provider-specific visibility
    updateProviderParamsVisibility();
}

/**
 * Update the disabled class on param groups based on checkbox state
 */
function updateParamGroupDisabledState() {
    elements.temperatureGroup.classList.toggle('disabled', !elements.temperatureEnabled.checked);
    elements.topPGroup.classList.toggle('disabled', !elements.topPEnabled.checked);
    elements.topKGroup.classList.toggle('disabled', !elements.topKEnabled.checked);
}

/**
 * Save model parameters from UI controls to state
 */
function saveModelParamsFromUI() {
    const persona = getActivePersona();
    if (!persona || !persona.modelConfig) return;

    const params = persona.modelConfig.modelParams;

    // Common parameters
    params.temperature = elements.temperatureSlider.value / 100;
    params.topP = elements.topPSlider.value / 100;
    params.topK = parseInt(elements.topKInput.value, 10) || 40;
    params.maxTokens = parseInt(elements.maxTokensInput.value, 10) || 4096;
    params.streaming = elements.streamingToggle.checked;
    // stopSequences is already updated via tag input handlers

    // Parameter enabled flags
    params.temperatureEnabled = elements.temperatureEnabled.checked;
    params.topPEnabled = elements.topPEnabled.checked;
    params.topKEnabled = elements.topKEnabled.checked;

    // Anthropic-specific
    params.anthropic.thinkingEnabled = elements.thinkingEnabledToggle.checked;
    params.anthropic.thinkingBudget = parseInt(elements.thinkingBudgetInput.value, 10) || 4000;

    // Gemini-specific
    params.google.thinkingLevel = elements.thinkingLevelSelect.value;
    params.google.mediaResolution = elements.mediaResolutionSelect.value;
    params.google.safetyHarassment = elements.safetyHarassmentSelect.value;
    params.google.safetyHate = elements.safetyHateSelect.value;
    params.google.safetySexual = elements.safetySexualSelect.value;
    params.google.safetyDangerous = elements.safetyDangerousSelect.value;
}

/**
 * Render stop sequences as clickable tags
 */
function renderStopSequencesTags() {
    const container = elements.stopSequencesTags;
    const persona = getActivePersona();
    const sequences = persona?.modelConfig?.modelParams?.stopSequences || [];
    container.innerHTML = '';

    sequences.forEach((seq, index) => {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = seq;
        tag.title = 'Click to remove';
        tag.addEventListener('click', () => {
            if (persona?.modelConfig?.modelParams?.stopSequences) {
                persona.modelConfig.modelParams.stopSequences.splice(index, 1);
                renderStopSequencesTags();
                autoSaveSettings();
            }
        });
        container.appendChild(tag);
    });
}

/**
 * Add a stop sequence from the input field
 */
function addStopSequence() {
    const input = elements.stopSequenceInput;
    const value = input.value.trim();
    const persona = getActivePersona();

    if (value && persona?.modelConfig?.modelParams) {
        const sequences = persona.modelConfig.modelParams.stopSequences;
        if (!sequences.includes(value)) {
            sequences.push(value);
            renderStopSequencesTags();
            autoSaveSettings();
        }
    }

    input.value = '';
}

function updateAvatarPreview() {
    const preview = elements.avatarPreview;
    const name = elements.avatarPreviewName;
    const status = elements.avatarPreviewStatus;
    const persona = getActivePersona();

    name.textContent = persona ? persona.name : CONFIG.defaults.assistantName;

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
    const cRect = chatArea.getBoundingClientRect();
    const aRect = avatar.getBoundingClientRect();
    const maxLeft = Math.max(0, cRect.width - aRect.width);
    const maxTop = Math.max(0, cRect.height - aRect.height);
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
        const cRect = chatArea.getBoundingClientRect();
        const aRect = avatar.getBoundingClientRect();
        const maxLeft = Math.max(0, cRect.width - aRect.width);
        const maxTop = Math.max(0, cRect.height - aRect.height);
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
        const maxLeft = Math.max(1, cRect.width - aRect.width);
        const maxTop = Math.max(1, cRect.height - aRect.height);
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
    avatar.classList.toggle('hidden', !state.settings.showAvatar);

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

    if (expressionImageUrl) {
        // Expression has a custom image
        elements.avatarEmoji.style.display = 'none';
        elements.avatarImg.style.display = 'block';
        elements.avatarImg.src = expressionImageUrl;
    } else if (avatarImageUrl) {
        // Use default avatar
        elements.avatarEmoji.style.display = 'none';
        elements.avatarImg.style.display = 'block';
        elements.avatarImg.src = avatarImageUrl;
    } else {
        // Use emoji
        elements.avatarEmoji.style.display = 'block';
        elements.avatarImg.style.display = 'none';
        elements.avatarEmoji.textContent = (currentExpr && currentExpr.emoji) || '🤖';
    }

    // Update name and expression label
    elements.floatingAvatarName.textContent = persona ? persona.name : CONFIG.defaults.assistantName;
    elements.floatingAvatarExpression.textContent = state.currentExpression;
}

function updateStatusBar() {
    // Update mood
    const persona = getActivePersona();
    const expressions = (persona && persona.expressions && Object.keys(persona.expressions).length > 0)
        ? persona.expressions
        : CONFIG.defaultExpressions;
    // Final guard: never let a missing expression entry throw and abort startup.
    const expr = expressions[state.currentExpression] || expressions.neutral || { emoji: '🤖' };
    elements.statusMood.textContent = `${expr.emoji} ${state.currentExpression}`;

    // Update message count
    const activeConvo = getActiveConversation();
    elements.statusMessages.textContent = activeConvo ? activeConvo.messages.length : 0;

    // Update estimated tokens
    elements.statusTokens.textContent = `~${formatNumber(state.estimatedTokens)}`;
}

function startSessionTimer() {
    setInterval(() => {
        const elapsed = Math.floor((Date.now() - state.sessionStartTime) / 1000 / 60);
        elements.statusSession.textContent = `${elapsed}m`;
    }, 60000);
}

function formatNumber(num) {
    if (num >= 1000) {
        return (num / 1000).toFixed(1) + 'k';
    }
    return num.toString();
}

function getModelDisplayName(modelId) {
    if (!modelId) return 'No model selected';

    // Look up in custom models for current persona's provider
    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;
    const providerModels = state.settings.customModels[provider] || [];
    const customModel = providerModels.find(m => m.id === modelId);
    if (customModel) {
        return customModel.name;
    }

    // Fallback to model ID
    return modelId;
}

function updateSendButtonState() {
    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;
    const hasApiKey = !!state.apiKeyStatus[provider]?.hasKey;
    const hasMessage = elements.messageInput.value.trim().length > 0;
    const hasAttachments = state.pendingAttachments.length > 0;
    const notLoading = !state.isLoading;

    elements.sendButton.disabled = !(hasApiKey && (hasMessage || hasAttachments) && notLoading);
}

// ===== Expression Management =====
async function renderExpressionList() {
    const list = elements.expressionList;
    list.innerHTML = '';

    const persona = getActivePersona();
    const expressions = persona ? persona.expressions : CONFIG.defaultExpressions;

    const cacheBust = persona && persona.updatedAt ? `?v=${persona.updatedAt}` : '';
    for (const [name, expr] of Object.entries(expressions)) {
        const item = document.createElement('div');
        item.className = 'expression-item';
        item.onclick = () => openExpressionModal(name);

        // Show image when expression has one server-side; fall back to emoji.
        let imageContent = expr.emoji;
        if (persona && expr.imageKey) {
            const imageUrl = `${API.avatars.getExpressionUrl(persona.id, name)}${cacheBust}`;
            imageContent = `<img src="${imageUrl}" alt="${name}">`;
        }

        item.innerHTML = `
            <div class="expression-item-emoji">
                ${imageContent}
            </div>
            <span class="expression-item-name">${name}</span>
            <span class="expression-item-edit">Edit →</span>
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
        elements.expressionKeywords.value = expr.keywords.join(', ');
        elements.deleteExpressionBtn.style.display = 'block';

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
        elements.expressionKeywords.value = '';
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
    const keywords = elements.expressionKeywords.value
        .split(',')
        .map(k => k.trim().toLowerCase())
        .filter(k => k.length > 0);

    if (!name) {
        showToast('Please enter an expression name', { type: 'warning' });
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
    newExpressions[name] = { emoji, keywords, imageKey: initialImageKey };

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

    if (confirm(`Delete expression "${editingExpression}"?`)) {
        const expr = persona.expressions[editingExpression];

        // Local optimistic delete.
        const newExpressions = { ...persona.expressions };
        delete newExpressions[editingExpression];

        try {
            // 1. Persist expression-set change.
            await API.personas.update(persona.id, { expressions: newExpressions });
            // 2. Drop the server-side image file too (best-effort).
            if (expr?.imageKey) {
                try {
                    await API.avatars.deleteExpression(persona.id, editingExpression);
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
}

function updateSystemPromptExpressions() {
    // This could automatically update the system prompt with available expressions
    // For now, we'll leave it manual since users customize their prompts
}

// ===== Model Management =====

/**
 * Fetch available models from the current provider's API
 * @returns {Promise<Array>} Array of { id, display_name } objects
 */
async function fetchAvailableModels() {
    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;

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
 * Add a custom model to the list for the current provider
 * @param {string} id - The model ID
 * @param {string} name - The display name
 * @returns {boolean} True if added, false if already exists
 */
function addCustomModel(id, name) {
    if (!id || !name) return false;

    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;
    const providerModels = state.settings.customModels[provider];

    // Check if already exists
    const exists = providerModels.some(m => m.id === id);
    if (exists) return false;

    providerModels.push({ id, name });
    saveCustomModels();
    return true;
}

/**
 * Remove a custom model from the list for the current provider
 * @param {string} id - The model ID to remove
 */
function removeCustomModel(id) {
    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;
    const providerModels = state.settings.customModels[provider];
    const index = providerModels.findIndex(m => m.id === id);
    if (index === -1) return;

    providerModels.splice(index, 1);
    saveCustomModels();

    // If the removed model was selected, update persona's model
    const persona = getActivePersona();
    if (persona?.modelConfig?.model === id) {
        persona.modelConfig.model = providerModels.length > 0 ? providerModels[0].id : '';
        savePersonas();
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
 * Populate the model dropdown from customModels for the current provider
 */
function populateModelDropdown() {
    const select = elements.modelSelect;
    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;
    const providerModels = state.settings.customModels[provider] || [];
    select.innerHTML = '';

    if (providerModels.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No models - click Manage Models';
        option.disabled = true;
        option.selected = true;
        select.appendChild(option);
        select.disabled = true;
    } else {
        select.disabled = false;
        providerModels.forEach(model => {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.name;
            if (model.id === modelConfig.model) {
                option.selected = true;
            }
            select.appendChild(option);
        });

        // If selected model not in list, select first one and update persona
        if (!providerModels.some(m => m.id === modelConfig.model)) {
            const persona = getActivePersona();
            if (persona && persona.modelConfig) {
                persona.modelConfig.model = providerModels[0].id;
            }
            select.value = providerModels[0].id;
        }
    }

    // Update status bar
    elements.modelIndicator.textContent = getModelDisplayName(modelConfig.model);
}

/**
 * Render the saved models list in the modal for the current provider
 */
function renderSavedModelsList() {
    const container = elements.savedModelsList;
    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;
    const providerModels = state.settings.customModels[provider] || [];
    container.innerHTML = '';

    if (providerModels.length === 0) {
        elements.noModelsMessage.style.display = 'block';
        return;
    }

    elements.noModelsMessage.style.display = 'none';

    providerModels.forEach(model => {
        const item = document.createElement('div');
        item.className = 'saved-model-item';
        item.innerHTML = `
            <div class="saved-model-info">
                <span class="saved-model-name">${model.name}</span>
                <span class="saved-model-id">${model.id}</span>
            </div>
            <button class="delete-model-btn" data-model-id="${model.id}" title="Delete model">×</button>
        `;
        container.appendChild(item);
    });

    // Add delete button listeners
    container.querySelectorAll('.delete-model-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const modelId = e.target.dataset.modelId;
            if (confirm(`Delete model "${getModelDisplayName(modelId)}"?`)) {
                removeCustomModel(modelId);
                renderSavedModelsList();
                populateModelDropdown();
            }
        });
    });
}

/**
 * Render available models grid after fetching from API
 * @param {Array} models - Array of { id, display_name } from API
 */
function renderAvailableModelsGrid(models) {
    const grid = elements.availableModelsGrid;
    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;
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
            if (addCustomModel(modelId, modelName)) {
                renderSavedModelsList();
                populateModelDropdown();
                // Update the button
                e.target.textContent = 'Added';
                e.target.disabled = true;
                e.target.closest('.available-model-card').classList.add('already-added');
            }
        });
    });
}

/**
 * Open the model management modal
 */
function openModelModal() {
    renderSavedModelsList();
    elements.availableModelsGrid.style.display = 'none';
    elements.availableModelsGrid.innerHTML = '';
    elements.newModelId.value = '';
    elements.newModelName.value = '';

    // Disable fetch button if no API key for current provider
    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;
    elements.fetchModelsBtn.disabled = !state.apiKeyStatus[provider]?.hasKey;

    elements.modelModal.classList.add('visible');
}

/**
 * Close the model management modal
 */
function closeModelModal() {
    elements.modelModal.classList.remove('visible');
}

/**
 * Open the settings modal (relocated out of the sidebar). The form fields are
 * kept current by updateUI on every state change, so no refresh is needed here.
 */
function openSettingsModal() {
    if (!elements.settingsModal) return;
    closeSidebar(); // close the mobile drawer if it's open
    elements.settingsModal.classList.add('visible');
}

function closeSettingsModal() {
    if (!elements.settingsModal) return;
    elements.settingsModal.classList.remove('visible');
}

/**
 * Handle fetch models button click
 */
async function handleFetchModels() {
    const btn = elements.fetchModelsBtn;
    const originalText = btn.textContent;

    try {
        btn.disabled = true;
        btn.textContent = 'Fetching...';

        const models = await fetchAvailableModels();
        renderAvailableModelsGrid(models);
    } catch (error) {
        console.error('Failed to fetch models:', error);
        displayError(error, { action: 'fetch models' });
    } finally {
        const modelConfig = getActiveModelConfig();
        const provider = modelConfig.provider;
        btn.disabled = !state.apiKeyStatus[provider]?.hasKey;
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

    if (addCustomModel(id, name)) {
        renderSavedModelsList();
        populateModelDropdown();
        elements.newModelId.value = '';
        elements.newModelName.value = '';

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
 * Switch to a specific sidebar tab
 * @param {string} tabName - 'chats', 'settings', or 'personas'
 */
async function switchTab(tabName) {
    state.ui.activeTab = tabName;

    // Update tab buttons
    document.querySelectorAll('.sidebar-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // Update tab content visibility
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('active', content.dataset.tab === tabName);
    });

    // Refresh content when switching to certain tabs
    if (tabName === 'chats') {
        renderConversationList();
    } else if (tabName === 'personas') {
        await renderPersonaList();
    } else if (tabName === 'projects') {
        renderProjectList();
    }
}

/**
 * Populate the persona filter dropdown in chats tab
 */
function populatePersonaFilter() {
    const select = elements.personaFilter;
    select.innerHTML = '';

    // Add "All Personas" option
    const allOption = document.createElement('option');
    allOption.value = 'all';
    allOption.textContent = 'All Personas';
    select.appendChild(allOption);

    // Add each persona
    Object.values(state.personas).forEach(persona => {
        const option = document.createElement('option');
        option.value = persona.id;
        option.textContent = persona.name;
        if (state.ui.conversationFilter === 'active' && persona.id === state.activePersonaId) {
            option.selected = true;
        } else if (state.ui.conversationFilter === persona.id) {
            option.selected = true;
        }
        select.appendChild(option);
    });

    // Select "All" if that's the filter
    if (state.ui.conversationFilter === 'all') {
        select.value = 'all';
    }
}

/**
 * Render the conversation list in the chats tab
 */
function renderConversationList() {
    const container = elements.conversationList;
    container.innerHTML = '';

    // Determine which conversations to show
    let conversations = Object.values(state.conversations);

    // Filter by persona if not "all"
    const filterPersonaId = state.ui.conversationFilter === 'active'
        ? state.activePersonaId
        : state.ui.conversationFilter;

    if (filterPersonaId && filterPersonaId !== 'all') {
        conversations = conversations.filter(c => c.personaId === filterPersonaId);
    }

    // Sort by updatedAt descending (most recent first)
    conversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    // Show empty state if no conversations
    if (conversations.length === 0) {
        elements.noConversationsMessage.style.display = 'block';
        return;
    }
    elements.noConversationsMessage.style.display = 'none';

    // Render each conversation
    conversations.forEach(convo => {
        const item = document.createElement('div');
        item.className = `conversation-item ${convo.id === state.activeConversationId ? 'active' : ''}`;
        item.dataset.conversationId = convo.id;

        const timeAgo = formatTimeAgo(convo.updatedAt || convo.createdAt);

        item.innerHTML = `
            <div class="conversation-info" data-conversation-id="${convo.id}">
                <span class="conversation-title">${escapeHtml(convo.title || 'New Chat')}</span>
                <span class="conversation-time">${timeAgo}</span>
            </div>
            <button class="conversation-menu-btn" data-conversation-id="${convo.id}" title="Options">⋯</button>
        `;

        container.appendChild(item);
    });

    // Add click listeners for conversation items
    container.querySelectorAll('.conversation-info').forEach(info => {
        info.addEventListener('click', () => {
            const convoId = info.dataset.conversationId;
            switchConversation(convoId);
        });
    });

    // Add click listeners for menu buttons
    container.querySelectorAll('.conversation-menu-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            showConversationMenu(btn, btn.dataset.conversationId);
        });
    });
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

    // Also switch to the persona that owns this conversation. activePersonaId
    // is session state — not persisted server-side — so no savePersonas() call
    // is needed (and including one would also re-PUT every persona, wasting
    // bandwidth and risking cross-write clobbers).
    const convo = state.conversations[conversationId];
    if (convo.personaId && convo.personaId !== state.activePersonaId) {
        state.activePersonaId = convo.personaId;
    }

    // Lazy-load messages if this is the first time we're activating this
    // conversation in the session.
    await loadConversationMessages(conversationId);

    renderConversation();
    renderConversationList();
    updateUI();
    closeSidebar();
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
function renameConversationPrompt(conversationId) {
    const convo = state.conversations[conversationId];
    if (!convo) return;

    const newTitle = prompt('Enter new name:', convo.title || 'New Chat');
    if (newTitle && newTitle.trim()) {
        convo.title = newTitle.trim();
        convo.updatedAt = Date.now();
        saveConversations();
        renderConversationList();
    }
}

/**
 * Prompt to delete a conversation. Server delete first (so the local state
 * never goes out of sync with the server on failure), then local cleanup.
 * @param {string} conversationId
 */
async function deleteConversationPrompt(conversationId) {
    const convo = state.conversations[conversationId];
    if (!convo) return;

    if (!confirm(`Delete "${convo.title || 'New Chat'}"? This cannot be undone.`)) return;

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
    renderConversationList();
    renderConversation();
    closeSidebar();
}

/**
 * Render the persona list in the personas tab
 */
async function renderPersonaList() {
    const container = elements.personaList;
    container.innerHTML = '';

    const personas = Object.values(state.personas);

    // Sort by updatedAt descending
    personas.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    for (const persona of personas) {
        // Count conversations for this persona
        const convoCount = Object.values(state.conversations).filter(c => c.personaId === persona.id).length;

        const item = document.createElement('div');
        item.className = `persona-item ${persona.id === state.activePersonaId ? 'active' : ''}`;
        item.dataset.personaId = persona.id;

        // Avatar comes from /api/avatars/:id/avatar — cache-busted by
        // persona.updatedAt so a re-upload is visible immediately.
        let avatarContent = '';
        if (persona.avatarFilename) {
            const cacheBust = persona.updatedAt ? `?v=${persona.updatedAt}` : '';
            const imageUrl = `${API.avatars.getUrl(persona.id)}${cacheBust}`;
            avatarContent = `<img src="${imageUrl}" alt="${escapeHtml(persona.name)}">`;
        } else {
            // Fallback to emoji if no avatar
            const firstExpr = Object.values(persona.expressions || {})[0];
            const avatarEmoji = firstExpr?.emoji || '🤖';
            avatarContent = `<span class="avatar-emoji">${avatarEmoji}</span>`;
        }

        item.innerHTML = `
            <div class="persona-avatar">${avatarContent}</div>
            <div class="persona-details" data-persona-id="${persona.id}">
                <span class="persona-name">${escapeHtml(persona.name)}</span>
                <span class="persona-convo-count">${convoCount} conversation${convoCount !== 1 ? 's' : ''}</span>
            </div>
            <button class="persona-menu-btn" data-persona-id="${persona.id}" title="Options">⋯</button>
        `;

        container.appendChild(item);
    }

    // Add click listeners for persona items (to switch)
    container.querySelectorAll('.persona-details').forEach(info => {
        info.addEventListener('click', () => {
            const personaId = info.dataset.personaId;
            switchPersona(personaId);
        });
    });

    // Also make avatar clickable
    container.querySelectorAll('.persona-avatar').forEach(avatar => {
        avatar.addEventListener('click', () => {
            const personaId = avatar.closest('.persona-item').dataset.personaId;
            switchPersona(personaId);
        });
    });

    // Add click listeners for menu buttons
    container.querySelectorAll('.persona-menu-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            showPersonaMenu(btn, btn.dataset.personaId);
        });
    });
}

/**
 * Switch to a different persona
 * @param {string} personaId
 */
async function switchPersona(personaId) {
    if (!state.personas[personaId]) return;

    state.activePersonaId = personaId;

    // Update the conversation filter to show this persona's conversations
    state.ui.conversationFilter = 'active';

    savePersonas();
    populatePersonaFilter();
    renderConversationList();
    await renderPersonaList();
    await updateUI();

    // Switch to chats tab to show the persona's conversations
    await switchTab('chats');
}

/**
 * Show context menu for a persona
 * @param {HTMLElement} anchorEl
 * @param {string} personaId
 */
function showPersonaMenu(anchorEl, personaId) {
    // Remove any existing menu
    const existingMenu = document.querySelector('.context-menu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = `
        <button class="context-menu-item" data-action="edit">Edit</button>
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

            if (action === 'edit') {
                editPersona(personaId);
            } else if (action === 'delete') {
                deletePersonaPrompt(personaId);
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
 * Edit a persona - switch to it and open settings tab
 * @param {string} personaId
 */
function editPersona(personaId) {
    if (!state.personas[personaId]) return;

    state.activePersonaId = personaId;
    savePersonas();
    updateUI();
    openSettingsModal();
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

    let message = `Delete persona "${persona.name}"?`;
    if (linkedConvos.length > 0) {
        message += `\n\nThis will also delete ${linkedConvos.length} linked conversation${linkedConvos.length !== 1 ? 's' : ''}.`;
    }
    message += '\n\nThis cannot be undone.';

    if (confirm(message)) {
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
        }

        // Clear active conversation if it was deleted by the cascade.
        if (state.activeConversationId && !state.conversations[state.activeConversationId]) {
            state.activeConversationId = null;
        }

        await renderPersonaList();
        renderConversationList();
        renderConversation();
        await updateUI();
    }
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
    await renderPersonaList();
    editPersona(id);
}

// ===== Projects =====

/**
 * Render the project list in the projects tab.
 */
function renderProjectList() {
    const container = elements.projectList;
    container.innerHTML = '';

    const projects = Object.values(state.projects);
    projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    if (projects.length === 0) {
        elements.noProjectsMessage.style.display = 'block';
        return;
    }
    elements.noProjectsMessage.style.display = 'none';

    projects.forEach(project => {
        const item = document.createElement('div');
        item.className = `project-item ${project.id === state.activeProjectId ? 'active' : ''}`;
        item.dataset.projectId = project.id;

        const count = project.fileCount || 0;
        const meta = `${count} file${count !== 1 ? 's' : ''}`;

        item.innerHTML = `
            <div class="project-info" data-project-id="${project.id}">
                <span class="project-name">${escapeHtml(project.name || 'Untitled Project')}</span>
                <span class="project-meta">${meta}</span>
            </div>
            <button class="project-menu-btn" data-project-id="${project.id}" title="Options">⋯</button>
        `;

        container.appendChild(item);
    });

    // Clicking a project opens it for editing (file management arrives in P1-09).
    container.querySelectorAll('.project-info').forEach(info => {
        info.addEventListener('click', () => editProject(info.dataset.projectId));
    });

    container.querySelectorAll('.project-menu-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            showProjectMenu(btn, btn.dataset.projectId);
        });
    });
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
 * Open the project modal. Pass a projectId to edit, or null/omit to create.
 * Unlike personas, projects are created via the modal's Save (which also makes
 * the Drive folder) so an abandoned "New Project" never creates anything.
 * @param {string|null} [projectId]
 */
function openProjectModal(projectId = null) {
    state.ui.editingProjectId = projectId;
    const project = projectId ? state.projects[projectId] : null;

    elements.projectModalTitle.textContent = project ? 'Edit Project' : 'New Project';
    elements.projectNameInput.value = project ? (project.name || '') : '';
    elements.projectInstructionsInput.value = project ? (project.instructions || '') : '';

    closeSidebar(); // close the mobile drawer if open
    elements.projectModal.classList.add('visible');
    elements.projectNameInput.focus();
}

function closeProjectModal() {
    elements.projectModal.classList.remove('visible');
    state.ui.editingProjectId = null;
}

/**
 * Save the project modal — create or update depending on editingProjectId.
 */
async function saveProject() {
    const name = elements.projectNameInput.value.trim();
    const instructions = elements.projectInstructionsInput.value;

    if (!name) {
        showToast('Project name is required.', { type: 'error' });
        elements.projectNameInput.focus();
        return;
    }

    const editingId = state.ui.editingProjectId;
    elements.saveProjectBtn.disabled = true;
    try {
        if (editingId) {
            const updated = await API.projects.update(editingId, { name, instructions });
            state.projects[editingId] = {
                ...state.projects[editingId],
                name: updated.name,
                instructions: updated.instructions,
                updatedAt: updated.updatedAt,
            };
        } else {
            const created = await API.projects.create({ name, instructions });
            state.projects[created.id] = {
                id: created.id,
                name: created.name,
                instructions: created.instructions || '',
                fileCount: created.fileCount || 0,
                createdAt: created.createdAt,
                updatedAt: created.updatedAt,
            };
        }
    } catch (err) {
        console.error('Failed to save project:', err);
        displayError(err, { action: 'save project' });
        return;
    } finally {
        elements.saveProjectBtn.disabled = false;
    }

    closeProjectModal();
    renderProjectList();
}

/**
 * Open the modal to create a new project.
 */
function startNewProject() {
    openProjectModal(null);
}

/**
 * Open the modal to edit an existing project.
 * @param {string} projectId
 */
function editProject(projectId) {
    if (!state.projects[projectId]) return;
    openProjectModal(projectId);
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
    let message = `Delete project "${project.name}"?`;
    if (count > 0) {
        message += `\n\nIts ${count} file${count !== 1 ? 's' : ''} will be moved to your Google Drive trash.`;
    }
    message += '\n\nConversations using this project will keep working without its context.';

    if (!confirm(message)) return;

    try {
        await API.projects.delete(projectId);
    } catch (err) {
        console.error('Failed to delete project:', err);
        displayError(err, { action: 'delete project' });
        return;
    }

    delete state.projects[projectId];
    if (state.activeProjectId === projectId) {
        state.activeProjectId = null;
    }
    renderProjectList();
}

/**
 * Format a timestamp as relative time (e.g., "2 hours ago")
 * @param {number} timestamp
 * @returns {string}
 */
function formatTimeAgo(timestamp) {
    if (!timestamp) return '';

    const now = Date.now();
    const diff = now - timestamp;

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;

    // Format as date for older items
    const date = new Date(timestamp);
    return date.toLocaleDateString();
}

/**
 * Escape HTML entities to prevent XSS
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ===== Expression Detection =====
function detectExpression(text) {
    const persona = getActivePersona();
    const expressions = persona ? persona.expressions : CONFIG.defaultExpressions;

    // First, check for explicit expression tag
    const tagMatch = text.match(/\[expression:\s*(\w+)\]/i);
    if (tagMatch) {
        const exprName = tagMatch[1].toLowerCase();
        if (expressions[exprName]) {
            return exprName;
        }
    }

    // Fallback: keyword matching
    const lowerText = text.toLowerCase();

    for (const [name, expr] of Object.entries(expressions)) {
        if (name === 'neutral') continue; // Skip neutral for keyword matching

        for (const keyword of expr.keywords) {
            if (lowerText.includes(keyword)) {
                return name;
            }
        }
    }

    // Default to current expression (don't change if nothing detected)
    return state.currentExpression;
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

// ===== Conversation Rendering =====
function renderConversation() {
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
                <p>${hasApiKey ? 'Start chatting with ' + assistantName + '!' : 'Configure your API key in the settings (☰) to get started.'}</p>
            </div>
        `;
        return;
    }

    messages.forEach((msg, index) => {
        appendMessage(msg.role, msg.content, false, index, msg.attachments);
    });

    scrollToBottom();
}

async function appendMessage(role, content, save = true, explicitIndex = null, attachments = null) {
    const welcome = elements.messagesContainer.querySelector('.welcome-message');
    if (welcome) {
        welcome.remove();
    }

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
            const msg = { role, content: displayContent, attachments: attachments || [] };
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

// ===== Error Display System (P0-17) =====
//
// Three presentation surfaces, chosen by severity/context:
//   - showToast()          : transient notifications (bottom-right, auto-dismiss)
//   - appendErrorMessage() : inline chat errors (tied to a conversation turn)
//   - showCriticalBanner() : persistent top banner for errors needing action
//
// displayError() is the central dispatcher: hand it any thrown error and a
// context hint, and it routes to the right surface based on the ApiError code.

// --- Toast manager ---
const TOAST_MAX = 3;
const TOAST_DEFAULT_MS = 5000;
const TOAST_DEDUPE_MS = 2000;
const _toastIcons = { error: '⛔', warning: '⚠️', success: '✓', info: 'ℹ️' };
// Tracks recently-shown toast keys to suppress duplicate spam.
const _recentToasts = new Map(); // key -> timestamp

/**
 * Show a transient toast notification.
 * @param {string} message - Text to display.
 * @param {Object} [opts]
 * @param {'error'|'warning'|'success'|'info'} [opts.type='info']
 * @param {number} [opts.duration] - ms before auto-dismiss; 0 = sticky. Defaults by type.
 * @param {string} [opts.key] - Dedupe key; defaults to type+message.
 * @returns {HTMLElement|null} The toast element (or null if deduped/suppressed).
 */
function showToast(message, opts = {}) {
    const container = elements.toastContainer;
    if (!container) return null;

    const type = opts.type || 'info';
    const key = opts.key || `${type}:${message}`;
    const now = Date.now();

    // Prune dedupe entries older than the window so the Map can't grow
    // unbounded over a long session with many distinct messages.
    for (const [k, t] of _recentToasts) {
        if (now - t >= TOAST_DEDUPE_MS) _recentToasts.delete(k);
    }

    // Dedupe: skip if an identical toast fired within the dedupe window.
    const last = _recentToasts.get(key);
    if (last && now - last < TOAST_DEDUPE_MS) return null;
    _recentToasts.set(key, now);

    // Cap stacked toasts: drop the oldest *non-hiding* toast when over the
    // limit. Toasts mid-dismiss (class toast-hiding) linger ~300ms during the
    // fade; counting them would let the cap evict a fully-visible newer toast.
    let live = Array.from(container.children).filter(c => !c.classList.contains('toast-hiding'));
    while (live.length >= TOAST_MAX) {
        const oldest = live.shift();
        if (oldest) oldest.remove();
    }

    const duration = opts.duration !== undefined
        ? opts.duration
        : (type === 'error' ? 8000 : TOAST_DEFAULT_MS);

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = _toastIcons[type] || _toastIcons.info;

    const body = document.createElement('div');
    body.className = 'toast-body';
    const msg = document.createElement('div');
    msg.className = 'toast-message';
    msg.textContent = message;
    body.appendChild(msg);

    const dismiss = document.createElement('button');
    dismiss.className = 'toast-dismiss';
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Dismiss notification');
    dismiss.textContent = '×';

    let timer = null;
    const remove = () => {
        if (timer) clearTimeout(timer);
        if (!toast.parentNode) return;
        toast.classList.add('toast-hiding');
        toast.addEventListener('animationend', () => toast.remove(), { once: true });
        // Fallback in case animationend doesn't fire.
        setTimeout(() => { if (toast.parentNode) toast.remove(); }, 300);
    };
    dismiss.addEventListener('click', remove);

    toast.appendChild(icon);
    toast.appendChild(body);
    toast.appendChild(dismiss);
    container.appendChild(toast);

    if (duration > 0) {
        timer = setTimeout(remove, duration);
    }

    return toast;
}

/**
 * Show the persistent critical banner at the top of the page.
 * @param {string} message
 * @param {Object} [opts]
 * @param {string} [opts.actionLabel] - If set, shows an action button.
 * @param {Function} [opts.onAction] - Click handler for the action button.
 */
function showCriticalBanner(message, opts = {}) {
    const banner = elements.criticalBanner;
    // Guard the inner nodes too — a partial HTML edit shouldn't turn an error
    // display into an uncaught TypeError.
    if (!banner || !elements.criticalBannerMessage) return;

    elements.criticalBannerMessage.textContent = message;

    const actionBtn = elements.criticalBannerAction;
    if (actionBtn && opts.actionLabel && typeof opts.onAction === 'function') {
        actionBtn.textContent = opts.actionLabel;
        actionBtn.hidden = false;
        // Replace handler by cloning to drop any prior listeners.
        const fresh = actionBtn.cloneNode(true);
        fresh.addEventListener('click', opts.onAction);
        actionBtn.parentNode.replaceChild(fresh, actionBtn);
        elements.criticalBannerAction = fresh;
    } else if (actionBtn) {
        actionBtn.hidden = true;
    }

    banner.hidden = false;
}

function hideCriticalBanner() {
    if (elements.criticalBanner) elements.criticalBanner.hidden = true;
}

/**
 * Render an inline error message inside the chat thread.
 * @param {Error|string} error - An ApiError, generic Error, or plain string.
 * @param {Object} [opts]
 * @param {Function} [opts.retryHandler] - If set, renders a Retry button.
 */
function appendErrorMessage(error, opts = {}) {
    const isApiError = error && error.name === 'ApiError';
    const code = isApiError ? error.code : null;
    const message = (typeof error === 'string')
        ? error
        : (error && error.message) || 'An unexpected error occurred.';

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message error';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    // Headline with optional code badge.
    const headline = document.createElement('div');
    headline.className = 'error-headline';
    const headlineText = document.createElement('span');
    headlineText.textContent = 'Something went wrong';
    headline.appendChild(headlineText);
    if (code) {
        const badge = document.createElement('span');
        badge.className = 'error-code-badge';
        badge.textContent = code;
        headline.appendChild(badge);
    }
    contentDiv.appendChild(headline);

    // Human-readable message.
    const detail = document.createElement('p');
    detail.className = 'error-detail-text';
    detail.textContent = message;
    contentDiv.appendChild(detail);

    // Collapsible technical details (status + any structured details).
    if (isApiError && (error.status || error.details)) {
        const details = document.createElement('details');
        details.className = 'error-details';
        const summary = document.createElement('summary');
        summary.textContent = 'Technical details';
        details.appendChild(summary);
        const pre = document.createElement('pre');
        const techLines = [];
        if (error.status) techLines.push(`HTTP ${error.status}`);
        if (error.details) {
            try {
                techLines.push(typeof error.details === 'string'
                    ? error.details
                    : JSON.stringify(error.details, null, 2));
            } catch (_) { /* ignore serialization issues */ }
        }
        pre.textContent = techLines.join('\n');
        details.appendChild(pre);
        contentDiv.appendChild(details);
    }

    // Optional retry button.
    if (typeof opts.retryHandler === 'function') {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'error-retry-btn';
        retryBtn.type = 'button';
        retryBtn.textContent = 'Retry';
        // Not {once:true}: if a send is still in flight we keep the button (and
        // the error bubble) so the user can retry once it settles. Only remove
        // the bubble when we actually hand off to the retry handler — otherwise
        // a no-op retry (isLoading) would destroy the error + retry affordance.
        retryBtn.addEventListener('click', () => {
            if (state.isLoading) {
                showToast('Please wait for the current response to finish, then retry.', { type: 'warning' });
                return;
            }
            messageDiv.remove();
            opts.retryHandler();
        });
        contentDiv.appendChild(retryBtn);
    }

    messageDiv.appendChild(contentDiv);
    elements.messagesContainer.appendChild(messageDiv);
    scrollToBottom();
    return messageDiv;
}

/**
 * Central error dispatcher. Routes any caught error to the appropriate
 * presentation surface based on its ApiError code.
 * @param {Error} error - The caught error (ideally an ApiError).
 * @param {Object} [context]
 * @param {'chat'|'background'} [context.surface='background'] - Where the
 *        error originated. 'chat' allows inline rendering for provider errors.
 * @param {Function} [context.retryHandler] - Retry callback for chat errors.
 * @param {string} [context.action] - Short verb describing the failed action,
 *        e.g. "save settings", used to make toast text specific.
 */
function displayError(error, context = {}) {
    // Swallow user-initiated aborts entirely — not an error to surface.
    if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERROR')) {
        return;
    }

    const surface = context.surface || 'background';
    const code = (error && error.name === 'ApiError') ? error.code : 'UNKNOWN_ERROR';
    const baseMsg = (error && error.message) || 'An unexpected error occurred.';
    const actionPrefix = context.action ? `Couldn't ${context.action}: ` : '';
    // retryAfter may legitimately be 0 (retry immediately); only fall back to
    // 60 when it's actually absent.
    const retrySecs = (error && typeof error.retryAfter === 'number') ? error.retryAfter : 60;

    // 401s are handled globally (the on401 handler reloads to the login
    // screen). Rendering a chat bubble that the imminent reload discards is
    // pointless, so AUTH_ERROR always takes the toast fallback regardless of
    // surface.
    if (code === 'AUTH_ERROR') {
        showToast('Your session has expired. Please sign in again.', {
            type: 'warning', key: 'auth-expired',
        });
        return;
    }

    // Chat-turn failures get a DURABLE inline error in the thread (with Retry),
    // whatever the code. The user's message is sitting there awaiting a reply,
    // so an auto-dismissing toast would lose that context once it fades. For
    // rate limits we additionally toast the wait time.
    if (surface === 'chat') {
        appendErrorMessage(error, { retryHandler: context.retryHandler });
        if (code === 'RATE_LIMITED') {
            showToast(`Rate limit reached. Try again in ${retrySecs}s.`, {
                type: 'warning', key: 'rate-limited',
            });
        }
        return;
    }

    // Background (non-chat) failures route by code to the right surface.
    switch (code) {
        case 'RATE_LIMITED':
            showToast(`Rate limit reached. Try again in ${retrySecs}s.`, {
                type: 'warning', key: 'rate-limited',
            });
            return;

        case 'VALIDATION_ERROR':
            showToast(`${actionPrefix}${baseMsg}`, { type: 'warning' });
            return;

        case 'DRIVE_ERROR':
            // Drive integration is Phase 1; banner path is dormant but wired.
            showCriticalBanner(`Google Drive error: ${baseMsg}`);
            return;

        case 'PROVIDER_ERROR':
        case 'NOT_FOUND':
        case 'SERVER_ERROR':
        case 'NETWORK_ERROR':
        default:
            showToast(`${actionPrefix}${baseMsg}`, { type: 'error' });
            return;
    }
}

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

function scrollToBottom() {
    elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
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

    if (!confirm('Delete this message?')) return;

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

    state.isLoading = true;
    updateSendButtonState();

    await appendMessage('user', text, true, null, attachments.length > 0 ? attachments : null);
    showTypingIndicator();

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
        displayError(error, { surface: 'chat', retryHandler: retryLastUserMessage });
        console.error('API Error:', error);
    } finally {
        state.isLoading = false;
        updateSendButtonState();
    }
}

// Helper: render attachments in a message
function renderMessageAttachments(attachments, containerDiv) {
    if (!attachments || attachments.length === 0) return;

    attachments.forEach(att => {
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

            const badge = document.createElement('span');
            badge.className = 'att-badge';
            badge.textContent = getFileTypeLabel(att.fileName, att.mimeType);
            attEl.appendChild(badge);

            const iconDiv = document.createElement('div');
            iconDiv.className = 'att-icon';
            iconDiv.textContent = getFileIcon(att.mimeType);
            attEl.appendChild(iconDiv);

            const nameDiv = document.createElement('div');
            nameDiv.className = 'att-name';
            nameDiv.textContent = att.fileName || 'File';
            nameDiv.title = att.fileName || 'File';
            attEl.appendChild(nameDiv);
        }

        containerDiv.appendChild(attEl);
    });
}

function getFileCategory(mimeType) {
    if (!mimeType) return 'document';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType === 'application/pdf' || mimeType === 'text/plain' || mimeType === 'text/csv' || mimeType === 'text/markdown') return 'document';
    if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') return 'code';
    return 'document';
}

function getFileIcon(mimeType) {
    const category = getFileCategory(mimeType);
    switch (category) {
        case 'image': return '\u{1F5BC}';
        case 'audio': return '\u{1F3B5}';
        case 'code': return '\u{1F4BB}';
        case 'document': return '\u{1F4C4}';
        default: return '\u{1F4CE}';
    }
}

// Short uppercase label for an attachment's type badge — the file extension
// when it's a sane length, else a category fallback (IMG/AUDIO/CODE/DOC).
function getFileTypeLabel(fileName, mimeType) {
    if (fileName && fileName.includes('.')) {
        const ext = fileName.split('.').pop();
        if (ext && ext.length >= 1 && ext.length <= 4 && /^[a-z0-9]+$/i.test(ext)) {
            return ext.toUpperCase();
        }
    }
    return ({ image: 'IMG', audio: 'AUDIO', code: 'CODE', document: 'DOC' })[getFileCategory(mimeType)] || 'FILE';
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

    elements.messageInput.value = '';
    elements.messageInput.style.height = 'auto';
    state.isLoading = true;
    updateSendButtonState();

    // Store attachments to IndexedDB and get metadata
    let attachmentMeta = [];
    if (hasAttachments) {
        attachmentMeta = await storeAttachmentsToIndexedDB(state.pendingAttachments);
        state.pendingAttachments = [];
        renderAttachmentPreviews();
    }

    await appendMessage('user', userMessage || '(attached files)', true, null, attachmentMeta.length > 0 ? attachmentMeta : null);

    if (modelConfig.modelParams.streaming) {
        // Streaming path
        showTypingIndicator();
        elements.sendButton.style.display = 'none';
        elements.stopButton.style.display = '';

        try {
            hideTypingIndicator();
            startStreamingMessage();
            // Pin the conversation id at send-time so a mid-stream switch
            // doesn't redirect the assistant reply.
            const targetConvoId = state.activeConversationId;

            // callAPIStreaming always returns { text, generatedImages }
            // — including on abort (api-client swallows AbortError and we
            // finalize with the accumulator-so-far).
            const result = await callAPIStreaming(userMessage, attachmentMeta);
            await finalizeStreamingMessage(result.text || '', result.generatedImages || [], targetConvoId);
        } catch (error) {
            // Real error path; abort flows through normally now.
            if (state.streamingMessageDiv) {
                state.streamingMessageDiv.remove();
                state.streamingMessageDiv = null;
            }
            hideTypingIndicator();
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

        try {
            const response = await callAPI(userMessage, attachmentMeta);

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
    const prefillText = persona?.prefill?.trim() || '';

    // The model echoes back the prefill — track it so appendStreamChunk and
    // the non-streaming branch can strip it from displayed/persisted output.
    state.currentPrefill = prefillText;

    const messages = conversationMessages.map(msg => ({
        role: msg.role,
        content: msg.content,
    }));

    return {
        provider: modelConfig.provider,
        model: modelConfig.model,
        messages,
        systemPrompt,
        modelParams: modelConfig.modelParams,
        ...(prefillText ? { prefill: prefillText } : {}),
    };
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

    const res = await API.chat.send(params);
    const generatedAttachments = res.generatedImages
        ? await storeGeneratedImages(res.generatedImages)
        : [];
    return { text: res.text || '', attachments: generatedAttachments };
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

    await API.chat.stream(params, (ev) => {
        if (!ev.data) return;
        let payload;
        try { payload = JSON.parse(ev.data); } catch { return; }

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
    messageDiv.appendChild(contentDiv);
    elements.messagesContainer.appendChild(messageDiv);

    state.streamingMessageDiv = messageDiv;
    state.streamingAccumulator = '';
    state.streamingGeneratedImages = [];

    scrollToBottom();
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
            contentDiv.innerHTML = renderMarkdown(displayText);
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

    // Persist generated images to IndexedDB and produce attachment metadata.
    const attachments = await storeGeneratedImages(generatedImages);

    // Bail-out for empty results (e.g., user clicked Stop before any chunk
    // arrived). Persisting an empty assistant turn would pollute the
    // conversation context on the next send. Remove the empty bubble too.
    if (!cleanText.trim() && attachments.length === 0) {
        state.streamingMessageDiv.remove();
        state.streamingMessageDiv = null;
        state.streamingAccumulator = '';
        state.streamingGeneratedImages = [];
        return;
    }

    // Render any generated images above the text content.
    if (attachments.length > 0) {
        const attachDiv = document.createElement('div');
        attachDiv.className = 'message-attachments';
        renderMessageAttachments(attachments, attachDiv);
        const contentDiv = state.streamingMessageDiv.querySelector('.message-content');
        if (contentDiv) state.streamingMessageDiv.insertBefore(attachDiv, contentDiv);
    }

    const contentDiv = state.streamingMessageDiv.querySelector('.message-content');
    if (contentDiv) {
        if (!cleanText && attachments.length > 0) {
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

    // Sidebar tabs
    document.querySelectorAll('.sidebar-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            switchTab(tab.dataset.tab);
        });
    });

    // Settings modal: relocate it to <body> so it overlays as a top-level
    // element rather than living inside the sidebar's stacking context.
    if (elements.settingsModal && elements.settingsModal.parentElement !== document.body) {
        document.body.appendChild(elements.settingsModal);
    }
    if (elements.openSettingsBtn) {
        elements.openSettingsBtn.addEventListener('click', openSettingsModal);
    }
    if (elements.closeSettingsModal) {
        elements.closeSettingsModal.addEventListener('click', closeSettingsModal);
    }
    if (elements.settingsModal) {
        elements.settingsModal.addEventListener('click', (e) => {
            if (e.target === elements.settingsModal) closeSettingsModal();
        });
    }
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && elements.settingsModal && elements.settingsModal.classList.contains('visible')) {
            closeSettingsModal();
        }
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
    if (elements.accentPicker) {
        elements.accentPicker.addEventListener('input', () => {
            UiPrefs.set('accent', elements.accentPicker.value);
            withThemeTransition(() => applyAccent(elements.accentPicker.value));
        });
    }
    if (elements.accentResetBtn) {
        elements.accentResetBtn.addEventListener('click', () => {
            UiPrefs.set('accent', '');
            withThemeTransition(() => applyAccent(''));
            syncAppearanceControls();
        });
    }

    // Chats tab controls
    elements.newChatBtn.addEventListener('click', startNewConversation);
    elements.personaFilter.addEventListener('change', (e) => {
        state.ui.conversationFilter = e.target.value === 'all' ? 'all' : e.target.value;
        renderConversationList();
    });

    // Personas tab controls
    elements.newPersonaBtn.addEventListener('click', startNewPersona);

    // Projects tab controls
    elements.newProjectBtn.addEventListener('click', startNewProject);
    elements.closeProjectModal.addEventListener('click', closeProjectModal);
    elements.saveProjectBtn.addEventListener('click', saveProject);
    elements.projectModal.addEventListener('click', (e) => {
        if (e.target === elements.projectModal) closeProjectModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && elements.projectModal.classList.contains('visible')) {
            closeProjectModal();
        }
    });

    // Close any open context menus when clicking elsewhere
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.context-menu') && !e.target.closest('.conversation-menu-btn') && !e.target.closest('.persona-menu-btn') && !e.target.closest('.project-menu-btn')) {
            const existingMenu = document.querySelector('.context-menu');
            if (existingMenu) existingMenu.remove();
        }
    });

    // Provider & Model - auto-save on change
    elements.providerSelect.addEventListener('change', (e) => {
        handleProviderChange(e.target.value);
        autoSaveSettings();
    });
    elements.modelSelect.addEventListener('change', autoSaveSettings);

    // API Key - auto-save on input
    elements.apiKeyInput.addEventListener('input', autoSaveSettings);

    // Model parameter sliders - update display value and auto-save
    elements.temperatureSlider.addEventListener('input', (e) => {
        const value = (e.target.value / 100).toFixed(2);
        elements.tempValue.textContent = value;
        autoSaveSettings();
    });

    elements.topPSlider.addEventListener('input', (e) => {
        const value = (e.target.value / 100).toFixed(2);
        elements.topPValue.textContent = value;
        autoSaveSettings();
    });

    // Other model params - auto-save on change
    elements.topKInput.addEventListener('input', autoSaveSettings);
    elements.maxTokensInput.addEventListener('input', autoSaveSettings);
    elements.streamingToggle.addEventListener('change', autoSaveSettings);

    // Parameter enable checkboxes - toggle disabled state and auto-save
    elements.temperatureEnabled.addEventListener('change', () => {
        updateParamGroupDisabledState();
        autoSaveSettings();
    });
    elements.topPEnabled.addEventListener('change', () => {
        updateParamGroupDisabledState();
        autoSaveSettings();
    });
    elements.topKEnabled.addEventListener('change', () => {
        updateParamGroupDisabledState();
        autoSaveSettings();
    });

    // Stop sequences - add on Enter
    elements.stopSequenceInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addStopSequence();
        }
    });

    // Anthropic settings - auto-save
    elements.thinkingEnabledToggle.addEventListener('change', (e) => {
        elements.thinkingBudgetGroup.style.display = e.target.checked ? 'block' : 'none';
        autoSaveSettings();
    });
    elements.thinkingBudgetInput.addEventListener('input', autoSaveSettings);

    // Gemini settings - auto-save
    elements.thinkingLevelSelect.addEventListener('change', autoSaveSettings);
    elements.mediaResolutionSelect.addEventListener('change', autoSaveSettings);
    elements.safetyHarassmentSelect.addEventListener('change', autoSaveSettings);
    elements.safetyHateSelect.addEventListener('change', autoSaveSettings);
    elements.safetySexualSelect.addEventListener('change', autoSaveSettings);
    elements.safetyDangerousSelect.addEventListener('change', autoSaveSettings);

    // Persona settings - auto-save
    elements.assistantName.addEventListener('input', autoSaveSettings);
    elements.systemPrompt.addEventListener('input', autoSaveSettings);
    elements.prefillInput.addEventListener('input', autoSaveSettings);

    // API key visibility toggle
    elements.toggleApiKey.addEventListener('click', () => {
        const input = elements.apiKeyInput;
        input.type = input.type === 'password' ? 'text' : 'password';
    });

    // Explicit Clear-saved-key handler (the safe, intentional path for
    // deleting a stored key — emptying the input does NOT do this).
    if (elements.clearApiKeyBtn) {
        elements.clearApiKeyBtn.addEventListener('click', clearStoredApiKey);
    }
    
    // Size preset buttons — set a named size, sync the slider, re-render, save.
    document.querySelectorAll('.size-preset-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            state.settings.avatarSize = btn.dataset.size;
            syncAvatarSizeControls();
            await updateFloatingAvatar();
            autoSaveSettings();
        });
    });

    // Position preset buttons — set a corner, re-render, save.
    document.querySelectorAll('.position-preset-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            state.settings.avatarPosition = btn.dataset.position;
            syncAvatarPositionControls();
            await updateFloatingAvatar();
            autoSaveSettings();
        });
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
    elements.showAvatar.addEventListener('change', async () => {
        state.settings.showAvatar = elements.showAvatar.checked;
        await updateFloatingAvatar();
        elements.avatarToggleBtn.classList.toggle('active', state.settings.showAvatar);
        autoSaveSettings();
    });

    // Avatar toggle button in status bar
    elements.avatarToggleBtn.addEventListener('click', async () => {
        state.settings.showAvatar = !state.settings.showAvatar;
        elements.showAvatar.checked = state.settings.showAvatar;
        await updateFloatingAvatar();
        elements.avatarToggleBtn.classList.toggle('active', state.settings.showAvatar);
        autoSaveSettings();
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

    // Model management modal
    elements.manageModelsBtn.addEventListener('click', openModelModal);
    elements.closeModelModal.addEventListener('click', closeModelModal);
    elements.fetchModelsBtn.addEventListener('click', handleFetchModels);
    elements.addModelBtn.addEventListener('click', handleAddModelManually);

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
        if (e.key === 'Enter' && !e.shiftKey) {
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
    
    // Model select change
    elements.modelSelect.addEventListener('change', () => {
        elements.modelIndicator.textContent = getModelDisplayName(elements.modelSelect.value);
    });
    
    // Assistant name preview
    elements.assistantName.addEventListener('input', () => {
        elements.avatarPreviewName.textContent = elements.assistantName.value || 'Assistant';
    });
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

// ===== Sidebar Functions =====
function createSidebarOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    overlay.id = 'sidebarOverlay';
    document.body.appendChild(overlay);
    
    overlay.addEventListener('click', closeSidebar);
}

function openSidebar() {
    elements.sidebar.classList.add('open');
    const overlay = document.getElementById('sidebarOverlay');
    if (overlay) overlay.classList.add('visible');
}

function closeSidebar() {
    elements.sidebar.classList.remove('open');
    const overlay = document.getElementById('sidebarOverlay');
    if (overlay) overlay.classList.remove('visible');
}

// Drag the handle on the sidebar's right edge to resize it (desktop only).
// Width is clamped, persisted per-device, and reset on double-click. Persists
// once at gesture end (not on every move) to avoid storage thrash.
function setupSidebarResize() {
    const handle = document.getElementById('sidebarResizeHandle');
    if (!handle) return;

    const MIN_W = 240;
    const maxW = () => Math.min(640, Math.round(window.innerWidth * 0.5));
    const clamp = (w) => Math.max(MIN_W, Math.min(maxW(), Math.round(w)));

    let dragging = false;
    let startX = 0;
    let startW = 0;
    let currentW = UiPrefs.get('sidebarWidth') || 320;

    const applyLive = (w) => {
        currentW = clamp(w);
        document.documentElement.style.setProperty('--sidebar-width', `${currentW}px`);
    };

    handle.addEventListener('pointerdown', (e) => {
        dragging = true;
        startX = e.clientX;
        // Measure the rendered width (honors the min(var, 85vw) cap).
        startW = elements.sidebar.getBoundingClientRect().width;
        handle.classList.add('dragging');
        try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        e.preventDefault();
    });

    handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        applyLive(startW + (e.clientX - startX)); // drag right widens
    });

    const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove('dragging');
        try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        UiPrefs.set('sidebarWidth', currentW); // persist once, at gesture end
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);

    handle.addEventListener('dblclick', () => {
        applyLive(UiPrefs.defaults.sidebarWidth);
        UiPrefs.set('sidebarWidth', currentW);
    });
}

// ===== Utility Functions =====
function autoResizeTextarea(textarea) {
    // Grow to fit content; CSS max-height caps it (then the textarea scrolls).
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
}

// Wire the themed bottom drag-bars that replace the native textarea grip.
// Each `.textarea-resize-handle` resizes the textarea immediately before it.
function setupTextareaResizers() {
    const MIN_H = 80;
    const MAX_H = 600;
    document.querySelectorAll('.textarea-resize-handle').forEach(handle => {
        const ta = handle.previousElementSibling;
        if (!ta || ta.tagName !== 'TEXTAREA') return;

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
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    });
}

async function clearConversation() {
    if (confirm('Are you sure you want to clear the conversation? This cannot be undone.')) {
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
    // - Stops the startSessionTimer setInterval
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

// ===== Start the App =====
document.addEventListener('DOMContentLoaded', bootstrap);
