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

**Status:** done (2026-11-12). Raised 2026-09-16; finalised & shipped 2026-11-12.

Since WR-07 moved all lists into the main area, `<aside class="sidebar">` holds
only 6 rail buttons (~248px tall) inside a `240px`–`640px` drag-resizable column
(~80% empty vertical space), and offers no direct way back to an open
conversation after visiting `Models`, `Personas`, `Profile`, or `Settings`
(clicking `Chats` opens the unfiled list instead, and a chat filed inside a
Workspace or Project does not appear in `Chats` at all). The **Solier**
wordmark at the top of the rail already shipped in UIP-01.

Scope: the side rail only. The top bar is UIP-04; the Chats page is UIP-08.

### How it was decided

Prototyped iteratively (v1–v6 HTML mockups). Layouts A (*Stacked*), B (*Recents
first*), and C (*Compact*) were compared, along with flat vs grouped Recent
lists and custom icon drafts (quill pen variants, open folder tab proportions,
and personas deck/silhouette variants). The user locked the v6 design on
2026-11-12.

### Decisions

- **D1 — Layout (variant C, Compact, with split footer).** Top to bottom:
  1. Compact header: the **Solier** wordmark (`Newsreader` Italic) with a 25px
     accent quill **New chat** button on its right (and `×` beside it on mobile).
  2. Top 4 sections (`Chats`, `Workspaces`, `Personas`, `Models`).
  3. Divider + **Recent** heading, filling the middle space and scrolling
     inside itself.
  4. Separated bottom footer anchored above the bottom edge: `Profile` and
     `Settings`.
- **D2 — Width: resizable, not fixed.** Default **220px**, drag-resizable
  between **200px** and **360px**; double-clicking the edge resets to 220.
  The desktop seam uses a single `1px` hairline on `#sidebarResizeHandle` that
  highlights to `3px` `--accent` on hover/drag (no double border). The width
  stays device-local (`UiPrefs.sidebarWidth`).
- **D3 — Recent shows chats from every home, and always keeps the open chat.**
  Shows the 8 most recently active chats across Unfiled, Workspaces, and
  Projects. If the currently open conversation (`state.activeConversationId`)
  falls outside the top 8, it is still kept in the 8-item list so navigating to
  `Models`/`Settings`/`Profile` never loses the way back to the active chat.
- **D4 — Recent style: Grouped (default) or Flat list (`UiPrefs.recentStyle`).**
  User preference in Settings → Appearance:
  - **Grouped by workspace (default):** One header per Workspace (`Open folder`
    icon + Workspace name). Direct Workspace chats come first, followed by muted
    `› Project name` subheaders and their chats. Unfiled chats get an
    **Unfiled** header with the chat-bubble icon. Groups sort by newest chat.
  - **Flat list:** Strict chronological list with a muted second line showing
    `Workspace › Project` (or `Unfiled`).
- **D5 — Each row: persona avatar and title.** Uses `personaAvatarHTML` (image
  or emoji) beside the ellipsis-truncated chat title; full title + home path
  show on hover (`title`).
- **D6 — The open chat** is marked with a 2px accent bar placed directly under
  the centre of its group's header icon (`left: 16px` under the `14px` icon at
  `10px`; `left: 4px` in Flat mode), plus a faint accent tint behind the row
  (~10% accent on dark themes, ~7% on light themes via `color-mix`). Hover keeps
  the plain `--bg-tertiary` background, so a hovered row never looks like a
  second open chat. Stays marked across all section views.
- **D7 — No "All chats" link.** Making the Chats page hold every chat is UIP-08.
- **D8 — Bigger targets.** On desktop, section rows are 36px tall and chat
  rows ≥34px. In the phone drawer (`< 768px`), every tappable item (sections,
  chats, New chat, close) is ≥44px.
- **D9 — No Recent block when there are no chats.** The divider and Recent
  block stay hidden while zero chats exist and return with the next new chat.
- **D10 — The rail's scrollbar** is slim (8px), arrow-less, with a track in
  `--bg-secondary` and `--scrollbar-thumb` revealed on hover, scoped to
  `.rail-recent-scroll`.
- **D11 — Icons.**
  - **Profile and Personas:** Profile takes a single-person outline (a future
    post-polish pass will allow a user-uploaded profile avatar to replace this
    icon); Personas takes the **Wider card carousel** (`13px` character card
    flanked by deck lines on each side).
  - **Workspaces:** **Open folder with bigger tab** (`24×24`, no background
    rect), shared by the `Workspaces` nav item and Workspace Recent headers.
  - **Chats:** Compact chat bubble (~20% shorter), shared with the `Unfiled`
    Recent header.
  - **New chat:** `25px × 25px` **G5 low-notch squiggle** quill path in
    `--accent`.
- **D12 — Phone.** The drawer shows the same rail, Recent included. Tapping a
  chat opens it and closes the drawer.

### Build notes

One slice, one PR. Keep the drag-resize in `js/sidebar.js` and change its
limits (200–360px) and default (220px). Recent lives in `js/rail-recent.js`
and re-renders whenever the conversation list, active conversation, workspace,
or persona avatar changes.

---

## UIP-04 — Contextual top status bar & section header cleanup

**Status:** shipped (2026-11-12; decisions locked from `uip04_topbar_mockup_v2.html`).

`renderTopBar` previously showed the Persona dropdown, Model dropdown, and
Floating Avatar toggle **only when not in a chat** (cluttering `Models`,
`Settings`, `Profile`, `Workspaces`), and hid the Persona indicator when in a
chat. Meanwhile `#avatarToggleBtn` reused the single-person outline icon now
claimed by `Profile` in the rail footer.

Locked decisions (signed off from `uip04_topbar_mockup_v2.html`):
- **D1 — Stacked Title + Meta in chats (`mainView.type === 'chat'`):** `.status-bar`
  shows only inside chats (`hidden` outside chats). Left side holds the active
  persona avatar (`30px` / `26px` on mobile, opens Persona popover), **Chat Title**
  (clickable to rename), and a meta line below (`Persona Name · Workspace › Project`
  or `Chats (unfiled)`, each segment clickable). Right side holds chat-scoped tools:
  `View request` (dev mode only), **Avatar PIP**, and **Files** (with activity dot /
  muted non-loaded count).
- **D2 — Distinct Avatar PIP icon:** `#avatarToggleBtn` uses a `22px` centered
  framed-portrait icon with a broken top-right corner gap and 4-point sparkle,
  clearly distinct from the rail footer `Profile` icon.
- **D3 — Usage counter moved near the composer:** Remove `.status-center` from the
  top bar so long chat titles never collide. Place `#statusTokensBtn` in a quiet
  `.composer-footer` row directly beneath `.composer-field` formatted as
  `Usage: <count>` (alongside the synced Enter/Shift+Enter hint on desktop, visible
  on mobile too). Clicking opens the breakdown modal titled **Token Usage (This chat)**.
- **D4 — Clean non-chat section headers (no duplicate mobile title):** Outside chats,
  desktop hides `.status-bar` completely (`>= 768px`). On mobile (`< 768px`), each
  section header (`.section-head`, `.models-head`) and sub-page back row embeds an
  inline `☰` drawer button directly beside the page `<h1>` / back crumb rather than
  rendering a separate mobile top bar that duplicates the title.
- **D5 — `Chats` page "next chat" controls & Quill `New chat` button:** Row 1 holds
  `Chats` + a primary `New chat` button carrying the `G5 low-notch squiggle` quill
  icon. Row 2 holds a `.chats-next-strip` utility bar (`Next chat starts with` +
  Persona & Model selector pills) so mobile never wraps `New chat` below dropdowns.
- **D6 — Unified section alignment:** Harmonize `#messagesContainer` top padding
  on `.section-view` / `.container-page` with `.main-view-panel`, and standardize
  `.section-head` / `.models-head` height and bottom margin so every section title
  (`Chats`, `Workspaces`, `Personas`, `Models`, `Settings`, `Profile`) lands on the
  exact same baseline on both Desktop and Phone.

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
- Audit and refine UI highlight colours across all themes (text selection
  tint, active/selected row highlights, hover tints, focus rings, and
  code/syntax-highlighting themes).

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
