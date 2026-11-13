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

/**
 * Markup for a single conversation row. `showPersonaAvatar` adds the owning
 * persona's avatar (used in the workspace list where personas are mixed; the
 * home list shows the avatar on the group header instead).
 * @param {Object} convo
 * @param {boolean} showPersonaAvatar
 * @returns {string}
 */
export function conversationRowHTML(convo, showPersonaAvatar) {
    const timeAgo = formatTimeAgo(conversationActivityAt(convo));
    const active = convo.id === state.activeConversationId ? 'active' : '';
    const avatar = showPersonaAvatar
        ? `<div class="conversation-persona-avatar">${personaAvatarHTML(state.personas[convo.personaId])}</div>`
        : '';
    return `
        <div class="conversation-item ${active}" data-conversation-id="${convo.id}">
            ${avatar}
            <div class="conversation-info" data-conversation-id="${convo.id}" role="button" tabindex="0">
                <span class="conversation-title">${escapeHtml(convo.title || 'New Chat')}</span>
                <span class="conversation-time">${timeAgo}</span>
            </div>
            <button type="button" class="conversation-menu-btn" data-conversation-id="${convo.id}" title="Options" aria-label="Chat options">⋯</button>
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
 * (WR-07: the unfiled chat list lives in the main area, not the sidebar; many
 * callers poke this after a conversation mutation, so it no-ops when a different
 * view is open.)
 */
export function renderConversationList() {
    if ((state.ui.mainView || {}).type === 'chats') renderChatsListMain();
    // A chat filed under a workspace or project is listed on that container's
    // page instead, and since its rows carry the same ⋯ menu, the same
    // rename/clear/delete callers have to repaint it. No-ops elsewhere.
    else refreshContainerChats();
    renderRail();
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
        g.latest = Math.max(g.latest, conversationActivityAt(c));
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
            .sort((a, b) => conversationActivityAt(b) - conversationActivityAt(a))
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

const NEW_CHAT_QUILL_SVG = '<svg class="section-new-quill-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.006,21.89c0.51,-4.56 1.691,-9.552 4.252,-13.349c2.568,-3.806 6.804,-6.556 12.924,-6.741l2.014,-0.061l-1.181,1.639c-1.632,2.264 -2.375,4.606 -4.107,7.427l1.549,1.327l-0.731,0.754c-1.848,1.908 -4.436,3.155 -7.577,3.602c-1.105,0.177 -1.996,0.51 -2.85,1.072c-0.426,0.28 -0.769,0.569 -1.12,0.951c-0.237,0.258 -0.627,0.832 -0.858,1.18c-0.131,0.804 -0.239,1.613 -0.328,2.419zM5.136,19.976c0,0 0,0.001 0,0.001c0,0 0,0 0,-0.001zM6.139,15.931c0.021,-0.014 0.041,-0.028 0.062,-0.041c1.047,-0.688 2.347,-1.153 3.635,-1.376c2.85,-0.355 4.244,-1.029 5.682,-2.267l-1.245,-1.067l0.495,-0.734c1.94,-2.876 2.408,-4.471 3.573,-6.545c-4.48,0.483 -7.067,2.265 -9.424,5.759c-1.255,1.861 -2.146,4.005 -2.778,6.271zM12.79 20.62L13.12 20.11L13.75 21.06L14 21.35L14.27 21.59L14.57 21.79L14.86 21.91L15.19 21.99L15.51 21.99L15.82 21.94L16.09 21.84L16.34 21.69L16.61 21.49L16.83 21.26L17.03 21.01L17.62 20.11L18.25 21.06L18.48 21.33L18.74 21.57L19.04 21.77L19.36 21.91L19.66 21.98L19.98 21.99L20.32 21.94L20.65 21.81L20.96 21.61L21.24 21.37L21.58 20.96L21.89 20.45L21.99 20.17L22 19.93L21.96 19.73L21.91 19.6L21.82 19.43L21.69 19.28L21.54 19.16L21.41 19.09L21.22 19.02L21.03 19L20.83 19.01L20.69 19.05L20.51 19.13L20.39 19.21L20.21 19.38L19.88 19.89L19.28 18.98L19.05 18.7L18.82 18.47L18.54 18.27L18.25 18.12L17.97 18.04L17.65 18L17.33 18.03L17.04 18.11L16.73 18.26L16.45 18.46L16.2 18.7L15.97 18.98L15.38 19.89L14.75 18.94L14.52 18.67L14.26 18.43L13.96 18.23L13.64 18.09L13.34 18.02L13.02 18.01L12.71 18.06L12.41 18.16L12.11 18.34L11.83 18.56L11.52 18.91L11.23 19.34L11.07 19.64L11 19.93L11 20.07L11.04 20.27L11.09 20.4L11.18 20.57L11.31 20.72L11.42 20.82L11.59 20.91L11.73 20.96L11.88 20.99L12.07 21L12.27 20.96L12.4 20.91L12.57 20.82L12.69 20.72Z"/></svg>';
const NEXT_CHEVRON_SVG = '<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>';

/** Main-area "Chats" section: unfiled chats grouped by persona + a New-chat action. */
export function renderChatsListMain() {
    const c = elements.messagesContainer;
    const persona = getActivePersona();
    const personaName = persona ? (persona.name || CONFIG.defaults.assistantName) : CONFIG.defaults.assistantName;
    const modelName = getModelDisplayName(getActiveModelConfig().model);

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
            <div class="section-list" id="chatsListBody"></div>
        </div>`;
    renderGroupedChatList(c.querySelector('#chatsListBody'));
    const nb = c.querySelector('#chatsNewBtn');
    if (nb) nb.addEventListener('click', startNewConversation);
    const pb = c.querySelector('#chatsPersonaBtn');
    if (pb) pb.addEventListener('click', (e) => { e.stopPropagation(); showPersonaPopover(pb); });
    const mb = c.querySelector('#chatsModelBtn');
    if (mb) mb.addEventListener('click', (e) => { e.stopPropagation(); showModelMenu(mb); });
}
