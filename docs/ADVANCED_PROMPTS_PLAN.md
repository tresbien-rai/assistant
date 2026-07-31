# Advanced — Editable Prompt Presets

Design + task plan for the Advanced settings surface: making Tessera's
platform-level prompt layer visible, editable, and switchable, for users coming
from SillyTavern / RisuAI who expect to own their prompt stack.

> **Status (2026-07-30):** **COMPLETE — AP-01 … AP-06 all built and merged**
> (#151, #152, #153, #154, #155, #156). Depth-positioned injections (Author's
> Note / post-history) and output regex rules remain *future work* — the block
> schema leaves room for both, but neither is built.
>
> Two things the build added beyond this plan, both noted in place below:
> **`PRESET_NONE`** (AP-04), because NULL-means-inherit left no way for a chat to
> opt out of a persona's preset; and **`composeSystemPrompt`** (AP-05), which
> `buildSystemPrompt` now wraps, so the inspector describes the assembly by
> running it rather than re-deriving it.
>
> Owed: a live pass with real keys. Everything was verified through the DOM and
> `/api/chat/preview`, but the browser pane never composited during the build,
> so **none of the UI has been seen**.

## Why

Everything the model sees today is assembled server-side and is invisible and
immutable from the UI:

| Block | Source | When |
|---|---|---|
| `ORIENTATION` — the Tessera preamble | `prompts/tessera.js:45` | always |
| Expression protocol | `buildExpressionSection`, generated from the persona's real expression set | when the persona has expressions |
| Scratchpad section | `SCRATCHPAD_SECTION` | when the pad is active |
| Persona prompt | `personas.system_prompt` | always (after `---`) |
| `CONTEXT_ACK` — the synthetic assistant ack | `routes/chat.js:215` | when workspace/project KB is injected |
| Active-file block, `<scratchpad>`, `<available_files>` | `utils/activeFiles.js`, `utils/scratchpadContext.js`, `utils/projectContext.js` | per-turn, appended to the last user message |

Two problems. For the user: an advanced audience can't tune the thing that most
shapes the model's behaviour. For the project: there is no way to A/B the
built-in wording, which is exactly what SP-05's "starting point to tune live"
note is waiting on.

## Decisions

**D1 — Presets, not a global override.** A *prompt preset* is a first-class,
named object owning the platform prompt layer: block text, block order, and
which blocks are on. Create, duplicate, export, import, switch. This mirrors
the character-card-vs-preset split ST/Risu users already think in — a persona
stays "who the assistant is", a preset is "how the platform talks to the
model". A persona is portable between presets and vice versa.

**D2 — Presets store overrides, not copies.** A block whose text is `null`
renders from the built-in default in `prompts/tessera.js`. Only blocks the user
actually edited carry text. This is the difference between a preset that ages
well and one that freezes today's wording forever: improvements to the built-in
prompt still reach every block a user never touched, and "Reset to default" is
just setting the text back to `null`.

**D3 — Presets control wording and order, never capability.** Whether tools are
advertised, whether the scratchpad is injected, whether KB files are loaded —
all of that stays where it is, resolved server-side from the conversation and
persona. A preset cannot turn a capability on, only change how it is described.
Keeps one source of truth for gating, and keeps the existing property that the
client can never talk the server into advertising a tool.

**D4 — Resolution mirrors the existing pattern.** Same shape as
`resolveToolsEnabled` / `resolveScratchpadEnabled`:

```
conversation.preset_id  →  persona.modelConfig.presetId  →  settings.default_preset_id  →  built-in
```

Resolved **server-side only**. The client never sends platform prompt text; it
sends a preset *id* at most, and the server loads it and checks ownership. The
persona's own `system_prompt` keeps travelling in the request body as it does
today — that is user content, already client-owned.

**D5 — The generated parts stay generated.** The expression list is derived
from the persona's actual expressions on every request (the whole reason the
base layer exists). Custom text reaches it through the `{{expressions}}` macro.
If a user's expression block omits that macro, the editor warns — non-blocking,
because deliberately dropping the protocol is a legitimate thing to want.

## Data model

```sql
CREATE TABLE IF NOT EXISTS prompt_presets (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    blocks      TEXT NOT NULL DEFAULT '{}',  -- JSON, see below
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
```

New table → `CREATE TABLE IF NOT EXISTS` on boot, no migration (WR-02b / FC-01
precedent). Two migrations are still needed for the pointers:
`settings.default_preset_id` and `conversations.preset_id`, both nullable with
`ON DELETE SET NULL` semantics enforced in the DAL (a deleted preset falls back
to the built-in rather than orphaning a chat).

`blocks` JSON — versioned so later slices can extend it without a migration:

```jsonc
{
  "version": 1,
  "order": ["orientation", "expressions", "scratchpad", "persona"],
  "blocks": {
    "orientation": { "enabled": true,  "text": null },        // null = built-in
    "expressions": { "enabled": true,  "text": "..." },       // customised
    "scratchpad":  { "enabled": true,  "text": null },
    "persona":     { "enabled": true },                       // position-only, text comes from the persona
    "context_ack": { "enabled": true,  "text": null }         // not in `order` — it is a message, not a system block
  }
}
```

`order` covers the **system layer** only. `context_ack` is listed in `blocks`
but positioned by the assembly code, because it is a synthetic message rather
than a system section. Future depth-positioned injections slot in as additional
block kinds with a `position` field; nothing here has to change to allow it.

### Macros

One resolver, applied to every block's text at assembly time (built-in text
passes through it too, so defaults can start using macros later):

| Macro | Value |
|---|---|
| `{{char}}` | active persona's name |
| `{{user}}` | user's display name |
| `{{expressions}}` | comma-separated sanitized expression names |
| `{{workspace}}` / `{{project}}` | container names, empty string when none |
| `{{model}}` | model id for the request |
| `{{date}}` / `{{time}}` | current date / time |

Unknown macros are left verbatim rather than blanked — silently deleting text a
user typed is worse than showing it. Resolution is non-recursive (a macro's
value is never re-scanned) so no macro can expand into another.

### Limits

8 KB per block, 32 KB per preset, 32 presets per user, validated server-side.
These are guard rails against accidents, not policy — a genuinely long prompt
fits comfortably.

## Slices

| # | Slice | Scope | Size |
|---|---|---|---|
| **AP-01** | **Resolution + assembly (server)** | `prompt_presets` table, two pointer migrations, DAL CRUD, `resolvePreset(userId, conversation)`, macro resolver, `buildSystemPrompt` driven by a resolved preset instead of constants, validation, tests. **No UI, no behaviour change** when no preset exists. | L |
| **AP-02** | **Advanced tab + preset CRUD** | Settings gains tabs (Appearance / Files / **Advanced** / Account) — note the settings body is re-parented out of a modal carrier into `#settingsView` (`main.js:1087`), so the tab strip lives with it. Preset list: create, rename, duplicate, delete, set as default. | M |
| **AP-03** | **Block editor** | Per-block editor with the built-in text as placeholder, per-block enable + "Reset to built-in", drag to reorder the system layer, macro reference, the `{{expressions}}` warning from D5. | M |
| **AP-04** | **Per-chat + per-persona selection** | Preset picker on the chat (mirrors the tools/scratchpad override pattern) and a persona default in the persona editor. | S |
| **AP-05** | **Assembled-prompt inspector** | Extend `POST /api/chat/preview` (already runs the real assembly) with a `blocks` array giving each span's provenance — block id, source (built-in / preset / persona / generated), char count. Render it as a labelled, collapsible view in Advanced; the raw JSON stays for dev mode. | M |
| **AP-06** | **Preset export / import** | `.tesserapreset` JSON bundle mirroring the persona `.tessera` bundle (`views/personas.js:283`). No images, so no normalisation step — small. | S |

All six shipped as merged slices; the table above is the record of what each
covered, not a to-do list. `downloadBlob` moved to `util/blob.js` in AP-06 once
the preset exporter became its second caller, the same journey `blobToBase64`
made in F-04.

Build order is strict for AP-01 → AP-02 → AP-03; AP-04/05/06 are independent
after that and can be reordered freely.

### AP-01 is the load-bearing one

It converts `buildSystemPrompt(personaPrompt, expressionNames, options)` into
something that takes a resolved preset and composes blocks in order. Everything
else is UI over that. Its acceptance test is that with **no preset anywhere**,
the assembled system prompt is byte-identical to today's for every combination
of (expressions on/off × scratchpad on/off × persona prompt empty/set) — the
existing prompt tests plus a golden-output comparison.

## Prompt-caching note

`ORIENTATION` currently sits at the front precisely because it is byte-identical
across every user, so it forms the longest shared prefix for provider caching.
A per-user edited orientation loses that sharing *for that user* — but the
prefix is still stable across their own requests, which is what actually matters
for cache hits in practice (caches are per-account anyway). No action needed;
noted so nobody rediscovers it as a bug.

## Future work (deliberately not in this plan)

- **Depth-positioned injections** — user-authored blocks with `position:
  system | before_history | after_history | depth:N`, a role, and an
  every-N-turns option. Covers ST's Author's Note and Post-History Instructions
  in one mechanism. The block schema above is shaped to accept it.
- **Output regex rules** — RisuAI/ST-style find-replace over model output, i.e.
  the built-in expression-tag stripping (`chat/expressions.js`) generalised into
  user rules. Biggest single slice of the family; wants its own design pass.
- **Context budget / history trimming** — message-count or token-budget window
  with "keep the first N", which ST users reach for on long chats.
- **Preset sharing** — presets are already export/import after AP-06; a
  browsable library is a separate product question.
