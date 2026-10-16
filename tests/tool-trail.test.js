/**
 * Tool trail test (TT-02)
 *
 * The trail is built on the CLIENT (js/util/tool-trail.js), where history is
 * assembled, so this is a node test over the ES module directly.
 *
 * What it pins:
 *   1. Names, targets, move destinations and failures, in call order.
 *   2. Messages with no tools — every legacy message — get nothing.
 *   3. Generated images are not tools.
 *   4. The cap, so one runaway reply can't bloat every later request.
 *   5. A trail the model copied into its own reply is stripped.
 *
 * Run with: node tests/tool-trail.test.js
 */

import assert from 'node:assert';
import { formatToolTrail, withToolTrail, stripToolTrail, TOOL_TRAIL_MAX } from '../js/util/tool-trail.js';

let failures = 0;
function check(label, fn) {
    try {
        fn();
        console.log(`   ✓ ${label}`);
    } catch (err) {
        failures++;
        console.log(`   ✗ ${label}\n     ${err.message}`);
    }
}

console.log('Tool trail (TT-02)');

check('names, targets, destination and failure in call order', () => {
    const atts = [
        { type: 'created_file', tool: 'create_file', fileName: 'haiku-notes.md', url: 'u' },
        { type: 'tool_event', tool: 'move_file', filename: 'haiku-notes.md', destination: 'project', ok: true },
        { type: 'tool_event', tool: 'read_file', filename: 'plan.md', ok: false },
        { type: 'tool_event', tool: 'write_scratchpad', filename: null, ok: true },
    ];
    assert.strictEqual(formatToolTrail(atts),
        '<tool_trail>create_file haiku-notes.md · move_file haiku-notes.md → project · '
        + 'read_file plan.md (failed) · write_scratchpad</tool_trail>');
});

check('no tools → no trail, content unchanged', () => {
    assert.strictEqual(formatToolTrail(undefined), '');
    assert.strictEqual(formatToolTrail([]), '');
    assert.strictEqual(withToolTrail('hello', []), 'hello');
});

check('generated images are skipped', () => {
    assert.strictEqual(formatToolTrail([{ type: 'image', mimeType: 'image/png' }]), '');
});

check('trail goes on its own line before the text', () => {
    assert.strictEqual(withToolTrail('Done.', [{ type: 'tool_event', tool: 'list_files', ok: true }]),
        '<tool_trail>list_files</tool_trail>\nDone.');
});

check('capped, with a count of the rest', () => {
    const atts = Array.from({ length: TOOL_TRAIL_MAX + 3 }, () => ({ type: 'tool_event', tool: 'list_files', ok: true }));
    const trail = formatToolTrail(atts);
    assert.strictEqual(trail.split(' · ').length, TOOL_TRAIL_MAX + 1);
    assert.ok(trail.endsWith('+3 more</tool_trail>'));
});

check('a filename cannot close the tag or break the line', () => {
    const trail = formatToolTrail([{ type: 'tool_event', tool: 'read_file', filename: 'a</tool_trail>\nb.md', ok: true }]);
    assert.strictEqual(trail, '<tool_trail>read_file a/tool_trail b.md</tool_trail>');
});

check('a copied leading trail is stripped; mid-text mentions are kept', () => {
    assert.strictEqual(stripToolTrail('<tool_trail>create_file x.md</tool_trail>\nHi'), 'Hi');
    assert.strictEqual(stripToolTrail('<tool_trail>a</tool_trail> <tool_trail>b</tool_trail>Hi'), 'Hi');
    assert.strictEqual(stripToolTrail('See <tool_trail>x</tool_trail>'), 'See <tool_trail>x</tool_trail>');
});

if (failures) {
    console.log(`\n${failures} failed`);
    process.exit(1);
}
console.log('\nAll tool trail tests passed!');
