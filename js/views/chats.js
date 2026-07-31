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

import { state } from '../state.js';
import { elements } from '../dom.js';
import { API } from '../api-client.js';
import { navigate, updateUI, renderMainView, renderShell } from '../shell.js';
import { getActivePersona } from '../state.js';
import {
    personaModelMode, findModelProvider, applyModelToLayer,
    } from '../model-layer.js';
import { persistSettings } from '../settings-store.js';
import { setActiveConversation, forgetConversationDraft } from '../active-conversation.js';
import { personaAvatarHTML, applyPersonaModelSettings } from '../persona-helpers.js';
import { escapeHtml, formatTimeAgo } from '../util/format.js';
import { displayError } from '../components/errors.js';
import { confirmDialog, promptName } from '../components/dialogs.js';
import { updateStatusBar } from '../status-bar.js';

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
 * Markup for a single conversation row. `showPersonaAvatar` adds the owning
 * persona's avatar (used in the workspace list where personas are mixed; the
 * home list shows the avatar on the group header instead).
 * @param {Object} convo
 * @param {boolean} showPersonaAvatar
 * @returns {string}
 */
export function conversationRowHTML(convo, showPersonaAvatar) {
    const timeAgo = formatTimeAgo(convo.updatedAt || convo.createdAt);
    const active = convo.id === state.activeConversationId ? 'active' : '';
    const avatar = showPersonaAvatar
        ? `<div class="conversation-persona-avatar">${personaAvatarHTML(state.personas[convo.personaId])}</div>`
        : '';
    return `
        <div class="conversation-item ${active}" data-conversation-id="${convo.id}">
            ${avatar}
            <div class="conversation-info" data-conversation-id="${convo.id}">
                <span class="conversation-title">${escapeHtml(convo.title || 'New Chat')}</span>
                <span class="conversation-time">${timeAgo}</span>
            </div>
            <button class="conversation-menu-btn" data-conversation-id="${convo.id}" title="Options">⋯</button>
        </div>
    `;
}

/**
 * Wire click + menu listeners for all conversation rows currently in `container`.
 * @param {HTMLElement} container
 */
export function wireConversationRows(container) {
    container.querySelectorAll('.conversation-info').forEach(info => {
        info.addEventListener('click', () => switchConversation(info.dataset.conversationId));
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
 * (WR-07: the unfiled chat list lives in the main area, not the sidebar; many
 * callers poke this after a conversation mutation, so it no-ops when a different
 * view is open.)
 */
export function renderConversationList() {
    if ((state.ui.mainView || {}).type === 'chats') renderChatsListMain();
}

/**
 * Home ("Chats") view: only UNFILED chats — those not in any workspace or
 * project — grouped by persona under collapsible headers ("chats with X").
 * Workspace/project chats live in their own container, never here (Workspace
 * Restructure: a chat appears in exactly one home, no cross-container leakage).
 * The active persona's group sorts first, the rest by most-recent activity.
 * @param {HTMLElement} container
 */
export function renderGroupedChatList(container) {
    const all = Object.values(state.conversations)
        .filter(c => !c.projectId && !c.workspaceId);

    if (all.length === 0) {
        container.innerHTML = `<p class="empty-state small">No chats yet. Start a new one above.</p>`;
        return;
    }

    // Group conversations by persona, tracking each group's latest activity.
    const groups = new Map(); // personaId -> { convos: [], latest }
    for (const c of all) {
        const pid = c.personaId || '__none__';
        if (!groups.has(pid)) groups.set(pid, { convos: [], latest: 0 });
        const g = groups.get(pid);
        g.convos.push(c);
        g.latest = Math.max(g.latest, c.updatedAt || c.createdAt || 0);
    }

    // Order: active persona first, then by most-recent activity.
    const ordered = [...groups.entries()].sort((a, b) => {
        if (a[0] === state.activePersonaId) return -1;
        if (b[0] === state.activePersonaId) return 1;
        return b[1].latest - a[1].latest;
    });

    let html = '';
    for (const [pid, g] of ordered) {
        const persona = state.personas[pid];
        const name = persona ? (persona.name || 'Untitled') : 'No persona';
        const collapsed = state.ui.collapsedPersonaGroups.has(pid);
        const rows = g.convos
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            .map(c => conversationRowHTML(c, false))
            .join('');
        html += `
            <div class="persona-group" data-persona-id="${escapeHtml(pid)}">
                <button class="persona-group-header" data-persona-id="${escapeHtml(pid)}" type="button">
                    <svg class="group-chevron ${collapsed ? 'collapsed' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
                    <div class="conversation-persona-avatar">${personaAvatarHTML(persona)}</div>
                    <span class="persona-group-name">${escapeHtml(name)}</span>
                    <span class="persona-group-count">${g.convos.length}</span>
                </button>
                <div class="persona-group-body" ${collapsed ? 'hidden' : ''}>${rows}</div>
            </div>
        `;
    }
    container.innerHTML = html;

    // Collapse/expand on header click.
    container.querySelectorAll('.persona-group-header').forEach(header => {
        header.addEventListener('click', () => {
            const pid = header.dataset.personaId;
            if (state.ui.collapsedPersonaGroups.has(pid)) {
                state.ui.collapsedPersonaGroups.delete(pid);
            } else {
                state.ui.collapsedPersonaGroups.add(pid);
            }
            renderConversationList();
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
            } else if (action === 'clear') {
                clearConversationPrompt(conversationId);
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
    convo.updatedAt = Date.now();
    saveConversations();
    renderConversationList();
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
            ? remaining.reduce((a, b) => ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a)).id
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
 * Create a new conversation and switch to it
 */
export async function startNewConversation() {
    try {
        await createConversation('New Chat');
    } catch (err) {
        console.error('Failed to create conversation:', err);
        return;
    }
    state.activeProjectId = null;
    state.activeWorkspaceId = null;
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

/** Main-area "Chats" section: unfiled chats grouped by persona + a New-chat action. */
export function renderChatsListMain() {
    const c = elements.messagesContainer;
    c.innerHTML = `
        <div class="section-view">
            <div class="section-head">
                <h1 class="section-title">Chats</h1>
                <button class="section-new-btn" id="chatsNewBtn" type="button">+ New chat</button>
            </div>
            <div class="section-list" id="chatsListBody"></div>
        </div>`;
    renderGroupedChatList(c.querySelector('#chatsListBody'));
    const nb = c.querySelector('#chatsNewBtn');
    if (nb) nb.addEventListener('click', startNewConversation);
}
