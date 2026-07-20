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
 * - The write goes through the shared storeWriter path, so the overwrite
 *   mechanics (upload-first, stable row id, old-Drive-file cleanup, implicit
 *   text-cache invalidation) stay identical to create_file's.
 *
 * Returns { content, isError?, display? } like the other executors:
 * validation/miss failures RETURN isError results; unexpected failures
 * (Drive down) THROW and the loop converts them.
 */

const path = require('node:path');

const config = require('../config');
const { isTextAuthorableExtension } = require('../utils/fileUploads');
const { extractFileText } = require('../utils/projectContext');
const { formatFileSize } = require('../utils/format');
const { resolveReadStores, findAcrossStores, resolveToolDriveAuth } = require('./fileStore');
const { writeContentToStore } = require('./storeWriter');
const { logger } = require('../utils/logger');

/**
 * Count occurrences of `needle` in `haystack`, INCLUDING overlapping ones
 * (e.g. "ana" occurs twice in "banana"). The uniqueness guard uses this so a
 * self-overlapping old_text can't slip past as "unique" and leave a silent
 * half-edit — String.replace would only touch the first overlap.
 */
function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return count;
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
  const hit = findAcrossStores(resolveReadStores(ctx), filename);
  if (!hit) {
    return {
      content: `No file named "${filename}" is available in this conversation. Use list_files to see the exact names, or create_file to make it.`,
      isError: true,
    };
  }
  if (!hit.file.drive_file_id) {
    return { content: `"${filename}" has no stored content to edit.`, isError: true };
  }

  // Editable = text-authorable, the same single policy create_file enforces
  // (PDFs are readable via read_file but cannot be edited as text).
  if (!isTextAuthorableExtension(path.extname(filename).toLowerCase())) {
    return { content: `"${filename}" is not a text-editable file type. Only text-based files (like .md, .txt, .csv, or code files) can be edited.`, isError: true };
  }

  // Drive-less users (e.g. dev login) get a readable failure, not a crash.
  const { auth, unavailable } = resolveToolDriveAuth(ctx.userId);
  if (unavailable) return { content: `Cannot edit the file: ${unavailable}`, isError: true };

  // extractFileText = the same cached read path read_file uses (keyed by the
  // immutable Drive file id, so a hit can never be stale — every write mints
  // a new id). For the non-PDF files that reach here it returns the raw
  // UTF-8 content, and the read-then-edit flow costs one download, not two.
  let content;
  try {
    content = await extractFileText(auth, hit.file);
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

  // split/join and the function replacer both insert new_text verbatim,
  // without interpreting the `$` patterns String.replace(string) would.
  // replace_all replaces the non-overlapping occurrences (a second overlap
  // disappears when the first is rewritten), so its reported count comes
  // from the split, not the overlap-aware guard count.
  let updated;
  let replacements = 1;
  if (replaceAll) {
    const parts = content.split(input.old_text);
    replacements = parts.length - 1;
    updated = parts.join(input.new_text);
  } else {
    updated = content.replace(input.old_text, () => input.new_text);
  }

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
  const replacedNote = replaceAll && replacements > 1 ? ` (${replacements} occurrences replaced)` : '';
  const shadowNote = hit.shadowedKinds.length > 0
    ? ` Note: this edited the ${hit.store.kind} copy; a different file with this name also exists in the ${hit.shadowedKinds.join(' and ')}.`
    : '';

  logger.info(
    { userId: ctx.userId, destination: hit.store.kind, fileId: record.id, sizeBytes: bytes.length, replacements, replaceAll },
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
      // An edit is by definition an overwrite of the existing file — the
      // generic marker the frontend reads (no tool-specific fields).
      overwritten: true,
      ...(replaceAll ? { replacements } : {}),
    },
  };
}

module.exports = { executeEditFile };
