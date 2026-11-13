# Solier — Project Master Document

**This is the one document to read before starting work.** It says what Solier
is, how it is put together, what state every feature is in, what is owed, and
what bit us before. Everything in `docs/design/` is a *decision record* for one
feature — read it when you touch that feature, not before.

How we work (branches, verification, merging, wrap-up) lives in
[`CLAUDE.md`](../CLAUDE.md). This document is *what*; that one is *how*.

> **Keeping this current is part of every session's wrap-up.** If a feature
> ships, a debt is paid, or a new trap is found, it is recorded here before the
> session ends. A stale line here is worse than a missing one.
>
> **Last updated:** 2026-09-25: created from memory + design docs (DOC-01), docs reorganised (DOC-02),
> `/start` + `/wrap` + auto-fetch added (DOC-03). 2026-10-14: deleted project Drive folders
> self-heal (#208); working rules moved from memory to `CLAUDE.md`; new-machine setup and test-account notes (§9).
> 2026-10-15: test-account Google sign-in working locally; #208 confirmed against real Drive;
> repo private, Railway deploy confirmed; failed API-key saves no longer show as saved;
> Claude 4.7+ requests fixed (#212); five owed live checks passed, two findings recorded (§8);
> tool trail designed (`TOOL_TRAIL_DESIGN.md`).
> 2026-11-07: persona traits designed (`PERSONA_TRAITS_DESIGN.md`, #220) and made the next target;
> harness idea noted under §7 *Later*.
> 2026-11-09: persona traits shipped (PT-01…05, #222–#226): Background rename, the
> 153-trait library, the picker design, storage + assembly, and the editor picker; one
> live check owed (§8); cloud-session gotchas added (§9).
> 2026-11-10: renamed app from Tessera to **Solier** (BR-02), fixed hardcoded brand
> strings in `prompts/tessera.js` and `utils/personaBundle.js`, and recorded the
> Editorial Serif wordmark note in `docs/UI_POLISH.md`.
> 2026-11-12: shipped UI polish slices UIP-01 (#230), UIP-02 (#231), UIP-03 (#233,
> enriched navigation rail with Recent chats, drag-resize 200–360px, and locked
> custom icons), and UIP-04 (#234, contextual chat-only top bar, composer Usage
> counter, clean section headers, and unified Desktop/Phone alignment).
> 2026-11-13: shipped UIP-05 (#235, Persona Editor 3-tab layout, separate desktop live
> card / Phone Strip A preview, and inline Fixed-model picker).

---

## Contents

1. [What Solier is](#1-what-solier-is)
2. [Where knowledge lives](#2-where-knowledge-lives)
3. [Architecture at a glance](#3-architecture-at-a-glance)
4. [Design principles](#4-design-principles)
5. [How a prompt is assembled](#5-how-a-prompt-is-assembled)
6. [Feature index](#6-feature-index)
7. [Current focus and next targets](#7-current-focus-and-next-targets)
8. [Owed, deferred and open](#8-owed-deferred-and-open)
9. [Gotchas](#9-gotchas)
10. [Slice ID registry](#10-slice-id-registry)

---

## 1. What Solier is

A personal, server-backed AI chat app. Users sign in with Google (which also
connects their Google Drive), store their own provider API keys server-side
(encrypted), and chat through customisable **personas** — each with a
segmented prompt, an avatar and a set of expressions the model can declare.

Beyond chat it is a **collaboration surface**: conversations can live inside a
workspace or project with knowledge files; the model can create, read, edit and
move files; a per-conversation **scratchpad** holds work-in-progress that both
sides edit; every file keeps a revision history.

- **Providers built:** Anthropic, Google Gemini. OpenAI has key storage but no
  provider module yet.
- **Deployed on:** Railway (Hobby), one Express service serving API + frontend.
  See [`docs/DEPLOY_RAILWAY.md`](DEPLOY_RAILWAY.md).
- **Name:** "**Solier**" (`솔리에` / `ソリエ`, formerly *Tessera*) — Old French for
  a *solar*, the private sunlit upper room of a medieval house used for quiet
  reading, writing, and conversation (also echoing *atelier* and *sommelier*).
  The display name lives behind the `BRAND` constant in `server/src/config.js`
  (BR-01, BR-02). `docs/design/PROFILE_DESIGN.md` §8 lists the places where
  `"tessera"` remains stored data or a test seam rather than branding
  (`.tessera` / `.tesserapreset` bundle format `'tessera.bundle'`, and
  `window.__tessera`).
- **Collaboration model:** the user is a novice developer who sets vision and
  direction; Claude is the architect and implementer. Explain trade-offs in
  plain language. Working rules: `CLAUDE.md`, *Working with the user*.
- **Audience:** private and single-user until the user chooses to release it.
  The GitHub repo is private (since 2026-10-15); Railway deploys from it fine.

---

## 2. Where knowledge lives

Each store has one job. If you are about to write something down, put it in the
store whose job it is.

| Store | Job | Loaded |
|---|---|---|
| `CLAUDE.md` | **How we work**: workflow, conventions, file map, code style | Automatically, every session |
| `docs/PROJECT.md` (this) | **What exists and where it stands**: architecture, principles, feature status, owed items, gotchas | Read at session start |
| `docs/design/` | **Why a feature is the way it is**: one decision record per feature, with its slices | When touching that feature |
| `docs/UI_POLISH.md` | Backlog of cosmetic and copy fixes noticed in passing | When doing a polish pass |
| `docs/DEPLOY_RAILWAY.md` | How to deploy (and redeploy) to Railway | When deploying |
| `docs/archive/` | Session handoffs, the original plan, retired scripts. History only | Never, unless digging | Never, unless digging |
| Claude's memory (local, per machine) | A pointer here. Nothing a session needs: the working rules moved to `CLAUDE.md`, because each machine has its own memory | Automatically |

Memory is **not** the place for project status: it lives only on one machine,
cloud sessions can't see it, and it drifted badly when used that way. Status
goes here, where it is versioned and reviewed.

---

## 3. Architecture at a glance

### Stack
- **Frontend:** vanilla HTML/CSS/JS as ES modules, no build step. Entry
  `js/main.js`; everything else imported. `marked` + `highlight.js` are CDN
  globals. File map: see `CLAUDE.md`.
- **Backend:** Express (`server/src/index.js`), SQLite via better-sqlite3
  behind a DAL (`server/src/db/dal.js`) that scopes every query by `user_id`.
- **Auth:** Google OAuth 2.0 → JWT cookie. A dev-only login bypass exists for
  local testing (see §9, *Local testing*).
- **Files:** avatars/expression images on the server filesystem
  (`server/data/avatars/`); project/workspace/chat files on the user's Google
  Drive, with revisions tracked in SQLite.

### Data model (20 tables)
The schema is `server/src/db/schema.sql` plus numbered migrations in
`server/src/db/migrations/`. Groups:

| Area | Tables |
|---|---|
| Identity & settings | `users`, `settings`, `api_keys`, `user_profile`, `schema_migrations` |
| Personas & prompts | `personas`, `prompt_presets` |
| Conversations | `conversations`, `messages`, `usage_events` |
| Containers | `workspaces`, `projects` (a workspace contains projects) |
| Files | `workspace_files`, `project_files`, `conversation_files`, `user_files`, `file_revisions`, `conversation_context_overrides` |
| Scratchpad | `scratchpads`, `scratchpad_revisions` |

### Server layout
| Directory | What's there |
|---|---|
| `routes/` | One file per resource: `auth`, `personas`, `conversations`, `chat`, `files`, `projects`, `workspaces`, `presets`, `profile`, `settings`, `apiKeys`, `avatars` |
| `providers/` | `anthropic.js`, `gemini.js`, and `registry.js` — **the one provider dispatch map**. `IMPLEMENTED_PROVIDER_IDS` is narrower than the valid-id list; anything that makes a call must check it |
| `prompts/` | `tessera.js` (base layer), `presets.js` (block composition), `profile.js`, `sessionState.js`, `title.js` |
| `tools/` | Model tools (`create/read/edit/move` file, scratchpad) and their shared write path `storeWriter.js` |
| `utils/` | Context gathering (`projectContext.js`, `activeFiles.js`, `scratchpadContext.js`, `contextState.js`), `provenance.js`, `drive.js`, `encryption.js`, `AppError.js` |

### Tests
- **Server:** `cd server && npm test` runs the whole suite (about 28 files, each
  `node src/.../test-*.js`). Known exception: `routes/test-apiKeys-http.js`
  needs a live server on `:3000` and fails on clean `main` — not in `npm test`,
  don't chase it.
- **Frontend unit:** `node tests/persona-sections.test.js` (sections, traits and the trait library).
- **Frontend smoke:** `tests/frontend-smoke.js` **must be run inside the live
  app** — `node tests/frontend-smoke.js` exits 0 without running anything. After
  dev-login, in the browser console:
  `await (await import('/tests/frontend-smoke.js')).run()`.

---

## 4. Design principles

These are the decisions that shape everything else. They were each argued out
with the user; don't re-litigate them without a new reason.

**Who is what — the organising rule.**
*Persona = who the model is · Profile = who the user is · Workspace/Project =
what the work is · Scratchpad = what we're doing now.* A new piece of context
belongs to exactly one of these. (Model = the *engine* under the persona's
*skin*; the two mix and match freely.)

**Prompt formatting convention.** XML tags wrap **data to consult**
(`<available_files>`, `<session_state>`); Markdown headings mark
**instructions to follow** (persona sections). Keep new blocks on the right
side of that line.

**Tell the model about absence, not just presence.** A block with stable keys
that says "none" beats silence — silence can't be told apart from "I wasn't
told". (SS-02.) Tool descriptions say what a tool *does*; `<session_state>`
says what *exists*.

**Nothing volatile in the system prompt.** Prompt caching depends on the prefix
being byte-identical turn to turn. Per-turn content goes in the message layer.
(See §9 for the two traps.)

**Tokens, never money.** Usage is reported in tokens, grouped by
(provider, model), never summed across models.

**Fail open, never silently drop.** Unknown `inject_mode` → `auto`; `enabled`
NULL → on; a file the model can't see in full is still *listed* so it can be
read. Missing optional things (no aux model, no profile) degrade gracefully —
NULL is a first-class state.

**Overrides, not copies.** Presets and per-chat settings store only what
differs, so an untouched value keeps tracking the improving built-in, and
"reset" is a delete.

**Three states, not two, where knowledge is uncertain.** File provenance is
`model` / `user` / `unknown`; `unknown` renders as nothing.

**One writer per invariant.** `js/active-conversation.js` is the only writer of
`state.activeConversationId`; `registry.js` the only provider map;
`storeWriter.js` the only file write path. Fix at the chokepoint, not at a call
site (the refactor lost three bugs to that lesson).

**UI placement.** The top bar's right side is home for chat-scoped
affordances; the composer holds composition actions only. Content wraps; no
horizontal scroll. No native dialogs.

**Features the architecture doesn't need don't get built.** UP-04 (global
answer preferences) was built and then reverted on purpose: it competed with
the persona prompt instead of complementing it. Don't rebuild it.

---

## 5. How a prompt is assembled

**System layer** (server-side, `prompts/presets.js`), default order:

1. `orientation` — Solier's base framing (`prompts/tessera.js`)
2. `profile` — the user's profile, if present and not switched off for this persona
3. `expressions` — the expression protocol, generated from the persona's real set
4. `scratchpad` — scratchpad instructions
5. `persona` — position marker for the persona's own prompt, which the
   **client** assembles from six sections (`js/persona-sections.js`:
   Personality, Voice, Expertise, Relationship, Background, General guidance).
   Each of the first five is its picked traits' sentences as one paragraph
   (`js/persona-traits.js`, the library; customised picks use their own
   text), then the section's own text as the next paragraph.

A **preset** can reword or reorder these blocks but can never enable a
capability. Preset resolution: chat → persona → account default → built-in
(`PRESET_NONE` opts out of an inherited one).

**Message layer** (appended to the last user turn at send time, never
persisted): `context_ack` and `state` (`<session_state>`: workspace / project /
scratchpad / files, always all four keys). The `state` block is plumbing — it
can be moved but not edited or disabled.

**Context injection:** container instructions and knowledge files (respecting
per-file toggles), the `<available_files>` manifest (with provenance), recently
active chat files (auto/pin/mute), and the scratchpad.

**Inspect it:** `POST /api/chat/preview`, or the assembled-prompt inspector in
Advanced settings (shows which block every span came from).

---

## 6. Feature index

Status: ✅ shipped · 🟡 shipped, live check owed · 📐 designed, not built ·
⏸ deferred. Design records are in `docs/design/` unless noted.

| Feature | Status | Slices / PRs | Design record |
|---|---|---|---|
| Phase 0 — backend, auth, deploy | ✅ | P0-01…18, #1–#24 | `../archive/PHASE0_TASKS.txt` |
| Phase 1 — Projects + Drive context | ✅ | P1-01…12 | `PHASE1_TASKS.md` |
| Phase 2 UX — top bar, persona grouping | ✅ | P2-U1…U4, #37–#43 | `PHASE2_UX_DESIGN.md` (partly superseded) |
| Workspace restructure (Workspace ⊃ Project) | ✅ | WR-01…09, #45–#55 | `WORKSPACE_RESTRUCTURE.md` |
| Persona/model de-sync, Models section | ✅ | WR-10…14, #56–#61 | `MODEL_DESYNC_DESIGN.md` |
| File tools: create/read/list | 🟡 | P2-01…05, #63–#70 | `PHASE2_TASKS.md` |
| Model parameter profiles | ✅ | #73 | `MODEL_PROFILES_DESIGN.md` |
| File panel + `edit_file` + user editing | 🟡 | #76–#78 | (in `FILE_COLLAB_DESIGN.md`) |
| Themes + OKLCH custom palette | ✅ | #80, #81 | — |
| File collaboration (chat files, revisions, live injection, move, re-roll, version viewer) | 🟡 | FC-01…06b, #82–#92 | `FILE_COLLAB_DESIGN.md` |
| Personas UI, expressions, `.tessera` bundles | ✅ | #94 | — |
| Orphaned avatar images cleanup | ✅ | OI-01…03, #95 | `ORPHANED_IMAGES_DESIGN.md` |
| In-app dialogs (no native dialogs) | ✅ | CD-01…04, #96–#98 | `CONFIRM_DIALOG_PLAN.md` |
| Models tab redesign | ✅ | slices 1–8, #99–#108 | `MODELS_TAB_REDESIGN.md` |
| Chat files explorer + uploads as working files | ✅ | CF-01, CF-01b, CF-02, #109–#111 | — |
| Scratchpad | 🟡 | SP-01…05, #112–#116 | `SCRATCHPAD_DESIGN.md` |
| Context toggles (KB on/off, auto/pin/mute) | 🟡 | CT-01…06, #117–#123 | `CONTEXT_TOGGLES_DESIGN.md` |
| Frontend refactor (`app.js` → modules) | ✅ | F-, R-, S-01, #124–#147 | `REFACTOR_PLAN.md` |
| Advanced prompt presets + inspector | 🟡 | AP-01…06, #151–#156 | `ADVANCED_PROMPTS_PLAN.md` |
| Shared form controls | ✅ | #157, #158 | — |
| Streaming tool loop | ✅ live-verified | TS-01…06, #159–#161, #167–#171 | (in `../archive/HANDOFF_2026-07-31.md`) |
| Session state + tool feedback | ✅ | SS-01…04, #162–#166 | `SESSION_STATE_DESIGN.md` |
| File provenance | ✅ live-verified | FP-01…04 (were "P-"), #173, #174 | `FILE_PROVENANCE_DESIGN.md` |
| Usage measurement | ✅ | U-01…05, #175–#179 | `USAGE_MEASUREMENT_DESIGN.md` |
| Prompt caching | ✅ live-verified (92% hit) | PC-01, PC-02, #180–#182 | `PROMPT_CACHING_DESIGN.md` |
| Aux model + auto chat titles | ✅ | AX-01, AX-02, #185, #186, #190 | — |
| Brand constant + rename to Solier | ✅ | BR-01, BR-02, #194, #228 | `PROFILE_DESIGN.md` §8 |
| User profile (tier 1) | ✅ live-confirmed | UP-01…03, #195–#198 | `PROFILE_DESIGN.md` |
| Answer preferences | ❌ reverted on purpose | UP-04, #199 → #200 | `PROFILE_DESIGN.md` (D3 withdrawn) |
| Persona sections + six-field editor | ✅ | PS-01, PS-02, #201–#203 | `PROFILE_DESIGN.md` §9 |
| Persona notes (tier 2, aux-written) | 📐 | UP-05, UP-06 | `PROFILE_DESIGN.md` |
| File digests | 📐 | — | `SESSION_STATE_DESIGN.md` §7 |
| Tool trail in history | ✅ live-verified | TT-01…03, #214–#216, #218 | `TOOL_TRAIL_DESIGN.md` |
| UI polish backlog | 🚧 (UIP-01…05 ✅, UIP-06…08 📐) | UIP-01…08, #230, #231, #233, #234, #235 | `../UI_POLISH.md` |
| Persona traits (ready-made, combinable, customisable) | ✅ (PT-06/07 later) | PT-01…05, #222–#226 | `PERSONA_TRAITS_DESIGN.md`, `PERSONA_TRAITS_LIBRARY.md` |
| Docs consolidation + session workflow | ✅ | DOC-01…03, #204–#206 | `PROJECT.md`, `CLAUDE.md` |

---

## 7. Current focus and next targets

**Next up (unless the user redirects):**
1. **Live with persona traits** (PT-01…05 shipped 2026-11-07…09). Build a few
   personas with the trait picker, on a phone too, and note what reads badly
   in the editor or in replies. Trait wording lives in `js/persona-traits.js`
   and can be improved any time (ids stay). PT-06 (bundles: an archetype in
   one pick) and PT-07 (saving your own traits) are recorded, not designed;
   pick them up only if living with traits asks for them.
2. **UP-05 / UP-06 — persona notes.** A per-persona store distilled from that
   persona's own conversations, written *between* conversations by the aux
   model, visible and editable by the user. This also covers the "more uses for
   the aux model" target. Design: `docs/design/PROFILE_DESIGN.md`.
3. **UI polish pass** (`docs/UI_POLISH.md`, active target 2026-11-11):
   - ~~**UIP-01**~~ *(shipped 2026-11-11, #230)* — preset-editor font jump fix
     (`.preset-block-text` uses `--font-main` at `14px`; `JetBrains Mono` loaded
     for `--font-mono`), Appearance **Font** picker + **Font Scope** toggle
     (`Whole app` vs `Chat & prose only` in `UiPrefs`), and `Newsreader` Italic
     brand wordmark for **Solier** on the login card and section rail.
   - ~~**UIP-02**~~ *(shipped 2026-11-11, #231)* — whole-UI wording pass: teaching
     placeholders and help text across `PERSONA_SECTIONS` and `SUGGESTED_SECTIONS`,
     trait editor and workspace copy polish, sentence-case unification, and
     fixes for stale strings (welcome empty state, server-synced avatar note,
     file panel mode note, and composer placeholder).
   - ~~**UIP-03**~~ *(shipped 2026-11-12, #233)* — enriched navigation rail (`feat/uip-03-nav-rail`):
     header with accent `G5 low-notch squiggle` quill New chat button, top 4 sections,
     Recent chats (top 8 from every home, always keeping the open chat visible,
     Grouped by workspace default or Flat list in Appearance settings, hidden at
     0 chats), separated `Profile` + `Settings` footer, drag-resize 200–360px
     (default 220px, single hairline seam), ≥44px phone drawer targets, and locked
     `Open folder` / `Chats` bubble / `Wider card carousel` Personas / single-person
     Profile icons.
   - ~~**UIP-04**~~ *(shipped 2026-11-12, #234)* — contextual top status bar (`feat/uip-04-top-bar`):
     chat-only `.status-bar` with Stacked Title + Meta (persona avatar, clickable
     chat title rename, persona name, `Workspace › Project` / muted `Chats (unfiled)`),
     `22px` distinct Avatar PIP icon, `Usage: <count>` footer beneath composer opening
     `Token Usage (This chat)`, clean non-chat section headers (hidden on desktop,
     inline `☰` drawer button on phone), `Chats` header Quill `New chat` + `.chats-next-strip`
     selectors, and unified `top`/`left` section alignment across Desktop & Phone.
   - ~~**UIP-05**~~ *(shipped 2026-11-13, #235)* — Persona Editor (`feat/uip-05-persona-editor`):
     3-tab strip (`Identity & Prompt` | `Avatar & Expressions` | `Defaults & Capabilities`),
     separate desktop sibling live WYSIWYG card preview (`>= 768px`), compact Phone
     Strip A above the tabs (`< 768px`, `94×94` portrait with action button below),
     and inline Fixed-model picker popover with `Edit model profile in Models →`.
   - **UIP-06** *(next target)* — Workspace/Project auto-save, visible `Chat`/`Edit` actions on
     Persona tiles, onboarding empty-state action button, unified button
     primitives, `var(--border-color)` fix, removal of `transition: all`, and
     keyboard accessibility.
   - **UIP-07** — evaluation and refinement of the 8 colour themes (`Midnight`,
     `Slate`, `Forest`, `Ocean`, `Light`, `Parchment`, `Rosé`, `Custom`) and
     light-theme contrast fixes for diffs and Markdown tables.
   - **UIP-08** — the Chats page holds every chat, organised by Workspace and
     Project (found while designing UIP-03). Not designed; prototype first.

**Later:**
4. **File digests** (`docs/design/SESSION_STATE_DESIGN.md` §7) — deterministic first line,
   then model-written summaries, then aux model; store provenance from day one.
5. **More providers — OpenAI first.** Key storage and validation exist; it
   needs a provider module and one entry in `providers/registry.js`. The user's
   framing: do this once the platform is stable.
6. **Harness** — the assistant doing more on its own (longer, multi-step
   work), building on the tool loop. A long-horizon goal the user raised
   2026-11-06; not designed. Wait until more features are in.

---

## 8. Owed, deferred and open

### Live checks owed (need real Drive + provider keys)
The user believes some of these were done informally; none was confirmed
in a session. Treat each as open until checked and recorded here. Since
2026-10-15 Claude can run the Drive half itself through the test account
(§9, *Local testing*); checks that need a model reply also need an AI key on
that account, which the user enters.

**Run 2026-10-15** with the test account on `claude-haiku-5-5` and
`gemini-3.8-flash`, through the real composer; each result confirmed in the
server log and against Drive, not just from the model's reply:
- [x] **File tools end-to-end** (P2-06): both models created a file, listed, and the content round-tripped on Drive.
- [x] **File panel user editing** (slice 3): a panel save reached Drive with a `user:edit` revision, and both models quoted the edited text via a real `read_file`.
- [x] **`move_file`** (FC-05): both models promoted their chat file into the project; content intact.
- [x] **Scratchpad adoption**: unprompted, both models wrote a plan to the pad, then made a targeted `edit_scratchpad` on a follow-up.
- [x] **Context toggles**: auto and pin inject a chat file, mute keeps it out (still in `list_files`, readable); a knowledge file switched off for the chat leaves the content and stays named in `<available_files>`, and Haiku read it from there.
- [x] **Tool trail** (TT-03), 2026-10-15, test account, four turns each on `claude-haiku-5-5` and `gemini-3.8-flash` (create + move, recall, edit, title): no "results I hadn't seen" apology, no tool re-runs, no `<tool_trail>` copied; both edits confirmed on Drive. It also showed a successful move saving no destination (a move is a file card), fixed in #218. One new doubt on Haiku, below.
- [ ] **Advanced presets visual pass**: the prompt inspector, the block editor at narrow widths, the composer's preset pill. Only verified through the DOM so far.
- [ ] **Persona traits on a real phone** (PT-05, #226): build a persona with the
  trait picker on the phone (bottom-sheet picker, editing a sentence, Reset)
  and chat with it once; check the reply reflects the picks. Verified only in
  automated desktop/phone-width runs so far.
- [ ] **Gemini 3.5+ trimmed body** (#217): one real send on `gemini-3.8-flash` (and `gemini-4-argon` if keyed) with tools off and thinking on Model default, then on Level; expect a normal reply. The body only lost fields, so low risk.
- [ ] **UI polish visual pass on a real phone** (UIP-03…05, #233–#235): rail drawer & `Recent` chats list, contextual chat top bar + composer `Usage:` footer, and Persona Editor 3-tab strip + Phone Strip A + Fixed-model picker. Verified in headless Chromium at `1280×820` and `390×844` so far.

### Deferred on purpose
- **CF-02b** — PDFs as working files.
- **Depth-positioned injections** (Author's Note / post-history) and **output
  regex rules** for presets. The block schema leaves room for both.
- **Search tools** for files.
- **Per-module event wiring**: `setupEventListeners` in `js/main.js` is still
  ~500 lines. Move a feature's listeners with it *when already touching that
  feature*; not a phase of its own.
- **Lost-update guard for file saves** — cross-tab saves are last-write-wins;
  the upgrade path is If-Match on `drive_file_id` → 409.
- **`showConversationMenu`** positions its menu inline instead of using
  `positionPopover`, so it doesn't flip above its anchor.
- **Custom Profile avatar upload** — allow users to upload their own profile
  icon and replace the single-person `Profile` icon in the rail footer when
  present; deferred until after the UI polish pass (`UIP-03` D11).

### Dropped
- **FC-06c** two-version compare — the user's call.
- **UP-04** answer preferences — built and reverted; see §4.

### Found in the 2026-10-15 live run — needs a decision
- **Current models think they made up their own tool results.** History stores
  only each reply's final text, so `claude-haiku-5-5` saw its earlier
  "Created… moved…" with no record behind it and apologised on every turn
  after tool use (not seen on Flash). **Decided 2026-10-15:** a compact
  per-reply tool trail, not full replay (≈50× cheaper, no stale file copies).
  Design: `docs/design/TOOL_TRAIL_DESIGN.md`. **Shipped and live-verified**
  (TT-01…03).
- **Reference files read as "already there".** Found in the TT-03 run.
  Project and workspace files are injected as reference material at the
  *start* of the conversation, but with their *current* content. After Haiku
  added a line to a project file, it saw that line in the reference block,
  placed before its own edit, and wondered whether the line had been there
  all along. The header says "(you created this)" but not that the block shows
  the latest version, including edits made later in this chat. Not seen on
  Flash. **Fixed 2026-10-15** (user chose the prompt-level fix over moving
  edited files to the end): both reference headers now say each file shows its
  current saved version, including later changes in this chat. Re-run on
  Haiku 5.5 (create + move, edit, title): no doubt. If it comes back, the
  next step is showing edited project files in `<active_files>` at the end.
- **Editing a project file breaks the cache for the whole chat.** Noticed while
  looking at the above, not measured. The reference block is the first message
  and carries current content, so any project or workspace file change alters
  the start of every later request, and the next message re-processes the
  whole history uncached. Already true before TT; worth measuring with the
  usage panel before deciding anything.
- **A muted chat file can be overlooked.** `<session_state>` says "1 in this
  conversation", but asked about "my working file", Haiku read the project
  files and never called `list_files`. Asked to list, it found and read it. A
  prompt nudge, not a bug.
- ~~**The model view still offers temperature / top-p / top-k for Claude 4.7+**~~
  and ~~**prefill on Claude 4.6+**~~ — resolved: the detail view hides them
  (and the thinking budget on 4.7+) with a note in their place, and neither
  the client nor the server sends a prefill to 4.6+. **Gemini 3.5+ got the
  same treatment** (sampling ignored, prefill a 400, budget deprecated): no
  sampling, prefill or budget sent; the thinking control offers "Model default"
  and "Level". Help text follows the model (`modelParamRules` in
  `js/model-layer.js`). The client's rules (`js/util/model-rules.js`) mirror
  `providers/anthropic.js` and `gemini.js`; `test-modelparams.js` fails if
  they disagree. Left alone by choice: the `minimal` thinking level, which
  Gemini 3.8 Flash and 4 Argon reject with a clear 400.

### Small open items
- File rows whose Drive file was deleted outside the app still list, then fail
  to open with the generic Drive error. Re-uploading fixes one by hand.
- `wrapDriveError` (`utils/drive.js`) says "Please reconnect your account" for
  every Drive failure, 404s included, so non-auth problems look like auth
  problems. Word it by cause.
- `conversation_files.last_touched_turn` is unused (superseded by
  `file_revisions.turn`); tidy up some time.
- Intermittent: about 1 turn in 12 on Gemini once returned tool-call syntax as
  text with no tool run. Not reproducible; looks model-side.

---

## 9. Gotchas

Things that cost real time. Most were silent — nothing errored.

### Editing files
- **Don't rewrite whole files with scripts.** A Python rewrite normalised line
  endings and put 2,700 lines of noise into a 3-line commit. Use the Edit tool.
  The repo is LF-normalised via `.gitattributes` (#197).
- **Never use PowerShell `Get-Content | Set-Content` on source.** It
  double-encodes non-ASCII (em-dashes became `â€”` and reached a commit). For
  scripted edits use Node with explicit `utf8`, cut by anchor not line number,
  and assert the match count.
- **`Measure-Object -Line` skips blank lines** — use Node for line counts.
- **Never filter a checker's output through `grep -v`**; it hides the result
  you needed.

### Testing
- **A test that accepts two shapes can't detect a shape error**, and **a fixture
  built on the wrong wire shape can't either**. Both happened: the Gemini CRLF
  bug (#170) and the thinking + `top_k` 400 (#171) were total failures with
  green tests. For provider transports, build fixtures from the provider's
  *actual* bytes and run at least one real request before calling it done.
- **Re-introduce the bug to prove a new test catches it.** One test passed with
  the bug present on first write.
- **Race tests need a delayed stub** — localhost resolves before the race.
- **Independent review per slice pays off.** Review agents found 3–4 real
  defects per usage slice, including ones argued to be fine.

### Prompt caching (fails silently — the bill just goes up)
- Nothing volatile in the system prompt; `{{time}}` in a preset re-breaks it every minute.
- Never put a cache marker on the last user turn (and never enable Anthropic's
  automatic top-level caching, which does exactly that).
- Guards: `routes/test-cacheprefix.js` and `providers/test-cachecontrol.js`. Run
  both before touching anything that builds `system`, `tools` or message content.

### Providers
- Anthropic `output_tokens` includes thinking; Gemini's excludes it. Anthropic
  `input_tokens` excludes cached; Gemini's includes it. `thinkingTokens` is
  `null` on Anthropic, which is not the same as 0.
- Anthropic rejects `top_k`/`top_p` with extended thinking; the guard drops them.
- **Claude 4.7 and later take no sampling parameters and no `budget_tokens`**
  (400 on any of them). `isCurrentGenerationModel` in `providers/anthropic.js`
  routes those models to a body with neither, and maps the thinking toggle to
  `{type: "adaptive"}` (#212). New model ids parse automatically; ids that
  don't parse are sent the old way.
- **Gemini 3.5 and later ignore `temperature`/`topP`/`topK`** (Google says a
  future generation will 400), **400 on prefill**, and deprecate
  `thinkingBudget` for `thinkingLevel`. `isCurrentGenerationModel` in
  `providers/gemini.js` sends them none of the three. Ignored params return
  200, so nothing would have shown the difference.
- Google terminates SSE lines with CRLF.

### Frontend
- **The `styles/` link order in `index.html` is the cascade** — don't reorder.
- **Nothing inside `.modal-overlay` may use `transition: all`** — it delays the
  `visibility` flip and makes the modal unfocusable on open.
- `express.static` has no cache-busting: hard-refresh after CSS changes or you
  will "find" bugs that are already fixed.
- Re-rendering a focused textarea eats the caret — build once, mutate.
- Expression-name charset must stay in sync in three places:
  `prompts/tessera.js`, `validateExpressionName` in `routes/avatars.js`, and the
  client guard in `saveExpression`.
- Don't rename element ids for a label change — it orphans stored data
  (persona "Speech" was relabelled "Voice", id stays `speech`).
- `normalizeBlocks` *appends* missing preset blocks on purpose; the user's order wins.
- `IMPLEMENTED_PROVIDER_IDS` ≠ valid provider ids.
- **`updateFixedPersonaPin()` (`js/settings-store.js`) runs on every `autoSaveSettings()` tick**
  and overwrites `persona.modelConfig` from `getActiveModelConfig()` unless the
  active layer's `provider`/`model` already match. Editor handlers that change a
  fixed persona's model or mode must preserve sibling keys (`presetId`,
  `toolsEnabled`, `profileEnabled`) and call `applyPersonaModelSettings()`
  immediately so background keystrokes don't drop or revert the pick.

### New machine
Setting up another computer (e.g. the laptop) to work exactly like the PC:
1. Install Git, Node.js (LTS) and the Claude desktop app; sign in to GitHub
   (`gh auth login`) so the private repo can be cloned and pushed.
2. Clone `tresbien-rai/assistant`, then `cd server && npm install`.
3. Copy `server/.env` from the PC **by hand** (USB stick or a password
   manager — never email, chat or git). It holds `JWT_SECRET`,
   `ENCRYPTION_KEY` and the Google OAuth client. The values must match the
   PC's only if the PC's database is copied too; a fresh database (created on
   first start) works with any values.
4. Start the `server` preview, click dev login, and run `npm test` once.
5. The Claude memory on that machine starts empty. That's fine: the working
   rules are in `CLAUDE.md`.

### Local testing
- **Dev login:** set `ALLOW_DEV_LOGIN=true` (with `NODE_ENV=development`) in the
  gitignored `server/.env`, start the `server` preview (port 3457), click
  "Dev login (local)". The stub user has **no Drive token**, so Drive-backed
  features can't be exercised — that is why live checks are owed.
- **Real Google sign-in locally (test account), working since 2026-10-15.**
  A dedicated test Google account (no real data at stake) is signed into the
  browser pane; Claude never types its password. With it, Claude exercises
  real Drive features before merge — drive the API from the page with
  `fetch` (the pane has no file picker; build a `File` for `FormData`). It
  needs four things, all in place on the PC:
  - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in the local `.env` (the same
    OAuth client as Railway's; copy from Railway → Variables).
  - `GOOGLE_REDIRECT_URI=http://localhost:3457/api/auth/google/callback` in
    the local `.env`. **Not** the Railway address: that sends the login to the
    live site, which rejects it. The two environments differ on this one value.
  - That localhost URI listed under *Authorized redirect URIs* on the OAuth
    client, next to the Railway one. A missing one shows `redirect_uri_mismatch`.
  - The account on the consent screen's test-user list. The app stays in
    *Testing* until release (the user's call), so only listed accounts can
    sign in — and Google expires every account's sign-in after 7 days, so the
    weekly symptom is a Drive error until you sign out and back in.

  If the preview is still on the dev user, go to `/api/auth/google` directly.
  **Leave the preview running when handing the pane to the user:** if it's
  stopped, everything they try there fails with "Network request failed".
  The same account also works on the live Railway site (production database,
  separate user).
- The auth cookie doesn't survive a server restart; click dev login again.
- `npm start` doesn't auto-reload — restart after server edits.
- Rows seeded directly into the DB only appear after a browser reload.
- CSS transitions don’t advance while `document.hidden` is true, so a modal in
  a background tab reads `opacity: 0` even though its class and CSS are right.
- Clipboard writes throw `NotAllowedError` when the document isn’t focused, so
  copy-button toasts never appear in automated runs. That is not a bug.
- A browser-pane eval can time out while the page keeps executing; split long
  test chains into small evals.

### Cloud sessions (started from the mobile app)
- **cdnjs and Google Fonts are blocked**, so `marked` and `highlight.js` never
  load and the app stops at "marked is not defined". For a headless Playwright
  check, fetch the real files from npm (`npm pack marked@12.0.0 @highlightjs/cdn-assets@11.9.0`,
  which the sandbox allows) and serve them with `page.route(/cdnjs/, …)`, and
  fulfil `fonts.googleapis.com` / `fonts.gstatic.com` with empty `200` CSS so
  console errors stay at zero. A hand-written stub breaks the smoke harness's
  markdown check.
- **The session's git rules refuse remote branch deletes and force-pushes.**
  Merged session branches pile up on origin until the user deletes them. To
  reuse the session branch after a squash-merge, recreate it from
  `origin/main` and *merge* the old remote branch in (its content is already
  on `main`, so the PR diff stays clean) instead of force-pushing.
- **`server/src/db/test-dal.js` writes to the dev database**
  (`server/data/assistant.db`) and applies pending migrations there, so a
  dev server started afterwards logs "No pending migrations" even for a new
  one. Not a bug, but it makes "did my migration run?" misleading: check
  `schema_migrations` directly.
- Screenshots have been unreliable here; verify visuals with computed styles too.

---

## 10. Slice ID registry

Every piece of planned work gets an ID `PREFIX-NN` used in branch names,
commit messages, PR titles and its design doc. **Before inventing a prefix,
check it isn't here, then add it.** (Two features once both used `P-`.)

| Prefix | Feature |
|---|---|
| P0, P1, P2 | Phases 0–2 (P2-U = Phase 2 UX track) |
| WR | Workspace restructure + model de-sync |
| FC | File collaboration |
| OI | Orphaned images |
| CD | Confirm dialogs |
| CF | Chat files |
| SP | Scratchpad |
| CT | Context toggles |
| F, R, S | Refactor: fixes, restructure slices, stylesheet split |
| AP | Advanced prompts |
| TS | Streaming tool loop |
| SS | Session state |
| FP | File provenance (the design doc still says `P-`) |
| U | Usage measurement |
| PC | Prompt caching |
| AX | Aux model |
| BR | Branding |
| UP | User profile + persona notes |
| PS | Persona sections |
| UIP | UI polish backlog |
| DOC | Documentation housekeeping |
| TT | Tool trail in history |
| PT | Persona traits |
