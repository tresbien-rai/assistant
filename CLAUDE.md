# CLAUDE.md - Project Instructions for Claude Code

This file says **how we work** on Tessera. For **what exists and where it
stands** (architecture, design principles, feature status, owed items,
gotchas), read [`docs/PROJECT.md`](docs/PROJECT.md) at the start of every
session. It is the master document.

## Collaboration Model

This is a **vibe coding experiment**. The human collaborator is a novice developer
who provides vision, direction, and feedback. Claude (you) is the primary architect
and implementer — responsible for all technical decisions, code structure, and
implementation. Explain technical trade-offs in plain language when relevant, and
don't assume the human has deep familiarity with the codebase internals.

Sessions can run on the desktop or in the cloud (a session *started* from the
mobile app runs in the cloud and merges without the local checkout seeing it).
So never assume local `main` is current — fetch first (see the workflow below).

### Model tiering / sub-agents

The orchestrator (main session) runs on the top-tier model. Two cheaper,
opt-in sub-agents are defined in `.claude/agents/` for the orchestrator to
delegate to **at its discretion**:

- **`searcher`** (fast/cheap, read-only) — bounded fan-out code search: "where
  does X live", "what uses Y", "what's the naming convention". Returns paths +
  line refs + a short conclusion.
- **`mechanic`** (mid-tier) — isolated, fully-specified mechanical work: a
  well-scoped edit, a repetitive change across named files, or running the test
  suite and reporting results.

Delegation is **selective, not reflexive.** A sub-agent starts cold and
re-derives context, so it only pays off for genuinely isolated, context-light
tasks. Work that is tightly woven into the current conversation (e.g. an active
design/implementation slice) stays inline on the orchestrator. Delegating is a
judgement call the orchestrator makes as the codebase grows — when in doubt,
inline it.

## Session Workflow

Every session follows the same shape. The steps are short on purpose; each
exists because skipping it cost us something before.

### 1. Start
1. `git fetch --prune` and `git status -sb`. If `main` is behind origin, pull
   before reading any code.
2. Read `docs/PROJECT.md` — at least §7 (current focus) and §8 (owed). If the
   session touches a feature, read that feature's design doc too.
3. If the user hasn't stated the session's goal, ask.

### 2. Design (anything bigger than one PR)
- Talk it through with the user first; they share their thinking before a plan.
- Write the decision record in `docs/design/<FEATURE>_DESIGN.md`: problem, decisions
  (with the reasoning), and slices with IDs. Register a new ID prefix in
  `docs/PROJECT.md` §10 — check it isn't taken.
- Merge the design doc as its own PR before building. Decisions it records as
  locked are not re-litigated without a new reason.
- Small fixes and polish need no design doc.

### 3. Build — one slice, one branch, one PR
- **Branch first**, from up-to-date `main`, before any edit:
  `<type>/<slice-id>-<short-name>`, e.g. `feat/up-05-persona-notes`,
  `fix/short-description` when there's no slice. Never commit on `main`.
- Commit messages: `type(SLICE-ID): summary`, where type is one of `feat`,
  `fix`, `docs`, `refactor`, `chore`, `style`, `test`. Drop the scope when
  there's no slice.
- Never mix moving code and changing code in the same commit.

### 4. Verify
- `cd server && npm test` passes. Run `node tests/persona-sections.test.js` if
  persona assembly is touched.
- **UI changes:** check in the `server` preview with dev login (see
  `docs/PROJECT.md` §9): console clean, the change works, phone width works.
  Run the in-browser smoke harness for anything touching shared frontend code.
- **Prompt assembly** (`system`, tools, message content): run
  `routes/test-cacheprefix.js` and `providers/test-cachecontrol.js`, and inspect
  `POST /api/chat/preview`.
- **Provider transport:** at least one real request before calling it done.
  That needs the user's keys; if it can't happen this session, record it as
  owed in `docs/PROJECT.md` §8.
- **A new test must be seen to fail:** re-introduce the bug and confirm it's caught.

### 5. Ship
- Push and open a PR. The body says what changed, why, how it was verified,
  and anything left owed.
- Review the diff independently before merging (the `/code-review` skill or a
  review agent) and fix what it finds. This has caught real defects nearly every time.
- **Standing rule (from the user, 2026-07-03): Claude merges its own PR once the
  review passes.** Squash-merge.
- Delete the branch locally and on origin, then `git fetch --prune`. Only
  `main` should remain.

### 6. Wrap up — before the session ends
Run `/wrap` (or do it by hand when the user says we're done):
- Update `docs/PROJECT.md`: the feature index row (§6), current focus (§7),
  owed/deferred (§8), any new gotcha (§9), and the "Last updated" line.
- Update the design doc's status header if its feature moved.
- Memory is for facts about the user and their preferences only — never
  project status (that goes in `PROJECT.md`, where every session can see it).
- Tell the user: what shipped, what's owed, and the suggested next step.

### Design doc status header
Every design doc opens with one status line in this form, kept current:

```
> **Status (YYYY-MM-DD):** Complete | In progress | Designed, not built | Deferred — one sentence.
```

## Tech Stack

- **Frontend**: Vanilla HTML, CSS, JavaScript as ES modules (no frameworks, no build step)
- **Backend**: Express.js (Node.js)
- **Database**: SQLite via better-sqlite3 behind a DAL (abstracted for a future PostgreSQL migration)
- **Auth**: Google OAuth 2.0 (provides login + Google Drive access)
- **Storage**:
  - SQLite for structured data — schema in `server/src/db/schema.sql` + `server/src/db/migrations/`
  - Server filesystem for avatar/expression images
  - Google Drive (per user) for workspace, project and chat files
- **APIs**: Server-side proxy to AI providers (Anthropic, Gemini built; keys stored encrypted)
- **Hosting**: Railway (Hobby tier)

The data model, server layout and prompt assembly are described in
`docs/PROJECT.md` §3 and §5.

## File Overview

| File/Directory | Purpose | Key Contents |
|----------------|---------|--------------|
| `index.html` | Frontend structure | Rail, main views, chat area, floating avatar, modals, login screen |
| `styles/` | Frontend styling | 9 files linked in cascade order: `tokens`, `base`, `views`, `models`, `chat`, `forms`, `system`, `buttons`, `file-panel`. **Link order in index.html IS the cascade** — do not reorder |
| `js/main.js` | Module entry point | Bootstrap, init, event wiring, the test seam. Its header has a charter: anything else belongs in the module that owns the feature |
| `js/api-client.js` | API wrapper | All backend API calls |
| `js/config.js` | Config + defaults | `CONFIG`, `getDefaultModelConfig()` |
| `js/state.js` | The state object | `state` — imported and mutated by everything; never reassigned |
| `js/active-conversation.js` | Conversation switching | The ONLY writer of `state.activeConversationId`; draft stash/restore |
| `js/dom.js` | Cached DOM refs | the `elements` lookup table |
| `js/shell.js` | Navigation seam | `navigate()`, `currentSection()`, and a facade over `renderShell`/`renderMainView`/`updateUI`. Import navigation from here, never from the router |
| `js/router.js` | Main-area router | Decides which view owns the main region; rail, top bar, chat chrome. Only `main.js` imports it |
| `js/model-layer.js` | Model service layer | Provider catalog + param descriptors, the active model layer, profile load/mirror, param-path helpers |
| `js/settings-store.js` | Persistence | Settings, personas, catalog and API keys; the debounced auto-save |
| `js/persona-sections.js` | Persona prompt assembly | The six-section vocabulary; composes the persona prompt client-side |
| `js/views/` | Main-area views | `chats`, `models`, `personas`, `profile`, `settings`, `workspaces`, `usage-panel` |
| `js/persona-helpers.js` | Shared persona ops | create/hydrate personas, avatar markup, apply a persona's model settings |
| `js/avatar.js` | Floating avatar | Size/corner presets, free-drag positioning, the image or emoji it shows |
| `js/status-bar.js` | Status bar | Billed-token usage and its breakdown |
| `js/chat/` | Chat | `expressions.js` (tag protocol), `thread.js` (rendering), `send.js` (send/stream/re-run), `composer.js` (drafts, attachments) |
| `js/ui-prefs.js` | Device-local prefs | `UiPrefs` (localStorage), themes, OKLCH palette engine |
| `js/sidebar.js` | Sidebar drawer | open/close/overlay/resize |
| `js/file-panel/` | The file panel | viewer, editor, browser, revision history, context toggles |
| `js/util/` | Dependency-free helpers | `markdown.js`, `format.js`, `diff.js`, `image-store.js`, … |
| `js/components/` | Reusable UI primitives | `dialogs.js` (`confirmDialog`/`promptName`), `toast.js`, `errors.js` (`displayError`), `menus.js` (popover positioning), `textarea-resize.js`, `collapsible.js` |
| `server/src/index.js` | Server entry point | Express app setup, middleware, route mounting |
| `server/src/config.js` | Configuration | Environment variables, constants, `BRAND` |
| `server/src/db/` | Database layer | connection, `schema.sql`, `migrations/`, `dal.js` |
| `server/src/routes/` | API routes | one file per resource |
| `server/src/providers/` | AI providers | `anthropic.js`, `gemini.js`, `registry.js` (the one dispatch map) |
| `server/src/prompts/` | Prompt layer | `tessera.js` (base), `presets.js` (block composition), `profile.js`, `sessionState.js`, `title.js` |
| `server/src/tools/` | Model tools | file + scratchpad tools; `storeWriter.js` is the one write path |
| `server/src/middleware/` | Express middleware | authenticate, errorHandler, rateLimiter |
| `server/src/utils/` | Utilities | context gathering, provenance, Drive, logger, encryption, AppError |
| `tests/` | Frontend tests | `frontend-smoke.js` (run in the browser), `persona-sections.test.js` (node) |
| `docs/` | Documentation | `PROJECT.md` (master), `design/` (one decision record per feature), `UI_POLISH.md`, `DEPLOY_RAILWAY.md`, `archive/` |

## Error Handling

Server uses structured errors via `AppError` class:

```javascript
// Error codes: AUTH_ERROR, PROVIDER_ERROR, DRIVE_ERROR, RATE_LIMITED, VALIDATION_ERROR, NOT_FOUND, SERVER_ERROR
AppError.auth(message)         // 401
AppError.provider(message)     // 502
AppError.rateLimited(seconds)  // 429
AppError.validation(message)   // 400
AppError.notFound(resource)    // 404
AppError.server(message)       // 500
```

Frontend displays errors via: toast notifications (transient), inline chat errors (conversation-related), or modal/banner (critical, requires action). Route them through `displayError(err, context)` in `js/components/errors.js` — it picks the surface from the `AppError` code — rather than calling a surface directly.

## Common Tasks

### Adding a New API Endpoint
1. Create or modify the route file in `server/src/routes/`
2. Add DAL functions in `server/src/db/dal.js` (scoped by `user_id`)
3. Mount the route in `server/src/index.js` if it's a new file
4. Add the method to `js/api-client.js`
5. Call it from the module that owns the feature

### Changing the Schema
Add a numbered migration in `server/src/db/migrations/` (and update
`schema.sql`); `test-migration.js` covers the path.

### Adding a New AI Provider
1. Create `server/src/providers/{provider}.js` following the existing modules
   (including `streamRaw` for the tool loop)
2. Add it to the map in `server/src/providers/registry.js` — the single wiring point
3. Make sure it's in the allowed providers in `server/src/routes/apiKeys.js`
4. Build test fixtures from the provider's real wire bytes (see `docs/PROJECT.md` §9)

### Styling Changes

Styles live in `styles/`, split into 9 files and linked from `index.html` in
cascade order (S-01). **That link order is the cascade** — concatenating the
files in it reproduces the original single stylesheet rule for rule, so
reordering them changes which rules win. Put a new rule in the file whose
section it belongs to rather than appending to the last one. One field and
checkbox appearance is defined app-wide in `styles/base.css` at minimal
specificity, so a new field anywhere is already styled.

CSS variables live in `styles/tokens.css` (`--accent`, `--bg-*`, `--avatar-*`, …).

**UI principle — content wraps by default.** Text content should wrap and scroll
only vertically; avoid horizontal scrollbars. Prefer `white-space: pre-wrap` +
`overflow-wrap: anywhere` over `white-space: pre` + `overflow-x: auto` for code,
diffs, and other long-line content. The rare exception is content that genuinely
can't wrap (e.g. a wide data table); confine that scroll to the element itself,
never the page/panel.

## Development Commands

```bash
# Start the server (serves frontend + API); no auto-reload
cd server && npm start

# Development with auto-reload
cd server && npm run dev

# Server test suite
cd server && npm test

# Frontend unit test
node tests/persona-sections.test.js
```

For local UI testing, use the `server` preview (`.claude/launch.json`, port
3457) with dev login — see `docs/PROJECT.md` §9.

## Environment Variables

Server requires these environment variables (see `server/.env.example`):

```
PORT=3000
NODE_ENV=development
JWT_SECRET=<random-string>
ENCRYPTION_KEY=<32-byte-hex-key>
GOOGLE_CLIENT_ID=<from-google-cloud-console>
GOOGLE_CLIENT_SECRET=<from-google-cloud-console>
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/google/callback
ALLOW_DEV_LOGIN=true   # local only; enables the dev-login bypass
```

## Code Style

### Backend
- Use async/await for all async operations
- All routes use authenticate middleware (except auth routes)
- DAL functions enforce user_id scoping for data isolation
- Never log API keys, tokens, or passwords
- Use structured logging via pino

### Frontend
- **ES modules.** `index.html` loads one script,
  `<script type="module" src="js/main.js">`. Nothing in `js/` is global — a
  sibling module gets what it needs via `import`/`export`. The one deliberate
  global is `window.__tessera` at the foot of `js/main.js`, the seam the smoke
  harness (`tests/frontend-smoke.js`) reaches through; keep it wired as code
  moves. New frontend code goes in the module that owns the feature, not
  `main.js` (see its charter).
- DOM elements cached in the `elements` object (`js/dom.js`)
- **No native dialogs.** Never use `confirm()`, `alert()`, or `prompt()`.
  Browsers let users permanently suppress them ("prevent this page from creating
  additional dialogs"), after which `confirm()` returns `false` forever and every
  guarded action silently does nothing. Use `confirmDialog()` (promise-based,
  themed, in `js/components/dialogs.js`) for confirmations, `showToast()`
  (`js/components/toast.js`) for transient notices, and `promptName()` for a
  name/text input.
- **Modal chrome.** `.modal-footer` right-aligns its buttons; add `.split` only
  to hold a destructive action away from the primary one. `.modal-btn.danger`
  is a solid destructive button, `.danger-quiet` a destructive one that sits
  next to a primary. Nothing inside `.modal-overlay` may use `transition: all`
  — it delays the inherited `visibility` flip and makes the element
  unfocusable when the modal opens (see `docs/design/CONFIRM_DIALOG_PLAN.md`).
- All data operations go through `js/api-client.js`
- State loaded from server on init, kept in memory during session

### Editing files
- Use the Edit tool for source changes. Never rewrite whole files with scripts,
  and never pipe source through PowerShell `Get-Content | Set-Content` — both
  have corrupted commits here (line endings, double-encoded characters).
