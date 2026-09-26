---
name: wrap
description: Wrap up a Tessera work session — make sure work is merged and cleaned up, then bring docs/PROJECT.md, the touched design docs, and memory up to date and report to the user. Use when the user types /wrap, or says the session is done ("let's wrap up", "that's it for today", "close out").
---

# Wrap up a session

Leave the project so the next session — possibly a different model, possibly
in the cloud — can pick up from `docs/PROJECT.md` alone. Skipping this step is
how the docs drifted before, so do every step even when the session was small.

## 1. Check the work is landed

- `git status -sb`, `git branch -a`, and `gh pr list --state open`.
- Anything uncommitted or on an unmerged branch: tell the user and ask —
  finish and merge it (normal workflow: verify, PR, review, merge), or leave
  it and record it in `PROJECT.md` §8 as in-flight with the branch name.
  Never discard work without asking.
- Merged branches still around: delete local + remote, `git fetch --prune`.

## 2. Gather what this session did

List the PRs merged this session (`git log` since the session started, or
`gh pr list --state merged --limit 10`). For each, note: which feature, which
slice IDs, anything verified live, anything left owed, any trap discovered.

## 3. Update `docs/PROJECT.md` (on a `docs/wrap-YYYY-MM-DD` branch)

Go section by section; only change what this session actually changed.

- **§6 Feature index** — new rows for new features; update status (✅ 🟡 📐 ⏸)
  and the slice/PR column for touched ones.
- **§7 Current focus** — remove what's done, add what was agreed as next.
  If the user stated a direction for next time, record it in their words.
- **§8 Owed / deferred / open** — add live checks this work needs; tick and
  remove the ones done (say which PR/date verified them); add deliberate
  deferrals with the reason, and drops with whose call it was.
- **§9 Gotchas** — add any trap that cost real time this session, written so
  a future session can recognise it before hitting it.
- **§10 Registry** — any new slice prefix.
- **§3–§5** — only if architecture, a principle, or prompt assembly changed.
- **"Last updated"** — today's date and a few words on what changed.

Also update the **status line** at the top of every design doc whose feature
moved (format in `CLAUDE.md`).

Commit as `docs: wrap-up YYYY-MM-DD`, PR, and merge it — no review agent
needed for a wrap-up, but reread the diff once for accuracy. If the session
changed nothing worth recording, say so and skip the PR.

## 4. Memory

Memory holds facts about the user and how they like to work — not project
status. Save a memory only if the user revealed a preference, gave feedback on
how to work, or corrected an approach. Anything about the project goes in
`PROJECT.md` instead. If a memory contradicts what was learned, fix it.

## 5. Report to the user

Short, plain language:
- **Shipped:** each PR in a line, with its link.
- **Owed:** anything the user needs to do (e.g. a live check with real keys).
- **Next:** the suggested next step, as now written in §7.
