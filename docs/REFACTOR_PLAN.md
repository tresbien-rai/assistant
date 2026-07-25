# Frontend refactor — plan

Splitting `app.js` (10,476 lines / 450 KB) into modules, and fixing the class of
bug that its size has been hiding. Written to be picked up cold in a new session:
each slice is independently shippable and says what "done" means.

> **Status (2026-07-24):** Plan **locked** with the human. Nothing built yet.
> Ordering decision: the live provider blocker (F-01) and the test harness (F-02)
> ship **before** any code moves; the stream-orphaning fix (F-03) ships **after**
> the extraction, because the fix *is* the boundary being drawn.

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
and renders *inside the Chats/Personas/Workspaces list*. (Read-confirmed; the
scripted repro of this variant was blocked by a permission prompt.)

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
| ☐ | **F-01** | top_p/temperature fix + server test | trivial — ship first |
| ☐ | **F-02** | Frontend smoke harness; 3 bugs encoded as failing checks | none (additive) |
| ☐ | **R-00** | `<script type="module">`; `api-client.js` → module. No code moves | low — proves loading |
| ☐ | **R-01** | Extract `util/`, `components/` (leaves, no deps) | low |
| ☐ | **R-02** | Extract `config` / `state` / `dom` / `ui-prefs` | medium |
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

### F-01 — top_p blocker

Guard the Anthropic provider so `temperature` and `top_p` are never both sent.
Prefer `temperature` when both are enabled (it's the one users actually tune).
Add a case to the provider tests. Consider whether the Models detail UI should
show the two as mutually exclusive — worth a note, not necessarily this slice.

**Done when:** a real Anthropic send succeeds with stock default model params.

### F-02 — frontend smoke harness

The investigation already produced ~80% of this: stub `API.chat.stream`, drive
the real UI through send / navigate / switch sequences, assert invariants.

Checks to encode (all three currently **fail**, which is the point):

- `messagesContainer` message count === `state.conversations[id].messages.length`
  after any navigation round-trip during a live turn.
- No orphaned `state.streamingMessageDiv` (`document.contains()` must hold while
  a turn is in flight).
- `data-msg-index` values are contiguous from 0.
- Composer draft and `state.pendingAttachments` are empty after switching to a
  different conversation.
- The rail round-trip (compose → tab → back → send) leaves the composer visible,
  `messagesContainer` unhidden, and send enabled. *(This one already passes for
  all five rail destinations — worth locking in so the refactor can't break it.)*

**Done when:** the harness runs from the browser console (or headlessly), reports
pass/fail per check, and the three known bugs show red.

### R-00 → R-05 — extraction

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
