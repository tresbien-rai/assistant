# In-App Confirm Dialogs — Plan

Replace every native `window.confirm()` in the frontend with an in-app dialog
matching Tessera's own visual language.

> **Status (2026-07-22):** CD-01 done — `confirmDialog()` built and
> `deleteExpression()` converted. CD-02 (remaining 11 sites) and CD-03 next.

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

## Call sites (12)

All in `app.js`. Line numbers are from commit `91a5565` and will drift — search
by function name.

| Function | What it guards |
|---|---|
| `clearStoredApiKey()` | Clearing the saved API key for a provider |
| `deleteExpression()` | Deleting a persona expression |
| `renderSavedModelsList()` | Removing a model from the catalog |
| `deleteConversationPrompt()` | Deleting a chat |
| `deletePersonaPrompt()` | Deleting a persona (+ its chats) |
| `deleteProjectPrompt()` | Deleting a project |
| `deleteWorkspacePrompt()` | Deleting a workspace |
| `deleteContainerFilePrompt()` | Deleting a file (also removes it from Drive) |
| `deleteMessage()` | Deleting a single message |
| `FilePanel.selectVersion()` | Restoring a file version over current content |
| `FilePanel.cancelEdit()` | Discarding edits when there's a save conflict |
| `clearConversation()` | Clearing all messages in a conversation |

Note the shapes differ: some are `if (confirm(...)) { ... }`, others
`if (!confirm(...)) return;`. Two live on class methods (`FilePanel`), the rest
are free functions. `alert()`/`prompt()` are not used anywhere.

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

## Build order

1. **CD-01** — ✅ Done. `confirmDialog()` + markup + styles built;
   `deleteExpression()` converted and verified (cancel leaves the expression in
   place, confirm removes it locally and server-side).
2. **CD-02** — Convert the remaining 11. Mechanical once CD-01 lands; a good
   candidate for delegation to the `mechanic` sub-agent, given a list of exact
   call sites and the new API.
3. **CD-03** — Grep to confirm zero remaining `confirm(` / `alert(` / `prompt(`
   in `app.js`, and add a short note to `CLAUDE.md` under Code Style saying
   native dialogs are not used.

4. **CD-04** — Convert the one native `prompt()` left in `app.js`: the chat
   rename flow in `renameConversationPrompt()`. Same suppression bug, and
   `promptName()` (the name-only modal) already does this job and returns a
   promise. It needs one small addition first: `promptName()` always clears its
   input, so it has to grow a `value` option to prefill the current title, and
   its button label is hardcoded to "Create". The plan originally claimed
   `prompt()` was unused; that was wrong.

## Follow-ups outside this plan

- **Footer alignment across the other modals.** CD-01 right-aligns the confirm
  dialog's footer only. The settings, expression, model, and name modals still
  use `justify-content: space-between`. Worth a pass to settle on one
  convention rather than leaving the confirm dialog as the odd one out.

## Out of scope

- Toasts (`showToast`) already exist and are fine; this plan doesn't touch them.
