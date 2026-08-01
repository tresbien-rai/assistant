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
const gemini = require('../providers/gemini');
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
    // The REAL one, like the rest of the contract above: the loop builds its
    // round separator through this, so a fake would let a wrong-shaped
    // separator pass unnoticed.
    formatFinalSseEvent: anthropic.formatFinalSseEvent,
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

  // --- 6. streamRaw reassembles the native message from the SSE stream -----
  console.log('\n6. streamRaw: SSE reassembly (text / tool_use / thinking)...');
  {
    // A realistic Anthropic stream: a thinking block with a signature, some
    // narration, then a tool call whose input arrives as JSON fragments.
    const events = [
      { type: 'message_start', message: { model: 'claude-test', usage: { input_tokens: 11 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig123' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Let me ' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'create that.' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'create_file' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"filename":"no' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'tes.md","content":"hi"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 22 } },
      { type: 'message_stop' },
    ];
    const wire = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

    // Split the wire bytes at deliberately awkward points — mid-frame and
    // mid-JSON — so the frame buffering is actually exercised.
    const bytes = Buffer.from(wire, 'utf8');
    const cuts = [17, 140, 400, 620, 900, bytes.length];
    let pos = 0;
    const chunks = cuts.map(c => { const slice = bytes.subarray(pos, c); pos = c; return slice; }).filter(b => b.length);

    const realFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      body: {
        getReader() {
          let i = 0;
          return { read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }) };
        },
      },
    });

    try {
      const forwarded = [];
      const msg = await anthropic.streamRaw(
        'k',
        { model: 'claude-test', messages: [{ role: 'user', content: 'go' }], tools: [] },
        { onDelta: (p) => forwarded.push(p) }
      );

      check('only text deltas are forwarded to the client', forwarded.length === 2);
      check('forwarded verbatim in provider SSE shape',
        forwarded[0].type === 'content_block_delta' && forwarded[0].delta.type === 'text_delta');
      check('forwarded text is in order',
        forwarded.map(p => p.delta.text).join('') === 'Let me create that.');

      const thinking = msg.content.find(b => b.type === 'thinking');
      check('thinking block reassembled', thinking?.thinking === 'pondering');
      check('thinking signature preserved (replay would fail without it)', thinking?.signature === 'sig123');

      const text = msg.content.find(b => b.type === 'text');
      check('text block reassembled', text?.text === 'Let me create that.');

      const toolUse = msg.content.find(b => b.type === 'tool_use');
      check('tool_use input reassembled across JSON fragments',
        toolUse?.input?.filename === 'notes.md' && toolUse?.input?.content === 'hi');
      check('stop_reason captured', msg.stop_reason === 'tool_use');
      check('usage merged from message_start + message_delta',
        msg.usage?.input_tokens === 11 && msg.usage?.output_tokens === 22);

      // The whole point: the reassembled message feeds the REAL extractor.
      const extraction = anthropic.extractToolCalls(msg);
      check('real extractToolCalls finds the streamed call',
        extraction?.calls.length === 1 && extraction.calls[0].name === 'create_file');
    } finally {
      global.fetch = realFetch;
    }
  }

  // --- 7. The loop streams EVERY round, not just the last ------------------
  console.log('\n7. Streaming loop: interstitial text reaches the client...');
  {
    // Two rounds: narration + a tool call, then the final answer. Each round's
    // text is pushed through onDelta the way streamRaw would.
    const rounds = [
      { text: 'Let me create that file.', data: structuredClone(toolCallResponse) },
      { text: 'All done!', data: structuredClone(finalResponse) },
    ];
    const provider = {
      requests: [],
      streamRaw: async (apiKey, params, { onDelta }) => {
        provider.requests.push(params);
        const round = rounds.shift();
        onDelta({ type: 'content_block_delta', delta: { type: 'text_delta', text: round.text } });
        return round.data;
      },
      chatRaw: async () => { throw new Error('chatRaw must not be used when streaming'); },
      extractToolCalls: anthropic.extractToolCalls,
      buildToolResultMessage: anthropic.buildToolResultMessage,
      formatChatResult: anthropic.formatChatResult,
      formatFinalSseEvent: anthropic.formatFinalSseEvent,
    };

    const deltas = [];
    const out = await runToolLoop({
      providerModule: provider, apiKey: 'k', params: { ...baseParams }, toolContext,
      onDelta: (p) => deltas.push(p),
    });

    check('loop reports it already streamed', out.streamed === true);
    check('no final result to re-send', out.result === undefined);
    check('two rounds streamed', provider.requests.length === 2);

    // Read only through Anthropic's shape, for the same reason the Gemini case
    // below does: a separator in the wrong provider's shape must fail here.
    check('every payload is in ANTHROPIC shape, separator included',
      deltas.every(d => d.type === 'content_block_delta' && d.delta?.type === 'text_delta'));
    const streamedText = deltas.map(d => d.delta.text).join('');
    check('pre-tool narration reaches the client (was discarded before)',
      streamedText.includes('Let me create that file.'));
    check('final answer reaches the client', streamedText.includes('All done!'));
    check('rounds separated by a blank line',
      streamedText === 'Let me create that file.\n\nAll done!');
  }

  // --- 8. A provider without streamRaw keeps the one-chunk fallback --------
  console.log('\n8. Fallback: provider without streamRaw still works...');
  {
    const provider = makeFakeProvider([structuredClone(toolCallResponse), structuredClone(finalResponse)]);
    const deltas = [];
    const out = await runToolLoop({
      providerModule: provider, apiKey: 'k', params: { ...baseParams }, toolContext,
      onDelta: (p) => deltas.push(p),
    });
    check('falls back to non-streaming', !out.streamed);
    check('nothing streamed mid-loop', deltas.length === 0);
    check('final result still returned for the one-chunk path', out.result?.text === 'All done!');
  }

  // --- 9. formatChatResult joins every text block --------------------------
  console.log('\n9. formatChatResult keeps text after the first block...');
  {
    const withThinking = {
      content: [
        { type: 'text', text: 'First. ' },
        { type: 'thinking', thinking: 'hmm', signature: 's' },
        { type: 'text', text: 'Second.' },
      ],
      model: 'claude-test',
      stop_reason: 'end_turn',
    };
    check('all text blocks joined (find() dropped the tail)',
      anthropic.formatChatResult(withThinking).text === 'First. Second.');
  }

  // --- 10. Gemini streamRaw reassembles its own native shape --------------
  console.log('\n10. Gemini streamRaw: SSE reassembly (text / functionCall)...');
  {
    // Gemini differs from Anthropic in shape: every payload is a COMPLETE
    // GenerateContentResponse whose parts are the increment, and a functionCall
    // arrives whole (no input_json_delta equivalent).
    const frames = [
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Let me ' }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: 'create that.' }] } }] },
      // A thought signature must NOT be merged away — it has to replay verbatim.
      { candidates: [{ content: { role: 'model', parts: [{ text: 'hmm', thoughtSignature: 'sig-abc' }] } }] },
      { candidates: [{ content: { role: 'model', parts: [
        { functionCall: { name: 'create_file', args: { filename: 'notes.md', content: 'hi' } } },
      ] } }] },
      { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22, totalTokenCount: 33 } },
    ];
    // CRLF, because that is what Google actually sends. This fixture used to
    // join with a bare `\n\n`; it therefore built a wire the real API never
    // produces, and could not catch that streamRaw's frame separator missed
    // `\r\n\r\n` entirely — the turn returned 200 with an empty parts array
    // and the client rendered nothing. Assertions were never the weak link
    // here; the fixture was. Keep this in the provider's real shape.
    const wire = frames.map((f) => `data: ${JSON.stringify(f)}\r\n\r\n`).join('');
    const bytes = Buffer.from(wire, 'utf8');
    const cuts = [23, 150, 380, 600, bytes.length];
    let pos = 0;
    const chunks = cuts.map((c) => { const s = bytes.subarray(pos, c); pos = c; return s; }).filter((b) => b.length);

    const realFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      body: { getReader() { let i = 0; return { read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }) }; } },
    });

    try {
      const forwarded = [];
      const msg = await gemini.streamRaw(
        'k',
        { model: 'gemini-test', messages: [{ role: 'user', content: 'go' }], tools: [] },
        { onDelta: (p) => forwarded.push(p) }
      );
      const parts = msg.candidates[0].content.parts;

      check('renderable chunks forwarded, bare functionCall/usage frames are not', forwarded.length === 3);
      check('adjacent plain-text parts merged into one',
        parts[0].text === 'Let me create that.');
      check('a part carrying a thoughtSignature is NOT merged away',
        parts.some((p) => p.thoughtSignature === 'sig-abc'));
      check('functionCall part preserved whole',
        parts.some((p) => p.functionCall?.args?.filename === 'notes.md'));
      check('finishReason latched from a later frame', msg.candidates[0].finishReason === 'STOP');
      check('usageMetadata latched', msg.usageMetadata?.totalTokenCount === 33);

      // Same proof as the Anthropic case: the REAL extractor consumes it.
      const extraction = gemini.extractToolCalls(msg);
      check('real extractToolCalls finds the streamed call',
        extraction?.calls.length === 1 && extraction.calls[0].name === 'create_file');
      check('formatChatResult reads the reassembled text',
        gemini.formatChatResult(msg, 'gemini-test').text === 'Let me create that.hmm');
    } finally {
      global.fetch = realFetch;
    }
  }

  // --- 11. Both providers now stream every round --------------------------
  console.log('\n11. The loop streams for Gemini too...');
  {
    const rounds = [
      { text: 'Reading it now.', data: { candidates: [{ content: { role: 'model', parts: [
        { functionCall: { name: 'create_file', args: { filename: 'a.md', content: 'A' } } },
      ] } }] } },
      { text: 'All done!', data: { candidates: [{ content: { role: 'model', parts: [{ text: 'All done!' }] } }] } },
    ];
    const provider = {
      requests: [],
      streamRaw: async (apiKey, params, { onDelta }) => {
        provider.requests.push(params);
        const round = rounds.shift();
        onDelta({ candidates: [{ content: { role: 'model', parts: [{ text: round.text }] } }] });
        return round.data;
      },
      chatRaw: async () => { throw new Error('chatRaw must not be used when streaming'); },
      extractToolCalls: gemini.extractToolCalls,
      buildToolResultMessage: gemini.buildToolResultMessage,
      formatChatResult: gemini.formatChatResult,
      formatFinalSseEvent: gemini.formatFinalSseEvent,
    };

    const deltas = [];
    const out = await runToolLoop({
      providerModule: provider, apiKey: 'k', params: { ...baseParams }, toolContext,
      onDelta: (p) => deltas.push(p),
    });

    check('loop reports it streamed', out.streamed === true);
    check('two rounds streamed', provider.requests.length === 2);

    // Read ONLY through Gemini's own shape. Reading either shape is what let a
    // real bug through: the round separator used to be hardcoded as Anthropic's
    // content_block_delta, which the Gemini client silently ignores, so the two
    // rounds ran together with no blank line and the test still passed.
    const geminiText = (d) => (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    const text = deltas.map(geminiText).join('');
    check('every payload is in GEMINI shape, separator included',
      deltas.every((d) => Array.isArray(d.candidates)));
    check('pre-tool narration reaches the client', text.includes('Reading it now.'));
    check('final answer reaches the client', text.includes('All done!'));
    check('rounds separated by a blank line', text === 'Reading it now.\n\nAll done!');
  }

  // --- 12. Toggle resolution: override → persona base → off (DB) -----------
  console.log('\n12. resolveToolsEnabled precedence (DB)...');
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
