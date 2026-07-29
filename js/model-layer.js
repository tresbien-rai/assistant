/**
 * The model layer (R-04b, moved verbatim from main.js).
 *
 * The provider catalog, the ACTIVE MODEL LAYER (`state.currentModelConfig`) and
 * the machinery that moves settings between a catalog model's saved profile and
 * that layer, plus the param-path helpers the model detail view reads and
 * writes through. Called from 38 places — it is the service layer the models
 * view, the personas view and the chat send path all stand on, which is why it
 * comes out first in R-04b.
 *
 * One passenger: `updateSendButtonState`. It is composer chrome, not model
 * machinery, but `applyModelToLayer` refreshes it on a provider switch and that
 * is the only edge tying it here. It belongs in `chat/composer.js` and should
 * move there in R-05.
 *
 * How profiles work (this note moved here with the code it describes): each
 * catalog model (`settings.customModels[provider][i]`) owns a `params` profile
 * — the full modelParams bag, prefill included. The active layer is just "the
 * currently loaded profile": switching models saves the outgoing model's params
 * to its profile and loads the incoming one's. A model that has never been used
 * keeps the carried-over params (and starts remembering from there), so nothing
 * resets unexpectedly.
 */

import { state } from './state.js';
import { elements } from './dom.js';
import { getDefaultModelConfig } from './config.js';
import { FilePanel } from './file-panel/index.js';

/**
 * Get the ACTIVE MODEL LAYER (WR-12) — the provider/model/params every send
 * and the model UI use. Callers may mutate the returned object; persistence
 * goes through persistSettings (+ mirrorLayerToModelProfile so the active
 * model's profile remembers the edits).
 * @returns {Object} The model configuration (provider, model, modelParams)
 */
export function getActiveModelConfig() {
    return state.currentModelConfig;
}

/** Find a model's catalog entry, or null. */
export function getCatalogEntry(provider, modelId) {
    const models = state.settings.customModels[provider] || [];
    return models.find(m => m.id === modelId) || null;
}

/**
 * Save the active layer's params into the profile of the layer's current
 * model. State-only — persistence rides on the caller's persistSettings()
 * (customModels is part of the settings payload).
 */
export function mirrorLayerToModelProfile() {
    const layer = getActiveModelConfig();
    const entry = getCatalogEntry(layer.provider, layer.model);
    if (!entry) return;
    entry.params = JSON.parse(JSON.stringify(layer.modelParams));
}

/**
 * Load the layer's current model's saved profile into the layer. Models with
 * no profile yet keep the carried-over params (today's behavior) — their
 * profile is written on the next edit/switch. Deep-copied so later layer
 * edits don't silently mutate the stored profile.
 */
export function loadModelProfileIntoLayer() {
    const layer = getActiveModelConfig();
    const entry = getCatalogEntry(layer.provider, layer.model);
    if (!entry || !entry.params) return;
    const merged = mergeModelConfig({ modelParams: entry.params });
    layer.modelParams = JSON.parse(JSON.stringify(merged.modelParams));
}

/**
 * Core model switch: remember the outgoing model's params in its profile,
 * move the layer to the new provider/model, and load the incoming profile.
 * @returns {boolean} true if the layer actually changed.
 */
export function applyModelToLayer(provider, modelId) {
    const layer = getActiveModelConfig();
    if (layer.provider === provider && layer.model === modelId) return false;
    mirrorLayerToModelProfile();
    if (layer.provider !== provider) {
        layer.provider = provider;
        // Provider-switch housekeeping. The old provider <select>, model
        // dropdown, API-key field, and static Advanced params are gone (Slices
        // 4–5) — switching is via catalog cards, the key is provider-owned, and
        // params live in the per-model detail view. The send button still needs
        // a refresh; the catalog/chips refresh on the ensuing updateUI.
        updateSendButtonState();
    }
    layer.model = modelId;
    loadModelProfileIntoLayer();
    return true;
}

/** Find which provider a catalog model id belongs to, or null if not saved. */
export function findModelProvider(modelId) {
    for (const provider of Object.keys(state.settings.customModels)) {
        if ((state.settings.customModels[provider] || []).some(m => m.id === modelId)) {
            return provider;
        }
    }
    return null;
}

/** @returns {'shared'|'fixed'} */
export function personaModelMode(persona) {
    return persona?.modelConfig?.mode === 'fixed' ? 'fixed' : 'shared';
}

/**
 * Merge a (possibly incomplete) modelConfig from the server with the
 * frontend's default structure. Server-provided values win; missing fields
 * are filled from the default. Returns a brand-new object — never mutates
 * the default.
 */
export function mergeModelConfig(serverConfig) {
    const defaults = getDefaultModelConfig();
    if (!serverConfig || typeof serverConfig !== 'object') return defaults;
    const incoming = serverConfig.modelParams || {};
    const incomingAnthropic = incoming.anthropic || {};
    const incomingGoogle = incoming.google || {};
    return {
        provider: serverConfig.provider || defaults.provider,
        model: serverConfig.model || defaults.model,
        // Persona model-settings mode (WR-12). Absent = 'shared'; must survive
        // the merge or fixed personas would reset on every reload.
        ...(serverConfig.mode === 'fixed' ? { mode: 'fixed' } : {}),
        modelParams: {
            ...defaults.modelParams,
            ...incoming,
            anthropic: { ...defaults.modelParams.anthropic, ...incomingAnthropic },
            google: { ...defaults.modelParams.google, ...incomingGoogle },
        },
    };
}

/** Read a value from a params bag by descriptor path ('temperature' or 'google.x'). */
export function getParamByPath(params, path) {
    if (!path.includes('.')) return params[path];
    const [ns, key] = path.split('.');
    return (params[ns] || {})[key];
}

/** Write a value into a params bag by descriptor path, creating the namespace. */
export function setParamByPath(params, path, value) {
    if (!path.includes('.')) { params[path] = value; return; }
    const [ns, key] = path.split('.');
    if (!params[ns]) params[ns] = {};
    params[ns][key] = value;
}

/** A descriptor is visible unless its showWhen dependency isn't met. */
export function paramVisible(d, params) {
    if (!d.showWhen) return true;
    return getParamByPath(params, d.showWhen.path) === d.showWhen.eq;
}

/** Find a provider's descriptor by path. */
export function descByPath(provider, path) {
    return (PROVIDERS[provider]?.params || []).find(d => d.path === path) || null;
}

/** Format a numeric value for display (2 dp for fractional ranges, else integer). */
export function fmtParamValue(v, d) {
    if (d && d.control === 'range' && d.step && d.step < 1) return Number(v).toFixed(2);
    return String(v);
}

/**
 * The editable params object for a model. For the active model it's the live
 * layer (edits take effect immediately); otherwise it's the model's stored
 * profile (seeded from defaults on first edit). Returns null if the model isn't
 * in the catalog.
 */
export function getModelParamsForEdit(provider, modelId) {
    const layer = getActiveModelConfig();
    if (layer.provider === provider && layer.model === modelId) return layer.modelParams;
    const entry = getCatalogEntry(provider, modelId);
    if (!entry) return null;
    if (!entry.params) entry.params = JSON.parse(JSON.stringify(getDefaultModelConfig().modelParams));
    return entry.params;
}

export function formatNumber(num) {
    if (num >= 1000) {
        return (num / 1000).toFixed(1) + 'k';
    }
    return num.toString();
}

export function getModelDisplayName(modelId) {
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

export function updateSendButtonState() {
    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;
    const hasApiKey = !!state.apiKeyStatus[provider]?.hasKey;
    const hasMessage = elements.messageInput.value.trim().length > 0;
    const hasAttachments = state.pendingAttachments.length > 0;
    const notLoading = !state.isLoading;

    elements.sendButton.disabled = !(hasApiKey && (hasMessage || hasAttachments) && notLoading);
    // Lock/unlock the file panel editor in step with the turn (SP-03b). This is
    // the one place isLoading transitions are always reflected in the UI.
    FilePanel.syncTurnLock();
}

// Provider brand marks — monochrome SVGs from Simple Icons (simpleicons.org),
// vendored inline so there are no external requests and they work offline. They
// inherit text color via fill="currentColor", so they adapt to theme and to a
// chip's active/hover state for free. Sized by the .provider-icon CSS class.
export const PROVIDER_ICON_ANTHROPIC = '<svg class="provider-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/></svg>';

export const PROVIDER_ICON_GEMINI = '<svg class="provider-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"/></svg>';

export const PROVIDER_ICON_OPENAI = '<svg class="provider-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>';

// Generic fallback (chip outline) for providers with no bundled mark, so the
// chip row and headers never break as new providers are added.
export const PROVIDER_ICON_FALLBACK = '<svg class="provider-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></svg>';

/** Inline brand mark for a provider, or the generic fallback. */
export function providerIconHtml(provider) {
    return PROVIDERS[provider]?.icon || PROVIDER_ICON_FALLBACK;
}

export const GEMINI_SAFETY_PARAMS = ['Harassment', 'Hate', 'Sexual', 'Dangerous'].map(cat => ({
    path: `google.safety${cat}`, label: cat, group: 'behaviour', subgroup: 'safety',
    control: 'select', default: 'BLOCK_MEDIUM_AND_ABOVE',
    options: [
        { value: 'BLOCK_LOW_AND_ABOVE',    label: 'Block most' },
        { value: 'BLOCK_MEDIUM_AND_ABOVE', label: 'Block some' },
        { value: 'BLOCK_ONLY_HIGH',        label: 'Block few'  },
        { value: 'BLOCK_NONE',             label: 'Block none' },
        { value: 'OFF',                    label: 'Off'        },
    ],
}));

// The param definitions each provider's detail view renders. They live here
// because PROVIDERS below is their only consumer.
export const SAMPLING_PARAMS = [
    { path: 'temperature', label: 'Temperature', group: 'sampling',
      control: 'range', min: 0, max: 2, step: 0.01, default: 1.0,
      enableKey: 'temperatureEnabled',
      help: 'Higher = more creative, lower = more focused.' },
    { path: 'topP', label: 'Top P', group: 'sampling',
      control: 'range', min: 0, max: 1, step: 0.01, default: 0.95,
      enableKey: 'topPEnabled' },
    { path: 'topK', label: 'Top K', group: 'sampling',
      control: 'number', min: 1, max: 100, default: 40, enableKey: 'topKEnabled' },
    { path: 'maxTokens', label: 'Max tokens', group: 'sampling',
      control: 'number', min: 1, max: 32000, default: 4096 },
    { path: 'stopSequences', label: 'Stop sequences', group: 'sampling',
      control: 'tags', default: [] },
];


export const BEHAVIOUR_PARAMS = [
    { path: 'streaming', label: 'Streaming', group: 'behaviour',
      control: 'toggle', default: false },
    { path: 'prefill', label: 'Response prefill', group: 'behaviour',
      control: 'textarea', default: '',
      help: 'The model continues from this text (hidden in responses).' },
];


export const ANTHROPIC_EXTRA_PARAMS = [
    { path: 'anthropic.thinkingEnabled', label: 'Extended thinking', group: 'behaviour',
      control: 'toggle', default: false, help: 'Deeper reasoning (Claude 4+).' },
    { path: 'anthropic.thinkingBudget', label: 'Thinking budget', group: 'behaviour',
      control: 'number', min: 1024, max: 32000, default: 4000, unit: 'tokens',
      showWhen: { path: 'anthropic.thinkingEnabled', eq: true } },
];


export const GEMINI_EXTRA_PARAMS = [
    // Gemini's thinking control split by model generation, exposed via a
    // user-set mode switch (the general model-variant pattern): 'level' and
    // 'budget' are mutually exclusive in the API and can't be auto-detected
    // from an arbitrary model id. mediaResolution was dropped — it's Gemini-3
    // only, per-attachment, and was never sent by the backend.
    { path: 'google.thinkingApi', label: 'Thinking control', group: 'behaviour',
      control: 'select', default: 'off',
      options: [
        { value: 'off',    label: 'Off' },
        { value: 'level',  label: 'Level (Gemini 3+)' },
        { value: 'budget', label: 'Budget (Gemini 2.5)' },
      ] },
    { path: 'google.thinkingLevel', label: 'Thinking level', group: 'behaviour',
      control: 'select', default: 'medium',
      options: ['minimal', 'low', 'medium', 'high'],
      showWhen: { path: 'google.thinkingApi', eq: 'level' } },
    { path: 'google.thinkingBudget', label: 'Thinking budget', group: 'behaviour',
      control: 'number', min: -1, max: 32000, default: -1, unit: 'tokens',
      help: '0 = off, -1 = dynamic.',
      showWhen: { path: 'google.thinkingApi', eq: 'budget' } },
    ...GEMINI_SAFETY_PARAMS,
];

/**
 * Switch the active model — and, when the model belongs to another provider,
 * the provider with it (WR-11: the top-bar menu lists all providers' models;
 * persona/character is retained across the switch by design). Saves the
 * outgoing model's params to its profile and loads the incoming model's
 * (model profiles). No-op if unchanged.
 * @param {string} modelId
 * @param {string} [provider] - the model's provider; defaults to the current one.
 */

export const PROVIDERS = {
    anthropic: {
        id: 'anthropic', label: 'Anthropic', tagline: 'Claude', status: 'live',
        icon: PROVIDER_ICON_ANTHROPIC, keyPlaceholder: 'sk-ant-…',
        params: [...SAMPLING_PARAMS, ...BEHAVIOUR_PARAMS, ...ANTHROPIC_EXTRA_PARAMS],
    },
    google: {
        id: 'google', label: 'Google', tagline: 'Gemini', status: 'live',
        icon: PROVIDER_ICON_GEMINI, keyPlaceholder: 'AIza…',
        params: [...SAMPLING_PARAMS, ...BEHAVIOUR_PARAMS, ...GEMINI_EXTRA_PARAMS],
    },
    openai: {
        id: 'openai', label: 'OpenAI', tagline: 'GPT', status: 'soon',
        icon: PROVIDER_ICON_OPENAI, keyPlaceholder: 'sk-…',
        params: [],
    },
};
