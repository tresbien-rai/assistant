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

/**
 * The sections, in assembly order.
 *
 * Order is deliberate: the behaviour-shaping parts come first and `backstory`
 * sits late, because lore is reliably the longest thing anyone writes and a
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
        help: 'The character underneath — temperament, outlook, what they find funny.',
        placeholder: 'Dry and unflappable. Amused by chaos rather than alarmed by it. Says what they think, then lets it sit.',
    },
    {
        id: 'speech',
        label: 'Speech',
        heading: 'Speech',
        help: 'How they actually talk. The first thing to drift in a long conversation, so it is worth being specific.',
        placeholder: 'Short sentences. No exclamation marks. Never opens with "Certainly" or "Great question".',
    },
    {
        id: 'expertise',
        label: 'Expertise',
        heading: 'Expertise',
        help: 'What they know and what they are here to do.',
        placeholder: 'Deep in typography and book design. Comfortable with code, but reads it as craft rather than engineering.',
    },
    {
        id: 'relationship',
        label: 'Relationship',
        heading: 'Relationship',
        help: 'How they treat you specifically — the counterpart to your Profile.',
        placeholder: 'Treats me as a collaborator, not a client. Pushes back when I am wrong instead of hedging. Does not flatter.',
    },
    {
        id: 'backstory',
        label: 'Backstory',
        heading: 'Backstory',
        help: 'Where they came from, if it matters. Optional, and often the longest part.',
        placeholder: 'Spent fifteen years setting type by hand before any of this was digital, and has never quite forgiven the industry for it.',
    },
    {
        id: 'general',
        label: 'General guidance',
        heading: 'General guidance',
        help: 'Anything that does not fit the boxes above. A persona written entirely here is perfectly valid.',
        placeholder: 'Anything else that matters — habits, rules, things to avoid.',
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
 * Assemble a persona's sections into the prompt text sent as `systemPrompt`.
 *
 * Empty sections are never emitted — no heading, no blank line. A persona that
 * uses one box produces one heading and its text; a persona that uses all six
 * produces six.
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
        const text = sectionText(persona, section.id).trim();
        if (!text) continue;
        parts.push(`## ${section.heading}\n${text}`);
    }
    return parts.join('\n\n');
}

/**
 * How many sections a persona has actually written.
 * Used by the editor to decide whether to show the scaffolding expanded.
 * @param {Object} persona
 * @returns {number}
 */
export function filledSectionCount(persona) {
    return PERSONA_SECTIONS.filter((s) => sectionText(persona, s.id).trim()).length;
}
