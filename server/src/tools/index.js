/**
 * Tool Executors (Track A)
 *
 * executeToolCall() dispatches one dispatch-shaped call ({ id, name, input })
 * from a provider's extractToolCalls() to its executor and returns a
 * provider-neutral result { content: string, isError?: boolean } for
 * buildToolResultMessage().
 *
 * File tools: create_file (P2-03), read_file + list_files (P2-04), and
 * edit_file (edit-in-context slice 2). Reachable when the conversation's
 * file-tools toggle is on (persona base + per-conversation override).
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
const { executeEditFile } = require('./editFile');
const { executeReadFile, executeListFiles } = require('./readFiles');
const { executeMoveFile } = require('./moveFile');

/**
 * Executor dispatch table. Each entry runs one tool's real work and returns a
 * provider-neutral result { content, isError?, display? }.
 */
const EXECUTORS = {
  create_file: (input, ctx) => executeCreateFile(input, ctx),
  edit_file: (input, ctx) => executeEditFile(input, ctx),
  read_file: (input, ctx) => executeReadFile(input, ctx),
  list_files: (input, ctx) => executeListFiles(input, ctx),
  move_file: (input, ctx) => executeMoveFile(input, ctx),
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
