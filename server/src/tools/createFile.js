/**
 * create_file Executor (Track A, P2-03)
 *
 * Writes model-authored text content to the user's Google Drive and records
 * it, so the user can download it from the conversation.
 *
 * Destination (decision 1 in docs/PHASE2_TASKS.md):
 *   active project folder → active workspace folder → Tessera/Downloads/
 * recorded in project_files / workspace_files / user_files respectively.
 *
 * Semantics (decision 6):
 * - The FILENAME EXTENSION is validated against the same allow-list as user
 *   uploads (config.projectFiles.acceptedExtensions); mime_type is advisory.
 * - Content is a UTF-8 string capped at config.projectFiles.maxFileBytes.
 * - A duplicate filename in the destination scope is OVERWRITTEN: the new
 *   bytes are uploaded first, the row is repointed (keeping its id, so
 *   existing download links serve the new content), then the old Drive file
 *   is deleted best-effort.
 *
 * Returns { content, isError?, display? }: `content` is what the model reads;
 * `display` extras (fileId, url, destination) merge into the tool event the
 * frontend renders as a chip/attachment (P2-05b).
 *
 * Validation failures RETURN isError results (the model can correct itself);
 * unexpected failures (Drive down, etc.) THROW and the loop converts them.
 */

const path = require('node:path');

const config = require('../config');
const dal = require('../db/dal');
const drive = require('../utils/drive');
const { ACCEPTED_EXTENSIONS } = require('../utils/fileUploads');
const { logger } = require('../utils/logger');

// Extension → MIME for common text types; fallback text/plain. mime_type from
// the model wins when provided (advisory but usually right).
const MIME_BY_EXTENSION = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

/**
 * Validate the filename: non-empty, no path tricks, allow-listed extension.
 * @param {*} filename
 * @returns {{ok: true, ext: string, name: string} | {ok: false, reason: string}}
 */
function validateFilename(filename) {
  if (typeof filename !== 'string' || !filename.trim()) {
    return { ok: false, reason: 'filename is required.' };
  }
  const name = filename.trim();
  if (name.length > 200) {
    return { ok: false, reason: 'filename is too long (max 200 characters).' };
  }
  // No folders, no traversal, no control characters — Drive has no real
  // paths, but the name is echoed into queries, headers, and the UI.
  if (/[/\\]/.test(name) || name.includes('..') || /[\u0000-\u001f]/.test(name)) {
    return { ok: false, reason: 'filename must be a plain file name without folders or path separators.' };
  }
  const ext = path.extname(name).toLowerCase();
  if (!ext) {
    return { ok: false, reason: 'filename needs a text-type extension, e.g. "notes.md" or "data.csv".' };
  }
  if (ext === '.pdf' || !ACCEPTED_EXTENSIONS.has(ext)) {
    // PDFs are accepted as USER uploads but can't be authored from a text
    // string, so create_file rejects them explicitly.
    return { ok: false, reason: `the "${ext}" extension is not supported. Use a text-based type like .md, .txt, .csv, or a code extension.` };
  }
  return { ok: true, ext, name };
}

/**
 * Resolve the destination for this conversation's files: folder on Drive +
 * the DAL accessors for the matching table.
 * @param {import('google-auth-library').OAuth2Client} auth
 * @param {Object} ctx - ToolContext ({ userId, workspace, project })
 * @returns {Promise<{kind: string, folderId: string, findByName: Function,
 *   add: Function, updateContent: Function, urlFor: (fileId: string) => string}>}
 */
async function resolveDestination(auth, ctx) {
  if (ctx.project) {
    const folderId = await drive.ensureProjectFolderId(auth, ctx.userId, ctx.project);
    return {
      kind: 'project',
      folderId,
      findByName: (name) => dal.getProjectFileByName(ctx.project.id, name),
      add: (data) => dal.addProjectFile(ctx.project.id, data),
      updateContent: (fileId, data) => dal.updateProjectFileContent(fileId, data),
      urlFor: (fileId) => `/api/projects/${ctx.project.id}/files/${fileId}/content`,
    };
  }
  if (ctx.workspace) {
    const folderId = await drive.ensureWorkspaceFolderId(auth, ctx.userId, ctx.workspace);
    return {
      kind: 'workspace',
      folderId,
      findByName: (name) => dal.getWorkspaceFileByName(ctx.workspace.id, name),
      add: (data) => dal.addWorkspaceFile(ctx.workspace.id, data),
      updateContent: (fileId, data) => dal.updateWorkspaceFileContent(fileId, data),
      urlFor: (fileId) => `/api/workspaces/${ctx.workspace.id}/files/${fileId}/content`,
    };
  }
  const folderId = await drive.ensureDownloadsFolder(auth);
  return {
    kind: 'downloads',
    folderId,
    findByName: (name) => dal.getUserFileByName(ctx.userId, name),
    add: (data) => dal.addUserFile(ctx.userId, data),
    updateContent: (fileId, data) => dal.updateUserFileContent(fileId, data),
    urlFor: (fileId) => `/api/files/${fileId}/content`,
  };
}

/**
 * Execute one create_file call.
 * @param {{filename?: string, content?: string, mime_type?: string}} input
 * @param {Object} ctx - ToolContext ({ userId, workspace, project, conversationId })
 * @returns {Promise<{content: string, isError?: boolean, display?: Object}>}
 */
async function executeCreateFile(input, ctx) {
  const check = validateFilename(input.filename);
  if (!check.ok) {
    return { content: `Cannot create the file: ${check.reason}`, isError: true };
  }
  const filename = check.name;

  if (typeof input.content !== 'string') {
    return { content: 'Cannot create the file: content must be a string of the complete file text.', isError: true };
  }
  const bytes = Buffer.from(input.content, 'utf8');
  if (bytes.length > config.projectFiles.maxFileBytes) {
    const mb = config.projectFiles.maxFileBytes / (1024 * 1024);
    return {
      content: `Cannot create the file: content is ${(bytes.length / (1024 * 1024)).toFixed(1)}MB but the limit is ${mb}MB. Split it into smaller files.`,
      isError: true,
    };
  }

  const mimeType = (typeof input.mime_type === 'string' && input.mime_type.trim())
    ? input.mime_type.trim()
    : (MIME_BY_EXTENSION[check.ext] || 'text/plain');

  // Drive-less users (e.g. dev login) get a readable failure, not a crash.
  let auth;
  try {
    auth = drive.getAuthForUser(ctx.userId);
  } catch (err) {
    return {
      content: 'Cannot create the file: Google Drive is not connected for this account. Ask the user to reconnect Google Drive in Tessera.',
      isError: true,
    };
  }

  const dest = await resolveDestination(auth, ctx);

  // Upload the new bytes FIRST — if this fails, an existing same-name file is
  // left untouched.
  const uploaded = await drive.uploadFile(auth, {
    name: filename,
    mimeType,
    parentId: dest.folderId,
    data: bytes,
  });

  // Overwrite-on-duplicate (decision 6): repoint the existing row (its id —
  // and therefore any previously shared download link — keeps working), then
  // drop the old Drive file best-effort.
  const existing = dest.findByName(filename);
  let record;
  let overwritten = false;
  if (existing) {
    record = dest.updateContent(existing.id, {
      mimeType,
      sizeBytes: bytes.length,
      driveFileId: uploaded.id,
    });
    overwritten = true;
    if (existing.drive_file_id && existing.drive_file_id !== uploaded.id) {
      try {
        await drive.deleteFile(auth, existing.drive_file_id);
      } catch (err) {
        logger.warn(
          { userId: ctx.userId, fileId: existing.id, msg: err.message },
          'Failed to delete replaced Drive file; orphan left on Drive'
        );
      }
    }
  } else {
    record = dest.add({
      filename,
      mimeType,
      sizeBytes: bytes.length,
      driveFileId: uploaded.id,
    });
  }

  const url = dest.urlFor(record.id);
  const sizeLabel = bytes.length < 1024 ? `${bytes.length} B` : `${(bytes.length / 1024).toFixed(1)} KB`;
  const where = dest.kind === 'project'
    ? `the project "${ctx.project.name}"`
    : dest.kind === 'workspace'
      ? `the workspace "${ctx.workspace.name}"`
      : "the user's Downloads folder";

  logger.info(
    { userId: ctx.userId, destination: dest.kind, fileId: record.id, sizeBytes: bytes.length, overwritten },
    'create_file executed'
  );

  return {
    content: `${overwritten ? 'Updated' : 'Created'} "${filename}" (${sizeLabel}, ${mimeType}) in ${where}. The user can download it at ${url} — you can reference this link in your reply as a markdown link.`,
    display: {
      fileId: record.id,
      url,
      destination: dest.kind,
      sizeBytes: bytes.length,
      mimeType,
      overwritten,
    },
  };
}

module.exports = { executeCreateFile, _validateFilename: validateFilename };
