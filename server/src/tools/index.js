/**
 * Tool Executors (Track A)
 *
 * executeToolCall() dispatches one dispatch-shaped call ({ id, name, input })
 * from a provider's extractToolCalls() to its executor and returns a
 * provider-neutral result { content: string, isError?: boolean } for
 * buildToolResultMessage().
 *
 * All three file tools are implemented (create_file: P2-03; read_file +
 * list_files: P2-04). The tools toggle is off for everyone until the frontend
 * exposes it (P2-05b), so these are unreachable in normal use for now.
 *
 * Executor errors must NEVER break the conversation: the loop converts a
 * thrown error into an isError result so the model can explain the failure.
 *
 * @typedef {Object} ToolContext
 * @property {string} userId
 * @property {Object|null} workspace - workspaces row (destination fallback)
 * @property {Object|null} project - projects row (primary destination)
 * @property {string|null} conversationId
 */

const { logger } = require('../utils/logger');
const { executeCreateFile } = require('./createFile');
const { executeReadFile, executeListFiles } = require('./readFiles');

/**
 * Executor dispatch table. Each entry runs one tool's real work and returns a
 * provider-neutral result { content, isError?, display? }.
 */
const EXECUTORS = {
  create_file: (input, ctx) => executeCreateFile(input, ctx),
  read_file: (input, ctx) => executeReadFile(input, ctx),
  list_files: (input, ctx) => executeListFiles(input, ctx),
};

/**
 * Execute a single tool call.
 * @param {{id: string, name: string, input: Object}} call
 * @param {ToolContext} ctx
 * @returns {Promise<{content: string, isError?: boolean, display?: Object}>}
 */
async function executeToolCall(call, ctx) {
  const executor = EXECUTORS[call.name];
  if (!executor) {
    // A tool name the model hallucinated — tell it rather than crash the turn.
    return {
      content: `Unknown tool "${call.name}". Available tools: ${Object.keys(EXECUTORS).join(', ')}.`,
      isError: true,
    };
  }

  logger.info(
    { userId: ctx.userId, tool: call.name, projectId: ctx.project?.id, workspaceId: ctx.workspace?.id },
    'Tool call'
  );

  return executor(call.input || {}, ctx);
}

module.exports = { executeToolCall };
