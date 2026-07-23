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
      "Create a text file for the user, saved to their Google Drive in the current project or workspace folder (or their Downloads folder when the chat is not in a project). If a file with the same name already exists there, it is overwritten — but for changing part of an existing file, prefer edit_file, which does not require resending the whole content. Only text-based files are supported (code, markdown, csv, json, and similar; no binary formats). Returns the saved file's name and a download link you can reference in your reply.",
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
    name: 'edit_file',
    description:
      "Edit an existing text file by replacing an exact snippet of its current content, without resending the whole file. old_text must match the file's current content exactly (including whitespace and line breaks) and, unless replace_all is true, must appear exactly once — include enough surrounding context to make it unique. Use read_file first if you are unsure of the exact current content. Returns the updated file's name and download link.",
    input_schema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Exact file name as shown by list_files, e.g. "notes.md".',
        },
        old_text: {
          type: 'string',
          description: 'The exact text to replace, copied verbatim from the current file content.',
        },
        new_text: {
          type: 'string',
          description: 'The replacement text. May be empty to delete old_text.',
        },
        replace_all: {
          type: 'boolean',
          description: 'Replace every occurrence of old_text instead of requiring it to be unique. Default false.',
        },
      },
      required: ['filename', 'old_text', 'new_text'],
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
  {
    name: 'move_file',
    description:
      "Move a file into a different scope — mainly to PROMOTE a file created in this chat into the shared knowledge base so it persists beyond the conversation. Use \"project\" or \"workspace\" to add a chat file to the shared files, or \"downloads\" to save it to the user's Downloads folder. The file keeps its content; it just changes where it lives (and its download link). A same-name file already in the destination is overwritten. Only destinations the chat can reach are valid (e.g. \"project\" only from a project chat).",
    input_schema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Exact file name as shown by list_files, e.g. "notes.md".',
        },
        destination: {
          type: 'string',
          enum: ['project', 'workspace', 'downloads'],
          description: 'Where to move the file: "project" or "workspace" to promote it into the shared files, or "downloads" for the user\'s Downloads folder.',
        },
      },
      required: ['filename', 'destination'],
    },
  },
];

/**
 * Scratchpad tools (docs/SCRATCHPAD_DESIGN.md). Defined SEPARATELY from the file
 * tools because they are gated independently: the scratchpad toggle advertises
 * these regardless of whether the file-tools toggle is on (Decision 3).
 *
 * The descriptions carry the CHURN principle (Decision 6 / the defining
 * principle) — replace/overwrite in place, do not append or let it grow. This is
 * the first line of the prompt-engineering that SP-05 tunes further.
 */
const SCRATCHPAD_TOOL_DEFINITIONS = [
  {
    name: 'write_scratchpad',
    description:
      "Replace the ENTIRE contents of the shared scratchpad — a space you and the user think in together, alongside the chat. Use it to develop ideas in place: rewrite, reorganize, trim, and REPLACE what is there. The scratchpad holds the current state of your shared thinking, NOT a growing log — delete superseded ideas rather than piling new ones on top of old ones, so it stays focused and small. This overwrites everything currently in the scratchpad; pass the complete new contents (or an empty string to clear it). The user sees your change as a diff. Prefer discussing your reasoning in your chat reply while keeping the scratchpad as the clean, current artifact.",
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The complete new contents of the scratchpad. Replaces everything currently in it. Empty string clears it.',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'edit_scratchpad',
    description:
      "Make a targeted change to PART of the scratchpad without rewriting the whole thing. Replaces an exact snippet (old_text — must match the current scratchpad content exactly, including whitespace and line breaks, and appear exactly once unless replace_all is true) with new_text. Prefer write_scratchpad when reworking most of the content; use this for a small, surgical change to a larger scratchpad. new_text may be empty to delete the snippet.",
    input_schema: {
      type: 'object',
      properties: {
        old_text: {
          type: 'string',
          description: 'The exact text to replace, copied verbatim from the current scratchpad content.',
        },
        new_text: {
          type: 'string',
          description: 'The replacement text. May be empty to delete old_text.',
        },
        replace_all: {
          type: 'boolean',
          description: 'Replace every occurrence of old_text instead of requiring it to be unique. Default false.',
        },
      },
      required: ['old_text', 'new_text'],
    },
  },
];

module.exports = { TOOL_DEFINITIONS, SCRATCHPAD_TOOL_DEFINITIONS };
