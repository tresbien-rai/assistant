# File Provenance — design

**Status:** specified, not built.
**Relates to:** `docs/SESSION_STATE_DESIGN.md` §7 (file digests), `docs/FILE_COLLAB_DESIGN.md`.

One word per file, telling the model where that file came from: *it wrote it*,
*the user provided it*, or *nobody knows*.

---

## 1. The problem

A file reaches the model as a bare name in the `<available_files>` manifest, or
as content under a `### File: x` header. Neither says where it came from, and
nothing else in the prompt does either.

Three very different files are therefore indistinguishable on turn 6:

- one the user uploaded before the conversation began,
- one the model itself created on turn 2,
- one that appeared by a path nobody remembers.

This is not fixed by the chat log. **Tool calls do not survive the turn they
happened in.** Within a turn the loop carries real tool-call and tool-result
parts; when the turn ends, only the assistant's *text* is persisted and replayed.
The `messages.attachments` column records which tool ran where — it is what draws
the inline tool cards — but it is never sent to the provider. So the model knows
it created a file only if it happened to say so in prose, and only while that
prose is still in effective context.

`<session_state>` does not help by design: it reports **counts, not names**, for
good reasons documented in its own header. The manifest reports **names, not
origins**. Nothing reports origin.

### Why it matters

Three concrete failures, in rising order of cost:

1. **Long conversations.** The creating turn scrolls out of effective attention
   while the file stays listed. The model treats its own work as foreign.
2. **After a re-roll.** FC-06a rolls the *file* back, but the narration that
   described creating it is gone. Text and state disagree, and the model has no
   way to notice.
3. **The ghost file.** `ode_to_tomatoes.txt` (see `HANDOFF_2026-07-31.md` §4)
   could not be attributed, because *the chat log cannot answer that question*.
   Only `file_revisions` can. This has already cost one unresolved
   investigation.

Behaviourally, the question that changes what the model *does* is not "when did
this appear" but **"is this mine?"** A file it authored is one it can confidently
rewrite; a user's file deserves asking first. That is the question this spec
answers, and it is why the design is one word rather than a timeline.

---

## 2. The data already exists

No new capture is required. `file_revisions` (schema.sql:221) already records,
per write:

| column | values |
|---|---|
| `author` | `'model'` \| `'user'` |
| `op` | `'create'` \| `'overwrite'` \| `'edit'` |
| `turn` | conversation turn at write time |
| `created_at` | timestamp |
| `scope`, `file_id` | indexed together (`idx_file_revisions_file`) |

There is exactly **one** non-test writer — `storeWriter.writeContentToStore`
(storeWriter.js:54) — which is what makes this trustworthy rather than
best-effort.

### Two real gaps, which this spec must not paper over

**Gap A — project and workspace uploads write no revision at all.**
`routes/projects.js:403` and `routes/workspaces.js:367` call `drive.uploadFile`
then `dal.addProjectFile` / `addWorkspaceFile` directly, bypassing
`writeContentToStore`. Every project and workspace file therefore has an empty
revision log, including brand-new uploads.

**Gap B — `move_file` destroys provenance.** A move "is not a content edit, so it
logs no revision" and *clears the source file's revision log*
(moveFile.js:17-18, 114). So a model-authored file promoted to project scope —
exactly the FC-05 flow — arrives with its authorship erased.

Both are fixed in slice 1. Without them, the feature would report `unknown` for
the majority of files and quietly mislabel promoted model work.

---

## 3. The model

Three states, never two:

| state | meaning | derived from |
|---|---|---|
| `model` | the assistant created this file | earliest revision has `author='model'` |
| `user` | the user uploaded or created it | earliest revision has `author='user'` |
| `unknown` | no revision log survives | no rows for `(scope, file_id)` |

**`unknown` is a first-class state, not a bug.** It is the honest answer for
files that predate this feature, and collapsing it into `user` would recreate
the exact ambiguity the feature exists to remove — the ghost file would have been
silently labelled `user` and the question closed wrongly.

**Origin, not last-touch.** Provenance is read from the *earliest* revision. A
user file the model later edited is still the user's file; that a model edit
happened is already visible in the revision history and the file panel. One
concept per word.

This maps directly onto the `authored` / `auto` / `none` triple that
`SESSION_STATE_DESIGN.md` §7 calls the load-bearing piece of file digests —
deliberately, so the digest work inherits a provenance column that already
exists and is already populated rather than adding a parallel one.

---

## 4. Surfaces

Provenance appears in three places, all reading one helper. Wording is
deliberately plain — no tag syntax for the model to imitate in its prose.

**The manifest** (`buildAvailableFilesSection`, projectContext.js:210), today
names only:

```
... call read_file with its exact name: alpha.txt (you created this),
notes.md (uploaded by the user), legacy.md.
```

An `unknown` file gets **no suffix at all**. Silence is the correct rendering of
"no information" and costs zero tokens on the common legacy case.

**Loaded file headers**, today `### File: alpha.txt`:

```
### File: alpha.txt (you created this)
```

**`list_files` tool output** — the same suffix, so a model that discovers a file
by calling the tool learns the same thing as one that read the manifest. Any
disagreement between these two would be worse than no provenance.

### Explicitly excluded

- **Timestamps and turn numbers.** "Created 4 turns ago" invites reasoning about
  recency the model cannot verify, and turn numbers become fiction the moment a
  re-roll rewrites history. The `turn` column stays for re-roll and the file
  panel, which is what it was built for.
- **`<session_state>`.** It reports counts by construction. Adding names there
  would duplicate the manifest and contradict it the moment they disagree —
  the failure its own header warns against.
- **Replaying tool calls into history.** Grows the prompt without bound and
  duplicates state the DB already holds authoritatively.

---

## 5. Slices

**P-01 — close the capture gaps.** Write a revision row on project and workspace
upload (`author: 'user'`, `op: 'create'`); carry provenance across `move_file`
instead of clearing it. No user-visible change; makes the rest truthful. Tests:
an uploaded project file has a `user` create row; a promoted model file still
reads `model` after the move.

**P-02 — the helper.** `getFileProvenance(scope, fileId)` in the DAL returning
`'model' | 'user' | 'unknown'`, plus a batch form for a list of files (one query,
not N — the manifest can name up to `MANIFEST_MAX_NAMES`). Pure function over
existing rows; unit-testable with no Drive and no provider.

**P-03 — surface it.** Wire the suffix into the manifest, the loaded-file header
and `list_files`. One shared formatter so the three cannot drift.

**P-04 — live pass.** Confirm the model actually uses it: that it rewrites its
own file without asking, and asks before overwriting a user's. This is the slice
that says whether the feature earns its tokens. *Given the last two sessions, no
provider-facing path is "done" until a real request has exercised it.*

Slices 1–3 are mechanical and need no keys. P-01 is worth doing regardless of
whether the rest ships: right now the revision log is silently incomplete, which
undermines the file panel's history view and the ghost-file query too.

---

## 6. Cost

Roughly six tokens per named file, only for files whose origin is known. The
manifest is already capped. No schema change, no migration, no new capture
beyond the two gap fixes — which are themselves bug fixes.

## 7. Open question

Whether `unknown` should be *stated* rather than silent for a file the model is
about to overwrite — "origin unrecorded" is a genuinely useful warning at the
moment of a destructive write, even though it is noise in a list. Deferred to
P-04, when there is behaviour to observe rather than guess at.
