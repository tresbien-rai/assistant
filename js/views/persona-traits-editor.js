/**
 * Persona trait editor (PT-05)
 *
 * The trait half of each persona section in the persona editor: the picked
 * traits as tags, "+ Add trait" opening a searchable picker, and the section's
 * Prompt text, the trait sentences exactly as they will be assembled, which you
 * click to edit. The section's own textarea (`persona.sections`) sits under
 * the Prompt text and is still owned by views/personas.js.
 *
 * Design: docs/design/PERSONA_TRAITS_DESIGN.md D9 (the layout the user chose in
 * PT-03) and D3 as amended there (editing a sentence is what customises it).
 * Reference prototype: docs/design/prototypes/persona-trait-picker.html.
 *
 * DATA
 *
 * Edits go straight onto the persona object in `state` (`persona.traits`) and
 * then through the normal debounced auto-save, which sends `traits` with every
 * persona field (settings-store.js). Every write first normalizes the
 * section's picks through `resolveTraits`, so the stored list is always the
 * one the prompt is built from: no duplicates, one option per pick-one scale.
 *
 * RE-RENDERING
 *
 * The tags and Prompt text are rebuilt on every change; they hold no caret.
 * The one exception is a sentence being edited: a repaint while its textarea
 * has focus skips that section, the same insurance the section textareas get.
 */

import { state } from '../state.js';
import { escapeHtml } from '../util/format.js';
import { autoSaveSettings } from '../settings-store.js';
import { PERSONA_SECTIONS } from '../persona-sections.js';
import { TRAIT_SECTION_IDS, resolveTraits, pickerGroups, findTrait } from '../persona-traits.js';

/** The persona the editor is showing. */
let persona = null;
/** The sentence open for editing: `{ sec, id }`, or null. */
let editing = null;
/** The open picker: `{ sec, el, opener }`, or null. */
let sheet = null;
/** The editor's host element, once wired. */
let host = null;
/** True between a pointer press and its release, anywhere on the page. */
let pointerDown = false;

/**
 * Follow the persona to the object `state` holds now. Re-hydrating personas
 * replaces their objects, and an edit made to the old one would never be saved.
 */
function refreshPersona() {
    if (persona && state.personas[persona.id]) persona = state.personas[persona.id];
}

/**
 * Run `fn` once the pointer press in progress (if any) has produced its click.
 * Repainting between a press and its release replaces the node under the
 * pointer, and the browser then sends the click nowhere.
 */
function afterPointer(fn) {
    if (!pointerDown) return fn();
    document.addEventListener('pointerup', () => setTimeout(fn, 0), { once: true, capture: true });
}

const keyOf = (sec, id) => `${sec}:${id}`;
const sectionLabel = (sec) => (PERSONA_SECTIONS.find((s) => s.id === sec) || {}).label || sec;

// ===== Data =====

/** The section's picks as they should be stored: normalized, in pick order. */
function normalizedPicks(sec) {
    return resolveTraits(persona, sec).map((t) => (t.customised ? { id: t.id, text: t.text } : { id: t.id }));
}

/** Replace a section's picks, save, and repaint the section. */
function setPicks(sec, picks) {
    const traits = { ...(persona.traits || {}) };
    if (picks.length) traits[sec] = picks;
    else delete traits[sec];
    persona.traits = traits;
    autoSaveSettings();
    renderSection(sec);
    if (sheet && sheet.sec === sec) renderSheetList();
}

/** Pick or unpick a trait. Picking a scale option replaces the scale's other option. */
function toggle(sec, id) {
    let picks = normalizedPicks(sec);
    if (picks.some((p) => p.id === id)) {
        picks = picks.filter((p) => p.id !== id);
        if (editing && editing.sec === sec && editing.id === id) editing = null;
    } else {
        const found = findTrait(sec, id);
        if (!found) return;
        if (found.group.kind === 'scale') {
            const sameScale = new Set(found.group.traits.map((t) => t.id));
            picks = picks.filter((p) => !sameScale.has(p.id));
        }
        picks.push({ id });
    }
    setPicks(sec, picks);
}

function resetText(sec, id) {
    setPicks(sec, normalizedPicks(sec).map((p) => (p.id === id ? { id } : p)));
}

/**
 * Close the open sentence editor, tidying what it left behind: text edited back
 * to the library's wording, or emptied, follows the library again. An unknown
 * trait has no library wording, so emptying it removes the pick.
 */
function finishEdit({ render = true } = {}) {
    if (!editing) return;
    const { sec, id } = editing;
    editing = null;
    const picks = (persona.traits && persona.traits[sec]) || [];
    const pick = picks.find((p) => p.id === id);
    const found = findTrait(sec, id);
    if (pick && typeof pick.text === 'string') {
        const text = pick.text.trim();
        if (!text && !found) {
            setPicks(sec, normalizedPicks(sec).filter((p) => p.id !== id));
            return;
        }
        if (!text || (found && text === found.trait.text)) delete pick.text;
        else pick.text = text;
        autoSaveSettings();
    }
    if (render) renderSection(sec);
}

// ===== Rendering =====

function tagsHTML(sec, traits) {
    const tags = traits.map((t) => {
        const unknown = !t.known && !t.customised;
        const cls = ['trait-tag', t.customised && 'is-customised', unknown && 'is-unknown'].filter(Boolean).join(' ');
        const label = unknown ? `${t.label} (no longer available)` : t.label;
        const title = unknown ? 'This trait was removed from the library. It is left out of the prompt.'
            : `${t.customised ? 'Customised. ' : ''}Edit its sentence`;
        return `<span class="${cls}" data-trait-key="${escapeHtml(keyOf(sec, t.id))}">`
            + `<button type="button" class="trait-tag-label" data-trait-action="edit" data-sec="${sec}" data-id="${escapeHtml(t.id)}"`
            + ` title="${escapeHtml(title)}"${unknown ? ' disabled' : ''}>${escapeHtml(label)}${t.customised ? ' <span aria-hidden="true">✎</span>' : ''}</button>`
            + `<button type="button" class="trait-tag-remove" data-trait-action="remove" data-sec="${sec}" data-id="${escapeHtml(t.id)}"`
            + ` aria-label="Remove ${escapeHtml(t.label)}">×</button></span>`;
    }).join('');
    return `${tags}<button type="button" class="trait-add" data-trait-action="add" data-sec="${sec}"${persona ? '' : ' disabled'}>+ Add trait</button>`;
}

function textHTML(sec, traits) {
    const chunks = [];
    let run = [];
    const flush = () => {
        if (run.length) chunks.push(`<p class="trait-paragraph">${run.join(' ')}</p>`);
        run = [];
    };
    for (const t of traits) {
        if (!t.text) continue;
        const key = keyOf(sec, t.id);
        if (editing && editing.sec === sec && editing.id === t.id) {
            flush();
            const pick = ((persona.traits || {})[sec] || []).find((p) => p.id === t.id);
            const value = pick && typeof pick.text === 'string' ? pick.text : t.text;
            chunks.push(`<div class="trait-edit" data-trait-key="${escapeHtml(key)}">
                <textarea class="trait-edit-field" rows="2" data-sec="${sec}" data-id="${escapeHtml(t.id)}"
                          aria-label="${escapeHtml(t.label)} sentence">${escapeHtml(value)}</textarea>
                <div class="trait-edit-bar">${editBarHTML(sec, t.id, value)}</div>
            </div>`);
            continue;
        }
        run.push(`<span class="trait-sentence${t.customised ? ' is-customised' : ''}" role="button" tabindex="0"`
            + ` data-trait-action="edit" data-sec="${sec}" data-id="${escapeHtml(t.id)}" data-trait-key="${escapeHtml(key)}"`
            + ` title="${escapeHtml(t.label)}${t.customised ? ' (customised)' : ''}: click to edit">${escapeHtml(t.text)}</span>`);
    }
    flush();
    return chunks.join('') || '<p class="trait-text-empty">No traits picked. Add some, write your own below, or both.</p>';
}

/** The status line under an open sentence: library text or customised, plus Reset and Done. */
function editBarHTML(sec, id, value) {
    const found = findTrait(sec, id);
    const customised = !found || value.trim() !== found.trait.text;
    const label = found ? found.trait.label : id;
    return `<span class="trait-edit-state">${escapeHtml(label)} · ${customised ? '<span class="is-customised">customised</span>' : 'library text'}</span>`
        + (customised && found ? `<button type="button" class="trait-link-btn" data-trait-action="reset" data-sec="${sec}" data-id="${escapeHtml(id)}">Reset to default</button>` : '')
        + `<button type="button" class="trait-link-btn" data-trait-action="done">Done</button>`;
}

/** Repaint one section's tags and Prompt text. */
function renderSection(sec) {
    if (!host) return;
    const tagsEl = host.querySelector(`[data-trait-tags="${sec}"]`);
    const textEl = host.querySelector(`[data-trait-text="${sec}"]`);
    if (!tagsEl || !textEl) return;
    const traits = persona ? resolveTraits(persona, sec) : [];
    tagsEl.innerHTML = tagsHTML(sec, traits);
    textEl.innerHTML = textHTML(sec, traits);
    const field = textEl.querySelector('.trait-edit-field');
    if (field && document.activeElement !== field) {
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
    }
}

/**
 * Show a persona's traits in the editor. Called on every editor repaint.
 * A different persona closes any open picker or sentence editor first.
 * @param {Object|null} p
 */
export function syncTraitEditors(p) {
    if (!host) return;
    if (!p || !persona || p.id !== persona.id) {
        editing = null;
        closeSheet({ restoreFocus: false });
    }
    persona = p || null;
    for (const sec of TRAIT_SECTION_IDS) {
        const open = host.querySelector(`[data-trait-text="${sec}"] .trait-edit-field`);
        if (open && open === document.activeElement) continue;
        renderSection(sec);
    }
}

// ===== The picker =====

function openSheet(sec, opener) {
    finishEdit();
    closeSheet({ restoreFocus: false });
    const count = pickerGroups(sec).reduce((n, g) => n + g.traits.length, 0);
    const el = document.createElement('div');
    el.className = 'trait-sheet-backdrop';
    el.innerHTML = `
        <div class="trait-sheet" role="dialog" aria-modal="true" aria-labelledby="traitSheetTitle">
            <div class="trait-sheet-head">
                <div class="trait-sheet-title-row">
                    <h3 id="traitSheetTitle">Add to ${escapeHtml(sectionLabel(sec))}</h3>
                    <button type="button" class="trait-sheet-close" data-trait-action="close" aria-label="Close">×</button>
                </div>
                <input type="search" class="trait-sheet-search" placeholder="Search ${count} traits…" aria-label="Search traits">
            </div>
            <div class="trait-sheet-list"></div>
            <div class="trait-sheet-foot">
                <button type="button" class="modal-btn primary" data-trait-action="close">Done</button>
            </div>
        </div>`;
    document.body.appendChild(el);
    sheet = { sec, el, opener, query: '', onKey: sheetKeydown };
    // On the document, not the sheet: focus can be outside it (Safari does
    // not focus a clicked button), and Escape and the Tab trap must still work.
    document.addEventListener('keydown', sheetKeydown, true);

    el.addEventListener('click', (e) => {
        if (e.target === el) return closeSheet();
        const btn = e.target.closest('[data-trait-action]');
        if (!btn) return;
        if (btn.dataset.traitAction === 'close') closeSheet();
        else if (btn.dataset.traitAction === 'toggle') {
            refreshPersona();
            toggle(btn.dataset.sec, btn.dataset.id);
        }
    });
    el.addEventListener('input', (e) => {
        if (!e.target.classList.contains('trait-sheet-search')) return;
        sheet.query = e.target.value;
        renderSheetList();
    });
    renderSheetList();
    el.querySelector('.trait-sheet-search').focus();
}

function renderSheetList() {
    if (!sheet) return;
    const list = sheet.el.querySelector('.trait-sheet-list');
    const q = sheet.query.trim().toLowerCase();
    const picked = new Set(resolveTraits(persona, sheet.sec).map((t) => t.id));
    let html = '';
    for (const g of pickerGroups(sheet.sec)) {
        const shown = g.traits.filter((t) => !q || g.name.toLowerCase().includes(q)
            || t.label.toLowerCase().includes(q) || t.text.toLowerCase().includes(q));
        if (!shown.length) continue;
        const scale = g.kind === 'scale';
        html += `<div class="trait-group" role="group" aria-label="${escapeHtml(g.name)}">
            <div class="trait-group-name">${escapeHtml(g.name)}${scale ? ' <span class="trait-group-kind">· pick one</span>' : ''}</div>`
            + shown.map((t) => {
                const on = picked.has(t.id);
                return `<button type="button" class="trait-option${scale ? ' is-radio' : ''}${on ? ' is-on' : ''}" aria-pressed="${on}"
                        data-trait-action="toggle" data-sec="${sheet.sec}" data-id="${escapeHtml(t.id)}">
                    <span class="trait-option-check" aria-hidden="true">${on ? '✓' : ''}</span>
                    <span class="trait-option-body"><span class="trait-option-label">${escapeHtml(t.label)}</span>
                    <span class="trait-option-text">${escapeHtml(t.text)}</span></span>
                </button>`;
            }).join('') + '</div>';
    }
    const top = list.scrollTop;
    list.innerHTML = html || '<p class="trait-text-empty">No trait matches. Write it in your own words instead.</p>';
    list.scrollTop = top;
}

/** Escape closes the picker; Tab cycles within it, as a modal dialog should. */
function sheetKeydown(e) {
    if (!sheet) return;
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeSheet();
        return;
    }
    if (e.key !== 'Tab') return;
    const focusable = [...sheet.el.querySelectorAll('button, input')];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const inside = sheet.el.contains(document.activeElement);
    if (!inside || (e.shiftKey && document.activeElement === first)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
}

function closeSheet({ restoreFocus = true } = {}) {
    if (!sheet) return;
    const { el, sec, opener, onKey } = sheet;
    sheet = null;
    document.removeEventListener('keydown', onKey, true);
    el.remove();
    if (restoreFocus) {
        // The opener was repainted while the picker was open; focus its successor.
        const add = host && host.querySelector(`[data-trait-action="add"][data-sec="${sec}"]`);
        (add || opener)?.focus();
    }
}

// ===== Wiring =====

/**
 * Wire the editor's events onto the section host, once.
 * @param {HTMLElement} el - the element holding every section's
 *   `[data-trait-tags]` and `[data-trait-text]` containers
 */
export function wireTraitEditor(el) {
    if (host) return;
    host = el;

    host.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-trait-action]');
        if (!btn || !persona) return;
        refreshPersona();
        const { sec, id } = btn.dataset;
        // A click outside the open sentence closes it first. The focusout below
        // does the same, but a quick click can arrive before it runs.
        const inEditor = !!btn.closest('.trait-edit');
        const prev = editing && !inEditor ? { ...editing } : null;
        if (prev) finishEdit({ render: false });
        switch (btn.dataset.traitAction) {
            case 'add': openSheet(sec, btn); break;
            case 'remove': toggle(sec, id); break;
            case 'reset': editing = null; resetText(sec, id); break;
            case 'done': finishEdit(); break;
            case 'edit':
                // Clicking the open sentence's own tag just closes it.
                if (!prev || prev.sec !== sec || prev.id !== id) startEdit(sec, id);
                break;
        }
        if (prev && !(editing && editing.sec === prev.sec)) renderSection(prev.sec);
    });

    // The bar's buttons must not take focus from the textarea: losing it would
    // close the editor (below) before the click lands. Safari never focuses a
    // clicked button at all, so this is the only way to get the same behaviour
    // everywhere.
    host.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.trait-edit-bar button')) e.preventDefault();
    });

    host.addEventListener('input', (e) => {
        if (!e.target.classList.contains('trait-edit-field')) return;
        const { sec, id } = e.target.dataset;
        refreshPersona();
        const pick = ((persona.traits || {})[sec] || []).find((p) => p.id === id);
        if (!pick) return;
        pick.text = e.target.value;
        e.target.closest('.trait-edit').querySelector('.trait-edit-bar').innerHTML = editBarHTML(sec, id, e.target.value);
        autoSaveSettings();
    });

    host.addEventListener('keydown', (e) => {
        if (e.target.classList.contains('trait-sentence') && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            e.target.click();
        } else if (e.target.classList.contains('trait-edit-field') && (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey))) {
            e.preventDefault();
            e.stopPropagation();
            const { sec, id } = e.target.dataset;
            finishEdit();
            host.querySelector(`.trait-sentence[data-trait-key="${CSS.escape(keyOf(sec, id))}"]`)?.focus();
        }
    });

    host.addEventListener('focusout', (e) => {
        if (!e.target.classList.contains('trait-edit-field')) return;
        // After the focus has landed: still inside the editor means a bar button.
        setTimeout(() => {
            const box = host.querySelector('.trait-edit');
            if (!editing || (box && box.contains(document.activeElement))) return;
            // Close it now, but repaint only after any click that caused this
            // has landed, so clicking a tag's × or another sentence works first
            // time. A click that acts repaints by itself; this covers the rest.
            const { sec } = editing;
            finishEdit({ render: false });
            afterPointer(() => { if (!editing || editing.sec !== sec) renderSection(sec); });
        }, 0);
    });

    document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
    for (const type of ['pointerup', 'pointercancel']) {
        document.addEventListener(type, () => { pointerDown = false; }, true);
    }

    // Hovering a tag lights up its sentence, and the other way round.
    let hovered = null;
    host.addEventListener('mouseover', (e) => {
        const key = e.target.closest('[data-trait-key]')?.dataset.traitKey || null;
        if (key === hovered) return;
        hovered = key;
        host.querySelectorAll('.is-linked').forEach((n) => n.classList.remove('is-linked'));
        if (key) host.querySelectorAll(`[data-trait-key="${CSS.escape(key)}"]`).forEach((n) => n.classList.add('is-linked'));
    });
}

function startEdit(sec, id) {
    // Normalize first, so the entry being typed into is the stored one.
    const picks = normalizedPicks(sec);
    if (!picks.some((p) => p.id === id)) return;
    persona.traits = { ...(persona.traits || {}), [sec]: picks };
    editing = { sec, id };
    renderSection(sec);
}
