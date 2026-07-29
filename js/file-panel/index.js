/**
 * The file panel (R-03, moved verbatim from main.js).
 *
 * Shows a model-created or user-uploaded working file beside the chat: viewer,
 * editor, revision history, version restore, and the per-file context toggle.
 * At ~1,300 lines it was already the most self-contained region of the old
 * file, which is why it moves as one piece rather than being split further —
 * see docs/REFACTOR_PLAN.md.
 *
 * The INJECT_MODE_* constants travel with it because nothing else uses them.
 */

import { state, getActivePersona } from '../state.js';
import { elements } from '../dom.js';
import { API } from '../api-client.js';
import { UiPrefs } from '../ui-prefs.js';
import { renderMarkdown } from '../util/markdown.js';
import { escapeHtml, formatFileSize, formatTimeAgo, getFileTypeLabel } from '../util/format.js';
import { diffStats, buildRichDiff } from '../util/diff.js';
import { positionPopover } from '../components/menus.js';
import { showToast } from '../components/toast.js';
import { displayError } from '../components/errors.js';
import { confirmDialog } from '../components/dialogs.js';

// Chat working-file inject modes (CT-04). Order IS the cycle order, and matches
// the server's INJECT_MODES so a round trip can't disagree with the UI.
const INJECT_MODES = ['auto', 'pin', 'mute'];

const INJECT_MODE_ICONS = {
    auto: '◐',
    pin: '📌',
    mute: '🚫',
};

const INJECT_MODE_TITLES = {
    auto: 'Auto — loaded for a turn after each change, then read on demand. Click to pin.',
    pin: 'Pinned — kept in context every turn. Click to mute.',
    mute: 'Muted — never loaded automatically. Click for auto.',
};

// ===== File Panel (edit-in-context slice 1: viewer) =====
// Shows a model-created file beside the chat instead of only as a download
// card. Device-local filePanelMode picks between auto-opening on create_file
// activity and a quiet edge-tab alert; small screens never auto-open (the
// panel is a full-screen overlay there).
export const FilePanel = {
    // File currently associated with the panel: { fileName, url, mimeType,
    // sizeBytes } (the created_file attachment shape). Kept even while the
    // panel is closed so the edge tab can reopen it.
    file: null,
    // Which conversation `file` belongs to — syncUi re-derives on mismatch.
    conversationId: null,
    isOpen: false,
    unseen: false,   // live activity arrived while closed → tab dot pulses
    rawMode: false,  // markdown only: show source instead of rendered
    editMode: false, // user is editing in a textarea (slice 3)
    // FC-04: a container/Downloads file opened from a file LIST (not a chat).
    // `standalone` decouples the panel from conversation plumbing; historyMode
    // shows the revision log instead of the file's content.
    standalone: false,
    standaloneView: null, // the mainView key it was opened on (dismiss on nav away)
    historyMode: false,
    // CF-01b: the panel is showing the chat's file LIST (browser view) rather
    // than a single file. The top-bar files button opens here; picking a file
    // switches to the viewer.
    browseMode: false,
    historyRevisions: [],  // FC-06b: fetched revisions, NEWEST first
    selectedRevId: null,   // the version shown in the detail pane
    conflict: false, // the assistant rewrote the file mid-edit (Save confirms)
    locked: false,   // SP-03b: editor read-only while the model's turn is in flight
    _fetchSeq: 0,    // ignore stale fetch responses after rapid updates
    _cache: null,    // { url, text } — last fetched content, so raw/rendered
                     // toggles and card re-clicks don't re-download
    _draftBaseline: null,   // text the open draft started from (dirty check)
    _pendingActivity: null, // { att, convoId } that arrived mid-edit; re-
                            // dispatched when the draft closes

    MAX_RENDER_CHARS: 500000,
    // Above this size, skip markdown/highlight parsing and show plain text —
    // a synchronous parse of hundreds of KB visibly janks the main thread.
    MAX_RICH_RENDER_CHARS: 150000,

    isMobile() {
        return window.matchMedia('(max-width: 768px)').matches;
    },

    mode() {
        return UiPrefs.get('filePanelMode') === 'click' ? 'click' : 'auto';
    },

    /**
     * Live create_file activity. `convoId` is the conversation the turn was
     * sent in, pinned at request time — if the user switched chats while the
     * turn was in flight, the event is ignored here (the file still persists
     * in that chat's message attachments, so its edge tab reappears on
     * return via syncUi's re-derivation).
     */
    notifyActivity(att, convoId) {
        if (!att || att.type !== 'created_file' || !att.url) return;
        if (convoId && convoId !== state.activeConversationId) return;
        // The file's content just changed server-side — drop the stale cache.
        if (this._cache && this._cache.url === att.url) this._cache = null;
        // Never clobber an in-progress user edit: same file → flag the
        // conflict so Save asks before overwriting; a different file is
        // queued and re-dispatched when the edit ends, so its panel/edge-tab
        // signal isn't lost.
        if (this.editMode) {
            if (this.file && this.file.url === att.url) {
                this.conflict = true;
                // While locked (SP-03b) the lock note is shown instead; the
                // conflict note is revealed when the turn ends (syncTurnLock).
                if (elements.filePanelConflict && !this.locked) elements.filePanelConflict.hidden = false;
            } else {
                this._pendingActivity = { att, convoId };
            }
            return;
        }
        if (this.isOpen || (this.mode() === 'auto' && !this.isMobile())) {
            this.open(att);
        } else {
            this.file = att;
            this.conversationId = state.activeConversationId;
            this.unseen = true;
            this.syncUi();
        }
    },

    /** Open the panel on a file (from activity, a card click, or the tab). */
    open(att) {
        if (!att || !att.url) return;
        // A card click while editing another file must not discard the draft.
        if (this.editMode && this.file && this.file.url !== att.url) {
            showToast('Finish or cancel your edit first.', { type: 'warning' });
            return;
        }
        // Re-clicking the edited file's own card leaves edit mode — warn if
        // the draft had changes (same courtesy as close/switch).
        this.discardDraft();
        this.standalone = false;
        this.historyMode = false;
        this.browseMode = false;
        this.file = att;
        this.conversationId = state.activeConversationId;
        this.isOpen = true;
        this.unseen = false;
        this.rawMode = false;
        this.renderHeader();
        this.loadContent();
        this.syncUi();
    },

    /**
     * Open the panel to the BROWSER view: the chat's file list (CF-01b). This
     * is what the top-bar files button opens. The list is fetched per opening,
     * not cached — a tool can add a file on any turn, and a stale list is worse
     * than a brief "Loading…".
     */
    openBrowser() {
        if (!state.activeConversationId) return;
        this.discardDraft();
        this.standalone = false;
        this.historyMode = false;
        this.browseMode = true;
        this.conversationId = state.activeConversationId;
        this.isOpen = true;
        this.unseen = false;
        this.renderHeader();
        this.loadBrowser();
        this.syncUi();
    },

    /**
     * Top-bar files button. Adaptive so the button always "goes to the files":
     * closed → open the list; showing a single file → switch to the list;
     * already on the list → close.
     */
    toggleExplorer() {
        if (this.isOpen && this.browseMode && !this.standalone) {
            this.close();
        } else {
            this.openBrowser();
        }
    },

    // ---- Scratchpad (SP-03a) ----

    /** Whether the panel is currently showing the conversation's scratchpad. */
    isScratchpad() {
        return !!(this.file && this.file.scratchpad);
    },

    /**
     * Open the conversation's scratchpad in the panel. Modelled as a special
     * "file" whose url is the /scratchpad/content endpoint, so the panel's
     * load / edit / history / restore machinery (all url-convention-driven)
     * works on it unchanged.
     */
    openScratchpad() {
        if (!state.activeConversationId) return;
        this.open({
            fileName: 'Scratchpad',
            url: API.conversations.scratchpad.contentUrl(state.activeConversationId),
            mimeType: 'text/markdown',
            scratchpad: true,
        });
    },

    /**
     * Effective scratchpad-enabled state, mirroring the server's
     * resolveScratchpadEnabled: override ?? persona base ?? auto-arm on a
     * non-empty pad. The auto-arm leg uses the loaded content (available
     * whenever the toggle is shown, i.e. the pad is open), so a pad the model
     * filled reads as active even before the user touches the toggle.
     */
    scratchpadEffectiveEnabled() {
        const convo = state.conversations[state.activeConversationId];
        if (!convo) return false;
        if (convo.scratchpadEnabled === true) return true;
        if (convo.scratchpadEnabled === false) return false;
        const persona = getActivePersona();
        if (persona?.modelConfig?.scratchpadEnabled === true) return true;
        const cache = this._cache;
        return !!(cache && this.file && cache.url === this.file.url && cache.text.trim() !== '');
    },

    /** Reflect the effective enabled state on the header toggle. */
    syncScratchpadToggle() {
        const btn = elements.filePanelScratchpadToggle;
        if (!btn) return;
        const on = this.scratchpadEffectiveEnabled();
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-pressed', String(on));
        const label = btn.querySelector('.scratchpad-toggle-label');
        if (label) label.textContent = on ? 'Active' : 'Off';
        btn.title = on
            ? 'The assistant can see and edit this scratchpad — click to turn off'
            : 'The assistant can’t see this scratchpad yet — click to turn on';
    },

    /** Flip the per-conversation scratchpad override and persist it. */
    async toggleScratchpadEnabled() {
        const convo = state.conversations[state.activeConversationId];
        if (!convo) return;
        const next = !this.scratchpadEffectiveEnabled();
        convo.scratchpadEnabled = next;
        this.syncScratchpadToggle();
        try {
            await API.conversations.update(convo.id, { scratchpadEnabled: next });
        } catch (err) {
            console.error('Failed to save scratchpad toggle:', err);
        }
    },

    /**
     * The model edited the scratchpad during its turn (SP-03a live refresh).
     * If the pad is open in view mode, drop the stale cache and reload so the
     * user sees the model's change without reopening. (The hard lock + richer
     * conflict handling is SP-03b; here, edit mode is already blocked while a
     * turn is in flight by the state.isLoading guards.)
     */
    refreshScratchpadFromActivity(convoId) {
        if (!this.isScratchpad() || !this.isOpen) return;
        if (convoId && convoId !== state.activeConversationId) return;
        if (this.editMode) return;
        this._cache = null;
        if (this.historyMode) this.showHistory();
        else this.loadContent();
    },

    /**
     * Auto-save a dirty scratchpad draft before a send (Decision 11): for the
     * pad, sending IS the commit gesture, so the model gets the committed
     * content rather than stale pre-draft text. Awaited by the send path so the
     * write lands before the server assembles the request. Returns the pad to
     * view mode either way (a send closes the editor).
     */
    async autoSaveScratchpadOnSend() {
        if (!this.isScratchpad() || !this.editMode) return;
        const ta = document.getElementById('filePanelEditor');
        if (!ta) return;
        const file = this.file;
        const text = ta.value;
        const dirty = typeof this._draftBaseline === 'string' && text !== this._draftBaseline;
        if (dirty) {
            try {
                await API.files.saveText(file.url, text);
                this._cache = { url: file.url, text };
                this.maybeAutoArmScratchpad(text);
            } catch (err) {
                console.error('Auto-save scratchpad on send failed:', err);
                showToast('Could not save the scratchpad before sending.', { type: 'warning' });
            }
        }
        if (this.file === file) this.returnToView();
    },

    /**
     * Lock the panel editor while the model's turn is in flight (Decision 10):
     * an open editor goes read-only with a note, and unlocks when the turn ends.
     * Simultaneous editing has no benefit and several failure modes, so it is
     * simply prevented. Driven from state.isLoading via updateSendButtonState,
     * so every turn start/end syncs it. (The scratchpad also auto-saves on send,
     * so it is in view mode during the turn; this covers a file editor left open
     * across a send.)
     */
    syncTurnLock() {
        const locked = !!state.isLoading;
        if (this.locked === locked) return;
        this.locked = locked;
        const ta = document.getElementById('filePanelEditor');
        if (ta) ta.readOnly = locked;
        if (elements.filePanelSaveBtn) elements.filePanelSaveBtn.disabled = locked;
        if (elements.filePanel) elements.filePanel.classList.toggle('is-locked', locked);
        if (elements.filePanelLockNote) elements.filePanelLockNote.hidden = !(locked && this.editMode);
        // The lock note supersedes the file conflict note while a turn runs; when
        // the turn ends, reveal the conflict note if the model changed this file
        // meanwhile (the "you were locked out, saving overwrites" signal).
        if (elements.filePanelConflict) {
            elements.filePanelConflict.hidden = locked ? true : !(this.conflict && this.editMode);
        }
    },

    /**
     * Auto-arm (Decision 2): the first non-empty user Save of a pad with no
     * explicit override flips the toggle on and persists it, so "using it
     * enables it" — and it stays armed even if later cleared.
     */
    maybeAutoArmScratchpad(text) {
        if (!this.isScratchpad()) return;
        const convo = state.conversations[this.conversationId];
        if (!convo || convo.scratchpadEnabled != null) return;
        if (typeof text === 'string' && text.trim() !== '') {
            convo.scratchpadEnabled = true;
            this.syncScratchpadToggle();
            API.conversations.update(convo.id, { scratchpadEnabled: true })
                .catch(err => console.error('Failed to auto-arm scratchpad:', err));
        }
    },

    /**
     * From the browser view, load and render the chat's CONTEXT (CT-04): the
     * knowledge files it inherits from its workspace/project, resolved for this
     * chat, plus its own working files. One call — the server does the layering.
     */
    async loadBrowser() {
        const body = elements.filePanelBody;
        const conversationId = state.activeConversationId;
        if (!body || !conversationId) return;
        body.innerHTML = '<p class="file-panel-empty">Loading…</p>';
        const seq = ++this._fetchSeq;
        let context;
        try {
            context = await API.conversations.context.get(conversationId);
        } catch (err) {
            console.error('Failed to load chat context:', err);
            if (seq === this._fetchSeq && this.browseMode && body) {
                body.innerHTML = '<p class="file-panel-empty">Could not load files.</p>';
            }
            return;
        }
        // Stale response (switched files/chat or left the browser since).
        if (seq !== this._fetchSeq || !this.browseMode) return;
        if (state.activeConversationId !== conversationId) return;
        this.renderBrowser(context, conversationId);
    },

    /**
     * Render the chat's context into the panel body: the scratchpad pinned at
     * the top (SP-03a), then a section per source — the inherited workspace,
     * the inherited project, and the chat's own files (CT-04).
     *
     * Sections answer a question the flat list couldn't: where is this chat's
     * context actually coming from?
     *
     * @param {{workspace: Object|null, project: Object|null, chatFiles: Array}} context
     * @param {string} conversationId
     */
    renderBrowser(context, conversationId) {
        const body = elements.filePanelBody;
        if (!body) return;

        // Kept so an in-place toggle can recompute the count badge without a
        // re-fetch: the row builders below mutate the very `f` objects this
        // holds (CT-06).
        this._browserContext = context;

        const list = document.createElement('div');
        list.className = 'fp-browser';

        // Pinned scratchpad entry — always present (the shared thinking space),
        // above everything else.
        const padRow = document.createElement('div');
        padRow.className = 'chat-file-row scratchpad-row';
        padRow.title = 'The shared scratchpad for this chat';
        padRow.innerHTML =
            `<span class="project-file-badge">PAD</span>`
            + `<button type="button" class="chat-file-name clickable">Scratchpad</button>`
            + `<span class="project-file-size scratchpad-row-hint">shared notes</span>`;
        padRow.querySelector('.chat-file-name').addEventListener('click', () => this.openScratchpad());
        list.appendChild(padRow);

        const knowledge = [
            { scope: 'workspace', label: 'Workspace', data: context?.workspace },
            { scope: 'project', label: 'Project', data: context?.project },
        ].filter(s => s.data && s.data.files.length > 0);

        // Tools-off note (CT-06): with file tools off there is no read_file, so an
        // unchecked knowledge file is genuinely unreachable — not merely unloaded.
        // This is the one case worth calling out; muted chat files stay reachable
        // through this very panel, so they don't trigger it.
        const hasDisabledKnowledge = knowledge.some(({ data }) => data.files.some(f => !f.enabled));
        if (context && context.toolsEnabled === false && hasDisabledKnowledge) {
            const note = document.createElement('p');
            note.className = 'fp-tools-off-note';
            note.textContent = 'File tools are off, so unchecked files below are fully excluded — '
                + 'the assistant can\'t open them on request until you turn file tools on.';
            list.appendChild(note);
        }

        knowledge.forEach(({ scope, label, data }) => {
            list.appendChild(this.browserSectionHeader(`${label} · ${data.name}`));
            // Knowledge files keep their upload order: in a reference library the
            // useful question is "what is this called", the opposite of a chat's.
            data.files.forEach(f => list.appendChild(
                this.knowledgeRow(f, scope, data.id, conversationId)));
        });

        const chatFiles = Array.isArray(context?.chatFiles) ? context.chatFiles : [];
        if (chatFiles.length > 0) {
            // Only label the section when there is something above it to
            // distinguish it from.
            if (knowledge.length > 0) list.appendChild(this.browserSectionHeader('This chat'));
            // Newest first: in a chat the useful question is "what were we just
            // working on", not "what is this called".
            [...chatFiles]
                .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
                .forEach(f => list.appendChild(this.chatFileRow(f, conversationId)));
        } else if (knowledge.length === 0) {
            const note = document.createElement('p');
            note.className = 'file-panel-empty fp-browser-empty';
            note.textContent = 'No files in this chat yet.';
            list.appendChild(note);
        }

        body.innerHTML = '';
        body.appendChild(list);

        // The panel's own fetch is the freshest read of this chat's context, so
        // let it settle the badge too (CT-06) — and mark it current so a
        // navigation-time sync won't re-fetch what we just rendered.
        this._badgeConvId = conversationId;
        this.applyContextBadge(this.contextNotLoadedItems(context));
    },

    /** A source divider in the browser list (CT-04). */
    browserSectionHeader(text) {
        const el = document.createElement('div');
        el.className = 'fp-browser-section';
        el.textContent = text;
        return el;
    },

    /**
     * One inherited knowledge file (CT-04): a checkbox resolving this chat's
     * state, plus a reset control when the row overrides its container default.
     */
    knowledgeRow(f, scope, containerId, conversationId) {
        const api = scope === 'workspace' ? API.workspaces.files : API.projects.files;
        const href = api.contentUrl(containerId, f.id);
        const viewable = !/\.pdf$/i.test(f.filename || '');
        const overridden = f.source === 'chat';

        const row = document.createElement('div');
        row.className = `chat-file-row knowledge-row${f.enabled ? '' : ' is-context-off'}${overridden ? ' is-overridden' : ''}`;
        row.title = f.filename || '';
        row.innerHTML =
            `<input type="checkbox" class="project-file-toggle" ${f.enabled ? 'checked' : ''}
                    aria-label="Load ${escapeHtml(f.filename)} into this chat"
                    title="Load this file into THIS chat. Other chats are unaffected.">`
            + `<span class="project-file-badge">${escapeHtml(getFileTypeLabel(f.filename, f.mimeType))}</span>`
            + (viewable
                ? `<button type="button" class="chat-file-name clickable">${escapeHtml(f.filename)}</button>`
                : `<span class="chat-file-name">${escapeHtml(f.filename)}</span>`)
            + `<span class="project-file-size">${escapeHtml(formatFileSize(f.sizeBytes))}</span>`
            + `<button type="button" class="fp-reset-btn" title="Reset to the ${scope} default"
                       aria-label="Reset ${escapeHtml(f.filename)} to the ${scope} default"${overridden ? '' : ' hidden'}>↺</button>`;

        if (viewable) {
            row.querySelector('.chat-file-name').addEventListener('click', () => {
                this.open({ fileName: f.filename, url: href, mimeType: f.mimeType, sizeBytes: f.sizeBytes });
            });
        }
        row.querySelector('.project-file-toggle').addEventListener('change', (e) =>
            this.setKnowledgeOverride(f, scope, conversationId, e.target, row));
        row.querySelector('.fp-reset-btn').addEventListener('click', () =>
            this.resetKnowledgeOverride(f, scope, conversationId, row));
        return row;
    },

    /** One of the chat's own working files, with its auto/pin/mute control. */
    chatFileRow(f, conversationId) {
        const href = API.conversations.files.contentUrl(conversationId, f.id);
        const viewable = !/\.pdf$/i.test(f.filename || '');
        const mode = INJECT_MODES.includes(f.injectMode) ? f.injectMode : 'auto';

        const row = document.createElement('div');
        row.className = `chat-file-row${mode === 'mute' ? ' is-context-off' : ''}`;
        row.title = f.filename || '';
        row.innerHTML =
            `<button type="button" class="fp-mode-btn mode-${mode}" data-mode="${mode}"
                     title="${escapeHtml(INJECT_MODE_TITLES[mode])}"
                     aria-label="${escapeHtml(f.filename)}: ${escapeHtml(INJECT_MODE_TITLES[mode])}">${INJECT_MODE_ICONS[mode]}</button>`
            + `<span class="project-file-badge">${escapeHtml(getFileTypeLabel(f.filename, f.mimeType))}</span>`
            + (viewable
                ? `<button type="button" class="chat-file-name clickable">${escapeHtml(f.filename)}</button>`
                : `<span class="chat-file-name">${escapeHtml(f.filename)}</span>`)
            + `<span class="project-file-size">${escapeHtml(formatFileSize(f.sizeBytes))}</span>`
            + `<a class="project-file-download" href="${href}" download title="Download">⤓</a>`;

        if (viewable) {
            row.querySelector('.chat-file-name').addEventListener('click', () => {
                this.open({ fileName: f.filename, url: href, mimeType: f.mimeType, sizeBytes: f.sizeBytes });
            });
        }
        row.querySelector('.fp-mode-btn').addEventListener('click', (e) =>
            this.cycleInjectMode(f, conversationId, e.currentTarget, row));
        return row;
    },

    /**
     * Flip a knowledge file's state FOR THIS CHAT (CT-04). Optimistic, same
     * reasoning as the container page: free to undo, so a round trip per click
     * would just feel slow.
     */
    async setKnowledgeOverride(f, scope, conversationId, checkbox, row) {
        const enabled = checkbox.checked;
        const prev = { enabled: f.enabled, source: f.source };
        // Toggling back to the container default is a RESET, not an override:
        // an override that equals the default is a phantom (it would show the
        // "overridden" marker while deviating from nothing). Keeps the panel
        // faithful to "an override exists only when the chat deviates".
        const matchesDefault = f.containerEnabled !== undefined && enabled === f.containerEnabled;
        this.applyKnowledgeRowState(row, f, { enabled, source: matchesDefault ? 'container' : 'chat' });
        checkbox.disabled = true;
        try {
            if (matchesDefault) {
                await API.conversations.context.reset(conversationId, scope, f.id);
            } else {
                await API.conversations.context.setEnabled(conversationId, scope, f.id, enabled);
            }
        } catch (err) {
            console.error('Failed to set per-chat context override:', err);
            checkbox.checked = prev.enabled;
            this.applyKnowledgeRowState(row, f, prev);
            displayError(err, { action: 'update the file' });
        } finally {
            checkbox.disabled = false;
        }
    },

    /** Drop this chat's override and fall back to the container default. */
    async resetKnowledgeOverride(f, scope, conversationId, row) {
        const prev = { enabled: f.enabled, source: f.source };
        const btn = row.querySelector('.fp-reset-btn');
        if (btn) btn.disabled = true;
        try {
            const res = await API.conversations.context.reset(conversationId, scope, f.id);
            // The server echoes what the file now resolves to, so the row can
            // snap to the container default without a second round trip.
            this.applyKnowledgeRowState(row, f, { enabled: res.enabled, source: 'container' });
            const cb = row.querySelector('.project-file-toggle');
            if (cb) cb.checked = res.enabled;
        } catch (err) {
            console.error('Failed to reset per-chat context override:', err);
            this.applyKnowledgeRowState(row, f, prev);
            displayError(err, { action: 'reset the file' });
        } finally {
            if (btn) btn.disabled = false;
        }
    },

    /** Write a resolved state onto a knowledge row (and its cached record). */
    applyKnowledgeRowState(row, f, { enabled, source }) {
        f.enabled = enabled;
        f.source = source;
        row.classList.toggle('is-context-off', !enabled);
        row.classList.toggle('is-overridden', source === 'chat');
        const btn = row.querySelector('.fp-reset-btn');
        if (btn) btn.hidden = source !== 'chat';
        this.refreshBadgeFromBrowser(); // the count changed with the row (CT-06)
    },

    /**
     * Cycle a chat working file through auto → pin → mute → auto (CT-04). One
     * click, no menu: the icon carries the state, so the control is as cheap to
     * read as it is to change.
     */
    async cycleInjectMode(f, conversationId, btn, row) {
        const current = INJECT_MODES.includes(f.injectMode) ? f.injectMode : 'auto';
        const next = INJECT_MODES[(INJECT_MODES.indexOf(current) + 1) % INJECT_MODES.length];
        this.applyInjectMode(btn, row, f, next);
        btn.disabled = true;
        try {
            await API.conversations.files.setInjectMode(conversationId, f.id, next);
        } catch (err) {
            console.error('Failed to set inject mode:', err);
            this.applyInjectMode(btn, row, f, current);
            displayError(err, { action: 'update the file' });
        } finally {
            btn.disabled = false;
        }
    },

    /** Write an inject mode onto a chat-file row (and its cached record). */
    applyInjectMode(btn, row, f, mode) {
        f.injectMode = mode;
        btn.dataset.mode = mode;
        btn.className = `fp-mode-btn mode-${mode}`;
        btn.innerHTML = INJECT_MODE_ICONS[mode];
        btn.title = INJECT_MODE_TITLES[mode];
        btn.setAttribute('aria-label', `${f.filename}: ${INJECT_MODE_TITLES[mode]}`);
        row.classList.toggle('is-context-off', mode === 'mute');
        this.refreshBadgeFromBrowser(); // muting/unmuting changes the count (CT-06)
    },

    // ---- Not-loaded count badge + popover (CT-06) ----

    _badgeConvId: null,   // the chat the badge currently reflects (skip re-fetch)
    _badgeSeq: 0,         // ignore stale badge fetches after rapid switches
    _notLoaded: [],       // [{ name, note }] currently not loaded — feeds the popover
    _contextPopover: null,
    _browserContext: null,

    /**
     * The files not loaded into this chat, for the badge count + hover popover:
     * disabled knowledge files (with where they live) and muted chat files.
     * Pinned/auto/enabled files are loaded, so they don't appear.
     * @param {Object} context - a /context response
     * @returns {Array<{name: string, note: string}>}
     */
    contextNotLoadedItems(context) {
        const items = [];
        for (const [scope, label] of [['workspace', 'Workspace'], ['project', 'Project']]) {
            const sec = context && context[scope];
            if (!sec) continue;
            for (const f of sec.files) {
                if (!f.enabled) items.push({ name: f.filename, note: label });
            }
        }
        for (const f of (context && context.chatFiles) || []) {
            if (f.injectMode === 'mute') items.push({ name: f.filename, note: 'Muted' });
        }
        return items;
    },

    /** Recompute the badge from the panel's last-rendered context (no fetch). */
    refreshBadgeFromBrowser() {
        if (this._browserContext) this.applyContextBadge(this.contextNotLoadedItems(this._browserContext));
    },

    /**
     * React to the chat's file-tools state changing (CT-06). The tools-off note
     * lives in the browser view, so an open list must re-render to show or hide
     * it — otherwise a user who flips tools off with the panel open never sees
     * the warning that their disabled files are now truly unreachable. We know
     * the new value, so update the cached context and re-render without a fetch.
     * @param {boolean} enabled - the new effective file-tools state
     */
    onToolsToggled(enabled) {
        if (!this._browserContext) return;
        this._browserContext.toolsEnabled = enabled;
        if (this.isOpen && this.browseMode && this.conversationId) {
            this.renderBrowser(this._browserContext, this.conversationId);
        }
    },

    /**
     * Write a not-loaded list onto the badge: count, visibility, the button's
     * accessible name, and any open popover. Hidden entirely at zero, so a user
     * who never touches a toggle never sees new chrome.
     * @param {Array<{name: string, note: string}>} items
     */
    applyContextBadge(items) {
        this._notLoaded = items || [];
        const n = this._notLoaded.length;
        const badge = elements.filesExplorerCount;
        if (badge) {
            badge.hidden = n === 0;
            badge.textContent = n > 0 ? String(n) : '';
        }
        const btn = elements.filesExplorerBtn;
        if (btn) {
            const base = 'Files in this chat';
            btn.setAttribute('aria-label', n > 0 ? `${base}, ${n} not loaded` : base);
            // Drop the native title while the count popover covers the same
            // ground, so the two tooltips don't stack; restore it at zero.
            if (n > 0) btn.removeAttribute('title');
            else btn.title = base;
        }
        if (this._contextPopover) this.renderContextPopover();
    },

    /**
     * Refresh the badge for the active chat (CT-06). Called on navigation, when
     * the panel may be closed — the whole point is a signal you can't miss
     * without opening the panel. Skips the fetch when it already reflects this
     * chat (an in-place toggle keeps it current).
     */
    async syncContextBadge() {
        const inChat = (state.ui.mainView || {}).type === 'chat';
        const conversationId = state.activeConversationId;
        if (!inChat || !conversationId) {
            this._badgeConvId = null;
            this._browserContext = null;
            this.hideContextPopover();
            this.applyContextBadge([]);
            return;
        }
        if (conversationId === this._badgeConvId) return; // already current

        this._badgeConvId = conversationId;
        const seq = ++this._badgeSeq;
        let context;
        try {
            context = await API.conversations.context.get(conversationId);
        } catch (err) {
            console.error('Failed to load context badge:', err);
            this._badgeConvId = null; // allow a retry on the next navigation
            return;
        }
        if (seq !== this._badgeSeq || state.activeConversationId !== conversationId) return;
        this.applyContextBadge(this.contextNotLoadedItems(context));
    },

    /** Show the hover/focus popover naming the not-loaded files. */
    showContextPopover() {
        if (!this._notLoaded || this._notLoaded.length === 0) return;
        this.hideContextPopover();
        const pop = document.createElement('div');
        pop.className = 'fp-context-popover';
        this._contextPopover = pop;
        this.renderContextPopover();
        positionPopover(pop, elements.filesExplorerBtn, 'right');
    },

    /** (Re)render the popover body from the current not-loaded list. */
    renderContextPopover() {
        const pop = this._contextPopover;
        if (!pop) return;
        const items = this._notLoaded || [];
        if (items.length === 0) { this.hideContextPopover(); return; }
        pop.innerHTML =
            `<div class="fp-context-popover-title">Not loaded in this chat</div>`
            + items.map(it =>
                `<div class="fp-context-popover-row">`
                + `<span class="fp-cp-name">${escapeHtml(it.name)}</span>`
                + `<span class="fp-cp-note">${escapeHtml(it.note)}</span>`
                + `</div>`).join('');
    },

    hideContextPopover() {
        if (this._contextPopover) {
            this._contextPopover.remove();
            this._contextPopover = null;
        }
    },

    /**
     * Open a container/Downloads file from a file list (FC-04). Unlike open(),
     * this is not tied to a conversation — the panel floats beside the
     * project/workspace page it was opened on and is dismissed on navigation.
     * @param {{fileName:string, url:string, mimeType?:string, sizeBytes?:number}} descriptor
     */
    openStandalone(descriptor) {
        if (!descriptor || !descriptor.url) return;
        this.discardDraft();
        const view = state.ui.mainView || {};
        this.standalone = true;
        this.standaloneView = `${view.type}:${view.id || ''}`;
        this.historyMode = false;
        this.browseMode = false;
        this.file = descriptor;
        this.conversationId = null;
        this.isOpen = true;
        this.unseen = false;
        this.rawMode = false;
        this.renderHeader();
        this.loadContent();
        this.syncUi();
    },

    close() {
        this.discardDraft();
        this.isOpen = false;
        this.syncUi();
    },

    /**
     * Leave edit mode without saving, warning only when the draft actually
     * differed from its baseline (silent for an untouched editor). The
     * baseline is captured at enterEdit — deliberately not the fetch cache,
     * which a mid-edit assistant rewrite invalidates.
     */
    discardDraft() {
        if (!this.editMode) return;
        const ta = document.getElementById('filePanelEditor');
        const dirty = ta && typeof this._draftBaseline === 'string' && ta.value !== this._draftBaseline;
        this.exitEditMode();
        if (dirty) showToast('Your unsaved edit was discarded.', { type: 'warning' });
    },

    /**
     * Central visibility sync, called from syncChatChrome on every navigation.
     * Panel + tab exist only in a chat view; when the active conversation
     * changed underneath us, re-derive the file from its messages.
     */
    syncUi() {
        if (!elements.filePanel) return;
        const view = state.ui.mainView || {};
        const inChat = view.type === 'chat';

        // FC-04 standalone viewer: a file opened from a container/Downloads list.
        // It floats beside the page it was opened on; opening a chat or
        // navigating to any other page dismisses it.
        if (this.standalone) {
            const viewKey = `${view.type}:${view.id || ''}`;
            if (inChat || viewKey !== this.standaloneView) {
                this.discardDraft();
                this.standalone = false;
                this.historyMode = false;
                this.browseMode = false;
                this.isOpen = false;
                this.file = null;
                // fall through to the chat logic below (hides or re-derives)
            } else {
                elements.filePanel.hidden = !(this.isOpen && !!this.file);
                if (elements.filesExplorerDot) elements.filesExplorerDot.hidden = true;
                return;
            }
        }

        if (inChat && this.conversationId !== state.activeConversationId) {
            this.discardDraft();
            this.conversationId = state.activeConversationId;
            this.file = this.deriveConversationFile();
            this.isOpen = false;
            this.unseen = false;
            this.historyMode = false;
            this.browseMode = false;
        }

        // The panel shows for the browser view (no file needed) or the viewer
        // (needs a file). The top-bar files button (renderTopBar) is the entry
        // point; its dot signals unseen activity while the panel is closed.
        const showPanel = inChat && this.isOpen && (this.browseMode || !!this.file);
        elements.filePanel.hidden = !showPanel;
        if (elements.filesExplorerDot) {
            elements.filesExplorerDot.hidden = !(inChat && !showPanel && this.unseen);
        }
    },

    /** Most recent created_file attachment in the active conversation, if any. */
    deriveConversationFile() {
        const convo = state.conversations[state.activeConversationId];
        if (!convo || !Array.isArray(convo.messages)) return null;
        for (let i = convo.messages.length - 1; i >= 0; i--) {
            const atts = convo.messages[i].attachments;
            if (!Array.isArray(atts)) continue;
            for (let j = atts.length - 1; j >= 0; j--) {
                if (atts[j] && atts[j].type === 'created_file' && atts[j].url) return atts[j];
            }
        }
        return null;
    },

    renderHeader() {
        // The browse toggle (CF-01b) flips list ⇄ file; active while the list
        // is shown. It's a chat-files affordance, so it's hidden for the FC-04
        // standalone viewer (a container/Downloads file on a non-chat page).
        if (elements.filePanelBrowseBtn) {
            elements.filePanelBrowseBtn.hidden = this.standalone;
            elements.filePanelBrowseBtn.classList.toggle('active', this.browseMode);
        }

        // Browser view: no single file, so the per-file controls don't apply.
        if (this.browseMode) {
            if (elements.filePanelBadge) elements.filePanelBadge.hidden = true;
            if (elements.filePanelName) {
                elements.filePanelName.textContent = 'Files in this chat';
                elements.filePanelName.title = '';
            }
            [elements.filePanelEditBtn, elements.filePanelRawToggle,
             elements.filePanelHistoryBtn, elements.filePanelDownload,
             elements.filePanelScratchpadToggle].forEach(el => {
                if (el) el.hidden = true;
            });
            return;
        }

        const f = this.file;
        if (!f) return;
        const isPad = this.isScratchpad();

        // Scratchpad "active" toggle: only for the pad.
        if (elements.filePanelScratchpadToggle) {
            elements.filePanelScratchpadToggle.hidden = !isPad || this.editMode || this.historyMode;
            if (isPad) this.syncScratchpadToggle();
        }

        if (elements.filePanelBadge) {
            elements.filePanelBadge.hidden = false;
            elements.filePanelBadge.textContent = isPad ? 'PAD' : getFileTypeLabel(f.fileName, f.mimeType);
        }
        if (elements.filePanelName) {
            elements.filePanelName.textContent = f.fileName || 'File';
            elements.filePanelName.title = f.fileName || 'File';
        }
        if (elements.filePanelDownload) {
            // The scratchpad isn't a downloadable file.
            elements.filePanelDownload.hidden = isPad;
            if (!isPad) {
                elements.filePanelDownload.href = f.url;
                elements.filePanelDownload.setAttribute('download', f.fileName || 'file');
            }
        }
        if (elements.filePanelRawToggle) {
            elements.filePanelRawToggle.hidden = this.editMode || this.historyMode || !this.isMarkdown();
            elements.filePanelRawToggle.classList.toggle('active', this.rawMode);
        }
        // History toggle (FC-04): available except while editing; active shows
        // the revision log instead of the content.
        if (elements.filePanelHistoryBtn) {
            elements.filePanelHistoryBtn.hidden = this.editMode;
            elements.filePanelHistoryBtn.classList.toggle('active', this.historyMode);
        }
        // All panel files are text in v1 — editable unless a draft or history is open.
        if (elements.filePanelEditBtn) elements.filePanelEditBtn.hidden = this.editMode || this.historyMode;
    },

    isMarkdown() {
        if (this.isScratchpad()) return true; // the pad renders as markdown notes
        const name = (this.file && this.file.fileName || '').toLowerCase();
        return name.endsWith('.md') || name.endsWith('.markdown');
    },

    toggleRaw() {
        this.rawMode = !this.rawMode;
        this.renderHeader();
        this.loadContent();
    },

    // ---- Change history (FC-04) ----


    /** Toggle between the file's content and its revision history. */
    toggleHistory() {
        if (!this.file || this.editMode) return;
        if (this.historyMode) {
            this.historyMode = false;
            this.renderHeader();
            this.loadContent();
        } else {
            this.showHistory();
        }
    },

    /** Fetch the file's revisions and render the version viewer (FC-06b). */
    async showHistory() {
        if (!this.file) return;
        this.historyMode = true;
        this.renderHeader();
        const body = elements.filePanelBody;
        if (body) body.innerHTML = '<p class="file-panel-empty">Loading history…</p>';
        const seq = ++this._fetchSeq;
        let revs;
        try {
            revs = await API.files.revisions(this.file.url);
        } catch (err) {
            console.error('Failed to load file history:', err);
            if (seq === this._fetchSeq && this.historyMode && body) {
                body.innerHTML = '<p class="file-panel-empty">Could not load history.</p>';
            }
            return;
        }
        // Ignore a stale response (panel switched files / left history since).
        if (seq !== this._fetchSeq || !this.historyMode) return;
        // Newest first; select the newest version by default.
        this.historyRevisions = Array.isArray(revs) ? [...revs].reverse() : [];
        this.selectedRevId = this.historyRevisions.length ? this.historyRevisions[0].id : null;
        this.renderHistory();
    },

    /** Render the version list + the selected version's detail (FC-06b). */
    renderHistory() {
        const body = elements.filePanelBody;
        if (!body) return;
        const revs = this.historyRevisions;
        if (!revs.length) {
            body.innerHTML = '<p class="file-panel-empty">No changes recorded yet.</p>';
            return;
        }

        const wrap = document.createElement('div');
        wrap.className = 'fp-history';

        // Version rail (newest first). Index 0 is the current version.
        const rail = document.createElement('div');
        rail.className = 'fp-versions';
        revs.forEach((rev, i) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'fp-version' + (rev.id === this.selectedRevId ? ' is-selected' : '');
            const { adds, dels } = diffStats(rev.diff);
            const who = rev.author === 'user' ? 'You' : 'Assistant';
            btn.innerHTML =
                `<span class="fp-version-line">`
                + `<span class="fp-version-who">${escapeHtml(who)}</span>`
                + `<span class="fp-version-op">${escapeHtml(rev.op)}</span>`
                + (i === 0 ? `<span class="fp-version-current">current</span>` : '')
                + `</span>`
                + `<span class="fp-version-line fp-version-sub">`
                + `<span class="fp-version-when">${escapeHtml(formatTimeAgo(rev.createdAt))}</span>`
                + `<span class="fp-version-stat">`
                + (adds ? `<span class="fp-add">+${adds}</span>` : '')
                + (dels ? `<span class="fp-del">−${dels}</span>` : '')
                + `</span></span>`;
            btn.addEventListener('click', () => this.selectVersion(rev.id));
            rail.appendChild(btn);
        });
        wrap.appendChild(rail);

        // Detail pane for the selected version.
        const detail = document.createElement('div');
        detail.className = 'fp-detail';
        const rev = revs.find(r => r.id === this.selectedRevId) || revs[0];
        const isCurrent = rev.id === revs[0].id;

        const head = document.createElement('div');
        head.className = 'fp-detail-head';
        const who = rev.author === 'user' ? 'You' : 'Assistant';
        head.innerHTML = `<span class="fp-detail-title">${escapeHtml(who)} · ${escapeHtml(rev.op)} · ${escapeHtml(new Date(rev.createdAt).toLocaleString())}</span>`;
        if (!isCurrent && rev.hasSnapshot) {
            const restore = document.createElement('button');
            restore.type = 'button';
            restore.className = 'fp-restore-btn';
            restore.textContent = 'Restore this version';
            restore.addEventListener('click', () => this.restoreVersion(rev.id));
            head.appendChild(restore);
        }
        detail.appendChild(head);
        detail.appendChild(buildRichDiff(rev.diff));
        wrap.appendChild(detail);

        body.innerHTML = '';
        body.appendChild(wrap);
    },

    /** Show a different version in the detail pane. */
    selectVersion(revId) {
        this.selectedRevId = revId;
        if (this.historyMode) this.renderHistory();
    },

    /** Restore the file to a stored version (adds a new version, FC-06b). */
    async restoreVersion(revId) {
        if (!this.file || state.isLoading) {
            if (state.isLoading) showToast('Wait for the assistant to finish its turn first.', { type: 'warning' });
            return;
        }
        const ok = await confirmDialog({
            title: 'Restore this version?',
            body: 'The file’s current content is replaced with this version, and the replacement is added as a new entry in the history.',
            confirmLabel: 'Restore',
        });
        if (!ok) return;
        try {
            const updated = await API.files.restoreRevision(this.file.url, revId);
            if (updated && typeof updated.sizeBytes === 'number') this.file.sizeBytes = updated.sizeBytes;
            this._cache = null; // content changed server-side
            showToast('Restored.', { type: 'success' });
            this.showHistory(); // refresh the log (restore appended a version)
        } catch (err) {
            console.error('Failed to restore version:', err);
            displayError(err, { action: 'restore the version' });
        }
    },

    // ---- User editing (slice 3) ----

    /** Switch the body to a textarea holding the file's full current text. */
    enterEdit() {
        if (this.editMode || !this.file) return;
        if (state.isLoading) {
            showToast('Wait for the assistant to finish its turn first.', { type: 'warning' });
            return;
        }
        // The full text lives in the fetch cache; without it (load still in
        // flight or failed) there is nothing safe to edit yet.
        if (!this._cache || this._cache.url !== this.file.url) {
            showToast('Still loading the file — try again in a moment.', { type: 'warning' });
            return;
        }
        if (this._cache.text.length > this.MAX_RENDER_CHARS) {
            showToast('This file is too large to edit here. Download it instead.', { type: 'warning' });
            return;
        }
        this.editMode = true;
        this.conflict = false;
        // Dirty-detection baseline: what the draft started from. Kept apart
        // from the fetch cache, which a mid-edit assistant rewrite nulls.
        this._draftBaseline = this._cache.text;
        this.renderHeader();
        if (elements.filePanel) elements.filePanel.classList.add('is-editing');
        if (elements.filePanelBody) {
            elements.filePanelBody.innerHTML = '';
            const ta = document.createElement('textarea');
            ta.className = 'file-panel-editor';
            ta.id = 'filePanelEditor';
            ta.setAttribute('aria-label', `Edit ${this.file.fileName || 'file'}`);
            ta.value = this._cache.text;
            elements.filePanelBody.appendChild(ta);
            ta.focus();
        }
        if (elements.filePanelFooter) elements.filePanelFooter.hidden = false;
        if (elements.filePanelConflict) elements.filePanelConflict.hidden = true;
    },

    /**
     * Clear edit-mode state + chrome (does not repaint the body), then
     * re-dispatch any file activity that arrived while the draft was open so
     * its panel/edge-tab signal is delivered, not lost.
     */
    exitEditMode() {
        this.editMode = false;
        this.conflict = false;
        this._draftBaseline = null;
        if (elements.filePanel) elements.filePanel.classList.remove('is-editing');
        if (elements.filePanelFooter) elements.filePanelFooter.hidden = true;
        if (elements.filePanelConflict) elements.filePanelConflict.hidden = true;
        const pending = this._pendingActivity;
        this._pendingActivity = null;
        // Re-dispatch outside edit mode: normal open/tab-dot behavior, and the
        // stale-conversation guard drops it if the user has switched chats.
        if (pending) this.notifyActivity(pending.att, pending.convoId);
    },

    /** Return the panel to view mode showing the file's current content. */
    returnToView() {
        this.exitEditMode();
        this.renderHeader();
        this.loadContent();
    },

    /** Discard the draft and show the file's current content again. */
    cancelEdit() {
        if (!this.editMode) return;
        this.returnToView();
    },

    /** Save the draft to the server, then return to view mode. */
    async saveEdit() {
        if (!this.editMode || !this.file) return;
        if (state.isLoading) {
            showToast('Wait for the assistant to finish its turn first.', { type: 'warning' });
            return;
        }
        const ta = document.getElementById('filePanelEditor');
        if (!ta) return;
        const text = ta.value;

        // Mirrors the server's PROJECT_FILE_MAX_BYTES default — a friendlier
        // stop than the request bouncing off the body-size limit.
        if (new TextEncoder().encode(text).length > 10 * 1024 * 1024) {
            showToast('This is too large to save (limit 10MB). Trim the content or download and edit locally.', { type: 'warning' });
            return;
        }

        // The assistant rewrote this file mid-edit — saving is a deliberate
        // choice to overwrite its version, so ask.
        if (this.conflict) {
            const ok = await confirmDialog({
                title: 'Overwrite the assistant’s version?',
                body: 'The assistant updated this file while you were editing. Saving replaces its version with yours.',
                confirmLabel: 'Save anyway',
                danger: true,
            });
            if (!ok) return;
        }

        // Pinned: a conversation switch or panel close while the PUT is in
        // flight reassigns this.file — the result must apply to THIS file.
        const file = this.file;
        const saveBtn = elements.filePanelSaveBtn;
        const cancelBtn = elements.filePanelCancelBtn;
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
        if (cancelBtn) cancelBtn.disabled = true;
        try {
            const updated = await API.files.saveText(file.url, text);
            if (updated && typeof updated.sizeBytes === 'number') file.sizeBytes = updated.sizeBytes;
            // The saved text is now the freshest content for this url — cache
            // it under the PINNED url (url-keyed, so this can never mislabel
            // another file's content even after a mid-save switch).
            this._cache = { url: file.url, text };
            // Auto-arm the scratchpad on its first non-empty save (SP-03a).
            if (file.scratchpad) this.maybeAutoArmScratchpad(text);
            // Only repaint if the panel still shows the file we saved; a
            // mid-save conversation switch already tore the editor down.
            if (this.file === file && this.editMode) {
                this.returnToView();
            }
            showToast('Saved.', { type: 'success' });
        } catch (err) {
            console.error('Failed to save file:', err);
            displayError(err, { action: 'save the file' });
        } finally {
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
            if (cancelBtn) cancelBtn.disabled = false;
        }
    },

    /**
     * Fetch the file's text (same content URL the download uses, via the
     * api-client so 401s trigger the app's re-auth flow) and render. Serves
     * from the in-memory cache when the content hasn't changed — raw/rendered
     * toggles and repeat card clicks cost no network round-trip.
     */
    async loadContent() {
        if (!this.file || !elements.filePanelBody) return;
        if (this.editMode) return; // never repaint over an open draft
        const seq = ++this._fetchSeq;

        let text;
        if (this._cache && this._cache.url === this.file.url) {
            text = this._cache.text;
        } else {
            elements.filePanelBody.innerHTML = '<div class="file-panel-loading">Loading…</div>';
            try {
                text = await API.files.fetchText(this.file.url);
            } catch (err) {
                if (seq !== this._fetchSeq) return;
                elements.filePanelBody.innerHTML =
                    '<div class="file-panel-error">Could not load the file. It may have been deleted — try the download button, or ask the assistant to recreate it.</div>';
                return;
            }
            if (seq !== this._fetchSeq) return;
            this._cache = { url: this.file.url, text };
        }

        // Empty scratchpad: a hint instead of a blank pane (SP-03a).
        if (this.isScratchpad() && text.trim() === '') {
            elements.filePanelBody.innerHTML =
                '<div class="file-panel-empty scratchpad-empty">The scratchpad is empty. Use the edit button to start jotting ideas — the assistant can see and edit it too.</div>';
            this.syncScratchpadToggle();
            return;
        }

        let truncated = false;
        if (text.length > this.MAX_RENDER_CHARS) {
            text = text.slice(0, this.MAX_RENDER_CHARS);
            truncated = true;
        }
        this.renderContent(text, truncated);
        // The auto-arm leg of the toggle depends on the now-loaded content.
        if (this.isScratchpad()) this.syncScratchpadToggle();
    },

    renderContent(text, truncated) {
        const body = elements.filePanelBody;
        body.innerHTML = '';

        // Oversized content renders as plain text: parsing it would jank, and
        // a mid-source truncation would corrupt rendered markdown anyway.
        const plainOnly = text.length > this.MAX_RICH_RENDER_CHARS;

        if (this.isMarkdown() && !this.rawMode && !plainOnly) {
            const div = document.createElement('div');
            div.className = 'message-content';
            div.innerHTML = renderMarkdown(text);
            body.appendChild(div);
        } else {
            const pre = document.createElement('pre');
            pre.className = 'file-panel-raw';
            const code = document.createElement('code');
            const lang = plainOnly ? null : this.hljsLanguage();
            if (lang) {
                try {
                    code.innerHTML = hljs.highlight(text, { language: lang }).value;
                } catch {
                    code.textContent = text;
                }
            } else {
                code.textContent = text;
            }
            pre.appendChild(code);
            body.appendChild(pre);
        }

        if (truncated) {
            const note = document.createElement('div');
            note.className = 'file-panel-error';
            note.textContent = 'File is large — showing the beginning only. Use download for the full content.';
            body.appendChild(note);
        }
    },

    /**
     * hljs language for the file's extension, or null for plain text. hljs
     * resolves common extensions as aliases itself (js, ts, py, yml, html,
     * md, …), so the extension is the language id — no mapping table.
     */
    hljsLanguage() {
        const name = (this.file && this.file.fileName || '').toLowerCase();
        const ext = name.slice(name.lastIndexOf('.') + 1);
        return ext && hljs.getLanguage(ext) ? ext : null;
    },
};
