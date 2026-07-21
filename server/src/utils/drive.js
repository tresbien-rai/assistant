/**
 * Google Drive Utility (Phase 1)
 *
 * Builds an authenticated google.auth.OAuth2 client from a user's stored
 * (encrypted) Drive tokens, transparently refreshing the access token when it
 * expires and persisting the new one. Exposes small helpers for the file/folder
 * operations the Projects feature needs.
 *
 * Scope note: the app uses the `drive.file` OAuth scope, which only grants
 * access to files/folders the app itself created or opened. That is exactly the
 * model here — the app owns a `Tessera/projects/...` folder tree. Do NOT
 * expect to browse the user's whole Drive.
 *
 * All Drive failures are wrapped in `AppError.drive()`. Tokens are never logged.
 */

const { Readable } = require('node:stream');
const { google } = require('googleapis');

const config = require('../config');
const dal = require('../db/dal');
const { encrypt, decrypt } = require('./encryption');
const AppError = require('./AppError');
const { logger } = require('./logger');

// App folder layout on the user's Drive (root name is configurable; see config).
const APP_ROOT_FOLDER = config.driveRootFolder;
const PROJECTS_FOLDER = 'projects';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Escape a value for use inside a Drive query string literal.
 * Drive query literals are single-quoted; backslashes and single quotes must
 * be escaped to avoid breaking the query (or query injection via filenames).
 * @param {string} value
 * @returns {string}
 */
function escapeQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Build a bare OAuth2 client configured with this app's credentials.
 * @returns {import('google-auth-library').OAuth2Client}
 */
function buildOAuthClient() {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
}

/**
 * Build an authenticated OAuth2 client for a user from their stored, encrypted
 * Drive tokens. Wires automatic persistence of refreshed tokens via the
 * client's `tokens` event (fired by google-auth-library on refresh).
 *
 * @param {string} userId - The user's UUID
 * @returns {import('google-auth-library').OAuth2Client}
 * @throws {AppError} If the user is missing or Drive is not connected
 */
function getAuthForUser(userId) {
  const user = dal.findUserById(userId);
  if (!user) {
    throw AppError.auth('User not found');
  }
  if (!user.drive_token && !user.drive_refresh) {
    throw AppError.drive('Google Drive is not connected. Please reconnect your account.');
  }

  let accessToken = '';
  let refreshToken = '';
  try {
    accessToken = user.drive_token ? decrypt(user.drive_token) : '';
    refreshToken = user.drive_refresh ? decrypt(user.drive_refresh) : '';
  } catch {
    logger.error({ userId }, 'Failed to decrypt stored Drive tokens');
    throw AppError.drive('Stored Google Drive credentials are invalid. Please reconnect your account.');
  }

  const auth = buildOAuthClient();
  auth.setCredentials({
    access_token: accessToken || undefined,
    refresh_token: refreshToken || undefined,
  });

  // Persist refreshed tokens (encrypted at rest). google-auth-library emits
  // `tokens` whenever it refreshes the access token. The refresh token is only
  // present on first authorization / rotation, so keep the existing one
  // otherwise.
  auth.on('tokens', (tokens) => {
    try {
      if (!tokens.access_token && !tokens.refresh_token) return;
      dal.updateUserDriveTokens(userId, {
        driveToken: tokens.access_token ? encrypt(tokens.access_token) : user.drive_token,
        driveRefresh: tokens.refresh_token ? encrypt(tokens.refresh_token) : user.drive_refresh,
      });
      logger.info({ userId }, 'Refreshed and persisted Drive access token');
    } catch (err) {
      logger.error({ userId, msg: err.message }, 'Failed to persist refreshed Drive tokens');
    }
  });

  return auth;
}

/**
 * Force a token refresh using the client's refresh token. Used after a 401.
 * Clearing the access token makes getAccessToken() refresh via the refresh
 * token (which also fires the `tokens` event → persistence).
 * @param {import('google-auth-library').OAuth2Client} auth
 * @throws {AppError} If there is no refresh token to refresh with
 */
async function forceRefresh(auth) {
  const refreshToken = auth.credentials?.refresh_token;
  if (!refreshToken) {
    throw AppError.drive('Google Drive session expired and cannot be refreshed. Please reconnect your account.');
  }
  auth.setCredentials({ refresh_token: refreshToken });
  await auth.getAccessToken();
}

/**
 * Determine whether an error from googleapis is an auth/expiry failure.
 * @param {any} err
 * @returns {boolean}
 */
function isAuthError(err) {
  const status = err?.response?.status ?? err?.code;
  return status === 401;
}

/**
 * Wrap a non-AppError Drive failure as an AppError.drive(), logging context
 * without leaking tokens.
 * @param {any} err
 * @param {string} label
 * @returns {AppError}
 */
function wrapDriveError(err, label) {
  if (err instanceof AppError) return err;
  logger.error(
    { label, status: err?.response?.status ?? err?.code, msg: err?.message },
    'Google Drive operation failed'
  );
  return AppError.drive();
}

/**
 * Run a Drive operation with one automatic refresh-and-retry on a 401.
 * @template T
 * @param {import('google-auth-library').OAuth2Client} auth
 * @param {string} label - Operation name (for logging)
 * @param {(drive: import('googleapis').drive_v3.Drive) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function execute(auth, label, fn) {
  const drive = google.drive({ version: 'v3', auth });
  try {
    return await fn(drive);
  } catch (err) {
    if (isAuthError(err)) {
      logger.info({ label }, 'Drive access token rejected; refreshing and retrying once');
      try {
        // forceRefresh is inside the try so a failed refresh (e.g. the refresh
        // token was revoked → invalid_grant) is also wrapped as a DRIVE_ERROR,
        // surfacing the "reconnect your account" path instead of a generic 500.
        await forceRefresh(auth);
        return await fn(drive);
      } catch (retryErr) {
        throw wrapDriveError(retryErr, label);
      }
    }
    throw wrapDriveError(err, label);
  }
}

// =============================================================================
// Folder helpers
// =============================================================================

/**
 * Find a folder by name under a given parent (or My Drive root).
 * @param {import('google-auth-library').OAuth2Client} auth
 * @param {string} name
 * @param {string|null} parentId - Parent folder id, or null for root
 * @returns {Promise<{id: string, name: string}|null>}
 */
function findFolder(auth, name, parentId) {
  return execute(auth, 'findFolder', async (drive) => {
    let q = `name='${escapeQueryValue(name)}' and mimeType='${FOLDER_MIME}' and trashed=false`;
    q += parentId ? ` and '${escapeQueryValue(parentId)}' in parents` : " and 'root' in parents";
    const res = await drive.files.list({
      q,
      fields: 'files(id, name)',
      spaces: 'drive',
      pageSize: 1,
    });
    return res.data.files?.[0] || null;
  });
}

/**
 * Create a folder under a given parent (or My Drive root).
 * @param {import('google-auth-library').OAuth2Client} auth
 * @param {string} name
 * @param {string|null} [parentId] - Parent folder id, or null for root
 * @returns {Promise<string>} The new folder's id
 */
function createFolder(auth, name, parentId = null) {
  return execute(auth, 'createFolder', async (drive) => {
    const requestBody = { name, mimeType: FOLDER_MIME };
    if (parentId) requestBody.parents = [parentId];
    const res = await drive.files.create({ requestBody, fields: 'id' });
    return res.data.id;
  });
}

/**
 * Find a folder by name under a parent, creating it if absent (idempotent).
 * @param {import('google-auth-library').OAuth2Client} auth
 * @param {string} name
 * @param {string|null} parentId
 * @returns {Promise<string>} The folder's id
 */
async function ensureFolder(auth, name, parentId) {
  const existing = await findFolder(auth, name, parentId);
  return existing ? existing.id : createFolder(auth, name, parentId);
}

/**
 * Ensure the app's legacy folder tree exists: `{driveRootFolder}/projects/`.
 * Retained for back-compat with Phase-1 projects created before the Workspace
 * Restructure (and as a fallback parent for a project with no workspace).
 * Idempotent.
 * @param {import('google-auth-library').OAuth2Client} auth
 * @returns {Promise<{rootId: string, projectsId: string}>}
 */
async function ensureAppFolders(auth) {
  const rootId = await ensureFolder(auth, APP_ROOT_FOLDER, null);
  const projectsId = await ensureFolder(auth, PROJECTS_FOLDER, rootId);
  return { rootId, projectsId };
}

/**
 * Ensure a workspace's folder exists at `{driveRootFolder}/{name}/` and return
 * its id (Workspace Restructure layout: `Tessera/<Workspace>/<Project>/`).
 * Idempotent — safe to call whenever a workspace's folder id is needed.
 * @param {import('google-auth-library').OAuth2Client} auth
 * @param {string} name - The workspace name
 * @returns {Promise<string>} The workspace folder's id
 */
async function ensureWorkspaceFolder(auth, name) {
  const rootId = await ensureFolder(auth, APP_ROOT_FOLDER, null);
  return ensureFolder(auth, name, rootId);
}

/**
 * Ensure the `{driveRootFolder}/Downloads/` folder exists and return its id
 * (Track A): the destination for tool-created files when the chat is unfiled
 * (no project, no workspace). Idempotent, like the other ensure* helpers.
 * @param {import('google-auth-library').OAuth2Client} auth
 * @returns {Promise<string>} The Downloads folder's id
 */
async function ensureDownloadsFolder(auth) {
  const rootId = await ensureFolder(auth, APP_ROOT_FOLDER, null);
  return ensureFolder(auth, 'Downloads', rootId);
}

/**
 * Ensure the per-conversation folder `{driveRootFolder}/Chats/<conversationId>/`
 * exists and return its id (File Collaboration, FC-01): the destination for
 * files a chat creates, kept apart from the curated project/workspace folders so
 * chat scratch output never clutters the knowledge base. Idempotent via
 * find-or-create, so no `drive_folder_id` column is needed on conversations —
 * the conversation id is a stable, unique folder name.
 * @param {import('google-auth-library').OAuth2Client} auth
 * @param {string} conversationId
 * @returns {Promise<string>} The conversation folder's id
 */
async function ensureConversationFolder(auth, conversationId) {
  if (!conversationId) {
    throw AppError.validation('A conversation is required to store chat files.');
  }
  const rootId = await ensureFolder(auth, APP_ROOT_FOLDER, null);
  const chatsId = await ensureFolder(auth, 'Chats', rootId);
  return ensureFolder(auth, String(conversationId), chatsId);
}

// =============================================================================
// Row-aware folder helpers (shared by the project/workspace routes and the
// Track A tool executors — moved here from routes/projects.js in P2-01)
// =============================================================================

/**
 * Ensure a workspace row has a backing Drive folder, persisting its id if just
 * created. Returns the folder id.
 * @param {import('google-auth-library').OAuth2Client} auth
 * @param {string} userId
 * @param {Object} workspace - workspaces row
 * @returns {Promise<string>} The workspace folder id
 */
async function ensureWorkspaceFolderId(auth, userId, workspace) {
  if (workspace.drive_folder_id) return workspace.drive_folder_id;
  const folderId = await ensureWorkspaceFolder(auth, workspace.name);
  dal.updateWorkspace(workspace.id, userId, { driveFolderId: folderId });
  return folderId;
}

/**
 * Ensure a project row has a backing Drive folder under its workspace
 * (`{root}/<Workspace>/<Project>/`), persisting its id if just created. Falls
 * back to the legacy `{root}/projects/` folder for an orphan project that has
 * no workspace. Returns the folder id. Requires a working Drive auth.
 * @param {import('google-auth-library').OAuth2Client} auth
 * @param {string} userId
 * @param {Object} project - projects row
 * @returns {Promise<string>} The project folder id
 */
async function ensureProjectFolderId(auth, userId, project) {
  if (project.drive_folder_id) return project.drive_folder_id;

  let parentId = null;
  if (project.workspace_id) {
    const workspace = dal.getWorkspaceById(project.workspace_id, userId);
    if (workspace) {
      parentId = await ensureWorkspaceFolderId(auth, userId, workspace);
    }
  }
  if (!parentId) {
    const { projectsId } = await ensureAppFolders(auth);
    parentId = projectsId;
  }

  const folderId = await createFolder(auth, project.name, parentId);
  dal.updateProject(project.id, userId, { driveFolderId: folderId });
  return folderId;
}

// =============================================================================
// File helpers
// =============================================================================

/**
 * Upload a file into a Drive folder.
 * @param {import('google-auth-library').OAuth2Client} auth
 * @param {Object} params
 * @param {string} params.name - Filename
 * @param {string} [params.mimeType] - MIME type
 * @param {string} params.parentId - Destination folder id
 * @param {Buffer|import('stream').Readable} params.data - File contents
 * @returns {Promise<{id: string, name: string, size: string, mimeType: string}>}
 */
function uploadFile(auth, { name, mimeType, parentId, data }) {
  return execute(auth, 'uploadFile', async (drive) => {
    const media = {
      mimeType: mimeType || 'application/octet-stream',
      body: Buffer.isBuffer(data) ? Readable.from(data) : data,
    };
    const requestBody = { name };
    if (parentId) requestBody.parents = [parentId];
    const res = await drive.files.create({
      requestBody,
      media,
      fields: 'id, name, size, mimeType',
    });
    return res.data;
  });
}

/**
 * Download a file's raw bytes.
 * @param {import('google-auth-library').OAuth2Client} auth
 * @param {string} fileId
 * @returns {Promise<Buffer>}
 */
function downloadFileBytes(auth, fileId) {
  return execute(auth, 'downloadFileBytes', async (drive) => {
    const res = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' }
    );
    return Buffer.from(res.data);
  });
}

/**
 * Download a file and decode it as UTF-8 text.
 * @param {import('google-auth-library').OAuth2Client} auth
 * @param {string} fileId
 * @returns {Promise<string>}
 */
async function downloadFileText(auth, fileId) {
  const buffer = await downloadFileBytes(auth, fileId);
  return buffer.toString('utf8');
}

/**
 * Permanently delete a file (skips the trash). Used when removing an individual
 * project file.
 * @param {import('google-auth-library').OAuth2Client} auth
 * @param {string} fileId
 * @returns {Promise<boolean>}
 */
function deleteFile(auth, fileId) {
  return execute(auth, 'deleteFile', async (drive) => {
    await drive.files.delete({ fileId });
    return true;
  });
}

/**
 * Move a file/folder to the trash (recoverable). Used when deleting a project,
 * so the user can recover its files from Drive's trash.
 * @param {import('google-auth-library').OAuth2Client} auth
 * @param {string} fileId
 * @returns {Promise<boolean>}
 */
function trashFile(auth, fileId) {
  return execute(auth, 'trashFile', async (drive) => {
    await drive.files.update({ fileId, requestBody: { trashed: true } });
    return true;
  });
}

/**
 * List non-trashed files directly inside a folder.
 * @param {import('google-auth-library').OAuth2Client} auth
 * @param {string} parentId - Folder id
 * @returns {Promise<Array<{id, name, mimeType, size, createdTime}>>}
 */
function listFiles(auth, parentId) {
  return execute(auth, 'listFiles', async (drive) => {
    const q = `'${escapeQueryValue(parentId)}' in parents and trashed=false`;
    const files = [];
    let pageToken;
    do {
      const res = await drive.files.list({
        q,
        fields: 'nextPageToken, files(id, name, mimeType, size, createdTime)',
        spaces: 'drive',
        pageToken,
        pageSize: 100,
      });
      files.push(...(res.data.files || []));
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    return files;
  });
}

module.exports = {
  getAuthForUser,
  ensureAppFolders,
  ensureWorkspaceFolder,
  ensureWorkspaceFolderId,
  ensureProjectFolderId,
  ensureDownloadsFolder,
  ensureConversationFolder,
  createFolder,
  uploadFile,
  downloadFileText,
  downloadFileBytes,
  deleteFile,
  trashFile,
  listFiles,
};
