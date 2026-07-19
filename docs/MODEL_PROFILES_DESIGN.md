# Model Profiles — Design Note

*Decided with the human 2026-07-18. Follow-up to the Model/Persona De-sync
(docs/MODEL_DESYNC_DESIGN.md, WR-10..14).*

## Premise

Personas are the **outer layer** ("skin": name, system prompt, avatar,
expressions). Models are the **inner core** ("engine": provider, model id, and
every generation parameter). The two mix and match freely.

The motivating problem: parameters used to travel with the single active
layer across model switches, so settings tuned for one model (e.g. Gemini's
Top K) would ride along to another that rejects them (e.g. Claude with
extended thinking) and the provider would 400. Once every model remembers its
own working configuration, switching is seamless.

## Design

### 1. Every catalog model owns a profile

`settings.customModels[provider][i]` grows from `{ id, name }` to
`{ id, name, params }` — `params` is the full modelParams bag (temperature,
Top P/K, max tokens, stop sequences, streaming, provider-specific settings,
**and prefill** — see §3). Stored as opaque JSON in the settings row: no
schema migration, no backend change.

- **Switching models** (top-bar menu, Models catalog, dropdown) saves the
  outgoing model's params to its profile and loads the incoming model's.
- **Editing the Advanced sliders** auto-saves to the active model's profile
  (last-used semantics — no Save button).
- A model that has never been selected has no profile yet: the current
  params carry over unchanged (pre-profiles behavior) and it starts
  remembering from there — nothing resets unexpectedly on upgrade.

### 2. Fixed personas are pins, not snapshots

A persona's `modelConfig` is now either `{}` (shared — pure skin) or a slim
pin `{ mode: 'fixed', provider, model }`. Activating a fixed persona selects
the pinned model, which loads *the model's* profile. Params never live on the
persona, so there is exactly one source of truth per model.

Switching models while a fixed persona is active re-pins it (same last-used
spirit as WR-12). Flipping a persona to Fixed pins the currently selected
model.

**Legacy migration** (lazy, one-time per persona): pre-profiles fixed
personas carried a full snapshot. On first activation, the snapshot's params
seed the pinned model's profile (if the model has none yet), the persona's
old prefill folds in, and the persona slims down to a pure pin.

### 3. Prefill is a model parameter

Moved from the persona ("skin") to model params ("engine"): it now lives in
the Advanced Settings section, saved per model profile, and the chat request
reads it from the active layer. The `personas.prefill` DB column stays (data
preserved, no migration) but the UI no longer edits it.

**Migration seed:** on the first load after upgrade (detected by the saved
layer lacking a `prefill` key), the active persona's prefill is copied into
the layer + the active model's profile. Other personas' prefills stay dormant
in their DB rows — re-enter them on the relevant model if still wanted.

### 4. Chats restore their persona AND their model *(added 2026-07-19)*

A conversation should never change character or engine behind the user's
back:

- **Persona**: a chat is bound to its persona (`conversations.persona_id`)
  and opening it activates that persona. This already worked in-session; the
  reload path now does the same (init used to fall back to the
  most-recently-edited persona, ignoring the restored chat).
- **Model**: opening a chat reactivates the model that produced its last
  assistant reply — derived from the per-message model tag (WR-14), so no new
  storage. The model's profile loads with it, as with any switch. Skipped
  when the chat's persona is fixed (the pin wins), when the chat has no
  tagged replies, or when that model was removed from the catalog.

This supersedes the de-sync note's rejection of per-conversation model
memory: opening a chat *is* user involvement, and the visible per-message
tags + profiles make the restore predictable instead of disorienting.

## Non-goals (for now)

- **Per-model capability matrix** (auto-disabling params a model rejects):
  users add arbitrary model ids, so a matrix would constantly chase releases.
  Profiles get the seamlessness without the maintenance; revisit if needed.
- Named/multiple profiles per model — one profile per catalog model.
- Stripping prefill server-side for configs that reject it (e.g. Anthropic
  extended thinking) — noted as a possible later guardrail.
