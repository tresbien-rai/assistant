---
name: frontend-design-principles
description: Use when building or reviewing frontend UI — web apps, settings panels, editors, or creative interfaces. Drives domain-specific design decisions (typography, color world, layout, CSS token discipline, subtle depth and spacing systems) instead of generic AI defaults.
---

# Frontend Design Principles

Build frontend interfaces with craft and intention.

## Why This Process Exists

Agents default to generic output — training patterns for dashboards and settings pages are strong. Process alone isn't craft: you have to catch yourself where defaults hide.

## Where Defaults Hide

Defaults disguise themselves as infrastructure — the parts that feel like they just need to work, not be designed. Everything is design:

- **Typography isn't a container — it IS the design.** A quiet personal study and a trading terminal both want "clean, readable type," but warm-and-literary is not cold-and-precise. Reaching for your usual font means you're not designing.
- **Navigation isn't around the product — it IS the product.** Where you are, where you can go, what matters most. A page floating in space is a component demo, not software.
- **Data isn't presentation — it's meaning.** Ask what a number or status indicator means to the person looking at it.
- **Token names and values are design decisions, not implementation detail.** Every surface, border, and accent token should belong coherently to the product's world.

## Before Generating UI Changes

1. **Answer the intent questions:**
   - **Who is this human?** What are they trying to accomplish right now, and what was on their mind 5 minutes ago?
   - **What must they accomplish?** Focus on the concrete verb.
   - **What should this feel like?** Use specific sensory/domain metaphors (e.g., for Solier: a sunlit upper room for quiet reading, writing, and conversation), not generic words like "clean and modern."
2. **Ground choices in the domain:**
   - **Domain & Metaphor:** Keep vocabulary, hierarchy, and visual weight aligned with the product's world.
   - **Signature:** Let one intentional detail carry the personality without cluttering the workspace.
   - **Defaults to reject:** Explicitly name the obvious generic patterns you are avoiding before writing CSS or markup.

## Self-Critique Before Showing

Look at what you made and ask *"if someone said this lacks craft, what would they mean?"* — fix that first:

- **Swap test:** Swap your typeface or layout treatment for a generic one — would anyone notice? Where swapping wouldn't matter is where you defaulted.
- **Squint test:** Blur your eyes. Is the visual hierarchy still immediately readable? Is anything jumping out too harshly? Craft whispers.
- **Token test:** Check that all colors, font sizes, and spacing values use the project's token system coherently rather than ad-hoc hardcoded values.

## Craft Foundations

- **Subtle layering:** Surfaces should be barely different yet distinguishable — whisper-quiet elevation shifts, not dramatic jumps. Borders should be light enough to disappear until you look for structure; if they are the first thing you notice, they are too strong.
- **Color lives somewhere:** Gray/neutral builds structure; color carries meaning. One intentional accent beats five thoughtless ones.
- **Systemic intent:** If a surface or theme is warm, keep surfaces, text, borders, and accents harmonious.

## Universal Anti-Patterns

Avoid unless explicitly requested:
- **Dramatic drop shadows** (`box-shadow: 0 25px 50px …` on everyday cards/panels)
- **Arbitrary asymmetric padding** — every spacing value should feel intentional
- **Thick decorative borders** (`2px+` purely for decoration rather than active/focus state)
- **Multiple competing accent colors** — use one primary accent consistently
- **Mixing depth strategies randomly** — use subtle borders or elevation consistently according to the existing surface hierarchy
- **Inconsistent spacing** — follow the existing spacing scale
