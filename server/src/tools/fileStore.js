/**
 * File store routing (Track A)
 *
 * Maps a conversation's context to WHERE its tool files live: the Drive folder
 * and the DAL accessors for the matching table. Destination precedence
 * (decision 1 in docs/PHASE2_TASKS.md): active project → active workspace →
 * the user's Tessera/Downloads/ (unfiled).
 *
 * Routing is PURE (no I/O): `ensureFolder(auth)` is a lazy closure, so read-only
 * tools (read_file / list_files, P2-04) can route to the right table WITHOUT
 * creating a Drive folder as a side effect — only create_file calls
 * ensureFolder. Every accessor is already scoped to the user's container.
 *
 * @typedef {Object} FileStore
 * @property {string} kind - 'project' | 'workspace' | 'downloads'
 * @property {string} label - human phrase for messages ("the project \"X\"")
 * @property {(auth) => Promise<string>} ensureFolder - resolve/create the Drive folder id
 * @property {(name: string) => Object|undefined} findByName - scoped filename lookup
 * @property {() => Array} list - scoped metadata list
 * @property {(data) => Object} add - insert a new file row
 * @property {(fileId: string, data) => Object|undefined} updateContent - repoint a row (scoped)
 * @property {(fileId: string) => string} urlFor - download URL for a file id
 */

const dal = require('../db/dal');
const drive = require('../utils/drive');

// Per-kind store builders. Kept separate so writes can pick ONE destination by
// precedence (resolveFileStore) while reads can search SEVERAL (resolveReadStores)
// without re-deriving the accessor wiring.

function projectStore(ctx) {
  const projectId = ctx.project.id;
  return {
    kind: 'project',
    label: `the project "${ctx.project.name}"`,
    ensureFolder: (auth) => drive.ensureProjectFolderId(auth, ctx.userId, ctx.project),
    findByName: (name) => dal.getProjectFileByName(projectId, name),
    list: () => dal.listProjectFiles(projectId),
    add: (data) => dal.addProjectFile(projectId, data),
    updateContent: (fileId, data) => dal.updateProjectFileContent(fileId, projectId, data),
    urlFor: (fileId) => `/api/projects/${projectId}/files/${fileId}/content`,
  };
}

function workspaceStore(ctx) {
  const workspaceId = ctx.workspace.id;
  return {
    kind: 'workspace',
    label: `the workspace "${ctx.workspace.name}"`,
    ensureFolder: (auth) => drive.ensureWorkspaceFolderId(auth, ctx.userId, ctx.workspace),
    findByName: (name) => dal.getWorkspaceFileByName(workspaceId, name),
    list: () => dal.listWorkspaceFiles(workspaceId),
    add: (data) => dal.addWorkspaceFile(workspaceId, data),
    updateContent: (fileId, data) => dal.updateWorkspaceFileContent(fileId, workspaceId, data),
    urlFor: (fileId) => `/api/workspaces/${workspaceId}/files/${fileId}/content`,
  };
}

function downloadsStore(ctx) {
  const userId = ctx.userId;
  return {
    kind: 'downloads',
    label: "the user's Downloads folder",
    ensureFolder: (auth) => drive.ensureDownloadsFolder(auth),
    findByName: (name) => dal.getUserFileByName(userId, name),
    list: () => dal.listUserFiles(userId),
    add: (data) => dal.addUserFile(userId, data),
    updateContent: (fileId, data) => dal.updateUserFileContent(fileId, userId, data),
    urlFor: (fileId) => `/api/files/${fileId}/content`,
  };
}

/**
 * The single WRITE destination for this conversation (create_file), by
 * precedence: active project → active workspace → the user's Downloads.
 * @param {Object} ctx - ToolContext ({ userId, workspace, project })
 * @returns {FileStore}
 */
function resolveFileStore(ctx) {
  if (ctx.project) return projectStore(ctx);
  if (ctx.workspace) return workspaceStore(ctx);
  return downloadsStore(ctx);
}

/**
 * The ordered READ search list for this conversation (read_file / list_files),
 * mirroring context inheritance: a project chat sees BOTH its project and its
 * (inherited) workspace files; a workspace chat sees the workspace; an unfiled
 * chat sees Downloads. Crucially, callers use `findByName`/`list` only — never
 * `ensureFolder` — so a read never creates a Drive folder as a side effect.
 * @param {Object} ctx - ToolContext ({ userId, workspace, project })
 * @returns {FileStore[]} search order (most specific first)
 */
function resolveReadStores(ctx) {
  if (ctx.project) {
    const stores = [projectStore(ctx)];
    if (ctx.workspace) stores.push(workspaceStore(ctx));
    return stores;
  }
  if (ctx.workspace) return [workspaceStore(ctx)];
  return [downloadsStore(ctx)];
}

/**
 * Resolve the user's Drive auth for a tool, converting the "not connected"
 * case (e.g. dev login) into a reusable reason string instead of a throw —
 * so create_file / read_file can return a friendly isError result. The
 * reconnect wording lives here so the file tools stay consistent.
 * @param {string} userId
 * @returns {{auth: object}|{unavailable: string}}
 */
function resolveToolDriveAuth(userId) {
  try {
    return { auth: drive.getAuthForUser(userId) };
  } catch (err) {
    return { unavailable: 'Google Drive is not connected for this account. Ask the user to reconnect Google Drive in Tessera.' };
  }
}

module.exports = { resolveFileStore, resolveReadStores, resolveToolDriveAuth };
