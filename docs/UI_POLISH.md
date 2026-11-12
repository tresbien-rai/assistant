# UI polish backlog

Things noticed in passing that are worth fixing but did not belong to the slice
that found them. Not a bug tracker — items here are cosmetic or copy-level, and
anything that breaks behaviour should be fixed where it is found instead.

---

## UIP-01 — Preset editor: the font changes mid-block

**Status:** done (2026-11-11). Raised 2026-09-16.

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

### Resolution (shipped 2026-11-11)

- `.settings-section .preset-block-text` now uses `var(--font-main)` at `var(--text-sm)` (`14px`), matching every other prose textarea in the app.
- `index.html` loads `JetBrains Mono` from Google Fonts and `--font-mono` resolves to `'JetBrains Mono', 'Fira Code', 'Consolas', monospace`.
- The **Solier** brand wordmark (`.login-title` and `.rail-brand` at the top of the section rail) is set in **Newsreader Italic** (`--font-brand: 'Newsreader', Georgia, serif`).
- Added a device-local **Font** picker (`Inter`, `Jakarta Sans`, `Newsreader`, `Source Serif`, `Atkinson`, `JetBrains Mono`, `System`) and **Font Scope** toggle (`Whole app` vs `Chat & prose only`) in Settings → Appearance (`UiPrefs.fontFamily` / `UiPrefs.fontScope`).


---

## UIP-02 — A wording pass over the whole UI

**Status:** done (2026-11-11). Raised 2026-09-16.

Copy has accumulated slice by slice, each written in the moment. Labels, help
text, placeholders and empty states have never been read end to end as one
voice, and several were written before the feature around them settled.

### Resolution (shipped 2026-11-11)

- **Persona section teaching placeholders & help text (`js/persona-sections.js`, `index.html`):** Rewrote the six section help lines and placeholders (`Personality`, `Voice`, `Expertise`, `Relationship`, `Background`, `General guidance`) so each example models concrete, drift-resistant character direction, and updated the section intro and `General guidance` help text to reflect the `PT-05` trait picker + prompt text drawers instead of referring to `"boxes"`.
- **Stale & inaccurate strings fixed (`index.html`, `js/chat/thread.js`):**
  - Updated the welcome empty states in `index.html` and `js/chat/thread.js` to point to **Models** (without the obsolete sidebar/hamburger reference) and escaped `assistantName`.
  - Updated the persona avatar upload note from `"Stored locally in your browser"` to `"PNG, JPG, GIF, or WebP up to 5 MB. Synced with this persona across your devices."`
  - Updated the File panel mode note in Settings → Appearance to reference the top-bar **Files** activity dot rather than the retired right-edge tab.
  - Removed the legacy hardcoded `[expression: happy]` paragraph from `#systemPrompt` in `index.html` and simplified `#messageInput`'s placeholder to `"Write a message…"`.
- **Profile, Trait Editor, Workspaces & Models copy (`js/views/profile.js`, `server/src/utils/userProfile.js`, `js/views/persona-traits-editor.js`, `js/views/workspaces.js`, `js/views/models.js`, `js/main.js`):**
  - Refined `SUGGESTED_SECTIONS` placeholders and Profile intro/delete confirmation.
  - Polished trait editor empty states, tooltips, workspace/project instruction placeholders (replacing `"injected into"` jargon), and toast/validation messages.
  - Unified form labels, headings, and modal controls to sentence case across Settings, Persona Editor, Expression Modal, and Add Model Modal.

---

## UIP-03 — Enriched navigation rail & active/recent chat context

**Status:** designed 2026-11-12, not built. Decisions below are locked; the
quill icon's drawing and colour are still open (see *Open*).

Since WR-07 moved all lists into the main area, `<aside class="sidebar">` holds
only 6 rail buttons (~248px tall) inside a `240px`–`640px` drag-resizable column
(~80% empty vertical space), and offers no direct way back to an open
conversation after visiting `Models`, `Personas`, `Profile`, or `Settings`
(clicking `Chats` opens the unfiled list instead, and a chat filed inside a
Workspace or Project does not appear in `Chats` at all). The **Solier**
wordmark at the top of the rail already shipped in UIP-01.

Scope: the side rail only. The top bar is UIP-04; the Chats page is UIP-08.

### How it was decided

Prototyped 2026-11-12 as a throwaway page with switchable variants
([Solier Rail Prototypes](https://claude.ai/artifact/QxjjBqj1rAUuhajGqjLmRQ),
private to the user; it now shows only the locked design). Three layouts were
compared: A *Stacked* (solid New chat button, sections, then Recent), B
*Recents first* (sections moved to the bottom), and C *Compact*. Four ways of
showing a chat's home were compared: hidden, a second line, grouped, and a
tree. The user picked C with Grouped; Grouped looked more organised and
instantly recognisable than Second line, its close rival. A design critique
of the result produced the changes in D6–D9; the user spotted the scrollbar (D10).

### Decisions

- **D1 — Layout (variant C, Compact).** Top to bottom: the wordmark with a
  New chat icon button on its right; the six sections (`Chats`, `Workspaces`,
  `Profile`, `Personas`, `Models`, `Settings`) as a compact list; a divider;
  then **Recent**, filling the rest of the rail and scrolling inside itself.
  Chosen by the user over A (recommended, closest to today) because it leaves
  the most room for recent chats and matches where current apps are heading.
- **D2 — Width: resizable, not fixed.** Default **220px**, drag-resizable
  between **200px** and **360px**; double-clicking the edge resets to 220.
  200px is the narrowest at which every section label still fits. The width
  stays device-local (`UiPrefs.sidebarWidth`, as today). This **reverses**
  the original "lock to a fixed width and remove the resizer": the user wants
  to keep the ability to size things to their liking. An icons-only collapse
  at narrow widths was considered and dropped by the user.
- **D3 — Recent shows chats from every home.** The 8 most recently active
  chats, whether unfiled or in a Workspace or Project. All conversations are
  already in `state.conversations`, so no server change is needed.
- **D4 — Recent is grouped by Workspace.** One header per Workspace, with the
  folder icon and the Workspace name. Under it, chats filed directly in the
  Workspace come first; then each Project appears as a muted **› Project
  name** label followed by its chats (no tree, no extra indent). Unfiled chats
  get their own **Unfiled** header with the chat-bubble icon, the same icon as
  the `Chats` section, which lists exactly those chats. Groups are ordered by
  their newest chat. Accepted trade-off: inside a Workspace, its direct chats
  come before its Projects' chats even when a Project chat is newer. The user
  proposed grouping a Workspace's Project chats under the Workspace header
  rather than giving each Project its own header.
- **D5 — Each row: persona avatar and title.** The full home shows as a
  tooltip. Long titles are cut off with an ellipsis.
- **D6 — The open chat** is marked with a 2px accent bar placed directly under
  the centre of its group's header icon (rows are indented to make room for
  it), plus a faint accent tint behind the row: about 10% accent on dark
  themes, 7% on light ones. Hover keeps the plain `--bg-tertiary` background,
  so a hovered row never looks like a second open chat (critique point,
  user asked for the tint to stay subtle). It stays marked while the user is
  on any section page, which is the point of the feature.
- **D7 — No "All chats" link.** It would have led to the Chats page, which
  lists only unfiled chats, so the label promised more than it gave; and the
  `Chats` section is right above it. Making the Chats page hold every chat is
  UIP-08.
- **D8 — Bigger targets.** On desktop, section rows are 36px tall and chat
  rows 34px. In the phone drawer, every tappable item (sections, chats, New
  chat, close) is 44px. The user asked for the desktop sizes after the
  critique raised phone targets: they mis-tap easily.
- **D9 — No Recent block when there are no chats.** The divider and Recent
  block show only while at least one chat exists. They disappear when the
  last chat is deleted and return with the next new chat.
- **D10 — The rail's scrollbar** is slim (8px), with no arrows, a track in the
  rail's own colour, and the themed `--scrollbar-thumb`, shown when the
  pointer is over the list. The app-wide 14px scrollbar (`styles/forms.css`)
  sits on `--bg-tertiary`, which read as a near-black strip in the narrow
  rail. The override is scoped to the Recent list.
- **D11 — Icons.**
  - **Profile and Personas swap icons.** Profile takes the single person;
    Personas takes a group. The old two-person drawing looked off-centre, and
    a first symmetric three-person drawing looked crowded, so Personas gets a
    redrawn, lighter, symmetric icon: one figure in front and two half-figures
    behind, drawn as open curves.
  - **Folder and chat bubble rebalanced.** The folder is bigger and fuller (a
    taller body, a wider tab and a line across the front); the bubble is about
    20% shorter, so it no longer looks larger than the folder. The same
    drawings are used in the section list and the Recent headers.
  - **New chat is a quill**, borderless and in the accent colour, to echo the
    handwritten feel of the wordmark. The user suggested a pen or quill
    instead of `+`.
- **D12 — Phone.** The drawer shows the same rail, Recent included. Tapping a
  chat opens it and closes the drawer.

### Open

- **The quill still looks "tacked on"** (user, 2026-11-12), possibly because
  of the accent colour. Build with the current drawing and revisit it once it
  can be seen in the real app; the user's reference for the feel was the
  "quill pen" icon on svgrepo (id 347320). Draw our own rather than copy it.

### Build notes

One slice, one PR. Keep the drag-resize in `js/sidebar.js` and change its
limits and default (today 240–640px, default 320px). The Recent list gets its
own module rather than growing `main.js`, and re-renders whenever the
conversation list or the active conversation changes.

---

## UIP-04 — Contextual top status bar & section header cleanup

**Status:** open, agreed 2026-11-11.

`renderTopBar` currently shows the Persona dropdown, Model dropdown, and
Floating Avatar toggle **only when not in a chat** (cluttering `Models`,
`Settings`, `Profile`, `Workspaces`), and hides the Persona indicator when in a
chat. Meanwhile `#avatarToggleBtn` uses the same user-silhouette icon as the
`Personas` rail item.

Agreed changes:
- **In a chat (`mainView.type === 'chat'`):** make the top bar chat-focused —
  show the Chat Title, Active Persona chip, and Workspace/Project breadcrumb on
  the left, and chat-scoped tools (`Tokens`, `Avatar PIP` with a distinct
  portrait-frame icon, and `Files`) on the right.
- **Outside a chat (browsing section pages):** keep section views (`Models`,
  `Settings`, `Profile`, `Personas`, `Workspaces`) free of redundant top-bar
  dropdowns on desktop (retaining only the mobile `☰` menu trigger on narrow
  screens), and place the "next chat" Persona/Model selector on the `Chats`
  list header alongside `+ New chat`.

---

## UIP-05 — Persona editor sub-tabs, live card preview & fixed-model picker

**Status:** open, agreed 2026-11-11.

`#personaEditView` stacks four re-parented sections (`Profile`, `Prompt preset`,
`Avatar`, `Expressions`) into one long vertical scroll, putting the live
WYSIWYG Persona Card preview at the bottom where it cannot be seen while editing
`Name` and `Tagline` at the top. In addition, selecting `Fixed` under Model
Settings pins whatever global model happens to be active with no inline picker
to choose which model to pin.

Agreed changes:
- Organise `#personaEditView` into a 3-tab strip (`Identity & Prompt` |
  `Avatar & Expressions` | `Defaults & Capabilities`) matching `Settings`.
- Keep the live WYSIWYG Persona Card preview visible alongside `Name`,
  `Tagline`, and `Avatar` so identity edits preview in real time.
- Add an inline model picker when `Fixed` model mode is selected so the pinned
  model can be chosen directly inside the Persona Editor.

---

## UIP-06 — Component UX, design system hygiene & accessibility

**Status:** open, agreed 2026-11-11.

Quick wins and structural CSS/DOM hygiene from the 2026-11-11 audit:
- **Workspace & Project auto-save:** auto-save container Name and Instructions
  (`#cpName`, `#cpInstructions` in `js/views/workspaces.js`) with debounce and
  flush-on-navigate, matching `Profile` and every other form in the app so
  unclicked `Save` edits are never silently lost.
- **Persona grid card actions:** surface visible `Chat` and `Edit` actions on
  `.persona-tile` cards (`js/views/personas.js`) instead of hiding both in the
  hover-only `⋯` menu.
- **Onboarding empty state:** when no API key is saved, provide a clickable
  action button that navigates directly to `Models` (`navigate({ type: 'models' })`).
- **Button system consolidation:** unify the 13+ competing button classes onto
  consistent token-driven primitives in `styles/buttons.css` and remove dead
  pre-WR-07 CSS selectors.
- **CSS & accessibility fixes:**
  - Fix undefined `var(--border)` → `var(--border-color)` on Markdown tables and
    `<hr>` dividers in `styles/chat.css`.
  - Replace all 21 `transition: all` declarations (including 4 inside
    `#modelModal` `.modal-overlay`) with explicit property lists.
  - Make clickable list rows/cards (`.conversation-info`, `.model-card-open`,
    `.ws-info`, `.project-info`, `.persona-tile`, `.cp-crumb`) keyboard-reachable
    and reveal hover-only `⋯` menus on `:focus-within` / `:focus-visible`.

---

## UIP-07 — Colour themes & light/dark surface polish

**Status:** open, agreed 2026-11-11.

Evaluate and refine Solier's 8 colour themes (`Midnight`, `Slate`, `Forest`,
`Ocean`, `Light`, `Parchment`, `Rosé`, `Custom`) in `styles/tokens.css`
and `js/ui-prefs.js`:
- Review the default theme and palette presets so the out-of-the-box visual
  world feels warm, cohesive, and aligned with Solier's identity.
- Fix hardcoded dark-mode colours that break `Light`, `Parchment`, and `Rosé`
  themes:
  - File revision diff colours (`.fp-diff-add`, `.fp-diff-del`, `.fp-add`,
    `.fp-del` in `styles/file-panel.css`) which currently use pale dark-mode
    tints (`#aff5b4`, `#ffdcd7`) that are illegible on light backgrounds.
  - Markdown table headers/striping and blockquotes (`rgba(0, 0, 0, 0.3)` in
    `styles/chat.css`) → replace with theme-aware surface tokens.
  - Hardcoded `#fff` / `white` on accent buttons → replace with
    `var(--on-accent)`.


---

## UIP-08 — The Chats page holds every chat

**Status:** open, agreed 2026-11-12. Not designed; prototype before building.

Found while designing UIP-03: a rail link to "All chats" would have led to the
Chats page, which lists only unfiled chats, grouped by persona. The user's
idea: give the Chats page the same treatment as the rail's Recent list, so it
becomes the place where every chat lives, organised by Workspace and Project.
New chats can be started there when the user doesn't need the Workspace or
Project pages.

This reverses the Workspace Restructure rule that the Chats tab shows only
unfiled chats (`docs/design/WORKSPACE_RESTRUCTURE.md`, Issue 1). That rule
exists because a Workspace chat opened from the Chats tab used to show the
wrong location in the UI. The new page is a *view* of every chat, and nothing
moves between homes, so it is allowed, provided that opening a chat from it
still sets the active Workspace and Project from the chat itself, as the rail
does. Open questions for the design: whether persona grouping survives (for
example, inside each group), how a long list stays scannable, and where New
chat sits.
