# Model / Persona De-sync — Design Note

*Decided with the human 2026-07-01. Follow-up to the Workspace Restructure
(WR-01..09); tasks numbered WR-10..14.*

## Premise

The persona is the **outer layer** (character: system prompt, prefill, avatar,
expressions). The model + its parameters are an **under layer** selected
independently, depending on the goal of the session. Tessera's core promise:
switch provider/model freely while retaining the persona and the layered
context (workspace / project instructions).

Two motivating use cases:

1. **Translator persona** — curated parameters (low temperature etc.).
   Benefits from settings bound to the persona.
2. **General assistant persona** — model-agnostic. Switching to it should NOT
   yank away the model you deliberately picked for this session.

Neither "settings belong to the persona" (status quo) nor "settings are fully
global" fits both — so it's a per-persona choice.

## Design

### 1. Active model layer

One user-level `currentModelConfig` (provider + model + all advanced params).
Every chat send uses this layer. The top-bar model menu and the Advanced
sliders edit **the layer**, not (directly) the persona.

### 2. Per-persona mode: `shared` | `fixed`

One advanced toggle in the persona editor — **"Model settings: Shared / Fixed"**:

- **`shared` (default)** — the persona never touches the layer. Activating it
  keeps whatever model/params are currently selected. Pure character.
- **`fixed`** — activating the persona loads its saved `modelConfig` into the
  layer; changes made while it is active are remembered back to the persona
  (last-used auto-save, scoped to personas that opt in). This is exactly the
  pre-de-sync behavior, made opt-in.

Storage: a `mode` field inside the existing `personas.model_config` JSON — no
schema migration for the flag. The layer needs one settings column
(`current_model_config`), added via the numbered-migration runner.

**Migration seed:** existing personas default to `shared`; the layer is seeded
from the active persona's config at upgrade, so nothing visibly changes at the
moment of deploy. The user flips curated personas (Translator-types) to
`fixed`.

### 3. Per-MESSAGE model tag (instead of per-conversation memory)

Rejected: per-conversation model memory (reopening an old chat silently
restores its model) — disorienting; settings should never change without user
involvement.

Adopted instead (RisuAI-style): **each assistant message records which
provider/model generated it**, displayed as a small tag on the message. Coming
back to an old conversation, the user can see what produced each reply and
manually pick that model back up — or deliberately try another.

Storage: `messages.model` (nullable; needs a migration). Set at generation
time by the chat routes. Old messages simply show no tag.

## Task breakdown

*Progress: ALL DONE — WR-10 (#56), WR-11 (#58), WR-12 (#59), WR-13 (#60),
WR-14 (#61) merged 2026-07-02.*

| Task | Scope | Size |
|------|-------|------|
| **WR-10** | Top-bar slimming: remove Mood, Messages, Session (keep Tokens). Remove the top-bar gear (Settings lives on the rail). Avatar button becomes an options popover: show/hide, size presets, corner presets, link to full settings. | Small |
| **WR-11** | Unified model menu: ONE popover listing all added models across providers, grouped by provider, "no key" badge where the provider has no stored API key. Picking one sets provider+model together (still writing to the active persona's config — de-sync lands in WR-12). | Small-medium |
| **WR-12** | The de-sync: `currentModelConfig` layer + per-persona `mode` (shared/fixed) toggle in the persona editor. WR-11's menu and the Advanced sliders redirect their writes to the layer. | Medium |
| **WR-13** | "Models & Providers" rail tab (mirrors Personas): model catalog + add/fetch models + per-provider API keys move there. Settings shrinks to Appearance, Avatar Display, Account. | Medium |
| **WR-14** | Per-message model tag: `messages.model` migration, chat routes record it, frontend renders the tag on assistant messages. | Small-medium |

Order: WR-10 and WR-11 are independent quick wins. WR-11 before WR-12 keeps
each PR small (menu ships with today's write semantics; WR-12 only redirects
the writes). WR-14 is independent of all of them.

## Non-goals (for now)

- Per-conversation model memory (see above — rejected).
- ~~Model "profiles"/presets as a separate concept — the fixed-mode persona
  already covers the curated-parameters case without a third entity.~~
  **Superseded 2026-07-18:** per-model profiles adopted; fixed personas
  became slim pins to a model. See docs/MODEL_PROFILES_DESIGN.md.
- Floating avatar as live preview on the persona editor (noted for later,
  separate idea).
