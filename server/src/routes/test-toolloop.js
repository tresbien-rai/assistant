/**
 * Tool Loop Test (Track A, P2-02)
 *
 * Exercises runToolLoop against a scripted fake provider that reuses the REAL
 * Anthropic tool-contract functions on Anthropic-shaped fixtures (so message
 * replay is validated against the real extract/build code), plus the
 * server-side tools-toggle resolution (conversation override → persona base →
 * off) against the app DB. No network, no Drive.
 *
 * Run with: node src/routes/test-toolloop.js
 */

const { getDb, closeDb } = require('../db/connection');
const dal = require('../db/dal');
const anthropic = require('../providers/anthropic');
const { runToolLoop, resolveToolsEnabled, resolveRequestContainers } = require('./chat');

let failures = 0;
function check(label, cond) {
  console.log(`   ${cond ? '✓' : '✗'} ${label}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// Fixtures (Anthropic response shapes)
// ---------------------------------------------------------------------------

const toolCallResponse = {
  content: [
    { type: 'text', text: 'Let me create that file.' },
    { type: 'tool_use', id: 'toolu_1', name: 'create_file', input: { filename: 'notes.md', content: 'hi' } },
  ],
  stop_reason: 'tool_use',
  model: 'claude-test',
};

const parallelCallResponse = {
  content: [
    { type: 'tool_use', id: 'toolu_a', name: 'create_file', input: { filename: 'a.md', content: 'A' } },
    { type: 'tool_use', id: 'toolu_b', name: 'list_files', input: {} },
  ],
  stop_reason: 'tool_use',
  model: 'claude-test',
};

const finalResponse = {
  content: [{ type: 'text', text: 'All done!' }],
  stop_reason: 'end_turn',
  model: 'claude-test',
  usage: { input_tokens: 1, output_tokens: 2 },
};

/**
 * Fake provider: chatRaw returns scripted responses in order (throws when a
 * script entry is an Error); the tool contract + result formatting are the
 * REAL anthropic implementations.
 */
function makeFakeProvider(script) {
  const requests = [];
  return {
    requests,
    chatRaw: async (apiKey, params, signal) => {
      requests.push(params);
      const next = script.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    extractToolCalls: anthropic.extractToolCalls,
    buildToolResultMessage: anthropic.buildToolResultMessage,
    formatChatResult: anthropic.formatChatResult,
  };
}

const baseParams = {
  model: 'claude-test',
  messages: [{ role: 'user', content: 'make me a file' }],
  systemPrompt: 'SYS',
  modelParams: { maxTokens: 100 },
};

const toolContext = { userId: 'u1', workspace: null, project: null, conversationId: null };

(async () => {
  console.log('='.repeat(60));
  console.log('Tool Loop Test (P2-02)');
  console.log('='.repeat(60));

  // --- 1. Happy path: tool call → executor → continuation → final ----------
  console.log('\n1. Tool round trip (call → execute → continue → final)...');
  {
    const provider = makeFakeProvider([structuredClone(toolCallResponse), structuredClone(finalResponse)]);
    const out = await runToolLoop({ providerModule: provider, apiKey: 'k', params: { ...baseParams }, toolContext });

    check('final result returned', out.result?.text === 'All done!');
    check('two provider round trips', provider.requests.length === 2);

    const second = provider.requests[1];
    check('tools advertised on every round trip',
      Array.isArray(provider.requests[0].tools) && Array.isArray(second.tools));
    check('prefill never sent when tools on', provider.requests.every((r) => r.prefill === undefined));

    const msgs = second.messages;
    check('continuation appends raw assistant message VERBATIM',
      msgs.length === 3
      && msgs[1].role === 'assistant'
      && msgs[1].content.length === 2
      && msgs[1].content[0].type === 'text'
      && msgs[1].content[1].type === 'tool_use'
      && msgs[1].content[1].id === 'toolu_1');
    check('continuation appends tool_result answering the call id',
      msgs[2].role === 'user' && msgs[2].content[0].type === 'tool_result' && msgs[2].content[0].tool_use_id === 'toolu_1');
    check('stub executor reports unavailable as isError', msgs[2].content[0].is_error === true);

    check('one tool event emitted with filename', out.toolEvents.length === 1
      && out.toolEvents[0].tool === 'create_file'
      && out.toolEvents[0].filename === 'notes.md'
      && out.toolEvents[0].ok === false);
    check('caller messages array not mutated', baseParams.messages.length === 1);
  }

  // --- 2. Parallel calls: all results in ONE continuation message ----------
  console.log('\n2. Parallel calls answered in one message, in order...');
  {
    const provider = makeFakeProvider([structuredClone(parallelCallResponse), structuredClone(finalResponse)]);
    const events = [];
    const out = await runToolLoop({
      providerModule: provider, apiKey: 'k', params: { ...baseParams }, toolContext,
      onEvent: (ev) => events.push(ev),
    });

    const resultMsg = provider.requests[1].messages[2];
    check('single continuation message carries BOTH results',
      resultMsg.content.length === 2
      && resultMsg.content[0].tool_use_id === 'toolu_a'
      && resultMsg.content[1].tool_use_id === 'toolu_b');
    check('events streamed per call, in order',
      events.length === 2 && events[0].tool === 'create_file' && events[1].tool === 'list_files');
    check('final still reached', out.result?.text === 'All done!');
  }

  // --- 3. Abort between provider response and execution --------------------
  console.log('\n3. Abort: no tool executes after the client disconnects...');
  {
    const provider = makeFakeProvider([structuredClone(toolCallResponse)]);
    const ac = new AbortController();
    ac.abort();
    const out = await runToolLoop({
      providerModule: provider, apiKey: 'k', params: { ...baseParams }, toolContext, signal: ac.signal,
    });
    check('reports aborted', out.aborted === true);
    check('no tool events (nothing executed)', out.toolEvents.length === 0);
  }

  // --- 4. AbortError from the provider fetch is a clean abort --------------
  console.log('\n4. AbortError from chatRaw → clean abort...');
  {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const provider = makeFakeProvider([abortErr]);
    const out = await runToolLoop({ providerModule: provider, apiKey: 'k', params: { ...baseParams }, toolContext });
    check('reports aborted', out.aborted === true);
  }

  // --- 5. Max iterations guard ----------------------------------------------
  console.log('\n5. Max-iterations guard throws a provider error...');
  {
    const script = Array.from({ length: 10 }, () => structuredClone(toolCallResponse));
    const provider = makeFakeProvider(script);
    let threw = null;
    try {
      await runToolLoop({ providerModule: provider, apiKey: 'k', params: { ...baseParams }, toolContext });
    } catch (err) {
      threw = err;
    }
    check('throws after the cap', !!threw && /kept calling tools/.test(threw.message));
    check('exactly 5 round trips made', provider.requests.length === 5);
  }

  // --- 6. Toggle resolution: override → persona base → off (DB) ------------
  console.log('\n6. resolveToolsEnabled precedence (DB)...');
  const db = getDb();
  let userId;
  try {
    const user = dal.createUser({ googleId: `tools-test-${Date.now()}`, email: 'tools@test.local' });
    userId = user.id;

    const personaOn = dal.createPersona(userId, { name: 'On', systemPrompt: 's', modelConfig: { toolsEnabled: true } });
    const personaOff = dal.createPersona(userId, { name: 'Off', systemPrompt: 's', modelConfig: {} });

    const inheritOn = dal.createConversation(userId, { personaId: personaOn.id, title: 'a' });
    const inheritOff = dal.createConversation(userId, { personaId: personaOff.id, title: 'b' });
    const forcedOff = dal.createConversation(userId, { personaId: personaOn.id, title: 'c' });
    const forcedOn = dal.createConversation(userId, { personaId: personaOff.id, title: 'd' });
    dal.updateConversation(forcedOff.id, userId, { toolsEnabled: false });
    dal.updateConversation(forcedOn.id, userId, { toolsEnabled: true });

    const metaFor = (id) => dal.getConversationMeta(id, userId);
    check('persona base ON inherited', resolveToolsEnabled(userId, metaFor(inheritOn.id)) === true);
    check('persona base OFF (absent) inherited', resolveToolsEnabled(userId, metaFor(inheritOff.id)) === false);
    check('conversation override OFF beats persona ON', resolveToolsEnabled(userId, metaFor(forcedOff.id)) === false);
    check('conversation override ON beats persona OFF', resolveToolsEnabled(userId, metaFor(forcedOn.id)) === true);
    check('no conversation → off', resolveToolsEnabled(userId, null) === false);

    // Clearing the override restores inheritance (tri-state null).
    dal.updateConversation(forcedOff.id, userId, { toolsEnabled: null });
    check('null override clears back to persona base', resolveToolsEnabled(userId, metaFor(forcedOff.id)) === true);

    // resolveRequestContainers surfaces the conversation row the toggle reads.
    const containers = resolveRequestContainers({ user: { userId }, body: { conversationId: inheritOn.id } });
    check('resolveRequestContainers returns the conversation row', containers.conversation?.id === inheritOn.id);
  } catch (err) {
    console.error('\n✗ Toggle resolution test failed:', err);
    failures++;
  } finally {
    if (userId) db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    closeDb();
  }

  console.log('\n' + '='.repeat(60));
  if (failures === 0) {
    console.log('All tool-loop tests passed!');
  } else {
    console.log(`${failures} assertion(s) FAILED`);
  }
  console.log('='.repeat(60) + '\n');

  process.exit(failures === 0 ? 0 : 1);
})();
