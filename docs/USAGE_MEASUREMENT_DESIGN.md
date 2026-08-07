# Usage Measurement — design

**Status:** specified, not built.
**Relates to:** prompt caching (this unblocks measuring it), `docs/SESSION_STATE_DESIGN.md`.

Record what every provider call actually cost, so the user can see their spend and
see *where* it goes.

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
    raw              TEXT,          -- the provider's own usage object, verbatim
    created_at       INTEGER NOT NULL
);
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

## 6. Cost in money

**Tokens are stored; money is a display layer.** Prices drift, and a bundled
price table would silently show wrong numbers the moment it goes stale — worse
than showing none, because the user would trust it.

Per-model rates are **user-editable**, defaulting to unset. With no rate, the UI
shows tokens only. This also handles the cases a bundled table cannot: negotiated
pricing, a provider's free tier, credits.

---

## 7. Slices

**U-01 — capture.** `usage_events` table, `extractUsage` on both providers, and
recording in `runToolLoop`. Tests: the Gemini thinking-sum, `thinking_tokens`
null vs 0, a round index that increments, and a failed write not breaking a turn.

**U-02 — the passthrough tee.** Toolless turns land in the same table. Tests
prove both paths produce equivalent rows for an equivalent turn.

**U-03 — read API.** `GET /api/conversations/:id/usage` → per-turn rollup
(rounds collapsed, with a round count) plus conversation totals.

**U-04 — surface.** Status bar shows real tokens; a per-turn breakdown showing
where the tokens went and how many rounds it took. The dev-mode "view request"
(`⟨⟩`) button is the natural neighbour for the detailed view.

**U-05 — rates and cost.** User-editable per-model rates; cost shown only where
a rate exists.

**U-06 — later, once caching ships.** `cache_read` / `cache_write` are captured
from U-01 but read ~0 until then. When caching lands, hit rate is already
measurable with no new capture — which is the point.

U-01 through U-03 need no keys beyond a single live turn to verify.

---

## 8. Open question

Whether to record usage for turns the user **aborts**. The tokens were spent —
the provider billed for the rounds that completed — so omitting them
under-reports real cost. But attributing spend to a turn with no visible
assistant message may read as a bug rather than a cost. Leaning toward recording
them and marking them aborted, so the totals stay honest; deferred to U-03,
where the rollup shape makes the display consequence concrete.
