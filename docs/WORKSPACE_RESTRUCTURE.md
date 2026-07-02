# Workspace Restructure — design + tasks

Agreed plan (2026-06-28) to rework the workspace model **before Track A (Tool
Use)**. Supersedes the workspace/sidebar parts of `docs/PHASE2_UX_DESIGN.md`
(the flat "Projects → Workspaces" model shipped in PRs #39/#40). Decided with
the human; this is the source of truth for the restructure.

## Why (three problems with the current flat model)
1. **Chat separation.** Today the home list shows *all* chats grouped by persona
   regardless of workspace, so a workspace chat opened from the Chats tab is
   viewed while the top-bar chip says "No workspace" — the `projectId` context
   still applies server-side, but the UI misrepresents where you are. Chats must
   live in exactly one container and not leak across it.
2. **Settings in a modal.** Editing instructions/files happens in a modal; it
   should live inline in the main area (Claude.ai-style), so a workspace/project
   is a *place* you open, not a dialog.
3. **No grouping of related projects.** A flat list can't express "a Vibe Coding
   space with shared house-style instructions + several coding projects under
   it." Need a container above projects.

## Target model (two levels + unfiled)

Hierarchy: **Workspace ⊃ Project ⊃ Chat**, plus **unfiled** chats at home.

- **Workspace** (NEW outer container): general/shared instructions + reference
  files. Contains Projects. Can also hold **workspace-level chats** directly.
- **Project** (the existing entity, now nested): specific instructions + files +
  its own chats. A project belongs to exactly one workspace.
- **Chat** lives in one of three homes:
  - **Unfiled** → the home **"Chats"** area (persona-grouped, as today). Indicator: **"No workspace"**.
  - **Workspace-level** (workspace, no project) → inherits the workspace's instructions + files only. Indicator: **"<Workspace>"**.
  - **Project-level** (project, within a workspace) → inherits **workspace + project** instructions + files. Indicator: **"<Workspace> › <Project>"**.
- **Context inheritance**: workspace context is layered **first**, then project,
  then the persona system prompt (extends the current `resolveProjectContext` /
  `applyProjectContext` ordering).
- **Naming**: outer = **Workspace**, inner = **Project** (reclaims the "Project"
  label; the UI "Workspaces" label from #39/#40 now refers to the new outer
  containers). Unfiled stays **"Chats" / "No workspace"**.

## UX

- **Chat separation (Issue 1):** the home **Chats** tab shows *only* unfiled
  chats (still persona-grouped). A workspace/project shows *only* its own chats.
  No cross-container leakage.
- **Top bar = breadcrumb indicator, NOT a switcher (Issue 1):** shows
  `No workspace` / `<Workspace>` / `<Workspace> › <Project>`. Clicking it opens
  that container's inline page. You change context by navigating the sidebar, not
  a dropdown. (Replaces the `showWorkspaceMenu` switcher chip.)
- **Inline container pages (Issue 2):** the main area is **container-aware** with
  two modes:
  - **Container page** (when a workspace/project is open with no chat selected):
    editable name + instructions + files inline; a workspace page also lists its
    **projects** and **workspace-level chats** with "New project" / "New chat
    here"; a project page shows its chats + "New chat" and notes inherited
    workspace context. Replaces the edit **modal**.
  - **Chat** (when a chat is open): the conversation, as today. Get back to the
    page via the breadcrumb or sidebar.
  - **Tiny create step:** creating a workspace/project asks only for a name, then
    lands on its inline page to fill in instructions/files. (Only remaining
    dialog; the full edit modal goes away.)
- **Sidebar:** two tabs — **Chats** (unfiled, persona-grouped) and
  **Workspaces** (drill-in nav: workspaces list → enter a workspace → its
  projects + workspace-level chats → enter a project → its chats; with back
  affordances mirroring the breadcrumb).
- See the in-session mockup for the inline workspace/project pages + create step.

## Data model + migration

- **`workspaces`** (NEW): `id, user_id, name, instructions, drive_folder_id,
  created_at, updated_at`.
- **`projects`**: ADD `workspace_id` (FK → workspaces.id, required going
  forward). Keeps its own `name, instructions, drive_folder_id`, files.
- **`conversations`**: ADD `workspace_id` (nullable). Keep `project_id`
  (nullable). Invariant: project-level chats set **both** (`workspace_id` = the
  project's workspace); workspace-level set only `workspace_id`; unfiled set
  neither. (Storing `workspace_id` on the row keeps scoping queries simple.)
- **Drive layout:** `Tessera/<Workspace>/` for workspace reference files, with a
  subfolder `Tessera/<Workspace>/<Project>/` per project. (Plus `Tessera/Downloads/`
  for unfiled tool-created files — added in Track A.) Current Phase-1 projects live
  under `Tessera/projects/<project>` — migration must re-map or move.
- **Migration (small dataset — experiment):** backfill a per-user default
  workspace (e.g. "General") and attach all existing `projects` to it; backfill
  each existing conversation's `workspace_id` from its project's new workspace.
  Unfiled conversations stay unfiled. Move/relink Drive folders accordingly.
  Finalize the exact strategy at implementation time. Use a real migration
  (better-sqlite3; the DAL is abstracted for a future Postgres move).

## Task breakdown (one branch/PR each, verify via dev-login)

- **WR-01 — schema + DAL + migration.** `workspaces` table; `projects.workspace_id`;
  `conversations.workspace_id`; DAL CRUD for workspaces + nested projects; the
  backfill migration. Headless tests.
- **WR-02 — backend routes + context layering + Drive.** Workspaces CRUD;
  projects nested under a workspace; extend context assembly to layer
  workspace→project→persona; workspace/project Drive folder creation + the new
  layout. Update `/api/chat` + `/api/chat/preview` resolution.
- **WR-03 — chat separation + creation context (frontend).** Chats tab = unfiled
  only; conversation create sets `workspace_id`/`project_id` from the open
  container; remove cross-container leakage. (Builds on the persona grouping.)
- **WR-04 — sidebar drill-in nav + breadcrumb indicator.** Workspaces tab
  drill-in (workspace → projects + workspace chats → project → chats);
  replace the top-bar switcher chip with the breadcrumb indicator.
- **WR-05 — inline container pages + tiny create step.** Main-area
  container-aware pages (workspace + project) replacing the edit modal; inline
  instructions/files editing; minimal name-only create dialog.
- **WR-06 — verify + review + migration test.** End-to-end via dev-login (the
  stub user has no Drive, so file bits need the human on the live deploy);
  migration tested against a copy of real data; `/code-review`; merge.

## Sequencing
**Restructure first, then Track A (Tool Use).** Tool-created files must target
the right workspace/project Drive folders, so the hierarchy lands before tool
executors are built. After WR-06, resume Track A (`docs/PHASE2_TASKS.md`) on the
new model — tool file destinations = active project folder → active workspace
folder → `Tessera/Downloads/` (unfiled).

## Carryover decisions (already settled)
- Chats live in **both** workspace-level and project-level (plus unfiled).
- Inline pages **replace** the modal; keep only a name-only create step.
- Indicator is a **breadcrumb**, not a switcher.
- Unfiled area named **"Chats" / "No workspace"**.

## Progress (status log)

- **WR-02 was split** into **WR-02a** (instructions-layering + Drive folders) and
  **WR-02b** (workspace reference files: `workspace_files` table + upload routes +
  folding files into context) — a scoping decision made because WR-01 created no
  `workspace_files` table. Both shipped.

| Task | Status | PR | Notes |
|------|--------|----|-------|
| WR-01 schema + DAL + migration | ✅ merged | #45 | migration runner + `workspaces` + backfill |
| WR-02a routes + context layering + Drive | ✅ merged | #46 | `/api/workspaces`, layered ctx, best-effort Drive folders |
| WR-02b workspace files | ✅ merged | #47 | `workspace_files`, `/api/workspaces/:id/files`, shared assembler |
| WR-03 chat separation + creation context | ✅ merged | #48 | conv `workspace_id` (derived from project), home = unfiled only |
| WR-04 drill-in sidebar + breadcrumb | ✅ merged | #49 | two-level drill-in, breadcrumb indicator (frontend) |
| WR-05 inline container pages + create step | ✅ merged | #50 | inline pages, ws file UI, name-only create |
| WR-06 verify + review + migration test | ✅ live-validated | — | live Drive upload + migration confirmed working by the human (2026-07-01) |
| WR-07a nav shell (rail + router + top bar) | ✅ merged | #51 | section rail, main-area router, contextual top bar, width fix |
| WR-07b Settings as main-area section | ✅ merged | — | settings form re-parented into a router view; composer/avatar hidden off-chat |
| WR-07c Personas as main-area section | ⬜ next | — | main-area personas list + manage |

**WR-05 done (delivered against the WR-04 bridges):**
- Container editing is now an **inline page in the main area** (`renderContainerPage`
  in app.js), replacing the `#projectModal`/`#workspaceModal` edit modals (removed).
  Driven by `state.ui.openContainer = { kind, id }`; `renderConversation` hands off
  to the page when set, and opening a chat clears it (decoupled from the active chat).
  - **Workspace page:** editable name + instructions (+ Save) + reference files +
    its projects ("New project") + workspace-level chats ("New chat here").
  - **Project page:** editable name + instructions + files + inherited-context note
    ("Inherits `<Workspace>` context") + its chats ("New chat").
- **Workspace file upload UI** landed (generic `loadContainerFiles` / `uploadContainerFiles`
  / `deleteContainerFilePrompt` over `API.workspaces.files` + `API.projects.files`).
- The **breadcrumb** segments + the sidebar **"Edit instructions & files"** buttons
  (project *and* workspace) now open the inline page via `openContainerPage`.
- **Name-only create step** (`#nameModal` + `promptName`): create asks only for a
  name, then lands on the new container's inline page. The full edit modals are gone.
- Verified via dev-login: open WS/project pages from breadcrumb + sidebar; edit +
  Save persists to state and server; drill WS→project page + back crumb; name-only
  create → drops onto the new project's page; zero console errors; backend suite
  green (frontend-only). File *upload* needs the human on the live deploy (the
  dev-login stub user has no Drive — carried to WR-06).

**WR-06 (next):** end-to-end verify on the live deploy (incl. real Drive file
upload for workspace + project pages), migration tested against a copy of real
data, `/code-review`, then merge the WR-04→WR-05 stack.

**Then Track A (Tool Use)** resumes on the new model (`docs/PHASE2_TASKS.md`):
tool file destinations = active project folder → active workspace folder →
`Tessera/Downloads/` (unfiled). Drive layout helpers live in `server/src/utils/drive.js`
(`ensureWorkspaceFolder`, plus `ensureProjectFolderId` in `routes/projects.js`).

## WR-07 — navigation consolidation (UX rework)

Added after live-deploy feedback (2026-06-30): WR-04/05 left **two competing
navigation metaphors** — the sidebar's own drill-in *and* WR-05's main-area pages.
The main area had no *list* views (lists lived only in the sidebar), so a page's
"‹ Back" had nowhere to land and fell back to the last chat — disorienting. Fix:
**one metaphor.**

**Target model (decided with the human 2026-06-30):**
- **Sidebar = a thin section rail**, not a content panel: **Chats · Workspaces ·
  Personas · Settings**. Clicking a section switches the main area; the rail just
  navigates between top-level sections.
- **Main area = a single content router** (`state.ui.mainView`). It shows lists
  *and* detail: chats list → a chat; workspaces list → workspace page → project
  page → a chat; (later) personas list; settings. "Back" returns to the list in
  the main area — a real destination. **Decision: single router** (not a
  persistent list column) — coherent, identical on desktop + mobile; the one cost
  (a chat-switch is list→pick, one extra click) was accepted.
- **Contextual top bar** (de-crowds it; enforces the locked "persona is fixed per
  conversation" rule):
  - **model badge — always** (quick model-switch without opening Settings; the
    human explicitly wants this on the bar).
  - **in a chat:** + the **workspace breadcrumb** (where this chat lives → jump back).
  - **browsing (no chat open):** + the **persona selector** (who the *next* chat
    will be) instead of the breadcrumb. Only one of {breadcrumb, persona} shows.
- **Container-page width:** workspace + project pages share `.container-page`
  (was 620px) — widen to ~720px (point-2 feedback: align + use desktop real estate).

**Staging (one PR each):**
- **WR-07a — shell + the pain fix.** Sidebar tabs → section rail; main-area router
  (`mainView`); Chats list + Workspaces list move into the main area; back-crumbs
  land on lists (WR-05 container pages become the workspace/project detail views);
  contextual top bar; width fix. Personas + Settings rail items keep opening the
  current popover/modal **as an interim** so the rail is complete.
- **WR-07b — Settings as a full main-area section** (relocate the `#settingsModal`
  content into a router view).
- **WR-07c — Personas as a full main-area section** (list + manage; the top-bar
  persona popover stays for quick-switch).

WR-06 (live Drive/migration verify) is independent of WR-07 and can land anytime.
