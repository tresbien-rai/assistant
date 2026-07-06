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

/**
 * @param {Object} ctx - ToolContext ({ userId, workspace, project })
 * @returns {FileStore}
 */
function resolveFileStore(ctx) {
  if (ctx.project) {
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
  if (ctx.workspace) {
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

module.exports = { resolveFileStore };
