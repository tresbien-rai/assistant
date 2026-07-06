/**
 * Tool Executors (Track A)
 *
 * executeToolCall() dispatches one dispatch-shaped call ({ id, name, input })
 * from a provider's extractToolCalls() to its executor and returns a
 * provider-neutral result { content: string, isError?: boolean } for
 * buildToolResultMessage().
 *
 * P2-02 ships STUBS so the loop can land first — every tool reports itself
 * unavailable (isError, which the model relays gracefully). P2-03 implements
 * create_file; P2-04 implements read_file + list_files. The tools toggle is
 * off for everyone until the frontend exposes it (P2-05b), so the stubs are
 * unreachable in normal use.
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

/**
 * Executor dispatch table. Each entry runs one tool's real work and returns a
 * provider-neutral result. read_file + list_files land in P2-04; until then
 * they fall through to the not-implemented stub below.
 */
const EXECUTORS = {
  create_file: (input, ctx) => executeCreateFile(input, ctx),
  // read_file / list_files: P2-04.
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
    // Either an as-yet-unimplemented tool (read_file/list_files) or a name the
    // model hallucinated — tell it rather than crash the turn.
    return {
      content: `The "${call.name}" tool is not available yet. Tell the user this capability is still being set up.`,
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
