# In-App Confirm Dialogs — Plan

Replace every native `window.confirm()` in the frontend with an in-app dialog
matching Tessera's own visual language.

> **Status (2026-07-22):** CD-01 → CD-03 done. All 12 `confirm()` call sites now
> use `confirmDialog()`; no native `confirm()`/`alert()` remains in the frontend.
> CD-04 (the one surviving `prompt()`) is still open.

## Why this matters (the actual bug)

This isn't cosmetic. Chrome (and other browsers) show a **"prevent this page
from creating additional dialogs"** checkbox after a page opens several dialogs
in quick succession. Once a user ticks it, `window.confirm()` returns `false`
forever, for the rest of the page session.

Every confirm-gated action in Tessera then **silently does nothing**. No error,
no toast, no console warning — the button just stops working. This was hit for
real: an expression named `fds` "would not delete", and the delete path turned
out to be correct all along.

Because 12 destructive actions are gated this way, one stray checkbox disables
essentially all of them at once, and the failure is invisible.

Secondary reasons: native dialogs ignore the theme system entirely (jarring
against the seven presets + custom OKLCH palette), can't show rich content
(filenames, counts, consequences) with any styling, aren't keyboard-styleable,
and block the main thread.

## Call sites (12) — all converted

All in `app.js`. Every one now calls `confirmDialog()`; the `danger` column is
what each was given.

| Function | What it guards | danger |
|---|---|---|
| `clearStoredApiKey()` | Clearing the saved API key for a provider | yes |
| `deleteExpression()` | Deleting a persona expression | yes |
| `renderSavedModelsList()` | Removing a model from the catalog | yes |
| `deleteConversationPrompt()` | Deleting a chat | yes |
| `deletePersonaPrompt()` | Deleting a persona (+ its chats) | yes |
| `deleteProjectPrompt()` | Deleting a project | yes |
| `deleteWorkspacePrompt()` | Deleting a workspace | yes |
| `deleteContainerFilePrompt()` | Deleting a file (also removes it from Drive) | yes |
| `deleteMessage()` | Deleting a single message | yes |
| `FilePanel.restoreVersion()` | Restoring a file version over current content | no |
| `FilePanel.saveEdit()` | Overwriting the assistant's version on a save conflict | yes |
| `clearConversation()` | Clearing all messages in a conversation | yes |

`restoreVersion()` is the one non-danger site: it adds a new history entry
rather than destroying anything, so it gets the accent button and starts with
focus on Confirm.

Two corrections to the original survey: the `FilePanel` sites are
`restoreVersion()` and `saveEdit()` (not `selectVersion()`/`cancelEdit()`), and
`prompt()` **is** used — see CD-04.

Three sites needed more than a mechanical swap:

- `renderSavedModelsList()`'s delete handler had to become `async`, and it keeps
  the `if (ok) { ... }` shape rather than an early return because it sits inside
  a `forEach` callback.
- `deleteExpression()` and `deleteMessage()` now re-validate after awaiting.
  Confirming used to be synchronous; with an await in the middle, the
  module-level `editingExpression` and the active conversation can both move
  under the function before it acts.

## Design

### API

A promise-based helper, so call sites change shape as little as possible:

```js
// Returns Promise<boolean>
const ok = await confirmDialog({
  title: 'Delete workspace?',
  body: 'Deleting "Research" also deletes its 3 projects and 12 chats.',
  confirmLabel: 'Delete',
  cancelLabel: 'Cancel',
  danger: true,          // red confirm button for destructive actions
});
if (!ok) return;
```

Every existing site is already inside an `async` function except
`renderSavedModelsList()`'s inner handler, which is a click callback and can be
made `async` locally.

### Behaviour requirements

- **Focus trap** while open; focus returns to the triggering element on close.
- **Esc** cancels, **Enter** confirms, backdrop click cancels.
- Confirm button takes initial focus for non-destructive actions; **Cancel**
  takes it when `danger: true`, so a stray Enter can't destroy anything.
- `role="alertdialog"`, `aria-modal="true"`, labelled by the title element.
- Never stack: opening a second dialog while one is up should be impossible by
  construction (single shared instance, reject/queue rather than double-render).
- Scroll lock on the body while open.

### Implementation notes

- One shared markup block in `index.html` (mirroring the existing
  `.modal-overlay` / `.modal-content` pattern used by `#expressionModal`), plus
  a `confirmDialog()` function in `app.js` that fills it and returns a promise
  resolved by the button handlers.
- Reuse existing `.modal-*` classes so it inherits theme tokens for free; add a
  `.modal-btn.danger` variant if one doesn't already exist.
- Keep the copy from the current `confirm()` strings — it's already written and
  reasonably specific — but split it into title + body rather than one run-on
  sentence.

## Decisions made during CD-01

- **Danger button** is solid `--error` with a dark label. `--error` (`#ff6b6b`)
  is a light coral that is never overridden per theme, so white text on it fails
  contrast; a new `--on-error` token holds the dark label colour, mirroring the
  existing `--on-accent` convention.
- **Footer buttons are right-aligned** (`.modal-confirm .modal-footer` overrides
  the inherited `justify-content: space-between`), so the two choices read as a
  pair instead of sitting at opposite ends of a 400px box.
- **`.modal-btn.secondary:hover` is neutralised inside the dialog.** The global
  rule turns Cancel red on hover, which would make both buttons read as
  destructive on a delete prompt.
- **Title and body are set with `textContent`, never `innerHTML`.** They
  interpolate user-controlled names (personas, files, imported `.tessera`
  bundles). This costs the emphasised filename from the mockup — quotes carry it
  instead. Revisit only with an explicit escaping helper.
- **No Enter handler.** Focus starts on Cancel when `danger: true` and on Confirm
  otherwise; the browser's native button activation then gives exactly the
  behaviour the plan asked for.
- **No × in the header.** A confirm has exactly two exits.
- **`visibility` is kept out of this dialog's CSS transitions.** See below —
  without that, initial focus silently does nothing.

### The visibility/transition trap (fixed after first merge)

Initial focus did not work when PR #96 first landed: the dialog opened with
nothing focused, and Tab walked the page behind it instead of cycling the two
buttons.

`visibility` is an animatable property. On `hidden -> visible` the new value
only takes effect once the transition has progressed past 0 — i.e. a frame
later. `.modal-overlay` transitions `all 0.3s`, so synchronously after adding
`.visible` the dialog is still computed `visibility: hidden`, and **an element
with computed `visibility: hidden` cannot take focus**. The `.focus()` call was
a guaranteed no-op.

`.modal-btn` sets `transition: all 0.2s` of its own, so fixing only the overlay
is not enough — the buttons stay computed-hidden for that frame too. Both need
`visibility` excluded, which is why `styles.css` names explicit
`transition-property` lists for `#confirmModal` and `#confirmModal .modal-btn`
instead of inheriting `all`.

Because focus never landed, the Tab trap never engaged either: it was bound to
the dialog element, so with focus on `<body>` the keydown never reached it. It
is now bound to `document` in the **capture** phase while the dialog is open,
which also means Tab pulls focus *into* the dialog from anywhere, and Esc beats
the Esc handler of any modal underneath.

Worth remembering generally: any `.modal-*` element that needs focus on open has
this same trap waiting.

## Build order

1. **CD-01** — ✅ Done. `confirmDialog()` + markup + styles built;
   `deleteExpression()` converted and verified (cancel leaves the expression in
   place, confirm removes it locally and server-side).
2. **CD-02** — ✅ Done. Remaining 11 converted. Every site's cancel path was
   exercised against the running app and left state untouched; the confirm path
   was verified end-to-end (through to the server) for `deleteExpression()` and
   for the model-catalog handler, the one site keeping the `if (ok)` shape.
3. **CD-03** — ✅ Done. No `confirm(` / `alert(` remains in `app.js` or
   `index.html`; the only `prompt(` left is CD-04's. `CLAUDE.md` notes under
   Code Style that native dialogs are not used.
4. **CD-04** — Convert the one native `prompt()` left in `app.js`: the chat
   rename flow in `renameConversationPrompt()`. Same suppression bug, and
   `promptName()` (the name-only modal) already does this job and returns a
   promise. It needs one small addition first: `promptName()` always clears its
   input, so it has to grow a `value` option to prefill the current title, and
   its button label is hardcoded to "Create". The plan originally claimed
   `prompt()` was unused; that was wrong.

## Follow-ups outside this plan

Both of these are modal-chrome conventions that CD-01 had to override locally.
Rather than leaving the confirm dialog as the odd one out, settle them across
every modal — possibly alongside CD-04, which is already in that area.

- **Footer alignment.** CD-01 right-aligns the confirm dialog's footer only. The
  settings, expression, model, and name modals still use
  `justify-content: space-between`.
- **Secondary-button hover.** The global `.modal-btn.secondary:hover` turns the
  button's border and text red (`--error`). That reads as "destructive" on what
  is usually a Cancel or Close button, and CD-01 had to neutralise it inside the
  confirm dialog. Decide whether the red hover belongs anywhere, and if so give
  it its own class rather than attaching it to every secondary button.

## Out of scope

- Toasts (`showToast`) already exist and are fine; this plan doesn't touch them.
