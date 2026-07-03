# Phase 2 — Tool Use + UI Polish

Detailed task breakdown for Phase 2. Companion to `docs/PHASE2_HANDOFF.md`
(orientation) and the **Phase 2: Tool Use** section of `PLANNING.txt` (the
original spec). Phase 4 in `PLANNING.txt` lists related QoL items.

> **Status (2026-06-28):** Track B (UI polish) is **DONE** (PRs #37–#43:
> top-bar controls, Projects→Workspaces, persona grouping, upload spinner,
> request inspector, thinking indicator). Before Track A, a **Workspace
> Restructure** lands (two-level Workspace ⊃ Project hierarchy, chat separation,
> inline container pages) — see `docs/WORKSPACE_RESTRUCTURE.md`. **Build order
> now: Workspace Restructure (WR-01…06) → Track A (P2-01…06).** Track A file
> destinations become: active project folder → active workspace folder →
> `Tessera/Downloads/` (unfiled).
>
> **Update (2026-07-03):** the Workspace Restructure is complete and
> live-validated (WR-01…07c + the model de-sync work, WR-10…14). Track A was
> re-reviewed against the restructured codebase; its open design questions are
> now settled — see **Decisions** under Track A below.

Two tracks — they can interleave; agree ordering with the human:
- **Track A — Tool Use (File Creation):** the planned Phase 2 feature.
- **Track B — UI Polish:** three human-requested goals from Phase 1 review.

---

## Track A — Tool Use (File Creation)

Goal: let the model create/read/list files mid-conversation, stored on the
user's Google Drive. Tools: `create_file(filename, content, mime_type)`,
`read_file(filename)`, `list_files()`. Provider mapping: Anthropic
`tool_use`/`tool_result`, Gemini `functionCall`/`functionResponse` (OpenAI
later, Phase 3).

### Decisions (settled with the human, 2026-07-03)

1. **File destinations + unfiled storage.** Tool files land in: active
   **project** folder → active **workspace** folder → **`Tessera/Downloads/`**
   (unfiled chat). Project/workspace files record in `project_files` /
   `workspace_files` as usual. Unfiled files get a NEW user-scoped
   **`user_files`** table (mirrors `project_files`) + a download endpoint
   (e.g. `GET /api/files/:id/content`), so Downloads files are just as
   listable/readable/downloadable as the others. (Without this, unfiled
   tool files would exist on Drive but be invisible to `list_files` /
   `read_file` and have no download link.)
2. **Tools toggle.** Advertising tools costs tokens, changes model behavior,
   and errors on models without tool support (users can add arbitrary custom
   models) — so tool use is switchable. **Per-persona base setting** (in the
   persona's `model_config` JSON — no schema change) + **per-conversation
   composer override** (nullable `tools_enabled` column on `conversations`,
   added by migration; `null` = inherit persona). Effective state =
   override ?? persona base. Base default: **off**.
   **UI (second pass, 2026-07-03):** the composer becomes **two rows,
   Claude.ai-style** — textarea on top, a **control row** beneath it: attach
   button, the **file-tools toggle pill** (tinted/filled when on, muted when
   off; tooltip states the effective source), and the **model chip**
   (relocated from the top bar), with send/stop on the right. Attachment
   previews stay above the textarea, so controls never shift. This amends
   WR-07's "model badge always on the top bar": **in a chat** the top bar
   shows only the breadcrumb (model lives in the composer); **while browsing**
   (composer hidden per WR-07b) the top bar keeps the persona selector +
   model badge as today — the model control is never absent, it lives where
   composing happens. The "Press Enter to send" hint line is dropped (or made
   desktop-only) to keep the mobile footprint sane.
3. **Streaming v1.** When tools are enabled for a turn, the server runs the
   whole tool loop **non-streaming** (model → tool call → execute → result →
   … → final) and delivers tool activity + the final answer as **synthetic
   SSE events** over the existing `/api/chat/stream` channel (precedent: the
   `project-context-warning` synthetic event in `api-client.js`). Tools off =
   streaming exactly as today. **Do not over-build v1:** true
   streaming-with-tools (server parses provider SSE while forwarding, detects
   the tool-use stop, executes, opens a continuation stream on the same
   response) is a feasible v2 in this architecture — the v1 event protocol
   should not preclude it, but do not build it now.
4. **Raw-message discipline (provider correctness).** The loop keeps each
   provider's **raw assistant message** and replays it **verbatim** in the
   continuation request. This one rule handles: Anthropic's requirement to
   resend `tool_use` blocks exactly; Anthropic **thinking block** echo
   (+signatures) so extended thinking + tools can coexist; Gemini 2.5
   **`thoughtSignature`** echo on `functionCall` parts; and **parallel tool
   calls** (multiple calls in one response → all results returned in a single
   follow-up message). The common `{ id, name, input }` shape is for executor
   dispatch only — never rebuild provider messages from it.
5. **Prefill is skipped when tools are enabled** (a trailing assistant
   prefill conflicts with the tool-continuation protocol). Note it in the
   toggle's UI copy.
6. **`create_file` semantics.** Validate the **filename extension** against
   `config.projectFiles.acceptedExtensions` (the `mime_type` param is
   advisory — extensions are the reliable signal); enforce `maxFileBytes` on
   the content; **overwrite on duplicate filename** within the destination
   scope (replace the Drive file + update the existing row) so `read_file`
   stays unambiguous and the model can iterate on a file. Content is a JSON
   string, so v1 is text-only by construction.
7. **Context side effect (accepted for v1).** A tool-created project or
   workspace file is a normal file row, so it joins that container's injected
   context on subsequent turns. Acceptable v1 behavior (the model "remembers"
   its files); revisit if it starts eating the context budget.

### Tasks

- **P2-01 — Tool definitions + provider tool contract** (`server/src/tools/`,
  + `providers/anthropic.js`, `gemini.js`)
  Define the tool schemas once. Each provider implements a small contract:
  `formatTools(defs)` → native tools param; `extractToolCalls(response)` →
  `{ calls: [{ id, name, input }], rawAssistantMessage }`;
  `buildToolResultMessage(calls, results)` → native continuation message.
  Thread `tools` through `buildRequestBody` so `/api/chat/preview` (the
  request inspector) shows tool definitions for free. Also move
  `ensureProjectFolderId` / `ensureWorkspaceFolderId` out of
  `routes/projects.js` into a shared module (`utils/drive.js` or the tools
  module) so executors don't import from a sibling route. No execution yet.
  **This contract is the multi-provider mitigation:** Phase 3's OpenAI =
  implement the same three functions in `openai.js`; the loop never changes.

- **P2-02 — Tool execution loop in the chat proxy** (`server/src/routes/chat.js`)
  Implement decision 3 (non-streaming loop + synthetic SSE events:
  tool-activity, final text, done). Refactor `resolveRequestContext` to also
  return the resolved **workspace/project rows** — executors need the
  destination container, not just the assembled context text. Guards: max
  **5 iterations**; check the client-abort signal **between** iterations
  (never execute a tool after the user hits Stop); skip prefill when tools
  are on (decision 5). Toggle plumbing: persona base + conversation override
  resolved server-side. Riskiest task — land it before the executors are
  fully fleshed out (stub executors are fine).

- **P2-03 — Destinations + `create_file` executor**
  Destination resolution per decision 1; add `Tessera/Downloads/` via a
  sibling of `ensureAppFolders`. NEW `user_files` table + DAL + user-scoped
  download endpoint. Validation + overwrite semantics per decision 6. Record
  in the destination's table; return filename + download URL to the model.

- **P2-04 — `read_file` + `list_files` executors**
  Scope mirrors context inheritance: project files first, then workspace
  files; unfiled chats see `user_files` (Downloads). `read_file` extracts
  text via the `projectContext` helpers (text + PDF, cached), returns
  budget-capped content. `list_files` returns DAL metadata. Everything
  user/container-scoped.

- **P2-05a — Composer control row rework** (`app.js`, `index.html`,
  `styles.css`) — **frontend-only; independent of the tool backend, can land
  early or in parallel with P2-01…04.**
  Implement decision 2's UI: two-row composer (textarea + control row);
  attach button moves into the row; **file-tools toggle pill** with visual
  state ("File tools on — persona default" / "…overridden for this chat";
  clicking sets the per-conversation override; persona base edited in the
  persona editor); **model chip** relocated from the top bar; send/stop on
  the right; top-bar contextual logic updated (in-chat: breadcrumb only;
  browsing: persona + model badge as today); drop/trim the Enter hint;
  verify mobile widths. Until P2-02 lands, the toggle can ship dark or
  disabled-with-tooltip — the control row itself doesn't depend on tools.

- **P2-05b — Tool/file rendering** (`app.js`, `index.html`, `styles.css`)
  Tool activity as compact chips ("Created `file.md`" / "Read `spec.txt`");
  created files as downloadable attachment cards with inline preview for
  text/code (reuse attachment-card styling +
  `getFileTypeLabel`/`formatFileSize`). **Persistence:** store tool events in
  the message's existing `attachments` JSON (`type: 'tool_event'` /
  `'created_file'`) so chips and cards survive reload — no schema change.
  Consume the synthetic SSE events like the `project-context-warning`
  precedent.

- **P2-06 — Verify + review + merge**
  Backend: in-process tests of the loop with a mocked provider emitting tool
  calls (single **and parallel**; assert execute → tool_result → final; abort
  + max-iteration guards), plus executor unit tests with mocked Drive. Live
  end-to-end on the deploy: create a file in a **project** chat, a
  **workspace** chat, and an **unfiled** chat (Downloads); run **Anthropic
  with extended thinking on** and **Gemini 2.5** function calling (thought
  signatures). `/code-review`; merge; update memory.

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

- **P2-U4 — "View sent request" inspector** (advanced / dev-level feature)
  Let the user inspect the exact request sent to the provider — messages, the
  **assembled** system prompt (incl. injected project context), model params,
  prefill, and (once Track A lands) tool definitions. Inspired by RisuAI's prompt/
  request inspection. *Feasibility + exact UX to be explored in-session.*
  - **Key design note:** the final payload is built **server-side** (project-
    context prepend in `resolveProjectContext`, prefill appended by the provider
    modules, provider-specific `buildRequestBody`), so the frontend doesn't have
    the true request. Showing the real thing means the server must expose the
    assembled body — recommend a **dry-run/preview path** (e.g.
    `POST /api/chat/preview` that runs the same assembly as `/api/chat` and
    returns the built provider body **without** calling the provider), rather
    than reconstructing it on the client.
  - **Security:** the API key is added as a header server-side and is **never** in
    the request body — keep it that way; the preview must never include it. The
    body does contain the system prompt + project file text (the user's own
    data), which is fine to show the owner.
  - **Frontend:** gate behind an "advanced/developer" toggle (e.g. in Settings);
    surface as a per-message "view request" action or a button that opens a modal
    with pretty-printed JSON (reuse the modal + code-block styling). Showing the
    provider-native body (Anthropic vs Gemini shape) is the most accurate.
  - Pairs naturally with Track A — seeing tool definitions in the payload is
    useful while building tool use.

---

## Suggested order
Track B is done. Track A build order: **P2-01 → P2-02** (the loop is the
riskiest piece — land it on stub executors) → **P2-03 → P2-04 → P2-05b →
P2-06**, with **P2-05a** (composer rework, frontend-only) landing anytime —
early is fine. The streaming approach and all open design questions are
settled in the Decisions section above. One branch/PR per task or small
group, per the project workflow.
