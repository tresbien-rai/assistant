/**
 * Persona helpers (R-04b, moved verbatim from main.js).
 *
 * The small, shared persona operations that both the chats view and the
 * personas view need: creating one, hydrating the set from the server, the
 * avatar markup, and applying a persona's model settings to the active layer.
 * A leaf apart from state and the model layer — extracted ahead of the view
 * clusters so neither has to reach into the other for them.
 */

import { state } from './state.js';
import { CONFIG } from './config.js';
import { API } from './api-client.js';
import {
    personaModelMode, applyModelToLayer, getCatalogEntry, } from './model-layer.js';
import { persistSettings } from './settings-store.js';
import { escapeHtml } from './util/format.js';

/**
 * Create a new persona server-side and set it as active.
 * Server generates the id — callers must await this.
 * @param {string} [name] - Optional name, defaults to "Assistant"
 * @returns {Promise<string>} The server-generated persona ID
 */
export async function createPersona(name = CONFIG.defaults.assistantName) {
    // New personas are pure skin: shared model mode, no pin. Engine settings
    // (params, prefill) live on model profiles, not here.
    const modelConfig = {};
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
        tagline: created.tagline || '',
        roleLabel: created.roleLabel || '',
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
 * Apply a persona's model-settings mode on activation: 'fixed' selects its
 * pinned model (loading that model's profile); 'shared' leaves the layer
 * untouched.
 */
export function applyPersonaModelSettings(persona) {
    if (!persona || personaModelMode(persona) !== 'fixed') return;
    const pin = persona.modelConfig || {};
    if (!pin.provider || !pin.model) return;
    // One-time legacy migration: pre-profiles fixed personas snapshotted full
    // params. Seed the pinned model's profile from them (unless it already
    // has one), fold in the persona's old prefill, then slim to a pure pin.
    if (pin.modelParams) {
        const entry = getCatalogEntry(pin.provider, pin.model);
        if (entry && !entry.params) {
            entry.params = JSON.parse(JSON.stringify(pin.modelParams));
            if (persona.prefill && entry.params.prefill === undefined) {
                entry.params.prefill = persona.prefill;
            }
        }
        persona.modelConfig = { mode: 'fixed', provider: pin.provider, model: pin.model };
        persona.updatedAt = Date.now();
    }
    applyModelToLayer(pin.provider, pin.model);
    persistSettings();
}

export function hydratePersonas(personas) {
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
        // The generating slot must always exist — otherwise setExpression()
        // silently no-ops while the model works and the slot never appears in
        // the expression editor. Personas predating it get it backfilled.
        // Note this deliberately leaves any existing `thinking` entry alone:
        // it used to be this reserved slot, and now demotes to an ordinary
        // expression, art and all.
        if (!expressions[CONFIG.generatingExpression]) {
            expressions[CONFIG.generatingExpression] = { ...CONFIG.defaultExpressions.generating };
        }
        state.personas[p.id] = {
            id: p.id,
            name: p.name,
            tagline: p.tagline || '',
            roleLabel: p.roleLabel || '',
            systemPrompt: p.systemPrompt || '',
            prefill: p.prefill || '',
            avatarFilename: p.avatarFilename || '',
            expressions,
            // Model profiles: a persona's modelConfig is a slim pin
            // ({ mode:'fixed', provider, model }) or {} for shared. Kept raw —
            // legacy full snapshots keep their modelParams so
            // applyPersonaModelSettings can seed the pinned model's profile
            // once, then slims them down.
            modelConfig: (p.modelConfig && typeof p.modelConfig === 'object') ? p.modelConfig : {},
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
        };
    }
}

/**
 * Inner avatar markup (img or emoji) for a persona. Shared by the persona-
 * grouped chat list and the workspace chat rows.
 * @param {Object} persona
 * @returns {string}
 */
export function personaAvatarHTML(persona) {
    if (!persona) return `<span class="avatar-emoji">🤖</span>`;
    if (persona.avatarFilename) {
        // Cache-bust by updatedAt so a re-upload is reflected immediately.
        const cacheBust = persona.updatedAt ? `?v=${persona.updatedAt}` : '';
        const imageUrl = `${API.avatars.getUrl(persona.id)}${cacheBust}`;
        return `<img src="${imageUrl}" alt="${escapeHtml(persona.name || '')}">`;
    }
    const firstExpr = Object.values(persona.expressions || {})[0];
    const avatarEmoji = firstExpr?.emoji || '🤖';
    return `<span class="avatar-emoji">${avatarEmoji}</span>`;
}
