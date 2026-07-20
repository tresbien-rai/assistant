/**
 * edit_file Executor (edit-in-context slice 2)
 *
 * Replaces an exact snippet of an existing file's content, so the model can
 * revise a file without resending the whole thing (fewer tokens, no
 * re-transcription errors).
 *
 * Semantics:
 * - The file is found across the conversation's READ stores (same search
 *   order and shadowing note as read_file), and edited in place in the store
 *   where it lives — a project chat can therefore edit an inherited
 *   workspace file, mirroring what read_file shows it.
 * - old_text must match the current content exactly; unless replace_all is
 *   true it must appear exactly once. Ambiguity and misses return isError
 *   results with actionable guidance (the model re-reads and retries).
 * - Only text-editable files (the create_file extension allow-list) can be
 *   edited — PDFs are readable but not editable.
 * - The write goes through createFile's shared writeContentToStore, so the
 *   overwrite mechanics (upload-first, stable row id, old-Drive-file cleanup,
 *   implicit text-cache invalidation) stay identical to create_file's.
 *
 * Returns { content, isError?, display? } like the other executors:
 * validation/miss failures RETURN isError results; unexpected failures
 * (Drive down) THROW and the loop converts them.
 */

const path = require('node:path');

const config = require('../config');
const drive = require('../utils/drive');
const { ACCEPTED_EXTENSIONS } = require('../utils/fileUploads');
const { formatFileSize } = require('../utils/format');
const { resolveReadStores, resolveToolDriveAuth } = require('./fileStore');
const { writeContentToStore } = require('./createFile');
const { logger } = require('../utils/logger');

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/**
 * Execute one edit_file call.
 * @param {{filename?: string, old_text?: string, new_text?: string, replace_all?: boolean}} input
 * @param {Object} ctx - ToolContext ({ userId, workspace, project, conversationId })
 * @returns {Promise<{content: string, isError?: boolean, display?: Object}>}
 */
async function executeEditFile(input, ctx) {
  const filename = typeof input.filename === 'string' ? input.filename.trim() : '';
  if (!filename) {
    return { content: 'edit_file needs a "filename". Use list_files to see what is available.', isError: true };
  }
  if (typeof input.old_text !== 'string' || input.old_text.length === 0) {
    return { content: 'edit_file needs a non-empty "old_text" — the exact current text to replace.', isError: true };
  }
  if (typeof input.new_text !== 'string') {
    return { content: 'edit_file needs "new_text" (a string; may be empty to delete old_text).', isError: true };
  }
  if (input.old_text === input.new_text) {
    return { content: 'old_text and new_text are identical — there is nothing to change.', isError: true };
  }
  const replaceAll = input.replace_all === true;

  // Same search as read_file: most specific store first, note shadowed copies.
  const stores = resolveReadStores(ctx);
  let hit = null;
  const shadowedKinds = [];
  for (const store of stores) {
    const file = store.findByName(filename);
    if (!file) continue;
    if (!hit) hit = { file, store };
    else shadowedKinds.push(store.kind);
  }
  if (!hit) {
    return {
      content: `No file named "${filename}" is available in this conversation. Use list_files to see the exact names, or create_file to make it.`,
      isError: true,
    };
  }
  if (!hit.file.drive_file_id) {
    return { content: `"${filename}" has no stored content to edit.`, isError: true };
  }

  // Editable = text-authorable, same rule as create_file (PDFs are readable
  // via read_file but cannot be edited as text).
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf' || !ACCEPTED_EXTENSIONS.has(ext)) {
    return { content: `"${filename}" is not a text-editable file type. Only text-based files (like .md, .txt, .csv, or code files) can be edited.`, isError: true };
  }

  // Drive-less users (e.g. dev login) get a readable failure, not a crash.
  const { auth, unavailable } = resolveToolDriveAuth(ctx.userId);
  if (unavailable) return { content: `Cannot edit the file: ${unavailable}`, isError: true };

  let content;
  try {
    content = await drive.downloadFileText(auth, hit.file.drive_file_id);
  } catch (err) {
    logger.warn({ userId: ctx.userId, fileId: hit.file.id, msg: err.message }, 'edit_file download failed');
    return { content: `Could not read the current content of "${filename}": ${err.message}`, isError: true };
  }

  const occurrences = countOccurrences(content, input.old_text);
  if (occurrences === 0) {
    return {
      content: `old_text was not found in "${filename}". It must match the current content exactly, including whitespace and line breaks — use read_file to check the current content, then retry.`,
      isError: true,
    };
  }
  if (occurrences > 1 && !replaceAll) {
    return {
      content: `old_text appears ${occurrences} times in "${filename}". Include more surrounding context so it matches exactly once, or set replace_all to true to replace every occurrence.`,
      isError: true,
    };
  }

  // split/join replaces without interpreting `$` patterns the way
  // String.replace would — new_text is inserted verbatim.
  const updated = replaceAll
    ? content.split(input.old_text).join(input.new_text)
    : content.replace(input.old_text, () => input.new_text);

  const bytes = Buffer.from(updated, 'utf8');
  if (bytes.length > config.projectFiles.maxFileBytes) {
    const mb = config.projectFiles.maxFileBytes / (1024 * 1024);
    return {
      content: `Cannot apply the edit: the result would be ${(bytes.length / (1024 * 1024)).toFixed(1)}MB but the limit is ${mb}MB.`,
      isError: true,
    };
  }

  const mimeType = hit.file.mime_type || 'text/plain';
  const { record } = await writeContentToStore(auth, hit.store, {
    filename,
    mimeType,
    bytes,
    userId: ctx.userId,
  });

  const url = hit.store.urlFor(record.id);
  const replacedNote = replaceAll && occurrences > 1 ? ` (${occurrences} occurrences replaced)` : '';
  const shadowNote = shadowedKinds.length > 0
    ? ` Note: this edited the ${hit.store.kind} copy; a different file with this name also exists in the ${shadowedKinds.join(' and ')}.`
    : '';

  logger.info(
    { userId: ctx.userId, destination: hit.store.kind, fileId: record.id, sizeBytes: bytes.length, occurrences, replaceAll },
    'edit_file executed'
  );

  return {
    content: `Edited "${filename}"${replacedNote} — now ${formatFileSize(bytes.length)}.${shadowNote} The user can download it at ${url} — you can reference this link in your reply as a markdown link.`,
    display: {
      fileId: record.id,
      url,
      destination: hit.store.kind,
      sizeBytes: bytes.length,
      mimeType,
      edited: true,
      ...(replaceAll ? { replacements: occurrences } : {}),
    },
  };
}

module.exports = { executeEditFile };
