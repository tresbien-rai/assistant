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
 *
 * SCOPE-NEUTRAL WORDING (SS-04, docs/SESSION_STATE_DESIGN.md D4). These
 * descriptions used to assert a container — "the current project or workspace"
 * — on every read and write. The tool list is deliberately STABLE (advertised
 * whether or not the chat has a container, so it cannot churn mid-conversation
 * or between turns), which meant a bare chat was told about project files that
 * could not exist, and invited to talk about them.
 *
 * A description now says what the tool DOES and leaves what EXISTS to the
 * `<session_state>` block, which reports the real containers, counts and
 * absences every turn. One consequence worth keeping: nothing here should
 * describe the state of the world, only the operation.
 */

const TOOL_DEFINITIONS = [
  {
    name: 'create_file',
    description:
      "Create a text file for the user. It is saved automatically in the scope this chat belongs to — you never choose a location. An existing file of the same name in that scope is overwritten; to change part of a file, prefer edit_file, which does not resend the whole content. Text formats only (markdown, code, csv, json and similar). Returns the saved name and a download link you can use in your reply.",
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
      "Change part of an existing text file without resending it. old_text must match the current content exactly, including whitespace and line breaks, and must appear exactly once unless replace_all is true — include enough surrounding context to make it unique. Read the file first if you are unsure of its exact current content. Reports how many places changed and the size before and after, so you can confirm the edit landed without reading it back.",
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
      "Read a file's text content. Searches the scopes this chat can reach, so you only need the name. Works for text files and PDFs. A file whose content is already shown to you does not need reading again; use list_files if you are unsure of the exact name.",
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
      "List the files this chat can reach, with each one's name, type and size. The session state already tells you how many there are and where they live, so call this when you need the actual names.",
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'move_file',
    description:
      "Move a file to a different scope — mainly to PROMOTE a file made in this chat into the shared knowledge base, so it outlives the conversation. The content is unchanged; only where it lives (and its download link) changes, and a same-name file in the destination is overwritten. The session state lists the containers this chat actually has; a destination it does not have is rejected.",
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
      "Replace the ENTIRE contents of the shared scratchpad — the space you and the user develop ideas in, alongside the chat. This is where the work itself belongs: premises, cast, outlines, structure. Rewrite, reorganize and trim it in place. The pad holds the CURRENT STATE of your shared thinking, not a growing log — delete what has been superseded rather than piling new on top of old. Pass the complete new contents (an empty string clears it); the user sees the change as a diff. An empty pad is a normal starting point, not a reason to wait. Keep the pad as the clean artifact and use your reply to say what you changed and why. If it grows past working size, save it as a file instead.",
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
      "Change PART of the scratchpad without rewriting all of it. old_text must match the current pad content exactly, including whitespace and line breaks, and appear exactly once unless replace_all is true; new_text may be empty to delete the snippet. Use this for a surgical change to a larger pad, and write_scratchpad when reworking most of it. Reports how many places changed and the length before and after, so you can confirm the edit without re-reading the pad.",
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
