/**
 * The settings store (R-04b, moved verbatim from main.js).
 *
 * Everything that persists user state to the server: settings, personas, the
 * model catalog, and the encrypted provider API keys — plus the debounced
 * auto-save that most of the UI mutates through.
 *
 * It repaints after a save (a settings change redraws the settings surface; a
 * key change redraws the models catalog and the add-model modal), but it does
 * that through the shell seam rather than by importing the views. That is what
 * lets this file and js/views/models.js be separate modules at all — before the
 * seam they were one mutually recursive cluster.
 *
 * `autoSaveTimeout` stays module-private: it is the debounce handle, and
 * nothing outside has any business touching it.
 */

import { state } from './state.js';
import { elements } from './dom.js';
import { API } from './api-client.js';
import { getActiveModelConfig, mirrorLayerToModelProfile } from './model-layer.js';
import { personaModelMode, updateSendButtonState } from './model-layer.js';
import { CONFIG } from './config.js';
import { getActivePersona } from './state.js';
import { confirmDialog } from './components/dialogs.js';
import { updateSettingsUI, renderModelsCatalog, refreshAddModelModal } from './shell.js';
import { displayError } from './components/errors.js';

/**
 * Keep the active fixed persona's pin pointing at the layer's current model.
 * A model/provider switch made while a fixed persona is active re-pins it
 * (last-used auto-save, same spirit as pre-profiles WR-12). State-only;
 * persistSettings()'s savePersonas ride-along persists it.
 */
export function updateFixedPersonaPin() {
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
 * Persist all personas to the server.
 * Fire-and-forget by design: most callers are UI handlers that don't need to
 * block on the round-trip; failures are logged but don't surface in P0-15
 * (toast UX comes in P0-17). Runs the updates in parallel.
 */
export function savePersonas() {
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

export function hydrateApiKeyStatus(apiKeyStatus) {
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

// ===== Real-Time Auto-Save =====
// Debounces the settings PUT so a slider drag or a fast typist doesn't churn
// /api/settings. API keys have their own explicit save path now (saveProviderKey
// from the provider key popover), not this settings tick.
let autoSaveTimeout = null;

/**
 * Debounced auto-save function
 * Saves settings after 300ms of no changes to avoid excessive writes
 */
export function autoSaveSettings() {
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
export function saveCatalogProviders(providers) {
    state.settings.catalogProviders =
        Array.isArray(providers) && providers.length ? providers : null;
    autoSaveSettings();
}

/**
 * Collect all current UI values into state
 */
export function saveAllSettingsFromUI() {
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
export async function saveProviderKey(provider, value) {
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
export async function clearStoredApiKey(provider) {
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
export function persistSettings() {
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
