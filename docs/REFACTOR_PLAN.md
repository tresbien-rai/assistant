# Frontend refactor — plan

Splitting `app.js` (10,476 lines / 450 KB) into modules, and fixing the class of
bug that its size has been hiding. Written to be picked up cold in a new session:
each slice is independently shippable and says what "done" means.

> **Status (2026-07-25):** Plan **locked** with the human.
> **F-01 ✅ merged (PR #125)** — Anthropic sends work again with stock params.
> **F-02 ✅ merged (PR #126)** — the smoke harness runs, and reports **1 pass /
> 3 fail**: the three known bugs are now red on demand instead of anecdotal.
> **R-00 ✅** — the frontend is an ES module (`js/main.js` + `js/api-client.js`),
> harness identical before and after.
> **R-01 ✅** — `util/markdown`, `util/image-store`, `components/menus` extracted;
> dialogs + toast deferred to R-02 (they need `dom.js`). Next up: **R-02**.
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
| ☐ | **R-02** | Extract `config` / `state` / `dom` / `ui-prefs`, **then** `components/dialogs` + `components/toast` | medium |
| ☐ | **R-03** | Extract `file-panel/` — biggest single win, already cohesive | medium |
| ☐ | **R-04** | Extract `views/` + `router.js` | medium |
| ☐ | **R-05** | Extract `chat/` — the tangled part, deliberately last | high |
| ☐ | **F-03** | Fix stream orphaning (bug 1) | low once R-05 lands |
| ☐ | **F-04** | Draft + attachments per conversation (bug 2) | low |
| ☐ | **F-05** | Accessibility section + Enter-behaviour toggle | low |
| ☐ | **S-01** | Split `styles.css` (5,957 lines) into `styles/` + `<link>` tags | low, independent |

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

### R-02 → R-05 — extraction

Mechanical. Move code, add `import`/`export`, change nothing else. Take the
`elements` cache (`app.js` ~1370–1500) with `dom.js` in R-02 — most modules need
it, so it must land before the view slices.

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
- **Dead cache entries.** `elements.settingsModal` / `closeSettingsModal` are
  cached but the node is removed at load ([app.js:9522](../app.js#L9522)). Sweep
  during R-02.
- **Stray `nul` file** in the repo root (Windows `> nul` redirect artifact).
- **Not yet decided:** whether `file-panel/index.js` should be split further
  (viewer / browser / history) during R-03 or left as one file. Recommend leaving
  it whole in R-03 and revisiting once it stands alone.
