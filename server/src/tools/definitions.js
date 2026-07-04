/**
 * Tool Definitions (Track A, P2-01)
 *
 * The file tools the model can call mid-conversation, defined ONCE in a
 * provider-neutral shape. The neutral shape is Anthropic's tools format
 * (name / description / input_schema, where input_schema is plain JSON
 * Schema); each provider translates it via its formatTools() —
 * Anthropic: pass-through; Gemini: functionDeclarations with proto-enum
 * types. See "Decisions" in docs/PHASE2_TASKS.md.
 *
 * No execution lives here — executors land in P2-03/P2-04, and the chat
 * loop (P2-02) advertises these only when the tools toggle is on.
 *
 * Description notes the model relies on:
 * - create_file OVERWRITES an existing file with the same name in the
 *   destination scope (decision 6), so the model can iterate on a file.
 * - Only text-based content is supported in v1 (content is a JSON string).
 * - Destination (project / workspace / Downloads) is implicit from the
 *   conversation — the model never chooses a path.
 */

const TOOL_DEFINITIONS = [
  {
    name: 'create_file',
    description:
      "Create a text file for the user, saved to their Google Drive in the current project or workspace folder (or their Downloads folder when the chat is not in a project). If a file with the same name already exists there, it is overwritten — use this to update files you created earlier. Only text-based files are supported (code, markdown, csv, json, and similar; no binary formats). Returns the saved file's name and a download link you can reference in your reply.",
    input_schema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description:
            'File name including a text-type extension, e.g. "notes.md", "report.txt", or "data.csv". No folders or path separators.',
        },
        content: {
          type: 'string',
          description: 'The complete text content of the file.',
        },
        mime_type: {
          type: 'string',
          description:
            'Optional MIME type, e.g. "text/markdown". Inferred from the file extension when omitted.',
        },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'read_file',
    description:
      "Read the text content of a file from the current project or workspace (or the user's Downloads folder when the chat is not in a project). Works for text files and PDFs. Use list_files first if you are unsure of the exact name.",
    input_schema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Exact file name as shown by list_files.',
        },
      },
      required: ['filename'],
    },
  },
  {
    name: 'list_files',
    description:
      'List the files available in the current project or workspace (or the Downloads folder when the chat is not in a project), with each file\'s name, type, and size.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

module.exports = { TOOL_DEFINITIONS };
