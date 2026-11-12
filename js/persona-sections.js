/**
 * Persona sections — the vocabulary, and the assembly (PS-01)
 *
 * A persona used to be one "System Prompt" textarea. That is fine once you know
 * what a system prompt wants, and a blank page before you do — someone arriving
 * with a clear idea of their character still has to invent a structure to put it
 * in. These sections are that structure, offered rather than imposed: named
 * boxes that say what is worth writing, with an escape hatch for everything
 * else.
 *
 * WHY THIS IS A FIXED VOCABULARY, UNLIKE PROFILE SECTIONS
 *
 * Profile sections are the user's own arbitrary topics, so they are
 * add/rename/reorder. These are scaffolding, and scaffolding you have to design
 * yourself is just a blank page with extra steps. The set is fixed, the order is
 * fixed, and `general` absorbs anything that does not fit.
 *
 * WHY ASSEMBLY LIVES ON THE CLIENT
 *
 * The client has always composed the persona prompt and sent it as
 * `systemPrompt` (js/chat/send.js); the server never reads personas.system_prompt
 * for a chat. Moving assembly server-side would mean changing every send path to
 * stop sending it, for no gain — so this stays where the seam already is, in ONE
 * function that every caller goes through.
 *
 * WHY MARKDOWN HEADINGS AND NOT XML
 *
 * Tessera already distinguishes the two: XML-ish tags (`<session_state>`,
 * `<active_files>`, `<scratchpad>`) mark DATA the model consults, and prose under
 * Markdown headings marks INSTRUCTIONS it follows. A persona is emphatically the
 * second kind. Wrapping it in tags would file it with the reference material,
 * which is the opposite of what a block about embodiment wants.
 */

import { traitSentences } from './persona-traits.js';

/**
 * The sections, in assembly order.
 *
 * Order is deliberate: the behaviour-shaping parts come first and Background
 * (`backstory`) sits late, because lore is reliably the longest thing anyone writes and a
 * three-hundred-word history should not bury a two-line voice instruction.
 *
 * `general` is last and is NOT a leftovers bin — it is the escape hatch that
 * keeps the scaffolding from being a cage, and it is the section every existing
 * persona already has (see `generalOf`).
 *
 * `placeholder` is the part that actually teaches. The heading tells someone
 * which box to type in; the example tells them what good looks like, and it is
 * the cheapest thing here to iterate on.
 */
export const PERSONA_SECTIONS = [
    {
        id: 'personality',
        label: 'Personality',
        heading: 'Personality',
        help: 'Temperament, disposition, and sense of humour — how they carry themselves beneath the task.',
        placeholder: 'Dry and unflappable. Amused by chaos rather than alarmed by it. Notices small absurdities and lets them sit without explaining the joke.',
    },
    {
        // The id stays `speech` while the label reads "Voice": the id is stored
        // data and renaming it would orphan every persona that has written one,
        // for a change nobody can see.
        id: 'speech',
        label: 'Voice',
        heading: 'Voice',
        help: 'Cadence, phrasing, and habits on the page. Concrete rules here hold up best over a long conversation.',
        placeholder: 'Measured, unhurried sentences. Uses plain words for hard things. Never opens with "Certainly!" or "Great question", and never hedges with "It depends" without saying on what.',
    },
    {
        id: 'expertise',
        label: 'Expertise',
        heading: 'Expertise',
        help: 'What they know deeply, how they approach a problem, and what you come to them for.',
        placeholder: 'Deep in book design and editorial structure. Comfortable with code, though they read it as craft rather than engineering. Cares about trade-offs more than textbook rules.',
    },
    {
        id: 'relationship',
        label: 'Relationship',
        heading: 'Relationship',
        help: 'Who they are to you and how they treat you — the counterpart to your Profile.',
        placeholder: 'Treats me as a sharp colleague, not a client. Pushes back plainly when my reasoning is thin, skips the praise, and remembers what I am trying to build.',
    },
    {
        // The id stays `backstory` while the label reads "Background" (PT-01),
        // for the same reason as `speech` above: the id is stored data.
        // "Background" because not every assistant has a story — a profession,
        // a setting or a plain role belongs here too.
        id: 'backstory',
        label: 'Background',
        heading: 'Background',
        help: 'Where they come from — a profession, a setting, a life lived, or the world they inhabit.',
        placeholder: 'Spent fifteen years running a small letterpress shop before moving to digital tools, and still judges every layout by how it would look on cotton paper.',
    },
    {
        id: 'general',
        label: 'General guidance',
        heading: 'General guidance',
        help: 'Anything that doesn\'t fit the sections above — habits, boundaries, formatting rules — or the entire persona if you prefer writing in one place.',
        placeholder: 'Keep replies under three paragraphs unless asked for depth. When reviewing drafts, quote the exact line before suggesting a cut.',
    },
];

/** Every section id, for validation and iteration. */
export const PERSONA_SECTION_IDS = PERSONA_SECTIONS.map((s) => s.id);

/** Section ids that live in `persona.sections`; `general` lives in systemPrompt. */
export const AUTHORED_SECTION_IDS = PERSONA_SECTION_IDS.filter((id) => id !== 'general');

/**
 * The general-guidance text for a persona.
 *
 * It is `persona.systemPrompt` — the original column, repurposed rather than
 * migrated. Every persona written before PS-01 has its whole character in
 * there, and reading it as "the general section" means an upgrade moves no data
 * and reshapes nobody's character.
 *
 * @param {Object} persona
 * @returns {string}
 */
export function generalOf(persona) {
    return (persona && persona.systemPrompt) || '';
}

/**
 * The text of one section, wherever it happens to live.
 * @param {Object} persona
 * @param {string} id - a PERSONA_SECTION_IDS entry
 * @returns {string}
 */
export function sectionText(persona, id) {
    if (id === 'general') return generalOf(persona);
    const sections = (persona && persona.sections) || {};
    return typeof sections[id] === 'string' ? sections[id] : '';
}

/**
 * The body of one section as it goes into the prompt (PT-04): the sentences of
 * its picked traits as one paragraph, in pick order, then the section's own
 * free text as a paragraph of its own. Either may be absent.
 *
 * One paragraph rather than a bullet list because a list of traits reads as a
 * rule sheet, and these describe a character (PERSONA_TRAITS_DESIGN.md §4).
 *
 * @param {Object} persona
 * @param {string} id - a PERSONA_SECTION_IDS entry
 * @returns {string} '' when the section has neither
 */
export function sectionBody(persona, id) {
    const traits = traitSentences(persona, id).join(' ');
    const own = sectionText(persona, id).trim();
    return [traits, own].filter(Boolean).join('\n\n');
}

/**
 * Assemble a persona's sections into the prompt text sent as `systemPrompt`.
 *
 * Empty sections are never emitted — no heading, no blank line. A persona that
 * uses one box produces one heading and its text; a persona that uses all six
 * produces six. A section counts as filled when it has picked traits, its own
 * text, or both (see `sectionBody`).
 *
 * Headings are always emitted, including for a lone section. The alternative
 * considered was emitting bare prose until a second section appears, which
 * would have kept existing personas byte-identical; it was rejected because a
 * prompt whose shape changes the moment you fill in a second box is harder to
 * reason about than one that always looks the same. The cost is that personas
 * written before PS-01 gain a `## General guidance` heading they did not have.
 *
 * @param {Object} persona
 * @returns {string} the assembled persona prompt, or '' if nothing is written
 */
export function assemblePersonaPrompt(persona) {
    const parts = [];
    for (const section of PERSONA_SECTIONS) {
        const text = sectionBody(persona, section.id);
        if (!text) continue;
        parts.push(`## ${section.heading}\n${text}`);
    }
    return parts.join('\n\n');
}

/**
 * How many sections a persona has actually filled, with traits or text.
 * Used by the editor to decide whether to show the scaffolding expanded.
 * @param {Object} persona
 * @returns {number}
 */
export function filledSectionCount(persona) {
    return PERSONA_SECTIONS.filter((s) => sectionBody(persona, s.id)).length;
}
