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
        anthropic: 'https://api.anthropic.com/v1/messages',
        google: 'https://generativelanguage.googleapis.com/v1beta/models'
    },
    modelEndpoints: {
        anthropic: 'https://api.anthropic.com/v1/models',
        google: 'https://generativelanguage.googleapis.com/v1beta/models'
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

// ===== Schema Version & Migrations =====
const CURRENT_SCHEMA_VERSION = 8;

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
    },

    /**
     * Migration 2: Add custom models support
     * - Adds customModels array for user-defined models
     */
    2: async (data) => {
        console.log('[Migration 2] Starting: Adding customModels support...');

        // Add customModels array if not present
        data.customModels = data.customModels || [];
        data.schemaVersion = 2;

        console.log('[Migration 2] Complete.');
        return data;
    },

    /**
     * Migration 3: Per-provider API keys and models
     * - Converts single apiKey to apiKeys object keyed by provider
     * - Converts customModels array to object keyed by provider
     */
    3: async (data) => {
        console.log('[Migration 3] Starting: Converting to per-provider API keys and models...');

        // Convert single apiKey to apiKeys object
        const existingKey = data.settings.apiKey || '';
        data.settings.apiKeys = {
            anthropic: existingKey,
            google: '',
            openai: ''
        };

        // Remove old apiKey field
        delete data.settings.apiKey;

        // Convert customModels array to per-provider object
        // Existing models are assumed to be Anthropic models
        const existingModels = Array.isArray(data.customModels) ? data.customModels : [];
        data.customModels = {
            anthropic: existingModels,
            google: [],
            openai: []
        };

        data.schemaVersion = 3;
        console.log('[Migration 3] Complete.');
        return data;
    },

    /**
     * Migration 4: Add model parameters
     * - Adds modelParams object for temperature, top_p, top_k, etc.
     * - Includes provider-specific settings (thinking, safety)
     */
    4: async (data) => {
        console.log('[Migration 4] Starting: Adding model parameters...');

        // Add modelParams with defaults
        data.settings.modelParams = {
            // Common parameters
            temperature: 1.0,
            topP: 0.95,
            topK: 40,
            maxTokens: 4096,
            stopSequences: [],
            streaming: false,

            // Anthropic-specific
            anthropic: {
                thinkingEnabled: false,
                thinkingBudget: 4000
            },

            // Google Gemini-specific
            google: {
                thinkingLevel: 'medium',
                safetyHarassment: 'BLOCK_MEDIUM_AND_ABOVE',
                safetyHate: 'BLOCK_MEDIUM_AND_ABOVE',
                safetySexual: 'BLOCK_MEDIUM_AND_ABOVE',
                safetyDangerous: 'BLOCK_MEDIUM_AND_ABOVE',
                mediaResolution: 'medium'
            }
        };

        data.schemaVersion = 4;
        console.log('[Migration 4] Complete.');
        return data;
    },

    /**
     * Migration 5: Add attachments array to messages
     * - Prepares message format for file attachment support
     */
    5: async (data) => {
        console.log('[Migration 5] Starting: Adding attachment support to messages...');

        for (const convo of Object.values(data.conversations || {})) {
            for (const msg of (convo.messages || [])) {
                if (!msg.attachments) {
                    msg.attachments = [];
                }
            }
        }

        data.schemaVersion = 5;
        console.log('[Migration 5] Complete.');
        return data;
    },

    /**
     * Migration 6: Add parameter enabled flags and update thinkingLevel default
     * - Adds temperatureEnabled, topPEnabled, topKEnabled flags
     * - Changes thinkingLevel default to 'off' to avoid API errors
     */
    6: async (data) => {
        console.log('[Migration 6] Starting: Adding parameter enabled flags...');

        if (data.settings && data.settings.modelParams) {
            const params = data.settings.modelParams;
            // Add enabled flags (default to true for backwards compatibility)
            if (params.temperatureEnabled === undefined) {
                params.temperatureEnabled = true;
            }
            if (params.topPEnabled === undefined) {
                params.topPEnabled = true;
            }
            if (params.topKEnabled === undefined) {
                params.topKEnabled = true;
            }
            // Change thinkingLevel default to 'off' if it's 'medium' (the old default)
            if (params.google && params.google.thinkingLevel === 'medium') {
                params.google.thinkingLevel = 'off';
            }
        }

        data.schemaVersion = 6;
        console.log('[Migration 6] Complete.');
        return data;
    },

    /**
     * Migration 7: Move model settings from global to per-persona
     * - Each persona gets its own modelConfig (provider, model, modelParams)
     * - Global settings keeps only apiKeys and avatar UI preferences
     * - Creates defaultModelConfig for new persona creation
     */
    7: async (data) => {
        console.log('[Migration 7] Starting: Moving model settings to personas...');

        // Extract current global model config
        const globalModelConfig = {
            provider: data.settings.provider || CONFIG.defaults.provider,
            model: data.settings.model || CONFIG.defaults.model,
            modelParams: data.settings.modelParams || {
                temperature: 1.0,
                topP: 0.95,
                topK: 40,
                maxTokens: 4096,
                stopSequences: [],
                streaming: false,
                temperatureEnabled: true,
                topPEnabled: true,
                topKEnabled: true,
                anthropic: { thinkingEnabled: false, thinkingBudget: 4000 },
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

        // Add modelConfig to each existing persona
        for (const persona of Object.values(data.personas || {})) {
            if (!persona.modelConfig) {
                // Deep copy the global config to each persona
                persona.modelConfig = JSON.parse(JSON.stringify(globalModelConfig));
                console.log(`[Migration 7] Added modelConfig to persona: ${persona.name}`);
            }
        }

        // Store as defaultModelConfig for creating new personas
        data.settings.defaultModelConfig = JSON.parse(JSON.stringify(globalModelConfig));

        // Remove model settings from global settings (keep apiKeys and avatar UI)
        delete data.settings.provider;
        delete data.settings.model;
        delete data.settings.modelParams;

        data.schemaVersion = 7;
        console.log('[Migration 7] Complete.');
        return data;
    },

    8: async (data) => {
        console.log('[Migration 8] Starting: Adding prefill field to personas...');

        for (const persona of Object.values(data.personas || {})) {
            if (persona.prefill === undefined) {
                persona.prefill = '';
            }
        }

        data.schemaVersion = 8;
        console.log('[Migration 8] Complete.');
        return data;
    }
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
    // null when unauthenticated. Shape: { userId, email, displayName }.
    user: null,
    // App-level preferences only (model settings now in personas)
    settings: {
        apiKeys: {
            anthropic: '',
            google: '',
            openai: ''
        },
        avatarSize: CONFIG.defaults.avatarSize,
        avatarPosition: CONFIG.defaults.avatarPosition,
        showAvatar: CONFIG.defaults.showAvatar,
        // Default model config for creating new personas
        defaultModelConfig: {
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
        }
    },
    // Personas stored by ID for multi-persona support
    personas: {},
    activePersonaId: null,
    // Conversations stored by ID for multi-conversation support
    conversations: {},
    activeConversationId: null,
    // User-defined models keyed by provider
    customModels: {
        anthropic: [],
        google: [],
        openai: []
    },
    // UI state
    ui: {
        activeTab: 'chats',
        conversationFilter: 'active' // 'active' means filter by activePersonaId, or 'all'
    },
    currentExpression: 'neutral',
    isLoading: false,
    currentPrefill: '',  // Tracks active prefill for response stripping
    sessionStartTime: Date.now(),
    estimatedTokens: 0,
    tempExpressionBlob: null, // Blob waiting to be saved when expression is saved
    tempExpressionPreviewUrl: '', // Object URL for preview in modal
    tempExpressionCleared: false, // Flag indicating user explicitly cleared the image
    // Streaming state
    abortController: null,
    streamingMessageDiv: null,
    streamingAccumulator: '',
    // Attachment state
    pendingAttachments: [] // Array of { id, file, previewUrl, type, mimeType, fileName, fileSize }
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

    // Get default model config (deep copy to ensure independence)
    const defaultConfig = state.settings.defaultModelConfig || getDefaultModelConfig();
    const modelConfig = JSON.parse(JSON.stringify(defaultConfig));

    state.personas[id] = {
        id,
        name,
        systemPrompt: CONFIG.defaults.systemPrompt,
        prefill: '',
        avatarImageKey: '',
        expressions: { ...CONFIG.defaultExpressions },
        modelConfig: modelConfig,
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
    return state.settings.defaultModelConfig || getDefaultModelConfig();
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

    // Sidebar tabs
    chatsTab: document.getElementById('chatsTab'),
    settingsTab: document.getElementById('settingsTab'),
    personasTab: document.getElementById('personasTab'),

    // Chats tab elements
    personaFilter: document.getElementById('personaFilter'),
    newChatBtn: document.getElementById('newChatBtn'),
    conversationList: document.getElementById('conversationList'),
    noConversationsMessage: document.getElementById('noConversationsMessage'),

    // Personas tab elements
    newPersonaBtn: document.getElementById('newPersonaBtn'),
    personaList: document.getElementById('personaList'),

    // Settings inputs
    providerSelect: document.getElementById('providerSelect'),
    modelSelect: document.getElementById('modelSelect'),
    apiKeyInput: document.getElementById('apiKeyInput'),
    toggleApiKey: document.getElementById('toggleApiKey'),
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
    // Load settings (model settings now in personas, not global)
    if (data.settings) {
        // Default model config structure for new personas
        const defaultModelConfig = getDefaultModelConfig();

        state.settings = {
            apiKeys: data.settings.apiKeys || { anthropic: '', google: '', openai: '' },
            avatarSize: data.settings.avatarSize || CONFIG.defaults.avatarSize,
            avatarPosition: data.settings.avatarPosition || CONFIG.defaults.avatarPosition,
            showAvatar: data.settings.showAvatar !== undefined ? data.settings.showAvatar : CONFIG.defaults.showAvatar,
            defaultModelConfig: data.settings.defaultModelConfig || defaultModelConfig
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

    // Load custom models (should be object keyed by provider after migration 3)
    if (data.customModels) {
        // Handle both old array format (pre-migration) and new object format
        if (Array.isArray(data.customModels)) {
            // Old format - assign to anthropic (shouldn't happen after migration)
            state.customModels = {
                anthropic: data.customModels,
                google: [],
                openai: []
            };
        } else {
            state.customModels = data.customModels;
        }
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
        customModels: state.customModels,
        activePersonaId: state.activePersonaId,
        activeConversationId: state.activeConversationId
    };
    localStorage.setItem(CONFIG.storageKeys.appData, JSON.stringify(data));
}

// ===== Real-Time Auto-Save =====
let autoSaveTimeout = null;

/**
 * Debounced auto-save function
 * Saves settings after 300ms of no changes to avoid excessive writes
 */
function autoSaveSettings() {
    // Clear any pending save
    if (autoSaveTimeout) {
        clearTimeout(autoSaveTimeout);
    }

    // Debounce: save after 300ms of no changes
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

    // API key for current provider (stays global)
    const currentProvider = persona?.modelConfig?.provider || CONFIG.defaults.provider;
    state.settings.apiKeys[currentProvider] = elements.apiKeyInput.value;

    // Avatar settings (stay global)
    state.settings.showAvatar = elements.showAvatar.checked;
    const activeSize = document.querySelector('.size-preset-btn.active');
    if (activeSize) state.settings.avatarSize = activeSize.dataset.size;
    const activePos = document.querySelector('.position-preset-btn.active');
    if (activePos) state.settings.avatarPosition = activePos.dataset.position;

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
 * Persist current state to localStorage
 */
function persistSettings() {
    localStorage.setItem(CONFIG.storageKeys.settings, JSON.stringify(state.settings));
    const persona = getActivePersona();
    if (persona) {
        savePersonas();
    } else {
        syncUnifiedStorage();
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

function saveConversations() {
    localStorage.setItem(CONFIG.storageKeys.conversations, JSON.stringify(state.conversations));
    syncUnifiedStorage();
}

// ===== UI Updates =====
async function updateUI() {
    const persona = getActivePersona();
    const modelConfig = getActiveModelConfig();

    // Update form inputs - provider/model now from active persona's modelConfig
    elements.providerSelect.value = modelConfig.provider;
    populateModelDropdown(); // Populate from customModels based on persona's provider
    // Load API key for the persona's provider
    const currentProvider = modelConfig.provider;
    elements.apiKeyInput.value = state.settings.apiKeys[currentProvider] || '';
    // Update API key field placeholder and label for current provider
    updateApiKeyFieldForProvider(currentProvider);
    elements.assistantName.value = persona ? persona.name : CONFIG.defaults.assistantName;
    elements.systemPrompt.value = persona ? persona.systemPrompt : CONFIG.defaults.systemPrompt;
    elements.prefillInput.value = persona ? (persona.prefill || '') : '';
    elements.showAvatar.checked = state.settings.showAvatar;

    // Load model parameters to UI (from active persona's modelConfig)
    loadModelParamsToUI();

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

    elements.apiKeyInput.placeholder = placeholders[provider] || 'API Key';

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
    const modelConfig = getActiveModelConfig();

    // Save the current API key for the previous provider before switching
    const previousProvider = modelConfig.provider;
    if (previousProvider && previousProvider !== provider) {
        state.settings.apiKeys[previousProvider] = elements.apiKeyInput.value;
    }

    // Update provider in active persona's modelConfig
    const persona = getActivePersona();
    if (persona && persona.modelConfig) {
        persona.modelConfig.provider = provider;
        persona.updatedAt = Date.now();
    }

    // Load API key for the new provider
    elements.apiKeyInput.value = state.settings.apiKeys[provider] || '';

    // Update placeholder and label
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
    if (!modelId) return 'No model selected';

    // Look up in custom models for current persona's provider
    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;
    const providerModels = state.customModels[provider] || [];
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
    const apiKey = state.settings.apiKeys[provider] || '';
    const hasApiKey = apiKey.length > 0;
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

// ===== Model Management =====

/**
 * Fetch available models from the current provider's API
 * @returns {Promise<Array>} Array of { id, display_name } objects
 */
async function fetchAvailableModels() {
    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;
    const apiKey = state.settings.apiKeys[provider];

    if (!apiKey) {
        throw new Error('API key required to fetch models');
    }

    switch (provider) {
        case 'anthropic':
            return await fetchAnthropicModels(apiKey);
        case 'google':
            return await fetchGoogleModels(apiKey);
        default:
            throw new Error(`Model fetching not supported for ${provider}`);
    }
}

/**
 * Fetch available models from Anthropic API
 * @param {string} apiKey - The Anthropic API key
 * @returns {Promise<Array>} Array of { id, display_name } objects
 */
async function fetchAnthropicModels(apiKey) {
    const response = await fetch(CONFIG.modelEndpoints.anthropic, {
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        }
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error?.message || `Failed to fetch models: ${response.status}`);
    }

    const data = await response.json();
    return data.data || [];
}

/**
 * Fetch available models from Google Gemini API
 * @param {string} apiKey - The Google AI API key
 * @returns {Promise<Array>} Array of { id, display_name } objects
 */
async function fetchGoogleModels(apiKey) {
    const response = await fetch(`${CONFIG.modelEndpoints.google}?key=${apiKey}`);

    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        const errorMessage = parseGoogleError(error);
        throw new Error(errorMessage || `Failed to fetch models: ${response.status}`);
    }

    const data = await response.json();

    // Filter for generative models only and format for our UI
    const models = (data.models || [])
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => ({
            id: m.name.replace('models/', ''),  // e.g., "gemini-1.5-pro"
            display_name: m.displayName || m.name.replace('models/', '')
        }));

    return models;
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
    const providerModels = state.customModels[provider];

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
    const providerModels = state.customModels[provider];
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
function saveCustomModels() {
    syncUnifiedStorage();
}

/**
 * Populate the model dropdown from customModels for the current provider
 */
function populateModelDropdown() {
    const select = elements.modelSelect;
    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;
    const providerModels = state.customModels[provider] || [];
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
    const providerModels = state.customModels[provider] || [];
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
    const providerModels = state.customModels[provider] || [];
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
    const apiKey = state.settings.apiKeys[provider] || '';
    elements.fetchModelsBtn.disabled = !apiKey;

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

    try {
        btn.disabled = true;
        btn.textContent = 'Fetching...';

        const models = await fetchAvailableModels();
        renderAvailableModelsGrid(models);
    } catch (error) {
        console.error('Failed to fetch models:', error);
        alert(`Failed to fetch models: ${error.message}`);
    } finally {
        const modelConfig = getActiveModelConfig();
        const provider = modelConfig.provider;
        const apiKey = state.settings.apiKeys[provider] || '';
        btn.disabled = !apiKey;
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
        alert('Please enter a model ID');
        return;
    }

    if (!name) {
        alert('Please enter a display name');
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
        alert('Model already exists');
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
 * Switch to a different conversation
 * @param {string} conversationId
 */
function switchConversation(conversationId) {
    if (!state.conversations[conversationId]) return;

    state.activeConversationId = conversationId;

    // Also switch to the persona that owns this conversation
    const convo = state.conversations[conversationId];
    if (convo.personaId && convo.personaId !== state.activePersonaId) {
        state.activePersonaId = convo.personaId;
        savePersonas(); // Updates unified storage
    }

    saveConversations();
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
 * Prompt to delete a conversation
 * @param {string} conversationId
 */
function deleteConversationPrompt(conversationId) {
    const convo = state.conversations[conversationId];
    if (!convo) return;

    if (confirm(`Delete "${convo.title || 'New Chat'}"? This cannot be undone.`)) {
        delete state.conversations[conversationId];

        // If we deleted the active conversation, switch to another or clear
        if (state.activeConversationId === conversationId) {
            const remaining = Object.values(state.conversations);
            if (remaining.length > 0) {
                // Switch to most recent
                const mostRecent = remaining.reduce((a, b) =>
                    (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a
                );
                state.activeConversationId = mostRecent.id;
            } else {
                state.activeConversationId = null;
            }
        }

        saveConversations();
        renderConversationList();
        renderConversation();
    }
}

/**
 * Create a new conversation and switch to it
 */
function startNewConversation() {
    const id = createConversation('New Chat');
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

        // Try to load avatar image from IndexedDB
        let avatarContent = '';
        if (persona.avatarImageKey) {
            const imageUrl = await ImageStore.get(persona.avatarImageKey);
            if (imageUrl) {
                avatarContent = `<img src="${imageUrl}" alt="${escapeHtml(persona.name)}">`;
            }
        }
        // Fallback to emoji if no image
        if (!avatarContent) {
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
    switchTab('settings');
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
        // Delete linked conversations
        linkedConvos.forEach(convo => {
            delete state.conversations[convo.id];
        });

        // Delete persona
        delete state.personas[personaId];

        // If we deleted the active persona, switch to another
        if (state.activePersonaId === personaId) {
            const remaining = Object.values(state.personas);
            if (remaining.length > 0) {
                state.activePersonaId = remaining[0].id;
            } else {
                // Create a default persona if none left
                createPersona('Assistant');
            }
        }

        // Clear active conversation if it was deleted
        if (!state.conversations[state.activeConversationId]) {
            state.activeConversationId = null;
        }

        savePersonas();
        saveConversations();
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
    const id = createPersona('New Persona');
    await renderPersonaList();
    editPersona(id);
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
        const hasApiKey = (state.settings.apiKeys[provider] || '').length > 0;
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

function appendMessage(role, content, save = true, explicitIndex = null, attachments = null) {
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
        actionsDiv.innerHTML = `
            <button class="message-action-btn" data-action="copy" title="Copy">&#128203;</button>
            <button class="message-action-btn" data-action="edit" title="Edit">&#9998;</button>
            <button class="message-action-btn" data-action="rerun" title="${rerunTitle}">&#128260;</button>
            <button class="message-action-btn danger" data-action="delete" title="Delete">&#128465;</button>
        `;
        messageDiv.appendChild(actionsDiv);
    }

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
            activeConvo.messages.push({ role, content: displayContent, attachments: attachments || [] });

            // Set data-msg-index after push
            messageDiv.dataset.msgIndex = activeConvo.messages.length - 1;

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
    } else {
        // When re-rendering (save=false), use explicit index
        if (explicitIndex !== null) {
            messageDiv.dataset.msgIndex = explicitIndex;
        }
    }

    scrollToBottom();
    return messageDiv;
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

function deleteMessage(msgIndex) {
    const activeConvo = getActiveConversation();
    if (!activeConvo || !activeConvo.messages[msgIndex]) return;

    if (!confirm('Delete this message?')) return;

    const msg = activeConvo.messages[msgIndex];

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
    buttonsDiv.querySelector('.message-edit-save').addEventListener('click', () => {
        const newContent = textarea.value.trim();
        if (!newContent) return;

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

function rerunFromMessage(msgIndex) {
    const activeConvo = getActiveConversation();
    if (!activeConvo || !activeConvo.messages[msgIndex]) return;
    if (state.isLoading) return;

    const msg = activeConvo.messages[msgIndex];

    if (msg.role === 'user') {
        // Truncate everything from this index onward, resend this user message
        const textToResend = msg.content;
        const attachmentsToResend = msg.attachments || [];
        activeConvo.messages.splice(msgIndex);
        activeConvo.updatedAt = Date.now();
        saveConversations();
        renderConversation();
        sendMessageFromText(textToResend, attachmentsToResend);
    } else if (msg.role === 'assistant') {
        // Find the preceding user message, remove from this assistant onward, resend
        const precedingUserMsg = activeConvo.messages.slice(0, msgIndex).reverse().find(m => m.role === 'user');
        if (!precedingUserMsg) return;

        activeConvo.messages.splice(msgIndex);
        activeConvo.updatedAt = Date.now();
        saveConversations();
        renderConversation();
        sendMessageFromText(precedingUserMsg.content, precedingUserMsg.attachments || []);
    }
}

async function sendMessageFromText(text, attachments = []) {
    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;
    const apiKey = state.settings.apiKeys[provider] || '';
    if (!apiKey || state.isLoading) return;

    state.isLoading = true;
    updateSendButtonState();

    appendMessage('user', text, true, null, attachments.length > 0 ? attachments : null);
    showTypingIndicator();

    try {
        let response;
        if (modelConfig.modelParams.streaming) {
            hideTypingIndicator();
            elements.sendButton.style.display = 'none';
            elements.stopButton.style.display = '';
            startStreamingMessage();
            try {
                response = await callAPIStreaming(text, attachments);

                // Handle both string (Anthropic) and object (Google with images) responses
                const fullText = typeof response === 'object' ? (response.text || '') : response;
                const generatedImages = typeof response === 'object' ? (response.generatedImages || []) : [];

                await finalizeStreamingMessage(fullText, generatedImages);
            } catch (error) {
                if (error.name === 'AbortError') {
                    await finalizeStreamingMessage(state.streamingAccumulator || '', state.streamingGeneratedImages || []);
                } else {
                    if (state.streamingMessageDiv) {
                        state.streamingMessageDiv.remove();
                        state.streamingMessageDiv = null;
                    }
                    throw error;
                }
            } finally {
                state.abortController = null;
                if (elements.stopButton) elements.stopButton.style.display = 'none';
                if (elements.sendButton) elements.sendButton.style.display = '';
            }
        } else {
            response = await callAPI(text, attachments);
            hideTypingIndicator();

            // Handle both string (Anthropic) and object (Google with images) responses
            let responseText, responseAttachments;
            if (typeof response === 'object' && response !== null) {
                responseText = response.text || '';
                responseAttachments = response.attachments || [];
            } else {
                responseText = response;
                responseAttachments = [];
            }

            // Strip prefill from response
            if (state.currentPrefill) {
                responseText = stripPrefillText(responseText, state.currentPrefill);
                state.currentPrefill = '';
            }

            const detectedExpr = detectExpression(responseText);
            await setExpression(detectedExpr);
            appendMessage('assistant', responseText, true, null, responseAttachments.length > 0 ? responseAttachments : null);
        }
    } catch (error) {
        hideTypingIndicator();
        appendErrorMessage(error.message);
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

        // Add special class for AI-generated images
        if (att.type === 'generated') {
            attEl.classList.add('generated-image');
        }

        if ((att.type === 'image' || att.type === 'generated') && att.imageStoreKey) {
            // Create wrapper for image + download button
            const imgWrapper = document.createElement('div');
            imgWrapper.className = 'attachment-image-wrapper';

            // Load image from IndexedDB
            const img = document.createElement('img');
            img.alt = att.fileName || (att.type === 'generated' ? 'Generated image' : 'Attached image');
            img.loading = 'lazy';
            ImageStore.get(att.imageStoreKey).then(url => {
                if (url) img.src = url;
            });
            imgWrapper.appendChild(img);

            // Add download button for generated images
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
        } else {
            const badge = document.createElement('div');
            badge.className = 'file-badge';
            badge.textContent = `${getFileIcon(att.mimeType)} ${att.fileName || 'File'}`;
            attEl.appendChild(badge);
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

// ===== API Communication =====
async function sendMessage() {
    const userMessage = elements.messageInput.value.trim();
    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;
    const apiKey = state.settings.apiKeys[provider] || '';

    const hasAttachments = state.pendingAttachments.length > 0;
    if ((!userMessage && !hasAttachments) || !apiKey || state.isLoading) {
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

    appendMessage('user', userMessage || '(attached files)', true, null, attachmentMeta.length > 0 ? attachmentMeta : null);

    if (modelConfig.modelParams.streaming) {
        // Streaming path
        showTypingIndicator();
        elements.sendButton.style.display = 'none';
        elements.stopButton.style.display = '';

        try {
            hideTypingIndicator();
            startStreamingMessage();

            const result = await callAPIStreaming(userMessage, attachmentMeta);

            // Handle both string (Anthropic) and object (Google with images) responses
            const fullText = typeof result === 'object' ? (result.text || '') : result;
            const generatedImages = typeof result === 'object' ? (result.generatedImages || []) : [];

            await finalizeStreamingMessage(fullText, generatedImages);
        } catch (error) {
            if (error.name === 'AbortError') {
                await finalizeStreamingMessage(state.streamingAccumulator || '', state.streamingGeneratedImages || []);
            } else {
                if (state.streamingMessageDiv) {
                    state.streamingMessageDiv.remove();
                    state.streamingMessageDiv = null;
                }
                hideTypingIndicator();
                appendErrorMessage(error.message);
                console.error('API Error:', error);
            }
        } finally {
            state.isLoading = false;
            state.abortController = null;
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

            // Handle both string (Anthropic) and object (Google with images) responses
            let responseText, responseAttachments;
            if (typeof response === 'object' && response !== null) {
                responseText = response.text || '';
                responseAttachments = response.attachments || [];
            } else {
                responseText = response;
                responseAttachments = [];
            }

            // Strip prefill from response
            if (state.currentPrefill) {
                responseText = stripPrefillText(responseText, state.currentPrefill);
                state.currentPrefill = '';
            }

            // Detect expression from response
            const detectedExpr = detectExpression(responseText);
            await setExpression(detectedExpr);

            // Strip expression tag and display (with any generated attachments)
            appendMessage('assistant', responseText, true, null, responseAttachments.length > 0 ? responseAttachments : null);

        } catch (error) {
            hideTypingIndicator();
            appendErrorMessage(error.message);
            console.error('API Error:', error);
        } finally {
            state.isLoading = false;
            updateSendButtonState();
        }
    }
}

async function callAPI(userMessage, attachments = []) {
    const modelConfig = getActiveModelConfig();
    const { provider, model } = modelConfig;
    const apiKey = state.settings.apiKeys[provider];
    const persona = getActivePersona();
    const systemPrompt = persona ? persona.systemPrompt : CONFIG.defaults.systemPrompt;

    if (!apiKey) {
        throw new Error(`No API key configured for ${provider}`);
    }

    switch (provider) {
        case 'anthropic':
            return await callAnthropicAPI(userMessage, model, apiKey, systemPrompt, attachments);
        case 'google':
            return await callGoogleAPI(userMessage, model, apiKey, systemPrompt, attachments);
        default:
            throw new Error(`Provider ${provider} not yet implemented`);
    }
}

// ===== Streaming Support =====
async function callAPIStreaming(userMessage, attachments = []) {
    const modelConfig = getActiveModelConfig();
    const { provider, model } = modelConfig;
    const apiKey = state.settings.apiKeys[provider];
    const persona = getActivePersona();
    const systemPrompt = persona ? persona.systemPrompt : CONFIG.defaults.systemPrompt;

    if (!apiKey) {
        throw new Error(`No API key configured for ${provider}`);
    }

    switch (provider) {
        case 'anthropic':
            return await callAnthropicAPIStreaming(userMessage, model, apiKey, systemPrompt, attachments);
        case 'google':
            return await callGoogleAPIStreaming(userMessage, model, apiKey, systemPrompt, attachments);
        default:
            throw new Error(`Streaming not supported for ${provider}`);
    }
}

async function callAnthropicAPIStreaming(userMessage, model, apiKey, systemPrompt, attachments = []) {
    const activeConvo = getActiveConversation();
    const conversationMessages = activeConvo ? activeConvo.messages : [];
    const modelConfig = getActiveModelConfig();
    const params = modelConfig.modelParams;

    const messages = conversationMessages.map(msg => ({
        role: msg.role,
        content: msg.content
    }));

    // Add prefill as assistant message if configured
    const persona = getActivePersona();
    const prefillText = persona?.prefill?.trim() || '';
    if (prefillText) {
        messages.push({ role: 'assistant', content: prefillText });
    }
    state.currentPrefill = prefillText;

    const requestBody = {
        model: model,
        max_tokens: params.maxTokens,
        system: systemPrompt,
        messages: messages,
        stream: true
    };

    // Conditionally add parameters based on enabled flags
    if (params.temperatureEnabled !== false) {
        requestBody.temperature = params.temperature;
    }
    if (params.topPEnabled !== false) {
        requestBody.top_p = params.topP;
    }
    if (params.topKEnabled !== false) {
        requestBody.top_k = params.topK;
    }

    if (params.stopSequences.length > 0) {
        requestBody.stop_sequences = params.stopSequences;
    }

    if (params.anthropic.thinkingEnabled) {
        requestBody.thinking = {
            type: 'enabled',
            budget_tokens: params.anthropic.thinkingBudget
        };
    }

    // Handle attachments for the last user message
    if (attachments.length > 0 && messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role === 'user') {
            lastMsg.content = await buildAnthropicMessageContent(lastMsg.content, attachments);
        }
    }

    state.abortController = new AbortController();

    const response = await fetch(CONFIG.endpoints.anthropic, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(requestBody),
        signal: state.abortController.signal
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `API request failed with status ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    await parseSSEStream(reader, decoder, (event) => {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            appendStreamChunk(event.delta.text);
        }
    });

    return state.streamingAccumulator;
}

async function callGoogleAPIStreaming(userMessage, model, apiKey, systemPrompt, attachments = []) {
    const activeConvo = getActiveConversation();
    const conversationMessages = activeConvo ? activeConvo.messages : [];
    const modelConfig = getActiveModelConfig();
    const params = modelConfig.modelParams;

    const contents = conversationMessages.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
    }));

    // Add prefill as model message if configured
    const persona = getActivePersona();
    const prefillText = persona?.prefill?.trim() || '';
    if (prefillText) {
        contents.push({ role: 'model', parts: [{ text: prefillText }] });
    }
    state.currentPrefill = prefillText;

    // Build generationConfig with only enabled parameters
    const generationConfig = {
        maxOutputTokens: params.maxTokens
    };
    if (params.temperatureEnabled !== false) {
        generationConfig.temperature = params.temperature;
    }
    if (params.topPEnabled !== false) {
        generationConfig.topP = params.topP;
    }
    if (params.topKEnabled !== false) {
        generationConfig.topK = params.topK;
    }
    if (params.stopSequences.length > 0) {
        generationConfig.stopSequences = params.stopSequences;
    }

    // Add thinkingConfig inside generationConfig if not set to 'off'
    if (params.google.thinkingLevel && params.google.thinkingLevel !== 'off') {
        generationConfig.thinkingConfig = {
            thinkingLevel: params.google.thinkingLevel
        };
    }

    const requestBody = {
        contents: contents,
        systemInstruction: {
            parts: [{ text: systemPrompt }]
        },
        generationConfig: generationConfig,
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: params.google.safetyHarassment },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: params.google.safetyHate },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: params.google.safetySexual },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: params.google.safetyDangerous }
        ]
    };

    // Handle attachments for the last user message
    if (attachments.length > 0 && contents.length > 0) {
        const lastContent = contents[contents.length - 1];
        if (lastContent.role === 'user') {
            const extraParts = await buildGeminiAttachmentParts(attachments);
            lastContent.parts = [...extraParts, ...lastContent.parts];
        }
    }

    state.abortController = new AbortController();

    // Use streamGenerateContent endpoint with SSE
    const endpoint = `${CONFIG.endpoints.google}/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        signal: state.abortController.signal
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = parseGoogleError(errorData);
        throw new Error(errorMessage || `API request failed with status ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // Initialize array to collect generated images during streaming
    state.streamingGeneratedImages = [];

    await parseSSEStream(reader, decoder, (event) => {
        const parts = event.candidates?.[0]?.content?.parts || [];

        for (const part of parts) {
            if (part.text) {
                appendStreamChunk(part.text);
            } else if (part.inlineData) {
                // Collect generated images (typically arrive at end of stream)
                state.streamingGeneratedImages.push({
                    mimeType: part.inlineData.mimeType,
                    base64Data: part.inlineData.data
                });
            }
        }
    });

    return {
        text: state.streamingAccumulator,
        generatedImages: state.streamingGeneratedImages
    };
}

async function parseSSEStream(reader, decoder, onEvent) {
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ')) {
                const data = trimmed.slice(6);
                if (data === '[DONE]') return;
                try {
                    const parsed = JSON.parse(data);
                    onEvent(parsed);
                } catch (e) {
                    // Skip malformed events
                }
            }
        }
    }
}

function startStreamingMessage() {
    const welcome = elements.messagesContainer.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message assistant streaming';

    // Add speaker label
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
            // Strip prefill for display
            let displayText = state.streamingAccumulator;
            if (state.currentPrefill) {
                displayText = stripPrefillText(displayText, state.currentPrefill);
            }
            contentDiv.innerHTML = renderMarkdown(displayText);
        }
        scrollToBottom();
    }
}

async function finalizeStreamingMessage(fullText, generatedImages = []) {
    if (!state.streamingMessageDiv) return;

    state.streamingMessageDiv.classList.remove('streaming');

    // Detect and apply expression
    const detectedExpr = detectExpression(fullText);
    setExpression(detectedExpr);

    // Strip prefill and expression tag for display and storage
    let cleanText = fullText;
    if (state.currentPrefill) {
        cleanText = stripPrefillText(cleanText, state.currentPrefill);
        state.currentPrefill = '';
    }
    cleanText = stripExpressionTag(cleanText);

    // Store any generated images to IndexedDB
    const attachments = await storeGeneratedImages(generatedImages);

    // If we have generated images, render them before the content
    if (attachments.length > 0) {
        const attachDiv = document.createElement('div');
        attachDiv.className = 'message-attachments';
        renderMessageAttachments(attachments, attachDiv);

        // Insert before message-content
        const contentDiv = state.streamingMessageDiv.querySelector('.message-content');
        if (contentDiv) {
            state.streamingMessageDiv.insertBefore(attachDiv, contentDiv);
        }
    }

    const contentDiv = state.streamingMessageDiv.querySelector('.message-content');
    if (contentDiv) {
        // Handle image-only responses
        if (!cleanText && attachments.length > 0) {
            contentDiv.innerHTML = '<em>Generated image(s)</em>';
        } else {
            contentDiv.innerHTML = renderMarkdown(cleanText);
        }
    }

    // Add action buttons
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'message-actions';
    actionsDiv.innerHTML = `
        <button class="message-action-btn" data-action="copy" title="Copy">&#128203;</button>
        <button class="message-action-btn" data-action="edit" title="Edit">&#9998;</button>
        <button class="message-action-btn" data-action="rerun" title="Regenerate">&#128260;</button>
        <button class="message-action-btn danger" data-action="delete" title="Delete">&#128465;</button>
    `;
    state.streamingMessageDiv.appendChild(actionsDiv);

    // Save to conversation
    const activeConvo = getActiveConversation();
    if (activeConvo) {
        activeConvo.messages.push({ role: 'assistant', content: cleanText, attachments: attachments });
        state.streamingMessageDiv.dataset.msgIndex = activeConvo.messages.length - 1;
        activeConvo.updatedAt = Date.now();
        saveConversations();
    }

    // Update token estimate
    state.estimatedTokens += Math.ceil(fullText.length / 4);
    updateStatusBar();

    state.streamingMessageDiv = null;
    state.streamingAccumulator = '';
    state.streamingGeneratedImages = [];
}

function stopGeneration() {
    if (state.abortController) {
        state.abortController.abort();
    }
}

async function callAnthropicAPI(userMessage, model, apiKey, systemPrompt, attachments = []) {
    const activeConvo = getActiveConversation();
    const conversationMessages = activeConvo ? activeConvo.messages : [];
    const modelConfig = getActiveModelConfig();
    const params = modelConfig.modelParams;

    const messages = conversationMessages.map(msg => ({
        role: msg.role,
        content: msg.content
    }));

    // Handle attachments for the last user message
    if (attachments.length > 0 && messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role === 'user') {
            lastMsg.content = await buildAnthropicMessageContent(lastMsg.content, attachments);
        }
    }

    // Add prefill as assistant message if configured
    const persona = getActivePersona();
    const prefillText = persona?.prefill?.trim() || '';
    if (prefillText) {
        messages.push({ role: 'assistant', content: prefillText });
    }
    state.currentPrefill = prefillText;

    const requestBody = {
        model: model,
        max_tokens: params.maxTokens,
        system: systemPrompt,
        messages: messages
    };

    // Conditionally add parameters based on enabled flags
    if (params.temperatureEnabled !== false) {
        requestBody.temperature = params.temperature;
    }
    if (params.topPEnabled !== false) {
        requestBody.top_p = params.topP;
    }
    if (params.topKEnabled !== false) {
        requestBody.top_k = params.topK;
    }

    // Add stop sequences if any
    if (params.stopSequences.length > 0) {
        requestBody.stop_sequences = params.stopSequences;
    }

    // Add extended thinking if enabled
    if (params.anthropic.thinkingEnabled) {
        requestBody.thinking = {
            type: 'enabled',
            budget_tokens: params.anthropic.thinkingBudget
        };
    }

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

/**
 * Call Google Gemini API
 * @param {string} userMessage - The user's message
 * @param {string} model - The model ID (e.g., "gemini-1.5-pro")
 * @param {string} apiKey - The Google AI API key
 * @param {string} systemPrompt - The system prompt
 * @returns {Promise<string>} The assistant's response
 */
async function callGoogleAPI(userMessage, model, apiKey, systemPrompt, attachments = []) {
    const activeConvo = getActiveConversation();
    const conversationMessages = activeConvo ? activeConvo.messages : [];
    const modelConfig = getActiveModelConfig();
    const params = modelConfig.modelParams;

    // Convert messages to Google format
    // Google uses 'user' and 'model' roles, and content is in parts array
    const contents = conversationMessages.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
    }));

    // Handle attachments for the last user message
    if (attachments.length > 0 && contents.length > 0) {
        const lastContent = contents[contents.length - 1];
        if (lastContent.role === 'user') {
            const extraParts = await buildGeminiAttachmentParts(attachments);
            lastContent.parts = [...extraParts, ...lastContent.parts];
        }
    }

    // Add prefill as model message if configured
    const persona = getActivePersona();
    const prefillText = persona?.prefill?.trim() || '';
    if (prefillText) {
        contents.push({ role: 'model', parts: [{ text: prefillText }] });
    }
    state.currentPrefill = prefillText;

    // Build generationConfig with only enabled parameters
    const generationConfig = {
        maxOutputTokens: params.maxTokens
    };
    if (params.temperatureEnabled !== false) {
        generationConfig.temperature = params.temperature;
    }
    if (params.topPEnabled !== false) {
        generationConfig.topP = params.topP;
    }
    if (params.topKEnabled !== false) {
        generationConfig.topK = params.topK;
    }
    if (params.stopSequences.length > 0) {
        generationConfig.stopSequences = params.stopSequences;
    }

    // Add thinkingConfig inside generationConfig if not set to 'off'
    if (params.google.thinkingLevel && params.google.thinkingLevel !== 'off') {
        generationConfig.thinkingConfig = {
            thinkingLevel: params.google.thinkingLevel
        };
    }

    const requestBody = {
        contents: contents,
        systemInstruction: {
            parts: [{ text: systemPrompt }]
        },
        generationConfig: generationConfig,
        // Safety settings
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: params.google.safetyHarassment },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: params.google.safetyHate },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: params.google.safetySexual },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: params.google.safetyDangerous }
        ]
    };

    // Google uses URL parameter for API key
    const endpoint = `${CONFIG.endpoints.google}/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        // Parse Google-specific error format
        const errorMessage = parseGoogleError(errorData);
        throw new Error(errorMessage || `API request failed with status ${response.status}`);
    }

    const data = await response.json();

    // Extract content from Google response format (supports text + images)
    const candidate = data.candidates?.[0];
    if (!candidate) {
        throw new Error('No response candidates received from API');
    }

    // Parse multimodal response (text + generated images)
    const parsed = parseGoogleMultimodalResponse(candidate);

    // Handle responses with no content at all
    if (!parsed.text && parsed.generatedImages.length === 0) {
        throw new Error('No content received from API');
    }

    // Store any generated images to IndexedDB
    const generatedAttachments = await storeGeneratedImages(parsed.generatedImages);

    return {
        text: parsed.text || '',
        attachments: generatedAttachments
    };
}

/**
 * Parse Google API error response into user-friendly message
 * @param {Object} errorData - The error response from Google API
 * @returns {string} User-friendly error message
 */
function parseGoogleError(errorData) {
    if (errorData.error) {
        const message = errorData.error.message;
        const status = errorData.error.status;

        // Map common errors to user-friendly messages
        if (status === 'INVALID_ARGUMENT') {
            if (message && message.includes('API key')) {
                return 'Invalid Google API key. Please check your key in settings.';
            }
        }
        if (status === 'PERMISSION_DENIED') {
            return 'API key does not have permission. Enable the Generative Language API in Google Cloud Console.';
        }
        if (status === 'RESOURCE_EXHAUSTED') {
            return 'Rate limit exceeded. Please wait and try again.';
        }

        return message || `Google API error: ${status}`;
    }
    return 'Unknown error from Google API';
}

/**
 * Parse Google API response that may contain both text and images
 * @param {Object} candidate - The response candidate from Google API
 * @returns {Object} { text: string|null, generatedImages: Array }
 */
function parseGoogleMultimodalResponse(candidate) {
    const result = {
        text: null,
        generatedImages: []
    };

    if (!candidate?.content?.parts) {
        return result;
    }

    const textParts = [];

    for (const part of candidate.content.parts) {
        if (part.text) {
            textParts.push(part.text);
        } else if (part.inlineData) {
            result.generatedImages.push({
                mimeType: part.inlineData.mimeType,
                base64Data: part.inlineData.data
            });
        }
    }

    if (textParts.length > 0) {
        result.text = textParts.join('');
    }

    return result;
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

        if (att.type === 'image' && att.previewUrl) {
            const img = document.createElement('img');
            img.src = att.previewUrl;
            img.alt = att.fileName;
            item.appendChild(img);
        } else {
            const iconDiv = document.createElement('div');
            iconDiv.className = 'file-icon';
            iconDiv.textContent = getFileIcon(att.mimeType);
            item.appendChild(iconDiv);
        }

        const nameDiv = document.createElement('div');
        nameDiv.className = 'file-name';
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

async function buildAnthropicMessageContent(textContent, attachments) {
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
        } else if (att.type === 'code' || att.type === 'document') {
            // Read text files as text and include inline
            const text = await blob.text();
            contentParts.push({
                type: 'text',
                text: `[File: ${att.fileName}]\n${text}`
            });
        }
        // Audio is not natively supported by Anthropic - skip
    }

    // Add the user's text message
    if (textContent) {
        contentParts.push({ type: 'text', text: textContent });
    }

    return contentParts;
}

async function buildGeminiAttachmentParts(attachments) {
    const parts = [];

    for (const att of attachments) {
        const blob = await ImageStore.getBlob(att.imageStoreKey);
        if (!blob) continue;

        if (att.type === 'image' || att.mimeType === 'application/pdf' || att.type === 'audio') {
            const base64 = await blobToBase64(blob);
            parts.push({
                inline_data: { mime_type: att.mimeType, data: base64 }
            });
        } else if (att.type === 'code' || att.type === 'document') {
            const text = await blob.text();
            parts.push({
                text: `[File: ${att.fileName}]\n${text}`
            });
        }
    }

    return parts;
}

// ===== Event Listeners =====
function setupEventListeners() {
    // Sidebar toggle
    elements.openSidebar.addEventListener('click', openSidebar);
    elements.closeSidebar.addEventListener('click', closeSidebar);

    // Sidebar tabs
    document.querySelectorAll('.sidebar-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            switchTab(tab.dataset.tab);
        });
    });

    // Chats tab controls
    elements.newChatBtn.addEventListener('click', startNewConversation);
    elements.personaFilter.addEventListener('change', (e) => {
        state.ui.conversationFilter = e.target.value === 'all' ? 'all' : e.target.value;
        renderConversationList();
    });

    // Personas tab controls
    elements.newPersonaBtn.addEventListener('click', startNewPersona);

    // Close any open context menus when clicking elsewhere
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.context-menu') && !e.target.closest('.conversation-menu-btn') && !e.target.closest('.persona-menu-btn')) {
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
    
    // Size preset buttons - apply immediately and auto-save
    document.querySelectorAll('.size-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.size-preset-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            // Apply size immediately
            elements.avatarImage.className = `avatar-image size-${btn.dataset.size}`;
            autoSaveSettings();
        });
    });

    // Position preset buttons - apply immediately and auto-save
    document.querySelectorAll('.position-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.position-preset-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            // Apply position immediately
            elements.floatingAvatar.className = `floating-avatar ${btn.dataset.position}`;
            if (!state.settings.showAvatar) elements.floatingAvatar.classList.add('hidden');
            autoSaveSettings();
        });
    });

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

// ===== Auth Gate (P0-14) =====
// Decides whether to show the login screen or the main app on page load.
// The actual data layer is still localStorage-backed at this stage — that
// gets replaced in P0-15.

const OAUTH_ERROR_MESSAGES = {
    oauth_denied: 'Sign-in was cancelled. Please try again to continue.',
    invalid_state: 'Sign-in security check failed. Please try again.',
    no_code: 'Sign-in did not complete. Please try again.',
    oauth_failed: 'Sign-in failed. Please try again in a moment.',
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
        // Even if the server call fails, treat the client as signed out.
        console.warn('Logout request failed:', err);
    }
    state.user = null;
    if (btn) btn.disabled = false;
    showLoginScreen();
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
    // Wire static event listeners that exist regardless of auth state.
    const loginBtn = document.getElementById('googleSignInBtn');
    if (loginBtn) loginBtn.addEventListener('click', handleLoginClick);

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', handleLogoutClick);

    // If any future API call returns 401 (e.g., JWT expired), kick back to login.
    API.setOn401Handler(() => {
        state.user = null;
        showLoginScreen('Your session expired. Please sign in again.');
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
        await init();
    } else {
        showLoginScreen(callbackError);
    }
}

// ===== Start the App =====
document.addEventListener('DOMContentLoaded', bootstrap);
