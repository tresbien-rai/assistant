/**
 * read_file + list_files Executors (Track A, P2-04)
 *
 * Read-only companions to create_file. Both search the conversation's readable
 * files via resolveReadStores(ctx) — a project chat sees its project AND its
 * inherited workspace files; a workspace chat sees the workspace; an unfiled
 * chat sees Downloads. Reads NEVER create a Drive folder (they only call
 * findByName / list, never ensureFolder).
 *
 * read_file returns budget-guarded text (reusing projectContext's cached
 * download + PDF-extraction path). list_files returns compact metadata.
 *
 * Both return { content, isError? }: a missing file or Drive-not-connected is
 * an isError result the model can relay/retry, not a thrown error.
 */

const config = require('../config');
const { extractFileText } = require('../utils/projectContext');
const { formatFileSize } = require('../utils/format');
const { resolveReadStores, resolveToolDriveAuth } = require('./fileStore');
const { logger } = require('../utils/logger');

/**
 * Find a file by exact name across the conversation's read stores (most
 * specific first). Also reports any LESS-specific stores that hold the same
 * name (shadowing) so the caller can disambiguate for the user.
 * @param {Array} stores - resolveReadStores(ctx)
 * @param {string} filename
 * @returns {{file: Object, store: Object, shadowedKinds: string[]}|null}
 */
function findAcrossStores(stores, filename) {
  let hit = null;
  const shadowedKinds = [];
  for (const store of stores) {
    const file = store.findByName(filename);
    if (!file) continue;
    if (!hit) hit = { file, store };
    else shadowedKinds.push(store.kind); // same name in a less-specific store
  }
  if (!hit) return null;
  return { ...hit, shadowedKinds };
}

/**
 * Execute one read_file call.
 * @param {{filename?: string}} input
 * @param {Object} ctx - ToolContext ({ userId, workspace, project })
 * @returns {Promise<{content: string, isError?: boolean, display?: Object}>}
 */
async function executeReadFile(input, ctx) {
  const filename = typeof input.filename === 'string' ? input.filename.trim() : '';
  if (!filename) {
    return { content: 'read_file needs a "filename". Use list_files to see what is available.', isError: true };
  }

  const stores = resolveReadStores(ctx);
  const hit = findAcrossStores(stores, filename);
  if (!hit) {
    return {
      content: `No file named "${filename}" is available in this conversation. Use list_files to see the exact names.`,
      isError: true,
    };
  }
  if (!hit.file.drive_file_id) {
    return { content: `"${filename}" has no stored content to read.`, isError: true };
  }

  // Drive-less users (e.g. dev login) get a readable failure, not a crash.
  const { auth, unavailable } = resolveToolDriveAuth(ctx.userId);
  if (unavailable) return { content: `Cannot read the file: ${unavailable}`, isError: true };

  let text;
  try {
    text = await extractFileText(auth, hit.file);
  } catch (err) {
    // A Drive/parse failure on one file shouldn't kill the turn — report it so
    // the model can tell the user or try another file.
    logger.warn({ userId: ctx.userId, fileId: hit.file.id, msg: err.message }, 'read_file extraction failed');
    return { content: `Could not read "${filename}": ${err.message}`, isError: true };
  }

  const cap = config.projectFiles.toolReadMaxChars;
  let truncated = false;
  if (text.length > cap) {
    text = text.slice(0, cap);
    truncated = true;
  }

  logger.info(
    { userId: ctx.userId, source: hit.store.kind, fileId: hit.file.id, chars: text.length, truncated },
    'read_file executed'
  );

  // Shadowing: the same name in a less-specific store was NOT read (the more
  // specific copy wins). Tell the model so it doesn't confuse the user who may
  // have edited the other copy.
  const shadowNote = hit.shadowedKinds.length > 0
    ? ` (note: read the ${hit.store.kind} copy; a different file with this name also exists in the ${hit.shadowedKinds.join(' and ')})`
    : '';

  const header = truncated
    ? `Contents of "${filename}"${shadowNote} (truncated to the first ${cap} characters — the file is longer):`
    : `Contents of "${filename}"${shadowNote}:`;

  return {
    content: `${header}\n\n${text}`,
    display: { source: hit.store.kind, truncated, ...(hit.shadowedKinds.length ? { shadowedBy: hit.shadowedKinds } : {}) },
  };
}

/**
 * Execute one list_files call.
 * @param {Object} _input - list_files takes no arguments
 * @param {Object} ctx - ToolContext ({ userId, workspace, project })
 * @returns {Promise<{content: string, isError?: boolean, display?: Object}>}
 */
async function executeListFiles(_input, ctx) {
  const stores = resolveReadStores(ctx);
  const showSource = stores.length > 1; // only a project chat spans >1 store

  const rows = [];
  for (const store of stores) {
    for (const f of store.list()) {
      rows.push({ filename: f.filename, sizeBytes: f.size_bytes, mimeType: f.mime_type, source: store.kind });
    }
  }

  logger.info({ userId: ctx.userId, count: rows.length }, 'list_files executed');

  if (rows.length === 0) {
    return {
      content: 'There are no files available in this conversation yet. Use create_file to make one.',
      display: { count: 0 },
    };
  }

  const lines = rows.map((r) => {
    const meta = [formatFileSize(r.sizeBytes)];
    if (r.mimeType) meta.push(r.mimeType);
    if (showSource) meta.push(`in ${r.source}`);
    return `- ${r.filename} (${meta.join(', ')})`;
  });

  return {
    content: `Files available in this conversation (${rows.length}):\n${lines.join('\n')}`,
    display: { count: rows.length },
  };
}

module.exports = { executeReadFile, executeListFiles };
