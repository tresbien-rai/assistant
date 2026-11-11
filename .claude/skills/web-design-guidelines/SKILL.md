---
name: web-design-guidelines
description: Review UI code for Web Interface Guidelines compliance. Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices".
metadata:
  author: vercel
  version: "1.0.0"
  argument-hint: <file-or-pattern>
---

# Web Interface Guidelines

Review files for compliance with Vercel's Web Interface Guidelines. This skill bundles the full guideline checklist locally so it works reliably offline and in sandboxed cloud sessions.

## How It Works

1. Read the specified files (or prompt the user for files/pattern if none are clear from context).
2. Check against all applicable rules in the bundled guidelines below (skip React/Next.js-specific items when auditing vanilla HTML/CSS/JS).
3. Output findings in a terse `file:line` format grouped by file, stating the issue and location concisely.

---

## Bundled Guidelines Checklist

### Interactions
- **Keyboard works everywhere:** All flows are keyboard-operable and follow WAI-ARIA Authoring Patterns.
- **Clear focus:** Every focusable element shows a visible, unobscured focus ring. Prefer `:focus-visible` over `:focus` to avoid distracting pointer users. Set `:focus-within` for grouped controls. Sticky headers, footers, banners, and overlays never cover the focused element.
- **Manage focus:** Use focus traps, move and return focus according to WAI-ARIA Patterns (especially in modals and drawers).
- **Match visual & hit targets:** If the visual target is `< 24px`, expand its hit target to `>= 24px`. On mobile, the minimum tap target size is `44px`.
- **Mobile input size:** `<input>` and `<textarea>` font size is `>= 16px` on mobile to prevent iOS Safari auto-zoom/pan on focus.
- **Respect zoom:** Never disable browser zoom.
- **Don't block paste:** Never disable paste in `<input>` or `<textarea>`.
- **Loading buttons:** Show a loading indicator and keep the original label (or clear progress state).
- **Ellipsis for further input & loading states:** Menu options that open a follow-up (e.g., `"Rename…"`) and loading/processing states (e.g., `"Loading…"`, `"Saving…"`) end with a typographic ellipsis (`…`).
- **Confirm destructive actions:** Require confirmation or provide Undo with a safe window.
- **Prevent double-tap zoom on controls:** Set `touch-action: manipulation` on interactive controls where appropriate.
- **Overscroll behavior:** Set `overscroll-behavior: contain` intentionally in modals, drawers, and scrollable panels.
- **Autofocus for speed:** On desktop screens or modals with a single primary input, autofocus it. Avoid unexpected autofocus on mobile where the keyboard opening causes layout shift.
- **No dead zones:** If part of a control looks interactive, it should be interactive. Labels and checkboxes/radios should share a single generous hit target.
- **Clean drag interactions:** Disable text selection while dragging an element so selection and hover don't trigger simultaneously.
- **Gestures have alternatives:** Every drag, swipe, or path-based action also works with a tap/click control and keyboard.
- **Links vs. buttons:** Use `<a>` for navigation and `<button>` for actions. Never substitute `<div>` or `<span>` with click handlers without proper button semantics.
- **Announce async updates:** Use polite `aria-live` for toasts and inline status/validation messages.

### Animations & Motion
- **Honor `prefers-reduced-motion`:** Always provide a reduced-motion variant when adding animations or transitions.
- **Prefer CSS:** Favor CSS transitions/animations on compositor-friendly properties (`transform`, `opacity`) and avoid animating layout properties (`width`, `height`, `top`, `left`) that trigger reflows.
- **Never `transition: all`:** Explicitly list only the properties you intend to animate (typically `opacity`, `transform`, `color`, `background-color`, `border-color`). `transition: all` causes layout jank and breaks `visibility` transitions inside modals.
- **Necessity check:** Only animate when it clarifies cause and effect (opening, expanding, confirming) or adds deliberate delight.

### Layout
- **Optical alignment:** Adjust `±1px` when human perception beats strict geometry (e.g., play icons, text beside icons).
- **Deliberate alignment:** Every element aligns intentionally to a grid, baseline, edge, or optical center.
- **Balance contrast in lockups:** When text and icons sit side by side, balance stroke weight, size, spacing, and color so they don't clash.
- **Responsive coverage:** Verify on phone width, laptop, and wide desktop screens.
- **Respect safe areas:** Account for mobile notches and insets with `env(safe-area-inset-*)` where applicable.
- **No excessive or horizontal scrollbars:** Only render useful scrollbars; wrap content vertically by default and confine any unavoidable overflow to the specific element.
- **Let the browser size things:** Prefer flex, grid, and intrinsic CSS sizing over measuring layout in JS.

### Content & Accessibility
- **Inline help first:** Prefer concise inline explanations over hiding essential context in tooltips.
- **All states designed:** Account for empty, sparse, dense, loading, and error states. An empty state should be a clear invitation to act.
- **Typographic characters:** Prefer real ellipsis (`…`) over three periods (`...`), and proper typographic quotes/dashes in UI copy.
- **Tabular numbers for comparisons:** Use `font-variant-numeric: tabular-nums` (or monospace) when numbers are stacked or compared (such as token counts or usage tables).
- **Redundant status cues:** Never rely on color alone to convey status; pair with text labels or distinct icons.
- **Icon-only buttons are named:** Every icon-only button must have a descriptive `aria-label` (and decorative SVGs inside buttons should use `aria-hidden="true"`).
- **Semantics before ARIA:** Prefer native HTML elements (`<button>`, `<label>`, `<dialog>`, `<table>`) before reaching for custom `aria-*` roles.
- **Resilient to user-generated content:** Ensure layouts handle very short, average, and very long user names, titles, or file names without breaking layout (`min-width: 0` in flex/grid children, proper wrapping or truncation).

### Forms
- **Labels everywhere:** Every form control has an associated `<label>` or `aria-label`.
- **Textarea submission & newlines:** Respect expected Enter / modifier+Enter behavior and auto-resize cleanly without eating caret position.
- **Don't block typing:** Allow users to type/edit freely and surface clear validation feedback rather than silently dropping keystrokes.
- **Error placement & clarity:** Show errors in the right surface (inline, toast, or banner depending on scope) and state both what went wrong and how to fix it.
- **Placeholders:** Use placeholders to show a helpful example or signal emptiness, never as the only label for a field.
- **Windows `<select>` contrast:** Explicitly set `background-color` and `color` on native `<select>` and `<option>` elements so dark mode remains legible on Windows.

### Design & Copywriting
- **Crisp borders & layered depth:** Use semi-transparent or token-matched borders and subtle elevation.
- **Nested radii:** Child border-radius should be `<=` parent border-radius so corners look concentric (`r_inner = max(0, r_outer - padding)`).
- **Color-scheme support:** Ensure dark/light themes set appropriate contrast for native scrollbars and form controls.
- **Active voice & specific CTAs:** Write from the end user's perspective in active voice. Buttons should state the action clearly (`"Save API key"`, `"Create persona"`), and follow-up toasts should use matching terminology.
- **Keep nouns consistent:** Use one term for each concept across the entire app (don't call the same thing a "box" in one place, a "field" in another, and a "section" in a third).
- **Separate numbers & units:** Put a space between numbers and units (`10 MB`, `12 px` in prose).
