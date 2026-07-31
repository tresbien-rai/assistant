# Session State & Tool Feedback — Design

Status: **decisions locked, implementation pending**
Arising from: live testing of the streaming tool loop (TS-01…TS-03)

---

## 1. The problem

The model is told what it *can do* (tool definitions) and given content that
*exists* (the scratchpad block, the KB manifest). It is told almost nothing
about **absence**.

Three things look identical from inside the prompt today — an empty scratchpad,
a conversation with no files, and a chat that belongs to no workspace or
project. All three are silence. `resolveScratchpadBlock` returns `null` when the
pad is empty (`server/src/utils/scratchpadContext.js:45`, "empty-skip"), the KB
manifest is omitted when there is nothing to list, and nothing anywhere says
"this chat has no container".

The model therefore cannot distinguish **"there is nothing there"** from
**"I wasn't told"**. That drives two bad behaviours:

- speculative tool calls to discover state it could have been handed for free
- referring to workspace/project files in a bare chat, because the tool
  descriptions state those containers as though they always exist

Compounding it: `resolveAdvertisedTools` (`server/src/routes/chat.js:463`)
advertises the **same** file tools regardless of whether the chat has a
container. In a bare chat the model sees `list_files` described as listing "the
current project or workspace", which is describing a thing that cannot exist.

---

## 2. Locked decisions

### D1 — Both edit tools report a delta, not just a total

A total length cannot confirm an edit. "Now 3,700 characters" tells the model
nothing about whether its replacement landed; 4,000 before and 4,000 after look
the same. The confirmation signal is **what changed**.

Both `edit_scratchpad` and `edit_file` adopt one shape:

```
<subject> — <N> replacement(s), <before> → <after> (<delta>).
```

Concretely:

| tool | before | after |
|---|---|---|
| `edit_scratchpad` | `Edited the scratchpad — now 3700 characters.` | `Edited the scratchpad — 1 replacement, 3,860 → 3,700 characters (−160).` |
| `edit_file` | `Edited "notes.md" — now 12.4 KB.` | `Edited "notes.md" — 1 replacement, 12.6 KB → 12.4 KB (−200 bytes).` |

They change **together**: two editing tools reporting success differently is its
own source of confusion. The trailing download-link sentence on `edit_file` and
the size warning on `edit_scratchpad` are unaffected.

Expected effect: fewer read-back calls to verify an edit landed.

### D2 — A session-state block, always present, reporting absence explicitly

A short block that always states the same keys, whether or not they have
values. Stable keys are the point: a key that disappears when empty recreates
the exact ambiguity being fixed.

It covers everything the platform can reference:

- **Container** — no workspace/project, or which one, and whether it has
  instructions
- **Scratchpad** — empty, or present (content continues to be injected
  separately)
- **Files** — none, or counts by scope

### D3 — It is plumbing, not user content

The block always ships. A user cannot delete it or rewrite its text, because a
prompt that lies about state is worse than one that omits it.

The compromise: it is a **position-only preset block**, exactly like the
existing `persona` block (`SYSTEM_BLOCK_IDS` in `server/src/prompts/presets.js:43`,
rendered with `positionOnly: true` in `js/views/settings.js:394`, which already
suppresses the textarea). Users can move it relative to the other blocks; they
cannot edit or disable it.

That reuses a pattern the preset system and its UI already support, so this is a
new block id rather than a new concept, and it shows up in the AP-05 inspector
like everything else.

### D4 — Tool descriptions become scope-neutral, and the state block carries the truth

Rejected: gating the advertised tool list on whether a container exists. A tool
list that changes shape between turns is harder to reason about, is hostile to
prompt caching if we ever add it, and would churn mid-conversation when a
workspace is attached.

Chosen: keep the tool list **stable**, pare the descriptions back to what the
tool *does*, and let the state block say what *exists*. Descriptions stop
asserting a container ("the current project or workspace") and describe scope
neutrally, deferring to the state block for what is actually there.

This also shortens the descriptions, which is its own benefit — they have grown
long enough to bury the operative sentence.

### D5 — No new-conversation marker

Considered and dropped. `Scratchpad: empty. Files: none.` already communicates
"fresh chat" without a marker whose only meaning is itself. A `[new
conversation]` tag is the kind of token models over-read, inviting a greeting or
preamble nobody asked for. If turn-one behaviour should differ, the persona
prompt is the honest place to say so.

---

## 3. The scratchpad's intended role

Recorded here because it is the premise behind D1 and D2, and it is not
derivable from the code.

The scratchpad is **the default place where ideas get documented, edited, and
scratched out**. The chat is for miscellaneous communication *about* that work.

Worked example: a user brainstorming a novel draft. The cast, setting, and
premise belong **in the pad**, developed in place — added to, cut, rewritten.
The chat is where the two of you discuss those changes, not where the ideas are
restated in prose.

Two consequences:

- The pad is a **prominent** part of the system, not an accessory. Feedback
  about it (D1) and awareness of it (D2) are worth real investment.
- When a pad grows long, it should **graduate to a file** rather than keep
  growing. This is the existing churn principle (replace, don't append) plus an
  exit ramp.

The SP-05 nudge wording was always "a starting point to tune live". This section
is the target it should be tuned toward.

---

## 4. Shape of the state block — options

The one genuinely open question. Sketches, populated and empty.

### Option A — XML-ish, matching `<scratchpad>` and the KB containers

```
<session_state>
Workspace: none. This chat is not in a workspace or project.
Scratchpad: empty.
Files: none.
</session_state>
```

```
<session_state>
Project: "Novel draft" (workspace "Writing"). No project instructions set.
Scratchpad: 1,240 characters — current content below.
Files: 3 in this conversation, 2 in the project knowledge base.
</session_state>
```

Consistent with the prompt's existing idiom. **Recommended.**

### Option B — bare labelled lines, no wrapper

Cheaper by a few tokens, but floats without an obvious owner among the other
blocks, and is easier for the model to mistake for user content.

### Option C — a compact single line

`State: no workspace · scratchpad empty · no files`

Tightest, but degrades badly once a container has a name and files have counts.

**Open sub-questions**

1. **Element name.** `<session_state>` vs `<workspace_state>` vs `<current_state>`.
   "Workspace" is too narrow — the block covers the pad and files too.
2. **A workspace with no instructions.** Say so explicitly ("No project
   instructions set") or stay silent? Explicit costs a few tokens and prevents
   the model inferring that instructions exist but were withheld. Leaning
   explicit, consistent with the rest of this design.
3. **File counts vs names.** Counts only, or the names too? Names duplicate the
   KB manifest when one is injected. Leaning counts, with the manifest remaining
   the source for names.

---

## 5. Placement, and the caching trade-off

Two candidate layers, with a real difference:

- **System prompt** (a block in `composeSystemPrompt`) — part of the cacheable
  prefix. But the values are volatile: the pad flipping empty→non-empty, or a
  file count changing, rewrites the prefix and invalidates the cache from that
  point on.
- **Message layer** (appended to the last user message, where
  `resolveScratchpadBlock` already puts the pad) — never part of a cacheable
  prefix, so volatility costs nothing.

**This does not bind today**: the app implements no prompt caching — there is no
`cache_control` anywhere in `server/src/`. So the choice is currently free, and
the argument is about not making caching harder to add later.

D3 puts the block in the preset system for position control, which points at the
system layer. But `context_ack` is precedent for a block that is listed and
resettable while the *assembly* positions it rather than the user's `order`
(`MESSAGE_BLOCK_IDS`, `server/src/prompts/presets.js:50`).

**Recommendation:** system layer for now, as a position-only system block, since
caching is hypothetical and position control was explicitly wanted. Revisit if
and when caching lands — at which point splitting the block into a static part
(early, cached) and a volatile part (late) is the natural move.

---

## 6. Implementation slices

| id | slice | depends on |
|---|---|---|
| SS-01 | Delta reporting in `edit_scratchpad` + `edit_file` (D1) | — |
| SS-02 | State resolver: container / scratchpad / files → the block text (D2) | shape agreed |
| SS-03 | Wire it as a position-only preset block (D3), inspector + settings UI | SS-02 |
| SS-04 | Tool description pass, scope-neutral (D4) | SS-02 |

SS-01 is independent and self-contained, so it goes first. SS-04 lands after
SS-02 so the descriptions can defer to a block that already exists.

---

## 7. Deferred

- Prompt caching, and the block split it would justify (§5)
- Any change to how the pad's *content* is injected — this design only adds
  awareness of its absence
- Automatic "this pad is long, promote it to a file" prompting; §3 makes it a
  principle, not yet a mechanism
