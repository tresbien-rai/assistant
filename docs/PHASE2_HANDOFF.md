# Phase 2 Handoff — start here

Orientation for picking up **Phase 2** in a fresh session. Read this, then
`docs/PHASE2_TASKS.md` for the task breakdown.

Phase 2 has **two tracks**:
- **Tool Use (File Creation)** — the planned Phase 2 feature: let the model
  create/read/list files during a conversation (stored on the user's Drive).
- **UI Polish** — three goals the human flagged after Phase 1 (upload
  indicators, a "thinking" streaming indicator, and tab/UX integration). These
  can run in parallel with Tool Use; pick ordering with the human.

## Where the project stands
- **Phase 0 + Phase 1 are complete, deployed, and live-validated** on Railway.
  The app (named **Tessera** — see `[[app-name-tessera]]` / the rename in git) is
  a server-backed (Express + SQLite) chat client with Google OAuth: personas,
  conversations, messages, settings, encrypted API keys, Anthropic + Gemini chat
  proxies (streaming), per-user rate limiting, avatars/expressions, **and
  Projects** (instructions + Drive-backed files injected as context, working on
  both providers).
- **Live URL:** `https://projectpa.up.railway.app`. Deploy = push to `main`
  (Railway auto-deploys). Logs: Railway → service → Deploy Logs. Details in
  `DEPLOY_RAILWAY.md`.
- Only `main` exists (feature branches are deleted after merge).

Run `git fetch` before reviewing — the human sometimes runs parallel work in
Claude Code Web, so local `main` may lag origin.

## Read these to get oriented (in order)
1. `CLAUDE.md` — project instructions, architecture, conventions.
2. The auto-memory `MEMORY.md` + `memory/project_phase1_status.md` (what shipped)
   + `memory/project_app_name.md` (the app is **Tessera**).
3. `PLANNING.txt` — the **Phase 2: Tool Use** section is the original spec;
   **Phase 4** lists QoL items (incl. "streaming improvements") that the UI
   polish track overlaps.
4. `docs/PHASE2_TASKS.md` — the task breakdown (Tool Use + UI Polish).
5. `docs/PHASE1_HANDOFF.md` / `docs/PHASE1_TASKS.md` — reference for patterns and
   the Drive/provider plumbing Phase 2 builds on.

## What the Tool Use track builds (one paragraph)
Define backend **tools** the model can call mid-conversation — `create_file`
(write content to the active project's Drive folder, or a `Tessera/Downloads/`
folder if no project; record in `project_files`), `read_file`, and `list_files`.
The chat proxy advertises these tools to the provider, and when the model
returns a tool call the backend **executes it, returns the result to the model,
and continues** until a final answer. The frontend renders tool calls and
created files as downloadable attachments with inline preview. Provider mapping:
Anthropic `tool_use`/`tool_result`, Gemini `functionCall`/`functionResponse`
(OpenAI later in Phase 3).

## Already in place (don't rebuild)
- **Drive I/O** (`server/src/utils/drive.js`): `getAuthForUser`, `ensureAppFolders`,
  `createFolder`, `uploadFile`, `downloadFileText`, `downloadFileBytes`,
  `listFiles`, token refresh — reuse directly for tool file I/O.
- **Project file DAL** (`server/src/db/dal.js`): `addProjectFile`,
  `listProjectFiles`, `getProjectFile`, etc.
- **Context assembler** (`server/src/utils/projectContext.js`): text/PDF
  extraction + the swappable `gatherFileTexts()` step.
- **Chat proxy** (`server/src/routes/chat.js`): provider dispatch, per-provider
  `buildRequestBody`, streaming SSE forwarding, mid-stream error handling, the
  `resolveProjectContext` → systemPrompt prepend, and the
  `X-Project-Context-Warning` header pattern.
- **Frontend**: attachment cards (`.att-badge`/`.att-icon`/`.att-name`,
  `getFileTypeLabel`, `formatFileSize`, the project file-list rows), toast +
  inline-error + critical-banner system (`displayError`), modal + context-menu
  systems, the typing indicator (`showTypingIndicator`/`hideTypingIndicator`),
  and the expression system (persona `expressions` = `{ emoji, imageKey }`,
  `setExpression`, `updateFloatingAvatar`, `detectExpression`).
- **Limits/config** (`config.js`): `projectFiles` (size cap, accepted-extension
  allow-list, `contextBudgetChars`). Reuse the allow-list for `create_file`.

## Key files
| Area | File |
|---|---|
| Chat proxy + tool loop | `server/src/routes/chat.js` |
| Provider tool formatting | `server/src/providers/anthropic.js`, `gemini.js` |
| New: tool defs + executor | `server/src/tools/` or `server/src/utils/tools.js` (to create) |
| Drive I/O | `server/src/utils/drive.js` |
| Project file DAL | `server/src/db/dal.js` |
| Frontend tool/file rendering | `app.js`, `index.html`, `styles.css` |
| Upload indicator | `api-client.js`, `app.js`, `styles.css` |
| "Thinking" expression / stream indicator | `app.js` (stream + expression hooks), `styles.css` |

## UI Polish goals (human-requested — full detail in `docs/PHASE2_TASKS.md`)
1. **Upload indicator** for project files *and* message attachments — a visual
   cue while an upload is in flight. Open question: real progress bar vs simple
   indeterminate "in progress" spinner. (Note: `fetch` can't report upload
   progress; a real progress bar needs `XMLHttpRequest` in `api-client.js`. An
   indeterminate indicator is much simpler and may be enough — decide with the
   human.)
2. **Streaming "thinking" indicator** (slightly bigger) — add a **`thinking`
   expression phase** to personas so an animated image (e.g. a `.gif`) can play
   while the model is generating, and improve the in-chat streaming indicator to
   match. Keep this **independent of** the human's planned broader expression-
   system overhaul, but compatible with it. Hook: set the thinking expression on
   stream start, restore on stream end / first token / `detectExpression`.
3. **Chat / Personas / Projects tab integration** — today switching sidebar tabs
   keeps the same chat window open, which is confusing and may cause issues.
   **This one needs a design discussion at the start of the session** before
   coding — clarify how the active conversation relates to the active persona and
   selected project, and what each tab should do on switch.
4. **"View sent request" inspector** (advanced / dev-level) — let the user see the
   exact payload sent to the provider (assembled system prompt incl. project
   context, messages, params, prefill, later tool defs), à la RisuAI. The true
   request is assembled server-side, so this likely needs a dry-run/preview
   endpoint rather than client-side reconstruction; never expose the API key.
   Feasibility to be explored in-session.

## Conventions / workflow (important)
- **All task work on a feature branch → PR → `/code-review` → fix findings →
  merge → delete branch** (local + remote, so only `main` survives). Never commit
  features directly to `main`. (Phase 1 had one slip where a commit landed on
  local `main`; it was moved to a branch and `main` reset — avoid by branching
  first.)
- **Verify before merge.** Backend is testable headlessly (in-process Express +
  a temp DB + a forged JWT, mocking providers/Drive — see how Phase 1 tested
  routes). The full UI is behind Google login, so use the Claude_Preview MCP
  (`.claude/launch.json` name `server`, port 3457) for clean-load / computed-
  style / global-function checks; the **human judges visual/interactive behavior
  on the live deploy**.
- **Secrets:** `server/.env` holds gitignored dev stubs — never commit. API keys
  & Drive tokens are encrypted at rest; never log them.
- Commit messages end with the project's `Co-Authored-By` trailer (see git log).

## Phase 2 gotchas (read before coding Tool Use)
- **Tool loop vs streaming is the hard part.** The multi-turn dance (model →
  `tool_use` → execute → `tool_result` → model → … → final) does **not** map
  cleanly onto the current "forward raw provider SSE to the client" model. Plan
  for either (a) running tool turns **non-streaming** server-side and only
  streaming the final answer, or (b) a more involved orchestration that emits
  synthetic events for tool activity. Decide this early (P2-02) — it shapes
  everything. The existing `X-Project-Context-Warning` synthetic-event pattern in
  `api-client.js` is a precedent for surfacing non-SSE info to the client.
- **Provider format differences** are real: Anthropic returns `tool_use` content
  blocks and expects `tool_result` blocks; Gemini uses `functionCall` parts and
  `functionResponse`. Build a small mapping layer (mirror how `buildRequestBody`
  already differs per provider).
- **Reuse, don't reinvent** the Drive + DAL + allow-list plumbing for file I/O,
  and enforce the same size/type limits on model-created files.
- **`Tessera/Downloads/` folder**: add it via `ensureAppFolders` (or a sibling)
  for files created outside any project.
- **Security**: tools execute server-side with the user's Drive auth — validate
  filenames (no path tricks), enforce limits, and keep everything user-scoped.

## First steps
1. `git fetch`, read the orientation docs above.
2. If starting with **UI Polish #3** (tab integration), do the design discussion
   first — don't code until the model of tabs ↔ active conversation is agreed.
3. For **Tool Use**, branch (e.g. `p2-01-tool-defs`), settle the streaming-vs-
   tool-loop approach (P2-02) before building executors, then go down
   `docs/PHASE2_TASKS.md` one branch/PR per task or small group.
4. The **upload indicator (UI #1)** is a good, self-contained warm-up task.
