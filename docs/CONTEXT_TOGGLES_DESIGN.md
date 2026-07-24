# Context toggles — design note

Per-file control over what actually rides in the prompt: a checkbox on every
knowledge file (workspace / project) and an inject-mode control on every chat
working file. Layers onto the File Collaboration system
(`docs/FILE_COLLAB_DESIGN.md`) and the workspace hierarchy
(`docs/WORKSPACE_RESTRUCTURE.md`).

> **Status (2026-07-24):** Design **locked** with the human. Four decisions
> settled: "off" = *excluded but listed*; toggles live in **both** places,
> layered; chat working files get **auto / pin / mute**; the "forgot I disabled
> it" failure is answered by a **persistent count badge on the top-bar files
> button** (human's idea, CT-06) rather than a toast. Prompt-cache invalidation
> on toggle was reviewed and accepted as a fair trade. Nothing built yet. Build
> order below (CT-01 → CT-06).

---

## Motivation

Today every file in a chat's workspace and project is downloaded, extracted, and
injected in full on **every single turn**, capped only by a 500k-char budget
(`projectContext.js`, `config.projectFiles.contextBudgetChars`). There is no way
to say "not this one, not right now."

That is fine with three files. It stops being fine the moment a workspace is a
real knowledge base:

1. **Cost and latency.** Every turn re-sends everything. A 200k-char workspace
   costs ~50k tokens per turn whether or not the conversation touches it.
2. **Attention dilution.** A chat about the magic system is reading the trade-route
   gazetteer on every turn. Irrelevant material measurably degrades the answer.
3. **Silent truncation.** Once the budget is hit, `gatherFileTexts()` truncates
   and skips in **upload order** — an arbitrary rule the user has no say in. The
   warning tells you it happened; nothing lets you choose *what* got cut.
4. **No per-chat variation.** Two chats in the same project always get byte-for-byte
   the same knowledge base, even when one of them is about something else entirely.

Automatic retrieval (chunk + embed + top-k) is the eventual answer to (1) and (2),
and `gatherFileTexts()` was deliberately isolated as the swap point for it. But
retrieval does not remove the need for this feature — it *changes what the toggle
gates*. "Off" becomes "excluded from the retrieval index" rather than "excluded
from the prompt." The user-facing control is the same, and it is useful now,
years before the index exists.

### Worked example

> A worldbuilding workspace holds `geography.md`, `magic-system.md`,
> `characters.md`, `trade-routes.md`, and a 400k-char `lore-dump.pdf`.
>
> `lore-dump.pdf` is toggled **off at the workspace level** — it's an archive, and
> loading it alone eats the whole budget. It stays listed, so the model can pull it
> in when it genuinely needs a citation.
>
> In a chat about a duel scene, the user unchecks `trade-routes.md` and
> `geography.md` **for that chat only**. The other four chats in the project are
> unaffected.
>
> The duel chat's own draft, `duel-scene.md`, is **pinned** — it stays fully
> injected every turn instead of falling out of the recency window after one turn.

---

## Settled decisions

### 1. "Off" means excluded-but-listed, not invisible

A disabled knowledge file's **content** is dropped. Its **name** still appears in
a one-line manifest inside the same context block:

```
<available_files>
The following files exist but are not loaded into this conversation. Call
read_file with the exact name if you need one: lore-dump.pdf, trade-routes.md
</available_files>
```

Cost is roughly one line per disabled file — negligible against the content it
replaces. The payoff is that a wrong toggle is *recoverable mid-conversation*:
the model notices it needs the file and fetches it, instead of confidently
answering from a gap it can't see.

**The manifest is emitted only when file tools are enabled for that request.**
With tools off, `read_file` doesn't exist, so naming an unreachable file is pure
noise and an invitation to hallucinate its contents. Tools-off requests get
silence — the file is genuinely invisible.

This also means `list_files` must report state, not just names (see CT-02).
A model that lists files, sees `trade-routes.md`, and finds no matching content
in context should be told *why*, not left to guess.

### 2. Two layers: container default, chat override

Matches the existing tri-state pattern (`conversations.tools_enabled`,
`conversations.scratchpad_enabled`) — a durable default with a per-chat override.

| Layer | Stored as | Meaning |
|---|---|---|
| Container default | `project_files.enabled` / `workspace_files.enabled` (1/0) | The file's default for every chat in that container |
| Chat override | a row in `conversation_context_overrides` | This chat deviates from the default |

Resolution: **chat override → container default → on**.

An override row exists *only* when the chat deviates. "Reset to default" is a
DELETE, not a write — which means changing the container default automatically
propagates to every chat that hasn't explicitly disagreed. That is the behaviour
you want: flipping `lore-dump.pdf` off at the workspace level should turn it off
everywhere except the two chats where you deliberately turned it back on.

### 3. Chat working files get auto / pin / mute, not on/off

Chat files are not always-injected. `activeFiles.js` injects a file only for
`activeFileTurns` turns after its last create/edit, then it drops out and the
model reads it on demand. So on/off is the wrong axis:

| Mode | Behaviour | Use |
|---|---|---|
| **Auto** (default) | Current recency-window behaviour | Everything, normally |
| **Pin** | Injected in full every turn, regardless of age | The document you're actively co-writing over many turns |
| **Mute** | Never injected, even immediately after an edit | A big generated artifact you don't want re-sent |

Pin is the more valuable half. The recency window exists because always-injecting
every chat file would be ruinous, but there is usually exactly one file that *is*
the conversation — and today it silently falls out after one turn.

Pin respects the existing caps in `activeFiles.js` (`MAX_ACTIVE_FILES = 5`,
`MAX_CONTENT_CHARS`), with pinned files taking priority over recency-window files
when both compete for those slots.

### 4. Toggles are live settings, not conversation history

Toggling does not create a revision, does not appear in the change log, and is
not rewound by a re-roll. Re-rolling a turn re-assembles the request with
*current* toggle state — the same way `tools_enabled` and `scratchpad_enabled`
already behave. This keeps the mental model simple: the checkboxes describe what
the next request will contain, full stop.

### 5. The scratchpad is not affected

The pad has its own enable/disable (SP-02, `conversations.scratchpad_enabled`)
surfaced on its own row in the panel. It is not a file and does not join this
system. The existing control stays exactly where it is.

---

## Data model

Two column additions (migration) and one new table (created on boot).

```sql
-- migration 010_context_toggles.js
ALTER TABLE project_files   ADD COLUMN enabled     INTEGER DEFAULT 1;
ALTER TABLE workspace_files ADD COLUMN enabled     INTEGER DEFAULT 1;
ALTER TABLE conversation_files ADD COLUMN inject_mode TEXT;  -- NULL='auto' | 'pin' | 'mute'
```

`enabled` is read as "NULL or 1 → on, 0 → off" so pre-migration rows and any
future path that forgets the column both default to the current behaviour.

```sql
-- schema.sql, CREATE TABLE IF NOT EXISTS (user_files / WR-02b precedent —
-- a brand-new table needs no migration)
CREATE TABLE IF NOT EXISTS conversation_context_overrides (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    scope           TEXT NOT NULL,      -- 'workspace' | 'project'
    file_id         TEXT NOT NULL,      -- row id in workspace_files / project_files
    enabled         INTEGER NOT NULL,   -- 1 | 0; a row exists ONLY when overriding
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, scope, file_id)
);
```

No FK on `file_id` — it spans two tables, same compromise as `file_revisions`.
A stale row (file deleted since) is harmless: resolution always iterates the
*file list* and looks overrides up, never the reverse. Container file deletion
prunes matching rows opportunistically.

### Resolution

One helper, used by both the injection path and the API:

```js
// server/src/utils/contextState.js
resolveKnowledgeFileState(conversationId, scope, file)
  -> { enabled: boolean, source: 'chat' | 'container' }

resolveChatFileMode(file)
  -> 'auto' | 'pin' | 'mute'
```

`source` is what lets the chat panel show "this row disagrees with the default"
and offer a reset.

---

## Server changes

### `projectContext.js` — `gatherFileTexts()`

The filter goes exactly where the module's own header comment says retrieval will
eventually go. Partition the file list into loaded / not-loaded before the
download loop; return the not-loaded names alongside the sections:

```js
{ sections, usedChars, skipped, driveFailed, notLoaded: string[] }
```

`assembleContextBlock()` gains a `conversationId` and a `toolsEnabled` flag, and
appends the `<available_files>` line to the block when `notLoaded` is non-empty
**and** `toolsEnabled`. Everything downstream — the wrapper, the budget, the
warning — is unchanged.

Two useful consequences fall out for free:

- **Budget pressure drops** proportionally, so the truncation warning fires far
  less often, and when it does the user has a lever.
- **Ordering becomes meaningful.** Since disabled files no longer consume budget,
  the arbitrary upload-order truncation now only bites among files the user
  actually chose to load.

### `activeFiles.js` — `resolveActiveFileBlock()`

`selectActiveRevisions()` currently keys entirely off the revision log. It gains
a pre-pass:

1. Collect **pinned** files (query `conversation_files WHERE inject_mode='pin'`)
   — these are included regardless of revision age, or of whether they have a
   revision at all.
2. Run the existing recency selection over the remainder, **skipping muted**
   files.
3. Concatenate pinned-first, truncate to `MAX_ACTIVE_FILES`.

A pinned file with no recent revision has no `last_change` phrase; its header
becomes `pinned` rather than `edit by you, 2 turns ago`.

### `list_files` tool

Append the state to each row so the model's view of the world matches the
prompt's:

```
notes.md (md, 12 KB)
trade-routes.md (md, 40 KB) — not loaded in this conversation
```

### Endpoints

```
PATCH /api/workspaces/:id/files/:fileId      { enabled }        -> container default
PATCH /api/projects/:id/files/:fileId        { enabled }        -> container default
GET   /api/conversations/:id/context                            -> the resolved view
PATCH /api/conversations/:id/context/:scope/:fileId { enabled }  -> set override
DELETE /api/conversations/:id/context/:scope/:fileId             -> clear override
PATCH /api/conversations/:id/files/:fileId   { injectMode }     -> auto|pin|mute
```

`GET /api/conversations/:id/context` is the one genuinely new shape — it returns
everything the chat's context panel needs in a single call:

```jsonc
{
  "workspace": { "id": "...", "name": "Lore",
    "files": [{ "id": "...", "filename": "geography.md", "sizeBytes": 8200,
                "enabled": true, "source": "container" }] },
  "project":   { "id": "...", "name": "Book 2", "files": [ ... ] },
  "chatFiles": [{ "id": "...", "filename": "duel-scene.md", "injectMode": "pin" }],
  "budget":    { "loadedChars": 84210, "budgetChars": 500000 }
}
```

---

## UI

### Container page (workspace / project)

A checkbox at the **left** of each row in `.project-file-item`, before the type
badge — exactly as described. Unchecked rows dim their name and badge. Below the
list, a quiet line: *"Unchecked files stay in this workspace but aren't loaded
into chats. The assistant can still open them on request."*

Optimistic toggle: flip the checkbox immediately, PATCH, revert + `showToast` on
failure. No confirm dialog — the action is free to undo.

### Chat panel (the FilePanel browser view)

This is the bigger UI move: the browser view stops being "this chat's files" and
becomes **this chat's context**, in one scrollable list:

```
  Scratchpad                                    shared notes
─ Workspace · Lore ────────────────────────────────────────
  ☑ geography.md            8 KB
  ☐ trade-routes.md        40 KB      ↺
  ☐ lore-dump.pdf         410 KB
─ Project · Book 2 ────────────────────────────────────────
  ☑ outline.md             12 KB
─ This chat ───────────────────────────────────────────────
  📌 duel-scene.md         6 KB
  ◐ notes.md               2 KB
```

- Knowledge rows use the same left-edge checkbox. A row whose state came from a
  **chat override** shows a `↺` reset control; clicking it deletes the override
  and the row snaps back to the container default.
- Chat file rows use a **cycling mode button** in the same left column:
  `◐ auto → 📌 pinned → 🚫 muted → ◐`, with the current state in the `title`.
  One click, no menu, and the icon carries the state at a glance.
- Section headers name the source container, which also answers a question the
  panel can't answer today: *where is this chat's context coming from?*
- The header keeps a running `84 KB of 500 KB loaded` readout (CT-06), so
  unchecking something produces visible feedback rather than an act of faith.

Rows stay keyboard-reachable; the checkbox is a real `<input type="checkbox">`
with an `aria-label`, the cycle button a `<button>` with `aria-label` reflecting
current state.

### The disabled-files indicator (top-bar button)

The panel makes state obvious *once you open it*. The failure mode is not opening
it — you disabled something four days ago and have since forgotten. So the count
has to live on the **files explorer top-bar button** (`filesExplorerBtn`,
CF-01b), which is visible from the composer at all times.

That button already carries `filesExplorerDot` — a transient accent dot meaning
"file activity happened while the panel was closed." The two signals must stay
distinguishable, so they do not share a corner or a colour:

| Indicator | Position | Style | Lifetime |
|---|---|---|---|
| `filesExplorerDot` (existing) | top-right | accent, pulses | transient — cleared on open |
| `filesExplorerMuted` (new) | bottom-right | muted/neutral count pill, no animation | persistent — present while any file is off |

The badge shows the count of files **not loaded in this chat** — disabled
knowledge files plus muted chat files. Hovering it (or focusing it) reveals a
small popover naming them:

```
Not loaded in this chat
  trade-routes.md      workspace
  lore-dump.pdf        workspace  (default)
  scratch-output.md    muted
```

Clicking the badge opens the panel straight to the context view, so noticing the
problem and fixing it are one gesture apart.

**Deliberately not a toast.** A notification that fires on chat open would be
correct exactly once and then become noise you learn to dismiss without reading —
which is worse than no signal, because it trains the reflex that hides the real
warnings. A persistent, quiet, always-truthful badge is the stronger version of
the same idea: it can't be missed *and* it can't nag. (Easy to revisit — if the
badge proves too quiet in practice, a once-per-chat toast is a small addition on
top of the same count.)

The count is `0` → badge hidden entirely, so a user who never touches a toggle
never sees any new chrome.

---

## Risks and interactions

| Risk | Mitigation |
|---|---|
| **Prompt-cache invalidation.** The KB block rides as a synthetic user turn (FC-03a); changing it busts the cache for that conversation's prefix. | Real but one-off per toggle — the *steady state* after toggling is a smaller, cheaper prefix. Net win for any conversation longer than a couple of turns. |
| **"Why isn't it using my file?"** A user disables a file, forgets, and blames the model. | The persistent count badge on the top-bar files button (CT-06) — visible from the composer, hover to name the files, click to fix. Backed by section headers + dimmed rows in the panel, and by the `<available_files>` manifest, which often lets the model answer the question itself. |
| **Tools-off silence.** With file tools disabled, a disabled file is truly invisible and unrecoverable. | The container page help text says so, and the panel shows a quiet note when tools are off with something disabled (CT-06). This is the one case where the badge is doing real work rather than reassurance. |
| **Stale override rows** for deleted files. | Harmless by construction (resolution iterates files, not overrides). Pruned on container file delete. |
| **Pinning everything** defeats the purpose. | `MAX_ACTIVE_FILES`/`MAX_CONTENT_CHARS` still apply; pinned files just win the ordering. The budget readout makes the cost visible. |
| **Interaction with future retrieval.** | Designed for it: "off" becomes "not indexed," "on" becomes "eligible for retrieval." Pin becomes "always included, skip retrieval." The data model and UI survive the swap unchanged — only `gatherFileTexts()` changes. |

---

## Proposed build order

Each slice is independently mergeable and leaves the app working.

| Slice | Scope | Notes |
|---|---|---|
| **CT-01** | Data model + resolution. Migration 010, `conversation_context_overrides` table, DAL accessors, `utils/contextState.js`. | **No behaviour change** — everything resolves to on/auto. Pure foundation, easy to review. |
| **CT-02** | Injection honours state. `gatherFileTexts` filter + `<available_files>` manifest, `activeFiles` pin/mute, `list_files` state suffix. | Server-only; testable via `routes/test-context.js` before any UI exists. |
| **CT-03** | Container page checkboxes + the two `PATCH .../files/:fileId` endpoints. | First user-visible slice. Delivers the workspace/project half on its own. |
| **CT-04** | `GET /api/conversations/:id/context` + the chat panel rebuilt as a sectioned context view, with knowledge-file overrides. | The biggest slice. Split into 04a (endpoint + sectioned read-only render) and 04b (override toggles + reset) if it runs long. |
| **CT-05** | Chat working file auto/pin/mute control. | Small once CT-04's rendering exists. |
| **CT-06** | **Disabled-files count badge on the top-bar button** + hover popover naming them; budget readout in the panel header; tools-off note. | The badge is the slice's anchor, not optional polish — it is the only signal visible without opening the panel, and the agreed answer to the "forgot I disabled it" failure. The budget readout is the droppable half. |

CT-01 → CT-02 → CT-03 is a complete, shippable feature on its own (container-level
toggles). CT-04+ adds the per-chat layer.

---

## Open questions

1. **Default for newly uploaded files** — on, always? Or inherit "off" if the
   container is already over budget? Recommendation: always on; surprising
   defaults are worse than a visible warning.
2. **Bulk actions.** "Uncheck all / check all" per section is obvious once a
   workspace has 20 files. Deferred to CT-06 or later unless it bites early.
3. **Does the persona get a say?** A persona could carry default-off patterns
   (`*.pdf`), but that's a third resolution layer for a speculative need. Not in
   this design.
4. **Should `move_file` carry state?** Promoting a chat file to the project — does
   it arrive enabled? Recommendation: yes, enabled; promotion is an explicit act
   of "make this shared."
