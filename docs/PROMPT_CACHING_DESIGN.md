# Prompt Caching — Design

Tessera re-sends the whole conversation on every turn, and pays full input
price for all of it. Both providers will serve most of that prefix from cache
instead — Anthropic for an explicit ~90% discount, Gemini automatically — but
only if the bytes ahead of the newest turn are **identical to last turn's**.

They are not. This document says why, and what to change.

`docs/USAGE_MEASUREMENT_DESIGN.md` §5 is the neighbour: `cache_read` and
`cache_write` have been captured per provider call since U-01 and read `0`
because nothing writes a cache yet. Nothing here adds instrumentation — the
measurement already exists and starts reporting the moment this lands.

---

## 1. The one rule

**Caching is a prefix match. A single changed byte invalidates everything
after it.**

Render order is `tools` → `system` → `messages`. So content must be laid out
**most stable first**, and the cache breakpoint goes at the last position whose
bytes this request and the *next* request will both reproduce.

That is the whole feature. Marker placement is downstream of getting the
layout right; markers on a prefix that churns buy nothing but the write
premium.

---

## 2. Two things break the prefix today

### 2.1 `<session_state>` is inside the system prompt

`prompts/sessionState.js` reports the scratchpad's character count and the file
count per scope. Both change during ordinary tool use — the model writes the
pad, and the pad's length is in the system prompt.

`SYSTEM_BLOCK_IDS` puts `state` at index 1, ahead of `expressions`,
`scratchpad` and `persona`, so a changed count invalidates the rest of the
system prompt as well. And per the API's invalidation hierarchy, a system
change invalidates the **messages** cache too.

So: on any turn where the model touched the pad or made a file, the entire
conversation history is re-processed at full price. In tool-using work — the
work Tessera is for — that is most turns.

Moving the block later in the system prompt does not help. *Anywhere* in
`system` is ahead of every message. It has to leave the system layer.

### 2.2 Injected blocks are appended, then dropped

`appendToLastUserMessage` (`utils/activeFiles.js`) bolts `<active_files>` and
the scratchpad onto the last user message at send time. Those blocks are never
persisted — deliberately, since FC-03b's recency window is meant to expire
them.

The consequence is a rewrite of history:

```
turn N     … a(N-1), [ u(N) + blocks ]
turn N+1   … a(N-1),   u(N) bare,  a(N), [ u(N+1) + blocks ]
                       ^^^^^^^^^^ different bytes here
```

Every request therefore **ends in bytes no later request reproduces.** A
breakpoint at the tail — which is exactly where Anthropic's top-level
automatic caching puts one — writes an entry that can never be read. That is
not neutral: it is the write premium (1.25×) charged on every turn for nothing.

The good news is what the diagram also shows: `u(1) … a(N-1)` **is** stable.
Each user message is augmented only on its own turn and is bare forever after,
so the longest common prefix between consecutive requests runs to the last
assistant message. That is a long, cheap, growing prefix — it is just not
where a naive breakpoint lands.

---

## 3. Decisions

**D1 — `<session_state>` moves to the message layer.** It becomes a message
block like `context_ack`, appended to the last user message alongside the
`<active_files>` and scratchpad blocks it already talks about.

Three reasons, in order of weight:

1. It is the only placement that leaves the history cache intact. Anything in
   `system` invalidates every message behind it.
2. It is where the block's own content already points. `scratchpadLine` says
   *"current content below"* — and the pad content is injected into the
   message layer. Today that sentence refers forward past the entire
   conversation; after this it refers to the adjacent block.
3. It matches the established pattern. Volatile per-request state already goes
   through `appendToLastUserMessage`; `state` was the one exception.

**What this costs:** presets can no longer choose where `state` sits, because
the assembly positions message-layer blocks (same as `context_ack` today). The
knob only ever meant "where among the other system blocks", which stops being
a meaningful question once it is not a system block. It remains undisableable
and uneditable, as SS-02 requires.

**What this does not change:** the block is still built per request from live
state, still always present, still says what does *not* exist. SS-02's two
rules (stable keys, counts not names) are untouched.

**Authority note.** Moving it from the system role to a user turn lowers its
nominal authority. That is correct here and not a concession: `<session_state>`
is *factual plumbing*, not instruction — the same reasoning that already puts
user file **data** in the user role (`assembleProviderInput`) rather than the
system role.

**D2 — no top-level automatic caching on Anthropic.** §2.2: it marks the tail,
which is never read back. Explicit breakpoints only.

**D3 — three explicit breakpoints, at the three real stability boundaries.**

| # | Position | Stable across | Reads |
|---|---|---|---|
| 1 | last `system` block | everything, until the persona/preset/tools change | every request, forever |
| 2 | last message of the stable history (the last assistant turn) | turns | every turn after the first |
| 3 | the growing tool-loop tail | rounds within a turn | every round after the first |

Breakpoint 2 is the one that matters and the one a default implementation gets
wrong. Breakpoint 3 pays off because the tool loop reuses `system`/`tools`
verbatim per round and only appends — so within a turn the tail *is*
reproduced, which is precisely what makes it different from the cross-turn
case.

Three of the four allowed breakpoints, leaving one spare.

**D4 — Gemini gets implicit caching only; no `cachedContents`.** Implicit
caching is on by default for Gemini 2.5+, needs no request parameters, and its
only lever is prefix stability — which D1 supplies. Explicit caching would
require a server-side cache registry, TTL lifecycle, per-user-key scoping and
cleanup, all of which must be torn down and rebuilt whenever the prefix
changes. That is a large amount of moving machinery for a personal app, and it
would earn its keep only under traffic Tessera does not have.

The honest caveat: Gemini's implicit minimum is 2,048 tokens (2.5 Flash/Pro)
and 4,096 on newer Flash models, against a Tessera prefix of roughly 2,500
tokens of tools + system. Short conversations on a large-minimum model will
simply not cache, silently and with no error. Nothing to be done about that
beyond measuring it — which U-01 already does.

**D5 — default (5-minute) TTL.** A cache read refreshes the entry's timer for
free, so continuous chat keeps a 5-minute entry alive indefinitely. The 1-hour
TTL costs 2× on write instead of 1.25× and only pays off for gaps in the
5-60 minute band. A user coming back to a chat after an hour is a cold miss
either way. Revisit only if measurement shows the 5-60 minute reply gap is
common.

---

## 4. What must not regress

Caching failures are **silent**. Nothing errors, no output changes; the bill is
just higher. The failure mode is not a bad first implementation — it is a
later, innocent-looking change to prompt assembly that reintroduces churn ahead
of a breakpoint and goes unnoticed for months.

So the load-bearing deliverable of PC-01 is not the move; it is the **standing
test** that the move stays true:

- the assembled `system` is **byte-identical** across two requests that differ
  only in session state (different scratchpad length, different file counts);
- the assembled message prefix ahead of the last user message is byte-identical
  across consecutive turns of the same conversation;
- `state` renders exactly once, in the message layer, and is still present when
  everything in it is empty.

Both of these assert on **bytes**, not on shape. The handoff of 2026-07-31
records the same lesson twice (#170, #171): a fixture that models the wrong
wire shape cannot detect a wire-shape error. A test that re-derives the prefix
through the same helper it is testing would pass while caching is broken.

### Known invalidators to leave alone, and one to warn about

- **Tool definitions** are static module-level literals in a fixed order
  (`tools/definitions.js`) — deterministic, nothing to fix. The set changes
  only when the user toggles tools or the scratchpad for a chat, which is a
  user action with an obvious cause.
- **Model switching** invalidates everything; caches are model-scoped. The
  composer's quick-switch makes that one click, and that is fine — it is the
  user's explicit choice, and U-04 already groups every usage rollup by
  `(provider, model)` for exactly this reason.
- **`{{date}}` and `{{time}}` macros** are a live footgun: `{{time}}` is
  HH:MM UTC, so a preset that uses it in a system block re-writes the prefix
  **every minute**. Not worth removing — it is legitimately useful — but the
  preset editor should say so where the macro is documented.

---

## 5. Slices

**PC-01 — freeze the prefix.** `state` moves from `SYSTEM_BLOCK_IDS` to
`MESSAGE_BLOCK_IDS`; the assembly appends it via `appendToLastUserMessage`
next to the blocks it describes. Provider-neutral. This slice **is** the
Gemini feature (D4) and the precondition for PC-02. Tests per §4.

Frontend cost is near zero: the preset editor already renders its two groups
from `presetDefaults.systemBlockIds` / `messageBlockIds`, so the card moves to
"Not part of the system prompt" and stops being draggable on its own. Only its
description text needs rewording. A stored preset with `state` in its `order`
degrades cleanly — `normalizeBlocks` already filters `order` to the system ids.

**PC-02 — Anthropic breakpoints.** `system` becomes an array of text blocks so
the last one can carry a marker; breakpoints 2 and 3 per D3. No top-level
`cache_control` (D2). Tests assert marker **positions** on a built request
body, plus the negative: no marker on the augmented last user message.

**PC-03 — not planned.** The surface exists: U-04 renders the cache columns
whenever they are non-zero, so hit rate appears by itself. If measurement later
shows something worth acting on, that is a new slice with real data behind it.

---

## 6. How to tell it worked

`cache_read_input_tokens` > 0 on the second turn of a conversation, and the
healthy multi-turn signature thereafter:

- **cache read** — the whole prior prefix; grows turn over turn;
- **cache write** — roughly the last turn's addition; small next to the
  conversation;
- **input** — just the tail past the last breakpoint.

Cache writes near the full conversation size on every request means the prefix
is still being rewritten upstream of a breakpoint — go back to §2.

This is visible in the usage panel already (U-04) with no further work.

### Measured, 2026-09-06 (PC-02, live against the real API)

Two turns, `claude-opus-5`, tools off:

| | input | cache write | cache read |
|---|---:|---:|---:|
| turn 1 | 118 | 1,566 | 0 |
| turn 2 | 49 | 82 | **1,566** |

The healthy signature above, exactly: turn 2 read the entire prefix turn 1
wrote, wrote only the 82-token delta the new turn added, and paid full price
for just the 49-token tail. 92% of turn 2's input was served from cache.

**Gemini is not covered by this measurement.** Its implicit caching needs no
code (D4) and the prefix is stable as of PC-01, but the minimum cacheable
prefix is 2,048 tokens (2.5 Flash/Pro) or 4,096 (newer Flash), and a
tools-off Tessera prefix is around 800. Expect hits once tools are on or the
conversation grows; below the minimum it simply reports zero, with no error.
Worth one live confirmation on a tools-on chat.
