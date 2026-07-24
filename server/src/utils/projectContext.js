/**
 * Project Context Assembler (Phase 1, P1-05)
 *
 * Turns a project (instructions + Drive-backed files) into a single text block
 * that the chat route prepends to the persona's system prompt. This works
 * identically for every provider because it produces plain text.
 *
 * v1 strategy = FULL-CONTEXT INJECTION: download every ENABLED file, extract its
 * text, and include it (within a budget). The "gather candidate text" step is
 * deliberately isolated in `gatherFileTexts()` so a future retrieval/RAG path
 * (chunk + embed + top-k) can replace it without touching the chat route or the
 * frontend (Phase 1 decision #1).
 *
 * Which files count as enabled is resolved by utils/contextState.js (Context
 * toggles, CT-02): a per-chat override, else the container default, else on.
 * Disabled files are not downloaded at all — they cost nothing but their name in
 * the `<available_files>` manifest, and only when file tools are on to make that
 * name actionable. When retrieval lands, this same partition becomes "what is
 * eligible for the index", so the toggle keeps its meaning.
 *
 * Resilience: a project must never break a conversation. Drive being
 * unreachable, a single corrupt file, or an oversized knowledge base all
 * degrade gracefully (skip/truncate + a warning) rather than throwing.
 */

const config = require('../config');
const dal = require('../db/dal');
const drive = require('./drive');
const { partitionKnowledgeFiles } = require('./contextState');
const { logger } = require('./logger');

// How many disabled filenames the <available_files> manifest names before it
// summarises the rest. The manifest is meant to cost ~one line, not to become a
// second knowledge base for a container with hundreds of files.
const MANIFEST_MAX_NAMES = 50;

// pdf-parse is required lazily (and via its lib entry, which avoids the package
// index's debug-mode test-file read) so the dependency only loads when a PDF is
// actually encountered.
let pdfParse = null;
function getPdfParser() {
  if (!pdfParse) {
    pdfParse = require('pdf-parse/lib/pdf-parse.js');
  }
  return pdfParse;
}

// In-memory cache of extracted file text, keyed by Drive file id, so repeated
// turns of a conversation don't re-download/re-parse the same files. Files are
// immutable per upload (a replacement gets a new Drive id), so the id is a safe
// key; the TTL just bounds staleness/memory.
const TEXT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const TEXT_CACHE_MAX_ENTRIES = 100;
const textCache = new Map(); // driveFileId -> { text, expires }

function cacheGet(key) {
  const hit = textCache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) {
    textCache.delete(key);
    return undefined;
  }
  return hit.text;
}

function cacheSet(key, text) {
  // Cheap FIFO eviction: drop the oldest entry when at capacity.
  if (textCache.size >= TEXT_CACHE_MAX_ENTRIES) {
    const oldest = textCache.keys().next().value;
    if (oldest !== undefined) textCache.delete(oldest);
  }
  textCache.set(key, { text, expires: Date.now() + TEXT_CACHE_TTL_MS });
}

function isPdf(file) {
  return /\.pdf$/i.test(file.filename || '') || file.mime_type === 'application/pdf';
}

/**
 * Download + extract one file's text (PDF via pdf-parse, everything else as
 * UTF-8). Cached by Drive file id.
 * @param {import('google-auth-library').OAuth2Client} auth
 * @param {Object} file - project_files row
 * @returns {Promise<string>}
 */
async function extractFileText(auth, file) {
  const key = file.drive_file_id;
  if (key) {
    const cached = cacheGet(key);
    if (cached !== undefined) return cached;
  }

  const bytes = await drive.downloadFileBytes(auth, file.drive_file_id);

  let text;
  if (isPdf(file)) {
    const parsed = await getPdfParser()(bytes);
    text = parsed.text || '';
  } else {
    text = bytes.toString('utf8');
  }

  if (key) cacheSet(key, text);
  return text;
}

/**
 * Gather the per-file text sections for a container (project or workspace),
 * honoring the character budget. This is the swappable "include everything"
 * step — replace its body with retrieval later without changing the
 * assembled-block format.
 *
 * @param {string} userId
 * @param {Object} container - projects/workspaces row (id, name, ...)
 * @param {Array} files - file rows (project_files or workspace_files)
 * @param {number} budgetRemaining - chars still available
 * @returns {Promise<{ sections: string[], usedChars: number, skipped: string[], driveFailed: boolean }>}
 */
async function gatherFileTexts(userId, container, files, budgetRemaining) {
  const sections = [];
  const skipped = [];
  let used = 0;

  let auth;
  try {
    auth = drive.getAuthForUser(userId);
  } catch (err) {
    logger.warn(
      { userId, containerId: container.id, code: err.code },
      'Drive unavailable while assembling context; including instructions only'
    );
    return { sections, usedChars: 0, skipped: files.map(f => f.filename), driveFailed: true };
  }

  for (const file of files) {
    const remaining = budgetRemaining - used;
    if (remaining <= 0) {
      skipped.push(file.filename);
      continue;
    }

    let fileText;
    try {
      fileText = await extractFileText(auth, file);
    } catch (err) {
      logger.warn(
        { userId, containerId: container.id, fileId: file.id, code: err.code, msg: err.message },
        'Failed to load context file; skipping'
      );
      skipped.push(file.filename);
      continue;
    }

    const header = `### File: ${file.filename}\n`;
    let body = fileText;
    if (header.length + body.length > remaining) {
      body = body.slice(0, Math.max(0, remaining - header.length));
      skipped.push(`${file.filename} (truncated)`);
    }

    const section = header + body;
    sections.push(section);
    used += section.length;
  }

  return { sections, usedChars: used, skipped, driveFailed: false };
}

/**
 * Wrap a project's instruction + file sections in a delimited context block.
 */
function wrapProjectBlock(project, sections) {
  return [
    '<project_context>',
    `The following is reference material for this conversation from the user's ` +
      `project "${project.name}". Treat it as authoritative background knowledge ` +
      `provided by the user.`,
    '',
    sections.join('\n\n'),
    '</project_context>',
  ].join('\n');
}

/**
 * Wrap a workspace's instruction + file sections in a delimited context block.
 * Mirrors wrapProjectBlock but labels the material as workspace-level shared
 * context (layered BEFORE the project block so it frames everything below).
 */
function wrapWorkspaceBlock(workspace, sections) {
  return [
    '<workspace_context>',
    `The following is shared reference material for this conversation from the ` +
      `user's workspace "${workspace.name}". Treat it as authoritative background ` +
      `knowledge provided by the user.`,
    '',
    sections.join('\n\n'),
    '</workspace_context>',
  ].join('\n');
}

/**
 * Build the `<available_files>` manifest for the files a chat has toggled off,
 * or null when there is nothing to name. Deliberately cheap: names only, capped,
 * and one instruction on how to get the content.
 * @param {Object} container - the container the files belong to
 * @param {Array} notLoaded - the disabled file rows
 * @param {string} nounLower - 'project' | 'workspace', for the sentence
 * @returns {string|null}
 */
function buildAvailableFilesSection(container, notLoaded, nounLower) {
  if (notLoaded.length === 0) return null;

  const names = notLoaded.slice(0, MANIFEST_MAX_NAMES).map((f) => f.filename);
  const overflow = notLoaded.length - names.length;
  const tail = overflow > 0 ? `, and ${overflow} more` : '';

  return [
    '<available_files>',
    `These files exist in the ${nounLower} "${container.name}" but are NOT loaded ` +
      `into this conversation. Their content is not shown above. If you need one, ` +
      `call read_file with its exact name: ${names.join(', ')}${tail}.`,
    '</available_files>',
  ].join('\n');
}

/**
 * Assemble a container's full context block (instructions + Drive-backed files),
 * shared by projects and workspaces — they differ only in which files to list,
 * the section/wrapper labels, and the warning noun.
 *
 * @param {string} userId
 * @param {Object} container - projects/workspaces row (must include id, name, instructions)
 * @param {Object} opts
 * @param {(id: string) => Array} opts.listFiles - DAL file lister for this container
 * @param {string} opts.heading - instructions section heading ("Project Instructions")
 * @param {(container, sections: string[]) => string} opts.wrap - block wrapper
 * @param {string} opts.noun - capitalized container noun for warnings ("Project")
 * @param {'workspace'|'project'} opts.scope - knowledge scope for override lookup
 * @param {string|null} [opts.conversationId] - the chat, for per-chat overrides;
 *   null resolves every file to its container default
 * @param {boolean} [opts.toolsEnabled] - whether file tools are advertised this
 *   request. Gates the `<available_files>` manifest: with no read_file to call,
 *   naming an unreachable file is noise and an invitation to invent its contents.
 * @returns {Promise<{ text: string, warning: string|null }|null>} null when there
 *   is nothing to inject (no instructions, no enabled files, nothing to list).
 */
async function assembleContextBlock(
  userId,
  container,
  { listFiles, heading, wrap, noun, scope, conversationId = null, toolsEnabled = false }
) {
  const allFiles = listFiles(container.id);
  const instructions = (container.instructions || '').trim();

  // Context toggles (CT-02): disabled files are never downloaded, so they cost
  // neither budget nor a Drive round trip.
  const { loaded, notLoaded } = partitionKnowledgeFiles(dal, conversationId, scope, allFiles);
  const manifest = toolsEnabled
    ? buildAvailableFilesSection(container, notLoaded, noun.toLowerCase())
    : null;

  if (!instructions && loaded.length === 0 && !manifest) {
    return null;
  }

  const budget = config.projectFiles.contextBudgetChars;
  const sections = [];
  let used = 0;

  if (instructions) {
    const section = `## ${heading}\n${instructions}`;
    sections.push(section);
    used += section.length;
  }

  let skipped = [];
  let driveFailed = false;

  if (loaded.length > 0) {
    const result = await gatherFileTexts(userId, container, loaded, budget - used);
    sections.push(...result.sections);
    used += result.usedChars;
    skipped = result.skipped;
    driveFailed = result.driveFailed;
  }

  // The manifest goes last, after the content it is the counterpart to. Not
  // budgeted: it is names-only and capped, so it cannot meaningfully compete
  // with file content for space.
  if (manifest) sections.push(manifest);

  const text = wrap(container, sections);

  let warning = null;
  if (driveFailed) {
    warning = `${noun} files could not be loaded (Google Drive was not accessible). Only the ${noun.toLowerCase()} instructions were included.`;
  } else if (skipped.length > 0) {
    warning = `${noun} context exceeded the size budget; some files were truncated or omitted: ${skipped.join(', ')}.`;
  }

  return { text, warning };
}

/**
 * Assemble the full project-context block (instructions + project files).
 * @param {string} userId
 * @param {Object} project - projects row (must include id, name, instructions)
 * @param {{conversationId?: string|null, toolsEnabled?: boolean}} [opts] - context
 *   toggle inputs (CT-02); omitted means "no chat, no manifest" — every file
 *   resolves to its container default.
 * @returns {Promise<{ text: string, warning: string|null }|null>}
 */
function assembleProjectContext(userId, project, opts = {}) {
  return assembleContextBlock(userId, project, {
    listFiles: dal.listProjectFiles,
    heading: 'Project Instructions',
    wrap: wrapProjectBlock,
    noun: 'Project',
    scope: 'project',
    conversationId: opts.conversationId ?? null,
    toolsEnabled: opts.toolsEnabled === true,
  });
}

/**
 * Assemble the full workspace-context block (instructions + workspace files).
 * Layered BEFORE the project block and the persona prompt.
 * @param {string} userId
 * @param {Object} workspace - workspaces row (must include id, name, instructions)
 * @param {{conversationId?: string|null, toolsEnabled?: boolean}} [opts] - see
 *   assembleProjectContext
 * @returns {Promise<{ text: string, warning: string|null }|null>}
 */
function assembleWorkspaceContext(userId, workspace, opts = {}) {
  return assembleContextBlock(userId, workspace, {
    listFiles: dal.listWorkspaceFiles,
    heading: 'Workspace Instructions',
    wrap: wrapWorkspaceBlock,
    noun: 'Workspace',
    scope: 'workspace',
    conversationId: opts.conversationId ?? null,
    toolsEnabled: opts.toolsEnabled === true,
  });
}

module.exports = {
  assembleProjectContext,
  assembleWorkspaceContext,
  // Shared with the read_file tool executor (Track A, P2-04): same
  // download + PDF-extraction + per-Drive-id cache path.
  extractFileText,
  // exported for tests
  _isPdf: isPdf,
  _textCache: textCache,
  _buildAvailableFilesSection: buildAvailableFilesSection,
  _MANIFEST_MAX_NAMES: MANIFEST_MAX_NAMES,
};
