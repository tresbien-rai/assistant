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
        neutral: { emoji: '😊', imageData: '', keywords: [] },
        happy: { emoji: '😄', imageData: '', keywords: ['happy', 'glad', 'wonderful', 'great', 'love', 'excited', 'awesome', 'fantastic'] },
        sad: { emoji: '😢', imageData: '', keywords: ['sorry', 'unfortunately', 'sad', 'regret', 'apologize', 'difficult'] },
        thinking: { emoji: '🤔', imageData: '', keywords: ['hmm', 'consider', 'perhaps', 'maybe', 'wondering', 'think', 'analyze'] },
        excited: { emoji: '🎉', imageData: '', keywords: ['amazing', 'incredible', 'wow', 'excellent', 'brilliant', 'outstanding'] },
        confused: { emoji: '😕', imageData: '', keywords: ['confused', 'unclear', 'not sure', 'don\'t understand', 'puzzled'] }
    },
    storageKeys: {
        settings: 'ai_assistant_settings',
        conversations: 'ai_assistant_conversations',
        expressions: 'ai_assistant_expressions'
    }
};

// ===== State Management =====
const state = {
    settings: {
        provider: CONFIG.defaults.provider,
        model: CONFIG.defaults.model,
        apiKey: '',
        assistantName: CONFIG.defaults.assistantName,
        systemPrompt: CONFIG.defaults.systemPrompt,
        avatarData: '', // Base64 encoded image data
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
    tempExpressionImage: '' // Temporary storage for expression image being edited
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
function init() {
    loadSettings();
    loadExpressions();
    setupEventListeners();
    updateUI();
    createSidebarOverlay();
    startSessionTimer();
    
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

function saveSettings() {
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
    
    // Note: avatarData is saved separately when image is uploaded
    
    localStorage.setItem(CONFIG.storageKeys.settings, JSON.stringify(state.settings));
    
    updateUI();
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
function updateUI() {
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
    
    // Update avatar preview in settings
    updateAvatarPreview();
    
    // Update floating avatar
    updateFloatingAvatar();
    
    // Update avatar toggle button
    elements.avatarToggleBtn.classList.toggle('active', state.settings.showAvatar);
    
    // Update status bar
    updateStatusBar();
    
    // Update expression list
    renderExpressionList();
    
    // Update send button state
    updateSendButtonState();
    
    // Render conversation
    renderConversation();
}

function updateAvatarPreview() {
    const preview = elements.avatarPreview;
    const name = elements.avatarPreviewName;
    const status = elements.avatarPreviewStatus;
    
    name.textContent = state.settings.assistantName;
    
    if (state.settings.avatarData) {
        preview.innerHTML = `<img src="${state.settings.avatarData}" alt="Avatar">`;
        status.textContent = 'Custom Avatar';
    } else {
        preview.textContent = '🤖';
        status.textContent = 'Default Avatar';
    }
}

function updateFloatingAvatar() {
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
    
    if (currentExpr.imageData) {
        // Expression has a custom image
        elements.avatarEmoji.style.display = 'none';
        elements.avatarImg.style.display = 'block';
        elements.avatarImg.src = currentExpr.imageData;
    } else if (state.settings.avatarData) {
        // Use default avatar
        elements.avatarEmoji.style.display = 'none';
        elements.avatarImg.style.display = 'block';
        elements.avatarImg.src = state.settings.avatarData;
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
function renderExpressionList() {
    const list = elements.expressionList;
    list.innerHTML = '';
    
    Object.entries(state.expressions).forEach(([name, expr]) => {
        const item = document.createElement('div');
        item.className = 'expression-item';
        item.onclick = () => openExpressionModal(name);
        
        item.innerHTML = `
            <div class="expression-item-emoji">
                ${expr.imageData ? `<img src="${expr.imageData}" alt="${name}">` : expr.emoji}
            </div>
            <span class="expression-item-name">${name}</span>
            <span class="expression-item-edit">Edit →</span>
        `;
        
        list.appendChild(item);
    });
}

let editingExpression = null;

function openExpressionModal(name = null) {
    editingExpression = name;
    state.tempExpressionImage = ''; // Reset temp image
    
    if (name && state.expressions[name]) {
        const expr = state.expressions[name];
        elements.expressionModalTitle.textContent = 'Edit Expression';
        elements.expressionName.value = name;
        elements.expressionEmoji.value = expr.emoji;
        elements.expressionKeywords.value = expr.keywords.join(', ');
        elements.deleteExpressionBtn.style.display = 'block';
        
        // Update image preview
        if (expr.imageData) {
            state.tempExpressionImage = expr.imageData;
            elements.expressionImagePreview.innerHTML = `<img src="${expr.imageData}" alt="${name}">`;
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
    state.tempExpressionImage = '';
}

function saveExpression() {
    const name = elements.expressionName.value.trim().toLowerCase();
    const emoji = elements.expressionEmoji.value.trim() || '😊';
    const imageData = state.tempExpressionImage; // Use temp image data
    const keywords = elements.expressionKeywords.value
        .split(',')
        .map(k => k.trim().toLowerCase())
        .filter(k => k.length > 0);
    
    if (!name) {
        alert('Please enter an expression name');
        return;
    }
    
    // If renaming, delete old entry
    if (editingExpression && editingExpression !== name) {
        delete state.expressions[editingExpression];
    }
    
    state.expressions[name] = { emoji, imageData, keywords };
    
    saveExpressions();
    renderExpressionList();
    closeExpressionModal();
    
    // Update system prompt hint about available expressions
    updateSystemPromptExpressions();
}

function deleteExpression() {
    if (!editingExpression) return;
    
    if (Object.keys(state.expressions).length <= 1) {
        alert('You must have at least one expression');
        return;
    }
    
    if (confirm(`Delete expression "${editingExpression}"?`)) {
        delete state.expressions[editingExpression];
        saveExpressions();
        renderExpressionList();
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

function setExpression(exprName) {
    if (state.expressions[exprName]) {
        state.currentExpression = exprName;
        updateFloatingAvatar();
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
        setExpression(detectedExpr);
        
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
    elements.avatarToggleBtn.addEventListener('click', () => {
        state.settings.showAvatar = !state.settings.showAvatar;
        elements.showAvatar.checked = state.settings.showAvatar;
        localStorage.setItem(CONFIG.storageKeys.settings, JSON.stringify(state.settings));
        updateFloatingAvatar();
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
 * Convert a file to Base64 string
 */
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = (error) => reject(error);
        reader.readAsDataURL(file);
    });
}

/**
 * Handle avatar image upload
 */
async function handleAvatarUpload(file) {
    // Validate file type
    if (!file.type.startsWith('image/')) {
        alert('Please select an image file');
        return;
    }
    
    // Validate file size (max 2MB)
    const maxSize = 2 * 1024 * 1024;
    if (file.size > maxSize) {
        alert('Image is too large. Please select an image under 2MB.');
        return;
    }
    
    try {
        const base64 = await fileToBase64(file);
        state.settings.avatarData = base64;
        
        // Save immediately
        localStorage.setItem(CONFIG.storageKeys.settings, JSON.stringify(state.settings));
        
        // Update previews
        updateAvatarPreview();
        updateFloatingAvatar();
        
        showNotification('Avatar uploaded!', 'success');
    } catch (error) {
        console.error('Failed to upload avatar:', error);
        alert('Failed to upload image. Please try again.');
    }
}

/**
 * Clear the avatar image
 */
function clearAvatarImage() {
    state.settings.avatarData = '';
    localStorage.setItem(CONFIG.storageKeys.settings, JSON.stringify(state.settings));
    updateAvatarPreview();
    updateFloatingAvatar();
}

/**
 * Handle expression image upload
 */
async function handleExpressionImageUpload(file) {
    // Validate file type
    if (!file.type.startsWith('image/')) {
        alert('Please select an image file');
        return;
    }
    
    // Validate file size (max 1MB for expressions since there can be many)
    const maxSize = 1 * 1024 * 1024;
    if (file.size > maxSize) {
        alert('Image is too large. Please select an image under 1MB.');
        return;
    }
    
    try {
        const base64 = await fileToBase64(file);
        state.tempExpressionImage = base64;
        
        // Update preview in modal
        elements.expressionImagePreview.innerHTML = `<img src="${base64}" alt="Expression preview">`;
        
    } catch (error) {
        console.error('Failed to upload expression image:', error);
        alert('Failed to upload image. Please try again.');
    }
}

/**
 * Clear the expression image in the modal
 */
function clearExpressionImage() {
    state.tempExpressionImage = '';
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

function clearConversation() {
    if (confirm('Are you sure you want to clear the conversation? This cannot be undone.')) {
        state.conversation = [];
        state.estimatedTokens = 0;
        state.currentExpression = 'neutral';
        saveConversation();
        renderConversation();
        updateStatusBar();
        updateFloatingAvatar();
        closeSidebar();
    }
}

// ===== Start the App =====
document.addEventListener('DOMContentLoaded', init);
