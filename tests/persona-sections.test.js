/**
 * Persona section assembly test (PS-01)
 *
 * The assembly runs on the CLIENT (js/persona-sections.js), because the client
 * has always composed the persona prompt and sent it. So this is a node test
 * over the ES module directly rather than part of the server suite.
 *
 * What it pins:
 *   1. A persona written before PS-01 — all text in `systemPrompt`, no sections
 *      — still produces its own words, with only the agreed heading added.
 *   2. Empty sections are never emitted. No stray headings, no blank runs.
 *   3. Order is the fixed vocabulary order, not object key order, so two
 *      personas with the same content always produce the same prompt.
 *   4. Traits (PT-04): picked traits read as one paragraph ahead of the
 *      section's own text; library text vs customised text; retired and
 *      unknown ids; pick-one scales; and the library's own integrity.
 *
 * Run with: node tests/persona-sections.test.js
 */

import assert from 'node:assert';
import {
    PERSONA_SECTIONS,
    PERSONA_SECTION_IDS,
    AUTHORED_SECTION_IDS,
    assemblePersonaPrompt,
    filledSectionCount,
    sectionText,
    sectionBody,
} from '../js/persona-sections.js';
import {
    TRAIT_LIBRARY,
    TRAIT_SECTION_IDS,
    findTrait,
    pickerGroups,
    resolveTraits,
} from '../js/persona-traits.js';

let failures = 0;
function check(label, fn) {
    try {
        fn();
        console.log(`   ✓ ${label}`);
    } catch (err) {
        console.log(`   ✗ ${label}`);
        console.log(`      ${err.message}`);
        failures++;
    }
}

console.log('='.repeat(60));
console.log('Persona Section Assembly Test (PS-01)');
console.log('='.repeat(60));

console.log('\n1. the legacy persona (nothing migrates)...');

check('a pre-PS-01 persona keeps its exact words', () => {
    const legacy = { systemPrompt: 'You are a helpful, friendly assistant.' };
    const out = assemblePersonaPrompt(legacy);
    assert.ok(out.includes('You are a helpful, friendly assistant.'));
    // The one agreed change: it gains a heading it did not have.
    assert.strictEqual(out, '## General guidance\nYou are a helpful, friendly assistant.');
});

check('a persona with nothing written assembles to empty', () => {
    assert.strictEqual(assemblePersonaPrompt({}), '');
    assert.strictEqual(assemblePersonaPrompt({ systemPrompt: '', sections: {} }), '');
    assert.strictEqual(assemblePersonaPrompt(null), '');
});

check('whitespace-only sections count as empty', () => {
    assert.strictEqual(assemblePersonaPrompt({ systemPrompt: '   \n  ' }), '');
});

console.log('\n2. assembly...');

const FULL = {
    systemPrompt: 'Never break character.',
    sections: {
        personality: 'Dry and unflappable.',
        speech: 'Short sentences. No exclamation marks.',
        expertise: 'Typography and book design.',
        relationship: 'Treats me as a collaborator.',
        backstory: 'Set type by hand for fifteen years.',
    },
};

check('every filled section appears under its heading', () => {
    const out = assemblePersonaPrompt(FULL);
    for (const section of PERSONA_SECTIONS) {
        assert.ok(out.includes(`## ${section.heading}`), `missing ${section.id}`);
    }
    assert.ok(out.includes('Dry and unflappable.'));
    assert.ok(out.includes('Never break character.'));
});

check('order is the vocabulary order, not object key order', () => {
    // Same content, keys inserted backwards. A prompt that changes because of
    // JSON key order would be unreproducible and would break prompt caching.
    const reversed = {
        systemPrompt: FULL.systemPrompt,
        sections: Object.fromEntries(Object.entries(FULL.sections).reverse()),
    };
    assert.strictEqual(assemblePersonaPrompt(reversed), assemblePersonaPrompt(FULL));
});

check('background comes after the behaviour sections', () => {
    // Deliberate: lore is reliably the longest thing anyone writes, and a long
    // history should not bury a two-line voice instruction.
    const out = assemblePersonaPrompt(FULL);
    assert.ok(out.indexOf('## Voice') < out.indexOf('## Background'));
    assert.ok(out.indexOf('## Personality') < out.indexOf('## Background'));
});

check('general guidance comes last', () => {
    const out = assemblePersonaPrompt(FULL);
    assert.ok(out.lastIndexOf('## General guidance') > out.indexOf('## Background'));
});

check('an unfilled section leaves no trace', () => {
    const out = assemblePersonaPrompt({ sections: { speech: 'Terse.' } });
    assert.strictEqual(out, '## Voice\nTerse.');
    assert.ok(!out.includes('Personality'));
    assert.ok(!/\n\n\n/.test(out), 'no blank run where a section was skipped');
});

check('sections are separated by exactly one blank line', () => {
    const out = assemblePersonaPrompt({
        sections: { personality: 'A.', speech: 'B.' },
    });
    assert.strictEqual(out, '## Personality\nA.\n\n## Voice\nB.');
});

console.log('\n3. vocabulary...');

check('general is part of the vocabulary but not stored in sections', () => {
    assert.ok(PERSONA_SECTION_IDS.includes('general'));
    // It lives in systemPrompt — that is what makes the upgrade free.
    assert.strictEqual(sectionText({ systemPrompt: 'X' }, 'general'), 'X');
    assert.strictEqual(sectionText({ sections: { general: 'Y' } }, 'general'), '');
});

check('every section has the fields the editor needs', () => {
    for (const s of PERSONA_SECTIONS) {
        assert.ok(s.id && s.label && s.heading, `${s.id} is missing a label`);
        assert.ok(s.placeholder, `${s.id} has no placeholder — the placeholder is what teaches`);
        assert.ok(s.help, `${s.id} has no help text`);
    }
});

check('ids are unique', () => {
    assert.strictEqual(new Set(PERSONA_SECTION_IDS).size, PERSONA_SECTION_IDS.length);
});

check('Background is still stored under the backstory id', () => {
    // PT-01 renamed the label only. Text written before the rename lives under
    // `backstory`; changing the id would silently drop it from the prompt.
    const out = assemblePersonaPrompt({ sections: { backstory: 'Set type by hand.' } });
    assert.strictEqual(out, '## Background\nSet type by hand.');
    assert.ok(AUTHORED_SECTION_IDS.includes('backstory'));
});

check('filledSectionCount counts what is written', () => {
    assert.strictEqual(filledSectionCount({}), 0);
    assert.strictEqual(filledSectionCount({ systemPrompt: 'X' }), 1);
    assert.strictEqual(filledSectionCount(FULL), PERSONA_SECTIONS.length);
});

check('an unknown section in the data is ignored, not emitted', () => {
    // Forward compatibility: a bundle from a future version may carry a section
    // this build has never heard of. It round-trips through storage, but it
    // must not appear in the prompt as an unlabelled paragraph.
    const out = assemblePersonaPrompt({ sections: { speech: 'Terse.', quirks: 'Hums.' } });
    assert.ok(!out.includes('Hums.'));
});

console.log('\n3. traits (PT-04)...');

const lib = (section, id) => findTrait(section, id).trait.text;

check('a picked trait assembles its library text under the section heading', () => {
    const out = assemblePersonaPrompt({ traits: { personality: [{ id: 'calm' }] } });
    assert.strictEqual(out, `## Personality\n${lib('personality', 'calm')}`);
});

check('traits join as one paragraph, in pick order, ahead of the own text', () => {
    const persona = {
        sections: { personality: 'Hums while thinking.' },
        traits: { personality: [{ id: 'curious' }, { id: 'calm' }] },
    };
    assert.strictEqual(
        sectionBody(persona, 'personality'),
        `${lib('personality', 'curious')} ${lib('personality', 'calm')}\n\nHums while thinking.`,
    );
});

check('a customised trait uses its own text, not the library', () => {
    const out = assemblePersonaPrompt({ traits: { speech: [{ id: 'terse', text: 'Never more than ten words.' }] } });
    assert.strictEqual(out, '## Voice\nNever more than ten words.');
});

check('blank customised text falls back to the library', () => {
    const [t] = resolveTraits({ traits: { speech: [{ id: 'terse', text: '   ' }] } }, 'speech');
    assert.strictEqual(t.text, lib('speech', 'terse'));
    assert.strictEqual(t.customised, false);
});

check('an unknown id is left out of the prompt but reported to the editor', () => {
    const persona = { traits: { personality: [{ id: 'no_such_trait' }, { id: 'calm' }] } };
    assert.strictEqual(sectionBody(persona, 'personality'), lib('personality', 'calm'));
    const unknown = resolveTraits(persona, 'personality').find((t) => t.id === 'no_such_trait');
    assert.strictEqual(unknown.known, false);
});

check('an unknown id that was customised keeps working', () => {
    const out = sectionBody({ traits: { personality: [{ id: 'gone_now', text: 'Whistles.' }] } }, 'personality');
    assert.strictEqual(out, 'Whistles.');
});

check('a retired trait leaves the picker but still assembles', () => {
    const { trait } = findTrait('personality', 'calm');
    trait.retired = true;
    try {
        const offered = pickerGroups('personality').flatMap((g) => g.traits.map((t) => t.id));
        assert.ok(!offered.includes('calm'));
        assert.strictEqual(sectionBody({ traits: { personality: [{ id: 'calm' }] } }, 'personality'), trait.text);
    } finally {
        delete trait.retired;
    }
});

check('two picks from one pick-one scale keep the later one', () => {
    const persona = { traits: { personality: [{ id: 'calm' }, { id: 'curious' }, { id: 'lively' }] } };
    assert.deepStrictEqual(resolveTraits(persona, 'personality').map((t) => t.id), ['curious', 'lively']);
});

check('chips combine freely, contradictions included', () => {
    const persona = { traits: { personality: [{ id: 'condescending' }, { id: 'earnest' }] } };
    assert.strictEqual(resolveTraits(persona, 'personality').length, 2);
});

check('a trait stored under the wrong section is unknown there', () => {
    assert.strictEqual(sectionBody({ traits: { personality: [{ id: 'terse' }] } }, 'personality'), '');
});

check('general guidance takes no traits', () => {
    assert.strictEqual(sectionBody({ traits: { general: [{ id: 'calm' }] } }, 'general'), '');
});

check('malformed and repeated picks are skipped, not thrown on', () => {
    const persona = { traits: { personality: [null, 'calm', { id: 5 }, { id: 'curious' }, { id: 'curious' }] } };
    assert.deepStrictEqual(resolveTraits(persona, 'personality').map((t) => t.id), ['curious']);
    assert.strictEqual(assemblePersonaPrompt({ traits: 'nonsense' }), '');
    assert.strictEqual(assemblePersonaPrompt({ traits: { personality: 'calm' } }), '');
});

check('a section with only traits counts as filled', () => {
    assert.strictEqual(filledSectionCount({ traits: { speech: [{ id: 'terse' }] } }), 1);
});

console.log('\n4. the trait library...');

const allTraits = Object.values(TRAIT_LIBRARY).flatMap((groups) => groups.flatMap((g) => g.traits));

check('ids are unique across the whole library', () => {
    const ids = allTraits.map((t) => t.id);
    assert.strictEqual(new Set(ids).size, ids.length);
});

check('ids are lowercase snake_case, which the server also requires', () => {
    for (const t of allTraits) assert.match(t.id, /^[a-z0-9_]{1,64}$/, t.id);
});

check('every trait has a label and a sentence', () => {
    for (const t of allTraits) {
        assert.ok(t.label && t.label.trim(), `${t.id} has no label`);
        assert.ok(t.text && t.text.trim(), `${t.id} has no text`);
    }
});

check('every scale offers at least two options', () => {
    for (const groups of Object.values(TRAIT_LIBRARY)) {
        for (const g of groups) {
            assert.ok(['scale', 'chip'].includes(g.kind), `${g.name}: unknown kind ${g.kind}`);
            if (g.kind === 'scale') assert.ok(g.traits.length >= 2, `${g.name} has one option`);
        }
    }
});

check('the library covers exactly the trait sections, and general has none', () => {
    assert.deepStrictEqual(Object.keys(TRAIT_LIBRARY).sort(), [...TRAIT_SECTION_IDS].sort());
    assert.ok(TRAIT_SECTION_IDS.every((id) => AUTHORED_SECTION_IDS.includes(id)));
    assert.ok(!TRAIT_SECTION_IDS.includes('general'));
});

console.log('\n' + '='.repeat(60));
console.log(failures === 0 ? 'All persona section tests passed!' : `${failures} assertion(s) FAILED`);
console.log('='.repeat(60) + '\n');
process.exit(failures === 0 ? 0 : 1);
