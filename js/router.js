/**
 * The main-area router (R-04b, moved verbatim from main.js).
 *
 * Owns the navigation shell: which view the main area shows, the rail
 * highlight, the contextual top bar, the breadcrumb, and the chrome that only
 * belongs in a chat (composer, floating avatar, file panel). `renderMainView`
 * is the one place that decides which view owns the main region — rule 2 of
 * docs/REFACTOR_PLAN.md, now enforced by the module graph rather than
 * convention.
 *
 * It imports every view, and NOTHING imports it except js/main.js, the entry
 * point, which imports everything by definition. Views reach navigation through
 * js/shell.js instead, which is what keeps that arrow pointing one way. The
 * shell implementations registered at the foot of this file used to live in
 * main.js.
 *
 * That rule used to hold only with an asterisk: js/chat/thread.js and
 * js/chat/send.js imported `getActiveConversation` from here, because it landed
 * in this file when R-04b moved the block of main.js it happened to sit in. It
 * is a pure state read with nothing to do with routing, and it now lives beside
 * its twin getActivePersona() in state.js — see the note there for why that edge
 * was the one thing standing between this codebase and a real import cycle.
 *
 * Passenger still to re-home: the file-tools toggle helpers
 * (`personaToolsBase` … `syncToolsToggle`) are composer concerns that arrived
 * here because `syncChatChrome` refreshes the toggle.
 */

import { state } from './state.js';
import { elements } from './dom.js';
import { getActivePersona, getActiveConversation } from './state.js';
import { currentSection, navigate, renderChatThread, registerShell } from './shell.js';
import { renderChatsListMain } from './views/chats.js';
import { renderWorkspacesListMain, renderBreadcrumb, renderContainerPage } from './views/workspaces.js';
import { renderPersonasListMain } from './views/personas.js';
import { renderModelsView } from './views/models.js';
import { FilePanel } from './file-panel/index.js';
// The composer is chrome this module shows and hides, so it also owns the
// resize that only becomes measurable at the moment it is shown.
import { autoResizeTextarea } from './chat/composer.js';

/**
 * The persona's base file-tools setting (its default for new chats). Stored in
 * the persona's model_config JSON; absent = off.
 * @param {Object} persona
 * @returns {boolean}
 */
export function personaToolsBase(persona) {
    return persona?.modelConfig?.toolsEnabled === true;
}

/**
 * The active chat's per-conversation file-tools override: the saved
 * conversation value, or the pending choice for a fresh unsaved chat.
 * true/false = forced, null/undefined = inherit the persona base.
 */
export function getToolsOverride() {
    const convo = getActiveConversation();
    return convo ? convo.toolsEnabled : state.pendingToolsOverride;
}

/**
 * The EFFECTIVE file-tools state for the active chat: the per-conversation
 * override wins, else the active persona's base. Mirrors the server's
 * resolveToolsEnabled precedence so the UI matches what a send will do.
 * @returns {boolean}
 */
export function effectiveToolsEnabled() {
    const override = getToolsOverride();
    if (override === true) return true;
    if (override === false) return false;
    return personaToolsBase(getActivePersona());
}

/** Whether the effective state comes from a per-chat override vs the persona base. */
export function toolsOverrideActive() {
    const override = getToolsOverride();
    return override === true || override === false;
}

/**
 * Reflect the effective file-tools state on the composer toggle: filled when
 * on, muted when off, with a tooltip naming the source (persona default vs
 * this-chat override).
 */
export function syncToolsToggle() {
    const btn = elements.toolsToggleBtn;
    if (!btn) return;
    const on = effectiveToolsEnabled();
    const overridden = toolsOverrideActive();
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    const source = overridden ? 'this chat' : 'persona default';
    btn.title = `File tools ${on ? 'on' : 'off'} (${source}) — click to turn ${on ? 'off' : 'on'}`;
}

/** Keep the persona editor's page title in sync with the active persona's name. */
export function syncPersonaEditTitle() {
    const title = document.getElementById('personaEditTitle');
    if (!title) return;
    const persona = getActivePersona();
    title.textContent = persona ? (persona.name || 'Untitled') : 'Persona';
}

/** Repaint the navigation shell: rail highlight + contextual top bar + chrome. */
export function renderShell() {
    renderRail();
    renderTopBar();
    renderBreadcrumb();
    syncChatChrome();
}

/**
 * Show the message composer + floating avatar only in a chat view — they're
 * irrelevant (and visually noisy) on the lists / settings / container pages.
 */
export function syncChatChrome() {
    const inChat = (state.ui.mainView || {}).type === 'chat';
    if (elements.inputContainer) {
        const wasHidden = elements.inputContainer.hidden;
        elements.inputContainer.hidden = !inChat;
        // Showing the composer is the first moment its height can actually be
        // measured: the draft restored on the way in (setActiveConversation)
        // ran while it was still display:none, where every measurement is 0.
        if (wasHidden && inChat && elements.messageInput) {
            autoResizeTextarea(elements.messageInput);
        }
    }
    if (elements.floatingAvatar) {
        elements.floatingAvatar.classList.toggle('hidden', !inChat || !state.settings.showAvatar);
    }
    // Reflect this chat's effective file-tools state on the composer toggle.
    if (inChat) syncToolsToggle();
    // The files explorer needs a saved conversation to list files for; a fresh
    // unsaved chat has no id yet (CF-01b).
    if (elements.filesExplorerBtn) {
        elements.filesExplorerBtn.disabled = !state.activeConversationId;
    }
    // File panel + explorer button follow the active chat (hidden while browsing).
    FilePanel.syncUi();
    // The not-loaded count badge tracks the active chat even with the panel
    // closed (CT-06). Fire-and-forget: it self-guards staleness.
    FilePanel.syncContextBadge();
}

/**
 * Render the active main-area view. Guards against views whose entity was
 * deleted by falling back to the owning list.
 */
export function renderMainView() {
    const v = state.ui.mainView || { type: 'chats' };

    // Toggle the two persistent main-area panels: the messages/lists surface vs
    // the settings form (which lives in #settingsView so its inputs + listeners
    // survive — it is shown, not re-rendered).
    const isSettings = v.type === 'settings';
    const isPersonaEdit = v.type === 'persona-edit';
    const isModels = v.type === 'models';
    if (elements.settingsView) elements.settingsView.hidden = !isSettings;
    if (elements.personaEditView) elements.personaEditView.hidden = !isPersonaEdit;
    if (elements.modelsView) elements.modelsView.hidden = !isModels;
    if (elements.messagesContainer) elements.messagesContainer.hidden = isSettings || isPersonaEdit || isModels;
    if (isModels) {
        renderModelsView();
        return;
    }
    if (isPersonaEdit) {
        // The editor's inputs always edit the *active* persona (editPersona
        // activates before navigating); the title just needs to match it.
        if (!getActivePersona()) return navigate({ type: 'personas' });
        syncPersonaEditTitle();
        return;
    }
    if (isSettings) return;

    if (v.type === 'workspace') {
        if (!state.workspaces[v.id]) return navigate({ type: 'workspaces' });
        elements.messagesContainer.innerHTML = '';
        renderContainerPage('workspace', v.id);
        return;
    }
    if (v.type === 'project') {
        if (!state.projects[v.id]) return navigate({ type: 'workspaces' });
        elements.messagesContainer.innerHTML = '';
        renderContainerPage('project', v.id);
        return;
    }
    if (v.type === 'workspaces') {
        renderWorkspacesListMain();
        return;
    }
    if (v.type === 'personas') {
        renderPersonasListMain();
        return;
    }
    if (v.type === 'chat') {
        if (!state.conversations[v.id]) return navigate({ type: 'chats' });
        renderChatThread();
        return;
    }
    // 'chats' (default)
    renderChatsListMain();
}

/** Highlight the rail item for the section the current view belongs to. */
export function renderRail() {
    const section = currentSection();
    document.querySelectorAll('.rail-item[data-section]').forEach(b =>
        b.classList.toggle('active', b.dataset.section === section));
}

/**
 * Contextual top bar (WR-07, amended by P2-05a): in a chat show only the
 * workspace breadcrumb — the model chip lives in the composer's control row.
 * While browsing (composer hidden) show the persona selector (who the next
 * chat will be) plus the model button, since there's no composer to host it.
 */
export function renderTopBar() {
    const inChat = (state.ui.mainView || {}).type === 'chat';
    if (elements.personaButton) elements.personaButton.hidden = inChat;
    if (elements.workspaceBreadcrumb) elements.workspaceBreadcrumb.hidden = !inChat;
    if (elements.modelButton) elements.modelButton.hidden = inChat;
    // Files explorer (CF-01b): per-conversation, so only in a chat.
    if (elements.filesExplorerBtn) elements.filesExplorerBtn.hidden = !inChat;
}

// `setModelIndicator` used to live here — another passenger like
// getActiveConversation was, and moved for the same reason: js/views/models.js
// needs it, and the router must not be imported by a view. It writes the model
// name into two chips and is now in js/model-layer.js, which already holds
// `elements` and everything else about the active model.

// The shell implementations this module owns. main.js registered these while
// they lived there; they belong with the router now.
registerShell({ renderShell, renderMainView });
