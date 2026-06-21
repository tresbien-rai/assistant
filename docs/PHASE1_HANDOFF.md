# Phase 1 Handoff — start here

Orientation for picking up **Phase 1 (Projects / Google Drive file context)** in
a fresh session. Read this, then `docs/PHASE1_TASKS.md` for the task breakdown.

## Where the project stands
- **Phase 0 is complete, deployed, and smoke-tested** on Railway. The app is a
  server-backed (Express + SQLite) chat client with Google OAuth: personas,
  conversations, messages, settings, encrypted API keys, Anthropic + Gemini
  chat proxies (streaming), per-user rate limiting, avatars/expressions.
- **A full UI redesign is complete** (PRs #10–#24): adjustable layout
  (resizable sidebar, adaptive chat width, auto-grow composer, movable/scalable
  avatar), Settings moved to a centered modal (status-bar gear), 3 themes
  (Midnight/Light/Slate) + accent color picker, Inter font + type/spacing scale,
  pill buttons, Claude-style scrollbars, unified attachment cards, hybrid depth.
- **Live URL:** `https://projectpa.up.railway.app` (Railway). To deploy: push to
  `main` (Railway auto-deploys) or hit Redeploy. Server logs: Railway → service
  → Deploy Logs. Full deploy details in `DEPLOY_RAILWAY.md`.
- Only `main` exists (feature branches are deleted after merge).

## Read these to get oriented (in order)
1. `CLAUDE.md` — project instructions, architecture, conventions.
2. The auto-memory `MEMORY.md` + `memory/project_phase0_status.md` — current state.
3. `PLANNING.txt` — full roadmap; the **Phase 1: Projects** section is the spec.
4. `docs/PHASE1_TASKS.md` — the Phase 1 task breakdown (P1-01 … P1-12).
5. `DEPLOY_RAILWAY.md` — deploy/ops (Drive API enablement, env vars, Volume).

Run `git fetch` before reviewing — the human sometimes runs parallel work in
Claude Code Web, so local `main` may lag origin.

## What Phase 1 builds (one paragraph)
A Projects feature: a project bundles **instructions + files** that get injected
as context into any conversation assigned to that project (independent of which
persona is used). Files are stored on the **user's Google Drive** (the backend
uploads/downloads via the Drive API); SQLite caches file metadata + Drive file
IDs. See `docs/PHASE1_TASKS.md` for the breakdown and suggested order.

## Already in place (don't rebuild)
- DB: `projects`, `project_files` tables (+ indexes) in `db/schema.sql`;
  `conversations.project_id` nullable FK.
- DAL: `createConversation`/`updateConversation` accept `projectId`; the
  conversations route accepts `projectId` on create.
- Auth/Drive: OAuth grants the `drive.file` scope; `users.drive_token` /
  `drive_refresh` stored **encrypted**; `/api/auth/me` returns `hasDriveAccess`;
  `googleapis` is a dependency (used in `routes/auth.js`).
- Errors: `AppError.drive()` → `DRIVE_ERROR`; frontend `displayError` already
  routes `DRIVE_ERROR` → critical banner.

## Key files
| Area | File |
|---|---|
| Schema | `server/src/db/schema.sql` |
| DAL (add project fns here) | `server/src/db/dal.js` |
| New: Drive helper | `server/src/utils/drive.js` (to create) |
| New: Projects routes | `server/src/routes/projects.js` (to create, mount in `index.js`) |
| Chat proxy (context injection) | `server/src/routes/chat.js` |
| OAuth / Drive tokens | `server/src/routes/auth.js`, `utils/encryption.js` |
| Frontend API client | `api-client.js` (add `API.projects.*`) |
| Frontend logic/UI | `app.js`, `index.html`, `styles.css` |

## Conventions / workflow (important)
- **All task work on a feature branch → PR → `/code-review` → fix findings →
  merge → delete branch** (local + remote, so only `main` survives). Never
  commit features directly to `main`.
- **Verify before merge.** The full UI is behind Google login, so it can't be
  driven locally; use the Claude_Preview MCP (`.claude/launch.json` server name
  `server`, port 3457) for headless checks (page loads clean, computed styles,
  global-function logic). The human judges visual/interactive behavior on the
  live deploy.
- **Secrets:** `server/.env` holds gitignored dev stubs — never commit. API keys
  & Drive tokens are encrypted at rest; never log them.
- Commit messages end with the project's Co-Authored-By trailer (see git log).

## Phase 1 gotchas (read before coding the backend)
- **Drive access-token refresh:** the stored `drive_token` (access token) expires
  (~1h). Before Drive calls, build an OAuth2 client with both tokens and refresh
  when needed, persisting the new access token via `dal.updateUserDriveTokens`.
  This is the first thing to get right (P1-01).
- **`drive.file` scope** only exposes files the app itself created/opened — which
  is exactly the model here (the app makes its own `AI Assistant/projects/...`
  folders). It's a **non-sensitive** scope, so **no Google app verification** is
  needed. Just ensure the **Drive API is enabled** in the Cloud project.
- **Storage location:** project files live on Drive, **not** on the Railway
  Volume. The Volume (`/app/server/data`) only holds SQLite + avatars. Temp
  downloads during context assembly are ephemeral.
- **Context/token budget:** project files can be large — guard the assembled
  context size and warn the user; cache downloaded text during a conversation.

## First steps
1. `git fetch`, read the orientation docs above.
2. Branch (e.g. `p1-01-drive-util`), implement P1-01 (Drive client + token
   refresh) and P1-02 (project DAL), verify, PR, review, merge.
3. Continue down `docs/PHASE1_TASKS.md` (backend → context injection → frontend
   → verify), one branch/PR per task or small group.
