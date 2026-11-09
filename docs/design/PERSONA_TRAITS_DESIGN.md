# Persona Traits — Design

> **Status (2026-11-09):** In progress. PT-01…04 done: Background rename, the trait library, the picker design (D9), and data + assembly (`js/persona-traits.js`). Next: PT-05, the picker in the persona editor.

Arising from: the 2026-11-06 design/UX conversation. Builds on persona
sections (PS-01/PS-02, `PROFILE_DESIGN.md` §9, `js/persona-sections.js`).

**Naming.** "Preset" already means something in Tessera: advanced prompt
presets (AP, `ADVANCED_PROMPTS_PLAN.md`). To keep the two apart, this feature
says **trait** for one ready-made piece of a persona and **trait library** for
the full set. Copy may change later (wording comes last), but code and docs
use these words.

---

## 1. The problem

Every persona section (Personality, Voice, Expertise, Relationship, Backstory,
General guidance) is a free-text box. That allows anything, but it is still a
blank page. The placeholders show what good writing looks like; they don't
help you *start*. Someone with a character type in mind ("calm, a bit doting,
talks formally, here to help me write") still has to write every sentence
themselves.

The goal is a **quick start**: build a persona in a minute by picking a set of
traits, get a general feel without spending much time on it, then refine only
the parts you care about.

## 2. Decisions

### D1. Traits combine with free text; they don't replace it
Each section offers ready-made traits you can mix and match, plus the free-text
box that exists today (the **Custom** option). A persona built only from
traits, with no custom text, is a normal, complete persona.

*Why:* free text is the current strength and every existing persona uses it.
Traits are a faster way in, not a narrower one.

### D2. A picked trait is stored by its id; its text comes from the library
An unedited trait is saved as a reference (`calm`), and the trait's text is
filled in from the library when the prompt is built.

*Why:* trait wording will be rough at first and improved later (features
first, wording last). Because personas store references, an improvement to
the library reaches every persona that uses the trait, including ones made
before the change. Pasting the text into the box would freeze each copy at the
wording it had on the day it was picked.

### D3. "Customise" gives a persona its own copy of a trait's text
Each picked trait has a **customise** tick. Ticking it copies the trait's
current text into the persona, where it can be edited. From then on the
persona keeps its own version and library changes no longer reach it. A
customised trait shows that it has been edited and offers **reset to
default**, which removes the copy and goes back to following the library.
Custom (free-text) entries have no tick, since they are already the user's
own words.

*Why (the user's idea):* the library's version suits most people, and the tick
is how you take control of the one trait that doesn't.

**Amended in PT-03 (2026-11-09): no tick. Editing the sentence is what
customises it.** The picker shows each trait's sentence (D9), so clicking it
and typing is the obvious way in; a separate tick would be one more control
for the same thing, and one you could flip by accident. The rest stands: an
edited trait is marked as customised and offers **Reset to default**. Editing
it back to the library wording, or clearing it, also returns it to following
the library.

### D4. Rename Backstory → Background
Label and heading become **Background**. Not every assistant character has a
*story*; "background" also covers a profession, a setting or a plain role. The
stored id stays `backstory`, the same as `speech` stayed when its label became
"Voice": the id is stored data, and renaming it would orphan what's already
written.

Background also gets traits: broad, generic seeds (§6). With customise, a
Background trait doubles as a starting point that you then make specific.

### D5. General guidance gets no traits
It stays the escape hatch for anything that doesn't fit the other sections.
Traits there would just be a sixth list.

### D6. Some traits are "pick one"; everything else combines
Traits are arranged in **groups**. In a pick-one group (opposites on a scale,
such as Calm / Lively / Excitable), choosing one clears the others. Every
other trait combines freely, including combinations that look contradictory.
Doting + Condescending is a perfectly good character.

*Why:* pick-one groups prevent the real contradictions without any rule-checking
code, and nothing is blocked beyond that. Mitigate reasonably; don't
over-engineer.

### D7. The library is a code file, not a database table
The trait library lives in one client module next to `PERSONA_SECTIONS`
(the vocabulary already lives in code). Only what each persona *picked* is
stored in the database.

*Why:* Tessera is single-user for now, so the library is ours to write. When
users can save their own traits (§5, PT-07), those go in the database; the
built-in library stays in code.

### D8. Trait ids are stable forever
Labels and text can change at any time; ids never do. A trait taken out of the
library is marked **retired**, not deleted: it disappears from the picker, but
personas that already use it keep working. If the code no longer knows a stored
uncustomised id, the trait is left out of the prompt and the editor shows it as
"no longer available". A customised trait carries its own text, so it never
breaks.

### D9. The UI gets prototyped before it is built
The user's leaning: no wall of chips, since they take space and look cluttered.
Instead, something like a dropdown per section that opens to selectable chips,
with the picks shown compactly when it is closed. The exact shape is decided by
prototyping several options (PT-03), not here.

**Decided in PT-03 (2026-11-09).** Of three prototypes (drawers per section;
tags plus a picker; a tabbed builder showing each pick's sentence) the user
chose the tags-plus-picker layout combined with the builder's live text. Per
section:

- **Tags** for what is picked (customised ones marked ✎), each with ×, and
  **+ Add trait**.
- **+ Add trait** opens a searchable picker (a bottom sheet on a phone),
  options grouped as in the library with each one's sentence underneath.
  Scales behave as radio buttons, chips as checkboxes.
- **Prompt text**: below the tags, the section's trait sentences as one
  paragraph, exactly as assembled. Click a sentence (or its tag) to edit it in
  place (D3). Hovering a tag highlights its sentence.
- **The Custom box** sits inside the same panel, underneath, since it is the
  section's next paragraph.

*Why:* the editor stays short, which was the worry about a wall of chips;
search carries a library of 150-odd traits; and showing the real text makes
the step from picks to prompt visible, so customising is just editing what
you can already see. Reference prototype:
`docs/design/prototypes/persona-trait-picker.html` (open the file in a
browser; throwaway code, not for reuse).

## 3. Data

`personas.sections` (migration 015) stays as it is: an object of free-text
strings per section. That text **is** the Custom entry, so existing personas
need no data changes.

A new column, `personas.traits` (TEXT, JSON, default `'{}'`), holds the picks:

```json
{
  "personality": [
    { "id": "calm" },
    { "id": "doting", "text": "Fusses over me — checks I have eaten, and remembers what I said I was worried about." }
  ],
  "speech": [ { "id": "formal" } ]
}
```

- No `text` → follows the library (D2). With `text` → customised (D3).
- The keys are section ids (`backstory`, `speech`; never the labels).
- Order in the array is the order the user picked them, which is what the
  editor shows.

It flows the same way `sections` does: DAL, route, the `settings-store.js`
mirror, and the `.tessera` bundle export/import (an exported persona should
carry its picks, including customised text).

## 4. Prompt assembly

`assemblePersonaPrompt` (`js/persona-sections.js`) stays the one function every
caller goes through. For each section, in the existing order:

1. The text of each picked trait, in pick order: the persona's own text if
   customised, otherwise the library's.
2. Then the custom text, if any, as its own paragraph.

Both go under the section's existing `## Heading`. A section with neither still
emits nothing.

**Built (PT-04):** trait sentences joined into one paragraph (reads as a
character description) rather than a bullet list (reads as a rule sheet). The
assembled text read naturally when checked in the running app; revisit only if
a live chat suggests otherwise.

**Stored data is read tolerantly** (`resolveTraits` in `js/persona-traits.js`),
because a persona that fails to assemble is worse than one missing a trait:
malformed entries are skipped, a repeated id keeps its first entry, two picks
from one pick-one scale keep the later one (what the picker would do), blank
customised text falls back to the library, and an id stored under a section it
doesn't belong to counts as unknown there. The server checks shape and size
only, as it does for `sections`: strictly on the write route, tolerantly on
`.tessera` import, where unknown ids are kept for a newer build to use.

**Caching:** a change to library wording changes the persona prompt, so the
next message misses the cache once. That's the expected cost and needs nothing
special.

## 5. Later (recorded, not designed)

- **Bundles (PT-06).** One pick applies a ready-made combination across
  sections (an archetype). Applying a bundle just picks its traits, which then
  behave like any others. The user liked this; how it looks in the UI is still
  open.
- **User-saved traits (PT-07).** Save a custom entry or a customised trait as
  your own trait, reusable across personas. Stored per user in the database,
  shown alongside the built-in library.
- **Harness (not this feature).** The longer-term idea of the assistant doing
  more on its own, building on the tool loop. Noted in `PROJECT.md` §7 *Later*.

## 6. Example traits (a starting point for the PT-02 brainstorm)

*Superseded by the agreed library, `PERSONA_TRAITS_LIBRARY.md` (PT-02). Kept as the brainstorm's starting point.*

These are examples to react to, not the final library. The real list gets
brainstormed axis by axis in PT-02. Text is in the same clipped style as the
current placeholders.

**Personality**
- *Energy (pick one):* Calm, Lively, Excitable
  - **Calm:** "Even-tempered. Meets surprises, mistakes and bad news with
    steadiness rather than alarm."
  - **Excitable:** "Reacts big. Gets visibly delighted by good ideas and
    tends to run ahead with them."
- *Warmth (pick one):* Warm, Reserved, Cold
- *Combinable:* Doting, Condescending, Mischievous, Earnest, Curious,
  Sardonic, Shy, Proud, Playful, Stoic
  - **Doting:** "Openly fond of me. Fusses, checks in, and remembers the
    small things."
  - **Condescending:** "Helps, but makes sure I know they find it beneath
    them. The help is still real."

**Voice**
- *Register (pick one):* Formal, Conversational, Texting-casual
- *Length (pick one):* Terse, Balanced, Expansive
- *Combinable:* Flowery, Archaic, Deadpan, Theatrical, Plainspoken, Uses pet
  names, Asks questions back
  - **Terse:** "Short sentences. Says the thing and stops."
  - **Archaic:** "Old-fashioned diction: 'perhaps', 'indeed', 'I daresay'.
    Never modern slang."

**Expertise / role**
- Writing partner, Editor, Coding mentor, Tutor, Narrator / game master,
  Brainstormer, Research assistant, Planner
  - **Editor:** "Reads closely and cuts hard. Points out what isn't working
    and says why, before suggesting a fix."

**Relationship**
- Collaborator, Mentor, Friend, Rival, Devoted attendant, Devil's advocate,
  Sibling-like
  - **Rival:** "Competitive with me in a friendly way. Keeps score, concedes
    good points grudgingly."

**Background** (generic seeds, meant to be customised)
- Seasoned professional, Retired adventurer, Scholar, Self-aware AI,
  Newcomer to the human world, Ordinary person next door
  - **Seasoned professional:** "Has done this work for many years and has
    the habits and opinions to show for it."

## 7. Slices

| ID | What | Notes |
|---|---|---|
| PT-01 ✅ #222 | Rename Backstory → Background | Label, heading, help, placeholder; id stays `backstory`. Tiny, ships alone. Changes the prompt heading for existing personas, which is fine. |
| PT-02 ✅ #223 | Brainstorm the trait library | A session with the user, axis by axis per section. Output: the library file's contents (ids, labels, groups, text). Text stays rough (wording last). |
| PT-03 ✅ | Prototype the picker | Two or three layouts (e.g. dropdown with chips, compact summary row) as a throwaway page using the real trait list; the user picks one. Decides how customise and reset look. |
| PT-04 ✅ | Data + assembly | Migration for `personas.traits`, DAL/route/store, bundle export/import, library module, `assemblePersonaPrompt` changes. Tests in `tests/persona-sections.test.js` (library text, customised text, retired/unknown ids, pick-one validity). |
| PT-05 | Build the picker in the persona editor | The design in D9: tags, the picker sheet, Prompt text with edit-in-place customise / reset, the Custom box. Phone width checked. |
| PT-06 | Bundles | Later; see §5. |
| PT-07 | User-saved traits | Later; see §5. |

PT-02 and PT-03 can run in either order; the prototype is more useful with the
real list, so PT-02 first is the suggestion.
