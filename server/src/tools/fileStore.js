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
    remove: (fileId) => dal.deleteProjectFile(fileId, projectId),
    get: (fileId) => dal.getProjectFile(fileId, projectId),
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
    remove: (fileId) => dal.deleteWorkspaceFile(fileId, workspaceId),
    get: (fileId) => dal.getWorkspaceFile(fileId, workspaceId),
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
    remove: (fileId) => dal.deleteUserFile(fileId, userId),
    get: (fileId) => dal.getUserFile(fileId, userId),
    urlFor: (fileId) => `/api/files/${fileId}/content`,
  };
}

function conversationStore(ctx) {
  const conversationId = ctx.conversationId;
  return {
    kind: 'conversation',
    label: 'this chat',
    ensureFolder: (auth) => drive.ensureConversationFolder(auth, conversationId),
    findByName: (name) => dal.getConversationFileByName(conversationId, name),
    list: () => dal.listConversationFiles(conversationId),
    add: (data) => dal.addConversationFile(conversationId, data),
    updateContent: (fileId, data) => dal.updateConversationFileContent(fileId, conversationId, data),
    remove: (fileId) => dal.deleteConversationFile(fileId, conversationId),
    get: (fileId) => dal.getConversationFile(fileId, conversationId),
    urlFor: (fileId) => `/api/conversations/${conversationId}/files/${fileId}/content`,
  };
}

/**
 * The single WRITE destination for a create_file call (File Collaboration,
 * FC-01): files a chat creates land in the CHAT's own scope, regardless of its
 * home, so scratch output never joins the always-injected project/workspace
 * knowledge base. The container-precedence fallback (project → workspace →
 * Downloads) is retained ONLY for callers without a conversation — e.g. the
 * `/api/files` Downloads save route, which passes no conversationId.
 * @param {Object} ctx - ToolContext ({ userId, workspace, project, conversationId })
 * @returns {FileStore}
 */
function resolveFileStore(ctx) {
  if (ctx.conversationId) return conversationStore(ctx);
  if (ctx.project) return projectStore(ctx);
  if (ctx.workspace) return workspaceStore(ctx);
  return downloadsStore(ctx);
}

/**
 * The ordered READ search list for this conversation (read_file / list_files),
 * most-specific first. Since FC-01 the chat's own `conversation` scope is
 * searched FIRST (files it created live there), then the inherited container
 * chain: a project chat also sees its project AND its (inherited) workspace
 * files; a workspace chat also sees the workspace; an unfiled chat also sees
 * Downloads (retained so files created in unfiled chats before FC-01 stay
 * readable). Crucially, callers use `findByName`/`list` only — never
 * `ensureFolder` — so a read never creates a Drive folder as a side effect.
 * @param {Object} ctx - ToolContext ({ userId, workspace, project, conversationId })
 * @returns {FileStore[]} search order (most specific first)
 */
function resolveReadStores(ctx) {
  const stores = [];
  if (ctx.conversationId) stores.push(conversationStore(ctx));
  if (ctx.project) {
    stores.push(projectStore(ctx));
    if (ctx.workspace) stores.push(workspaceStore(ctx));
  } else if (ctx.workspace) {
    stores.push(workspaceStore(ctx));
  } else {
    stores.push(downloadsStore(ctx));
  }
  return stores;
}

/**
 * Resolve a WRITE store for an explicit destination kind (File Collaboration,
 * FC-05, move_file). Unlike resolveFileStore (which picks by precedence), this
 * returns the store the caller named, or a reason string when that destination
 * isn't available in this conversation (e.g. "project" from an unfiled chat).
 * @param {Object} ctx - ToolContext
 * @param {'conversation'|'project'|'workspace'|'downloads'} kind
 * @returns {{store: FileStore}|{unavailable: string}}
 */
function resolveDestinationStore(ctx, kind) {
  switch (kind) {
    case 'conversation':
      if (!ctx.conversationId) return { unavailable: 'this chat has no file scope.' };
      return { store: conversationStore(ctx) };
    case 'project':
      if (!ctx.project) return { unavailable: 'this chat is not in a project.' };
      return { store: projectStore(ctx) };
    case 'workspace':
      if (!ctx.workspace) return { unavailable: 'this chat is not in a workspace.' };
      return { store: workspaceStore(ctx) };
    case 'downloads':
      return { store: downloadsStore(ctx) };
    default:
      return { unavailable: `"${kind}" is not a valid destination.` };
  }
}

/**
 * Find a file by exact name across an ordered store list (most specific
 * first). Also reports any LESS-specific stores that hold the same name
 * (shadowing) so callers can disambiguate for the user. Shared by read_file
 * and edit_file so both resolve a filename to the same store the same way.
 * @param {FileStore[]} stores - resolveReadStores(ctx)
 * @param {string} filename
 * @returns {{file: Object, store: FileStore, shadowedKinds: string[]}|null}
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

module.exports = { resolveFileStore, resolveReadStores, resolveDestinationStore, findAcrossStores, resolveToolDriveAuth };
