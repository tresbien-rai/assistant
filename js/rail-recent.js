/**
 * Recent chats list inside the section rail (UIP-03).
 *
 * Shows the 8 most recently active conversations from every home (Unfiled,
 * Workspaces, Projects) and always keeps the currently open conversation in
 * the list even if older than the top 8. Supports two layouts chosen via
 * Settings -> Appearance (`UiPrefs.recentStyle`):
 *   - 'grouped' (default): grouped under Workspace headers (with direct chats
 *     first, then `› Project name` subheaders) and an `Unfiled` header.
 *   - 'flat': strict chronological rows with a muted home sub-line.
 * Hidden altogether when zero conversations exist (D9).
 */

import { state } from './state.js';
import { elements } from './dom.js';
import { UiPrefs } from './ui-prefs.js';
import { closeSidebar } from './sidebar.js';
import { personaAvatarHTML } from './persona-helpers.js';
import { escapeHtml } from './util/format.js';
import { switchConversation, conversationActivityAt } from './views/chats.js';

const RECENT_LIMIT = 8;

const GROUP_FOLDER_SVG = '<svg class="rail-recent-group-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V6.15C4 5.84 4.07 5.53 4.21 5.25L5.05 3.6H11.2L12.4 6H21C21.5523 6 22 6.44772 22 7V9V18C22 19.1046 21.1046 20 20 20H18"></path><path d="M17.2362 9H2.30925C1.64988 9 1.17099 9.62698 1.34449 10.2631L3.59806 18.5262C3.83537 19.3964 4.62569 20 5.52759 20H19.6908C20.3501 20 20.829 19.373 20.6555 18.7369L18.201 9.73688C18.0823 9.30182 17.6872 9 17.2362 9Z"></path></svg>';
const GROUP_CHATS_SVG = '<svg class="rail-recent-group-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 14a2 2 0 0 1-2 2H8l-4 3.5V6a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"></path></svg>';

function resolveContainer(convo) {
    const project = convo.projectId ? state.projects[convo.projectId] : null;
    const wsId = convo.workspaceId || project?.workspaceId || null;
    const workspace = wsId ? state.workspaces[wsId] : null;
    return { workspace, project };
}

function conversationHomeLabel(convo) {
    const { workspace, project } = resolveContainer(convo);
    if (workspace) {
        const wsName = workspace.name || 'Untitled workspace';
        return project ? `${wsName} › ${project.name || 'Untitled project'}` : wsName;
    }
    return project ? (project.name || 'Untitled project') : 'Unfiled';
}

function compareByActivityDesc(a, b) {
    const diff = conversationActivityAt(b) - conversationActivityAt(a);
    if (diff !== 0) return diff;
    return (b.createdAt || 0) - (a.createdAt || 0);
}

function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
}

function recentRowHTML(convo) {
    const title = convo.title || 'New Chat';
    const home = conversationHomeLabel(convo);
    const open = convo.id === state.activeConversationId;
    const v = state.ui.mainView || {};
    const viewingThis = open && v.type === 'chat' && v.id === convo.id;
    const ariaCurrent = open ? ` aria-current="${viewingThis ? 'page' : 'true'}"` : '';
    const persona = state.personas[convo.personaId];
    return `
        <button
            class="rail-chat-row${open ? ' open' : ''}"
            type="button"
            data-conversation-id="${escapeAttr(convo.id)}"${ariaCurrent}
            title="${escapeAttr(`${title} · ${home}`)}">
            <span class="rail-chat-ava" aria-hidden="true">${personaAvatarHTML(persona)}</span>
            <span class="rail-chat-body">
                <span class="rail-chat-title">${escapeHtml(title)}</span>
                <span class="rail-chat-ctx">${escapeHtml(home)}</span>
            </span>
        </button>`;
}

function wireListClick(listEl) {
    if (listEl.dataset.railRecentWired) return;
    listEl.dataset.railRecentWired = '1';
    listEl.addEventListener('click', (e) => {
        const row = e.target.closest('.rail-chat-row[data-conversation-id]');
        if (!row) return;
        closeSidebar();
        switchConversation(row.dataset.conversationId);
    });
}

/**
 * Render the rail's Recent chats block from current state.
 */
export function renderRailRecent() {
    const wrap = elements.railRecent;
    const list = elements.railRecentList;
    if (!wrap || !list) return;

    wireListClick(list);

    const all = Object.values(state.conversations);
    if (all.length === 0) {
        wrap.hidden = true;
        list.innerHTML = '';
        return;
    }

    wrap.hidden = false;
    const sorted = all.slice().sort(compareByActivityDesc);
    let pool = sorted.slice(0, RECENT_LIMIT);

    // Always keep the currently open conversation visible in Recent, even when
    // it falls outside the 8 most recently active chats.
    const activeConvo = state.activeConversationId ? state.conversations[state.activeConversationId] : null;
    if (activeConvo && !pool.some(c => c.id === activeConvo.id)) {
        pool = [...sorted.slice(0, RECENT_LIMIT - 1), activeConvo];
    }

    const style = UiPrefs.get('recentStyle') === 'flat' ? 'flat' : 'grouped';
    if (style === 'flat') {
        list.innerHTML = pool.map(recentRowHTML).join('');
        return;
    }

    // Group by Workspace (direct chats first, then each Project as a subheader)
    // plus an Unfiled group for chats without a workspace.
    const groups = new Map();
    for (const convo of pool) {
        const { workspace, project } = resolveContainer(convo);
        const key = workspace ? `ws:${workspace.id}` : '__unfiled__';
        if (!groups.has(key)) {
            groups.set(key, {
                name: workspace ? (workspace.name || 'Untitled workspace') : 'Unfiled',
                unfiled: !workspace,
                direct: [],
                projects: new Map(),
                latest: 0,
            });
        }
        const g = groups.get(key);
        const ts = conversationActivityAt(convo);
        if (ts > g.latest) g.latest = ts;

        if (project) {
            const pKey = project.id;
            if (!g.projects.has(pKey)) {
                g.projects.set(pKey, {
                    name: project.name || 'Untitled project',
                    items: [],
                    latest: 0,
                });
            }
            const pg = g.projects.get(pKey);
            pg.items.push(convo);
            if (ts > pg.latest) pg.latest = ts;
        } else {
            g.direct.push(convo);
        }
    }

    const orderedGroups = [...groups.values()].sort((a, b) => b.latest - a.latest);
    let html = '';
    for (const g of orderedGroups) {
        const icon = g.unfiled ? GROUP_CHATS_SVG : GROUP_FOLDER_SVG;
        html += `<div class="rail-recent-group-head">${icon}<span>${escapeHtml(g.name)}</span></div>`;
        if (g.direct.length > 0) {
            html += g.direct.slice().sort(compareByActivityDesc).map(recentRowHTML).join('');
        }
        const orderedProjects = [...g.projects.values()].sort((a, b) => b.latest - a.latest);
        for (const p of orderedProjects) {
            html += `<div class="rail-recent-project-sub">› ${escapeHtml(p.name)}</div>`;
            html += p.items.slice().sort(compareByActivityDesc).map(recentRowHTML).join('');
        }
    }
    list.innerHTML = html;
}
