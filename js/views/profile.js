/**
 * Profile view (UP-02, docs/PROFILE_DESIGN.md tier 1)
 *
 * Who the USER is, in their own words — the counterpart to the persona editor.
 * A persona describes the character the model plays; this describes the person
 * it is playing to. That framing is deliberate and is why this sits beside
 * Personas in the rail rather than inside Settings: Settings is configuration,
 * and none of this is configuration.
 *
 * WHY THIS VIEW BUILDS ITS DOM ONCE AND THEN MUTATES IT
 *
 * Every other list view re-renders wholesale on change, which is fine for rows
 * you click. It is NOT fine here: this page is mostly textareas, and
 * re-rendering one while it has focus destroys the caret mid-word. So:
 *
 *   - `renderProfileView()` builds the page only when it has to (first visit,
 *     or when the underlying profile was replaced).
 *   - Typing mutates `state.profile` in place and schedules a save. No re-render.
 *   - Structural edits (add / delete / move a section) mutate BOTH the model and
 *     the DOM directly, then restore focus deliberately.
 *
 * Nothing here reaches the model yet — UP-03 adds the `profile` system block.
 * This slice ships a page you can fill in before it has anywhere to go.
 */

import { state } from '../state.js';
import { elements } from '../dom.js';
import { API } from '../api-client.js';
import { showToast } from '../components/toast.js';
import { confirmDialog } from '../components/dialogs.js';
import { displayError } from '../components/errors.js';
import { escapeHtml } from '../util/format.js';

/**
 * Server limits + suggested sections, fetched once and cached.
 * Falls back to conservative numbers if the probe fails, so the editor still
 * works (and still guards) when offline — the server re-checks everything
 * anyway, so a stale client limit can never corrupt a profile.
 */
let meta = null;
const FALLBACK_META = {
    sections: [],
    limits: { preferredNameChars: 60, sections: 12, titleChars: 60, bodyChars: 4000, profileChars: 16000 },
};

/** Debounce handle for the profile PUT. Mirrors autoSaveSettings' 300ms. */
let saveTimeout = null;
/** True while a save is in flight, so the status line can say so. */
let saving = false;
/** Set when the DOM has been built for the current profile object. */
let built = false;

/** The id of whatever created a newly added section, so focus can land on it. */
let focusSectionId = null;

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/** Characters that would actually reach the model (mirrors profileTextLength). */
function textLength(profile) {
    if (!profile) return 0;
    let total = (profile.preferredName || '').length;
    for (const s of profile.sections || []) {
        if (s.enabled === false) continue;
        total += (s.title || '').length + (s.body || '').length;
    }
    return total;
}

/**
 * Load the profile and the server's limits, once.
 * Both are cheap and the view cannot render without them.
 */
async function ensureLoaded() {
    if (!meta) {
        try {
            meta = await API.profile.suggested();
        } catch (err) {
            console.warn('Profile suggestions unavailable; using fallbacks:', err);
            meta = FALLBACK_META;
        }
    }
    if (!state.profile) {
        state.profile = await API.profile.get();
        built = false;
    }
}

/**
 * Persist the profile (debounced).
 *
 * Sends the WHOLE document, because that is what the endpoint takes — sections
 * are reordered and deleted, which no field-level patch could express.
 */
function scheduleSave() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(save, 300);
    syncStatus();
}

async function save() {
    if (!state.profile) return;
    // Release the debounce handle: it has already fired, and syncStatus reads
    // it as "a save is still pending". Left set, the status line sticks on
    // "Saving…" forever after the first successful save.
    saveTimeout = null;
    saving = true;
    syncStatus();
    try {
        const saved = await API.profile.update({
            preferredName: state.profile.preferredName || '',
            sections: (state.profile.sections || []).map((s) => ({
                id: s.id,
                title: s.title || '',
                body: s.body || '',
                enabled: s.enabled !== false,
            })),
        });
        // Keep the server's view of ids/updatedAt without disturbing what the
        // user is typing: only the bookkeeping fields are copied back.
        state.profile.updatedAt = saved.updatedAt;
        state.profile.textLength = saved.textLength;
    } catch (err) {
        displayError(err, { action: 'save your profile' });
    } finally {
        saving = false;
        syncStatus();
    }
}

/**
 * Flush a pending save immediately.
 *
 * Called when the view is navigated away from: the 300ms debounce is longer
 * than it takes to click the rail, and losing the last sentence you typed
 * because you switched pages would be the worst bug this page could have.
 */
export function flushProfileSave() {
    if (!saveTimeout) return;
    clearTimeout(saveTimeout);
    saveTimeout = null;
    save();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** One section's markup. Ids are data-attributes so delegation can find them. */
function sectionMarkup(section, index, limits) {
    const enabled = section.enabled !== false;
    const placeholder = (meta.sections[index] && meta.sections[index].placeholder)
        || 'Anything you want your personas to know.';
    return `
        <div class="profile-section${enabled ? '' : ' disabled'}" data-section-id="${escapeHtml(section.id)}">
            <div class="profile-section-head">
                <input type="text" class="profile-section-title" data-field="title"
                       maxlength="${limits.titleChars}" placeholder="Section title"
                       value="${escapeHtml(section.title || '')}" aria-label="Section title">
                <div class="profile-section-actions">
                    <label class="profile-section-toggle" title="${enabled ? 'Included in every chat' : 'Kept, but not sent to the model'}">
                        <input type="checkbox" data-field="enabled" ${enabled ? 'checked' : ''}>
                        <span>${enabled ? 'On' : 'Off'}</span>
                    </label>
                    <button type="button" class="profile-section-btn" data-action="up" title="Move up" aria-label="Move section up">↑</button>
                    <button type="button" class="profile-section-btn" data-action="down" title="Move down" aria-label="Move section down">↓</button>
                    <button type="button" class="profile-section-btn danger" data-action="delete" title="Delete section" aria-label="Delete section">×</button>
                </div>
            </div>
            <div class="textarea-resizable">
                <textarea class="profile-section-body" data-field="body" rows="4"
                          maxlength="${limits.bodyChars}"
                          placeholder="${escapeHtml(placeholder)}">${escapeHtml(section.body || '')}</textarea>
                <div class="textarea-resize-handle" aria-hidden="true" title="Drag to resize"></div>
            </div>
        </div>`;
}

/** Build the whole page. Only called when there is no DOM for this profile. */
function build() {
    const limits = meta.limits;
    const profile = state.profile;
    const accountName = (state.user && state.user.displayName) || '';

    elements.profileView.innerHTML = `
        <h1 class="settings-view-title">Profile</h1>
        <div class="settings-modal-body">
            <div class="settings-section">
                <p class="section-note">Synced to your account.</p>
                <p class="help-text profile-intro">
                    This is you, the way a persona is a character: whatever you write here is
                    what every persona knows about the person it is talking to.
                </p>

                <label for="profilePreferredName">
                    What should I call you?
                    <span class="field-counter" id="profileNameCount"></span>
                </label>
                <input type="text" id="profilePreferredName" maxlength="${limits.preferredNameChars}"
                       placeholder="${escapeHtml(accountName || 'Your name')}"
                       value="${escapeHtml(profile.preferredName || '')}">
                <p class="help-text">
                    The name your personas use for you.${accountName
                        ? ` Left empty, they fall back to your account name (${escapeHtml(accountName)}).`
                        : ''}
                </p>
            </div>

            <div class="settings-section">
                <h3>About you</h3>
                <p class="help-text">
                    Write as much or as little as you like. Sections are yours — rename them,
                    reorder them, add your own. Turn one <em>Off</em> to keep it without sending it.
                </p>
                <div id="profileSections"></div>
                <button type="button" class="section-secondary-btn" id="profileAddSection">+ Add section</button>
            </div>

            <div class="settings-section">
                <p class="profile-status" id="profileStatus"></p>
            </div>
        </div>`;

    renderSections();
    wire();
    built = true;
}

/** Repaint just the sections list (structural changes only — never on typing). */
function renderSections() {
    const host = document.getElementById('profileSections');
    if (!host) return;
    const sections = state.profile.sections || [];
    if (sections.length === 0) {
        host.innerHTML = `<p class="profile-empty">No sections yet. Add one to start describing yourself.</p>`;
        return;
    }
    host.innerHTML = sections.map((s, i) => sectionMarkup(s, i, meta.limits)).join('');
}

/** The saved / saving / size line under the form. */
function syncStatus() {
    const el = document.getElementById('profileStatus');
    if (!el) return;
    const chars = textLength(state.profile);
    const limits = meta ? meta.limits : FALLBACK_META.limits;
    const pending = saving || !!saveTimeout;
    // Rough, and labelled rough. The status bar's real token count comes from
    // the provider; this is only here to make "is my profile getting big"
    // answerable while typing.
    const tokens = Math.round(chars / 4);
    el.textContent = pending
        ? 'Saving…'
        : `Saved. ${chars.toLocaleString()} of ${limits.profileChars.toLocaleString()} characters (~${tokens.toLocaleString()} tokens), sent with every message.`;
    el.classList.toggle('pending', pending);

    const counter = document.getElementById('profileNameCount');
    if (counter) {
        const n = (state.profile.preferredName || '').length;
        counter.textContent = `${n}/${limits.preferredNameChars}`;
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Find the section object a DOM event happened inside. */
function sectionFor(target) {
    const host = target.closest('[data-section-id]');
    if (!host) return null;
    const id = host.dataset.sectionId;
    return (state.profile.sections || []).find((s) => s.id === id) || null;
}

/** Wire the page once. Delegation, so section nodes can come and go freely. */
function wire() {
    const root = elements.profileView;

    // Typing: mutate the model, save, and touch NOTHING else in the DOM. The
    // status line is the one exception, and it is not an ancestor of the input.
    root.addEventListener('input', (e) => {
        const t = e.target;
        if (t.id === 'profilePreferredName') {
            state.profile.preferredName = t.value;
            scheduleSave();
            return;
        }
        const section = sectionFor(t);
        if (!section) return;
        if (t.dataset.field === 'title') section.title = t.value;
        else if (t.dataset.field === 'body') section.body = t.value;
        else return;
        scheduleSave();
    });

    // The enabled toggle is a change, not an input.
    root.addEventListener('change', (e) => {
        const t = e.target;
        if (t.dataset.field !== 'enabled') return;
        const section = sectionFor(t);
        if (!section) return;
        section.enabled = t.checked;
        const host = t.closest('.profile-section');
        if (host) host.classList.toggle('disabled', !t.checked);
        const label = t.parentElement.querySelector('span');
        if (label) label.textContent = t.checked ? 'On' : 'Off';
        scheduleSave();
    });

    root.addEventListener('click', async (e) => {
        const addBtn = e.target.closest('#profileAddSection');
        if (addBtn) return addSection();

        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const section = sectionFor(btn);
        if (!section) return;
        const sections = state.profile.sections;
        const i = sections.indexOf(section);

        if (btn.dataset.action === 'delete') {
            const label = section.title ? `"${section.title}"` : 'this section';
            const ok = await confirmDialog({
                title: 'Delete section',
                body: `Delete ${label}? Anything written in it is lost.`,
                confirmLabel: 'Delete',
                danger: true,
            });
            if (!ok) return;
            sections.splice(i, 1);
        } else if (btn.dataset.action === 'up') {
            if (i <= 0) return;
            [sections[i - 1], sections[i]] = [sections[i], sections[i - 1]];
            focusSectionId = section.id;
        } else if (btn.dataset.action === 'down') {
            if (i < 0 || i >= sections.length - 1) return;
            [sections[i + 1], sections[i]] = [sections[i], sections[i + 1]];
            focusSectionId = section.id;
        }
        renderSections();
        restoreFocus(btn.dataset.action);
        scheduleSave();
    });
}

/**
 * Put focus back after a structural repaint.
 *
 * Reordering with the keyboard is unusable if focus is lost on every press —
 * the button you just hit has to still be under your finger for the second
 * press. So the moved section's matching button is re-focused by id.
 */
function restoreFocus(action) {
    if (!focusSectionId) return;
    const host = elements.profileView.querySelector(`[data-section-id="${CSS.escape(focusSectionId)}"]`);
    focusSectionId = null;
    if (!host) return;
    const btn = host.querySelector(`[data-action="${action}"]`);
    if (btn) btn.focus();
}

/** Add a section: seeded from the next unused suggestion, else untitled. */
function addSection() {
    const sections = state.profile.sections || (state.profile.sections = []);
    const limits = meta.limits;
    if (sections.length >= limits.sections) {
        showToast(`A profile can have at most ${limits.sections} sections.`, { type: 'warning' });
        return;
    }
    // Offer the suggestions in order, skipping any title already used, so the
    // second and third "Add section" keep teaching rather than repeating.
    const used = new Set(sections.map((s) => (s.title || '').toLowerCase()));
    const suggestion = meta.sections.find((s) => !used.has(s.title.toLowerCase()));

    const id = (crypto.randomUUID && crypto.randomUUID()) || `s${Date.now()}`;
    sections.push({ id, title: suggestion ? suggestion.title : '', body: '', enabled: true });
    renderSections();

    // Land the caret in the new section: an empty titled box is an invitation,
    // but only if the cursor is already in it.
    const host = elements.profileView.querySelector(`[data-section-id="${CSS.escape(id)}"]`);
    if (host) {
        const field = host.querySelector(suggestion ? '.profile-section-body' : '.profile-section-title');
        if (field) field.focus();
    }
    scheduleSave();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Render the Profile view. Called by the router when the section is active.
 *
 * Async because the first visit fetches; the router does not await it, so the
 * panel is briefly empty on a cold open. That is the same shape as every other
 * view that loads (and it is one request against localhost-or-better).
 */
export async function renderProfileView() {
    if (!elements.profileView) return;
    try {
        await ensureLoaded();
    } catch (err) {
        displayError(err, { action: 'load your profile' });
        elements.profileView.innerHTML =
            `<h1 class="settings-view-title">Profile</h1>
             <div class="settings-modal-body"><p class="help-text">Could not load your profile.</p></div>`;
        return;
    }
    if (!built) build();
    syncStatus();
}
