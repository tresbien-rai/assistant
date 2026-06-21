# Phase 1 — Projects (Google Drive file context)

Detailed task breakdown for Phase 1. Companion to `docs/PHASE1_HANDOFF.md`
(orientation) and the Phase 1 section of `PLANNING.txt` (the original spec).

## Goal
A **Projects** system that gives conversations persistent background context
(instructions + files), independent of personas. Files live on the user's
**Google Drive**; the app stores only metadata + Drive file IDs in SQLite.

- A project has a name, optional instructions, and a collection of files.
- A conversation may belong to one project (or none). Any persona can be used.
- When a conversation has a `project_id`, the project's instructions + file
  contents are injected into the model's context.

## Already in place (from Phase 0 — do NOT rebuild)
- **Schema**: `projects`, `project_files` tables (+ indexes) in
  `server/src/db/schema.sql`; `conversations.project_id` nullable FK.
- **DAL**: `createConversation` / `updateConversation` already accept `projectId`.
- **Conversations route**: accepts `projectId` in create body.
- **Auth/Drive**: OAuth requests the `drive.file` scope; `users.drive_token` /
  `drive_refresh` stored **encrypted** (see `utils/encryption.js`);
  `/api/auth/me` returns `hasDriveAccess`. `googleapis` is a dependency.
- **Errors**: `AppError.drive()` → `DRIVE_ERROR` (502); frontend `displayError`
  already routes `DRIVE_ERROR` → critical banner (currently dormant).

---

## Design decisions (locked 2026-06-20)

These were settled at the start of the Phase 1 session and shape the tasks below.
The north star is **a model-agnostic clone of Claude's Projects feature**: a
custom-buildable persistent memory/reference system that works against *any*
provider API (Anthropic, Gemini, OpenAI, …), not just Anthropic.

1. **Knowledge strategy: full-context injection now, retrieval-ready later.**
   v1 downloads the project's files and prepends their contents to the model
   context every turn, guarded by a token/size budget + a user-facing warning
   when the knowledge base is too large. This is identical across all providers
   (no provider-specific retrieval machinery). The injection layer must be
   written as a single, swappable "context assembler" so a future retrieval/RAG
   path (chunking + embeddings + vector store) can replace the "include
   everything" step **without** touching the routes or the frontend.

2. **File-type support: text/code + PDF.** v1 accepts plain text, markdown, and
   source-code files (used verbatim) plus **PDF** (server-side text extraction
   via `pdf-parse`). Other binary types (Office docs, images, etc.) are rejected
   on upload with a clear validation error for now. Multimodal image refs are
   explicitly **out of scope** for v1.

3. **Cost note — prompt caching is a fast-follow, not v1.** Re-injecting a large
   knowledge base every turn is expensive without provider prompt caching
   (Anthropic `cache_control`, Gemini cached content; OpenAI auto-caches). v1
   ships without it; revisit once injection works end-to-end. The budget guard
   in P1-05 keeps costs bounded in the meantime.

4. **Chat route is currently stateless re: conversations.** `POST /api/chat[/stream]`
   receives `messages` + `systemPrompt` from the client and never looks up the
   conversation. P1-05 therefore must thread a `conversationId` (preferred) or
   `projectId` through the chat request bodies so the server can resolve the
   project and assemble context **server-side**. The client must never send file
   contents — it only references the conversation/project by id.

5. **Project delete behavior:** delete the DB rows (cascades to `project_files`)
   **and move the project's Drive folder to trash** (recoverable by the user
   from Drive's trash). `drive.file` scope covers trashing folders the app
   created. Conversations that referenced the project keep working — their
   `project_id` simply resolves to nothing and no context is injected.

6. **Limits live in `config.js`.** Add a `projectFiles` config block (per-file
   upload cap, accepted MIME/extension allow-list, assembled-context budget +
   warning threshold) rather than scattering magic numbers across routes.

---

## Tasks

### Backend — Drive foundation
- **P1-01 — Drive client + token refresh util** (`server/src/utils/drive.js`)
  Build an authenticated `google.auth.OAuth2` client from a user's *decrypted*
  `drive_token` / `drive_refresh`. **Refresh** the access token when expired and
  persist the new one (`dal.updateUserDriveTokens`). Expose helpers:
  `ensureAppFolders(auth)` (creates `AI Assistant/projects/` once, returns IDs),
  `createFolder`, `uploadFile`, `downloadFileText`, `downloadFileBytes`,
  `deleteFile`, `listFiles`. Wrap Drive failures in `AppError.drive()`.
  *Gotcha:* `drive.file` only grants access to files the app itself creates —
  that's correct here; don't expect to browse the user's whole Drive.

- **P1-02 — Project DAL functions** (`server/src/db/dal.js`)
  `createProject`, `listProjectsByUser`, `getProjectById` (user-scoped),
  `updateProject`, `deleteProject`; and `addProjectFile`, `listProjectFiles`,
  `getProjectFile`, `deleteProjectFile`. Enforce `user_id` / project ownership
  on every call (match existing DAL patterns).

### Backend — Projects API
- **P1-03 — Project CRUD routes** (`server/src/routes/projects.js`, mount in
  `index.js`): `GET/POST/PUT/DELETE /api/projects`. On **create**, also create
  the project's Drive folder under `AI Assistant/projects/{name}` and store
  `drive_folder_id`. Delete behavior is fixed per decision #5 (delete DB rows +
  trash the Drive folder). All routes behind `authenticate`.

- **P1-04 — Project file routes**: `POST /api/projects/:id/files` (multipart,
  `multer` is already a dep) → upload to the project's Drive folder → record in
  `project_files`. `GET /api/projects/:id/files` → list from SQLite (cached
  metadata, avoid Drive calls). `DELETE /api/projects/:id/files/:fileId` →
  delete from Drive + DB. Enforce the per-file size cap and the **accepted-type
  allow-list** (text/code + PDF — see decision #2) from the `projectFiles` config
  block (decision #6); reject other types with `AppError.validation`. PDFs are
  stored as-is on Drive; text extraction happens later at injection time (P1-05),
  not on upload.

### Backend — Context injection
- **P1-05 — Inject project context into chat** (`server/src/routes/chat.js` +
  a new context-assembler module, e.g. `server/src/utils/projectContext.js`).
  First thread a `conversationId` (preferred) or `projectId` through the
  `/api/chat` and `/api/chat/stream` request bodies (decision #4) so the server
  can resolve the project itself. When the resolved conversation has a
  `project_id`, the assembler builds: (1) project instructions, (2) text/code
  file contents verbatim, (3) **PDF** contents via `pdf-parse` text extraction —
  all downloaded from Drive on demand and cached (in-memory keyed by
  `drive_file_id`) to limit Drive calls within a conversation. Prepend the
  assembled block **before** the persona's system prompt. Enforce the
  assembled-context budget from config (decision #6): truncate + attach a
  user-facing warning when the knowledge base exceeds it. Keep the "include
  everything" step isolated behind one function so retrieval can replace it later
  (decision #1). Multimodal/image refs are **out of scope** for v1 (decision #2).

### Frontend — client + UI
- **P1-06 — API client + state** (`api-client.js`, `app.js`):
  `API.projects.list/get/create/update/delete` and
  `API.projects.files.list/upload/delete`. Add `state.projects` and
  `state.activeProjectId`; load projects during `init()`.

- **P1-07 — Projects in the sidebar**: a Projects section/tab listing projects
  with a "+ New Project" button. (Sidebar is currently Chats + Personas; the
  Settings tab was moved to a modal — keep that pattern in mind.)

- **P1-08 — Project create/edit modal** (name, instructions). Reuse the existing
  modal system (`.modal-overlay` / `.modal-content`; remember secondary modals
  opened from the settings modal use z-index 250).

- **P1-09 — File management UI**: upload control + file list with
  download/delete inside the project view. Reuse the attachment-card styling
  (`.att-badge` / `.att-icon` / `.att-name`, `getFileTypeLabel`).

- **P1-10 — Wire project into conversations**: project selector when starting a
  new chat; active-project indicator on a conversation; pass `project_id`
  through `API.conversations.create` (already supported server-side).

### Ops / verification
- **P1-11 — Google Cloud / deploy**: confirm **Drive API is enabled** in the
  Cloud project (already a step in `DEPLOY_RAILWAY.md`). `drive.file` is a
  *non-sensitive* scope, so no Google app-verification is required for this use.
  Note: project files live on Drive, **not** the Railway volume (only SQLite +
  avatars are local), so no volume changes are needed. Update
  `DEPLOY_RAILWAY.md` if any new env/setup emerges.

- **P1-12 — Verify + review + merge**: end-to-end test (create project → upload
  file → start a conversation in the project → confirm the file/instructions
  reach the model) on the live deploy; `/code-review`; merge; update memory.

## Suggested order
P1-01 → P1-02 → P1-03 → P1-04 (backend Drive + CRUD first, the most
agent-friendly), then P1-05 (context injection), then P1-06–P1-10 (frontend),
then P1-11–P1-12. Land each as its own branch/PR per the project workflow.
