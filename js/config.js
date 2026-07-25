/**
 * Configuration and defaults (R-02, moved verbatim from main.js).
 *
 * A true leaf — imports nothing. `getDefaultModelConfig()` lives here because
 * it is nothing but CONFIG.defaults reshaped into a model-config bag; state.js
 * calls it to seed `state.currentModelConfig`.
 */

// ===== Configuration =====
// Provider endpoints are gone from the frontend after P0-16 — all chat and
// model-list traffic goes through window.API → /api/chat[/stream] and
// /api/models/:provider, and the backend holds the keys.
export const CONFIG = {
    defaults: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        assistantName: 'Assistant',
        // Persona voice only. The expression protocol is NOT stated here — the
        // server's Tessera base layer supplies it, generated from the persona's
        // real expression set, so it can never go stale the way this text did.
        systemPrompt: `You are a helpful, friendly assistant. You provide clear and concise answers while being warm and personable.`,
        avatarSize: 'medium',
        avatarPosition: 'top-right',
        showAvatar: true,
        activeFileTurns: 1
    },
    // `keywords` is gone — expressions are declared by the model, never inferred
    // from the text. `generating` is the one reserved slot: it's the UI's own
    // "working on it" state, held for the whole response, and the model may
    // never declare it. Everything else here is an ordinary expression —
    // including `thinking`, which used to be reserved and is now free to be a
    // real character pose (hand on chin).
    defaultExpressions: {
        neutral: { emoji: '😊', imageKey: '' },
        happy: { emoji: '😄', imageKey: '' },
        sad: { emoji: '😢', imageKey: '' },
        thinking: { emoji: '🤔', imageKey: '' },
        excited: { emoji: '🎉', imageKey: '' },
        confused: { emoji: '😕', imageKey: '' },
        generating: { emoji: '💭', imageKey: '' }
    },
    /** The expression slot driven by the UI, never by the model. */
    generatingExpression: 'generating',
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
/**
 * Get the default model configuration structure
 * @returns {Object} Default model config
 */
export function getDefaultModelConfig() {
    return {
        provider: CONFIG.defaults.provider,
        model: CONFIG.defaults.model,
        modelParams: {
            temperature: 1.0,
            topP: 0.95,
            topK: 40,
            maxTokens: 4096,
            stopSequences: [],
            // Response prefill — an "engine" param like temperature, saved per
            // model profile (moved off the persona; personas are pure skin).
            prefill: '',
            streaming: false,
            temperatureEnabled: true,
            topPEnabled: true,
            topKEnabled: true,
            anthropic: {
                thinkingEnabled: false,
                thinkingBudget: 4000
            },
            google: {
                // thinkingApi selects which thinking control is sent: 'off',
                // 'level' (Gemini 3+ thinkingLevel) or 'budget' (Gemini 2.5
                // thinkingBudget). They're mutually exclusive in the API.
                thinkingApi: 'off',
                thinkingLevel: 'medium',
                thinkingBudget: -1,
                safetyHarassment: 'BLOCK_MEDIUM_AND_ABOVE',
                safetyHate: 'BLOCK_MEDIUM_AND_ABOVE',
                safetySexual: 'BLOCK_MEDIUM_AND_ABOVE',
                safetyDangerous: 'BLOCK_MEDIUM_AND_ABOVE'
            }
        }
    };
}
