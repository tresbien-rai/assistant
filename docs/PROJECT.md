# Tessera — Project Master Document

**This is the one document to read before starting work.** It says what Tessera
is, how it is put together, what state every feature is in, what is owed, and
what bit us before. Everything else in `docs/` is a *decision record* for one
feature — read it when you touch that feature, not before.

How we work (branches, verification, merging, wrap-up) lives in
[`CLAUDE.md`](../CLAUDE.md). This document is *what*; that one is *how*.

> **Keeping this current is part of every session's wrap-up.** If a feature
> ships, a debt is paid, or a new trap is found, it is recorded here before the
> session ends. A stale line here is worse than a missing one.
>
> **Last updated:** 2026-09-25 (created by consolidating memory + design docs).

---

## Contents

1. [What Tessera is](#1-what-tessera-is)
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

## 1. What Tessera is

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
  See [`DEPLOY_RAILWAY.md`](../DEPLOY_RAILWAY.md).
- **Name:** "Tessera" — a single tile in a mosaic. The name sits behind a
  `BRAND` constant in `server/src/config.js` (BR-01) because a rename toward
  something evoking a personal *study* is still being considered.
  `docs/PROFILE_DESIGN.md` §8 lists the places where "Tessera" is data, not
  branding (e.g. the Drive root folder).
- **Collaboration model:** the user is a novice developer who sets vision and
  direction; Claude is the architect and implementer. Explain trade-offs in
  plain language.

---

## 2. Where knowledge lives

Each store has one job. If you are about to write something down, put it in the
store whose job it is.

| Store | Job | Loaded |
|---|---|---|
| `CLAUDE.md` | **How we work**: workflow, conventions, file map, code style | Automatically, every session |
| `docs/PROJECT.md` (this) | **What exists and where it stands**: architecture, principles, feature status, owed items, gotchas | Read at session start |
| `docs/*_DESIGN.md`, `*_PLAN.md` | **Why a feature is the way it is**: one decision record per feature, with its slices | When touching that feature |
| `docs/archive/` | Finished phase plans and retired files. History only | Never, unless digging |
| Claude's memory (local, per machine) | Facts about the user and their preferences that don't belong in the repo; a pointer here | Automatically |

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
- **Frontend unit:** `node tests/persona-sections.test.js`.
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

1. `orientation` — Tessera's base framing (`prompts/tessera.js`)
2. `profile` — the user's profile, if present and not switched off for this persona
3. `expressions` — the expression protocol, generated from the persona's real set
4. `scratchpad` — scratchpad instructions
5. `persona` — position marker for the persona's own prompt, which the
   **client** assembles from six sections (`js/persona-sections.js`:
   Personality, Voice, Expertise, Relationship, Backstory, General guidance)

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
⏸ deferred. Design docs are in `docs/` unless noted.

| Feature | Status | Slices / PRs | Design record |
|---|---|---|---|
| Phase 0 — backend, auth, deploy | ✅ | P0-01…18, #1–#24 | `archive/PHASE0_TASKS.txt` |
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
| Streaming tool loop | ✅ live-verified | TS-01…06, #159–#161, #167–#171 | (in `HANDOFF_2026-07-31.md`) |
| Session state + tool feedback | ✅ | SS-01…04, #162–#166 | `SESSION_STATE_DESIGN.md` |
| File provenance | ✅ live-verified | FP-01…04 (were "P-"), #173, #174 | `FILE_PROVENANCE_DESIGN.md` |
| Usage measurement | ✅ | U-01…05, #175–#179 | `USAGE_MEASUREMENT_DESIGN.md` |
| Prompt caching | ✅ live-verified (92% hit) | PC-01, PC-02, #180–#182 | `PROMPT_CACHING_DESIGN.md` |
| Aux model + auto chat titles | ✅ | AX-01, AX-02, #185, #186, #190 | — |
| Brand constant | ✅ | BR-01, #194 | `PROFILE_DESIGN.md` §8 |
| User profile (tier 1) | ✅ live-confirmed | UP-01…03, #195–#198 | `PROFILE_DESIGN.md` |
| Answer preferences | ❌ reverted on purpose | UP-04, #199 → #200 | `PROFILE_DESIGN.md` (D3 withdrawn) |
| Persona sections + six-field editor | ✅ | PS-01, PS-02, #201–#203 | `PROFILE_DESIGN.md` §9 |
| Persona notes (tier 2, aux-written) | 📐 | UP-05, UP-06 | `PROFILE_DESIGN.md` |
| File digests | 📐 | — | `SESSION_STATE_DESIGN.md` §7 |
| UI polish backlog | 📐 | UIP-01, UIP-02 | `UI_POLISH.md` |

---

## 7. Current focus and next targets

**Next up (unless the user redirects):**
1. **UP-05 / UP-06 — persona notes.** A per-persona store distilled from that
   persona's own conversations, written *between* conversations by the aux
   model, visible and editable by the user. This also covers the "more uses for
   the aux model" target. Design: `PROFILE_DESIGN.md`.
2. **UI polish pass** (`UI_POLISH.md`): UIP-01, the preset-editor font jump
   (`--font-mono` names Fira Code, which is never loaded) plus the agreed
   font-picker extension; UIP-02, a whole-UI wording pass with persona
   placeholders as the highest-leverage copy. The user deliberately deferred
   wording until the feature set is complete.

**Later:**
3. **File digests** (`SESSION_STATE_DESIGN.md` §7) — deterministic first line,
   then model-written summaries, then aux model; store provenance from day one.
4. **More providers — OpenAI first.** Key storage and validation exist; it
   needs a provider module and one entry in `providers/registry.js`. The user's
   framing: do this once the platform is stable.
5. **Rename** — blocked only on choosing a name.

---

## 8. Owed, deferred and open

### Live checks owed (need real Drive + provider keys; the user drives)
The user believes some of these were done informally; none was confirmed
in a session. Treat each as open until checked and recorded here.

- [ ] **File tools end-to-end** (P2-06): create/read/list against real Drive.
- [ ] **File panel user editing** (slice 3): edit in the panel, confirm the model sees it via `read_file`.
- [ ] **`move_file`** (FC-05) with real Drive.
- [ ] **Scratchpad adoption**: the model actually tool-calls the pad instead of narrating in chat. SP-05 wording is a starting point; tune it live in `prompts/tessera.js`, `utils/scratchpadContext.js`, `tools/definitions.js`.
- [ ] **Context toggles**: pin/auto/mute injection into a real request; the model calling `read_file` on a manifested file.
- [ ] **Advanced presets visual pass**: the prompt inspector, the block editor at narrow widths, the composer's preset pill. Only verified through the DOM so far.

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

### Dropped
- **FC-06c** two-version compare — the user's call.
- **UP-04** answer preferences — built and reverted; see §4.

### Small open items
- `conversation_files.last_touched_turn` is unused (superseded by
  `file_revisions.turn`); tidy up some time.
- Intermittent: about 1 turn in 12 on Gemini once returned tool-call syntax as
  text with no tool run. Not reproducible; looks model-side.
- Root `package.json` has a pre-server `dev` script (`http-server`) that no
  longer reflects how the app runs.

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

### Local testing
- **Dev login:** set `ALLOW_DEV_LOGIN=true` (with `NODE_ENV=development`) in the
  gitignored `server/.env`, start the `server` preview (port 3457), click
  "Dev login (local)". The stub user has **no Drive token**, so Drive-backed
  features can't be exercised — that is why live checks are owed.
- The auth cookie doesn't survive a server restart; click dev login again.
- `npm start` doesn't auto-reload — restart after server edits.
- Rows seeded directly into the DB only appear after a browser reload.

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
| UIP | UI polish backlog (the doc still says `P-`) |
| DOC | Documentation housekeeping |
