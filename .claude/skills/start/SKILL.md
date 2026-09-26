---
name: start
description: Start a Tessera work session — sync with origin, read docs/PROJECT.md, and brief the user on where things stand and what's next. Use when the user types /start or asks where the project stands at the beginning of a session.
---

# Start a session

Brief the user on where the project stands, so the session begins from facts
rather than memory. Keep the briefing short and in plain language — the user
is a novice developer who sets direction; they need the picture, not the
plumbing.

## Steps

1. **Sync.** The SessionStart hook already fetched; confirm with
   `git status -sb` and `git branch -a`.
   - If on `main` and behind origin: `git pull`.
   - If there's uncommitted work or a leftover feature branch, don't touch it —
     report it and ask what it is.
   - If any branch other than `main` exists locally or on origin, report it
     (the rule is that only `main` survives a merged PR).

2. **Read `docs/PROJECT.md`** — §7 (current focus), §8 (owed, deferred, open),
   and the "Last updated" line. Skim §6 for anything marked 🟡 or 📐.

3. **Check that the doc isn't stale.** Compare `git log --oneline -15` with the
   feature index. If PRs have merged since "Last updated" that PROJECT.md
   doesn't reflect, say so — the previous session skipped its wrap-up, and
   fixing the doc comes before new work.

4. **Brief the user**, in this shape:
   - **State:** one line — branch, in sync or not, anything unexpected.
   - **Last session:** what the most recent merged PRs did, one line each (max 3).
   - **Next up:** the §7 items, one line each.
   - **Owed:** a count of open live checks, and whether any need the user
     (real keys / real Drive) — name them only if the user may want to do one now.
   - **Question:** ask what this session is for, offering the top §7 item as
     the default.

Don't start work until the user picks a direction. Once they do, follow the
workflow in `CLAUDE.md` (design doc if it's bigger than one PR, then branch
first).
