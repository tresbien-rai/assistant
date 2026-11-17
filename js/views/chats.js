/**
 * The Chats view (R-04b, moved verbatim from main.js).
 *
 * The chat list — grouped rows, row menus, rename/delete — together with the
 * conversation lifecycle it drives: create, switch, load messages, save, and
 * restoring the model a conversation was last running on.
 *
 * List and lifecycle are one module because they are one mutually recursive
 * cluster: a row switches the conversation, and switching repaints the list.
 * Splitting them would need another seam and buys nothing today.
 */

import { state, getActivePersona } from '../state.js';
import { elements } from '../dom.js';
import { API } from '../api-client.js';
import { CONFIG } from '../config.js';
import {
    navigate, updateUI, renderMainView, renderShell, renderRail,
    refreshContainerChats, mobileMenuButtonHTML, showPersonaPopover, showModelMenu,
} from '../shell.js';
import {
    personaModelMode, findModelProvider, applyModelToLayer,
    getActiveModelConfig, getModelDisplayName,
} from '../model-layer.js';
import { persistSettings } from '../settings-store.js';
import { setActiveConversation, forgetConversationDraft } from '../active-conversation.js';
import { personaAvatarHTML, applyPersonaModelSettings } from '../persona-helpers.js';
import { escapeHtml, formatTimeAgo } from '../util/format.js';
import { displayError } from '../components/errors.js';
import { confirmDialog, promptName } from '../components/dialogs.js';
import { positionPopover, attachPopoverOutsideClose } from '../components/menus.js';
import { updateStatusBar } from '../status-bar.js';
import { loadUsage } from './usage-panel.js';

/**
 * Create a new conversation server-side and set it as active.
 * The server generates the id — callers must await this.
 * @param {string} [title] - Optional title, defaults to "New Chat"
 * @returns {Promise<string>} The server-generated conversation ID
 */
export async function createConversation(title = 'New Chat', container = null) {
    // Container is explicit (caller decides the home): the Chats tab creates
    // unfiled chats; the Workspaces drill-in creates workspace-/project-level
    // ones. The server derives workspace_id from a project. Persona is always
    // the currently-active one (P2-U3b model).
    const target = container || {};
    const created = await API.conversations.create({
        personaId: state.activePersonaId,
        projectId: target.projectId || null,
        workspaceId: target.workspaceId || null,
        title,
    });
    state.conversations[created.id] = {
        id: created.id,
        title: created.title,
        personaId: created.personaId,
        projectId: created.projectId,
        workspaceId: created.workspaceId,
        toolsEnabled: created.toolsEnabled ?? null,
        scratchpadEnabled: created.scratchpadEnabled ?? null,
        presetId: created.presetId ?? null,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        lastMessageAt: null,   // nothing said in it yet
        messageCount: 0,
        messages: [],
    };
    // Creating a chat makes it active, which is a conversation change like any
    // other — the composer moves with it (F-04). On the auto-create path inside a
    // send (appendMessage → here) the composer has already been emptied and its
    // draft dropped, so the transition runs but has nothing to move.
    setActiveConversation(created.id);

    // Apply a per-chat file-tools override chosen BEFORE the chat was persisted
    // (the toggle was flipped on a fresh, unsaved chat).
    if (state.pendingToolsOverride != null) {
        const override = state.pendingToolsOverride;
        state.pendingToolsOverride = undefined;
        state.conversations[created.id].toolsEnabled = override;
        try {
            await API.conversations.update(created.id, { toolsEnabled: override });
        } catch (err) {
            console.error('Failed to persist pending tools override:', err);
        }
    }

    // Same for a prompt preset chosen before the chat existed (AP-04).
    if (state.pendingPresetId != null) {
        const presetId = state.pendingPresetId;
        state.pendingPresetId = undefined;
        state.conversations[created.id].presetId = presetId;
        try {
            await API.conversations.update(created.id, { presetId });
        } catch (err) {
            console.error('Failed to persist pending preset override:', err);
        }
    }

    return created.id;
}

/**
 * Restore a chat's model on open: the model that produced its last assistant
 * reply (per-message tag, WR-14) becomes the active model again, profile and
 * all — so coming back to a conversation keeps the engine it was running on.
 * Skipped when the chat's persona pins a model (fixed mode wins), when the
 * chat has no tagged replies yet, or when the tagged model is no longer in
 * the catalog. Requires convo.messages to be loaded.
 */
export function restoreConversationModel(convo) {
    if (!convo || !Array.isArray(convo.messages)) return;
    if (personaModelMode(getActivePersona()) === 'fixed') return;
    const lastTagged = [...convo.messages].reverse()
        .find(m => m.role === 'assistant' && m.model);
    if (!lastTagged) return;
    const provider = findModelProvider(lastTagged.model);
    if (!provider) return; // removed from the catalog — keep the current model
    if (applyModelToLayer(provider, lastTagged.model)) {
        persistSettings();
    }
}

/**
 * Lazy-load a conversation's full message history. Idempotent: if messages
 * are already loaded (or being loaded), returns without an extra fetch.
 */
export async function loadConversationMessages(conversationId) {
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

/**
 * Persist conversation metadata for the active conversation (title, personaId).
 * Fire-and-forget. Per-message persistence is NOT handled here — see
 * persistMessage() for that path. Most call sites just want "I tweaked the
 * conversation; flush it" and that's what this does.
 */
export function saveConversations() {
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
 * When this chat was last ACTIVE — the timestamp of its newest message, or,
 * for a chat nothing has been said in yet, when it was created.
 *
 * Deliberately not `updatedAt`: that is bumped by every metadata write, so
 * renaming a chat used to reset it to "Just now" and shuffle the row to the top
 * of the list. Reorganising a chat history made every chat look the same age.
 * `lastMessageAt` comes from the server (MAX of the messages' timestamps) and is
 * kept fresh locally by the two paths that append a message.
 *
 * @param {Object} convo
 * @returns {number} epoch ms
 */
export function conversationActivityAt(convo) {
    return convo.lastMessageAt || convo.createdAt || convo.updatedAt || 0;
}

const INITIAL_GROUP_LIMIT = 4;
const EXPAND_STEP = 10;

const HOME_FOLDER_SVG = '<svg class="chats-home-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V6.15C4 5.84 4.07 5.53 4.21 5.25L5.05 3.6H11.2L12.4 6H21C21.5523 6 22 6.44772 22 7V9V18C22 19.1046 21.1046 20 20 20H18"></path><path d="M17.2362 9H2.30925C1.64988 9 1.17099 9.62698 1.34449 10.2631L3.59806 18.5262C3.83537 19.3964 4.62569 20 5.52759 20H19.6908C20.3501 20 20.829 19.373 20.6555 18.7369L18.201 9.73688C18.0823 9.30182 17.6872 9 17.2362 9Z"></path></svg>';
const HOME_CHATS_SVG = '<svg class="chats-home-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 14a2 2 0 0 1-2 2H8l-4 3.5V6a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"></path></svg>';
const GROUP_CHEVRON_SVG = (collapsed) => `<svg class="group-chevron${collapsed ? ' collapsed' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
}

function resolveContainer(convo) {
    const project = convo.projectId ? state.projects[convo.projectId] : null;
    const wsId = convo.workspaceId || project?.workspaceId || null;
    const workspace = wsId ? state.workspaces[wsId] : null;
    return { workspace, project };
}

function homeSpecToContainer(spec) {
    if (!spec || spec === '__unfiled__') return null;
    if (spec.startsWith('ws:')) {
        const id = spec.slice(3);
        return state.workspaces[id] ? { workspaceId: id } : null;
    }
    if (spec.startsWith('proj:')) {
        const id = spec.slice(5);
        return state.projects[id] ? { projectId: id } : null;
    }
    return null;
}

function resolveNextChatHome() {
    const cur = state.ui.nextChatHome;
    if (!cur) return null;
    if (cur.projectId && state.projects[cur.projectId]) {
        return { projectId: cur.projectId };
    }
    if (cur.workspaceId && state.workspaces[cur.workspaceId]) {
        return { workspaceId: cur.workspaceId };
    }
    state.ui.nextChatHome = null;
    return null;
}

function formatNextHomeLabel(home) {
    if (!home) return 'Unfiled';
    if (home.projectId) {
        const proj = state.projects[home.projectId];
        if (!proj) return 'Unfiled';
        const ws = proj.workspaceId ? state.workspaces[proj.workspaceId] : null;
        return ws ? `${ws.name || 'Untitled workspace'} › ${proj.name || 'Untitled project'}` : (proj.name || 'Untitled project');
    }
    if (home.workspaceId) {
        const ws = state.workspaces[home.workspaceId];
        return ws ? (ws.name || 'Untitled workspace') : 'Unfiled';
    }
    return 'Unfiled';
}

function compareByActivityDesc(a, b) {
    const diff = conversationActivityAt(b) - conversationActivityAt(a);
    if (diff !== 0) return diff;
    return (b.createdAt || 0) - (a.createdAt || 0);
}

/**
 * Markup for a single conversation row. `showPersonaAvatar` adds the owning
 * persona's avatar and name (used in the Chats page and workspace lists where
 * personas are mixed).
 * @param {Object} convo
 * @param {boolean} showPersonaAvatar
 * @param {Object} [opts]
 * @param {boolean} [opts.indented]
 * @returns {string}
 */
export function conversationRowHTML(convo, showPersonaAvatar, { indented = false } = {}) {
    const timeAgo = formatTimeAgo(conversationActivityAt(convo));
    const active = convo.id === state.activeConversationId ? ' active' : '';
    const indentCls = indented ? ' indented' : '';
    const persona = state.personas[convo.personaId];
    const personaName = persona ? (persona.name || 'Untitled') : 'No persona';
    const metaText = showPersonaAvatar ? `${personaName} · ${timeAgo}` : timeAgo;
    const avatar = showPersonaAvatar
        ? `<div class="conversation-persona-avatar" aria-hidden="true">${personaAvatarHTML(persona)}</div>`
        : '';
    return `
        <div class="conversation-item${active}${indentCls}" data-conversation-id="${escapeAttr(convo.id)}">
            ${avatar}
            <div class="conversation-info" data-conversation-id="${escapeAttr(convo.id)}" role="button" tabindex="0">
                <span class="conversation-title">${escapeHtml(convo.title || 'New Chat')}</span>
                <span class="conversation-time">${escapeHtml(metaText)}</span>
            </div>
            <button type="button" class="conversation-menu-btn" data-conversation-id="${escapeAttr(convo.id)}" title="Options" aria-label="Chat options">⋯</button>
        </div>
    `;
}

/**
 * Wire click + menu listeners for all conversation rows currently in `container`.
 * @param {HTMLElement} container
 */
export function wireConversationRows(container) {
    container.querySelectorAll('.conversation-info').forEach(info => {
        const open = () => switchConversation(info.dataset.conversationId);
        info.addEventListener('click', open);
        info.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                open();
            }
        });
    });
    container.querySelectorAll('.conversation-menu-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            showConversationMenu(btn, btn.dataset.conversationId);
        });
    });
}

/**
 * Refresh the chats list if it's the view currently showing in the main area.
 * Many callers poke this after a conversation mutation, so it updates only the
 * region showing (and keeps any active search input focused).
 */
export function renderConversationList() {
    if ((state.ui.mainView || {}).type === 'chats') {
        const listEl = document.getElementById('chatsListBody');
        if (listEl) renderGroupedChatList(listEl);
        else renderChatsListMain();
    } else {
        // A chat filed under a workspace or project is listed on that container's
        // page instead, and since its rows carry the same ⋯ menu, the same
        // rename/clear/delete callers have to repaint it. No-ops elsewhere.
        refreshContainerChats();
    }
    renderRail();
}

function renderSteppedRowsHTML(convos, limitKey, { indented = false, isFiltering = false } = {}) {
    const sorted = convos.slice().sort(compareByActivityDesc);
    if (isFiltering) {
        return sorted.map(c => conversationRowHTML(c, true, { indented })).join('');
    }
    const limit = state.ui.expandedChatLimits.get(limitKey) || INITIAL_GROUP_LIMIT;
    const shown = sorted.slice(0, limit);
    const remaining = sorted.length - shown.length;
    let html = shown.map(c => conversationRowHTML(c, true, { indented })).join('');

    if (remaining > 0 || (limit > INITIAL_GROUP_LIMIT && sorted.length > INITIAL_GROUP_LIMIT)) {
        const nextStep = Math.min(EXPAND_STEP, remaining);
        const moreLabel = remaining > EXPAND_STEP
            ? `Show ${nextStep} more (${remaining} left)…`
            : `Show ${nextStep} more…`;
        const indentCls = indented ? ' indented' : '';
        html += `<div class="chats-step-actions${indentCls}">`;
        if (remaining > 0) {
            html += `<button type="button" class="chats-step-btn" data-expand-more="${escapeAttr(limitKey)}">${moreLabel}</button>`;
        }
        if (limit > INITIAL_GROUP_LIMIT && sorted.length > INITIAL_GROUP_LIMIT) {
            html += `<button type="button" class="chats-step-btn quiet" data-expand-less="${escapeAttr(limitKey)}">Show less</button>`;
        }
        html += `</div>`;
    }
    return html;
}

/**
 * Chats view list (UIP-08): shows every conversation from every home
 * (Workspaces, Projects, and Unfiled), organised by home and ordered by latest
 * activity, with inline persona identity, search/persona filtering, and
 * stepped top-4 / +10 expansion.
 * @param {HTMLElement} container
 */
export function renderGroupedChatList(container) {
    const all = Object.values(state.conversations);
    const toolbarEl = document.getElementById('chatsToolbar');
    if (toolbarEl) toolbarEl.hidden = all.length === 0;
    if (all.length === 0) {
        container.innerHTML = `<p class="empty-state small">No chats yet. Start a new one above.</p>`;
        return;
    }

    const rawSearch = (state.ui.chatsSearch || '').trim().toLowerCase();
    const personaFilter = (state.ui.chatsPersonaFilter && state.ui.chatsPersonaFilter !== 'all' && state.personas[state.ui.chatsPersonaFilter])
        ? state.ui.chatsPersonaFilter
        : 'all';
    if (state.ui.chatsPersonaFilter !== personaFilter) {
        state.ui.chatsPersonaFilter = 'all';
    }
    const isFiltering = rawSearch.length > 0 || personaFilter !== 'all';

    const filtered = all.filter(c => {
        if (personaFilter !== 'all' && c.personaId !== personaFilter) return false;
        if (!rawSearch) return true;
        const title = (c.title || 'New Chat').toLowerCase();
        const { workspace, project } = resolveContainer(c);
        const wsName = (workspace?.name || '').toLowerCase();
        const projName = (project?.name || '').toLowerCase();
        const homeFallback = (!workspace && !project) ? 'unfiled' : '';
        const personaName = (state.personas[c.personaId]?.name || '').toLowerCase();
        return title.includes(rawSearch) || wsName.includes(rawSearch) || projName.includes(rawSearch) ||
            homeFallback.includes(rawSearch) || personaName.includes(rawSearch);
    });

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="chats-filter-empty">
                <p class="empty-state small">No chats match that filter.</p>
                <button type="button" class="chats-step-btn" id="chatsResetFilterBtn">Reset filters</button>
            </div>`;
        const rb = container.querySelector('#chatsResetFilterBtn');
        if (rb) {
            rb.addEventListener('click', () => {
                state.ui.chatsSearch = '';
                state.ui.chatsPersonaFilter = 'all';
                renderChatsListMain();
            });
        }
        return;
    }

    // Group conversations by top-level home (Workspace, orphaned Project, or Unfiled).
    const groups = new Map();
    for (const c of filtered) {
        const { workspace, project } = resolveContainer(c);
        const key = workspace
            ? `ws:${workspace.id}`
            : (project ? `proj:${project.id}` : '__unfiled__');
        if (!groups.has(key)) {
            groups.set(key, {
                key,
                unfiled: !workspace && !project,
                name: workspace ? (workspace.name || 'Untitled workspace') : (project ? (project.name || 'Untitled project') : 'Unfiled'),
                newTarget: workspace ? `ws:${workspace.id}` : (project ? `proj:${project.id}` : '__unfiled__'),
                direct: [],
                projects: new Map(),
                total: 0,
                latest: 0,
            });
        }
        const g = groups.get(key);
        const ts = conversationActivityAt(c);
        g.total++;
        if (ts > g.latest) g.latest = ts;

        if (workspace && project) {
            if (!g.projects.has(project.id)) {
                g.projects.set(project.id, {
                    id: project.id,
                    name: project.name || 'Untitled project',
                    items: [],
                    latest: 0,
                });
            }
            const pg = g.projects.get(project.id);
            pg.items.push(c);
            if (ts > pg.latest) pg.latest = ts;
        } else {
            g.direct.push(c);
        }
    }

    const orderedGroups = [...groups.values()].sort((a, b) => b.latest - a.latest);
    let html = '';

    for (const g of orderedGroups) {
        const collapsed = !isFiltering && state.ui.collapsedChatGroups.has(g.key);
        const icon = g.unfiled ? HOME_CHATS_SVG : HOME_FOLDER_SVG;
        let bodyHTML = '';

        if (g.direct.length > 0) {
            bodyHTML += renderSteppedRowsHTML(g.direct, `${g.key}:direct`, { indented: false, isFiltering });
        }

        const orderedProjects = [...g.projects.values()].sort((a, b) => b.latest - a.latest);
        for (const p of orderedProjects) {
            const pKey = `proj:${p.id}`;
            const pCollapsed = !isFiltering && state.ui.collapsedChatGroups.has(pKey);
            const pRows = renderSteppedRowsHTML(p.items, pKey, { indented: true, isFiltering });
            bodyHTML += `
                <div class="chats-project-sub">
                    <div class="chats-project-head">
                        <button class="chats-project-toggle" type="button" data-toggle-group="${escapeAttr(pKey)}" aria-expanded="${pCollapsed ? 'false' : 'true'}">
                            ${GROUP_CHEVRON_SVG(pCollapsed)}
                            <span class="chats-project-name">› ${escapeHtml(p.name)}</span>
                            <span class="chats-group-count">${p.items.length}</span>
                        </button>
                        <button class="chats-sub-new-btn" type="button" data-new-home="proj:${escapeAttr(p.id)}" aria-label="New chat in ${escapeAttr(p.name)}">+ New</button>
                    </div>
                    <div class="chats-project-body"${pCollapsed ? ' hidden' : ''}>${pRows}</div>
                </div>
            `;
        }

        html += `
            <section class="chats-home-group" data-home-group="${escapeAttr(g.key)}">
                <div class="chats-home-head">
                    <button class="chats-home-toggle" type="button" data-toggle-group="${escapeAttr(g.key)}" aria-expanded="${collapsed ? 'false' : 'true'}">
                        ${GROUP_CHEVRON_SVG(collapsed)}
                        ${icon}
                        <span class="chats-home-name">${escapeHtml(g.name)}</span>
                        <span class="chats-group-count">${g.total}</span>
                    </button>
                    <button class="chats-group-new-btn" type="button" data-new-home="${escapeAttr(g.newTarget)}" aria-label="New chat in ${escapeAttr(g.name)}">+ New chat</button>
                </div>
                <div class="chats-home-body"${collapsed ? ' hidden' : ''}>${bodyHTML}</div>
            </section>
        `;
    }

    container.innerHTML = html;

    container.querySelectorAll('[data-toggle-group]').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.toggleGroup;
            if (state.ui.collapsedChatGroups.has(key)) state.ui.collapsedChatGroups.delete(key);
            else state.ui.collapsedChatGroups.add(key);
            renderGroupedChatList(container);
        });
    });

    container.querySelectorAll('[data-new-home]').forEach(btn => {
        btn.addEventListener('click', () => {
            startNewConversation(homeSpecToContainer(btn.dataset.newHome));
        });
    });

    container.querySelectorAll('[data-expand-more]').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.expandMore;
            const cur = state.ui.expandedChatLimits.get(key) || INITIAL_GROUP_LIMIT;
            state.ui.expandedChatLimits.set(key, cur + EXPAND_STEP);
            renderGroupedChatList(container);
        });
    });

    container.querySelectorAll('[data-expand-less]').forEach(btn => {
        btn.addEventListener('click', () => {
            state.ui.expandedChatLimits.delete(btn.dataset.expandLess);
            renderGroupedChatList(container);
        });
    });

    wireConversationRows(container);
}

/**
 * Switch to a different conversation. Lazy-loads its messages on first
 * access — without this, renderConversation crashes on `messages.length`
 * because hydrateConversations seeds messages=undefined as a "not loaded"
 * sentinel for non-active conversations.
 * @param {string} conversationId
 */
export async function switchConversation(conversationId) {
    if (!state.conversations[conversationId]) return;

    // The composer travels with the user (F-04). setActiveConversation handles the
    // same-chat case: switchConversation is also how you return to the chat you
    // were already on (from Workspaces, say), so it must not early-return — there
    // is simply no draft to move when the conversation has not changed.
    setActiveConversation(conversationId);

    // Real usage travels with the chat (U-04). setActiveConversation above has
    // already cleared the outgoing chat's figure, so this only fetches; the
    // staleness guard lives inside loadUsage.
    updateStatusBar();
    loadUsage(conversationId).then((current) => { if (current) updateStatusBar(); });

    // Track the chat's container so breadcrumb + restore have context.
    const convo = state.conversations[conversationId];
    state.activeProjectId = convo.projectId || null;
    state.activeWorkspaceId = convo.workspaceId || (convo.projectId && state.projects[convo.projectId] ? state.projects[convo.projectId].workspaceId : null) || null;

    // Also switch to the persona that owns this conversation. activePersonaId
    // is session state — not persisted server-side — so no savePersonas() call
    // is needed (and including one would also re-PUT every persona, wasting
    // bandwidth and risking cross-write clobbers).
    if (convo.personaId && convo.personaId !== state.activePersonaId) {
        state.activePersonaId = convo.personaId;
        // A fixed-mode persona brings its own model settings along (WR-12).
        applyPersonaModelSettings(getActivePersona());
    }

    // Lazy-load messages if this is the first time we're activating this
    // conversation in the session.
    await loadConversationMessages(conversationId);

    // The chat also remembers its engine: reactivate the model that wrote its
    // last reply (unless the persona above pinned one — fixed mode wins).
    restoreConversationModel(convo);

    navigate({ type: 'chat', id: conversationId });
    updateUI();
}

/**
 * Show context menu for a conversation
 * @param {HTMLElement} anchorEl - The button that was clicked
 * @param {string} conversationId
 */
export function showConversationMenu(anchorEl, conversationId) {
    // Remove any existing menu
    const existingMenu = document.querySelector('.context-menu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = `
        <button class="context-menu-item" data-action="rename">Rename</button>
        <button class="context-menu-item" data-action="clear">Clear messages</button>
        <button class="context-menu-item danger" data-action="delete">Delete</button>
    `;

    // Positioned through the shared helper rather than by hand. The hand-rolled
    // version pinned the menu below the anchor unconditionally, so a chat row
    // near the bottom of the viewport put "Delete" past the edge — and
    // `.context-menu` clips its overflow, so the item was invisible rather than
    // merely off-screen. The helper flips, clamps and (failing both) scrolls.
    positionPopover(menu, anchorEl, 'right');

    // Handle menu item clicks
    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', () => {
            const action = item.dataset.action;
            menu.remove();

            if (action === 'rename') {
                renameConversationPrompt(conversationId);
            } else if (action === 'clear') {
                clearConversationPrompt(conversationId);
            } else if (action === 'delete') {
                deleteConversationPrompt(conversationId);
            }
        });
    });

    // Excludes the anchor, so clicking ⋯ again closes the menu instead of
    // closing and immediately reopening it.
    attachPopoverOutsideClose(menu, anchorEl);
}

/**
 * Name a chat from its opening exchange (AX-02).
 *
 * Fire-and-forget by design: this runs after the reply is already on screen, so
 * nothing here may throw, block, or surface an error. A chat that keeps the
 * name "New Chat" is a small disappointment; a chat that breaks because naming
 * failed is not.
 *
 * The server decides whether to do anything at all — that rule lives in one
 * place so a repeated call cannot re-name (or re-charge for) a chat that
 * already has a title.
 *
 * The local title is only adopted if the user has not renamed it in the
 * meantime: they were here first, and their choice outranks the model's.
 *
 * @param {string} conversationId
 */
export async function maybeAutoTitle(conversationId) {
    try {
        const before = state.conversations[conversationId]?.title;
        const res = await API.conversations.title(conversationId);
        if (!res || res.source === 'skipped' || !res.title) return;

        const convo = state.conversations[conversationId];
        if (!convo) return;                       // deleted while the call was out
        if (convo.title !== before) return;       // renamed by hand meanwhile

        convo.title = res.title;
        renderConversationList();
        // The open chat shows its title in the top bar, so repaint that too.
        if (state.activeConversationId === conversationId) updateUI();
    } catch (err) {
        // Deliberately silent: the user did not ask for this, so a failure is
        // not something to interrupt them about.
        console.error('Auto-naming failed:', err);
    }
}

/**
 * Prompt to rename a conversation
 * @param {string} conversationId
 */
export async function renameConversationPrompt(conversationId) {
    const convo = state.conversations[conversationId];
    if (!convo) return;

    const newTitle = await promptName({
        title: 'Rename chat',
        label: 'Chat name',
        value: convo.title || 'New Chat',
        confirmLabel: 'Rename',
    });
    if (!newTitle) return;

    // Prompting is async now — the chat may have been deleted meanwhile.
    if (!state.conversations[conversationId]) return;

    convo.title = newTitle;
    // Not a bump of `updatedAt`: renaming is not activity, and the row's
    // timestamp and position now come from conversationActivityAt().
    //
    // Addressed directly rather than via saveConversations(), which only ever
    // flushes the ACTIVE conversation — renaming any OTHER chat from its row
    // menu wrote the active chat's title back instead, so the new name was
    // local-only and vanished on the next reload.
    API.conversations.update(conversationId, {
        title: newTitle,
        personaId: convo.personaId,
    }).catch(err => {
        console.error(`Failed to rename conversation ${conversationId}:`, err);
        displayError(err, { action: 'rename chat' });
    });
    renderConversationList();
    // The open chat shows its title in the top bar, so repaint that too.
    if (state.activeConversationId === conversationId) updateUI();
}

/**
 * Prompt to empty a conversation, keeping the chat itself.
 *
 * Re-homed from an orphaned `clearConversation()` in main.js that had lost its
 * entry point — and fixed on the way: that version only spliced the messages out
 * of local state and called saveConversations(), which persists title and
 * personaId only. The messages were never deleted server-side, so they came
 * straight back on the next reload. Each one is deleted explicitly here.
 *
 * @param {string} conversationId
 */
export async function clearConversationPrompt(conversationId) {
    const convo = state.conversations[conversationId];
    if (!convo) return;

    const ok = await confirmDialog({
        title: 'Clear this conversation?',
        body: `Every message in "${convo.title || 'New Chat'}" will be removed. The chat itself stays. This can't be undone.`,
        confirmLabel: 'Clear',
        danger: true,
    });
    if (!ok) return;

    // Confirming is async — the chat may have been deleted while the dialog was
    // open, so re-resolve rather than trusting the captured reference.
    const stillThere = state.conversations[conversationId];
    if (!stillThere) return;

    // Messages are only loaded lazily; a chat cleared without ever being opened
    // has `messages === undefined` and nothing to enumerate.
    await loadConversationMessages(conversationId);

    const persisted = (stillThere.messages || []).filter(m => m.id);
    if (persisted.length > 0) {
        const results = await Promise.all(persisted.map(m =>
            API.messages.delete(conversationId, m.id)
                .then(() => true)
                .catch(err => {
                    console.error(`Failed to delete message ${m.id}:`, err);
                    return false;
                })
        ));
        // If the server kept any of them, stop rather than show an empty thread
        // that refills on reload.
        if (results.some(ok => !ok)) {
            displayError(new Error('Some messages could not be deleted.'), { action: 'clear conversation' });
            return;
        }
    }

    stillThere.messages = [];
    stillThere.title = 'New Chat';
    stillThere.updatedAt = Date.now();
    // Emptied: there is no last message any more, so the row falls back to when
    // the chat was created (which is what the server will report on reload too).
    stillThere.lastMessageAt = null;
    // Addressed directly rather than via saveConversations(), which only ever
    // flushes the ACTIVE conversation — clearing a chat from the list while a
    // different one is open would otherwise re-PUT the wrong chat's title.
    API.conversations.update(conversationId, {
        title: stillThere.title,
        personaId: stillThere.personaId,
    }).catch(err => {
        console.error(`Failed to persist cleared conversation ${conversationId}:`, err);
    });

    if (state.activeConversationId === conversationId) {
        state.estimatedTokens = 0;
        updateStatusBar();
        renderConversation();
    }
    renderConversationList();
}

/**
 * Prompt to delete a conversation. Server delete first (so the local state
 * never goes out of sync with the server on failure), then local cleanup.
 * @param {string} conversationId
 */
export async function deleteConversationPrompt(conversationId) {
    const convo = state.conversations[conversationId];
    if (!convo) return;

    const ok = await confirmDialog({
        title: 'Delete chat?',
        body: `"${convo.title || 'New Chat'}" and all of its messages will be deleted. This can't be undone.`,
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;

    try {
        await API.conversations.delete(conversationId);
    } catch (err) {
        console.error('Failed to delete conversation:', err);
        displayError(err, { action: 'delete conversation' });
        return;
    }

    const wasActive = state.activeConversationId === conversationId;
    delete state.conversations[conversationId];

    if (wasActive) {
        // 'discard': the chat is gone, so its draft must not be stashed for a
        // return that can never happen — and must not be left in the composer,
        // where it could be sent into whichever chat we land on instead.
        const remaining = Object.values(state.conversations);
        const next = remaining.length > 0
            ? remaining.reduce((a, b) => (conversationActivityAt(b) > conversationActivityAt(a) ? b : a)).id
            : null;
        setActiveConversation(next, { outgoing: 'discard' });
        // Lazy-load the newly-active conversation's messages.
        if (next) await loadConversationMessages(next);
    } else {
        // Deleted from the list while a different chat is open: the active
        // conversation does not move, but this one's draft still has to go.
        forgetConversationDraft(conversationId);
    }

    renderConversationList();
    renderConversation();
}

/**
 * Create a new conversation and switch to it.
 *
 * Accepts an optional container (`{ workspaceId }` or `{ projectId }`), or
 * `null` / a DOM `Event` (for `railNewChatBtn`) for an unfiled chat.
 * @param {Object|Event|null} [container]
 */
export async function startNewConversation(container = null) {
    const target = (container && typeof container === 'object' && !(container instanceof Event) &&
        (container.projectId || container.workspaceId))
        ? { projectId: container.projectId || null, workspaceId: container.workspaceId || null }
        : null;
    try {
        await createConversation('New Chat', target);
    } catch (err) {
        console.error('Failed to create conversation:', err);
        displayError(err, { action: 'create chat' });
        return;
    }
    const created = state.conversations[state.activeConversationId];
    const projId = created?.projectId || target?.projectId || null;
    const wsId = created?.workspaceId || target?.workspaceId ||
        (projId && state.projects[projId] ? state.projects[projId].workspaceId : null) || null;
    state.activeProjectId = projId;
    state.activeWorkspaceId = wsId;
    navigate({ type: 'chat', id: state.activeConversationId });
}

/**
 * Back-compat shim. Older call sites call renderConversation() to mean "repaint
 * the main area"; route them through the view dispatcher (+ shell) so the rail
 * and top bar stay in sync.
 */
export function renderConversation() {
    renderShell();
    renderMainView();
}

const NEW_CHAT_QUILL_SVG = '<svg class="section-new-quill-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.006,21.89c0.51,-4.56 1.691,-9.552 4.252,-13.349c2.568,-3.806 6.804,-6.556 12.924,-6.741l2.014,-0.061l-1.181,1.639c-1.632,2.264 -2.375,4.606 -4.107,7.427l1.549,1.327l-0.731,0.754c-1.848,1.908 -4.436,3.155 -7.577,3.602c-1.105,0.177 -1.996,0.51 -2.85,1.072c-0.426,0.28 -0.769,0.569 -1.12,0.951c-0.237,0.258 -0.627,0.832 -0.858,1.18c-0.131,0.804 -0.239,1.613 -0.328,2.419zM5.136,19.976c0,0 0,0.001 0,0.001c0,0 0,0 0,-0.001zM6.139,15.931c0.021,-0.014 0.041,-0.028 0.062,-0.041c1.047,-0.688 2.347,-1.153 3.635,-1.376c2.85,-0.355 4.244,-1.029 5.682,-2.267l-1.245,-1.067l0.495,-0.734c1.94,-2.876 2.408,-4.471 3.573,-6.545c-4.48,0.483 -7.067,2.265 -9.424,5.759c-1.255,1.861 -2.146,4.005 -2.778,6.271zM12.79 20.62L13.12 20.11L13.75 21.06L14 21.35L14.27 21.59L14.57 21.79L14.86 21.91L15.19 21.99L15.51 21.99L15.82 21.94L16.09 21.84L16.34 21.69L16.61 21.49L16.83 21.26L17.03 21.01L17.62 20.11L18.25 21.06L18.48 21.33L18.74 21.57L19.04 21.77L19.36 21.91L19.66 21.98L19.98 21.99L20.32 21.94L20.65 21.81L20.96 21.61L21.24 21.37L21.58 20.96L21.89 20.45L21.99 20.17L22 19.93L21.96 19.73L21.91 19.6L21.82 19.43L21.69 19.28L21.54 19.16L21.41 19.09L21.22 19.02L21.03 19L20.83 19.01L20.69 19.05L20.51 19.13L20.39 19.21L20.21 19.38L19.88 19.89L19.28 18.98L19.05 18.7L18.82 18.47L18.54 18.27L18.25 18.12L17.97 18.04L17.65 18L17.33 18.03L17.04 18.11L16.73 18.26L16.45 18.46L16.2 18.7L15.97 18.98L15.38 19.89L14.75 18.94L14.52 18.67L14.26 18.43L13.96 18.23L13.64 18.09L13.34 18.02L13.02 18.01L12.71 18.06L12.41 18.16L12.11 18.34L11.83 18.56L11.52 18.91L11.23 19.34L11.07 19.64L11 19.93L11 20.07L11.04 20.27L11.09 20.4L11.18 20.57L11.31 20.72L11.42 20.82L11.59 20.91L11.73 20.96L11.88 20.99L12.07 21L12.27 20.96L12.4 20.91L12.57 20.82L12.69 20.72Z"/></svg>';
const NEXT_CHEVRON_SVG = '<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>';
const SEARCH_ICON_SVG = '<svg class="chats-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>';

/**
 * Open the "Home for next chat" popover anchored to `#chatsHomeBtn`, listing
 * Unfiled and every Workspace + Project (including empty containers so first
 * chats can be started straight from Chats).
 * @param {HTMLElement} anchorEl
 */
function showNextHomeMenu(anchorEl) {
    const existing = document.querySelector('.context-menu');
    if (existing) existing.remove();

    const current = resolveNextChatHome();
    const isUnfiled = !current;
    const menu = document.createElement('div');
    menu.className = 'context-menu context-menu-wide';

    let html = `<div class="context-menu-label">Home for next chat</div>`;
    html += `<button class="context-menu-item context-menu-check-item${isUnfiled ? ' active' : ''}" data-home-spec="__unfiled__"><span class="context-menu-check-label">Unfiled</span></button>`;

    const workspaces = Object.values(state.workspaces)
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const allProjects = Object.values(state.projects);
    const seenProjects = new Set();

    if (workspaces.length > 0) {
        html += `<div class="context-menu-separator"></div>`;
        for (const ws of workspaces) {
            const wsActive = !!(current && current.workspaceId === ws.id && !current.projectId);
            const wsName = ws.name || 'Untitled workspace';
            html += `<button class="context-menu-item context-menu-check-item${wsActive ? ' active' : ''}" data-home-spec="ws:${escapeAttr(ws.id)}"><span class="context-menu-check-label">${escapeHtml(wsName)}</span></button>`;

            const wsProjects = allProjects
                .filter(p => p.workspaceId === ws.id)
                .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            for (const p of wsProjects) {
                seenProjects.add(p.id);
                const pActive = !!(current && current.projectId === p.id);
                html += `<button class="context-menu-item context-menu-check-item context-menu-indent${pActive ? ' active' : ''}" data-home-spec="proj:${escapeAttr(p.id)}"><span class="context-menu-check-label">› ${escapeHtml(p.name || 'Untitled project')}</span></button>`;
            }
        }
    }

    const orphanProjects = allProjects
        .filter(p => !seenProjects.has(p.id))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (orphanProjects.length > 0) {
        html += `<div class="context-menu-separator"></div>`;
        for (const p of orphanProjects) {
            const pActive = !!(current && current.projectId === p.id);
            html += `<button class="context-menu-item context-menu-check-item${pActive ? ' active' : ''}" data-home-spec="proj:${escapeAttr(p.id)}"><span class="context-menu-check-label">${escapeHtml(p.name || 'Untitled project')}</span></button>`;
        }
    }

    menu.innerHTML = html;
    positionPopover(menu, anchorEl, 'left');

    menu.querySelectorAll('[data-home-spec]').forEach(item => {
        item.addEventListener('click', () => {
            state.ui.nextChatHome = homeSpecToContainer(item.dataset.homeSpec);
            menu.remove();
            const label = formatNextHomeLabel(resolveNextChatHome());
            const homeNameEl = document.getElementById('chatsHomeName');
            if (homeNameEl) {
                homeNameEl.textContent = `In: ${label}`;
                anchorEl.title = `Home for next chat: ${label}`;
            } else {
                renderChatsListMain();
            }
        });
    });

    attachPopoverOutsideClose(menu, anchorEl);
}

/** Main-area "Chats" section: every chat organised by home + New-chat defaults & filter bar. */
export function renderChatsListMain() {
    const c = elements.messagesContainer;
    const prevSearch = document.activeElement?.id === 'chatsSearchInput' ? document.activeElement : null;
    const selStart = prevSearch ? prevSearch.selectionStart : null;
    const selEnd = prevSearch ? prevSearch.selectionEnd : null;

    const persona = getActivePersona();
    const personaName = persona ? (persona.name || CONFIG.defaults.assistantName) : CONFIG.defaults.assistantName;
    const modelName = getModelDisplayName(getActiveModelConfig().model);
    const nextHome = resolveNextChatHome();
    const homeLabel = formatNextHomeLabel(nextHome);

    const hasAnyChats = Object.keys(state.conversations).length > 0;
    const personasList = Object.values(state.personas)
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const activePersonaFilter = (state.ui.chatsPersonaFilter && state.ui.chatsPersonaFilter !== 'all' && state.personas[state.ui.chatsPersonaFilter])
        ? state.ui.chatsPersonaFilter
        : 'all';
    const showPersonaPills = personasList.length >= 2 || activePersonaFilter !== 'all';
    const rawSearch = state.ui.chatsSearch || '';

    const personaFilterHTML = showPersonaPills
        ? `<div class="chats-persona-filter" id="chatsPersonaFilter" role="group" aria-label="Filter by persona">
                <button class="chats-filter-pill${activePersonaFilter === 'all' ? ' active' : ''}" data-pf="all" type="button">All personas</button>
                ${personasList.map(p => `
                    <button class="chats-filter-pill${activePersonaFilter === p.id ? ' active' : ''}" data-pf="${escapeAttr(p.id)}" type="button">
                        <span class="chats-next-ava" aria-hidden="true">${personaAvatarHTML(p)}</span>
                        <span class="chats-filter-pill-name">${escapeHtml(p.name || 'Untitled')}</span>
                    </button>
                `).join('')}
           </div>`
        : '';

    c.innerHTML = `
        <div class="section-view">
            <div class="section-head">
                <div class="section-head-left">
                    ${mobileMenuButtonHTML()}
                    <h1 class="section-title">Chats</h1>
                </div>
                <button class="section-new-btn section-new-chat-btn" id="chatsNewBtn" type="button">
                    ${NEW_CHAT_QUILL_SVG}<span>New chat</span>
                </button>
            </div>
            <div class="chats-next-strip">
                <span class="chats-next-label">Next chat starts with</span>
                <div class="chats-next-controls">
                    <button class="chats-next-pill home" id="chatsHomeBtn" type="button" aria-haspopup="true" title="Home for next chat: ${escapeAttr(homeLabel)}" aria-label="Home for next chat">
                        <span class="chats-next-name" id="chatsHomeName">In: ${escapeHtml(homeLabel)}</span>
                        ${NEXT_CHEVRON_SVG}
                    </button>
                    <button class="chats-next-pill" id="chatsPersonaBtn" type="button" aria-haspopup="true" title="Persona options" aria-label="Persona for next chat">
                        <span class="chats-next-ava" aria-hidden="true">${personaAvatarHTML(persona)}</span>
                        <span class="chats-next-name">${escapeHtml(personaName)}</span>
                        ${NEXT_CHEVRON_SVG}
                    </button>
                    <button class="chats-next-pill model" id="chatsModelBtn" type="button" aria-haspopup="true" title="Switch model" aria-label="Model for next chat">
                        <span class="chats-next-name" id="chatsModelName">${escapeHtml(modelName)}</span>
                        ${NEXT_CHEVRON_SVG}
                    </button>
                </div>
            </div>
            <div class="chats-toolbar" id="chatsToolbar"${hasAnyChats ? '' : ' hidden'}>
                <div class="chats-search-wrap">
                    ${SEARCH_ICON_SVG}
                    <input class="chats-search" id="chatsSearchInput" type="text" placeholder="Filter chats by title or home…" aria-label="Filter chats by title or home" value="${escapeAttr(rawSearch)}">
                    <button class="chats-search-clear" id="chatsSearchClear" type="button" aria-label="Clear search"${rawSearch ? '' : ' hidden'}>×</button>
                </div>
                ${personaFilterHTML}
            </div>
            <div class="section-list" id="chatsListBody"></div>
        </div>`;

    const listEl = c.querySelector('#chatsListBody');
    renderGroupedChatList(listEl);

    if (prevSearch) {
        const inp = c.querySelector('#chatsSearchInput');
        if (inp) {
            inp.focus();
            if (typeof selStart === 'number' && typeof selEnd === 'number') {
                inp.setSelectionRange(selStart, selEnd);
            }
        }
    }

    const nb = c.querySelector('#chatsNewBtn');
    if (nb) nb.addEventListener('click', () => startNewConversation(resolveNextChatHome()));
    const hb = c.querySelector('#chatsHomeBtn');
    if (hb) hb.addEventListener('click', (e) => { e.stopPropagation(); showNextHomeMenu(hb); });
    const pb = c.querySelector('#chatsPersonaBtn');
    if (pb) pb.addEventListener('click', (e) => { e.stopPropagation(); showPersonaPopover(pb); });
    const mb = c.querySelector('#chatsModelBtn');
    if (mb) mb.addEventListener('click', (e) => { e.stopPropagation(); showModelMenu(mb); });

    const searchInput = c.querySelector('#chatsSearchInput');
    const clearBtn = c.querySelector('#chatsSearchClear');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            state.ui.chatsSearch = searchInput.value;
            if (clearBtn) clearBtn.hidden = !searchInput.value;
            renderGroupedChatList(listEl);
        });
    }
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            state.ui.chatsSearch = '';
            if (searchInput) {
                searchInput.value = '';
                searchInput.focus();
            }
            clearBtn.hidden = true;
            renderGroupedChatList(listEl);
        });
    }

    c.querySelectorAll('#chatsPersonaFilter [data-pf]').forEach(btn => {
        btn.addEventListener('click', () => {
            state.ui.chatsPersonaFilter = btn.dataset.pf;
            c.querySelectorAll('#chatsPersonaFilter [data-pf]').forEach(b => {
                b.classList.toggle('active', b === btn);
            });
            renderGroupedChatList(listEl);
        });
    });
}
