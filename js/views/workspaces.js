/**
 * The Workspaces view (R-04b, moved verbatim from main.js).
 *
 * The workspaces/projects lists, their row menus and create/edit/delete flows,
 * the breadcrumb, and the inline container pages — including each container's
 * file list with uploads, deletes and the per-file context toggle.
 */

import { state } from '../state.js';
import { elements } from '../dom.js';
import { API } from '../api-client.js';
import { navigate, renderMainView, renderShell } from '../shell.js';
import {
    escapeHtml, formatFileSize, formatTimeAgo, getFileTypeLabel,
} from '../util/format.js';
import { positionPopover, attachPopoverOutsideClose } from '../components/menus.js';
import { showToast } from '../components/toast.js';
import { displayError } from '../components/errors.js';
import { confirmDialog, promptName } from '../components/dialogs.js';
import { setupTextareaResizers } from '../components/textarea-resize.js';
import {
    switchConversation, createConversation,
} from './chats.js';
import { UiPrefs } from '../ui-prefs.js';
import { FilePanel } from '../file-panel/index.js';

const byUpdatedDesc = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);

function workspaceRowHTML(w) {
    const pc = w.projectCount || 0;
    const fc = w.fileCount || 0;
    const meta = `${pc} project${pc !== 1 ? 's' : ''} · ${fc} file${fc !== 1 ? 's' : ''}`;
    return `
        <div class="project-item" data-workspace-id="${w.id}">
            <div class="project-info ws-info" data-workspace-id="${w.id}">
                <span class="project-name">${escapeHtml(w.name || 'Untitled workspace')}</span>
                <span class="project-meta">${meta}</span>
            </div>
            <button class="project-menu-btn ws-menu-btn" data-workspace-id="${w.id}" title="Options">⋯</button>
        </div>
    `;
}

function projectRowHTML(p) {
    const count = p.fileCount || 0;
    const meta = `${count} file${count !== 1 ? 's' : ''}`;
    return `
        <div class="project-item" data-project-id="${p.id}">
            <div class="project-info" data-project-id="${p.id}">
                <span class="project-name">${escapeHtml(p.name || 'Untitled project')}</span>
                <span class="project-meta">${meta}</span>
            </div>
            <button class="project-menu-btn" data-project-id="${p.id}" title="Options">⋯</button>
        </div>
    `;
}

/**
 * Show the context menu for a project (Edit / Delete).
 * @param {HTMLElement} anchorEl
 * @param {string} projectId
 */
function showProjectMenu(anchorEl, projectId) {
    const existingMenu = document.querySelector('.context-menu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = `
        <button class="context-menu-item" data-action="edit">Edit</button>
        <button class="context-menu-item danger" data-action="delete">Delete</button>
    `;

    const rect = anchorEl.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${rect.left - 80}px`;

    document.body.appendChild(menu);

    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', () => {
            const action = item.dataset.action;
            menu.remove();
            if (action === 'edit') {
                editProject(projectId);
            } else if (action === 'delete') {
                deleteProjectPrompt(projectId);
            }
        });
    });

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
 * Create a new project (name-only step) nested under the given workspace, then
 * open its inline page so the user can fill in instructions/files.
 * @param {string} workspaceId - The owning workspace (defaults to the active one)
 */
async function startNewProjectIn(workspaceId) {
    const wsId = workspaceId || state.activeWorkspaceId || null;
    const name = await promptName({
        title: 'New project',
        label: 'Project name',
        placeholder: 'e.g., Q3 launch',
    });
    if (!name) return;

    let created;
    try {
        created = await API.projects.create({ name, workspaceId: wsId || undefined });
    } catch (err) {
        console.error('Failed to create project:', err);
        displayError(err, { action: 'create project' });
        return;
    }
    state.projects[created.id] = {
        id: created.id,
        workspaceId: created.workspaceId || null,
        name: created.name,
        instructions: created.instructions || '',
        fileCount: created.fileCount || 0,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
    };
    openContainerPage('project', created.id);
}

/**
 * Open a project's inline page to edit its name/instructions/files.
 * @param {string} projectId
 */
function editProject(projectId) {
    if (!state.projects[projectId]) return;
    openContainerPage('project', projectId);
}

/**
 * Confirm and delete a project. The backend moves its Drive folder to the trash
 * (recoverable) and removes the DB rows. Conversations that referenced the
 * project keep working — they just stop receiving its context.
 * @param {string} projectId
 */
async function deleteProjectPrompt(projectId) {
    const project = state.projects[projectId];
    if (!project) return;

    const count = project.fileCount || 0;
    let body = `"${project.name}" will be deleted.`;
    if (count > 0) {
        body += ` Its ${count} file${count !== 1 ? 's' : ''} will be moved to your Google Drive trash.`;
    }
    body += ' Chats in this project will keep working, but without its context.';

    const ok = await confirmDialog({
        title: 'Delete project?',
        body,
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;

    try {
        await API.projects.delete(projectId);
    } catch (err) {
        console.error('Failed to delete project:', err);
        displayError(err, { action: 'delete project' });
        return;
    }

    delete state.projects[projectId];

    // If we're viewing the deleted project's page, climb to its workspace.
    const v = state.ui.mainView || {};
    if (v.type === 'project' && v.id === projectId) {
        backToWorkspace();
    } else {
        renderMainView(); // refresh any list/page that showed it
        renderShell();
    }
}

/**
 * Create a new workspace (name-only step), then open its inline page so the user
 * can fill in shared instructions and add reference files.
 */
export async function startNewWorkspace() {
    const name = await promptName({
        title: 'New workspace',
        label: 'Workspace name',
        placeholder: 'e.g., Vibe Coding',
    });
    if (!name) return;

    let created;
    try {
        created = await API.workspaces.create({ name });
    } catch (err) {
        console.error('Failed to create workspace:', err);
        displayError(err, { action: 'create workspace' });
        return;
    }
    state.workspaces[created.id] = {
        id: created.id,
        name: created.name,
        instructions: created.instructions || '',
        projectCount: created.projectCount || 0,
        fileCount: created.fileCount || 0,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
    };
    openContainerPage('workspace', created.id);
}

/**
 * Open a workspace's inline page to edit its name/instructions/files.
 * @param {string} workspaceId
 */
function editWorkspace(workspaceId) {
    if (!state.workspaces[workspaceId]) return;
    openContainerPage('workspace', workspaceId);
}

/**
 * Confirm and delete a workspace. The backend trashes its Drive folder (and
 * nested projects/files) and reparents its chats to unfiled (kept).
 * @param {string} workspaceId
 */
async function deleteWorkspacePrompt(workspaceId) {
    const ws = state.workspaces[workspaceId];
    if (!ws) return;

    const pc = ws.projectCount || 0;
    const fc = ws.fileCount || 0;
    let body = `"${ws.name}" will be deleted.`;
    if (pc > 0 || fc > 0) {
        body += ` Its ${pc} project${pc !== 1 ? 's' : ''} and ${fc} file${fc !== 1 ? 's' : ''} will be moved to your Google Drive trash.`;
    }
    body += ' Chats in this workspace become unfiled — kept, but without its context.';

    const ok = await confirmDialog({
        title: 'Delete workspace?',
        body,
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;

    try {
        await API.workspaces.delete(workspaceId);
    } catch (err) {
        console.error('Failed to delete workspace:', err);
        displayError(err, { action: 'delete workspace' });
        return;
    }

    // Mirror the server-side cascade locally: projects gone, chats unfiled.
    delete state.workspaces[workspaceId];
    for (const pid of Object.keys(state.projects)) {
        if (state.projects[pid].workspaceId === workspaceId) delete state.projects[pid];
    }
    for (const c of Object.values(state.conversations)) {
        if (c.workspaceId === workspaceId) {
            c.workspaceId = null;
            c.projectId = null;
        }
    }

    // If we're viewing this workspace's page (or one of its now-deleted
    // projects' pages), drop back to the workspaces list.
    const v = state.ui.mainView || {};
    const viewingDeleted =
        (v.type === 'workspace' && v.id === workspaceId) ||
        (v.type === 'project' && !state.projects[v.id]);

    if (state.activeWorkspaceId === workspaceId) {
        state.activeWorkspaceId = null;
        state.activeProjectId = null;
        UiPrefs.set('activeWorkspace', null);
        UiPrefs.set('activeProject', null);
    }

    if (viewingDeleted) {
        navigate({ type: 'workspaces' });
    } else {
        renderMainView();
        renderShell();
    }
}

const BREADCRUMB_FOLDER_SVG = '<svg class="breadcrumb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>';

/** Shell-only refresh (rail highlight + contextual top bar + breadcrumb). */
export function updateWorkspaceUI() {
    renderShell();
}

/**
 * Render the top-bar breadcrumb for the OPEN CHAT's container: "Chats" (unfiled)
 * / "<Workspace>" / "<Workspace> › <Project>". Shown only while a chat is open
 * (renderTopBar toggles visibility); segments navigate the main-area router.
 */
export function renderBreadcrumb() {
    const el = elements.workspaceBreadcrumb;
    if (!el) return;

    const v = state.ui.mainView || {};
    const convo = v.type === 'chat' ? state.conversations[v.id] : null;
    if (!convo) { el.innerHTML = ''; el.classList.remove('active'); return; }

    const workspace = convo.workspaceId ? state.workspaces[convo.workspaceId] : null;
    const project = convo.projectId ? state.projects[convo.projectId] : null;

    let html = '';
    if (!workspace && !project) {
        html = `<span class="breadcrumb-seg" data-nav="chats">${BREADCRUMB_FOLDER_SVG}<span>Chats</span></span>`;
    } else {
        html = `<span class="breadcrumb-seg" data-nav="workspace">${BREADCRUMB_FOLDER_SVG}<span>${escapeHtml(workspace ? (workspace.name || 'Untitled workspace') : 'Workspace')}</span></span>`;
        if (project) {
            html += `<span class="breadcrumb-sep" aria-hidden="true">›</span>`;
            html += `<span class="breadcrumb-seg" data-nav="project"><span>${escapeHtml(project.name || 'Untitled project')}</span></span>`;
        }
    }
    el.innerHTML = html;
    el.classList.toggle('active', !!(workspace || project));

    el.querySelectorAll('[data-nav]').forEach(seg => {
        seg.addEventListener('click', () => {
            const nav = seg.dataset.nav;
            if (nav === 'project' && project) navigate({ type: 'project', id: project.id });
            else if (nav === 'workspace' && workspace) navigate({ type: 'workspace', id: workspace.id });
            else navigate({ type: 'chats' });
        });
    });
}

/** From a project, go up to its workspace page (or the workspaces list). */
export function backToWorkspace() {
    if (state.activeWorkspaceId && state.workspaces[state.activeWorkspaceId]) {
        openContainerPage('workspace', state.activeWorkspaceId);
    } else {
        navigate({ type: 'workspaces' });
    }
}

/**
 * Create a chat in the container of the current view (a workspace or project
 * page → workspace-/project-level; otherwise unfiled), then open it.
 */
async function startNewChatInContainer() {
    const v = state.ui.mainView || {};
    let container = null;
    if (v.type === 'project') container = { projectId: v.id };
    else if (v.type === 'workspace') container = { workspaceId: v.id };

    try {
        await createConversation('New Chat', container);
    } catch (err) {
        console.error('Failed to create conversation:', err);
        displayError(err, { action: 'create chat' });
        return;
    }
    navigate({ type: 'chat', id: state.activeConversationId });
}

/**
 * Context menu for a workspace row (Edit / Delete).
 * @param {HTMLElement} anchorEl
 * @param {string} workspaceId
 */
export function showWorkspaceContextMenu(anchorEl, workspaceId) {
    const existing = document.querySelector('.context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = `
        <button class="context-menu-item" data-action="edit">Edit</button>
        <button class="context-menu-item danger" data-action="delete">Delete</button>
    `;

    positionPopover(menu, anchorEl, 'left');

    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', () => {
            menu.remove();
            if (item.dataset.action === 'edit') {
                editWorkspace(workspaceId);
            } else if (item.dataset.action === 'delete') {
                deleteWorkspacePrompt(workspaceId);
            }
        });
    });

    attachPopoverOutsideClose(menu, anchorEl);
}

/** Main-area "Workspaces" section: the list of workspaces + a New-workspace action. */
export function renderWorkspacesListMain() {
    const c = elements.messagesContainer;
    const workspaces = Object.values(state.workspaces).sort(byUpdatedDesc);
    const list = workspaces.length
        ? `<div class="drill-list">${workspaces.map(workspaceRowHTML).join('')}</div>`
        : `<p class="empty-state small">No workspaces yet. Create one to group projects and share instructions + files.</p>`;
    c.innerHTML = `
        <div class="section-view">
            <div class="section-head">
                <h1 class="section-title">Workspaces</h1>
                <button class="section-new-btn" id="wsNewBtn" type="button">+ New workspace</button>
            </div>
            ${list}
        </div>`;
    const nb = c.querySelector('#wsNewBtn');
    if (nb) nb.addEventListener('click', startNewWorkspace);
    c.querySelectorAll('.ws-info[data-workspace-id]').forEach(el =>
        el.addEventListener('click', () => navigate({ type: 'workspace', id: el.dataset.workspaceId })));
    c.querySelectorAll('.ws-menu-btn[data-workspace-id]').forEach(btn =>
        btn.addEventListener('click', (e) => { e.stopPropagation(); showWorkspaceContextMenu(btn, btn.dataset.workspaceId); }));
}

const CONTAINER_FOLDER_SVG = '<svg class="cp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>';

const CONTAINER_UPLOAD_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';

export function openContainerPage(kind, id) {
    if (kind === 'workspace') {
        if (!state.workspaces[id]) return;
        state.activeWorkspaceId = id;
        state.activeProjectId = null;
        UiPrefs.set('activeWorkspace', id);
        UiPrefs.set('activeProject', null);
    } else {
        const project = state.projects[id];
        if (!project) return;
        state.activeProjectId = id;
        state.activeWorkspaceId = project.workspaceId || null;
        UiPrefs.set('activeProject', id);
        UiPrefs.set('activeWorkspace', state.activeWorkspaceId);
    }
    navigate({ type: kind, id });
}

/**
 * Render the inline container page (workspace or project) into the main area.
 * @param {'workspace'|'project'} kind
 * @param {string} id
 */
export function renderContainerPage(kind, id) {
    const isWs = kind === 'workspace';
    const entity = isWs ? state.workspaces[id] : state.projects[id];
    if (!entity) return;
    const workspace = isWs ? entity : state.workspaces[entity.workspaceId];

    // Breadcrumb row at the top of the page (climbs out of the page).
    const crumbs = isWs
        ? `<span class="cp-crumb" data-nav="workspaces">‹ Workspaces</span>`
        : `<span class="cp-crumb" data-nav="workspace">‹ ${escapeHtml(workspace ? (workspace.name || 'Workspace') : 'Workspace')}</span>`;

    const instrPlaceholder = isWs
        ? 'Shared context injected into every chat in this workspace and its projects (optional).'
        : 'Context injected into every chat in this project — on top of its workspace (optional).';

    const inheritNote = (!isWs && workspace)
        ? `<p class="cp-inherit-note">Inherits <strong>${escapeHtml(workspace.name || 'workspace')}</strong> context (its instructions + files apply here too).</p>`
        : '';

    const listsHTML = isWs
        ? containerProjectsListHTML(entity) + containerChatsListHTML(kind, entity)
        : containerChatsListHTML(kind, entity);

    elements.messagesContainer.innerHTML = `
        <div class="container-page" data-kind="${kind}" data-id="${escapeHtml(id)}">
            <div class="cp-breadcrumb">${crumbs}</div>

            <div class="cp-head">
                ${CONTAINER_FOLDER_SVG}
                <input class="cp-name" id="cpName" type="text" maxlength="100" placeholder="${isWs ? 'Workspace name' : 'Project name'}">
            </div>
            ${inheritNote}

            <label class="cp-label" for="cpInstructions">Instructions</label>
            <div class="textarea-resizable">
                <textarea class="cp-instructions" id="cpInstructions" rows="8" placeholder="${instrPlaceholder}"></textarea>
                <div class="textarea-resize-handle" aria-hidden="true" title="Drag to resize"></div>
            </div>
            <div class="cp-save-row">
                <button class="cp-save-btn" id="cpSave" type="button" disabled>Save</button>
                <span class="cp-save-hint" id="cpSaveHint" aria-live="polite"></span>
            </div>

            <div class="cp-section">
                <div class="cp-section-label">Files</div>
                <div class="project-file-list" id="cpFileList"></div>
                <p class="empty-state small" id="cpNoFiles" hidden>No files yet.</p>
                <div class="file-upload-wrapper">
                    <input type="file" id="cpFileInput" class="file-input-hidden" multiple>
                    <button type="button" class="file-upload-btn" id="cpUploadBtn">${CONTAINER_UPLOAD_SVG} Upload files</button>
                </div>
                <p class="help-text">Text, code, and PDF files up to 10MB each.</p>
                <p class="help-text" id="cpFilesToggleHint" hidden>Unchecked files stay here but aren't loaded into chats. The assistant can still open one on request when file tools are on.</p>
            </div>

            ${listsHTML}
        </div>
    `;

    wireContainerPage(kind, id);
    setupTextareaResizers(); // the page's Instructions handle is freshly rendered
    loadContainerFiles(kind, id);
}

/** Projects list for a workspace page (each row opens that project's page). */
function containerProjectsListHTML(workspace) {
    const projects = Object.values(state.projects)
        .filter(p => p.workspaceId === workspace.id)
        .sort(byUpdatedDesc);

    let h = `<div class="cp-section"><div class="cp-section-label">Projects</div>`;
    if (projects.length > 0) {
        h += `<div class="drill-list">${projects.map(projectRowHTML).join('')}</div>`;
    } else {
        h += `<p class="empty-state small">No projects yet.</p>`;
    }
    h += `<button class="cp-add-btn" data-action="new-project" type="button">+ New project</button></div>`;
    return h;
}

/** Chats list for a container page (workspace-level or project-level chats). */
function containerChatsListHTML(kind, entity) {
    const chats = (kind === 'workspace'
        ? Object.values(state.conversations).filter(c => c.workspaceId === entity.id && !c.projectId)
        : Object.values(state.conversations).filter(c => c.projectId === entity.id)
    ).sort(byUpdatedDesc);

    const sectionLabel = kind === 'workspace' ? 'Chats here' : 'Chats';
    const addLabel = kind === 'workspace' ? '+ New chat here' : '+ New chat';

    let h = `<div class="cp-section"><div class="cp-section-label">${sectionLabel}</div>`;
    if (chats.length > 0) {
        h += `<div class="cp-row-list">` + chats.map(ch =>
            `<button class="cp-row" data-open-chat="${escapeHtml(ch.id)}" type="button">
                <span class="cp-row-name">${escapeHtml(ch.title || 'New Chat')}</span>
                <span class="cp-row-meta">${formatTimeAgo(ch.updatedAt || ch.createdAt)}</span>
            </button>`).join('') + `</div>`;
    } else {
        h += `<p class="empty-state small">No chats yet.</p>`;
    }
    h += `<button class="cp-add-btn" data-action="new-chat" type="button">${addLabel}</button></div>`;
    return h;
}

/** Wire the interactive elements of the currently-rendered container page. */
export function wireContainerPage(kind, id) {
    const page = elements.messagesContainer.querySelector('.container-page');
    if (!page) return;
    const isWs = kind === 'workspace';
    const entity = isWs ? state.workspaces[id] : state.projects[id];
    if (!entity) return;

    const nameEl = page.querySelector('#cpName');
    const instrEl = page.querySelector('#cpInstructions');
    const saveBtn = page.querySelector('#cpSave');
    const hintEl = page.querySelector('#cpSaveHint');

    // Set values via property (avoids HTML-escaping pitfalls in attributes/body).
    if (nameEl) nameEl.value = entity.name || '';
    if (instrEl) instrEl.value = entity.instructions || '';

    const markDirty = () => { if (saveBtn) saveBtn.disabled = false; if (hintEl) hintEl.textContent = ''; };
    if (nameEl) {
        nameEl.addEventListener('input', markDirty);
        nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveBtn?.click(); } });
    }
    if (instrEl) instrEl.addEventListener('input', markDirty);
    if (saveBtn) saveBtn.addEventListener('click', () => saveContainerEdits(kind, id, { saveBtn, nameEl, instrEl, hintEl }));

    // Breadcrumb out of the page (into the main-area router).
    page.querySelectorAll('.cp-crumb[data-nav]').forEach(el => el.addEventListener('click', () => {
        const nav = el.dataset.nav;
        if (nav === 'workspace' && entity.workspaceId) {
            openContainerPage('workspace', entity.workspaceId);
        } else { // 'workspaces' — back to the workspaces list
            navigate({ type: 'workspaces' });
        }
    }));

    // Files.
    const uploadBtn = page.querySelector('#cpUploadBtn');
    const fileInput = page.querySelector('#cpFileInput');
    if (uploadBtn && fileInput) {
        uploadBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => uploadContainerFiles(kind, id, fileInput.files));
    }

    // Project rows (workspace page): open on the info area, ⋯ menu for edit/delete.
    page.querySelectorAll('.project-info[data-project-id]').forEach(el =>
        el.addEventListener('click', () => openContainerPage('project', el.dataset.projectId)));
    page.querySelectorAll('.project-menu-btn[data-project-id]').forEach(btn =>
        btn.addEventListener('click', (e) => { e.stopPropagation(); showProjectMenu(btn, btn.dataset.projectId); }));

    // Chat rows + add buttons.
    page.querySelectorAll('[data-open-chat]').forEach(b =>
        b.addEventListener('click', () => switchConversation(b.dataset.openChat)));
    page.querySelectorAll('[data-action="new-project"]').forEach(b =>
        b.addEventListener('click', () => startNewProjectIn(id)));
    page.querySelectorAll('[data-action="new-chat"]').forEach(b =>
        b.addEventListener('click', startNewChatInContainer));
}

/**
 * Persist the inline name + instructions edits for a container.
 * @param {'workspace'|'project'} kind
 * @param {string} id
 * @param {{saveBtn:HTMLElement, nameEl:HTMLInputElement, instrEl:HTMLTextAreaElement, hintEl:HTMLElement}} els
 */
async function saveContainerEdits(kind, id, els) {
    const { saveBtn, nameEl, instrEl, hintEl } = els;
    const name = (nameEl?.value || '').trim();
    const instructions = instrEl?.value || '';
    const label = kind === 'workspace' ? 'Workspace' : 'Project';

    if (!name) {
        showToast(`${label} name is required.`, { type: 'error' });
        nameEl?.focus();
        return;
    }

    if (saveBtn) saveBtn.disabled = true;
    try {
        if (kind === 'workspace') {
            const u = await API.workspaces.update(id, { name, instructions });
            state.workspaces[id] = { ...state.workspaces[id], name: u.name, instructions: u.instructions, updatedAt: u.updatedAt };
        } else {
            const u = await API.projects.update(id, { name, instructions });
            state.projects[id] = { ...state.projects[id], name: u.name, instructions: u.instructions, updatedAt: u.updatedAt };
        }
    } catch (err) {
        console.error('Failed to save container:', err);
        displayError(err, { action: 'save changes' });
        if (saveBtn) saveBtn.disabled = false;
        return;
    }

    if (hintEl) {
        hintEl.textContent = 'Saved';
        setTimeout(() => { if (hintEl.isConnected) hintEl.textContent = ''; }, 1500);
    }
    updateWorkspaceUI(); // refresh breadcrumb + sidebar names (leaves the page intact)
}

/** The files API namespace for a container kind. */
function containerFilesApi(kind) {
    return kind === 'workspace' ? API.workspaces.files : API.projects.files;
}

/**
 * Load and render the file list for the open container page, keeping the cached
 * file count (and the sidebar/breadcrumb meta) in sync.
 * @param {'workspace'|'project'} kind
 * @param {string} id
 */
async function loadContainerFiles(kind, id) {
    const listEl = document.getElementById('cpFileList');
    if (!listEl) return;

    let files;
    try {
        files = await containerFilesApi(kind).list(id);
    } catch (err) {
        console.error('Failed to load files:', err);
        displayError(err, { action: 'load files' });
        return;
    }

    // Keep the cached count current, then refresh the sidebar/breadcrumb meta.
    if (kind === 'workspace' && state.workspaces[id]) state.workspaces[id].fileCount = files.length;
    if (kind === 'project' && state.projects[id]) state.projects[id].fileCount = files.length;
    updateWorkspaceUI(); // sidebar/breadcrumb only — does not touch the main page

    if (!listEl.isConnected) return; // navigated away during the await
    listEl.innerHTML = '';
    const noEl = document.getElementById('cpNoFiles');
    // The toggle hint only makes sense once there are checkboxes to explain.
    const hintEl = document.getElementById('cpFilesToggleHint');
    if (hintEl) hintEl.hidden = files.length === 0;

    if (files.length === 0) {
        if (noEl) noEl.hidden = false;
        return;
    }
    if (noEl) noEl.hidden = true;

    files.forEach(f => {
        const row = document.createElement('div');
        // enabled is undefined on any response predating CT-03 — treat as on,
        // matching the server's "NULL means loaded" rule.
        const enabled = f.enabled !== false;
        row.className = `project-file-item${enabled ? '' : ' is-context-off'}`;
        const label = getFileTypeLabel(f.filename, f.mimeType);
        const href = containerFilesApi(kind).contentUrl(id, f.id);
        // Text files open in the file panel for view/edit/history (FC-04); PDFs
        // and other binaries are download-only.
        const viewable = !/\.pdf$/i.test(f.filename || '');
        row.innerHTML = `
            <input type="checkbox" class="project-file-toggle" ${enabled ? 'checked' : ''}
                   aria-label="Load ${escapeHtml(f.filename)} into chats" title="${CONTEXT_TOGGLE_TITLE}">
            <span class="project-file-badge">${escapeHtml(label)}</span>
            <span class="project-file-name${viewable ? ' clickable' : ''}" title="${escapeHtml(f.filename)}">${escapeHtml(f.filename)}</span>
            <span class="project-file-size">${escapeHtml(formatFileSize(f.sizeBytes))}</span>
            <a class="project-file-download" href="${href}" download title="Download">⤓</a>
            <button class="project-file-delete" type="button" title="Delete">✕</button>
        `;
        if (viewable) {
            row.querySelector('.project-file-name').addEventListener('click', () => {
                FilePanel.openStandalone({ fileName: f.filename, url: href, mimeType: f.mimeType, sizeBytes: f.sizeBytes });
            });
        }
        row.querySelector('.project-file-toggle')
            .addEventListener('change', (e) => toggleContainerFileContext(kind, id, f, e.target, row));
        row.querySelector('.project-file-delete')
            .addEventListener('click', () => deleteContainerFilePrompt(kind, id, f.id, f.filename));
        listEl.appendChild(row);
    });
}

/** Tooltip shared by every context-toggle checkbox. */
const CONTEXT_TOGGLE_TITLE =
    'Load this file into chats. Unchecking keeps the file but leaves its ' +
    'contents out of the conversation.';

/**
 * Flip a container file's context toggle (CT-03). Optimistic: the row updates
 * immediately and reverts if the server refuses, because the action is free to
 * undo and a round trip per click would feel broken.
 * @param {'workspace'|'project'} kind
 * @param {string} id - container id
 * @param {Object} file - the file row from the list
 * @param {HTMLInputElement} checkbox
 * @param {HTMLElement} row
 */
async function toggleContainerFileContext(kind, id, file, checkbox, row) {
    const enabled = checkbox.checked;
    row.classList.toggle('is-context-off', !enabled);
    checkbox.disabled = true;

    try {
        const updated = await containerFilesApi(kind).setEnabled(id, file.id, enabled);
        file.enabled = updated.enabled; // keep the cached row honest for re-renders
    } catch (err) {
        console.error('Failed to set file context toggle:', err);
        checkbox.checked = !enabled;
        row.classList.toggle('is-context-off', enabled);
        displayError(err, { action: 'update the file' });
    } finally {
        checkbox.disabled = false;
    }
}

/**
 * Upload one or more files to the open container, then refresh the list.
 * @param {'workspace'|'project'} kind
 * @param {string} id
 * @param {FileList|File[]} fileList
 */
async function uploadContainerFiles(kind, id, fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    const btn = document.getElementById('cpUploadBtn');
    const originalHTML = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.classList.add('is-uploading');
        btn.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span> Uploading…`;
    }

    let failures = 0;
    for (const file of files) {
        try {
            await containerFilesApi(kind).upload(id, file);
        } catch (err) {
            failures++;
            console.error('Failed to upload file:', file.name, err);
            displayError(err, { action: 'upload file' });
        }
    }

    if (btn && btn.isConnected) {
        btn.classList.remove('is-uploading');
        btn.innerHTML = originalHTML;
        btn.disabled = false;
    }
    const input = document.getElementById('cpFileInput');
    if (input) input.value = ''; // allow re-selecting the same file
    await loadContainerFiles(kind, id);

    const ok = files.length - failures;
    if (ok > 0) showToast(`Uploaded ${ok} file${ok !== 1 ? 's' : ''}.`, { type: 'success' });
}

/**
 * Confirm and delete a single container file (from Drive + DB), then refresh.
 * @param {'workspace'|'project'} kind
 * @param {string} id
 * @param {string} fileId
 * @param {string} filename
 */
async function deleteContainerFilePrompt(kind, id, fileId, filename) {
    const where = kind === 'workspace' ? 'workspace' : 'project';
    const ok = await confirmDialog({
        title: 'Delete file?',
        body: `"${filename}" will be removed from this ${where} and from your Google Drive.`,
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;
    try {
        await containerFilesApi(kind).delete(id, fileId);
    } catch (err) {
        console.error('Failed to delete file:', err);
        displayError(err, { action: 'delete file' });
        return;
    }
    await loadContainerFiles(kind, id);
}

