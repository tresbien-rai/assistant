/**
 * Project Context Assembler (Phase 1, P1-05)
 *
 * Turns a project (instructions + Drive-backed files) into a single text block
 * that the chat route prepends to the persona's system prompt. This works
 * identically for every provider because it produces plain text.
 *
 * v1 strategy = FULL-CONTEXT INJECTION: download every file, extract its text,
 * and include it (within a budget). The "gather candidate text" step is
 * deliberately isolated in `gatherFileTexts()` so a future retrieval/RAG path
 * (chunk + embed + top-k) can replace it without touching the chat route or the
 * frontend (Phase 1 decision #1).
 *
 * Resilience: a project must never break a conversation. Drive being
 * unreachable, a single corrupt file, or an oversized knowledge base all
 * degrade gracefully (skip/truncate + a warning) rather than throwing.
 */

const config = require('../config');
const dal = require('../db/dal');
const drive = require('./drive');
const { logger } = require('./logger');

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
 * Gather the per-file text sections for a project, honoring the character
 * budget. This is the swappable "include everything" step — replace its body
 * with retrieval later without changing the assembled-block format.
 *
 * @param {string} userId
 * @param {Object} project - projects row (id, name, ...)
 * @param {Array} files - project_files rows
 * @param {number} budgetRemaining - chars still available
 * @returns {Promise<{ sections: string[], usedChars: number, skipped: string[], driveFailed: boolean }>}
 */
async function gatherFileTexts(userId, project, files, budgetRemaining) {
  const sections = [];
  const skipped = [];
  let used = 0;

  let auth;
  try {
    auth = drive.getAuthForUser(userId);
  } catch (err) {
    logger.warn(
      { userId, projectId: project.id, code: err.code },
      'Drive unavailable while assembling project context; including instructions only'
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
        { userId, projectId: project.id, fileId: file.id, code: err.code, msg: err.message },
        'Failed to load project file; skipping'
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
 * Wrap the instruction + file sections in a delimited context block.
 */
function wrapBlock(project, sections) {
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
 * Assemble the full project-context block for a project.
 *
 * @param {string} userId
 * @param {Object} project - projects row (must include id, name, instructions)
 * @returns {Promise<{ text: string, warning: string|null }|null>} null when
 *   there is nothing to inject (no instructions and no files).
 */
async function assembleProjectContext(userId, project) {
  const files = dal.listProjectFiles(project.id);
  const instructions = (project.instructions || '').trim();

  if (!instructions && files.length === 0) {
    return null;
  }

  const budget = config.projectFiles.contextBudgetChars;
  const sections = [];
  let used = 0;

  if (instructions) {
    const section = `## Project Instructions\n${instructions}`;
    sections.push(section);
    used += section.length;
  }

  let skipped = [];
  let driveFailed = false;

  if (files.length > 0) {
    const result = await gatherFileTexts(userId, project, files, budget - used);
    sections.push(...result.sections);
    used += result.usedChars;
    skipped = result.skipped;
    driveFailed = result.driveFailed;
  }

  const text = wrapBlock(project, sections);

  let warning = null;
  if (driveFailed) {
    warning = 'Project files could not be loaded (Google Drive was not accessible). Only the project instructions were included.';
  } else if (skipped.length > 0) {
    warning = `Project context exceeded the size budget; some files were truncated or omitted: ${skipped.join(', ')}.`;
  }

  return { text, warning };
}

/**
 * Wrap workspace instruction sections in a delimited context block. Mirrors
 * wrapBlock (project) but labels the material as workspace-level shared context.
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
 * Assemble the workspace-context block. Layered BEFORE the project block (and
 * the persona prompt) so workspace-wide instructions frame everything below.
 *
 * WR-02a includes workspace INSTRUCTIONS only; workspace reference files arrive
 * in WR-02b, at which point this gains a gatherFileTexts step like the project
 * assembler. Kept as a sibling of assembleProjectContext for that symmetry.
 *
 * @param {string} userId
 * @param {Object} workspace - workspaces row (must include id, name, instructions)
 * @returns {Promise<{ text: string, warning: string|null }|null>} null when there
 *   is nothing to inject (no instructions).
 */
async function assembleWorkspaceContext(userId, workspace) {
  const instructions = (workspace.instructions || '').trim();
  if (!instructions) {
    return null;
  }

  const sections = [`## Workspace Instructions\n${instructions}`];
  return { text: wrapWorkspaceBlock(workspace, sections), warning: null };
}

module.exports = {
  assembleProjectContext,
  assembleWorkspaceContext,
  // exported for tests
  _isPdf: isPdf,
  _textCache: textCache,
};
