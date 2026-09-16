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
 *
 * Run with: node tests/persona-sections.test.js
 */

import assert from 'node:assert';
import {
    PERSONA_SECTIONS,
    PERSONA_SECTION_IDS,
    assemblePersonaPrompt,
    filledSectionCount,
    sectionText,
} from '../js/persona-sections.js';

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

check('backstory comes after the behaviour sections', () => {
    // Deliberate: lore is reliably the longest thing anyone writes, and a long
    // history should not bury a two-line voice instruction.
    const out = assemblePersonaPrompt(FULL);
    assert.ok(out.indexOf('## Voice') < out.indexOf('## Backstory'));
    assert.ok(out.indexOf('## Personality') < out.indexOf('## Backstory'));
});

check('general guidance comes last', () => {
    const out = assemblePersonaPrompt(FULL);
    assert.ok(out.lastIndexOf('## General guidance') > out.indexOf('## Backstory'));
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

console.log('\n' + '='.repeat(60));
console.log(failures === 0 ? 'All persona section tests passed!' : `${failures} assertion(s) FAILED`);
console.log('='.repeat(60) + '\n');
process.exit(failures === 0 ? 0 : 1);
