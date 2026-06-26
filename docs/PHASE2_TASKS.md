# Phase 2 — Tool Use + UI Polish

Detailed task breakdown for Phase 2. Companion to `docs/PHASE2_HANDOFF.md`
(orientation) and the **Phase 2: Tool Use** section of `PLANNING.txt` (the
original spec). Phase 4 in `PLANNING.txt` lists related QoL items.

Two tracks — they can interleave; agree ordering with the human:
- **Track A — Tool Use (File Creation):** the planned Phase 2 feature.
- **Track B — UI Polish:** three human-requested goals from Phase 1 review.

---

## Track A — Tool Use (File Creation)

Goal: let the model create/read/list files mid-conversation, stored on the
user's Google Drive (in the active project, or a `Tessera/Downloads/` folder).
Tools: `create_file(filename, content, mime_type)`, `read_file(filename)`,
`list_files()`. Provider mapping: Anthropic `tool_use`/`tool_result`, Gemini
`functionCall`/`functionResponse` (OpenAI later, Phase 3).

- **P2-01 — Tool definitions + provider mapping** (`server/src/tools/` or
  `utils/tools.js`, + `providers/anthropic.js`, `gemini.js`)
  Define the tool schemas once, then translate them into each provider's format
  in `buildRequestBody`. Parse each provider's tool-call response back into a
  common shape `{ name, input, id }`. No execution yet — just advertise tools and
  detect calls.

- **P2-02 — Tool execution loop in the chat proxy** (`server/src/routes/chat.js`)
  **Decide the streaming strategy first** (see handoff gotcha): recommended v1 =
  run tool turns **non-streaming** server-side (model → tool_use → execute →
  tool_result → loop), then stream (or return) only the final assistant message.
  Add a max-iterations guard. Thread the existing project resolution through so
  tools know the active project. This is the riskiest task — land it before the
  executors are fully fleshed out.

- **P2-03 — `create_file` executor**
  Validate filename + type against the `config.projectFiles` allow-list and size
  cap. Upload via `drive.uploadFile` to the active project's folder (reuse the
  self-heal path) or to a `Tessera/Downloads/` folder (add to `ensureAppFolders`)
  when there's no project. Record in `project_files` via `dal.addProjectFile`.
  Return a result the model can reference (filename + a download URL using the
  existing `/files/:id/content` endpoint).

- **P2-04 — `read_file` + `list_files` executors**
  `read_file`: resolve by filename within the project, extract text via the
  `projectContext` helpers (text + PDF), return content (budget-guarded).
  `list_files`: return `dal.listProjectFiles` metadata. Both user/project-scoped.

- **P2-05 — Frontend tool/file rendering** (`app.js`, `index.html`, `styles.css`)
  Show tool activity in the conversation (e.g. a compact "Created `file.md`" /
  "Read `spec.txt`" chip) and render created files as downloadable attachments
  with inline preview for text/code (reuse attachment-card styling +
  `getFileTypeLabel`/`formatFileSize`). If P2-02 uses synthetic events, consume
  them like the `project-context-warning` precedent.

- **P2-06 — Verify + review + merge**
  Backend: in-process tests of the tool loop with a mocked provider that emits a
  tool call (assert execute → tool_result → final), plus executor unit tests with
  mocked Drive. Live end-to-end on the deploy (ask the model to create a file →
  confirm it lands in Drive + the project). `/code-review`; merge; update memory.

---

## Track B — UI Polish (human-requested)

- **P2-U1 — Upload in-progress indicator** (`api-client.js`, `app.js`,
  `styles.css`)
  Show a visual cue while project-file **and** message-attachment uploads are in
  flight. **Decision needed:** indeterminate spinner (simple — disable control +
  spinner, works with the current `fetch` upload) vs a real progress bar (needs
  switching uploads to `XMLHttpRequest` for `upload.onprogress`). Recommend
  starting with the indeterminate indicator unless the human wants true progress.
  Cover both the project modal upload and the composer attachment flow.

- **P2-U2 — Streaming "thinking" indicator + persona `thinking` expression**
  (`app.js`, `styles.css`; touches the expression system)
  Add a **`thinking`** expression phase to personas so an animated image
  (e.g. `.gif`) can play while the model generates. Set it on stream start;
  restore the normal/detected expression on first token or stream end. Also
  improve the in-chat streaming indicator to match (the current
  `showTypingIndicator`). Keep this **independent of** the human's planned
  broader expression-system overhaul but compatible with it (don't hard-code
  assumptions that would block that). *Slightly larger task — may warrant its own
  small design note first.*

- **P2-U3 — Chat / Personas / Projects tab integration** (design-first)
  Today switching sidebar tabs keeps the same chat window open, which is
  confusing and may cause issues. **Start with a design discussion** (no code
  until agreed): clarify how the active conversation relates to the active
  persona and the selected project, what each tab should show/do on switch, and
  whether the chat view should change context. Then implement the agreed model.

---

## Suggested order
Settle Track B #3's design early (it may influence other UI work). A good build
order: **P2-U1** (small, self-contained warm-up) → **P2-01 → P2-02** (lock the
tool-loop/streaming approach) → **P2-03 → P2-04 → P2-05 → P2-06**, with **P2-U2**
and **P2-U3** interleaved per the human's priority. One branch/PR per task or
small group, per the project workflow.
