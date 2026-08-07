# Usage Measurement — design

**Status:** specified, not built.
**Relates to:** prompt caching (this unblocks measuring it), `docs/SESSION_STATE_DESIGN.md`.

Tessera reports **tokens, never money** (§6) — every provider prices per million
tokens, so identifiable usage is enough for the user to price it themselves.

Record what every provider call actually consumed, so the user can see their
usage and see *where* it goes.

---

## 1. The problem

Users bring their own API keys, so every token is money out of their pocket. The
one number Tessera shows them is wrong in a way that is not close.

**The current estimator** (`js/chat/send.js`, `js/chat/thread.js`):

```js
state.estimatedTokens += Math.ceil(fullText.length / 4);
```

Client-side `chars/4`, accumulated over **message text only**. It omits the
system prompt, the tool definitions, and injected file content.

Measured against a real request: a tools-on turn whose user message was `"hi"`
cost **2,466 input tokens**. The estimator would have shown approximately
**zero**. The two largest contributors are the ones it doesn't count:

| Component | Size | Counted today |
|---|---|---|
| Tool definitions | ~2,000 tokens | ❌ |
| System prompt | ~560 tokens | ❌ |
| Message text | a few tokens | ✅ |

**The providers already report the truth and we discard it.**
`anthropic.streamRaw` latches `usage` from `message_start` and merges the
`message_delta` update; `gemini.streamRaw` latches `usageMetadata`. But in
`routes/chat.js` the word `usage` appears exactly once, in a JSDoc comment.
`runToolLoop` returns `{aborted, toolEvents, streamed}` — every round's usage is
dropped on the floor.

### Why per-round, not per-turn

**A turn is not a request.** With tools on, one user message becomes up to
`MAX_TOOL_ITERATIONS = 5` provider calls, and each round re-sends the entire
history *plus* the ~2,000-token tool block. Cost grows superlinearly in rounds.

That makes a multi-round tool turn the most expensive and least predictable
thing in the app — and it is currently invisible. Recording per round is what
turns "that turn was expensive" into "that turn took four rounds, and rounds 2–4
each re-sent 2,000 tokens of tool definitions."

It is also what makes prompt caching legible: cache hit rate is a per-call
property and cannot be derived from a per-turn total.

---

## 2. Data model

One row per **provider call**.

```sql
CREATE TABLE usage_events (
    id               TEXT PRIMARY KEY,
    conversation_id  TEXT REFERENCES conversations(id) ON DELETE CASCADE,
    message_id       TEXT,          -- the assistant message this turn produced (nullable)
    turn             INTEGER,       -- conversation turn ordinal, as file_revisions uses
    round            INTEGER NOT NULL,  -- 0-based within the turn; >0 means a tool round
    provider         TEXT NOT NULL,
    model            TEXT NOT NULL,
    input_tokens     INTEGER DEFAULT 0,
    output_tokens    INTEGER DEFAULT 0,  -- BILLED output (see normalisation below)
    cache_read       INTEGER DEFAULT 0,
    cache_write      INTEGER DEFAULT 0,
    thinking_tokens  INTEGER,       -- nullable: only when the provider reports it separately
    aborted          INTEGER DEFAULT 0,  -- the turn was stopped by the user (§8)
    output_partial   INTEGER DEFAULT 0,  -- output_tokens is a floor, not a total (§8)
    raw              TEXT,          -- the provider's own usage object, verbatim
    created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_events_conversation ON usage_events(conversation_id);
```

**`raw` is load-bearing.** Providers add usage fields faster than we will
normalise them (`service_tier`, `inference_geo`, `promptTokensDetails`). Storing
the original means a later question can be answered from data we already have,
rather than needing a new capture and a wait for fresh traffic.

`conversation_id` carries the FK so a deleted chat takes its usage with it.

---

## 3. Normalising two providers that disagree

Each provider module gains `extractUsage(raw)` returning the normalised shape
plus the untouched original.

| Normalised | Anthropic | Gemini |
|---|---|---|
| `input_tokens` | `input_tokens` | `promptTokenCount` |
| `output_tokens` | `output_tokens` | `candidatesTokenCount` **+** `thoughtsTokenCount` |
| `cache_read` | `cache_read_input_tokens` | `cachedContentTokenCount` |
| `cache_write` | `cache_creation_input_tokens` | — (no equivalent) |
| `thinking_tokens` | `null` | `thoughtsTokenCount` |

**The one trap worth stating explicitly.** Anthropic's `output_tokens` already
*includes* thinking; Gemini's `candidatesTokenCount` *excludes* it and reports
`thoughtsTokenCount` separately. Summing the two Gemini fields is what makes
`output_tokens` mean the same thing on both sides — without it, Gemini turns
with thinking on would silently under-report, and the error would grow with
thinking level. `thinking_tokens` is kept alongside so the split is still
visible where the provider offers it, and is `null` (not `0`) on Anthropic —
"not reported" is not the same claim as "none".

---

## 4. Capture points

**The tool loop** is the natural choke point: every round already flows through
one place in `runToolLoop`, whether it streamed or not. Record after each
provider call returns, with the loop's iteration index as `round`.

**The toolless passthrough is a second path and must not be forgotten.** When
zero tools are advertised, `provider.stream()` pipes raw provider SSE straight
to the client and never touches the loop — so a turn there would record nothing
and silently vanish from the totals. The fix is to tee the passthrough: parse
frames for usage while forwarding the bytes unchanged, reusing the same
`extractUsage`. Both paths must agree, or the totals are wrong in a way nobody
can see. (This path is rarer since SS-03 put the scratchpad on by default, which
means most sends advertise at least the pad tools — but "rare" is not "never".)

**Failure is never fatal.** A usage write that throws must not fail the turn;
log and continue. Missing usage is a gap in a report, a lost turn is a lost
conversation.

---

## 5. The estimator: fix, don't retire

A pre-send estimate and a post-hoc actual answer different questions — *"should
I send this?"* versus *"what did that cost?"* — and only the estimate exists
before the user commits. Keep both, but make the estimate honest.

The cheap way to do that falls out of the measurement: **the expensive part of
the prefix is stable.** Tools plus the system prompt are ~2,500 tokens and
barely change within a conversation. So:

- take the *measured* prefix cost from the conversation's most recent
  `usage_events` row (real, from the provider's tokenizer),
- add `chars/4` for the new message and the history since,
- show the sum.

The large, stable component becomes exact for free; only the small, volatile
tail stays approximate. A conversation with no usage rows yet falls back to
today's behaviour, clearly marked as an estimate.

---

## 6. Tokens only — Tessera is not a billing dashboard

**We report tokens and never convert to money.** Every provider prices per
million tokens, so a user who can see their token counts can do the arithmetic
against whatever rate they actually pay. Tessera's job is to make the usage
*identifiable*; the rate is the user's to know.

This is a deliberate scope cut, and it gets better as providers are added: a
price table would need maintaining per provider, per model, per tier, and would
show confidently wrong numbers the moment any of them moved. It also cannot
represent negotiated pricing, free tiers, credits, or promotional rates — all of
which are the user's reality and none of which we can see.

### The consequence: segment by model, never just sum

Without a money column, **a total is only useful if the user can apply a rate to
it** — and that means a number that mixes models is worthless. A conversation can
switch models mid-way (the composer's quick-switch makes that a one-click
action), so a turn's rounds are not guaranteed to share a model.

Every rollup is therefore **grouped by `(provider, model)`**, and a
cross-model total is only ever shown alongside that breakdown, never instead of
it. This is the load-bearing consequence of dropping cost display: get it wrong
and the feature produces numbers that look authoritative and cannot be priced.

For the same reason the four token classes stay separate rather than being summed
into one "input" figure — they are priced differently (a cache read is a fraction
of a fresh input token; a cache write is a premium on one), so collapsing them
would destroy the user's ability to compute cost. What began as diagnostics are
now the cost-math inputs.

---

## 7. Slices

**U-01 — capture.** `usage_events` table, `extractUsage` on both providers, and
recording in `runToolLoop`. Tests: the Gemini thinking-sum, `thinking_tokens`
null vs 0, a round index that increments, and a failed write not breaking a turn.

**U-02 — the passthrough tee.** Toolless turns land in the same table. Tests
prove both paths produce equivalent rows for an equivalent turn.

**U-03 — read API.** `GET /api/conversations/:id/usage` returns **both levels,
not a choice between them**:

- **per round** — the raw rows, so a user can see that round 3 re-sent 2,000
  tokens of tool definitions;
- **per turn** — rounds rolled up, with a round count, grouped by
  `(provider, model)`;
- **per conversation** — the same grouping, totalled.

Every level carries the model breakdown (§6) and propagates `output_partial`
(§8), so no total is ever shown as exact when it contains a partial round.

**U-04 — surface.** Status bar shows real tokens; a per-turn breakdown showing
where the tokens went and how many rounds it took. The dev-mode "view request"
(`⟨⟩`) button is the natural neighbour for the detailed view. Aborted turns are
labelled, not hidden.

**U-05 — later, once caching ships.** `cache_read` / `cache_write` are captured
from U-01 but read ~0 until then. When caching lands, hit rate is already
measurable with no new capture — which is the point.

U-01 through U-03 need no keys beyond a single live turn to verify.

---

## 8. Aborted turns are recorded

**Decided: record them, with whatever the provider gave us before the stop.**
Those tokens were billed whether or not the user saw a reply, so omitting them
under-reports real spend — and under-reporting is the one failure this feature
cannot afford, since the whole point is letting the user trust the number.

What is recoverable differs by where the abort lands, and the schema has to be
honest about it:

- **Rounds that completed before the abort** carry full, exact usage. Nothing
  special is needed.
- **The round that was interrupted** is partial. Anthropic reports
  `input_tokens` up front on `message_start`, so the input side is exact and
  known early; `output_tokens` only settles on `message_delta` at the end, so an
  abort mid-stream leaves the output side partial or absent. Gemini latches
  `usageMetadata` from whichever chunks arrived.

So the interrupted round records the exact input it has and whatever output
accrued, flagged rather than silently rounded. Two columns carry this:

```sql
    aborted          INTEGER DEFAULT 0,   -- the turn was stopped by the user
    output_partial   INTEGER DEFAULT 0,   -- output_tokens is a floor, not a total
```

`output_partial` is separate from `aborted` on purpose: it is the narrower claim
("this number is a lower bound") and is the one a rollup must propagate, so a
total containing a partial round is never presented as exact. A turn can be
aborted with every round complete — stopping between rounds — in which case
nothing is partial and the totals stand.

Displaying an aborted turn's cost against a turn with no visible assistant
message could read as a bug, so the surface labels it rather than hiding it: the
tokens were spent, and a user tuning their workflow wants to know that stopping
a runaway tool loop on round four still cost four rounds.
