# Scratchpad — design note

A shared, always-current document that both the user and the model edit
directly, attached to every request like an active file. Layers onto the File
Collaboration system (`docs/FILE_COLLAB_DESIGN.md`) and reuses most of its
machinery.

> **Status (2026-07-23):** Design **locked** with the human — all open questions
> confirmed (availability auto-arms, own table, diff depth 3, size cap is a high
> warning-only threshold). CF-01, CF-01b, and CF-02 are merged; the scratchpad is
> next. **Build order below (SP-01 → SP-05).** Nothing built yet.
>
> **Defining principle (added 2026-07-23, human):** the scratchpad is a
> *churning* surface — the collaborators are expected to **erase, overwrite, and
> replace** its content, NOT append to it. This is the single most important
> thing that distinguishes it from a working file (which you build up). The pad
> must not grow unmanageably; superseded ideas are replaced in place. This drives
> the tool design (Decision 6, rewritten) and is as much a prompt-engineering
> goal as a mechanical one — assume replace-in-place is the *default* behaviour we
> are steering the model toward.

---

## Motivation

When a user brainstorms with a model today, every idea they float — including
the ones immediately discarded — becomes a permanent chat message. Three costs
follow:

1. **Token load.** Superseded ideas are re-sent on every subsequent turn,
   forever.
2. **Attention drift.** The model keeps reading proposals that were rejected
   twenty turns ago and subtly weights them.
3. **No single artifact.** "What did we actually decide about the kingdom's
   social strata?" has no answer except re-reading the thread.

The scratchpad moves the *substance* out of the message log. The user writes
their idea into the pad and the message says only "this is what I think,
thoughts?". The model responds in chat with its **reasoning**, and edits the
**pad** with its contribution. Superseded ideas are overwritten in place rather
than accumulating as turns.

Crucially this is not "brainstorm in chat, then summarise into a document" —
that would duplicate content and cost *more*. The pad is where the work happens
from the start; the chat carries commentary about the work.

### Worked example

> **User** *(edits pad: adds a five-tier social strata outline)*
> "This is what I think — thoughts?"
>
> **Model** *(edits pad: merges tiers 3 and 4, adds a note on priesthood)*
> "I merged the artisan and merchant tiers — with a coastal trade economy
> they'd realistically overlap. Added an open question about whether the
> priesthood sits outside the hierarchy or above it."
>
> **User** *(edits pad: answers the priesthood question)*
> "Good call. Answered your question in the pad."

The chat is three short messages. The pad holds the current state of the world.
The diff log holds the negotiation.

---

## Settled decisions

1. **Per-conversation scope (v1).** One pad per conversation. A
   workspace-level pad that persists across chats is a plausible future
   extension — the worldbuilding use case argues for it — but it is a different
   product and is deliberately out of scope for the first version. Escape hatch:
   promote a pad to a real workspace/project file (Decision 9).

2. **Availability: always present in the UI; active by toggle; the toggle
   auto-arms on first use.** *(Confirmed 2026-07-23. See "The availability
   question" below for the reasoning.)*
   - The pad **UI is always reachable** in a chat. Discoverability matters more
     than purity here, and an empty pad costs nothing.
   - "Active" means the model is told the pad exists and is given its tools.
     This is **not** free: two tool schemas plus a nudge paragraph on every
     request, and a behavioural nudge that is noise in a quick Q&A chat.
   - Resolution mirrors the existing file-tools pattern exactly (P2-05b):
     **per-conversation override ?? persona base ?? off**.
   - **The user writing into an empty pad auto-arms the toggle.** Using the
     feature enables it; nobody has to find a setting. The explicit toggle
     survives for the cold-start case ("draft an outline in the scratchpad"),
     where the model must have the tools *before* any content exists.

3. **Scratchpad tools are gated independently of the File tools pill.**
   Enabling the pad enables its own two tools regardless of whether file tools
   are on. Without this the product has a dead state — pad enabled, model
   unable to write to it — which is confusing and silent.

4. **Disabling never destroys content.** Turning the pad off hides it and stops
   injection; re-enabling restores the content and its full revision history.

5. **Never inject an empty pad.** No content block, no "the scratchpad is
   currently empty" filler. When armed-but-empty, the model gets the tools and a
   one-line nudge only.

6. **Two dedicated tools; whole-document replace is the PRIMARY one.**
   *(Rewritten 2026-07-23 — this reverses the earlier append-first design once
   the churn principle was set.)*
   - `write_scratchpad(content)` — replaces the **entire** scratchpad with
     `content`. This is the primary tool and the one the nudge steers toward:
     erase = write less, overwrite = write different, replace = write new,
     clear = write empty. It encodes the churn principle directly — there is no
     "add to the end" verb to tempt accumulation.
   - `edit_scratchpad(old_text, new_text)` — exact-match find-and-replace with
     the same unique-match enforcement as `edit_file`. Secondary: a surgical
     tweak to one part of a larger pad without re-typing the whole thing (saves
     output tokens and removes the drop-risk of re-typing).
   - **No `append_scratchpad`.** Appending is the behaviour we are steering
     *away* from; it should not exist as a first-class verb.
   - The earlier worry ("the model replaces the user's notes when it meant to
     annotate them") is handled by the **revision history**, not by restricting
     the tools: every write snapshots + diffs (Decision 7 / the version rail),
     so nothing is truly lost and any version is restorable. Append-only
     *history* is what makes replace-primary *content* safe.

7. **Injection: full current content + the last ~3 diffs, author-labelled.**
   Attached to the latest real user message, same seam as the FC-03b active-file
   block. "Latest diff only" is right for files but too thin for a
   back-and-forth — the model should see the recent arc of the negotiation, not
   just the last edit. Three is a starting value, tunable.

8. **No in-document authorship markers.** Contributions are distinguished by
   the **revision log**, not by inline tags. Markers would pollute a document
   that is meant to be exported, and the log already carries authorship
   losslessly. The diff viewer *is* the conversation history of the pad.

9. **Export by promotion.** A pad that outgrows scratch status becomes a real
   file via the existing `move_file` path (FC-05). This is also the pressure
   valve for size (see Risks).

10. **Hard lock during the model's turn.** Both the scratchpad **and** regular
    file editing become read-only while a turn is in flight. This replaces the
    existing conflict-flag-and-confirm behaviour for files
    (`FilePanel.notifyActivity`, app.js:7080). Simultaneous editing has no
    benefit and several failure modes; a lock is simpler and more predictable.

11. **Auto-save the draft on send.** If the pad has an unsaved draft when the
    user sends a message, it is saved first, then locked. The core interaction
    is "write the idea, then ask about it" — a stale pad means the model answers
    confidently about the wrong content, silently. For files a dirty-draft
    warning is adequate; for the pad, **sending is the commit gesture**.

---

## The availability question

The tempting simplification is "the scratchpad is always available, it just
doesn't inject when empty." That conflates three separable layers:

| Layer | Cost when pad is empty |
|---|---|
| The pad's UI affordance | Free |
| The tools + nudge in the request | **Not free** — ~150–300 tokens every turn, plus a behavioural pull toward using a pad the conversation doesn't need |
| The content block | Free (Decision 5 skips it) |

So "always available" is genuinely free for layer 1 and genuinely not for layer
2. Decision 2 splits them: the UI is always there, the *model-facing* affordance
is toggled, and the toggle arms itself the moment the user actually writes
something. That preserves discoverability without taxing every quick chat, and
reuses a resolution pattern the codebase already implements.

---

## Data model

**Its own tables — confirmed 2026-07-23.** The scratchpad is deliberately NOT a
`conversation_files` row: it isn't a working file, has no Drive presence, and
(per the churn principle) is treated differently by the injection and re-roll
paths. Keeping it separate avoids teaching every file code path to skip a
non-file row, and avoids the null-`drive_file_id`-in-a-file-table hazard that
produced the silent Drive-path bug in the revert logic.

- **`scratchpads`** — one row per conversation: `id`, `conversation_id`
  (FK ON DELETE CASCADE, UNIQUE — one pad per chat), `content` (TEXT, DB-resident,
  no Drive), `created_at`, `updated_at`. New table → no migration needed
  (`CREATE TABLE IF NOT EXISTS`, per the codebase pattern).
- **`scratchpad_revisions`** — mirrors `file_revisions` minus the Drive columns:
  `id`, `scratchpad_id`, `conversation_id` (FK CASCADE), `author` (user|model),
  `op` (write|edit), `diff` (bounded unified diff via `utils/diff.js`),
  `size_bytes`, `turn` (user-message count at write, for "N turns ago" labels +
  re-roll keying), `content` (full-text snapshot, kept last N, pruned per write),
  `created_at`. A small `recordScratchpadRevision` + prune mirrors
  `storeWriter.recordRevision`; the revisions endpoint returns the same JSON
  shape as `formatFileRevision` so the frontend version rail (FC-06b) renders it
  unchanged.

Why not reuse `file_revisions` with a `scope='scratchpad'`? It would work
structurally, but the file-scoped queries (active-file injection, the Drive-routed
revert) would then have to be taught to exclude scratchpad rows — exactly the
"skip the non-file row everywhere" tax the separate table avoids. The revision
logging is ~20 lines; the isolation is worth it.

---

## Re-roll integrity

FC-06a fixed a live bug where re-rolling a turn discarded messages but left the
model's file edits applied on Drive, so the re-run operated on the wrong
content. **The scratchpad inherits this bug unless handled explicitly**, and it
cannot simply reuse the file path:

`revertConversationFiles` routes restores through Drive and **bails entirely
when Drive is unavailable** (`server/src/tools/revertFiles.js:55`). A
DB-resident pad has no Drive file at all.

The good news is that reverting the pad is *easier* than reverting a file —
content is already in the database, so it is a row write with no Drive round
trip. It needs its own branch in the revert path, not a fall-through.

Same keying as FC-06a: undo **model-authored** revisions with `turn >=
fromTurn`, preserving the user's own edits.

---

## Editing, locking, and lifecycle

- Pad is editable by the user whenever no turn is in flight.
- On send: auto-save any draft (Decision 11) → lock.
- **The lock must span the entire tool loop**, not just the final streamed
  answer — the model may edit the pad across several loop iterations.
- **The lock must release on abort and on error**, not only on clean
  completion. Missing this leaves the pad frozen with no recovery but a page
  reload. This is the most likely bug in the slice; it should have a test.
- Model edits arriving while locked need no conflict handling by construction —
  the user cannot be mid-edit.

---

## Risks

1. **Adoption is the real risk, not the plumbing.** Models are heavily trained
   to put their thinking in the chat reply. The likely v1 failure is the model
   explaining its ideas beautifully *in the message* and either forgetting the
   pad, or writing to it **and** restating everything in prose — which doubles
   tokens and defeats the entire purpose. Mitigations:
   - Put the nudge in the **persona base-prompt layer** so it can be tuned
     without a deploy.
   - Use the existing **`/api/chat/preview` inspector** to see exactly what the
     model receives each turn. This is the iteration instrument; it should be
     used from day one.
   - Expect several rounds of prompt tuning after the code is done. Budget for
     it rather than treating a weak first result as a design failure.

2. **Always-injected means always-paid — but the churn principle is the primary
   defence.** A pad that grows to 20 KB costs a few thousand tokens *every turn*.
   The main guard is behavioural (Decision 6 / the defining principle): because
   the model replaces rather than appends, a well-behaved pad stays small on its
   own. The size **cap is a high, arbitrary threshold** (confirmed 2026-07-23) —
   set well above normal use so it never fires in practice — and is a **warning
   only**, never a hard block on writing. If it fires regularly, that's a signal
   the churn nudge is failing (tune it, SP-05) or the pad has outgrown scratch
   status and wants promotion to a real file (Decision 9). Revisit the cap value
   after living with it.

3. **Novelty.** The closest shipped cousins (Canvas, Artifacts) are document
   *generation* surfaces: the model writes, the user reads. Mutual editing with
   a shared changelog is a different interaction and is genuinely untested.
   This argues for keeping v1 deliberately small, so the first real
   conversation on it teaches something before much is built on assumptions.

---

## Proposed build order

Sequenced after the two agreed File-Collab follow-ons:

- **CF-01 — chat files navigation.** `API.conversations.files.list()` + a Files
  affordance in a chat opening the existing FilePanel. Backend already exists
  (`GET /api/conversations/:id/files`, conversations.js:468); the client method
  and the surface were simply never written.
- **CF-02 — user uploads become working files.** Text/code/markdown attachments
  route to `conversation_files` instead of device-local IndexedDB (app.js:8490);
  images stay as message content blocks; PDFs become read-only working files.
  Also fixes a cross-device sync gap.

Then:

- **SP-01 — data model + tools.** Table/row, revision wiring, the two tools,
  executor + provider advertisement, tests. No UI.
- **SP-02 — injection + toggle.** Request assembly (content + last 3 diffs),
  toggle resolution incl. auto-arming, independent tool gating, empty-skip.
- **SP-03 — UI.** Pad surface in the chat, editing, version rail reuse,
  auto-save-on-send, the lock (including the file-side change from Decision 10).
- **SP-04 — re-roll branch.** DB-only revert path + tests.
- **SP-05 — nudge tuning.** Prompt iteration against `/api/chat/preview` and
  real conversations. Explicitly a slice, not an afterthought.

---

## Open questions — all resolved 2026-07-23

1. ~~Availability model~~ → **auto-arming toggle** (Decision 2).
2. ~~Own table vs. a `conversation_files` row~~ → **own tables**
   (`scratchpads` + `scratchpad_revisions`; see Data model).
3. ~~Diff depth~~ → **3** (Decision 7). Revisit after SP-05.
4. ~~Size cap~~ → **high arbitrary threshold, warning only, never a hard block**
   (Risk 2). The churn principle is the real size defence. Revisit the value
   after living with it.

Remaining to settle *during* the build, not blocking:
- The exact nudge wording (SP-05 tunes it against `/api/chat/preview`).
- The concrete cap number (pick something obviously-high for SP-01, e.g. a few
  hundred KB, purely as a runaway guard).
