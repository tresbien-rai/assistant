/**
 * AI Assistant - Main Application Logic
 * 
 * Features:
 * - Multi-provider API support (Claude, with OpenAI/Gemini coming)
 * - Customizable personas with system prompts
 * - Floating avatar with expression system
 * - Status bar with session info
 * - Settings persistence via localStorage
 */

// ===== Configuration =====
const CONFIG = {
    endpoints: {
        anthropic: 'https://api.anthropic.com/v1/messages'
    },
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
    storageKeys: {
        settings: 'ai_assistant_settings',
        conversations: 'ai_assistant_conversations',
        expressions: 'ai_assistant_expressions', // Legacy, kept for migration
        personas: 'ai_assistant_personas',
        appData: 'ai_assistant_data', // Unified storage with schema version
        backup: 'ai_assistant_backup' // Backup before migrations
    }
};

// ===== Schema Version & Migrations =====
const CURRENT_SCHEMA_VERSION = 1;

/**
 * Migration functions indexed by target version.
 * Each migration transforms data from (version - 1) to version.
 * Migrations receive the full stored data object and return the migrated version.
 */
const migrations = {
    /**
     * Migration 1: Initial restructure
     * - Converts flat conversation array to multi-conversation format
     * - Converts settings + expressions to personas format
     * - Migrates Base64 images to IndexedDB keys
     */
    1: async (data) => {
        console.log('[Migration 1] Starting: Initial restructure...');
        const result = {
            schemaVersion: 1,
            settings: {},
            personas: {},
            conversations: {},
            activePersonaId: null,
            activeConversationId: null
        };

        // Migrate settings (extract app-level settings only)
        const oldSettings = data.settings || {};
        result.settings = {
            provider: oldSettings.provider || CONFIG.defaults.provider,
            model: oldSettings.model || CONFIG.defaults.model,
            apiKey: oldSettings.apiKey || '',
            avatarSize: oldSettings.avatarSize || CONFIG.defaults.avatarSize,
            avatarPosition: oldSettings.avatarPosition || CONFIG.defaults.avatarPosition,
            showAvatar: oldSettings.showAvatar !== undefined ? oldSettings.showAvatar : CONFIG.defaults.showAvatar
        };

        // Migrate personas
        if (data.personas && Object.keys(data.personas).length > 0) {
            // Already has personas - copy them
            result.personas = data.personas;
            // Set active to most recently updated
            const personaList = Object.values(result.personas);
            if (personaList.length > 0) {
                const mostRecent = personaList.reduce((a, b) =>
                    (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a
                );
                result.activePersonaId = mostRecent.id;
            }
        } else if (oldSettings.assistantName) {
            // Migrate from old settings + expressions format
            console.log('[Migration 1] Converting old settings to persona...');
            const id = crypto.randomUUID();
            const now = Date.now();

            let expressions = { ...CONFIG.defaultExpressions };
            if (data.expressions) {
                expressions = data.expressions;
            }

            result.personas[id] = {
                id,
                name: oldSettings.assistantName || CONFIG.defaults.assistantName,
                systemPrompt: oldSettings.systemPrompt || CONFIG.defaults.systemPrompt,
                avatarImageKey: oldSettings.avatarKey || '',
                expressions,
                createdAt: now,
                updatedAt: now
            };
            result.activePersonaId = id;
        }

        // Create default persona if still none
        if (Object.keys(result.personas).length === 0) {
            console.log('[Migration 1] Creating default persona...');
            const id = crypto.randomUUID();
            const now = Date.now();
            result.personas[id] = {
                id,
                name: CONFIG.defaults.assistantName,
                systemPrompt: CONFIG.defaults.systemPrompt,
                avatarImageKey: '',
                expressions: { ...CONFIG.defaultExpressions },
                createdAt: now,
                updatedAt: now
            };
            result.activePersonaId = id;
        }

        // Migrate conversations
        if (data.conversations) {
            if (Array.isArray(data.conversations)) {
                // Old format: flat array of messages
                if (data.conversations.length > 0) {
                    console.log('[Migration 1] Converting flat conversation array...');
                    const id = crypto.randomUUID();
                    const now = Date.now();

                    const firstUserMsg = data.conversations.find(m => m.role === 'user');
                    const title = firstUserMsg
                        ? generateConversationTitle(firstUserMsg.content)
                        : 'Migrated Chat';

                    result.conversations[id] = {
                        id,
                        title,
                        personaId: result.activePersonaId,
                        createdAt: now,
                        updatedAt: now,
                        messages: data.conversations
                    };
                    result.activeConversationId = id;
                }
            } else if (typeof data.conversations === 'object') {
                // Already multi-conversation format
                result.conversations = data.conversations;

                // Ensure all conversations have personaId
                for (const convo of Object.values(result.conversations)) {
                    if (!convo.personaId && result.activePersonaId) {
                        convo.personaId = result.activePersonaId;
                    }
                }

                // Set active to most recently updated
                const convos = Object.values(result.conversations);
                if (convos.length > 0) {
                    const mostRecent = convos.reduce((a, b) =>
                        (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a
                    );
                    result.activeConversationId = mostRecent.id;
                }
            }
        }

        // Migrate Base64 images to IndexedDB
        await migrateBase64ImagesToIndexedDB(result, oldSettings, data.expressions);

        console.log('[Migration 1] Complete.');
        return result;
    }

    // Future migrations go here:
    // 2: async (data) => { ... }
};

/**
 * Helper: Migrate Base64 image data to IndexedDB
 * Called during migration 1 to move images from localStorage to IndexedDB
 */
async function migrateBase64ImagesToIndexedDB(result, oldSettings, oldExpressions) {
    try {
        await ImageStore.init();

        // Migrate avatar image from old settings
        if (oldSettings.avatarData && oldSettings.avatarData.startsWith('data:')) {
            console.log('[Migration 1] Migrating avatar image to IndexedDB...');
            const blob = ImageStore.dataUrlToBlob(oldSettings.avatarData);
            const key = 'avatar_main';
            await ImageStore.store(key, blob);

            // Update the persona's avatar key
            const persona = Object.values(result.personas)[0];
            if (persona) {
                persona.avatarImageKey = key;
            }
        }

        // Migrate expression images
        if (oldExpressions) {
            for (const [name, expr] of Object.entries(oldExpressions)) {
                if (expr.imageData && expr.imageData.startsWith('data:')) {
                    console.log(`[Migration 1] Migrating expression image "${name}" to IndexedDB...`);
                    const blob = ImageStore.dataUrlToBlob(expr.imageData);
                    const key = `expr_${name}`;
                    await ImageStore.store(key, blob);

                    // Update the expression in personas
                    for (const persona of Object.values(result.personas)) {
                        if (persona.expressions && persona.expressions[name]) {
                            persona.expressions[name].imageKey = key;
                            delete persona.expressions[name].imageData;
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error('[Migration 1] Failed to migrate images:', error);
        // Continue with migration even if image migration fails
    }
}

/**
 * Create a backup of current data before running migrations
 * Keeps only the last 2 backups to save space
 */
function createMigrationBackup(data, fromVersion) {
    try {
        const backupKey = CONFIG.storageKeys.backup;
        const existingBackups = JSON.parse(localStorage.getItem(backupKey) || '[]');

        // Add new backup
        existingBackups.push({
            timestamp: Date.now(),
            fromVersion,
            data
        });

        // Keep only last 2 backups
        while (existingBackups.length > 2) {
            existingBackups.shift();
        }

        localStorage.setItem(backupKey, JSON.stringify(existingBackups));
        console.log(`[Migrations] Backup created (from version ${fromVersion})`);
    } catch (error) {
        console.error('[Migrations] Failed to create backup:', error);
        // Don't fail migration if backup fails
    }
}

/**
 * Load current data from all storage keys (handles both old and new formats)
 */
function loadStoredData() {
    // First check for unified storage
    const unified = localStorage.getItem(CONFIG.storageKeys.appData);
    if (unified) {
        try {
            return JSON.parse(unified);
        } catch (e) {
            console.error('[Migrations] Failed to parse unified storage:', e);
        }
    }

    // Fall back to loading from separate keys (old format)
    const data = {
        schemaVersion: 0 // Missing version means version 0
    };

    const settings = localStorage.getItem(CONFIG.storageKeys.settings);
    if (settings) {
        try {
            data.settings = JSON.parse(settings);
        } catch (e) {
            console.error('[Migrations] Failed to parse settings:', e);
        }
    }

    const personas = localStorage.getItem(CONFIG.storageKeys.personas);
    if (personas) {
        try {
            data.personas = JSON.parse(personas);
        } catch (e) {
            console.error('[Migrations] Failed to parse personas:', e);
        }
    }

    const conversations = localStorage.getItem(CONFIG.storageKeys.conversations);
    if (conversations) {
        try {
            data.conversations = JSON.parse(conversations);
        } catch (e) {
            console.error('[Migrations] Failed to parse conversations:', e);
        }
    }

    const expressions = localStorage.getItem(CONFIG.storageKeys.expressions);
    if (expressions) {
        try {
            data.expressions = JSON.parse(expressions);
        } catch (e) {
            console.error('[Migrations] Failed to parse expressions:', e);
        }
    }

    return data;
}

/**
 * Save migrated data to unified storage
 */
function saveMigratedData(data) {
    localStorage.setItem(CONFIG.storageKeys.appData, JSON.stringify(data));

    // Also save to individual keys for backward compatibility during transition
    if (data.settings) {
        localStorage.setItem(CONFIG.storageKeys.settings, JSON.stringify(data.settings));
    }
    if (data.personas) {
        localStorage.setItem(CONFIG.storageKeys.personas, JSON.stringify(data.personas));
    }
    if (data.conversations) {
        localStorage.setItem(CONFIG.storageKeys.conversations, JSON.stringify(data.conversations));
    }

    // Clean up legacy keys that are no longer needed
    localStorage.removeItem(CONFIG.storageKeys.expressions);
    localStorage.removeItem('ai_assistant_migration_v1'); // Old migration flag
}

/**
 * Run all pending migrations from current version to CURRENT_SCHEMA_VERSION
 * @returns {Promise<Object>} The migrated data
 */
async function runMigrations() {
    console.log('[Migrations] Checking for pending migrations...');

    let data = loadStoredData();
    const startVersion = data.schemaVersion || 0;

    console.log(`[Migrations] Current schema version: ${startVersion}, Target: ${CURRENT_SCHEMA_VERSION}`);

    if (startVersion >= CURRENT_SCHEMA_VERSION) {
        console.log('[Migrations] No migrations needed.');
        return data;
    }

    // Create backup before any migrations
    createMigrationBackup(data, startVersion);

    // Run each migration in sequence
    for (let version = startVersion + 1; version <= CURRENT_SCHEMA_VERSION; version++) {
        const migration = migrations[version];

        if (!migration) {
            console.error(`[Migrations] Missing migration for version ${version}!`);
            throw new Error(`Missing migration for version ${version}`);
        }

        console.log(`[Migrations] Running migration ${version}...`);

        try {
            data = await migration(data);
            data.schemaVersion = version;

            // Save after each successful migration
            saveMigratedData(data);

            console.log(`[Migrations] Migration ${version} completed successfully.`);
        } catch (error) {
            console.error(`[Migrations] Migration ${version} failed:`, error);
            throw error;
        }
    }

    console.log(`[Migrations] All migrations complete. Now at version ${CURRENT_SCHEMA_VERSION}.`);
    return data;
}

// ===== IndexedDB Image Store =====
// Stores image Blobs in IndexedDB to avoid localStorage size limits.
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

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

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
    // App-level preferences only (no persona data)
    settings: {
        provider: CONFIG.defaults.provider,
        model: CONFIG.defaults.model,
        apiKey: '',
        avatarSize: CONFIG.defaults.avatarSize,
        avatarPosition: CONFIG.defaults.avatarPosition,
        showAvatar: CONFIG.defaults.showAvatar
    },
    // Personas stored by ID for multi-persona support
    personas: {},
    activePersonaId: null,
    // Conversations stored by ID for multi-conversation support
    conversations: {},
    activeConversationId: null,
    currentExpression: 'neutral',
    isLoading: false,
    sessionStartTime: Date.now(),
    estimatedTokens: 0,
    tempExpressionBlob: null, // Blob waiting to be saved when expression is saved
    tempExpressionPreviewUrl: '', // Object URL for preview in modal
    tempExpressionCleared: false // Flag indicating user explicitly cleared the image
};

// ===== Conversation Helpers =====

/**
 * Create a new conversation and set it as active
 * @param {string} [title] - Optional title, defaults to "New Chat"
 * @returns {string} The new conversation ID
 */
function createConversation(title = 'New Chat') {
    const id = crypto.randomUUID();
    const now = Date.now();

    state.conversations[id] = {
        id,
        title,
        personaId: state.activePersonaId, // Link to current persona
        createdAt: now,
        updatedAt: now,
        messages: []
    };

    state.activeConversationId = id;
    saveConversations();

    return id;
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
 * Create a new persona and set it as active
 * @param {string} [name] - Optional name, defaults to "Assistant"
 * @returns {string} The new persona ID
 */
function createPersona(name = CONFIG.defaults.assistantName) {
    const id = crypto.randomUUID();
    const now = Date.now();

    state.personas[id] = {
        id,
        name,
        systemPrompt: CONFIG.defaults.systemPrompt,
        avatarImageKey: '',
        expressions: { ...CONFIG.defaultExpressions },
        createdAt: now,
        updatedAt: now
    };

    state.activePersonaId = id;
    savePersonas();

    return id;
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
 * Save personas to localStorage
 */
function savePersonas() {
    localStorage.setItem(CONFIG.storageKeys.personas, JSON.stringify(state.personas));
    syncUnifiedStorage();
}

// ===== DOM Elements =====
const elements = {
    // Sidebar
    sidebar: document.getElementById('sidebar'),
    openSidebar: document.getElementById('openSidebar'),
    closeSidebar: document.getElementById('closeSidebar'),
    
    // Settings inputs
    providerSelect: document.getElementById('providerSelect'),
    modelSelect: document.getElementById('modelSelect'),
    apiKeyInput: document.getElementById('apiKeyInput'),
    toggleApiKey: document.getElementById('toggleApiKey'),
    assistantName: document.getElementById('assistantName'),
    systemPrompt: document.getElementById('systemPrompt'),
    saveSettings: document.getElementById('saveSettings'),
    clearChat: document.getElementById('clearChat'),
    
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
    
    // Chat area
    messagesContainer: document.getElementById('messagesContainer'),
    messageInput: document.getElementById('messageInput'),
    sendButton: document.getElementById('sendButton'),
    
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
    avatarEmoji: document.getElementById('avatarEmoji'),
    avatarImg: document.getElementById('avatarImg'),
    floatingAvatarName: document.getElementById('floatingAvatarName'),
    floatingAvatarExpression: document.getElementById('floatingAvatarExpression')
};

// ===== Initialization =====
async function init() {
    // Initialize IndexedDB first (needed for migrations)
    await ImageStore.init();

    // Run migrations (handles all data format upgrades)
    const migratedData = await runMigrations();

    // Load state from migrated data
    loadStateFromData(migratedData);

    // Setup event listeners before UI update
    setupEventListeners();

    // Update UI (async - loads images from IndexedDB)
    await updateUI();

    createSidebarOverlay();
    startSessionTimer();

    // Clean up object URLs when page unloads
    window.addEventListener('beforeunload', () => {
        ImageStore.revokeAllURLs();
    });

    console.log('AI Assistant initialized!');
}

// ===== Settings Management =====

/**
 * Load state from migrated data object
 * Called after runMigrations() with the fully migrated data
 */
function loadStateFromData(data) {
    // Load settings
    if (data.settings) {
        state.settings = {
            provider: data.settings.provider || CONFIG.defaults.provider,
            model: data.settings.model || CONFIG.defaults.model,
            apiKey: data.settings.apiKey || '',
            avatarSize: data.settings.avatarSize || CONFIG.defaults.avatarSize,
            avatarPosition: data.settings.avatarPosition || CONFIG.defaults.avatarPosition,
            showAvatar: data.settings.showAvatar !== undefined ? data.settings.showAvatar : CONFIG.defaults.showAvatar
        };
    }

    // Load personas
    if (data.personas) {
        state.personas = data.personas;
    }

    // Set active persona
    if (data.activePersonaId && state.personas[data.activePersonaId]) {
        state.activePersonaId = data.activePersonaId;
    } else {
        // Fall back to most recently updated persona
        const personaList = Object.values(state.personas);
        if (personaList.length > 0) {
            const mostRecent = personaList.reduce((a, b) =>
                (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a
            );
            state.activePersonaId = mostRecent.id;
        }
    }

    // Load conversations
    if (data.conversations) {
        state.conversations = data.conversations;
    }

    // Set active conversation
    if (data.activeConversationId && state.conversations[data.activeConversationId]) {
        state.activeConversationId = data.activeConversationId;
    } else {
        // Fall back to most recently updated conversation
        const convos = Object.values(state.conversations);
        if (convos.length > 0) {
            const mostRecent = convos.reduce((a, b) =>
                (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a
            );
            state.activeConversationId = mostRecent.id;
        }
    }

    console.log(`Loaded state: ${Object.keys(state.personas).length} personas, ${Object.keys(state.conversations).length} conversations`);
}

/**
 * Sync all state to the unified storage
 * Called after any save operation to keep the unified storage in sync
 */
function syncUnifiedStorage() {
    const data = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        settings: state.settings,
        personas: state.personas,
        conversations: state.conversations,
        activePersonaId: state.activePersonaId,
        activeConversationId: state.activeConversationId
    };
    localStorage.setItem(CONFIG.storageKeys.appData, JSON.stringify(data));
}

async function saveSettings() {
    // Save app-level settings
    state.settings.provider = elements.providerSelect.value;
    state.settings.model = elements.modelSelect.value;
    state.settings.apiKey = elements.apiKeyInput.value;
    state.settings.showAvatar = elements.showAvatar.checked;

    // Get size from active button
    const activeSize = document.querySelector('.size-preset-btn.active');
    if (activeSize) {
        state.settings.avatarSize = activeSize.dataset.size;
    }

    // Get position from active button
    const activePosition = document.querySelector('.position-preset-btn.active');
    if (activePosition) {
        state.settings.avatarPosition = activePosition.dataset.position;
    }

    localStorage.setItem(CONFIG.storageKeys.settings, JSON.stringify(state.settings));

    // Save persona-specific settings to the active persona
    const persona = getActivePersona();
    if (persona) {
        persona.name = elements.assistantName.value || CONFIG.defaults.assistantName;
        persona.systemPrompt = elements.systemPrompt.value || CONFIG.defaults.systemPrompt;
        persona.updatedAt = Date.now();
        savePersonas(); // This also syncs to unified storage
    } else {
        // Sync to unified storage if no persona update
        syncUnifiedStorage();
    }

    await updateUI();
    showNotification('Settings saved!', 'success');
    closeSidebar();
}

function saveConversations() {
    localStorage.setItem(CONFIG.storageKeys.conversations, JSON.stringify(state.conversations));
    syncUnifiedStorage();
}

// ===== UI Updates =====
async function updateUI() {
    const persona = getActivePersona();

    // Update form inputs
    elements.providerSelect.value = state.settings.provider;
    elements.modelSelect.value = state.settings.model;
    elements.apiKeyInput.value = state.settings.apiKey;
    elements.assistantName.value = persona ? persona.name : CONFIG.defaults.assistantName;
    elements.systemPrompt.value = persona ? persona.systemPrompt : CONFIG.defaults.systemPrompt;
    elements.showAvatar.checked = state.settings.showAvatar;

    // Update size preset buttons
    document.querySelectorAll('.size-preset-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.size === state.settings.avatarSize);
    });

    // Update position preset buttons
    document.querySelectorAll('.position-preset-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.position === state.settings.avatarPosition);
    });

    // Update header
    elements.headerAssistantName.textContent = persona ? persona.name : CONFIG.defaults.assistantName;
    elements.modelIndicator.textContent = getModelDisplayName(state.settings.model);

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
}

async function updateAvatarPreview() {
    const preview = elements.avatarPreview;
    const name = elements.avatarPreviewName;
    const status = elements.avatarPreviewStatus;
    const persona = getActivePersona();

    name.textContent = persona ? persona.name : CONFIG.defaults.assistantName;

    const avatarKey = persona ? persona.avatarImageKey : '';
    if (avatarKey) {
        const imageUrl = await ImageStore.get(avatarKey);
        if (imageUrl) {
            preview.innerHTML = `<img src="${imageUrl}" alt="Avatar">`;
            status.textContent = 'Custom Avatar';
        } else {
            preview.textContent = '🤖';
            status.textContent = 'Default Avatar';
        }
    } else {
        preview.textContent = '🤖';
        status.textContent = 'Default Avatar';
    }
}

async function updateFloatingAvatar() {
    const avatar = elements.floatingAvatar;
    const image = elements.avatarImage;
    const persona = getActivePersona();
    const expressions = persona ? persona.expressions : CONFIG.defaultExpressions;

    // Show/hide avatar
    avatar.classList.toggle('hidden', !state.settings.showAvatar);

    // Update position
    avatar.className = `floating-avatar ${state.settings.avatarPosition}`;
    if (!state.settings.showAvatar) {
        avatar.classList.add('hidden');
    }

    // Update size
    image.className = `avatar-image size-${state.settings.avatarSize}`;

    // Update image or emoji
    // Priority: expression image > default avatar > emoji
    const currentExpr = expressions[state.currentExpression] || expressions.neutral;

    // Try to load expression image from IndexedDB
    let expressionImageUrl = null;
    if (currentExpr && currentExpr.imageKey) {
        expressionImageUrl = await ImageStore.get(currentExpr.imageKey);
    }

    // Try to load default avatar from IndexedDB
    let avatarImageUrl = null;
    const avatarKey = persona ? persona.avatarImageKey : '';
    if (avatarKey) {
        avatarImageUrl = await ImageStore.get(avatarKey);
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
    const expressions = persona ? persona.expressions : CONFIG.defaultExpressions;
    const expr = expressions[state.currentExpression] || expressions.neutral;
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
    const modelNames = {
        'claude-sonnet-4-20250514': 'Claude Sonnet 4',
        'claude-haiku-4-20250514': 'Claude Haiku 4'
    };
    return modelNames[modelId] || modelId;
}

function updateSendButtonState() {
    const hasApiKey = state.settings.apiKey.length > 0;
    const hasMessage = elements.messageInput.value.trim().length > 0;
    const notLoading = !state.isLoading;
    
    elements.sendButton.disabled = !(hasApiKey && hasMessage && notLoading);
}

// ===== Expression Management =====
async function renderExpressionList() {
    const list = elements.expressionList;
    list.innerHTML = '';

    const persona = getActivePersona();
    const expressions = persona ? persona.expressions : CONFIG.defaultExpressions;

    for (const [name, expr] of Object.entries(expressions)) {
        const item = document.createElement('div');
        item.className = 'expression-item';
        item.onclick = () => openExpressionModal(name);

        // Load image from IndexedDB if key exists
        let imageContent = expr.emoji;
        if (expr.imageKey) {
            const imageUrl = await ImageStore.get(expr.imageKey);
            if (imageUrl) {
                imageContent = `<img src="${imageUrl}" alt="${name}">`;
            }
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

        // Load image preview from IndexedDB
        if (expr.imageKey) {
            const imageUrl = await ImageStore.get(expr.imageKey);
            if (imageUrl) {
                elements.expressionImagePreview.innerHTML = `<img src="${imageUrl}" alt="${name}">`;
            } else {
                elements.expressionImagePreview.innerHTML = '<span class="preview-placeholder">No image</span>';
            }
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
        alert('Please enter an expression name');
        return;
    }

    const persona = getActivePersona();
    if (!persona) {
        alert('No active persona');
        return;
    }

    // Determine the image key
    let imageKey = '';
    const oldExpr = editingExpression ? persona.expressions[editingExpression] : null;
    const oldImageKey = oldExpr?.imageKey || '';

    try {
        if (state.tempExpressionBlob) {
            // User uploaded a new image - store it with the expression name as key
            imageKey = `expr_${persona.id}_${name}`;
            await ImageStore.store(imageKey, state.tempExpressionBlob);

            // If renaming and old key was different, delete old image
            if (oldImageKey && oldImageKey !== imageKey) {
                await ImageStore.delete(oldImageKey);
            }
        } else if (state.tempExpressionCleared) {
            // User explicitly cleared the image
            if (oldImageKey) {
                await ImageStore.delete(oldImageKey);
            }
            imageKey = '';
        } else if (editingExpression && editingExpression !== name && oldImageKey) {
            // Renaming expression - need to copy image to new key
            const oldUrl = await ImageStore.get(oldImageKey);
            if (oldUrl) {
                // Fetch the blob from the old location and store with new key
                const response = await fetch(oldUrl);
                const blob = await response.blob();
                imageKey = `expr_${persona.id}_${name}`;
                await ImageStore.store(imageKey, blob);
                await ImageStore.delete(oldImageKey);
            }
        } else {
            // Keep existing image key (or empty if none)
            imageKey = oldImageKey;
        }
    } catch (error) {
        console.error('Failed to save expression image:', error);
        alert('Failed to save image. Please try again.');
        return;
    }

    // If renaming, delete old expression entry
    if (editingExpression && editingExpression !== name) {
        delete persona.expressions[editingExpression];
    }

    persona.expressions[name] = { emoji, imageKey, keywords };
    persona.updatedAt = Date.now();

    savePersonas();
    await renderExpressionList();
    closeExpressionModal();

    // Update floating avatar in case current expression changed
    await updateFloatingAvatar();

    // Update system prompt hint about available expressions
    updateSystemPromptExpressions();
}

async function deleteExpression() {
    if (!editingExpression) return;

    const persona = getActivePersona();
    if (!persona) return;

    if (Object.keys(persona.expressions).length <= 1) {
        alert('You must have at least one expression');
        return;
    }

    if (confirm(`Delete expression "${editingExpression}"?`)) {
        // Delete image from IndexedDB if exists
        const expr = persona.expressions[editingExpression];
        if (expr?.imageKey) {
            await ImageStore.delete(expr.imageKey);
        }

        delete persona.expressions[editingExpression];
        persona.updatedAt = Date.now();
        savePersonas();
        await renderExpressionList();
        closeExpressionModal();
    }
}

function updateSystemPromptExpressions() {
    // This could automatically update the system prompt with available expressions
    // For now, we'll leave it manual since users customize their prompts
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
        elements.messagesContainer.innerHTML = `
            <div class="welcome-message">
                <h1>Welcome!</h1>
                <p>${state.settings.apiKey ? 'Start chatting with ' + assistantName + '!' : 'Configure your API key in the settings (☰) to get started.'}</p>
            </div>
        `;
        return;
    }

    messages.forEach(msg => {
        appendMessage(msg.role, msg.content, false);
    });

    scrollToBottom();
}

function appendMessage(role, content, save = true) {
    const welcome = elements.messagesContainer.querySelector('.welcome-message');
    if (welcome) {
        welcome.remove();
    }

    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}`;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    // For assistant messages, strip expression tags before display
    const displayContent = role === 'assistant' ? stripExpressionTag(content) : content;
    contentDiv.textContent = displayContent;

    messageDiv.appendChild(contentDiv);
    elements.messagesContainer.appendChild(messageDiv);

    if (save) {
        // Auto-create conversation if none exists
        if (!state.activeConversationId) {
            // Generate title from first user message
            const title = role === 'user'
                ? generateConversationTitle(displayContent)
                : 'New Chat';
            createConversation(title);
        }

        const activeConvo = getActiveConversation();
        if (activeConvo) {
            activeConvo.messages.push({ role, content: displayContent });

            // Update title from first user message if still default
            if (activeConvo.messages.length === 1 && role === 'user' && activeConvo.title === 'New Chat') {
                activeConvo.title = generateConversationTitle(displayContent);
            }

            activeConvo.updatedAt = Date.now();
            saveConversations();
        }

        // Update token estimate (rough: 1 token ≈ 4 chars)
        state.estimatedTokens += Math.ceil(content.length / 4);
        updateStatusBar();
    }

    scrollToBottom();
}

function appendErrorMessage(errorText) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message error';
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.textContent = `Error: ${errorText}`;
    
    messageDiv.appendChild(contentDiv);
    elements.messagesContainer.appendChild(messageDiv);
    
    scrollToBottom();
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

function showNotification(message, type = 'info') {
    console.log(`[${type}] ${message}`);
    // TODO: Implement toast notifications
}

// ===== API Communication =====
async function sendMessage() {
    const userMessage = elements.messageInput.value.trim();
    
    if (!userMessage || !state.settings.apiKey || state.isLoading) {
        return;
    }
    
    elements.messageInput.value = '';
    elements.messageInput.style.height = 'auto';
    state.isLoading = true;
    updateSendButtonState();
    
    appendMessage('user', userMessage);
    showTypingIndicator();
    
    try {
        const response = await callAPI(userMessage);
        
        hideTypingIndicator();
        
        // Detect expression from response
        const detectedExpr = detectExpression(response);
        await setExpression(detectedExpr);

        // Strip expression tag and display
        appendMessage('assistant', response);
        
    } catch (error) {
        hideTypingIndicator();
        appendErrorMessage(error.message);
        console.error('API Error:', error);
    } finally {
        state.isLoading = false;
        updateSendButtonState();
    }
}

async function callAPI(userMessage) {
    const { provider, model, apiKey } = state.settings;
    const persona = getActivePersona();
    const systemPrompt = persona ? persona.systemPrompt : CONFIG.defaults.systemPrompt;

    if (provider === 'anthropic') {
        return await callAnthropicAPI(userMessage, model, apiKey, systemPrompt);
    }

    throw new Error(`Provider ${provider} not yet implemented`);
}

async function callAnthropicAPI(userMessage, model, apiKey, systemPrompt) {
    const activeConvo = getActiveConversation();
    const conversationMessages = activeConvo ? activeConvo.messages : [];

    const messages = conversationMessages.map(msg => ({
        role: msg.role,
        content: msg.content
    }));
    
    const requestBody = {
        model: model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: messages
    };
    
    const response = await fetch(CONFIG.endpoints.anthropic, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `API request failed with status ${response.status}`);
    }
    
    const data = await response.json();
    const textContent = data.content.find(block => block.type === 'text');
    
    if (!textContent) {
        throw new Error('No text response received from API');
    }
    
    return textContent.text;
}

// ===== Event Listeners =====
function setupEventListeners() {
    // Sidebar toggle
    elements.openSidebar.addEventListener('click', openSidebar);
    elements.closeSidebar.addEventListener('click', closeSidebar);
    
    // Settings
    elements.saveSettings.addEventListener('click', saveSettings);
    elements.clearChat.addEventListener('click', clearConversation);
    
    // API key visibility toggle
    elements.toggleApiKey.addEventListener('click', () => {
        const input = elements.apiKeyInput;
        input.type = input.type === 'password' ? 'text' : 'password';
    });
    
    // Size preset buttons
    document.querySelectorAll('.size-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.size-preset-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });
    
    // Position preset buttons
    document.querySelectorAll('.position-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.position-preset-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });
    
    // Avatar toggle button in status bar
    elements.avatarToggleBtn.addEventListener('click', async () => {
        state.settings.showAvatar = !state.settings.showAvatar;
        elements.showAvatar.checked = state.settings.showAvatar;
        localStorage.setItem(CONFIG.storageKeys.settings, JSON.stringify(state.settings));
        await updateFloatingAvatar();
        elements.avatarToggleBtn.classList.toggle('active', state.settings.showAvatar);
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
 * Handle avatar image upload - stores blob in IndexedDB
 */
async function handleAvatarUpload(file) {
    // Validate file type
    if (!file.type.startsWith('image/')) {
        alert('Please select an image file');
        return;
    }

    // Validate file size (max 5MB - can be larger now with IndexedDB)
    const maxSize = 5 * 1024 * 1024;
    if (file.size > maxSize) {
        alert('Image is too large. Please select an image under 5MB.');
        return;
    }

    const persona = getActivePersona();
    if (!persona) {
        alert('No active persona');
        return;
    }

    try {
        const blob = await ImageStore.fileToBlob(file);
        const key = `avatar_${persona.id}`;

        await ImageStore.store(key, blob);
        persona.avatarImageKey = key;
        persona.updatedAt = Date.now();

        // Save persona
        savePersonas();

        // Update previews
        await updateAvatarPreview();
        await updateFloatingAvatar();

        showNotification('Avatar uploaded!', 'success');
    } catch (error) {
        console.error('Failed to upload avatar:', error);
        alert('Failed to upload image. Please try again.');
    }
}

/**
 * Clear the avatar image - removes from IndexedDB
 */
async function clearAvatarImage() {
    const persona = getActivePersona();
    if (!persona) return;

    if (persona.avatarImageKey) {
        await ImageStore.delete(persona.avatarImageKey);
    }
    persona.avatarImageKey = '';
    persona.updatedAt = Date.now();
    savePersonas();
    await updateAvatarPreview();
    await updateFloatingAvatar();
}

/**
 * Handle expression image upload - stores blob temporarily until expression is saved
 */
async function handleExpressionImageUpload(file) {
    // Validate file type
    if (!file.type.startsWith('image/')) {
        alert('Please select an image file');
        return;
    }

    // Validate file size (max 2MB for expressions with IndexedDB)
    const maxSize = 2 * 1024 * 1024;
    if (file.size > maxSize) {
        alert('Image is too large. Please select an image under 2MB.');
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
        alert('Failed to upload image. Please try again.');
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
    document.getElementById('sidebarOverlay').classList.add('visible');
}

function closeSidebar() {
    elements.sidebar.classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('visible');
}

// ===== Utility Functions =====
function autoResizeTextarea(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
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

// ===== Start the App =====
document.addEventListener('DOMContentLoaded', init);
