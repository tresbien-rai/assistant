/**
 * Cache-prefix stability test (PC-01, docs/PROMPT_CACHING_DESIGN.md §4)
 *
 * Prompt caching is a prefix match: the provider serves the leading bytes of a
 * request from cache only when they are IDENTICAL to the bytes it cached last
 * time. Everything after the first changed byte is re-processed at full price.
 *
 * Which makes this the rare feature whose failure is completely silent. Nothing
 * throws, no response changes, no log line appears — the bill is just higher.
 * And the shape it fails in is a regression months later, not a bad first
 * implementation: someone adds a field to the system prompt, or a helper starts
 * rewriting history, and the cache quietly stops being read.
 *
 * So this asserts on BYTES, through the real assembly, not on shape through a
 * reimplementation. Two lessons from the 2026-07-31 handoff are behind that:
 * a fixture modelling the wrong wire shape cannot detect a wire-shape error
 * (#170, #171), and a test that re-derives its expectation from the code under
 * test agrees with itself while the feature is broken.
 *
 * The two guarantees:
 *
 *   1. `system` does not move a byte when session state changes. It carries the
 *      scratchpad's length and the file counts, which the model changes by
 *      doing its job — and a system change invalidates the message cache behind
 *      it, so this one failing costs the WHOLE conversation, every turn.
 *
 *   2. The message prefix ahead of the newest turn is reproduced exactly on the
 *      next turn. That prefix is what a breakpoint can actually read back
 *      (§2.2): each user message is augmented on its own turn only, and is bare
 *      forever after.
 *
 * Runs against the app DB and cleans up after itself.
 *
 * Run with: node src/routes/test-cacheprefix.js
 */

const assert = require('node:assert');
const { closeDb } = require('../db/connection');
const dal = require('../db/dal');
const { assembleChatRequest, resolveRequestContainers } = require('./chat');

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

const reqFor = (userId, body) => ({ user: { userId }, body });

/** Render the assembled messages the way a provider would see them, as bytes. */
function renderMessages(messages) {
  return messages.map((m) => {
    const content = typeof m.content === 'string'
      ? m.content
      : JSON.stringify(m.content);
    return `${m.role} ${content}`;
  });
}

(async () => {
  console.log('='.repeat(60));
  console.log('Cache-prefix stability (PC-01)');
  console.log('='.repeat(60));

  let userId;
  try {
    const user = dal.createUser({ googleId: `pc1-${Date.now()}`, email: 'pc1@test.local' });
    userId = user.id;
    const persona = dal.createPersona(userId, {
      name: 'Vela',
      systemPrompt: 'You are Vela, a terse navigator.',
    });
    const conversation = dal.createConversation(userId, {
      personaId: persona.id,
      title: 'cache prefix',
    });
    // Scratchpad on, so session state has something that actually churns.
    dal.updateConversation(conversation.id, userId, { scratchpadEnabled: true });
    dal.ensureScratchpad(conversation.id);

    const assemble = async (messages) => {
      const body = { conversationId: conversation.id, messages };
      const req = reqFor(userId, body);
      return assembleChatRequest(req, resolveRequestContainers(req), {
        systemPrompt: 'You are Vela, a terse navigator.',
        messages,
        expressionNames: ['neutral', 'happy'],
        model: 'claude-opus-5',
      });
    };

    // --- Guarantee 1: session state must not touch the system prompt --------
    console.log('\nThe system prompt is frozen against session state...');

    const turn1 = [{ role: 'user', content: 'Plot a course.' }];

    dal.updateScratchpadContent(conversation.id, '');
    const empty = await assemble(turn1);

    dal.updateScratchpadContent(conversation.id, 'x'.repeat(4918));
    const full = await assemble(turn1);

    check('a 4,918-character scratchpad moves no byte of `system`', () => {
      assert.strictEqual(empty.system, full.system);
    });

    check('and session state is genuinely different between the two', () => {
      // Guards the guard: if state stopped varying, guarantee 1 would pass
      // vacuously and this test would be worthless.
      assert.notStrictEqual(
        empty.promptOptions.sessionState,
        full.promptOptions.sessionState,
        'the two assemblies must actually differ in state'
      );
    });

    check('`<session_state>` is in the messages, exactly once, not in `system`', () => {
      assert.ok(!String(full.system).includes('<session_state>'), 'absent from system');
      const rendered = renderMessages(full.messages).join('\n');
      const hits = rendered.split('<session_state>').length - 1;
      assert.strictEqual(hits, 1, `expected one state block in messages, found ${hits}`);
    });

    check('it rides on the LAST user message, not a turn of its own', () => {
      const last = full.messages[full.messages.length - 1];
      assert.strictEqual(last.role, 'user');
      const content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
      assert.ok(content.includes('<session_state>'));
    });

    // --- Guarantee 2: the history ahead of the newest turn is reproduced ----
    console.log('\nThe message prefix survives into the next turn...');

    const turn2 = [
      { role: 'user', content: 'Plot a course.' },
      { role: 'assistant', content: 'Heading 041, mark.' },
      { role: 'user', content: 'Now hold it.' },
    ];

    // The model wrote to the pad during turn 1 — the realistic case, and the
    // one that used to invalidate everything.
    dal.updateScratchpadContent(conversation.id, 'course: 041\nspeed: 12kn');
    const second = await assemble(turn2);

    check('every message before the newest turn is byte-identical', () => {
      const before = renderMessages(full.messages);
      const after = renderMessages(second.messages);
      // Turn 1's own trailing user message is the volatile tail; the cacheable
      // prefix is everything ahead of it. On turn 2 that same region must
      // reappear unchanged.
      const shared = before.length - 1;
      assert.deepStrictEqual(
        after.slice(0, shared),
        before.slice(0, shared),
        'the reusable prefix was rewritten'
      );
    });

    check('the newest turn is where the divergence starts, and nowhere earlier', () => {
      const before = renderMessages(full.messages);
      const after = renderMessages(second.messages);
      let i = 0;
      while (i < before.length && i < after.length && before[i] === after[i]) i++;
      assert.strictEqual(
        i,
        before.length - 1,
        `divergence at index ${i}, expected ${before.length - 1} (the augmented last user turn)`
      );
    });

    check('`system` is unchanged across the two turns as well', () => {
      assert.strictEqual(second.system, full.system);
    });

  } catch (err) {
    console.log(`   ✗ setup failed: ${err.message}`);
    console.log(err.stack);
    failures++;
  } finally {
    if (userId) {
      try { dal.deleteUser(userId); } catch { /* best effort */ }
    }
    closeDb();
  }

  console.log('\n' + '='.repeat(60));
  if (failures > 0) {
    console.log(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('All cache-prefix tests passed!');
  console.log('='.repeat(60));
})();
