# User Profile & Persona Notes — Design

Status: **design agreed, nothing built** (brainstormed 2026-09-08)
Arising from: `project_next_targets` item 3 — "a user profile the user can customise"

---

## 1. The problem

Tessera has five context layers, and every one of them describes something
other than the person using it:

| Layer | Answers | Where |
|---|---|---|
| Base orientation | what this app is | `server/src/prompts/tessera.js` (`ORIENTATION`) |
| Persona prompt | who the *model* is | `personas.system_prompt` |
| Workspace / project instructions | what the *work* is | `workspaces.instructions`, `projects.instructions` |
| Scratchpad | what we are doing *right now* | per-conversation, churns every turn |
| `<session_state>` | what *exists* right now | generated, message layer, not editable |

Nothing says **who the user is**. The closest thing is the `{{user}}` macro
(`prompts/presets.js:275`), which resolves to the Google account display name —
often not even the name the user wants to be called.

The consequence is that a persona configured as a friend or a close colleague
has nothing to be friendly *with*. It cannot address the user by name, knows
nothing about them, and starts every conversation — and every new conversation
forever — as a stranger.

## 2. The organising rule

One sentence decides what belongs in this feature and what does not:

> **persona = who the model is · profile = who the user is ·
> workspace/project = what the work is · scratchpad = what we are doing now**

If a thing cannot be described as "who the user is", it belongs in one of the
other four layers. This rule exists to stop the profile becoming a sixth junk
drawer.

## 3. Two tiers

The feature is two distinct stores, not one store with a bigger schema.

**Tier 1 — the Profile.** One per user. Authored by the user. Freeform named
sections. Shared by every persona (subject to a per-persona switch, D6).

**Tier 2 — Persona notes.** One store *per persona*. Accumulated by that persona
from its own conversations. Never shared with other personas — each persona is a
separate acquaintance, not a shared dossier.

```
user_profile   (user_id, preferred_name, sections JSON, updated_at)
persona_notes  (id, persona_id, text, source, conversation_id, created_at)
```

`source` is `'user' | 'persona'` from the first migration even though tier 1
ships user-authored only. Retrofitting provenance is expensive — the file layer
learned that the hard way (`docs/FILE_PROVENANCE_DESIGN.md`) — and a nullable
column costs nothing now.

## 4. Locked decisions

### D1 — Freeform sections, with exactly one real field

Everything is a named freeform section with a suggestive placeholder (pronouns,
what you do, what you are into, how you would describe yourself). Rigid field
grids — the shape most platforms use — are rejected: they make the user answer
the app's questions instead of saying what matters.

The **one** exception is `preferred_name`. It is a real field because:

- it is the highest-value single item in the feature (a friendly persona needs it
  on turn one),
- it should not have to be inferred out of prose, and
- it fixes a live wart: `{{user}}` currently resolves to the Google display name.
  After this, `{{user}}` resolves to `preferred_name`, falling back to the
  account name when unset.

### D2 — The profile is a SYSTEM block

`profile` joins `SYSTEM_BLOCK_IDS` and renders after `orientation`, before
`persona`. It is per-user constant, so unlike `<session_state>` it does not churn
and does not need exiling to the message layer (PC-01).

As a preset block it inherits reordering, per-block disable, macro expansion and
prompt-inspector accounting (AP-05) with no new machinery.

Cache note: the shared cross-user prefix ends at `orientation`. Irrelevant here —
Tessera is a single-user-per-account app and the profile is stable within a
user, so their own prefix caches fine.

### D3 — Answer preferences are a SEPARATE block, stored alongside

"Working preferences" splits in two:

- **App preferences** (theme, avatar, aux model, default preset) — already in
  Settings, never reach the model, stay exactly where they are.
- **Answer preferences** ("keep it brief", "British spelling", "don't apologise")
  — these are prompt content and must be injected.

The second kind gets its own `preferences` system block next to `profile`. Same
storage table, distinct block, because "who I am" and "how to answer me" are
different instructions and a persona may want one without the other. It is
surfaced in Settings, not on the Profile page, per the user's framing.

### D4 — Persona notes are written BETWEEN conversations, by the aux model

Not during. Two independent reasons that agree:

- **Caching.** A note store the model rewrites mid-chat re-breaks the stable
  prefix exactly as `<session_state>` did before PC-01. Frozen for the duration
  of a conversation, notes sit in the system layer for free.
- **It is the truer metaphor.** Reflection happens after a conversation, not
  while talking. A persona that updates its impression at the end of a session
  behaves more like an acquaintance than one editing a dossier mid-sentence.

The mechanism already exists: this is the **aux model's second consumer**. Auto
chat naming (AX-02) already fires a cheap model at the end of an exchange and
writes back a small string, with usage recording and a no-aux fallback rule in
place. "Distil anything worth remembering" is the same trigger, slot, and
write-back path — which makes tier 2 far cheaper than it looks and closes out
`project_next_targets` item 1 at the same time.

### D5 — Notes are auto-written, and fully visible and editable

Read, edit and delete from the persona's own page, any time. No approval prompt:
propose-and-confirm was considered and rejected because it adds a review chore to
the end of every session. Trust, but make it inspectable and correctable.

### D6 — A persona sees the whole profile, or none of it

One switch per persona. Per-section visibility ("my fiction companion does not
need my job title") is a real use case but needs a matrix UI, which is too much
surface for a v1. Section-level granularity is deferred until wanted, and the
per-section enable toggles (D1) mean the storage already supports it.

### D7 — A persona distils only from its OWN conversations

Ada knows what happened in chats with Ada. Cross-persona distillation was
considered and rejected: it is more useful faster but breaks the "separate
acquaintances" model that makes the feature coherent.

## 5. Resulting prompt shape

```
orientation        shared, cache anchor
profile            NEW — who the user is
preferences        NEW — how they want to be answered
expressions
persona
[scratchpad]
persona_notes      NEW (tier 2) — stable within a conversation
---
<session_state>, KB context, active files, scratchpad content   (message layer, volatile)
```

Everything new is a preset block. Nothing new is invented to support it.

## 6. Slices

| id | slice | notes |
|---|---|---|
| UP-01 | `user_profile` schema + DAL + routes + api-client | includes `preferred_name` |
| UP-02 | Profile view (new rail surface) — sections, add/remove, placeholders | top-level, not buried in Settings |
| UP-03 | `profile` system block; `{{user}}` rewired to `preferred_name`; per-persona switch (D6) | the slice that makes it reach the model |
| UP-04 | `preferences` block + its Settings surface (D3) | |
| UP-05 | `persona_notes` schema + persona-page surface: read, edit, delete (D5) | ships empty — no writer yet |
| UP-06 | Aux-model distillation at end of conversation → writes notes (D4, D7) | mirrors AX-02's trigger |

UP-01…UP-03 are the feature standing on its own. UP-04 is small and independent.
UP-05/UP-06 are tier 2 and can wait.

## 7. Deferred

- **Per-section persona visibility** (D6) — storage supports it; UI does not.
- **Cross-persona distillation** (D7) — deliberately rejected, revisit only if
  the separate-acquaintances model proves annoying in practice.
- **Model-writable tier 1** — the profile itself stays user-authored. Tier 2 is
  where the model writes. `source` exists in both tables if this changes.
- **Note decay / consolidation** — an accumulating store eventually needs
  trimming. Not a v1 problem, but the scratchpad's "replace, don't append"
  principle is the likely answer.

## 8. Open thread — the rename

Separate from this feature, but the reason it surfaced now: the user wants a name
evoking a personal *study*. Three places "Tessera" is **data**, not branding:

- the Drive root folder name (`server/src/config.js:45`) — safest of the three,
  since Drive **folder ids** are what we store, so renaming the display folder
  orphans nothing;
- the `.tessera` persona bundle format, with a magic-string validator
  (`server/src/utils/personaBundle.js:143`) — needs a compat reader for bundles
  already exported;
- `window.__tessera`, the smoke-harness seam (`js/main.js`).

Recommended prerequisite: a single `BRAND` constant, so the product name and the
storage identifiers can be renamed independently.

Candidates raised: **Solar** (the private upper room of a medieval house),
**Carrel** (a library study nook), Scriptorium, Alcove, Marginalia, Escritoire,
Athenaeum. Undecided.
