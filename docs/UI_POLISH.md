# UI polish backlog

Things noticed in passing that are worth fixing but did not belong to the slice
that found them. Not a bug tracker — items here are cosmetic or copy-level, and
anything that breaks behaviour should be fixed where it is found instead.

---

## P-01 — Preset editor: the font changes mid-block

**Status:** open. Raised 2026-09-16.

Reading a preset block top to bottom, the typeface changes partway down. The
block's description and conditional note render in Inter at 12px; the editable
text box directly beneath them renders in monospace. So the moment you click in
to write, you are typing in a different font from every other field in the app.

Measured in the running app (`.preset-block-text` vs `.preset-block-desc`):

| | font-family | size |
|---|---|---|
| block description | Inter | 12px |
| block text box (and its placeholder) | Fira Code → Consolas → monospace | 12px |
| every other textarea in the app | Inter | 14px |

The rule is `styles/forms.css`, `.settings-section .preset-block-text`, which
sets `font-family: var(--font-mono)` and `font-size: var(--text-xs)`.

Worth noting what is **not** the problem, since it is the obvious suspect: the
placeholder and the typed value have identical computed styles. The built-in
prompt is shown as the textarea's `placeholder` attribute, so empty and filled
states use the same font. The jump is between the *prose around the box* and the
*box*, not between two states of the box.

There is a defensible reason the box is monospace — prompt text is whitespace-
sensitive and the block's content is arguably code-like. But it is the only
monospace field in the app, and it is two points smaller than every other field,
which reads as an accident rather than a decision.

### A second, quieter problem

`--font-mono` is `'Fira Code', 'Consolas', monospace`, but **Fira Code is never
loaded**. `index.html` fetches only Inter from Google Fonts. So the editor
renders in whatever the visitor happens to have installed — Consolas on Windows,
something else on macOS, a generic monospace on Linux. The app looks different
on different machines in exactly one place, and nobody chose that.

Either load the font or stop naming it.

### Extension — a font option

Agreed alongside the fix: offer a small set of base fonts the user can choose
from, as a device-local appearance preference (the `UiPrefs` / Appearance tab
family, beside theme and chat width). That turns the question above from "which
font do we impose" into "which font do you want", and gives `--font-main` and
`--font-mono` somewhere legitimate to come from.

Scope it deliberately: a handful of well-chosen faces that are actually loaded,
not a free-text field.

---

## P-02 — A wording pass over the whole UI

**Status:** open, expected. Raised 2026-09-16.

Copy has accumulated slice by slice, each written in the moment. Labels, help
text, placeholders and empty states have never been read end to end as one
voice, and several were written before the feature around them settled.

Known specifics so far:

- The persona section placeholders (`js/persona-sections.js`) are first-pass and
  are the highest-leverage copy in the app: for a segmented persona editor, the
  example in the box teaches far more than the label above it.
- `Speech` was renamed to `Voice` during PS-02 for exactly this reason — the
  label should say what the user is being asked for, not what the field is
  technically about.

Do this as one deliberate pass rather than incrementally, so the result reads as
one voice.
