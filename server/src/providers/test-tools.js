/**
 * Tool Contract Tests (Track A, P2-01)
 *
 * Headless assertions over the provider tool contract: tools/definitions.js
 * plus formatTools / extractToolCalls / buildToolResultMessage in both
 * provider modules, and the `tools` + raw-message threading through
 * buildRequestBody. Pure unit tests — no network, no DB.
 *
 * Run: node src/providers/test-tools.js (part of `npm test`).
 */

const assert = require('node:assert');

const { TOOL_DEFINITIONS } = require('../tools/definitions');
const anthropic = require('./anthropic');
const gemini = require('./gemini');

let failures = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`   ✓ ${label}`);
  } catch (err) {
    failures++;
    console.error(`   ✗ ${label}`);
    console.error(`     ${err.message}`);
  }
}

console.log('='.repeat(60));
console.log('Tool Contract Test (P2-01)');
console.log('='.repeat(60));

// ---------------------------------------------------------------------------
console.log('\n1. Definitions sanity...');

check('three tools defined: create_file, read_file, list_files', () => {
  assert.deepStrictEqual(
    TOOL_DEFINITIONS.map((t) => t.name),
    ['create_file', 'read_file', 'list_files']
  );
});

check('every tool has description + object input_schema', () => {
  for (const t of TOOL_DEFINITIONS) {
    assert.ok(t.description.length > 20, `${t.name} description too short`);
    assert.strictEqual(t.input_schema.type, 'object');
  }
});

check('create_file requires filename + content', () => {
  const cf = TOOL_DEFINITIONS[0];
  assert.deepStrictEqual(cf.input_schema.required, ['filename', 'content']);
});

// ---------------------------------------------------------------------------
console.log('\n2. Anthropic formatTools + buildRequestBody threading...');

check('formatTools passes the native shape through', () => {
  const tools = anthropic.formatTools(TOOL_DEFINITIONS);
  assert.strictEqual(tools.length, 3);
  assert.strictEqual(tools[0].name, 'create_file');
  assert.strictEqual(tools[0].input_schema.properties.filename.type, 'string');
});

check('buildRequestBody includes tools when passed, omits otherwise', () => {
  const base = { model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] };
  const withTools = anthropic.buildRequestBody({ ...base, tools: TOOL_DEFINITIONS });
  assert.strictEqual(withTools.tools.length, 3);
  const without = anthropic.buildRequestBody(base);
  assert.strictEqual(without.tools, undefined);
});

check('raw assistant message (content blocks) passes through verbatim', () => {
  const raw = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'hmm', signature: 'sig123' },
      { type: 'tool_use', id: 'tu_1', name: 'list_files', input: {} },
    ],
  };
  const body = anthropic.buildRequestBody({
    model: 'claude-x',
    messages: [{ role: 'user', content: 'hi' }, raw],
  });
  assert.deepStrictEqual(body.messages[1].content, raw.content);
});

// ---------------------------------------------------------------------------
console.log('\n3. Anthropic extractToolCalls (incl. thinking + parallel)...');

const anthropicResponse = {
  content: [
    { type: 'thinking', thinking: 'let me create both files', signature: 'sig-abc' },
    { type: 'text', text: 'Creating the files now.' },
    { type: 'tool_use', id: 'toolu_01', name: 'create_file', input: { filename: 'a.md', content: '# A' } },
    { type: 'tool_use', id: 'toolu_02', name: 'create_file', input: { filename: 'b.md', content: '# B' } },
  ],
  stop_reason: 'tool_use',
};

check('extracts parallel calls in dispatch shape', () => {
  const { calls } = anthropic.extractToolCalls(anthropicResponse);
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls[0], {
    id: 'toolu_01', name: 'create_file', input: { filename: 'a.md', content: '# A' },
  });
});

check('rawAssistantMessage preserves ALL blocks incl. thinking signature', () => {
  const { rawAssistantMessage } = anthropic.extractToolCalls(anthropicResponse);
  assert.strictEqual(rawAssistantMessage.role, 'assistant');
  assert.strictEqual(rawAssistantMessage.content.length, 4);
  assert.strictEqual(rawAssistantMessage.content[0].signature, 'sig-abc');
});

check('returns null when there are no tool calls', () => {
  assert.strictEqual(
    anthropic.extractToolCalls({ content: [{ type: 'text', text: 'done' }] }),
    null
  );
});

check('buildToolResultMessage pairs results by call id, flags errors', () => {
  const { calls } = anthropic.extractToolCalls(anthropicResponse);
  const msg = anthropic.buildToolResultMessage(calls, [
    { content: 'Created a.md' },
    { content: 'Disk full', isError: true },
  ]);
  assert.strictEqual(msg.role, 'user');
  assert.strictEqual(msg.content.length, 2);
  assert.strictEqual(msg.content[0].type, 'tool_result');
  assert.strictEqual(msg.content[0].tool_use_id, 'toolu_01');
  assert.strictEqual(msg.content[0].is_error, undefined);
  assert.strictEqual(msg.content[1].tool_use_id, 'toolu_02');
  assert.strictEqual(msg.content[1].is_error, true);
});

// ---------------------------------------------------------------------------
console.log('\n4. Gemini formatTools + buildRequestBody threading...');

check('formatTools emits functionDeclarations with proto-enum types', () => {
  const tools = gemini.formatTools(TOOL_DEFINITIONS);
  assert.strictEqual(tools.length, 1);
  const decls = tools[0].functionDeclarations;
  assert.strictEqual(decls.length, 3);
  assert.strictEqual(decls[0].parameters.type, 'OBJECT');
  assert.strictEqual(decls[0].parameters.properties.filename.type, 'STRING');
  assert.deepStrictEqual(decls[0].parameters.required, ['filename', 'content']);
});

check('no-argument tool (list_files) omits parameters entirely', () => {
  const decls = gemini.formatTools(TOOL_DEFINITIONS)[0].functionDeclarations;
  const listFiles = decls.find((d) => d.name === 'list_files');
  assert.strictEqual(listFiles.parameters, undefined);
});

check('buildRequestBody includes tools when passed, omits otherwise', () => {
  const base = { model: 'gemini-x', messages: [{ role: 'user', content: 'hi' }] };
  const withTools = gemini.buildRequestBody({ ...base, tools: TOOL_DEFINITIONS });
  assert.strictEqual(withTools.tools[0].functionDeclarations.length, 3);
  const without = gemini.buildRequestBody(base);
  assert.strictEqual(without.tools, undefined);
});

check('native parts messages pass through verbatim (thoughtSignature kept)', () => {
  const rawModel = {
    role: 'model',
    parts: [
      { functionCall: { name: 'list_files', args: {} }, thoughtSignature: 'ts-xyz' },
    ],
  };
  const fnResponse = {
    role: 'user',
    parts: [{ functionResponse: { name: 'list_files', response: { output: '[]' } } }],
  };
  const body = gemini.buildRequestBody({
    model: 'gemini-x',
    messages: [{ role: 'user', content: 'hi' }, rawModel, fnResponse],
  });
  assert.strictEqual(body.contents[1].role, 'model');
  assert.deepStrictEqual(body.contents[1].parts, rawModel.parts);
  assert.strictEqual(body.contents[1].parts[0].thoughtSignature, 'ts-xyz');
  assert.strictEqual(body.contents[2].role, 'user');
  assert.deepStrictEqual(body.contents[2].parts, fnResponse.parts);
});

// ---------------------------------------------------------------------------
console.log('\n5. Gemini extractToolCalls (incl. thoughtSignature + parallel)...');

const geminiResponse = {
  candidates: [{
    content: {
      role: 'model',
      parts: [
        { text: 'Let me check the files.' },
        { functionCall: { name: 'list_files', args: {} }, thoughtSignature: 'ts-1' },
        { functionCall: { name: 'read_file', args: { filename: 'spec.md' } } },
      ],
    },
    finishReason: 'STOP',
  }],
};

check('extracts parallel calls with synthetic ids', () => {
  const { calls } = gemini.extractToolCalls(geminiResponse);
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls[0], { id: 'list_files_1', name: 'list_files', input: {} });
  assert.deepStrictEqual(calls[1], { id: 'read_file_2', name: 'read_file', input: { filename: 'spec.md' } });
});

check('rawAssistantMessage preserves parts incl. thoughtSignature', () => {
  const { rawAssistantMessage } = gemini.extractToolCalls(geminiResponse);
  assert.strictEqual(rawAssistantMessage.role, 'model');
  assert.strictEqual(rawAssistantMessage.parts.length, 3);
  assert.strictEqual(rawAssistantMessage.parts[1].thoughtSignature, 'ts-1');
});

check('returns null when there are no function calls', () => {
  assert.strictEqual(
    gemini.extractToolCalls({ candidates: [{ content: { parts: [{ text: 'done' }] } }] }),
    null
  );
});

check('buildToolResultMessage answers by function name, error variant wraps', () => {
  const { calls } = gemini.extractToolCalls(geminiResponse);
  const msg = gemini.buildToolResultMessage(calls, [
    { content: 'a.md, b.md' },
    { content: 'File not found', isError: true },
  ]);
  assert.strictEqual(msg.role, 'user');
  assert.strictEqual(msg.parts.length, 2);
  assert.deepStrictEqual(msg.parts[0].functionResponse, {
    name: 'list_files', response: { output: 'a.md, b.md' },
  });
  assert.deepStrictEqual(msg.parts[1].functionResponse, {
    name: 'read_file', response: { error: 'File not found' },
  });
});

// ---------------------------------------------------------------------------
console.log('');
if (failures > 0) {
  console.error(`${failures} tool-contract test(s) FAILED`);
  process.exit(1);
}
console.log('='.repeat(60));
console.log('All tool-contract tests passed!');
console.log('='.repeat(60));
