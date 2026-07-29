# Frontend refactor — plan

Splitting `app.js` (10,476 lines / 450 KB) into modules, and fixing the class of
bug that its size has been hiding. Written to be picked up cold in a new session:
each slice is independently shippable and says what "done" means.

> **Status: PLAN COMPLETE (2026-07-29).** Every slice shipped, in 20 PRs
> (#125–#144).
>
> `app.js` was 10,476 lines in one scope. `js/main.js` is now **2,504** lines
> beside 24 sibling modules, and `styles.css` (5,957 lines) is 9 files under
> `styles/`.
>
> **The smoke harness is 4 pass / 0 fail**, from 1 pass / 3 fail when F-02 first
> encoded the bugs. Both bugs that motivated the plan are fixed: the live reply
> survives navigation (F-03) and drafts belong to a conversation (F-04). The
> third, the Anthropic `top_p` blocker, went first (F-01).
>
> The three rules held. State is the only source of truth — the DOM pointer that
> caused bug 1 is gone. One owner per DOM region — `js/router.js` decides, and
> the module graph enforces it. Dependencies point one way — the checker reports
> no cycles across 25 modules. The one cycle anything created (F-04, via a
> helper parked in a view) was caught before merge.
>
> Ordering decision: the live provider blocker (F-01) and the test harness (F-02)
> ship **before** any code moves; the stream-orphaning fix (F-03) ships **after**
> the extraction, because the fix *is* the boundary being drawn.
>
> **Note on line references below:** every `../app.js#Lnnnn` link predates R-00.
> That file is now `js/main.js` and the numbers have shifted slightly. The
> function names are the reliable handle — grep for those.

---

## Why now

Three bugs were found and reproduced on 2026-07-24 while investigating a report
that "sending after switching tabs doesn't work." Two of them share one root
cause, and that root cause is a direct consequence of everything living in one
scope with no ownership rules.

### Bug 1 — the live reply is orphaned by navigation (confirmed)

`#messagesContainer` is a single shared DOM node that five different renderers
wipe with `innerHTML = ''`: [`renderChatThread`](../app.js#L4915),
[workspace](../app.js#L4876) / [project](../app.js#L4882) views in
`renderMainView`, and [`renderContainerPage`](../app.js#L5732).

Meanwhile the send path holds a **direct DOM pointer** to the live assistant
bubble in [`state.streamingMessageDiv`](../app.js#L9000) and appends chunks to it
for the whole response ([`appendStreamChunk`](../app.js#L9053)).

Nothing connects the two. Navigating away detaches the bubble; the in-flight turn
keeps writing into the orphan. Coming back repaints from
`state.conversations[id].messages` — which doesn't contain the reply yet, because
it's only pushed at the end, in [`finalizeStreamingMessage`](../app.js#L9099).

Reproduced (send → leave to Personas mid-response → return mid-response):

| checkpoint | messages in DOM | messages in state |
|---|---|---|
| mid-stream, in chat | 15 | 15 |
| after leaving to Personas | 0 | 15 |
| back in chat, mid-stream | **14** | 15 |
| turn finished | **14** | 15 |

The reply reaches SQLite correctly but is **absent from the screen until a page
reload**. No typing dots, no cursor, no bubble. Later turns show the index gap
(`data-msg-index` runs `…13, 15, 16`).

The same defect seen from the other side: [`appendMessage`](../app.js#L6148)
appends to `elements.messagesContainer` with no check of which view is showing,
so on the **non-streaming** path the reply arrives seconds after you've navigated
and renders *inside the Chats/Personas/Workspaces list*. (Confirmed by the F-02
harness: `1 chat message(s) rendered into the workspaces list`.)

### Bug 2 — composer draft bleeds across chats (confirmed)

Nothing in [`switchConversation`](../app.js#L3557) clears or scopes
`messageInput.value` or `state.pendingAttachments`. Reproduced: compose in chat A,
switch to chat B, the draft is still in the box. Sending files it under the wrong
conversation.

### Bug 3 — every Anthropic send fails out of the box (confirmed, unrelated)

Defaults are `temperatureEnabled / topPEnabled / topKEnabled: true`
([app.js:1084-1086](../app.js#L1084)) and the provider forwards each
independently ([server/src/providers/anthropic.js:78-85](../server/src/providers/anthropic.js#L78)).
Claude 4.5+ rejects `temperature` and `top_p` together:

> `PROVIDER_ERROR` — `temperature` and `top_p` cannot both be specified

Nothing to do with the refactor. Ships first.

---

## The three rules

These matter more than the file tree — they are what stops the bug class
recurring. Every slice below is in service of making them enforceable.

1. **State is the only source of truth.** No module holds a DOM node across an
   `await`. To update something after an async gap, re-derive from state and
   re-render. `state.streamingMessageDiv` is the exact anti-pattern.
2. **One owner per DOM region.** The router decides which view owns the main
   area. A module that isn't the current owner updates state and returns — it
   does not write to the DOM.
3. **Dependencies point one way.** `state.js` and `api-client.js` import nothing
   from view code. No cycles.

---

## Target structure

```
index.html
js/
  main.js            boot, auth gate, event wiring
  config.js          CONFIG + defaults
  state.js           state object + derived getters
  ui-prefs.js        device-local prefs (theme, devMode, enterToSend)
  dom.js             elements cache + DOM/format helpers
  api-client.js      (moved, converted to a module)
  router.js          navigate / renderShell / renderMainView / currentSection
  views/
    chats.js  workspaces.js  personas.js  models.js  settings.js
  chat/
    thread.js        renderChatThread, appendMessage, message actions
    composer.js      draft + attachments + send button + keydown
    send.js          send orchestration, buildChatRequest
    stream.js        streaming render, state-driven
    expressions.js
  file-panel/
    index.js         the FilePanel object (~1,300 lines, from app.js:7127)
  components/
    dialogs.js  toast.js  menus.js
  util/
    markdown.js  image-store.js
```

~20 files, ~500 lines average.

### ES module migration notes

Checked and confirmed before planning:

- **No inline `onclick=` / `onchange=` handlers in `index.html`.** Nothing in the
  HTML depends on functions being global, so module scope breaks no wiring.
- Currently two classic tags: [index.html:692-693](../index.html#L692). Becomes
  one `<script type="module" src="js/main.js">`.
- `marked` and `hljs` stay as classic CDN globals loaded first — modules read
  `window.marked` / `window.hljs` fine.
- `express.static` serves the project root
  ([server/src/index.js:120](../server/src/index.js#L120)), so a `js/`
  subdirectory needs **no server change**.
- Module scripts are deferred by default, so the DOM is ready without relying on
  script placement.
- `api-client.js` (852 lines) is already a clean namespace — converting it to a
  module is mechanical.

---

## Build order

Each row is one branch, one PR. Harness green before and after.

| | Slice | What | Risk |
|---|---|---|---|
| ☑ | **F-01** | top_p/temperature fix + server test | trivial — ship first |
| ☑ | **F-02** | Frontend smoke harness; 3 bugs encoded as failing checks | none (additive) |
| ☑ | **R-00** | `<script type="module">`; `api-client.js` → module. No code moves | low — proves loading |
| ☑ | **R-01** | Extract `util/markdown`, `util/image-store`, `components/menus` (true leaves) | low |
| ☑ | **R-02** | Extract `config` / `state` / `dom` / `ui-prefs` / `sidebar`, then `components/dialogs` + `components/toast` | medium |
| ☑ | **R-03** | Extract `file-panel/` + the helpers it stands on (`util/format`, `util/diff`, `components/errors`) | medium |
| ☑ | **R-04a** | Shell seam (`js/shell.js`) — a **change**, not a move; breaks the 60-function knot | low |
| ☑ | **R-04b** | View layer + `router.js`, bottom-up: model-layer, settings-store, models, persona-helpers, chats, personas, workspaces, router | medium |
| ☑ | **R-05** | Extract `chat/` (expressions, thread, send, composer) + `avatar`, `status-bar` | high |
| ☑ | **F-03** | Fix stream orphaning (bug 1) — harness 1 pass → 3 pass | low once R-05 lands |
| ☑ | **F-04** | Draft + attachments per conversation (bug 2) — harness 4 pass / 0 fail | low |
| ☑ | **F-05** | Accessibility section + Enter-behaviour toggle | low |
| ☑ | **S-01** | Split `styles.css` (5,957 lines) into `styles/` + `<link>` tags | low, independent |

### Rules of engagement

- **Never mix "move code" and "change code" in one commit.** With no frontend
  test net, that separation is the only debugging tool — when something breaks
  you must be able to tell whether the extraction or the fix did it. R-slices
  are byte-equivalent behaviour; F-slices change behaviour.
- One slice per branch, per the usual workflow. Never commit to `main`.
- Run the F-02 harness before and after every R-slice.
- `cd server && npm test` (21 test files) must stay green on any server change.
- S-01 goes **after** R-05, not concurrently — so a visual regression is never
  ambiguous about its cause.

---

## Slice detail

### F-01 — top_p blocker ✅ (PR #125)

`buildRequestBody` in the Anthropic provider now sends `top_p` only when
`temperature` is absent. Temperature wins when both toggles are on; turning
temperature off in the model detail view is how you opt into `top_p` instead.
Gemini untouched (no such restriction).

`server/src/providers/test-modelparams.js` — 11 checks: the exclusion both ways,
the `temperature: 0` falsy trap, `top_k`/`stop_sequences`/`max_tokens`
unaffected, the streaming body guarded identically, Gemini still sending both.
In `npm test`; suite green. Live-verified on dev login with stock params.

**Still open (deliberately not in this slice):** the Models detail UI doesn't
show the two as mutually exclusive, so a user who wants `top_p` sampling has to
know to disable temperature first. Worth a hint line there eventually.

### F-02 — frontend smoke harness ✅

`tests/frontend-smoke.js`. Load it into the running app from the console:

```js
const t = await import('/tests/frontend-smoke.js'); await t.run();
```

Drives the real UI — real router, real send path, real DOM — with the provider
stubbed. **Safe to run any time:** it creates two throwaway conversations, works
only in those, and deletes them in a `finally` (verified: server conversation
count unchanged across runs). Stubs, API-key status, the streaming flag, the
active chat, the draft and the current view are all captured and restored.

Reaches the app through **one deliberate seam**, `window.__tessera` (added at the
foot of `app.js`), rather than incidental globals — so the harness survives
R-00…R-05 unchanged, and a slice that forgets to wire something fails loudly
instead of silently losing coverage. (R-00 turned out to need no re-wiring — the
seam rode along with the file rename into `js/main.js`. **R-01 onward is where it
matters:** as each function moves out, `main.js` must import it back so the seam
keeps resolving.)

Current result — **1 pass, 3 fail**, which is the point:

| check | status | covers |
|---|---|---|
| `rail-round-trip` | ✅ pass | regression lock on the path from the original report |
| `stream-survives-navigation` | ❌ fail | bug 1 |
| `non-streaming-reply-lands-in-the-chat` | ❌ fail | bug 1, other face |
| `draft-is-per-conversation` | ❌ fail | bug 2 |

The non-streaming check **empirically confirmed** what was previously only
read-confirmed: a reply really does render into the workspaces list
(`1 chat message(s) rendered into the workspaces list`).

### R-00 — ES module boot ✅

`app.js` → `js/main.js`, `api-client.js` → `js/api-client.js` (git-tracked
renames), the two classic `<script>` tags replaced by one
`<script type="module" src="js/main.js">`, and `api-client.js` now `export`s the
`API` object that `main.js` imports. No code moved between files. The files land
in `js/` now rather than at the root so that R-01…R-05 extract *sideways* into
siblings, with import paths that never have to change again.

One real thing fell out of it. `blobToBase64` was **declared twice** at the top
level of `app.js` (~5367 and ~9407). Legal in a classic script — the later
declaration silently wins — but a module is strict, where a duplicate top-level
function declaration is a hard `SyntaxError` that stops the whole app loading.
The earlier copy was therefore already dead code and was deleted; the surviving
implementation, the one that has always actually run, is untouched. Worth knowing
for later slices: **run `node --check` on the file as `.mjs` before loading it**,
which is how this was caught rather than discovered as a white screen.

`window.API` is still mirrored for console debugging. Every other former global
(`state`, `CONFIG`, `sendMessage`, `FilePanel`, …) is now gone from `window` —
verified in the browser — which is the property later slices depend on.

**Verified:** app boots, no console errors, one module script tag, the
`window.__tessera` seam intact (no re-wiring needed — it lives in the same file),
and the harness reports the same **1 pass / 3 fail** with byte-identical detail
strings before and after.

### R-01 — leaf modules ✅

Three modules, ~405 lines, moved out of `main.js`:

| module | from | contents |
|---|---|---|
| `js/util/markdown.js` | app.js 69–151 | `marked`/`hljs` setup, `renderMarkdown`, `ICON_SVG`, `messageActionsHTML` |
| `js/util/image-store.js` | app.js 457–722 | the `ImageStore` IndexedDB wrapper |
| `js/components/menus.js` | app.js 3785–3840 | `positionPopover`, `attachPopoverOutsideClose` |

**Scope changed from the original plan, deliberately.** `components/dialogs.js`
(`confirmDialog` / `promptName`) and `components/toast.js` (`showToast` /
`showCriticalBanner`) both need the `elements` DOM cache, which R-02 extracts.
Importing it back from `main.js` would create precisely the cycle rule 3
forbids, so those two modules move in **R-02, immediately after `dom.js`**, where
they cost one import line each. R-01 ships only what genuinely has zero
dependencies.

`ICON_SVG` and `messageActionsHTML` came along with `markdown.js` because
`ICON_SVG.copy` is used by the code-block renderer — they are really chat-surface
helpers and should land in `chat/thread.js` in R-05.

**Method worth reusing for R-02…R-05.** Two throwaway scripts did the work and
made the result checkable rather than trusted:

1. A dependency reporter — for a line range, list what it declares, what it uses
   from outside (→ imports), and what the outside uses from it (→ exports). Keep
   it crude: strip whole-line comments only. Anything cleverer misreads this file
   (a `/*` inside a CSS string swallows hundreds of real lines; template literals
   hold most of the app's call sites). Over-report, never under-report.
2. A cutter that slices the byte range out and writes it to the new file, so the
   moved code is provably the original rather than retyped. Then diff the new
   file against `git show main:js/main.js | sed -n 'a,bp'` to prove it.

For this slice that diff came back **identical modulo blank lines** for all
three, and `main.js` gained nothing but three `import` lines and a two-line
comment. That is what an R-slice diff should look like.

**Verified:** `node --check` on all four files, app boots with no console errors,
markdown renders, the avatar popover positions and outside-closes, and the
harness reports the same **1 pass / 3 fail**.

### R-02 — core modules ✅

Seven modules, ~1,000 lines. The dependency graph they form is the whole point,
so it is worth stating — it is acyclic and shallow:

```
config.js ──> state.js
dom.js ──┬─> ui-prefs.js ──> sidebar.js ──> components/dialogs.js
         ├─> components/toast.js
         └─> components/dialogs.js
```

| module | from | notes |
|---|---|---|
| `js/config.js` | 23–70, 727–766 | `CONFIG` + `getDefaultModelConfig()`, which is only CONFIG.defaults reshaped |
| `js/state.js` | 376–461 | the `state` object; imports config for its seed values |
| `js/dom.js` | 1018–1186 | the `elements` cache; a leaf |
| `js/ui-prefs.js` | 72–375 | `UiPrefs` + themes + the OKLCH palette engine |
| `js/sidebar.js` | 9694–9767 | drawer open/close/overlay/resize |
| `js/components/toast.js` | 5809–5952 | `showToast`, critical banner |
| `js/components/dialogs.js` | 5122–5281 | `confirmDialog`, `promptName` |

**Two judgement calls.**

`sidebar.js` is a new module the target tree doesn't list. It exists because
`dialogs.js` calls `closeSidebar()` (dismissing the mobile drawer), and the
sidebar functions need both `elements` and `UiPrefs` while `ui-prefs.js` already
needs `elements`. Folding them into `dom.js` would have created a cycle;
a module between the two does not.

`getDefaultModelConfig()` went to `config.js` rather than staying with the
persona helpers, because `state.js` calls it at module-evaluation time to seed
`state.currentModelConfig`. It depends on nothing but `CONFIG`, so this keeps
`state.js`'s only import pointing at a leaf.

**Shared mutable state across modules is fine here, and it was checked, not
assumed.** `state` and `elements` are imported by everything and mutated
constantly. An ES module import is a live binding: importers may mutate the
object's properties but may never reassign the binding itself. The codebase does
exactly that — 97 property writes to `state`, one to `elements`, and zero
reassignments of either.

**A third script joined the toolkit:** a cross-module wiring checker. For every
file it reports names used but not imported (the way an extraction breaks at
runtime rather than at parse time), duplicate top-level names, and import
cycles. `main.js` came back with zero missing imports and the graph came back
acyclic. It also over-reports — object keys and method names that happen to
match a function name elsewhere — which is the right direction.

Same lesson as R-01, learned again the same way: the checker's first version
missed a real import because the word "import" appeared in a doc comment and its
regex swallowed the statement that followed. Parse from comment-stripped text.

**Verified at runtime, module by module:** app boots clean; theme switch and
restore (`ui-prefs`); mobile drawer opens, builds its overlay, and closes
(`sidebar`); the rename prompt opens focused and dismisses (`dialogs`); a delete
confirm renders the right text, gates the action on Cancel, and performs it on
confirm (`dialogs`); toast and critical banner show and dismiss (`toast`); and
the harness reports the same **1 pass / 3 fail**.

Two things that look like regressions in a headless pane and are not: CSS
transitions never advance while `document.hidden` is true, so a modal reads
`opacity: 0` even though its class and rule are correct; and
`navigator.clipboard.writeText` rejects with `NotAllowedError` when the document
isn't focused, so the copy button's toast never fires. Check the class list, not
the computed style.

**Left deliberately undone:** `elements.closeSettingsModal` really is dead (the
button lives inside the `#settingsModal` shell that `main.js` removes at load),
but deleting it is a *change*, and mixing one into a move slice forfeits the
byte-identity proof for `dom.js`. It wants a small cleanup slice of its own —
along with the stray `nul` file and the junk "SP-04/05" chat below.

### R-03 — file panel ✅

`FilePanel` needed **eleven** things from `main.js`, so the slice is "the panel
plus the helpers it stands on":

| module | contents |
|---|---|
| `js/file-panel/index.js` | the `FilePanel` object + the `INJECT_MODE_*` constants (nothing else used them) |
| `js/util/format.js` | `formatFileSize`, `formatTimeAgo`, `formatBytes`, `formatRelativeTime`, `escapeHtml`, `getFileCategory`, `getFileIcon`, `getFileTypeLabel` |
| `js/util/diff.js` | `diffStats` … `buildRichDiff` — a pure leaf |
| `js/components/errors.js` | `appendErrorMessage`, `displayError` |
| `js/dom.js` (+) | `scrollToBottom` — a bare DOM op both the thread and errors.js need |
| `js/state.js` (+) | `getActivePersona` — a derived getter, which is what state.js is for |

`main.js`: 9,082 → **7,382** lines. Its whole diff is nine import lines, two
comment headers, and deletions.

**Gathering the formatters exposed two near-duplicate pairs:** `formatFileSize`
vs `formatBytes`, and `formatTimeAgo` vs `formatRelativeTime` — same jobs,
different rounding and wording, written months apart in different parts of the
file. Left alone here (merging them is a behaviour change), but they are an easy
cleanup once the extraction is done, and they are now sitting next to each other
where the duplication is obvious.

**The slice that proved why the byte-identity check exists.** One cut used line
numbers computed *before* an earlier cut in the same batch had shifted them by
two, which sliced `formatRelativeTime` in half: its signature stayed in
`main.js`, its body moved to `format.js`. `node --check` caught it immediately
(both files failed to parse), and the repair was verified against
`git show main:js/main.js`. **Re-derive line numbers after every cut** — or cut
strictly bottom-up, which is what the rest of the batch did safely.

**Review agents were run on this slice** (the first time), on top of the
mechanical checks: one on the extraction as a whole, one on the file panel's
module boundary specifically.

The boundary audit came back clean — all 16 imports used, every free identifier
accounted for (including inside string-built HTML and `catch` blocks), no
top-level side effects, `marked`/`hljs` provably defined before any module
evaluates, and all 27 `FilePanel.*` call sites in `main.js` resolving to real
methods. It also found one thing the mechanical checks would never surface:
`FilePanel.revisionsUrl()` (`js/file-panel/index.js:955`) **has no callers
anywhere in the repo**. It predates the move, so it stays for now — see the
cleanup list in Open items.

The whole-slice review found no runtime defect either, and contributed a check
stronger than byte-identity: **two-way line accounting.** Every one of the 1,570
non-blank lines deleted from `main.js` was matched to a line in the new modules
(the only 17 exceptions being declarations that gained `export `), and every
non-blank line in the new modules was traced back to deleted `main.js` text
(exceptions: file headers and import lines). Byte-identity proves what moved
arrived intact; this also proves **nothing was dropped in the cut and nothing was
invented in the paste**. Worth running on R-04 and R-05.

It did catch four real hygiene defects, all fixed before merge:

- **Four dead imports in `main.js`** — `showCriticalBanner`, `formatRelativeTime`,
  `diffStats`, `buildRichDiff`. Each was imported because `main.js` *used* to
  need it, and its last caller left in the same slice. `node --check` can't see
  this, and it inflates the module's apparent dependency surface — the exact
  thing this refactor exists to make legible. (`hideCriticalBanner` is still
  live: the `criticalBannerDismiss` listener.)
- `appendErrorMessage` was exported with no importer. It is now module-private;
  `displayError` is the only way in, and R-05 can make it public when the chat
  thread has a real reason to call it.
- A carried-over section header in `errors.js` that still said "what stays here"
  — true in `main.js`, meaningless in its new home.
- A three-blank-line seam in `format.js`.

**The wiring checker now detects stale imports itself** (a name imported but
never used in the body), so R-04 and R-05 catch this class automatically instead
of needing an agent to notice.

### R-04a — the shell seam ✅ (a change, not a move)

**R-04 as written could not be done.** Not "was hard" — could not be done as a
move. Measuring the top-level call graph of `main.js` and computing its
strongly-connected components found **one mutually recursive cluster of 60
functions**: the view layer, the router and the settings-persistence code all
call each other. Any boundary drawn through that cluster puts each half
importing the other, which is exactly the cycle rule 3 forbids. 206 of the 273
declarations are in no cycle at all; the tangle is concentrated and specific.

Cutting single edges from the graph showed what holds it together — three
"repaint everything" calls, and nothing else comes close:

| edges cut | largest remaining cluster |
|---|---|
| none | **60** |
| `navigate` | 44 |
| `navigate` + `updateUI` | 21 |
| `navigate` + `updateUI` + `renderMainView` | **13** |

So `js/shell.js` now owns `navigate` and `currentSection` outright and exposes
`renderShell` / `renderMainView` / `updateUI` as a facade over implementations
registered once at boot. A view imports `navigate` from the seam and stays
ignorant of the router; the router registers itself. The implementations still
live in `main.js` and move to `js/router.js` in R-04b, which will do the
registering instead — nothing else about them changes.

This is **rule 2 made enforceable** rather than merely stated, and it is the
same seam F-03 needs: to stop a streaming reply being written into a detached
node, the send path must be able to ask which view is showing without reaching
into the router.

**Deliberately shipped as a change commit, alone.** No code moved in this slice.
The one thing to know when reading it: `renderShell` / `renderMainView` /
`updateUI` are now declared in two places — the facade in `shell.js` and the
implementation in `main.js`. That is the point of a facade, and it keeps every
existing call site reading identically, but the cross-module checker flags it as
a duplicate name, correctly. Expect that warning until R-04b.

**Verified:** all five rail sections navigate and highlight correctly through
the seam (which exercises `currentSection`), opening a chat still paints its 23
messages and shows the composer, `updateUI()` through the facade still returns
its promise, no console errors, harness unchanged at 1 pass / 3 fail.

A review agent checked the change specifically for behaviour identity and found
no defect: `navigate`/`currentSection` byte-identical to the originals,
`closeSidebar` resolving to literally the same binding, registration provably
ordered before any possible call (`main.js` is the **only** importer of
`shell.js`, and its only other top-level statement is the `DOMContentLoaded`
hook), no shadowing or self-recursion, the async promise passing through the
facade untouched, and the `window.__tessera` getter still resolving now that
`navigate` is an imported binding.

**Three notes it left for R-04b:**

1. The `updateUI` facade is not load-bearing yet — nothing imports it, because
   `main.js` still calls its own local copy. R-04b is what activates it.
2. The guard in `call()` throws **synchronously**. Harmless today (unreachable,
   and no caller does `updateUI().catch(...)`), but if R-04b introduces a caller
   that only `await`s, a missed registration would surface as an uncaught error
   rather than a rejected promise. Make the guard async-safe if that happens.
3. `main.js`'s own `renderShell()` / `updateUI()` calls still bind to its local
   declarations rather than going through `impl`. Correct while they *are* the
   registered functions — and moot once R-04b moves them wholesale into
   `router.js` — but it means the seam currently redirects external callers
   only.

### R-04b — the view layer, bottom-up (in progress)

With the seam in place the knot decomposes into clusters that map onto real
modules. Measured after R-04a, treating `navigate`/`updateUI`/`renderMainView`
as seam calls:

| cluster | size | becomes |
|---|---|---|
| models + settings persistence | 13 | `views/models.js` (+ its service layer, below) |
| chats list | 7 | `views/chats.js` |
| model detail | 3 | `views/models.js` |
| personas import | 3 | `views/personas.js` |
| send/retry/re-roll | 3 | R-05, `chat/` |

Each cluster must move as a unit — that is what "mutually recursive" means — but
the clusters are independent of each other. **Order is bottom-up: services
first, view clusters next, `router.js` last**, since the router imports the views
and nothing imports the router.

#### `js/model-layer.js` ✅

23 declarations, ~160 lines of logic (340 with the param descriptors), **called
from 38 places**: the provider catalog, the active model layer, profile
load/mirror, and the param-path helpers the detail view reads and writes
through. It is what the models view, the personas view and the chat send path
all stand on, so it comes out first.

One passenger, documented in the file: `updateSendButtonState` is composer
chrome, but `applyModelToLayer` refreshes it on a provider switch and that is
the only edge tying it here. It belongs in `chat/composer.js` in R-05.

**Two tooling lessons, both from this one module.**

*A blind spot that had been there all along.* The checker's guard against
counting property accesses (`obj.foo`) excludes an identifier preceded by a dot
— which also silently excludes **spread syntax** (`...FOO`). `PROVIDERS` is
built as `[...SAMPLING_PARAMS, ...BEHAVIOUR_PARAMS, …]`, so five constants it
depends on were invisible to every dependency script. The module parsed, the
checker was clean, and it threw `SAMPLING_PARAMS is not defined` on first load.
Fixed in all four scripts: `(?:(?<![\w$.])|(?<=\.\.\.))`. Worth remembering that
the SCC and closure numbers quoted above were computed with that blind spot —
they under-count spread edges.

*Cut by name, not by line number.* After R-03 sliced a function in half with
stale line numbers, extraction is now done by naming the declarations; the tool
recomputes spans itself, takes each declaration with its doc comment, and
refuses to run if two spans overlap. No line arithmetic survives to be wrong.

**Verified:** all 24 moved declarations byte-identical; no cycles, no missing or
stale imports; the app boots; `PROVIDERS` resolves its param lists
(`anthropic:9`, `google:14` — the exact thing the spread bug broke); the models
catalog paints 4 cards and 4 provider chips; the model detail view opens with
its param controls; harness unchanged at 1 pass / 3 fail.

### R-04b (remaining) → R-05 — extraction

Mechanical. Move code, add `import`/`export`, change nothing else. (`dom.js`
landed in R-02, as planned — the view slices need it.)

R-05 is last and hardest because `sendMessage` ([app.js:8533](../app.js#L8533)),
`sendMessageFromText` ([app.js:6795](../app.js#L6795)), `appendMessage`, and the
streaming helpers are mutually entangled. Expect this slice to surface the real
shape of the fix in F-03.

**Done when (each):** harness green, app boots, no console errors, no behaviour
change observable.

### F-03 — stream orphaning

Make the in-progress reply **derivable from state**: park the accumulating text
on the conversation (e.g. a `pendingReply` field) so `renderChatThread()` can
paint the live bubble on return and chunks keep flowing. Then guard
`appendMessage` / `startStreamingMessage` / `showTypingIndicator` to no-op on the
DOM when the target chat isn't the view currently showing — state still updates,
rendering happens on return.

**Done when:** harness checks for bug 1 go green; manual check that leaving and
returning mid-response shows a live, still-streaming bubble.

### F-04 — draft ownership

Store draft text + pending attachments per conversation; swap them in
`switchConversation`. Owned by `chat/composer.js`.

**Done when:** harness check for bug 2 goes green.

### F-05 — Enter-behaviour toggle

Today: plain Enter inserts a newline, **Shift+Enter sends**
([app.js:9904](../app.js#L9904)). Intentional, and the human wants to keep it as
the default.

Add a new **Accessibility** section in Settings with a toggle between
"Shift+Enter sends" (default, current behaviour) and "Enter sends".

**Store it device-local in `UiPrefs`**, alongside theme / devMode / filePanelMode
— not account-synced. A phone keyboard and a desktop keyboard genuinely want
different answers, so syncing it across devices would fight the user.

**Done when:** both modes work, the default is unchanged for existing users, and
the preference survives a reload.

---

## Open items

- **Live-key debt carried over.** The scratchpad (SP-05 wording) and context
  toggles (pin injection, model calling `read_file` on a manifested file) still
  owe a live pass with real provider keys. F-01 is a prerequisite for any of it —
  Anthropic sends currently fail outright.
- **Junk test data.** The **"SP-04/05"** chat in the local dev DB holds ~17
  throwaway messages from the 2026-07-24 investigation (it was empty before).
  Harmless; delete the chat whenever convenient.
- **Cleanup slice ✅ done.** All of it, in one PR:
  - `elements.closeSettingsModal` removed — the button lives inside the
    `#settingsModal` shell that `main.js` deletes at load, so the cache entry had
    always been null after boot.
  - `FilePanel.revisionsUrl()` removed — no callers anywhere in the repo.
  - `switchTab` inlined at its single call site and deleted from `shell.js`. It
    was a two-line shim over `navigate()` left from the old sidebar-tab UI.
  - **Both near-duplicate formatter pairs merged**, which is a visible change and
    the reason they were left alone during the move slices: `formatBytes` folded
    into `formatFileSize`, so the persona-export toast now reads `12.3 KB`
    instead of `12 KB`; `formatRelativeTime` folded into `formatTimeAgo`, so file
    version labels read `Just now` instead of `just now`. One rounding rule and
    one wording, everywhere.
  - The stray `nul` file (captured `curl -V` output from a Windows `> nul`
    redirect) deleted. It was never tracked by git.
- **Still open, deliberately:** `showConversationMenu` positions its menu inline
  (`menu.style.position = 'fixed'`) instead of using `positionPopover`, so it
  misses the shared helper's flip-above-the-anchor behaviour near the viewport
  bottom. Switching it over changes where a menu appears, so it wants its own
  look rather than a line in a cleanup PR.
- **Decided:** `file-panel/index.js` stays **one file**. It moved whole in R-03
  and the boundary audit found it genuinely self-contained (16 imports, all used,
  no top-level side effects), so splitting it into viewer/browser/history would
  be a design change with no dependency pressure behind it. Revisit only if it
  grows.
