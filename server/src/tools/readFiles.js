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
const dal = require('../db/dal');
const { extractFileText } = require('../utils/projectContext');
const { formatFileSize } = require('../utils/format');
const { resolveKnowledgeFiles, resolveInjectMode, isKnowledgeScope } = require('../utils/contextState');
const { resolveReadStores, findAcrossStores, resolveToolDriveAuth } = require('./fileStore');
const { logger } = require('../utils/logger');

/**
 * Annotate one store's files with their context state (CT-02), resolved for the
 * whole store in one pass rather than per row.
 *
 * Only the NOT-LOADED states get a note: a model that sees a file listed but
 * finds no matching content in its context would otherwise be left to guess why,
 * and guessing tends to mean inventing the contents. A pinned or normally-loaded
 * file needs no explanation — its content is right there.
 *
 * @param {Object} store - the FileStore
 * @param {Array} files - store.list() rows
 * @param {string|null} conversationId
 * @returns {Array<{ file: Object, note: string }>}
 */
function annotateStoreFiles(store, files, conversationId) {
  if (isKnowledgeScope(store.kind)) {
    return resolveKnowledgeFiles(dal, conversationId, store.kind, files).map(({ file, enabled }) => ({
      file,
      note: enabled ? '' : 'not loaded into this conversation — read_file to load it',
    }));
  }
  if (store.kind === 'conversation') {
    return files.map((file) => ({
      file,
      note: resolveInjectMode(file) === 'mute' ? 'muted — not loaded automatically, read_file to load it' : '',
    }));
  }
  // Downloads is never auto-injected, so there is no state to report.
  return files.map((file) => ({ file, note: '' }));
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
    for (const { file, note } of annotateStoreFiles(store, store.list(), ctx.conversationId || null)) {
      rows.push({
        filename: file.filename,
        sizeBytes: file.size_bytes,
        mimeType: file.mime_type,
        source: store.kind,
        note,
      });
    }
  }

  const notLoaded = rows.filter((r) => r.note).length;
  logger.info({ userId: ctx.userId, count: rows.length, notLoaded }, 'list_files executed');

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
    return `- ${r.filename} (${meta.join(', ')})${r.note ? ` — ${r.note}` : ''}`;
  });

  return {
    content: `Files available in this conversation (${rows.length}):\n${lines.join('\n')}`,
    display: { count: rows.length, ...(notLoaded > 0 ? { notLoaded } : {}) },
  };
}

module.exports = { executeReadFile, executeListFiles };
