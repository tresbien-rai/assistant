# Orphaned Avatar/Expression Images — Design Note

*Decided with the human 2026-07-22. Follow-up to the recent persona work
(persona cards #94, export/import `.tessera` bundles). Tasks numbered
OI-01..03.*

## Premise

Avatar and expression images are stored on the server filesystem at
`server/data/avatars/`, named by persona:

- `{personaId}_avatar.{ext}`
- `{personaId}_expr_{name}.{ext}`

The database stores only *references* to these files —
`personas.avatar_filename` and, per expression, an `imageKey` inside the
`personas.expressions` JSON. Nothing keeps the files and the references in sync
when data is removed, so files leak. As the persona system makes personas
cheaper to create and discard, the leak accumulates faster.

### Where orphans come from

1. **Persona deletion (primary).** `DELETE /api/personas/:id` →
   `dal.deletePersona()` runs a DB transaction that cascades conversations +
   messages and deletes the persona row, but touches **no files**. Every
   deleted persona strands its avatar *and* every expression image.
2. **Expression removal via edit.** `PUT /api/personas/:id` overwrites the
   `expressions` JSON wholesale. Dropping an expression that had an image
   orphans that file. (The dedicated `DELETE …/expressions/:name/image`
   endpoint already cleans up; a bulk edit that reshapes the map does not.)

### Already handled (for reference — not part of this work)

- Import-failure rollback: `written.forEach(safeDelete)` in the import route.
- Extension change on re-upload: the old file is deleted before the rename.
- Stale *DB→file* references: the serving routes self-heal, clearing the DB
  reference when the file it points at is missing.

The gap this note closes is the reverse: **files with no live DB reference.**

## Design

Two complementary layers — **eager cleanup** stops new orphans at the source;
a **periodic sweep** clears the existing backlog and acts as a safety net for
any path we miss. Filesystem deletes cannot live inside the SQLite transaction,
so eager cleanup runs in the route *after* the DB mutation reports success — a
file stranded by a crash in that window is exactly what the sweep reclaims.

### 1. Eager cleanup at the source (OI-01)

A shared helper in `avatars.js`, exported alongside the existing
`safeDelete`/`findFileByPattern`:

```js
// Delete every file belonging to a persona: {id}_avatar.* and {id}_expr_*.*
function deletePersonaImages(personaId) { … }   // prefix match on readdir
```

- **Persona delete** — the route calls `deletePersonaImages(personaId)` after
  `dal.deletePersona()` returns success.
- **Persona edit** — before writing a new `expressions` map, the route diffs it
  against the persona's current expressions and `safeDelete`s the `imageKey`
  file of any expression that was removed or whose image was cleared. (Avatar
  clearing via edit already goes through the dedicated avatar routes, but if a
  `PUT` ever blanks `avatarFilename`, prune that file too.)

Prefix matching (not exact filename) matters because the stored `imageKey`
carries the extension, and a persona can hold images of several extensions.

### 2. Periodic sweep / reconciliation (OI-02)

`sweepOrphanedAvatars()` — a maintenance function (new module, e.g.
`server/src/tools/avatarSweep.js`):

1. `readdir(AVATARS_DIR)`.
2. Build the **referenced set** from the DB across *all* users: every
   `avatar_filename` plus every expression `imageKey`. Needs a new
   unscoped DAL, e.g. `getAllPersonaImageRefs()` returning
   `{ avatar_filename, expressions }` rows — the only maintenance query that
   deliberately ignores `user_id` scoping.
3. Delete any file that is **not** in the referenced set — with two guards:
   - **Skip `tmp_*`** — multer's in-flight upload temp files.
   - **Age grace** — skip files modified within the last few minutes, so a
     just-uploaded image whose DB write is still in flight is never reaped.
4. Log a summary (`scanned`, `referenced`, `deleted`).

**Trigger: periodic timer** (the chosen option). In `index.js`, after
`app.listen`, run one sweep shortly after boot (a short delay so startup isn't
blocked) and then on a `setInterval` (default ~6h; the interval is
`.unref()`'d so it never keeps the process alive). Gated by env so it can be
disabled — `AVATAR_SWEEP_ENABLED` (default on) and `AVATAR_SWEEP_INTERVAL_MS` —
and skipped under `NODE_ENV=test`.

### 3. Tests (OI-03)

- Unit: `deletePersonaImages` removes avatar + all expression files, leaves
  other personas' files; edit-diff prunes only removed expressions.
- Unit: `sweepOrphanedAvatars` deletes an unreferenced file, keeps a referenced
  one, keeps a `tmp_*` file, keeps a fresh-mtime file.
- Route: deleting a persona removes its files; a sweep after an orphan is
  created reclaims it.

## Task breakdown

| Task | Scope | Size |
|------|-------|------|
| **OI-01** | `deletePersonaImages` helper; wire into the persona delete route and the expression-diff prune in the edit route. | Small |
| **OI-02** | `getAllPersonaImageRefs()` DAL; `sweepOrphanedAvatars()` with `tmp_*` + age guards; periodic timer + env gating in `index.js`. | Small-medium |
| **OI-03** | Unit + route tests for both layers. | Small |

Order: OI-01 and OI-02 are independent and can land in either order (OI-01
stops the bleeding, OI-02 clears the backlog). OI-03 follows whichever ships.

## Non-goals (for now)

- Moving avatar storage off the local filesystem (e.g. into the DB or object
  storage). Out of scope; the persistent Volume on Railway is fine.
- Account/user deletion cleanup — there is no delete-account path today. If one
  is added, it should call `deletePersonaImages` per persona (or lean on the
  sweep).
- An admin/maintenance HTTP endpoint to trigger the sweep on demand.
  Reconsidered but dropped in favor of the timer; easy to add later if useful.
- Reclaiming orphaned Google Drive project files — a separate concern tracked
  under the file-collab design, not this note.
