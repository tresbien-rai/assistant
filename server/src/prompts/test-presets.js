/**
 * Prompt preset test (AP-01, docs/ADVANCED_PROMPTS_PLAN.md)
 *
 * Three things, in descending order of how much they'd hurt to get wrong:
 *
 * 1. **Byte-identity.** With no preset, buildSystemPrompt must produce exactly
 *    what it produced before AP-01, for every combination of the three
 *    conditions that shape it. The expected strings below are pinned from the
 *    pre-AP-01 implementation — if a change to the built-in wording is
 *    deliberate, update GOLDEN; if this fails unexpectedly, the composer broke.
 * 2. **Overrides + order.** A preset changes wording and sequence, and a block
 *    it never touched still renders from the built-in.
 * 3. **Gating survives.** A preset cannot make a conditional block appear when
 *    its condition is false (Decision D3) — the security-shaped property here.
 *
 * Plus macros, normalisation of junk input, and validation limits.
 * Pure functions only: no DB, no requests.
 *
 * Run with: node src/prompts/test-presets.js
 */

const assert = require('node:assert');
const {
  buildSystemPrompt, buildContextAck, composeSystemPrompt, describeContextAck,
  ORIENTATION, CONTEXT_ACK,
} = require('./tessera');
const {
  PRESET_NONE,
  defaultBlocks,
  normalizeBlocks,
  validateBlocks,
  validateName,
  expandMacros,
  buildMacroValues,
  MAX_BLOCK_CHARS,
  SYSTEM_BLOCK_IDS,
} = require('./presets');

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

const PERSONA = 'You are Vela, a terse navigator.';
const EXPRESSIONS = ['neutral', 'happy', 'wry'];

/** The pre-AP-01 composition, rebuilt from its parts. */
function golden({ expressions = false, scratchpad = false, persona = false } = {}) {
  let out = ORIENTATION;
  if (expressions) {
    out += `

## Expression

The user sees you as an avatar whose face changes with your mood. Start every
reply with an expression tag, before any other text:

[expression: name]

Available expressions: ${EXPRESSIONS.join(', ')}

Pick the one that best fits how you feel as you begin writing, and let it carry
into the reply's tone. Use exactly one tag, always as the very first thing in
the message. If nothing fits, use the closest match.

The tag is removed before the message is displayed, so the user never sees it —
never mention it, explain it, or apologize for it. If you omit it, your avatar
simply keeps its previous expression.`;
  }
  if (scratchpad) {
    out += `

## Scratchpad

This conversation has a shared scratchpad — a document beside the chat that both
you and the user edit directly (write_scratchpad replaces the whole thing;
edit_scratchpad changes part of it). Use it as the main place to develop
substantial or evolving content — outlines, drafts, structured notes, the current
state of a plan — rather than packing that content into long chat messages.

Keep it a clean, CURRENT artifact, not a log. Rework, trim, and REPLACE
superseded ideas in place instead of appending to them, so it stays focused and
does not grow unmanageably — this is the core of how the scratchpad differs from
a file you build up. In your chat replies, stay focused on reasoning and
discussion: explain what you changed and why, and point to the scratchpad rather
than restating its contents. The user edits it too, so treat their changes as
part of your shared thinking.`;
  }
  if (persona) out += `\n\n---\n\n${PERSONA}`;
  return out;
}

console.log('='.repeat(60));
console.log('Prompt presets (AP-01)');
console.log('='.repeat(60));

console.log('\n1. Byte-identity with the pre-AP-01 output (no preset)...');

for (const expressions of [false, true]) {
  for (const scratchpad of [false, true]) {
    for (const persona of [false, true]) {
      const label = `expressions=${expressions} scratchpad=${scratchpad} persona=${persona}`;
      check(label, () => {
        const actual = buildSystemPrompt(
          persona ? PERSONA : '',
          expressions ? EXPRESSIONS : [],
          { scratchpad }
        );
        assert.strictEqual(actual, golden({ expressions, scratchpad, persona }));
      });
    }
  }
}

check('the context ack is unchanged', () => {
  assert.strictEqual(buildContextAck(), CONTEXT_ACK);
});

check('a persona prompt is trimmed, as before', () => {
  const out = buildSystemPrompt(`  \n${PERSONA}\n  `, [], {});
  assert.strictEqual(out, golden({ persona: true }));
});

console.log('\n2. Overrides and ordering...');

check('an override replaces only its own block', () => {
  const preset = defaultBlocks();
  preset.blocks.orientation.text = 'CUSTOM ORIENTATION';
  const out = buildSystemPrompt(PERSONA, EXPRESSIONS, { preset });
  assert.ok(out.startsWith('CUSTOM ORIENTATION'), 'override applied');
  assert.ok(!out.includes('# Tessera'), 'built-in orientation gone');
  assert.ok(out.includes('## Expression'), 'untouched block still built-in');
  assert.ok(out.endsWith(PERSONA), 'persona still last');
});

check('reordering moves blocks, persona included', () => {
  const preset = defaultBlocks();
  preset.order = ['persona', 'orientation', 'expressions', 'scratchpad'];
  const out = buildSystemPrompt(PERSONA, [], { preset });
  assert.ok(out.startsWith(PERSONA), 'persona leads');
  // Nothing above it to separate it from, so no rule.
  assert.ok(!out.includes('---'), 'separator dropped when the persona leads');
  assert.ok(out.includes('# Tessera'), 'orientation follows');
});

check('a disabled block is omitted', () => {
  const preset = defaultBlocks();
  preset.blocks.orientation.enabled = false;
  const out = buildSystemPrompt(PERSONA, EXPRESSIONS, { preset });
  assert.ok(!out.includes('# Tessera'), 'orientation gone');
  assert.ok(out.includes('## Expression'), 'the rest survives');
});

check('a disabled context_ack renders as empty', () => {
  const preset = defaultBlocks();
  preset.blocks.context_ack.enabled = false;
  assert.strictEqual(buildContextAck({ preset }), '');
});

check('an all-disabled preset with no persona yields an empty prompt', () => {
  const preset = defaultBlocks();
  for (const id of SYSTEM_BLOCK_IDS) preset.blocks[id].enabled = false;
  assert.strictEqual(buildSystemPrompt('', [], { preset }), '');
});

console.log('\n3. A preset cannot enable a capability (D3)...');

check('scratchpad text stays out when the pad is inactive', () => {
  const preset = defaultBlocks();
  preset.blocks.scratchpad.text = 'PAD RULES';
  const out = buildSystemPrompt(PERSONA, [], { preset, scratchpad: false });
  assert.ok(!out.includes('PAD RULES'), 'not injected while the pad is off');
  assert.ok(buildSystemPrompt(PERSONA, [], { preset, scratchpad: true }).includes('PAD RULES'),
    'injected once the pad is on');
});

check('the expression block stays out when the persona has none', () => {
  const preset = defaultBlocks();
  preset.blocks.expressions.text = 'EXPRESSION RULES';
  assert.ok(!buildSystemPrompt(PERSONA, [], { preset }).includes('EXPRESSION RULES'));
  assert.ok(buildSystemPrompt(PERSONA, EXPRESSIONS, { preset }).includes('EXPRESSION RULES'));
});

check('the expression list comes from the persona, not the caller', () => {
  const preset = defaultBlocks();
  preset.blocks.expressions.text = 'Moods: {{expressions}}';
  // A caller trying to force the macro is ignored — the sanitized set wins.
  const out = buildSystemPrompt(PERSONA, EXPRESSIONS, {
    preset,
    macros: { expressionNames: ['smug', 'injected'] },
  });
  assert.ok(out.includes('Moods: neutral, happy, wry'), out.slice(0, 200));
});

check('reserved + malformed expression names never reach the prompt', () => {
  const preset = defaultBlocks();
  preset.blocks.expressions.text = 'Moods: {{expressions}}';
  const out = buildSystemPrompt(PERSONA, ['generating', 'bad name', 'ok'], { preset });
  assert.ok(out.includes('Moods: ok'), 'only the valid name survives');
});

console.log('\n4. Macros...');

check('known macros expand, unknown ones are left verbatim', () => {
  const values = buildMacroValues({ personaName: 'Vela', userName: 'Rai' });
  assert.strictEqual(
    expandMacros('{{char}} greets {{user}} at {{nowhere}}', values),
    'Vela greets Rai at {{nowhere}}'
  );
});

check('macro expansion is a single pass (no recursion)', () => {
  const out = expandMacros('{{char}}', buildMacroValues({ personaName: '{{user}}', userName: 'Rai' }));
  assert.strictEqual(out, '{{user}}', 'the inserted value is not re-scanned');
});

check('whitespace and case inside the braces are tolerated', () => {
  const values = buildMacroValues({ personaName: 'Vela' });
  assert.strictEqual(expandMacros('{{ CHAR }}', values), 'Vela');
});

check('a macro with no source resolves to empty, not to the literal', () => {
  assert.strictEqual(expandMacros('[{{project}}]', buildMacroValues({})), '[]');
});

check('date and time are ISO-shaped', () => {
  const v = buildMacroValues({ now: new Date(Date.UTC(2026, 6, 30, 14, 5)) });
  assert.strictEqual(v.date, '2026-07-30');
  assert.strictEqual(v.time, '14:05');
});

console.log('\n5. Normalisation of stored/imported JSON...');

check('null / garbage falls back to the built-in shape', () => {
  for (const raw of [null, undefined, 'nope', 42, []]) {
    const n = normalizeBlocks(raw);
    assert.deepStrictEqual(n.order, SYSTEM_BLOCK_IDS, `order for ${JSON.stringify(raw)}`);
    assert.strictEqual(n.blocks.orientation.text, null);
    assert.strictEqual(n.blocks.orientation.enabled, true);
  }
});

check('unknown ids are dropped and missing ones appended', () => {
  const n = normalizeBlocks({ order: ['persona', 'not_a_block', 'persona'] });
  assert.strictEqual(n.order[0], 'persona', 'the known id keeps its place');
  assert.strictEqual(new Set(n.order).size, n.order.length, 'no duplicates');
  assert.deepStrictEqual(
    [...n.order].sort(),
    [...SYSTEM_BLOCK_IDS].sort(),
    'every system block is present exactly once'
  );
});

check('a non-string text is treated as "use the built-in"', () => {
  const n = normalizeBlocks({ blocks: { orientation: { text: 12 } } });
  assert.strictEqual(n.blocks.orientation.text, null);
});

check('a malformed preset still composes the built-in prompt', () => {
  const out = buildSystemPrompt(PERSONA, EXPRESSIONS, { preset: { blocks: 'broken' } });
  assert.strictEqual(out, golden({ expressions: true, persona: true }));
});

console.log('\n6. Validation (the write path)...');

check('the default blocks validate', () => {
  assert.strictEqual(validateBlocks(defaultBlocks()).ok, true);
});

check('an unknown block id is rejected', () => {
  const r = validateBlocks({ blocks: { jailbreak: { text: 'hi' } } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Unknown block/);
});

check('an unknown id in order is rejected', () => {
  assert.strictEqual(validateBlocks({ order: ['orientation', 'nope'] }).ok, false);
});

check('a duplicate in order is rejected', () => {
  assert.strictEqual(validateBlocks({ order: ['orientation', 'orientation'] }).ok, false);
});

check('an over-long block is rejected', () => {
  const r = validateBlocks({ blocks: { orientation: { text: 'x'.repeat(MAX_BLOCK_CHARS + 1) } } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /limit/);
});

check('text on the persona block is rejected', () => {
  const r = validateBlocks({ blocks: { persona: { text: 'not yours' } } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /persona/i);
});

check('names are required and bounded', () => {
  assert.strictEqual(validateName('').ok, false);
  assert.strictEqual(validateName('   ').ok, false);
  assert.strictEqual(validateName('x'.repeat(200)).ok, false);
  assert.strictEqual(validateName('Roleplay v2').ok, true);
});

console.log('\n7. Provenance (AP-05)...');

check('the reported spans reconstruct the prompt exactly', () => {
  const preset = defaultBlocks();
  preset.blocks.orientation.text = 'CUSTOM';
  const { text, blocks } = composeSystemPrompt(PERSONA, EXPRESSIONS, { preset, scratchpad: true });
  const included = blocks.filter(b => b.included);
  // Joining the reported spans must give back the real prompt, character for
  // character. This is the property the inspector's char counts rest on.
  assert.strictEqual(included.map(b => b.text).join('\n\n'), text);
  assert.strictEqual(
    included.reduce((n, b) => n + b.chars, 0) + (included.length - 1) * 2,
    text.length
  );
});

check('sources name where each block\'s text came from', () => {
  const preset = defaultBlocks();
  preset.blocks.orientation.text = 'CUSTOM';
  const { blocks } = composeSystemPrompt(PERSONA, EXPRESSIONS, { preset });
  const by = Object.fromEntries(blocks.map(b => [b.id, b]));
  assert.strictEqual(by.orientation.source, 'preset', 'overridden');
  assert.strictEqual(by.expressions.source, 'built-in', 'untouched');
  assert.strictEqual(by.persona.source, 'persona', 'the persona’s own prompt');
});

check('every exclusion carries a reason', () => {
  const preset = defaultBlocks();
  preset.blocks.orientation.enabled = false;
  // No expressions, no scratchpad, no persona prompt → three different reasons.
  const { blocks } = composeSystemPrompt('', [], { preset, scratchpad: false });
  const by = Object.fromEntries(blocks.map(b => [b.id, b]));
  assert.strictEqual(by.orientation.reason, 'disabled');
  assert.strictEqual(by.expressions.reason, 'no-expressions');
  assert.strictEqual(by.scratchpad.reason, 'scratchpad-inactive');
  assert.strictEqual(by.persona.reason, 'no-persona-prompt');
  assert.ok(blocks.every(b => b.included || b.reason), 'no unexplained exclusion');
});

check('the context ack is described separately from the system layer', () => {
  assert.strictEqual(describeContextAck({}, false).reason, 'no-context');
  assert.strictEqual(describeContextAck({}, true).included, true);
  const off = defaultBlocks();
  off.blocks.context_ack.enabled = false;
  assert.strictEqual(describeContextAck({ preset: off }, true).reason, 'disabled');
});

check('buildSystemPrompt and composeSystemPrompt cannot drift', () => {
  // buildSystemPrompt is a wrapper, not a parallel implementation — this is
  // what lets the inspector claim to show the real assembly.
  for (const scratchpad of [false, true]) {
    for (const persona of ['', PERSONA]) {
      const opts = { scratchpad };
      assert.strictEqual(
        buildSystemPrompt(persona, EXPRESSIONS, opts),
        composeSystemPrompt(persona, EXPRESSIONS, opts).text
      );
    }
  }
});

console.log('\n8. Resolution precedence (DB-backed)...');

// Everything above is pure; this section is the one place AP-01 touches the
// database, and it is the part that decides WHOSE prompt a request gets.
const { closeDb } = require('../db/connection');
const dal = require('../db/dal');
const { resolvePromptPreset } = require('../routes/chat');

try {
  const user = dal.createUser({ googleId: `preset-test-${Date.now()}`, email: 'preset@test.local' });
  const other = dal.createUser({ googleId: `preset-other-${Date.now()}`, email: 'other@test.local' });
  const userId = user.id;

  const mk = (name, text) =>
    dal.createPromptPreset(userId, {
      name,
      blocks: { ...defaultBlocks(), blocks: { ...defaultBlocks().blocks, orientation: { enabled: true, text } } },
    });

  const chatPreset = mk('chat', 'CHAT');
  const personaPreset = mk('persona', 'PERSONA');
  const defaultPreset = mk('default', 'DEFAULT');

  const persona = dal.createPersona(userId, {
    name: 'Vela',
    modelConfig: { presetId: personaPreset.id },
  });
  // Deliberately starts bare — the persona (which carries a preset of its own)
  // is attached partway through, so each level can be observed taking over.
  const conv = dal.createConversation(userId, { title: 'presets' });
  const row = () => dal.getConversationMeta(conv.id, userId);
  const orientationOf = (blocks) => (blocks ? normalizeBlocks(blocks).blocks.orientation.text : null);

  check('no pointers anywhere → built-in (null)', () => {
    assert.strictEqual(resolvePromptPreset(userId, row()), null);
  });

  check('the user default applies when nothing overrides it', () => {
    dal.upsertSettings(userId, { defaultPresetId: defaultPreset.id });
    assert.strictEqual(orientationOf(resolvePromptPreset(userId, row())), 'DEFAULT');
  });

  check("the persona's preset beats the user default", () => {
    dal.updateConversation(conv.id, userId, { personaId: persona.id });
    assert.strictEqual(orientationOf(resolvePromptPreset(userId, row())), 'PERSONA');
  });

  check("the conversation's preset beats the persona's", () => {
    dal.updateConversation(conv.id, userId, { presetId: chatPreset.id });
    assert.strictEqual(orientationOf(resolvePromptPreset(userId, row())), 'CHAT');
  });

  check('clearing the conversation override falls back to the persona', () => {
    dal.updateConversation(conv.id, userId, { presetId: null });
    assert.strictEqual(orientationOf(resolvePromptPreset(userId, row())), 'PERSONA');
  });

  check("another user's preset id resolves to the built-in, not their prompt", () => {
    const theirs = dal.createPromptPreset(other.id, { name: 'theirs', blocks: defaultBlocks() });
    assert.ok(dal.getPromptPreset(theirs.id, other.id), 'exists for its owner');
    assert.strictEqual(dal.getPromptPreset(theirs.id, userId), undefined, 'not readable cross-user');
    dal.updateConversation(conv.id, userId, { presetId: theirs.id });
    // Falls through the whole chain rather than leaking the other user's blocks.
    assert.strictEqual(orientationOf(resolvePromptPreset(userId, row())), 'PERSONA');
    dal.updateConversation(conv.id, userId, { presetId: null });
  });

  check('PRESET_NONE on the chat forces the built-in over a persona preset', () => {
    // The persona still points at PERSONA here (set two checks above).
    dal.updateConversation(conv.id, userId, { presetId: PRESET_NONE });
    assert.strictEqual(resolvePromptPreset(userId, row()), null, 'built-in, not the persona preset');
    dal.updateConversation(conv.id, userId, { presetId: null });
    assert.strictEqual(orientationOf(resolvePromptPreset(userId, row())), 'PERSONA', 'and it is reversible');
  });

  check('PRESET_NONE on the persona forces the built-in over the account default', () => {
    dal.updatePersona(persona.id, userId, { modelConfig: { presetId: PRESET_NONE } });
    assert.strictEqual(resolvePromptPreset(userId, row()), null);
    // A chat can still override upward — "none" only stops the walk BELOW it.
    dal.updateConversation(conv.id, userId, { presetId: chatPreset.id });
    assert.strictEqual(orientationOf(resolvePromptPreset(userId, row())), 'CHAT');
    dal.updateConversation(conv.id, userId, { presetId: null });
    dal.updatePersona(persona.id, userId, { modelConfig: { presetId: personaPreset.id } });
  });

  check('deleting a preset clears every pointer at it', () => {
    dal.updateConversation(conv.id, userId, { presetId: chatPreset.id });
    assert.strictEqual(dal.deletePromptPreset(chatPreset.id, userId), true);
    assert.strictEqual(row().preset_id, null, 'conversation pointer cleared');
    dal.deletePromptPreset(defaultPreset.id, userId);
    assert.strictEqual(dal.getSettingsByUser(userId).defaultPresetId, null, 'user default cleared');
  });

  check('an unreadable blocks column degrades to the built-in prompt', () => {
    const broken = dal.createPromptPreset(userId, { name: 'broken', blocks: defaultBlocks() });
    require('../db/connection').getDb()
      .prepare('UPDATE prompt_presets SET blocks = ? WHERE id = ?')
      .run('{not json', broken.id);
    const blocks = dal.getPromptPreset(broken.id, userId).blocks;
    assert.deepStrictEqual(blocks, {}, 'parse failure reads as no overrides');
    assert.strictEqual(
      buildSystemPrompt(PERSONA, [], { preset: blocks }),
      golden({ persona: true }),
      'and still composes the built-in prompt'
    );
  });
} catch (err) {
  console.log(`   ✗ resolution setup failed: ${err.message}`);
  failures++;
} finally {
  closeDb();
}

// --- SS-02: the session-state block is plumbing -----------------------------
console.log('\nSession-state block (SS-02)...');

check('state is a system block, present in a preset that predates it', () => {
  const n = normalizeBlocks({ order: ['orientation', 'expressions', 'scratchpad', 'persona'] });
  assert.ok(n.order.includes('state'), 'an older preset still gets the block');
  assert.ok(SYSTEM_BLOCK_IDS.includes('state'));
});

check('it cannot be turned off', () => {
  const res = validateBlocks({ blocks: { state: { enabled: false } } });
  assert.strictEqual(res.ok, false, 'the write path refuses it');
  assert.match(res.error, /cannot be turned off/);
});

check('it cannot be given text', () => {
  const res = validateBlocks({ blocks: { state: { text: 'my own state line' } } });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /cannot be edited/);
});

check('it may be moved', () => {
  const res = validateBlocks({ order: ['state', 'orientation', 'expressions', 'scratchpad', 'persona'] });
  assert.strictEqual(res.ok, true, 'reordering is the one thing allowed');
});

check('an already-stored enabled:false is ignored rather than obeyed', () => {
  // Defence in depth: validateBlocks guards the write path, but a preset
  // written before that guard (or hand-edited) must not silently blind the
  // model. The composer emits the block regardless.
  const text = buildSystemPrompt(PERSONA, [], {
    preset: { blocks: { state: { enabled: false } } },
    sessionState: '<session_state>\nWorkspace: none\n</session_state>',
  });
  assert.ok(text.includes('<session_state>'), 'still composed into the prompt');
});

check('absent session state skips the block instead of emitting an empty one', () => {
  const text = buildSystemPrompt(PERSONA, [], { preset: {} });
  assert.ok(!text.includes('<session_state>'), 'nothing to report, nothing emitted');
});

check('the preset controls WHERE it lands', () => {
  const state = '<session_state>\nWorkspace: none\n</session_state>';
  const first = buildSystemPrompt(PERSONA, [], {
    preset: { order: ['state', 'orientation', 'expressions', 'scratchpad', 'persona'] },
    sessionState: state,
  });
  assert.ok(first.startsWith('<session_state>'), 'moved to the front');

  const later = buildSystemPrompt(PERSONA, [], {
    preset: { order: ['orientation', 'state', 'expressions', 'scratchpad', 'persona'] },
    sessionState: state,
  });
  assert.ok(!later.startsWith('<session_state>') && later.includes(state), 'and back after orientation');
});

console.log('\n' + '='.repeat(60));
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('All prompt preset tests passed!');
