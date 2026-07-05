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

const { TOOL_DEFINITIONS } = require('./definitions');
const { logger } = require('../utils/logger');

const KNOWN_TOOLS = new Set(TOOL_DEFINITIONS.map((t) => t.name));

/**
 * Execute a single tool call.
 * @param {{id: string, name: string, input: Object}} call
 * @param {ToolContext} ctx
 * @returns {Promise<{content: string, isError?: boolean}>}
 */
async function executeToolCall(call, ctx) {
  if (!KNOWN_TOOLS.has(call.name)) {
    // The model hallucinated a tool name; tell it rather than crash the turn.
    return { content: `Unknown tool: ${call.name}`, isError: true };
  }

  logger.info(
    { userId: ctx.userId, tool: call.name, projectId: ctx.project?.id, workspaceId: ctx.workspace?.id },
    'Tool call'
  );

  // P2-03/P2-04 replace this with real executors (Drive I/O + DAL records).
  return {
    content: `The ${call.name} tool is not available yet. Tell the user file tools are still being set up.`,
    isError: true,
  };
}

module.exports = { executeToolCall };
