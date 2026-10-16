# Tool Trail in History — Design

> **Status (2026-10-15):** In progress — TT-01 (#215) and TT-02 (#216) shipped; TT-03 live pass owed.

Arising from: the 2026-10-15 live run (`docs/PROJECT.md` §8, *Found in the
2026-10-15 live run*). Revisits one exclusion in
[`FILE_PROVENANCE_DESIGN.md`](FILE_PROVENANCE_DESIGN.md) §4.

---

## 1. The problem

Tessera saves only the final text of each reply. On the next message the model
sees its own earlier words ("Created haiku-notes.md… moved it into the
project") with nothing behind them: no tool call, no result.

In the 2026-10-15 run, `claude-haiku-5-5` opened nearly every reply after a
tool-using turn by apologising for "reporting results I hadn't seen", and
sometimes re-ran the tools. The tools had actually worked; the server log and
Drive confirmed it. `gemini-3.8-flash` did not react this way.

Two things combine:

- **No record.** Inside one reply the tool loop does see full calls and
  results (`runToolLoop`, `server/src/routes/chat.js`). Across replies, the
  history the client sends (`buildChatRequest`, `js/chat/send.js`) is
  `{ role, content }` only.
- **A rule that punishes the gap.** The base prompt says "Never invent facts,
  fabricate file contents, or claim work you didn't do"
  (`server/src/prompts/tessera.js`). A careful model sees claims it can't
  verify and applies that rule to itself.

The record already exists. Every saved reply keeps its tool calls as
`tool_event` / `created_file` entries in the message's `attachments` JSON
(tool name, filename, ok/failed). These drive the chips under each message;
the model has simply never been shown them.

## 2. Options considered

| | What the model sees | Prompt growth | Verdict |
|---|---|---|---|
| **A. Tool trail** | One line per past reply naming the tools and targets | ~50 tokens per tool-using reply | **Chosen** |
| B. Full replay | The real tool calls and results, every turn | ~2,500 tokens per tool-using reply (whole files for `read_file` / `create_file`) | Rejected |
| C. Prompt sentence only | "Earlier tool calls aren't shown; they were real" | ~0 | Too weak alone; kept as half of A |

**Measured scale.** Take a 30-message chat where every third reply uses tools.
By message 30, B has added about 25,000 tokens to every request and about
360,000 billed input tokens over the chat. A adds about 500 and 7,000. The chat
itself is 15–20k tokens by then, so B more than doubles each late request
while A adds about 3%. Caching softens B less than it looks: the cache lives 5
minutes (`CACHE_CONTROL` in `providers/anthropic.js`), and people pause longer
than that between chat messages.

**B's other cost is correctness.** Every replayed `read_file` result is the
file as it was at that moment. After a few edits the history carries several
stale copies that contradict the current content Tessera injects each turn.
That is the second half of the original exclusion ("duplicates state the DB
holds authoritatively"), and replay makes it worse.

**What other harnesses do.** Agentic coding tools replay full tool traffic
*within* a task (Tessera's tool loop already does), then clear old results
and keep a placeholder showing the call happened, and summarise when context
runs long. Anthropic's API offers this as "context editing" (clear old tool
results, keep the call). Keeping the record and dropping the result for older
turns is the standard long-term shape, and A is that shape.

## 3. Decisions

**D1. Add a compact trail; keep excluding full replay.** This narrows the
`FILE_PROVENANCE_DESIGN.md` §4 exclusion rather than overturning it: tool
*results* (and inputs such as file content) are still never replayed. Only
names, targets and outcomes are. The reason for the exclusion, unbounded
growth and duplicated state, still holds and is respected.

**D2. Built from saved attachments, on the client, at request time.** History
already comes from the client, and `buildChatRequest` is shared by the send
path and the prompt inspector, so the two cannot drift. The trail is derived
from the message's saved `attachments`, so the stored `content` is untouched
and nothing in the DB changes shape.

**D3. Format: one tagged line at the start of the assistant message.**

```
<tool_trail>create_file haiku-notes.md · move_file haiku-notes.md → project · read_file plan.md (failed)</tool_trail>
```

- At the **start**, so the model reads the evidence before its own claims.
- **Tool name + target + outcome only.** Targets: the filename; the
  destination for `move_file`; nothing for the scratchpad tools or
  `list_files` (the tool name says it). Only a failure is marked. Success is
  the default, and a marked failure is what stops the model claiming success.
- **In call order**, capped at 12 entries, then `+N more`.
- Replies with no tool attachments (including every legacy message) get no
  line.
- Generated-image attachments are not tools and are skipped.

**D4. One sentence in the base prompt explains it.** Unconditional, in the
static Tessera layer next to the "claim work you didn't do" rule, so it never
varies between requests. Draft wording (polished last, per the working
rules):

> Earlier replies of yours may begin with a `<tool_trail>` line. Tessera adds
> it to record the tools you actually ran in that reply; their results aren't
> repeated, but they were real. Don't write a trail yourself.

**D5. Caching stays intact.** A past message's trail is a pure function of
its saved attachments, so each past message renders byte-identical on every
later request; history stays append-only
([`PROMPT_CACHING_DESIGN.md`](PROMPT_CACHING_DESIGN.md)). The one cost is a
single cache miss on the first request after deploy, plus one more after the
base-prompt sentence lands. A re-rolled reply gets its new attachments, and
therefore its new trail, exactly as its text changes today.

**D6. Guard against imitation.** The model might copy the tag into its own
new reply. Mitigations: the prompt sentence says not to, and the client
strips a leading `<tool_trail>…</tool_trail>` from model output before
display and save, so a copied line never becomes "evidence" on the next turn.
Whether the guard is ever needed is a TT-03 observation.

### Explicitly excluded

- **Tool results or inputs.** No file content, no `old_text` / `new_text`.
  That is B under another name.
- **Server-side reconstruction from the DB.** Doable, but history is the
  client's job today; a second assembly path invites drift.
- **Provider-native tool blocks** (`tool_use` / `functionCall` shapes). They
  are provider-specific, break mid-chat model switches between Anthropic and
  Gemini, and add nothing a text line doesn't.
- **Softening the "claim work you didn't do" rule.** It guards against real
  fabrication; the fix is giving the model the evidence, not loosening the
  rule.

## 4. Slices

**TT-01 — capture the move destination.** The tool event (and the
`tool_event` attachment from `toolEventToAttachment`, `js/chat/thread.js`)
records `destination` for `move_file`. Today only `input.filename` is kept.
Messages saved before this get a trail without the arrow; acceptable. Test:
a `move_file` event round-trips its destination into the attachment.

**TT-02 — the trail.** A dependency-free formatter
`formatToolTrail(attachments)` (`js/util/`), used by `buildChatRequest` to
prefix assistant content; the base-prompt sentence; the D6 strip on model
output. Tests: a node unit test for the formatter (order, failure mark, cap,
no-tools → empty, image attachments skipped), seen to fail; prefix stability
via `routes/test-cacheprefix.js`; inspect `POST /api/chat/preview` to see the
trail in the assembled request.

**TT-03 — live pass (owed; needs an AI key).** Re-run the 2026-10-15 scenario
on `claude-haiku-5-5` and `gemini-3.8-flash`: tool-using turn, then two
follow-ups. Pass = no "results I hadn't seen" apology, no needless re-runs, no
copied `<tool_trail>` in output. If Haiku still doubts itself, tune the D4
wording before anything bigger.
