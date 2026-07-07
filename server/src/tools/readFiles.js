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
const drive = require('../utils/drive');
const { extractFileText } = require('../utils/projectContext');
const { formatFileSize } = require('../utils/format');
const { resolveReadStores } = require('./fileStore');
const { logger } = require('../utils/logger');

/**
 * Find a file by exact name across the conversation's read stores (most
 * specific first).
 * @param {Array} stores - resolveReadStores(ctx)
 * @param {string} filename
 * @returns {{file: Object, store: Object}|null}
 */
function findAcrossStores(stores, filename) {
  for (const store of stores) {
    const file = store.findByName(filename);
    if (file) return { file, store };
  }
  return null;
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
  let auth;
  try {
    auth = drive.getAuthForUser(ctx.userId);
  } catch (err) {
    return {
      content: 'Cannot read the file: Google Drive is not connected for this account. Ask the user to reconnect Google Drive in Tessera.',
      isError: true,
    };
  }

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

  const header = truncated
    ? `Contents of "${filename}" (truncated to the first ${cap} characters — the file is longer):`
    : `Contents of "${filename}":`;

  return {
    content: `${header}\n\n${text}`,
    display: { source: hit.store.kind, truncated },
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
