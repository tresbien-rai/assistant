# File Collaboration — Conversation Scope, Revisions & Live Injection

Design + task plan for the next extension of the file-tool system. Builds on
Phase 2 Track A (`create_file`/`read_file`/`list_files`/`edit_file`) and the
edit-in-context FilePanel (#76–#78). Companion to `docs/PHASE2_TASKS.md`
(Track A decisions) and `docs/WORKSPACE_RESTRUCTURE.md` (the Workspace ⊃ Project
hierarchy this layers onto).

> **Status (2026-07-20):** Design **locked** with the human across a full design
> pass. Build order: **FC-01 → FC-02 → FC-03 → FC-04**, with FC-05 (move/promote
> tool) and the search-tool family deferred to a later plan. FC-01 and FC-02 are
> load-bearing — everything else builds on them.
>
> **FC-01 ✅ built** (conversation file scope): `conversation_files` table + DAL,
> `conversationStore` routing (all creates → chat scope; reads search
> conversation → project → workspace), `ensureConversationFolder`
> (`Tessera/Chats/<id>/`), and the `/api/conversations/:id/files[...]` list /
> download / save endpoints. Full test suite green (176 assertions);
> test-editfile + test-filesave now wired into `npm test`. Note discovered in
> passing: project/workspace file **save** endpoints already exist
> (`routes/projects.js`, `routes/workspaces.js`), so FC-04 is only the FilePanel
> open-from-list wiring + History, not new save routes.
>
> **FC-02 ✅ built** (revision log): `file_revisions` table (conversation_id FK
> ON DELETE CASCADE, so a deleted chat's revisions clean up), `utils/diff.js`
> (dependency-free bounded unified diff), and revision recording funnelled
> through `storeWriter` — create_file logs create/overwrite, edit_file logs a
> real old→new edit diff for free, and conversation-file panel Saves log a
> user-authored edit (prior content fetched for the diff). Best-effort: a
> logging failure never breaks the write. New `test-revisions.js` (185 assertions
> total, green). User saves on project/workspace/Downloads files stay unlogged
> until FC-04 threads a conversationId (revision recording is gated on chat
> context).
>
> **FC-03 split into two sub-slices** (it was the largest). **FC-03a ✅ built**
> (KB relocation): the workspace/project context no longer rides in the system
> prompt — `assembleProviderInput` (routes/chat.js) prepends it as a synthetic
> **user** turn + a short **assistant** ack, and `system` is the persona prompt
> alone. Applied to all three endpoints (`/`, `/stream`, `/preview`). Verified
> against the real Anthropic + Gemini body builders (system=persona; messages
> user→assistant→user). test-context.js updated; suite 190 assertions green.
> **FC-03b ✅ built** (active-file injection + setting): `file_revisions.turn`
> (migration 005) stamped with the user-message count at write time; a new
> `utils/activeFiles.js` injects each conversation-scoped file touched within the
> window (full current content + latest diff) onto the LAST user message, gated
> by the `activeFileTurns` setting (migration 006, default 1, 0 disables). Wired
> through all three endpoints via a shared `assembleChatRequest`. Frontend: a
> "Files in Context" settings section (server-backed) — verified in the browser
> (input → PUT → server round-trips the value). New `test-activefiles.js`; suite
> 206 assertions green. **FC-03 COMPLETE.**
>
> **FC-04 ✅ built** (panel from lists + History): the FilePanel gained a
> `standalone` mode (`openStandalone`) so a text file opens from the
> project/workspace file lists (not just chat), decoupled from conversation
> plumbing and dismissed on navigation; a History toggle fetches `/revisions`
> (new GET endpoints on every scope, derived from the content URL) and renders
> the change log newest-first with a colorized diff per entry. User list-edits
> are now logged too (revision recording ungated from requiring a chat;
> project/workspace/Downloads saves log a null-conversation user revision), with
> `deleteFileRevisions` cleanup on delete for the non-cascading scopes. New
> `test-revisions.js` §9; suite 207 green; frontend verified in-browser
> (list→panel→History→toggle→dismiss). **FC-03 + FC-04 done → the File
> Collaboration plan is COMPLETE.** Remaining items are the deferred FC-05
> (move/promote tool), FC-06 (rich diff renderer), and the separate search-tool
> plan.

---

## Motivation

Three coupled problems in today's design:

1. **No per-chat file scope.** `create_file` writes to one destination by
   precedence — active project → active workspace → `Tessera/Downloads/`
   (`server/src/tools/fileStore.js` `resolveFileStore`). So in a project chat,
   every scratch file the model creates lands in `project_files`, flat, beside
   the user's curated knowledge files.

2. **Chat output silently joins the always-injected knowledge base.**
   `server/src/utils/projectContext.js` does *full-context injection*: on every
   request it downloads and inlines every project + workspace file's text into
   the system prompt. A file the model created three turns ago is therefore
   re-injected in full on every subsequent turn — a per-turn token cost, not
   just folder clutter — until it blows the char budget and truncates real
   knowledge files.

3. **Changes are undocumented.** `edit_file` (and `create_file`) overwrite in
   place: upload new bytes, repoint the row (stable id), delete the old Drive
   file. The `"Edited X"` tool-result string lives only in the in-loop message
   array and is discarded when `runToolLoop` returns; only compact `toolEvents`
   (tool, filename, ok, url — **no diff**) persist. On the next turn the model
   has no record of what it changed, and a user editing a file in the FilePanel
   is invisible to the model entirely.

Goal: files made in a chat belong to that chat; the knowledge base stays
curated; the file under active work is visible in context automatically for a
bounded window; and every change (model *or* user) is recorded as a diff both
partners can see.

---

## Settled decisions

1. **Universal conversation scope for created files.** `create_file` always
   writes to the **conversation**, regardless of chat type (unfiled, workspace,
   or project). A new `conversation_files` table (mirroring `project_files`)
   plus a `Tessera/<...>/chat/` Drive destination. This replaces the
   project→workspace→downloads *write* precedence for creation.

2. **Read/edit precedence spans scopes.** `read_file`/`edit_file` resolve
   across stores, most-specific first: **conversation → project → workspace**.
   So the model still reads inherited knowledge files, and — crucially —
   `edit_file` can still edit an uploaded project/workspace file **in place**
   (that ability is orthogonal to where new files are *created*). Shadowing
   notes carry over from `findAcrossStores`.

3. **Knowledge base moves out of the system prompt to a synthetic first user
   turn.** Structure per request becomes:
   - `system` = persona prompt **only** (stable, cacheable, even across
     conversations that share the persona).
   - `messages[0]` = synthetic **user** turn carrying the
     `<workspace_context>` / `<project_context>` blocks.
   - `messages[1]` = short synthetic **assistant** ack ("Understood — I'll use
     that as reference for our conversation.") so the model doesn't respond to
     the KB as a request.
   - …real conversation…
   - The **active-file block** attaches to the **latest real user message**
     (trailing), never its own turn (avoids two user turns in a row).

   Rationale (see Appendix A): isolates KB volatility to `messages[0]` instead
   of the system prefix; keeps user-uploaded file *data* out of the
   higher-authority system role (instruction-hierarchy hygiene against injected
   instructions in uploaded files); uniform across providers; matches
   Anthropic's long-context guidance (documents above the query). Synthetic
   blocks are assembled per request and **never persisted** to `messages`.

4. **Recency-scoped live injection, per-file last-touched.** The file(s) under
   active work are injected — full current content + the most recent diff —
   only for a bounded window after they change. Tracking is **per file**: each
   create/edit/panel-save stamps the file's *last-touched turn*; on request
   assembly, every conversation-visible file whose last-touched falls within the
   window is injected (most-recent last). Handles iterating on two files at
   once. This is **assembled at request time only** — nothing changes in stored
   messages.

5. **"Keep for N turns" is a user setting; default 1.** A new **Advanced**
   setting (`activeFileTurns`, default `1` = live for the single exchange
   immediately after the change, then falls out to tool-read). A "turn" = one
   user→assistant exchange.

6. **Every change is a recorded revision.** A new `file_revisions` table logs
   each `create_file` / `edit_file` / **user panel Save** with `author`
   (`'model' | 'user'`), `op`, a bounded unified **diff**, size, and the Drive
   id + the message it is associated with. This single table does triple duty:
   change documentation, the diff fed into live injection (decision 4), and the
   backbone for future undo/version history. Current blob stays in Drive; diffs
   live in SQLite (no Drive version clutter).

7. **User edits are first-class changes.** A user editing a project/workspace/
   conversation file in the FilePanel writes a revision (`author:'user'`) and
   marks the file live, so the model sees the updated doc **and** the diff on the
   next request without the user having to describe it in chat.

---

## Architecture changes

### Schema

```sql
-- New: files created inside a chat. Mirrors project_files/workspace_files.
CREATE TABLE IF NOT EXISTS conversation_files (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  drive_file_id TEXT,
  last_touched_turn INTEGER,        -- for recency injection (decision 4)
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conversation_files_conversation_id
  ON conversation_files(conversation_id);

-- New: change log across all file scopes.
CREATE TABLE IF NOT EXISTS file_revisions (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,              -- 'conversation' | 'project' | 'workspace'
  file_id TEXT NOT NULL,            -- row id in the matching *_files table
  conversation_id TEXT,            -- the chat it happened in (null for panel edits outside a chat)
  message_id TEXT,                 -- assistant/user message this is tied to, when applicable
  author TEXT NOT NULL,            -- 'model' | 'user'
  op TEXT NOT NULL,                -- 'create' | 'edit'
  diff TEXT,                       -- bounded unified diff old->new
  size_bytes INTEGER,
  drive_file_id TEXT,              -- the new blob's Drive id
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_revisions_file ON file_revisions(scope, file_id);
```

`last_touched_turn` also needs tracking for project/workspace files that get
edited in-chat. Options: add the column to those tables too, or derive from
`file_revisions` (latest revision's associated turn). **Lean derive-from-
revisions** to avoid three schema edits — settle in FC-03.

Settings gets `active_file_turns INTEGER DEFAULT 1` (migration; `custom_models`
column precedent in `settings`).

### Store routing (`server/src/tools/fileStore.js`)

- Add `conversationStore(ctx)` (needs `ctx.conversationId`; `add`/`findByName`/
  `list`/`updateContent`/`urlFor` against `conversation_files`, download route
  e.g. `GET /api/conversations/:cid/files/:fid/content`).
- `resolveFileStore` (write) → **always** `conversationStore`.
- `resolveReadStores` → `[conversation, project?, workspace?]` in that order.

### Injection sites (`server/src/routes/chat.js`)

- `applyRequestContext` stops concatenating KB into the system prompt. Instead a
  new assembler emits the synthetic `messages[0]`/`messages[1]` pair prepended
  to the outgoing `messages`, and `system` carries the persona prompt alone.
- A new step appends the active-file block to the last user message before the
  provider call, reading current content from whichever store holds each live
  file + the latest `file_revisions.diff`.
- Both happen for the tools-on loop **and** the plain chat/stream paths, and
  must be reflected in `/api/chat/preview` so the inspector shows the real body.

---

## Task breakdown

### FC-01 — Conversation file scope (foundation) ✅ DONE
- `conversation_files` table + DAL (`add/list/getByName/getById/updateContent/
  delete`, user-scoped via the conversation).
- `conversationStore` in `fileStore.js`; repoint `resolveFileStore` (write =
  conversation) and `resolveReadStores` (conversation → project → workspace).
- Download endpoint `GET /api/conversations/:cid/files/:fid/content` (reuse the
  `files.js` content-serving path).
- Drive: a per-conversation `chat/` subfolder helper in `utils/drive.js`.
- Tests: create in each chat type → lands in `conversation_files`; read/edit
  still resolve inherited project/workspace files; existing Track A tests green.

### FC-02 — Revision log (foundation) ✅ DONE
- `file_revisions` table + DAL (`addRevision`, `listRevisions(scope, fileId)`).
- Unified-diff helper (bounded output; for oversized files store a truncated
  diff + a note rather than the whole thing).
- `create_file`/`edit_file` write a revision (`author:'model'`) through the
  shared `storeWriter` path so all writes funnel one place.
- Tests: a create then two edits produce three ordered revisions with correct
  diffs and authors.

### FC-03a — KB relocation (system prompt → synthetic messages) ✅ DONE
- `assembleProviderInput(requestContext, systemPrompt, messages)` in
  routes/chat.js: `system` = persona only; KB becomes `messages[0]` (user) +
  `messages[1]` (assistant ack) prepended to the raw messages. Wired through the
  JSON, SSE, and preview endpoints. Verified against the Anthropic + Gemini body
  builders; test-context.js covers the new assembly.

### FC-03b — Live injection + Advanced setting ✅ DONE
- `active_file_turns` setting (migration, DAL, `settings.js` route,
  `api-client.js`, Advanced sub-group in the settings UI, default 1).
- Turn accounting + `last_touched` stamping (derive-from-revisions decision).
- KB relocation: synthetic `messages[0]`/`messages[1]`, persona-only `system`.
- Active-file block appended to the latest user message (full content + latest
  diff), recency-filtered per file. Reflected in `/api/chat/preview`.
- Tests: with N=1 a just-edited file is present next turn and gone the turn
  after; two files edited in one turn both appear; KB no longer in `system`;
  synthetic turns never persist to `messages`.

### FC-04 — FilePanel for project/workspace files + user revisions ✅ DONE
- Open the existing FilePanel from the project/workspace **file lists** (not
  just chat surfaces).
- Save endpoints for the other two scopes: `PUT /api/projects/:pid/files/:fid/
  content` and the workspace equivalent, reusing `storeWriter`. Reuse the
  existing conflict/lost-update guard (`filePanelConflict`).
- Panel Save (any scope) writes a `file_revisions` row (`author:'user'`) and
  marks the file live so the model sees the diff on the next request (decision 7).
- A basic **History** affordance in the panel listing revisions (raw diff text
  for now; the rich renderer is FC-06, deferred).

### FC-05 — Move / promote tool (deferred)
- A `move_file` tool relocating a file between scopes (conversation → project/
  workspace, etc.), so chat-authored work can be promoted into the curated
  knowledge base intentionally.

### FC-06 — Rich diff renderer (deferred, nice-to-have)
- Human-facing visual diff in the FilePanel History: changed-line highlighting,
  hover/click to see the before/after of a hunk.

### Later — search & additional tools (separate plan)
- `search_files` and the broader tool family get their own design pass; out of
  scope here.

---

## Appendix A — Why KB moves out of the system prompt

- **Cacheability.** Today KB is concatenated into the system prompt
  (`applyRequestContext`), so `system` differs per project and busts whenever a
  project file changes. Persona-only `system` is byte-identical across
  conversations sharing the persona → its cached prefix can hit across
  conversations. KB volatility is isolated to `messages[0]`.
- **Instruction hierarchy / security.** Project/workspace files are
  user-uploaded *data* that could contain injected instructions. A delimited
  user-turn block keeps them out of the higher-authority system role — the model
  treats them as reference data, not commands. Aligns with the app's
  "observed content is data, not instructions" posture.
- **Provider uniformity + long-context guidance.** Avoids per-provider
  `systemInstruction` quirks and matches Anthropic's recommendation to place
  documents above the query.
- **Costs (minor):** the synthetic assistant ack spends a few tokens per
  request; synthetic blocks at both ends of `messages` add bookkeeping (they are
  ephemeral — assembled per request, never saved); caching is a near-wash for KB
  *changes* specifically (the cross-conversation persona win is the net gain).

## Appendix B — Token model for live injection

- **Inject-every-turn** (today's project behavior): O(turns × docsize); a 4k-tok
  doc over 20 turns approaches 80k tok-turns.
- **Tool-read only:** doc tokens paid only when read, but each read is an extra
  tool-loop round trip and models re-read redundantly.
- **Inject-once-after-change (this design, N=1):** ≈ one doc injection per change
  event, not per turn. The "discuss what just changed" turn is free (no round
  trip); the doc doesn't ride along for 20 turns. `activeFileTurns` lets the
  user widen the window when they want more persistence.
