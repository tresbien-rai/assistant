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
        expressions: 'ai_assistant_expressions'
    }
};

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

// ===== Migration: Base64 to IndexedDB =====
// Migrates existing Base64 image data from localStorage to IndexedDB
// This runs once on first load after the migration update
async function migrateBase64ToIndexedDB() {
    const migrationKey = 'ai_assistant_migration_v1';

    // Check if migration already done
    if (localStorage.getItem(migrationKey)) {
        return false; // Already migrated
    }

    console.log('ImageStore: Starting migration from Base64 to IndexedDB...');
    let migrationNeeded = false;

    try {
        // Initialize IndexedDB first
        await ImageStore.init();

        // Migrate avatar image from settings
        const savedSettings = localStorage.getItem(CONFIG.storageKeys.settings);
        if (savedSettings) {
            const settings = JSON.parse(savedSettings);

            // Check for old avatarData field (Base64)
            if (settings.avatarData && settings.avatarData.startsWith('data:')) {
                console.log('ImageStore: Migrating avatar image...');
                const blob = ImageStore.dataUrlToBlob(settings.avatarData);
                await ImageStore.store('avatar_main', blob);

                // Update settings to use key instead of data
                settings.avatarKey = 'avatar_main';
                delete settings.avatarData;
                localStorage.setItem(CONFIG.storageKeys.settings, JSON.stringify(settings));
                migrationNeeded = true;
                console.log('ImageStore: Avatar image migrated successfully');
            }
        }

        // Migrate expression images
        const savedExpressions = localStorage.getItem(CONFIG.storageKeys.expressions);
        if (savedExpressions) {
            const expressions = JSON.parse(savedExpressions);
            let expressionsMigrated = 0;

            for (const [name, expr] of Object.entries(expressions)) {
                // Check for old imageData field (Base64)
                if (expr.imageData && expr.imageData.startsWith('data:')) {
                    console.log(`ImageStore: Migrating expression image for "${name}"...`);
                    const blob = ImageStore.dataUrlToBlob(expr.imageData);
                    const key = `expr_${name}`;
                    await ImageStore.store(key, blob);

                    // Update expression to use key instead of data
                    expr.imageKey = key;
                    delete expr.imageData;
                    expressionsMigrated++;
                    migrationNeeded = true;
                }
            }

            if (expressionsMigrated > 0) {
                localStorage.setItem(CONFIG.storageKeys.expressions, JSON.stringify(expressions));
                console.log(`ImageStore: ${expressionsMigrated} expression images migrated successfully`);
            }
        }

        // Mark migration as complete
        localStorage.setItem(migrationKey, Date.now().toString());

        if (migrationNeeded) {
            console.log('ImageStore: Migration completed successfully!');
        } else {
            console.log('ImageStore: No migration needed (no Base64 data found)');
        }

        return migrationNeeded;
    } catch (error) {
        console.error('ImageStore: Migration failed:', error);
        // Don't set migration key so it can be retried
        return false;
    }
}

// ===== State Management =====
const state = {
    settings: {
        provider: CONFIG.defaults.provider,
        model: CONFIG.defaults.model,
        apiKey: '',
        assistantName: CONFIG.defaults.assistantName,
        systemPrompt: CONFIG.defaults.systemPrompt,
        avatarKey: '', // Key reference to image in IndexedDB
        avatarSize: CONFIG.defaults.avatarSize,
        avatarPosition: CONFIG.defaults.avatarPosition,
        showAvatar: CONFIG.defaults.showAvatar
    },
    expressions: { ...CONFIG.defaultExpressions },
    conversation: [],
    currentExpression: 'neutral',
    isLoading: false,
    sessionStartTime: Date.now(),
    estimatedTokens: 0,
    tempExpressionBlob: null, // Blob waiting to be saved when expression is saved
    tempExpressionPreviewUrl: '', // Object URL for preview in modal
    tempExpressionCleared: false // Flag indicating user explicitly cleared the image
};

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
    // Run migration first (converts Base64 data in localStorage to IndexedDB)
    await migrateBase64ToIndexedDB();

    // Initialize IndexedDB
    await ImageStore.init();

    // Load settings and expressions (may have been updated by migration)
    loadSettings();
    loadExpressions();

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
function loadSettings() {
    const saved = localStorage.getItem(CONFIG.storageKeys.settings);
    
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            state.settings = { ...CONFIG.defaults, ...parsed };
        } catch (e) {
            console.error('Failed to parse saved settings:', e);
        }
    }
    
    const savedConvo = localStorage.getItem(CONFIG.storageKeys.conversations);
    if (savedConvo) {
        try {
            state.conversation = JSON.parse(savedConvo);
        } catch (e) {
            console.error('Failed to parse saved conversation:', e);
        }
    }
}

function loadExpressions() {
    const saved = localStorage.getItem(CONFIG.storageKeys.expressions);
    
    if (saved) {
        try {
            state.expressions = JSON.parse(saved);
        } catch (e) {
            console.error('Failed to parse saved expressions:', e);
            state.expressions = { ...CONFIG.defaultExpressions };
        }
    }
}

async function saveSettings() {
    state.settings.provider = elements.providerSelect.value;
    state.settings.model = elements.modelSelect.value;
    state.settings.apiKey = elements.apiKeyInput.value;
    state.settings.assistantName = elements.assistantName.value || CONFIG.defaults.assistantName;
    state.settings.systemPrompt = elements.systemPrompt.value || CONFIG.defaults.systemPrompt;
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

    // Note: avatarKey is saved separately when image is uploaded

    localStorage.setItem(CONFIG.storageKeys.settings, JSON.stringify(state.settings));

    await updateUI();
    showNotification('Settings saved!', 'success');
    closeSidebar();
}

function saveConversation() {
    localStorage.setItem(CONFIG.storageKeys.conversations, JSON.stringify(state.conversation));
}

function saveExpressions() {
    localStorage.setItem(CONFIG.storageKeys.expressions, JSON.stringify(state.expressions));
}

// ===== UI Updates =====
async function updateUI() {
    // Update form inputs
    elements.providerSelect.value = state.settings.provider;
    elements.modelSelect.value = state.settings.model;
    elements.apiKeyInput.value = state.settings.apiKey;
    elements.assistantName.value = state.settings.assistantName;
    elements.systemPrompt.value = state.settings.systemPrompt;
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
    elements.headerAssistantName.textContent = state.settings.assistantName;
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

    name.textContent = state.settings.assistantName;

    if (state.settings.avatarKey) {
        const imageUrl = await ImageStore.get(state.settings.avatarKey);
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
    const currentExpr = state.expressions[state.currentExpression] || state.expressions.neutral;

    // Try to load expression image from IndexedDB
    let expressionImageUrl = null;
    if (currentExpr.imageKey) {
        expressionImageUrl = await ImageStore.get(currentExpr.imageKey);
    }

    // Try to load default avatar from IndexedDB
    let avatarImageUrl = null;
    if (state.settings.avatarKey) {
        avatarImageUrl = await ImageStore.get(state.settings.avatarKey);
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
        elements.avatarEmoji.textContent = currentExpr.emoji || '🤖';
    }

    // Update name and expression label
    elements.floatingAvatarName.textContent = state.settings.assistantName;
    elements.floatingAvatarExpression.textContent = state.currentExpression;
}

function updateStatusBar() {
    // Update mood
    const expr = state.expressions[state.currentExpression] || state.expressions.neutral;
    elements.statusMood.textContent = `${expr.emoji} ${state.currentExpression}`;
    
    // Update message count
    elements.statusMessages.textContent = state.conversation.length;
    
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

    for (const [name, expr] of Object.entries(state.expressions)) {
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

    if (name && state.expressions[name]) {
        const expr = state.expressions[name];
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

    // Determine the image key
    let imageKey = '';
    const oldExpr = editingExpression ? state.expressions[editingExpression] : null;
    const oldImageKey = oldExpr?.imageKey || '';

    try {
        if (state.tempExpressionBlob) {
            // User uploaded a new image - store it with the expression name as key
            imageKey = `expr_${name}`;
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
                imageKey = `expr_${name}`;
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
        delete state.expressions[editingExpression];
    }

    state.expressions[name] = { emoji, imageKey, keywords };

    saveExpressions();
    await renderExpressionList();
    closeExpressionModal();

    // Update floating avatar in case current expression changed
    await updateFloatingAvatar();

    // Update system prompt hint about available expressions
    updateSystemPromptExpressions();
}

async function deleteExpression() {
    if (!editingExpression) return;

    if (Object.keys(state.expressions).length <= 1) {
        alert('You must have at least one expression');
        return;
    }

    if (confirm(`Delete expression "${editingExpression}"?`)) {
        // Delete image from IndexedDB if exists
        const expr = state.expressions[editingExpression];
        if (expr?.imageKey) {
            await ImageStore.delete(expr.imageKey);
        }

        delete state.expressions[editingExpression];
        saveExpressions();
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
    // First, check for explicit expression tag
    const tagMatch = text.match(/\[expression:\s*(\w+)\]/i);
    if (tagMatch) {
        const exprName = tagMatch[1].toLowerCase();
        if (state.expressions[exprName]) {
            return exprName;
        }
    }
    
    // Fallback: keyword matching
    const lowerText = text.toLowerCase();
    
    for (const [name, expr] of Object.entries(state.expressions)) {
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
    if (state.expressions[exprName]) {
        state.currentExpression = exprName;
        await updateFloatingAvatar();
        updateStatusBar();
    }
}

// ===== Conversation Rendering =====
function renderConversation() {
    elements.messagesContainer.innerHTML = '';
    
    if (state.conversation.length === 0) {
        elements.messagesContainer.innerHTML = `
            <div class="welcome-message">
                <h1>Welcome!</h1>
                <p>${state.settings.apiKey ? 'Start chatting with ' + state.settings.assistantName + '!' : 'Configure your API key in the settings (☰) to get started.'}</p>
            </div>
        `;
        return;
    }
    
    state.conversation.forEach(msg => {
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
        state.conversation.push({ role, content: displayContent });
        saveConversation();
        
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
    const { provider, model, apiKey, systemPrompt } = state.settings;
    
    if (provider === 'anthropic') {
        return await callAnthropicAPI(userMessage, model, apiKey, systemPrompt);
    }
    
    throw new Error(`Provider ${provider} not yet implemented`);
}

async function callAnthropicAPI(userMessage, model, apiKey, systemPrompt) {
    const messages = state.conversation.map(msg => ({
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

    try {
        const blob = await ImageStore.fileToBlob(file);
        const key = 'avatar_main';

        await ImageStore.store(key, blob);
        state.settings.avatarKey = key;

        // Save key reference to localStorage
        localStorage.setItem(CONFIG.storageKeys.settings, JSON.stringify(state.settings));

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
    if (state.settings.avatarKey) {
        await ImageStore.delete(state.settings.avatarKey);
    }
    state.settings.avatarKey = '';
    localStorage.setItem(CONFIG.storageKeys.settings, JSON.stringify(state.settings));
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
        state.conversation = [];
        state.estimatedTokens = 0;
        state.currentExpression = 'neutral';
        saveConversation();
        renderConversation();
        updateStatusBar();
        await updateFloatingAvatar();
        closeSidebar();
    }
}

// ===== Start the App =====
document.addEventListener('DOMContentLoaded', init);
