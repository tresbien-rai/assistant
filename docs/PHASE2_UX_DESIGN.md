# Phase 2 — UX Redesign Design Note (P2-U3)

Agreed design for the Phase 2 UX overhaul. Companion to `docs/PHASE2_TASKS.md`
(the P2-U3 entry) and `docs/PHASE2_HANDOFF.md`. Decided with the human in a
design discussion; this note is the source of truth for the redesign — read it
before touching the tab/sidebar/top-bar code.

## North star

Move weight **off the sidebar and into the top bar**, and turn **Projects into
workspaces you enter** (Claude.ai-style), layered on top of the existing
**persona** system (the "who" — SillyTavern/RisuAI DNA). The result is a
two-axis model that doesn't fight itself:

- **Persona = the "who"** — identity, system prompt, prefill, avatar/expressions,
  default model. Groups your chats at **home**.
- **Project = the "where/context"** — instructions + knowledge files + a grouping
  of conversations. **Scopes** your chats when you enter one.
- **Conversation = one thread** — belongs to exactly **one persona**, optionally
  lives **in one project**. Every chat row shows its persona avatar so the "who"
  is never lost.

## Core entity rules

- A conversation has one `personaId` (required) and one optional `projectId`.
- **New chat uses the currently-active persona** (shown in the top bar). The
  project governs context/files/grouping only — it does **not** pick the persona.
  (A per-project default persona is a possible *later* enhancement, explicitly
  deferred — no schema field for it now.)
- **No mid-conversation persona reassignment.** A thread belongs to its persona;
  "switch persona" means jump to / start a different chat, never rewrite the
  current one in place.
- Tabs/sidebar are **navigation only** — the chat window changes only via
  explicit actions (open a chat, start a chat, enter a project).

## Top bar (left → right)

- **Project chip** — `📁 No project ▾` / `📁 <name> ▾`. Shows the active
  workspace; lights up (info color) when inside a project. Click → switch project
  / open project settings. Replaces the old per-conversation `projectSelect`
  dropdown.
- **Persona button** — `[avatar] <name> ▾`. Click → **popover**: *Edit persona*
  (opens the existing persona settings modal), *+ New persona*, and the list of
  personas to **jump** to (jumping shows that persona's chats / starts one as
  them — never reassigns the current thread). This replaces the standalone
  Personas sidebar tab.
- *(center)* metrics — Mood / Messages / Tokens / Session (unchanged).
- **Model button** — `<model name> ▾`. Click → quick-switch among the persona's
  configured models, plus *Manage models…* (opens the existing models modal).
  Replaces the static `model-badge` span.
- Avatar toggle · Settings ⚙️ (unchanged).

## Sidebar (navigation, two states)

**Home (no project active):**
- `+ New chat`
- **Projects** section — list of projects; click one to **enter** it.
- **Chats** section — grouped by persona under collapsible headers
  (`Aria` / `Max` …), i.e. "chats with A". Each chat row shows the persona
  avatar.

**Inside a project:**
- `‹ All chats` (leave the workspace, back to Home)
- `+ New chat` (uses the active persona, auto-attached to this project)
- **Chats in this project** — flat list scoped to the project; each row tagged
  with its persona avatar (a project can hold chats from several personas).

The standalone **Personas tab is retired** (moved to the top-bar persona button).
Sidebar is now effectively **Chats + Projects**.

## Project management UI — "Modal + project home"

- **Keep the existing project modal** for editing (name, instructions, files) —
  it's intuitive and already built; reuse it.
- **Entering a project gives it a "home" in the main area:** when in a project
  and no chat is open, the chat area shows a lightweight **project header** —
  name, instructions preview, file count, and `New chat` / `Project settings`
  buttons. Opening/starting a chat replaces it with the conversation.
- This sets up Track A: tool-created files will naturally surface in the project
  home as Tool Use lands.

## What "enter / leave a project" does (behavior)

- **Enter** (click a project in the sidebar, or pick it in the project chip):
  set the active project, scope the chat list to it, light up the chip, show the
  project home in the main area (if no chat open). Persist the active project
  (likely device-local; see open items).
- **Leave** (`‹ All chats`): clear the active project, return the sidebar to the
  persona-grouped home view.
- An existing conversation always opens in *its own* project context (its
  `projectId`), regardless of which workspace you were browsing.

## State changes (frontend `state`)

- `activeProjectId` stops being vestigial (today it only highlights a tab row and
  clicking a project just opens the edit modal). It becomes the **active
  workspace**: drives chat-list scoping, the top-bar chip, new-chat attachment,
  and the project-home view.
- New chats: `projectId = state.activeProjectId || null`,
  `personaId = state.activePersonaId`.
- Sidebar chat grouping reads persona (home) vs. project scope (in-project).

## Open items to settle during build (not blockers)

- **Persistence of the active project** across reloads (device-local setting vs.
  server). Lean device-local first.
- **Mobile layout** for the busier top bar (chip + persona + model) — may need to
  collapse metrics or move some controls behind the menu.
- Empty states (no projects yet; project with zero chats).

## Task breakdown (supersedes the single P2-U3 line in PHASE2_TASKS.md)

- **P2-U3a — Top bar activation** (frontend only, no schema change)
  Model badge → quick-switch dropdown + *Manage models…*. Persona name → popover
  (*Edit persona* / *+ New persona* / jump to persona). Good first concrete task.
- **P2-U3b — Projects-as-workspace + sidebar restructure**
  Make `activeProjectId` the active workspace; enter/leave a project; scope the
  chat list; new-chat auto-attaches to the active project + active persona;
  project chip in the top bar (replacing `projectSelect`); persona-grouped chat
  list at home; retire the Personas sidebar tab; project-home panel in the main
  area; persist the active project.

## Verification

Frontend is behind Google login — use the Claude_Preview MCP (`.claude/launch.json`
name `server`, port 3457) for clean-load / computed-style / global-function
checks; the **human judges visual/interactive behavior on the live deploy**.
One branch/PR per task, `/code-review`, fix findings, merge, delete branch.
