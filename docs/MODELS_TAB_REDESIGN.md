# Models Tab Redesign — Design Note

*Decided with the human 2026-07-22. Builds on the model-profiles work
(docs/MODEL_PROFILES_DESIGN.md) and the WR-13 re-parenting that first moved the
active-model / advanced-params sections into `#modelsView`.*

**Status: complete.** Slices 1–6 landed 2026-07-22 (PRs #99–#105). Slices 7–8,
added after living with the result, landed 2026-07-23: the add-model modal's
provider picker (§6, PR #106) and the quick-switch dropdown (§5, PR #108).

## Premise

The Models tab grew organically and now carries a relic. It stacks four things:
a provider-grouped **catalog**, an **"Active Model"** section (provider +
model dropdowns, a "Manage Models" button, the API-key field), an **"Advanced
Settings"** param block bound to whichever model is active, and a separate
**"Manage Models" modal**.

Three of those overlap. The catalog already switches the active model and shows
per-provider key status; the "Active Model" dropdowns are a worse version of
clicking a card; its "Manage Models" button opens the same modal as the header's
"+ Add model". The only non-redundant piece in that section is the API key —
and it's mis-scoped, living in a *per-model* section when a key is a
*per-provider* thing.

This note reshapes the tab into a **catalog-first surface** that mirrors the
Personas tab (a card grid you browse, with each card opening a detail view),
makes **providers** first-class (they own the key), and moves per-model params
into a **per-model detail view** so we only ever show params the model's
provider actually supports.

## Locked decisions

1. **Layout B — provider chips over one catalog.** A row of provider chips sits
   above the catalog; the catalog below shows the models for whichever
   providers are toggled on. Chosen over per-provider stacked sections
   ("Layout A") because the provider count is expected to reach 10+ (OpenAI,
   OpenRouter, xAI, DeepSeek, local runners, …); a single filtered catalog stays
   a fixed height as providers grow, where stacked sections become an endless
   scroll.

2. **Chips are multi-select toggles, and the selection is saved.** Toggling a
   provider chip adds/removes that provider's models from the catalog below
   (rendered in the Layout-A-style grouped form — a small header per selected
   provider, its cards beneath). Users combine the providers they use often into
   a persisted **"daily drivers"** list, so the catalog opens showing exactly
   the models they quick-switch between.

3. **An "All" chip** shows every provider that has models, ignoring the saved
   subset. It's the overview / fallback and the default for a fresh account.

4. **Card click switches; `⋯` edits.** Clicking a model card makes it the active
   model (fast, one act). Editing its parameters is the per-card `⋯` menu →
   "Edit settings", which opens the per-model detail view. Switch and edit are
   deliberately separate, consistent with the rest of the UI.

5. **Per-model detail view, provider-scoped.** The detail view edits *that
   model's* profile (`customModels[provider][i].params`). Because the provider
   is known, params the provider doesn't support are simply not rendered — no
   more toggling provider blocks in/out of a shared panel. Params are grouped
   into **Sampling** and **Behaviour**.

6. **The "Active Model" section is deleted.** Its provider/model dropdowns and
   "Manage Models" button go; "active" survives as the catalog's Active badge.
   The API key relocates to the provider (see §4). "+ Add model" in the header
   is the single entry to the add-model modal.

## 1. Catalog surface (`#modelsView`)

```
Models                                                    [+ Add model]
──────────────────────────────────────────────────────────────────────
[ All ]  [◆ Anthropic ●]  [◆ Google ●]  [◆ OpenRouter ○]  [ xAI · soon ]

  ── Anthropic ──────────────  ● key saved        [Manage key]
  ┌ Claude Sonnet 4 · Active ┐  ┌ Claude Opus 4  ┐  ┌ Claude Haiku 4 ┐
  └──────────────────────────┘  └────────────────┘  └────────────────┘

  ── Google ─────────────────  ● key saved        [Manage key]
  ┌ Gemini 2.5 Pro ┐  ┌ Gemini 2.5 Flash ┐
  └────────────────┘  └──────────────────┘
```

- **Header**: view title + "+ Add model" (opens the existing add-model modal,
  unchanged — fetch-from-API or manual id + display name).
- **Chip row**: one chip per provider in the registry, plus a leading "All"
  chip. Each provider chip carries a status dot: has-key vs. no-key, and a
  distinct disabled/"soon" state for providers not yet wired up (e.g. OpenAI
  today). Provider icon on the chip — see §5.
- **Catalog body**: for each *selected* provider (or every provider when "All"
  is active), a lightweight group header (provider name · key status ·
  "Manage key") followed by that provider's model cards. This reuses the
  Layout-A grouping, just filtered by the chip selection — so `renderModelsCatalog`
  stays largely as-is, gated by the active provider set.
- **Cards** keep today's shape: display name, model id in mono (the id stays
  visible as a power-user nicety), Active badge on the active model, `⋯` menu.

### Chip selection semantics

- Selection is a **set of provider ids**. "All" is a distinct mode, not a member
  of the set.
- Toggling any individual chip turns "All" off and adds/removes that provider.
- Toggling "All" on clears the individual selection view (shows everything);
  the saved subset is remembered and restored when the user next picks an
  individual chip. *(Implementation choice: keep the subset array as the stored
  value and treat "All" as `null`/empty → render all. Simplest single source of
  truth.)*
- If the user deselects down to an **empty** subset, fall back to "All" rather
  than render an empty catalog — the tab is never blank.
- A provider with **no models added** still shows its chip (so you can add the
  first one / manage its key); its group body shows the existing "No X models
  added" empty state when selected.

### Persistence — the "daily drivers" list

New per-user setting, synced across devices (server-backed, matching the app's
model — not localStorage):

- **DB**: add `catalog_providers TEXT DEFAULT NULL` to the `settings` table
  (`server/src/db/schema.sql`) — JSON array of provider ids, or `NULL`/absent =
  "All". Nullable default means no destructive migration; existing rows read as
  "All".
- **DAL / route**: thread it through `server/src/db/dal.js` settings read/write
  and `server/src/routes/settings.js`, following the CLAUDE.md "Adding a New
  Setting" checklist.
- **API client**: `API.settings` already round-trips the settings object; add the
  field to the shape.
- **Frontend**: `state.settings.catalogProviders`; chip toggles write through
  `API.settings.update` (debounced is fine — it's a preference, low stakes).

## 2. Per-model detail view (option B)

Reached from a card's `⋯` → "Edit settings". Mirrors the Personas edit view
(back button → grid, title, an explicit action, then grouped fields).

```
[← Models]  Claude Sonnet 4   · Active            [ Use this model ]
claude-sonnet-4-20250514

SAMPLING
  Temperature      ────●────  1.00
  Top P            ──────●──  0.95
  Max tokens       [ 4096 ]
  (Top K, Stop sequences — only when the provider supports them)

BEHAVIOUR
  Extended thinking (Claude-only)   [on]
  Streaming                          [on]
  Response prefill   [ textarea ]
```

- **"Use this model"** in the header is the explicit switch action for when you
  arrive via the menu on a non-active model (card-click still switches directly
  from the grid). Shows "Active" state when it's already the active model.
- **Sampling group**: temperature, Top P, max tokens, and — *only when the
  provider offers them* — Top K and stop sequences.
- **Behaviour group**: streaming, response prefill (a model param since the
  profiles work), and provider-specific behaviour (Anthropic extended thinking +
  budget; Gemini thinking level, media resolution, safety settings) folded in
  here rather than in a separate provider footer.
- **Provider alignment by omission**: the view renders from a per-provider param
  descriptor (which params exist, their ranges, their group). Unsupported params
  are absent, not disabled. This is *provider*-level shaping, not the rejected
  per-*model* capability matrix (see MODEL_PROFILES_DESIGN.md non-goals) — we key
  off the provider the model belongs to, which we always know.
- **The per-param "enable" checkboxes** (temperature/Top P/Top K on-off) survive
  as an advanced/override affordance for the odd model that rejects a param its
  provider generally supports — but they're no longer the default surface; a
  supported param shows enabled by default.
- **Auto-save** to the model's profile on edit (last-used semantics, no Save
  button) — unchanged from the profiles design.

## 3. Provider as a first-class entity

Introduce a small **provider registry** (extend the existing `PROVIDER_LABELS`
in app.js into `PROVIDERS = { id: { label, tagline, icon, status, params } }`):

- `label` / `tagline` — "Anthropic" / "Claude".
- `icon` — see §5.
- `status` — `live` vs. `soon` (drives the disabled chip state; replaces the
  hard-coded `disabled` option in the old provider `<select>`).
- `params` — the param descriptor the detail view reads for provider alignment.

The **API key is provider-owned**: the group header (and the chip's status dot)
show key state; "Manage key" opens the key editor (the existing password input +
toggle-visibility + "Clear saved key", relocated out of the dead Active-Model
section into a small inline editor or popover per provider). Backend key storage
(`api_keys` table, per-provider) is already correct — no server change.

## 4. Provider icons on chips (answer to "what would it take?")

Modest, one-time work — no architectural change:

1. **Source** a monochrome brand mark per provider. The standard source is
   Simple Icons (has Anthropic, OpenAI, Google Gemini, xAI, etc.) — permissively
   licensed SVGs. We vendor only the handful we use, not the whole set.
2. **Bundle inline, not remote.** Store each as a small inline SVG (a
   `PROVIDERS[id].icon` string, or an SVG sprite). Inlining respects the app's
   no-external-requests posture and works offline; no CDN, no network on render.
3. **Theme via `currentColor`.** Monochrome marks (Anthropic, OpenAI) inherit
   text color and adapt to light/dark for free. Google's mark is multicolor and
   fixed-brand — acceptable, but verify contrast on both themes; if it's noisy at
   16px, use a monochrome fallback.
4. **Graceful fallback.** Providers without a bundled icon (arbitrary/future
   ones) fall back to a generic glyph (e.g. Tabler `ti-cpu`) or a lettered
   avatar, so the chip row never breaks as providers are added.
5. **Reuse everywhere.** Once `PROVIDERS[id].icon` exists it's reused in the
   catalog group headers and the top-bar quick-switch dropdown (§6), not just the
   chips.

Trademark note: these are used descriptively to identify the integration (no
implied endorsement), which is standard for an integrations UI. Low risk for a
personal app; keep marks unmodified and don't imply partnership.

Estimated effort: small (~an hour), mostly vendoring the SVGs and wiring the
lookup + fallback.

## 5. Top-bar quick-switch dropdown (design locked 2026-07-23)

*Deferred out of the six-slice build; designed in its own pass afterwards.
Slices 7 and 8 below implement §5 and §6.*

The model button in the top bar / composer (`#modelButton`,
`#composerModelButton`) opens a quick-switch popover, `showModelMenu()`. Slice 1
already gave it provider grouping, empty-provider hiding, and a "no key" badge,
so this pass is narrower than the original note implied.

```
┌───────────────────────────────────┐
│ ◆ ANTHROPIC                       │
│    Claude Opus 4.8              ✓ │
│    Claude Sonnet 4.5              │
│ ✦ GOOGLE               [no key]   │
│    Gemini 3 Pro                   │
│ ─────────────────────────────     │
│ Show all providers (1 more)       │  ← only when the subset hides something
│ Manage models…                    │
└───────────────────────────────────┘
```

**B1 — Provider icons on the group labels.** `providerIconHtml(provider)` into
`.context-menu-label`, which becomes a flex row so icon, label, and the "no key"
badge share a line.

**B2 — Honour the daily-drivers subset, with two guardrails.** The reservation
that shaped this: `catalogProviders` was built as a *catalog view* filter. If
narrowing the catalog to one provider silently made the top-bar switcher
unable to reach the others, a view preference would have become a global
restriction. So:

- **The active model's provider is always shown**, even when the subset excludes
  it. Never hide what you're currently using.
- **"Show all providers (N more)"** appears in the footer only when the subset
  actually hides a provider that has models, and expands **for that popover
  session only**. It does not write `catalogProviders` — the saved list stays a
  deliberate setting, changed only from the chips.

**B3 — Height cap.** `.context-menu` has `overflow: hidden` and no `max-height`
(styles.css ~L1348); at 10+ providers the menu would run off-screen. The groups
go in a `max-height: 50vh; overflow-y: auto` scroll region, with the separator
and footer items pinned below it.

**B4 — Rows stay name-only.** No model-id sub-line. The catalog is where ids are
inspected; the dropdown is where switching is fast, and compactness is the point.

**B5 — "no key" providers stay listed and clickable.** The badge explains the
state, and pre-selecting a model before adding its key is legitimate.

**B6 — Out of scope:** a filter/search input (revisit past ~12–15 total models)
and keyboard navigation (no context menu in the app has it — an app-wide gap,
not this feature's).

## 6. Add-model modal — provider becomes explicit (added 2026-07-23)

*A relic missed by the six slices, found in use: the `+ Add model` button sits at
the top right of the whole tab, and the modal it opens silently operates on the
**active model's provider**. There is no visible way to add a model for a
different provider.*

The hidden coupling is real and total — every operation in the modal reads
`getActiveModelConfig().provider`: `fetchAvailableModels()` (app.js ~L3044),
`addCustomModel()` (~L3071), `renderSavedModelsList()` (~L3160),
`renderAvailableModelsGrid()` (~L3210), and the Fetch button's disabled state in
`openModelModal()` (~L3264).

```
┌─ Add model ───────────────────────────────── × ─┐
│  Select provider                                │
│  [◆ Anthropic ●] [✦ Google ●] [⬡ OpenAI soon]   │
│  ───────────────────────────────────────────    │
│  [ Fetch available models ]                     │
│  Fetches the model list from Anthropic's API.   │
│  Requires a saved key; not every provider       │
│  offers a list endpoint.                        │
│                                                 │
│  ┌ (grid appears here after fetch) ┐            │
│  ───────────── or add manually ─────────────    │
│  Model ID     [ claude-opus-4-8            ]    │
│  Display Name [ Claude Opus 4.8            ]    │
│                              [ Add model ]      │
└─────────────────────────────────────────────────┘
```

**A1 — "Your Models" is deleted.** A relic from before the catalog existed.
Removal already lives in the catalog card's `⋯` menu, and the catalog is a
strictly better list (grouped, shows the active model, shows key status). Drops
`renderSavedModelsList()`, `#savedModelsList`, `#noModelsMessage`, and the
delete-button wiring.

**A2 — The modal is titled "Add model"** (was "Manage Models"). It only adds
now, and `+ Add model` is its only entry point.

**A3 — Provider selection is a chip row**, reusing the catalog chips and
`providerIconHtml()`. Single-select, so: no "All" chip, `.provider-chips.single`
+ `role="radiogroup"` for a11y. `status: 'soon'` providers render disabled, as
in the catalog.

**A4 — Modal-local `modelModalProvider`, defaulting to the active model's
provider.** The same default as today, but visible and changeable. Switching
provider clears the fetched grid (it is provider-specific) and re-evaluates the
Fetch button and its help text.

**A5 — Thread `provider` through as an argument** to `fetchAvailableModels`,
`addCustomModel`, and `renderAvailableModelsGrid` rather than reading the active
layer. This is the actual untangle, and it matches the shape
`removeCustomModel(id, provider)` already has. That function's "default to the
active provider" fallback goes dead once the modal stops relying on it — drop it.

**A6 — Provider-aware help text**, replacing "Requires API key. Fetches models
from Anthropic API." The caveat is literal, not hedging: `chat.js` (~L707)
throws `Model listing not supported` for any provider module without
`listModels`.

> Fetches the model list from **{Provider}**'s API. Requires a saved API key —
> and not every provider offers a list endpoint.

**A7 — A toast confirms a manual add** ("Claude Opus 4.8 added to Anthropic"),
since the removal of "Your Models" leaves that path with no visible result. The
fetch grid already flips its button to "Added".

**A8 — When the selected provider has no key**, say so instead of just going
dead, and offer `showProviderKeyPopover(anchorEl, provider)` from an "Add key"
button in the modal. *Build risk*: that popover renders at `z-index: 1000` and
may lose to the modal overlay's stacking context — if it does, fall back to a
static "no API key — add one in the Models tab" line.

**A9 — Per-group "+ Add" on catalog group headers**, opening the modal
pre-selected to that provider. This answers "how do I add a Google model?" at
the point the question actually occurs. The header's `+ Add model` stays for the
empty/general case.

## Non-goals

- Per-*model* capability matrix / auto-detecting which params a specific model
  id rejects — still rejected (users add arbitrary ids). We shape by *provider*,
  not by model.
- Named/multiple profiles per model — still one profile per catalog model.
- Reworking the add-model modal itself — it stays as-is this pass.

## Build plan

Slices are ordered so each is independently shippable and reviewable, on its own
feature branch (per the branch-per-task workflow), merged before the next starts.
The guiding order: **build the replacement before retiring the relic** — the old
"Active Model" and "Advanced Settings" sections stay live until the surface that
supersedes each is in place.

### Slice 1 — `PROVIDERS` registry (the keystone)

Pure refactor, no visible change. De-risks everything after it.

- Grow `PROVIDER_LABELS` (app.js ~L3862) into `PROVIDERS` (label, tagline,
  `status`, `keyPlaceholder`, `params` descriptor list; `icon` stubbed for now).
- Extract the param descriptors (`P`, `SAMPLING`, `BEHAVIOUR`, provider extras)
  per the Appendix.
- Repoint existing consumers (`renderModelsCatalog`, the provider `<select>`
  population, anywhere iterating `PROVIDER_LABELS`) to read from `PROVIDERS`.
- Replace the hard-coded `disabled` OpenAI `<option>` with `status: 'soon'`.
- **Verify**: catalog + existing model switching behave exactly as before.

### Slice 2 — daily-drivers persistence (plumbing, no UI)

- schema.sql: add `catalog_providers TEXT DEFAULT NULL` to `settings`.
- dal.js: thread the field through settings read/write.
- routes/settings.js: accept/return it (CLAUDE.md "Adding a New Setting").
- api-client.js: include it in the settings shape.
- app.js: load into `state.settings.catalogProviders`; add a debounced
  `saveCatalogProviders()` helper (no UI caller yet).
- **Verify**: value round-trips through `API.settings` and survives reload.

### Slice 3 — chips + filtered catalog (Layout B)

- Render the chip row above `#modelsCatalog`: an "All" chip + one per provider,
  each with a status dot (has-key / no-key) and the `soon` disabled state.
- Multi-select toggle logic → writes `catalogProviders` (Slice 2), "All" = empty
  set, empty-selection falls back to "All".
- Gate `renderModelsCatalog` by the selected provider set; keep the grouped
  (Layout-A-style) body per selected provider, incl. the "No X models" empty
  state.
- **Verify**: toggling filters the catalog, persists, and restores on reload.

### Slice 4 — provider-owned key, delete "Active Model" section

- Move the key editor (password input + toggle-visibility + "Clear saved key")
  into the provider group header / a per-provider popover; use `keyPlaceholder`.
  (Settle the form-factor open question here.)
- Delete `#modelSettingsSection` (provider/model dropdowns + "Manage Models"
  button). "+ Add model" is now the only modal entry.
- **Verify**: set / clear key per provider works; add-model modal unaffected.

### Slice 5 — per-model detail view (option B), retire "Advanced Settings"

- `⋯` menu on a card → "Edit settings" → detail view (back button, title, model
  id, "Use this model" action). Card click keeps switching directly.
- Descriptor-driven renderer: bucket `PROVIDERS[p].params` by `group`/`subgroup`,
  render each `control` type (range / number / tags / toggle / select /
  textarea), read/write at `path`, honour `showWhen` + `enableKey`; Safety in a
  collapsible subgroup.
- Migrate the live logic out of the static `#advancedSettingsSection` into the
  renderer, then retire that section. Auto-save to the model's profile
  (unchanged semantics).
- Confirm `google.mediaResolution` is actually consumed by `gemini.js` before
  keeping its descriptor (else drop it).
- **Verify**: each control writes the correct `path`; Anthropic vs. Google show
  their correct param sets; switching models loads the right profile.

### Slice 6 — provider icons

- Vendor inline Simple-Icons SVG strings into `PROVIDERS[*].icon`; generic
  `ti-cpu` fallback in render code when absent.
- Reuse in chips + catalog group headers; `currentColor` for monochrome marks.
- **Verify**: icons render on both light/dark themes; fallback works for a
  provider with no `icon`.

### Slice 7 — add-model modal: explicit provider (see §6)

Independent of Slice 8; do it first, it's self-contained.

- index.html: delete the "Your Models" section; retitle the modal "Add model";
  add the `Select provider` chip row above the fetch section.
- app.js: add `modelModalProvider` state; thread `provider` through
  `fetchAvailableModels` / `addCustomModel` / `renderAvailableModelsGrid`;
  delete `renderSavedModelsList` and its element refs; provider-aware help text;
  add toast on manual add; per-group "+ Add" buttons in `renderModelsCatalog`.
- styles.css: `.provider-chips.single` variant.
- **Verify**: add a model to a provider that is *not* the active one, from both
  the header button and a group's "+ Add"; the active model must not change.
  Check the key-popover-inside-modal stacking (A8) and fall back if it loses.

### Slice 8 — quick-switch dropdown rework (see §5)

- app.js `showModelMenu`: icons in group labels; daily-drivers filter with the
  active provider always included; transient "Show all providers (N more)".
- styles.css: `.context-menu-label` as a flex row; `.model-menu` scroll region
  with a pinned footer.
- **Verify**: narrow the chips to one provider, then confirm the dropdown still
  reaches the active model's provider and that "Show all" does not persist;
  confirm a long list scrolls rather than overflowing the viewport.

## Open questions

- **Key editor form factor**: inline-in-group-header vs. a small per-provider
  popover vs. a reused modal. Lean inline/popover; decide during build.
- **"Manage key" while a provider has no models yet** — confirm the chip +
  empty group is a comfortable enough place to set the first key, or whether the
  add-model modal should also offer the key inline.
- **`google.mediaResolution`**: RESOLVED (Slice 5) — dropped. Confirmed never
  read by `gemini.js`; it's Gemini-3-only and set per-attachment (a `resolution`
  on each media part), not globally in `generationConfig`. It belongs on the
  attachment flow, not a per-model profile, so it's out of the descriptor.

## Model-variant params — the general pattern (added 2026-07-22, Slice 5)

Provider APIs split by model generation. Gemini's thinking control is the first
case: `thinkingLevel` (Gemini 3+) vs `thinkingBudget` (Gemini 2.5) are mutually
exclusive and can't be auto-detected from an arbitrary model id (our standing
non-goal). The general mechanism, which needs **no new descriptor machinery**:

- A **user-set mode selector** param (stored in the profile like any other), plus
- the divergent params **gated on it via the existing `showWhen`**.

For Gemini: `google.thinkingApi` (`off`/`level`/`budget`) gates `thinkingLevel`
and `thinkingBudget`. `gemini.js` sends whichever the mode selects (never both —
the API rejects that), and is legacy-safe (infers `level` from a set
`thinkingLevel` on pre-switch profiles). Any future provider that splits its API
uses the same pattern: add a mode selector + `showWhen`-gated params.

## Appendix — Providers registry sketch (2026-07-22)

Grounded in the actual param bag the providers read
(`server/src/providers/{anthropic,gemini}.js`). Note: `top_k` IS accepted by
Anthropic — Top K is a shared sampling param, not an Anthropic omission. The
real per-provider divergence is in the Behaviour group.

The registry grows today's `PROVIDER_LABELS` into a single source of truth
carrying label, tagline, inline Simple-Icons SVG string, live/soon status, key
placeholder, and a **param descriptor list** the detail view renders from.

```js
// Param descriptor: one drives one control in the detail view.
//   path  → location in the model's params bag. Bare key = flat
//           ('temperature'); dotted = provider namespace the backend
//           already reads ('anthropic.thinkingBudget', 'google.thinkingLevel').
//   group → 'sampling' | 'behaviour'; subgroup → optional (e.g. 'safety').
//   enableKey → optional advanced on/off companion (temp/topP/topK).
//   showWhen  → conditional visibility (thinking budget).
//   Array order = render order.

const P = {
  temperature:  { path: 'temperature', label: 'Temperature', group: 'sampling',
    control: 'range', min: 0, max: 2, step: 0.01, default: 1.0,
    enableKey: 'temperatureEnabled' },
  topP:         { path: 'topP', label: 'Top P', group: 'sampling',
    control: 'range', min: 0, max: 1, step: 0.01, default: 0.95,
    enableKey: 'topPEnabled' },
  topK:         { path: 'topK', label: 'Top K', group: 'sampling',
    control: 'number', min: 1, max: 100, default: 40, enableKey: 'topKEnabled' },
  maxTokens:    { path: 'maxTokens', label: 'Max tokens', group: 'sampling',
    control: 'number', min: 1, max: 32000, default: 4096 },
  stopSequences:{ path: 'stopSequences', label: 'Stop sequences', group: 'sampling',
    control: 'tags', default: [] },
  streaming:    { path: 'streaming', label: 'Streaming', group: 'behaviour',
    control: 'toggle', default: false },
  prefill:      { path: 'prefill', label: 'Response prefill', group: 'behaviour',
    control: 'textarea', default: '' },
};

const SAMPLING  = [P.temperature, P.topP, P.topK, P.maxTokens, P.stopSequences];
const BEHAVIOUR = [P.streaming, P.prefill];

const ANTHROPIC_EXTRAS = [
  { path: 'anthropic.thinkingEnabled', label: 'Extended thinking', group: 'behaviour',
    control: 'toggle', default: false },
  { path: 'anthropic.thinkingBudget', label: 'Thinking budget', group: 'behaviour',
    control: 'number', min: 1024, max: 32000, default: 4000, unit: 'tokens',
    showWhen: { path: 'anthropic.thinkingEnabled', eq: true } },
];

const SAFETY = ['Harassment', 'Hate', 'Sexual', 'Dangerous'].map(cat => ({
  path: `google.safety${cat}`, label: cat, group: 'behaviour', subgroup: 'safety',
  control: 'select', default: 'BLOCK_MEDIUM_AND_ABOVE',
  options: [
    { value: 'BLOCK_LOW_AND_ABOVE',    label: 'Block most' },
    { value: 'BLOCK_MEDIUM_AND_ABOVE', label: 'Block some' },
    { value: 'BLOCK_ONLY_HIGH',        label: 'Block few'  },
    { value: 'BLOCK_NONE',             label: 'Block none' },
    { value: 'OFF',                    label: 'Off'        },
  ],
}));

const GEMINI_EXTRAS = [
  { path: 'google.thinkingLevel', label: 'Thinking level', group: 'behaviour',
    control: 'select', default: 'medium',
    options: ['off', 'minimal', 'low', 'medium', 'high'] },
  { path: 'google.mediaResolution', label: 'Media resolution', group: 'behaviour',
    control: 'select', default: 'medium', options: ['low', 'medium', 'high'] },
  ...SAFETY,   // collapsible "Safety" subgroup
];

const PROVIDERS = {
  anthropic: { id: 'anthropic', label: 'Anthropic', tagline: 'Claude', status: 'live',
    icon: SI_ANTHROPIC, keyPlaceholder: 'sk-ant-…',
    params: [...SAMPLING, ...BEHAVIOUR, ...ANTHROPIC_EXTRAS] },
  google:    { id: 'google', label: 'Google', tagline: 'Gemini', status: 'live',
    icon: SI_GEMINI, keyPlaceholder: 'AIza…',
    params: [...SAMPLING, ...BEHAVIOUR, ...GEMINI_EXTRAS] },
  openai:    { id: 'openai', label: 'OpenAI', tagline: 'GPT', status: 'soon',
    icon: SI_OPENAI, keyPlaceholder: 'sk-…', params: [] },
};
```

Consumption:

- **Chips**: `label`, `icon`, `status` (`soon` → disabled chip), key state from
  `state.apiKeyStatus[id]` for the status dot.
- **Detail view**: iterate `PROVIDERS[p].params`, bucket by `group`/`subgroup`,
  render by `control`, read/write at `path`, honour `showWhen` + `enableKey`.
  Provider alignment = a provider simply listing fewer descriptors.
- **Key editor**: `keyPlaceholder` for the input hint.

`icon` values are inline Simple-Icons SVG strings pasted at build (the
`SI_*` names are placeholders here — no fabricated path data); render code
falls back to a generic glyph (`ti-cpu`) when `icon` is absent, so
arbitrary/future providers degrade gracefully.
