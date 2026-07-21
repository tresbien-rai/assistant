/**
 * read_file + list_files Executor Test (Track A, P2-04)
 *
 * Runs the real executors against the app DB with Drive's byte download
 * monkeypatched (no network). Exercises: read scope (chat's own conversation
 * scope searched first, then project + inherited workspace), Downloads scope for
 * unfiled chats, the budget truncation, not-found / no-content / Drive-less
 * results, and the list_files formatting incl. the cross-store "in <source>" hint.
 *
 * Run with: node src/tools/test-readfiles.js
 */

const assert = require('node:assert');
const { getDb, closeDb } = require('../db/connection');
const dal = require('../db/dal');
const drive = require('../utils/drive');
const config = require('../config');
const projectContext = require('../utils/projectContext');
const { executeReadFile, executeListFiles } = require('./readFiles');

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`   ✓ ${label}`);
  } catch (err) {
    console.log(`   ✗ ${label}`);
    console.log(`      ${err.message}`);
    failures++;
  }
}

// --- Drive mock: serve bytes from an in-memory map keyed by drive_file_id ----
const driveBytes = new Map();
let driveConnected = true;
const realDrive = { ...drive };
function installDriveMock() {
  drive.getAuthForUser = () => {
    if (!driveConnected) {
      const err = new Error('Drive not connected');
      err.code = 'DRIVE_ERROR';
      throw err;
    }
    return { mock: true };
  };
  drive.downloadFileBytes = async (auth, fileId) => {
    if (!driveBytes.has(fileId)) {
      const err = new Error('File not found on Drive');
      throw err;
    }
    return driveBytes.get(fileId);
  };
}
function restoreDrive() {
  Object.assign(drive, realDrive);
}

(async () => {
  console.log('='.repeat(60));
  console.log('read_file + list_files Executor Test (P2-04)');
  console.log('='.repeat(60));

  const db = getDb();
  let userId;
  installDriveMock();

  try {
    const user = dal.createUser({ googleId: `rf-test-${Date.now()}`, email: 'rf@test.local' });
    userId = user.id;
    const workspace = dal.createWorkspace(userId, { name: 'WS', instructions: '' });
    const project = dal.createProject(userId, { workspaceId: workspace.id, name: 'PROJ', instructions: '' });

    // Seed files: one in the project, one in the workspace, one in Downloads.
    const pFile = dal.addProjectFile(project.id, { filename: 'spec.md', mimeType: 'text/markdown', sizeBytes: 5, driveFileId: 'd_proj' });
    driveBytes.set('d_proj', Buffer.from('PROJECT SPEC BODY', 'utf8'));
    const wFile = dal.addWorkspaceFile(workspace.id, { filename: 'style.md', mimeType: 'text/markdown', sizeBytes: 5, driveFileId: 'd_ws' });
    driveBytes.set('d_ws', Buffer.from('WORKSPACE STYLE BODY', 'utf8'));
    const uFile = dal.addUserFile(userId, { filename: 'draft.txt', mimeType: 'text/plain', sizeBytes: 3, driveFileId: 'd_dl' });
    driveBytes.set('d_dl', Buffer.from('DOWNLOADS DRAFT', 'utf8'));

    // FC-01: real conversations (conversation_files rows need a valid FK), plus
    // a file that lives in the project chat's OWN scope to exercise the
    // conversation-first read order.
    const convProject = dal.createConversation(userId, { title: 'P', projectId: project.id, workspaceId: workspace.id });
    const convWorkspace = dal.createConversation(userId, { title: 'W', workspaceId: workspace.id });
    const convUnfiled = dal.createConversation(userId, { title: 'U' });
    dal.addConversationFile(convProject.id, { filename: 'chatnote.md', mimeType: 'text/markdown', sizeBytes: 4, driveFileId: 'd_chat' });
    driveBytes.set('d_chat', Buffer.from('CHAT NOTE BODY', 'utf8'));

    const projectCtx = { userId, workspace, project, conversationId: convProject.id };
    const workspaceCtx = { userId, workspace, project: null, conversationId: convWorkspace.id };
    const unfiledCtx = { userId, workspace: null, project: null, conversationId: convUnfiled.id };

    // Files are immutable per Drive id, but the executor caches by that id;
    // clear between assertions so a truncation test re-reads fresh bytes.
    const clearCache = () => projectContext._textCache.clear();

    console.log('\n1. read_file scope (project chat reads project AND inherited workspace)...');

    await check('reads a project file', async () => {
      const res = await executeReadFile({ filename: 'spec.md' }, projectCtx);
      assert.ok(!res.isError, res.content);
      assert.match(res.content, /PROJECT SPEC BODY/);
      assert.strictEqual(res.display.source, 'project');
    });

    await check('reads an inherited workspace file from a project chat', async () => {
      const res = await executeReadFile({ filename: 'style.md' }, projectCtx);
      assert.ok(!res.isError, res.content);
      assert.match(res.content, /WORKSPACE STYLE BODY/);
      assert.strictEqual(res.display.source, 'workspace');
    });

    await check('a project chat does NOT read the user Downloads', async () => {
      const res = await executeReadFile({ filename: 'draft.txt' }, projectCtx);
      assert.ok(res.isError, 'should not find the Downloads file');
    });

    await check('unfiled chat reads its Downloads file', async () => {
      const res = await executeReadFile({ filename: 'draft.txt' }, unfiledCtx);
      assert.ok(!res.isError, res.content);
      assert.match(res.content, /DOWNLOADS DRAFT/);
      assert.strictEqual(res.display.source, 'downloads');
    });

    await check('unfiled chat cannot read project/workspace files', async () => {
      const res = await executeReadFile({ filename: 'spec.md' }, unfiledCtx);
      assert.ok(res.isError);
    });

    await check('shadowing: project copy wins + a note flags the workspace twin', async () => {
      // Same filename in BOTH the project and the (inherited) workspace.
      const dupW = dal.addWorkspaceFile(workspace.id, { filename: 'dup.md', driveFileId: 'd_dupw' });
      driveBytes.set('d_dupw', Buffer.from('WORKSPACE DUP', 'utf8'));
      const dupP = dal.addProjectFile(project.id, { filename: 'dup.md', driveFileId: 'd_dupp' });
      driveBytes.set('d_dupp', Buffer.from('PROJECT DUP', 'utf8'));
      clearCache();
      const res = await executeReadFile({ filename: 'dup.md' }, projectCtx);
      assert.ok(!res.isError, res.content);
      assert.match(res.content, /PROJECT DUP/, 'reads the project copy');
      assert.strictEqual(res.display.source, 'project');
      assert.deepStrictEqual(res.display.shadowedBy, ['workspace']);
      assert.match(res.content, /also exists in the workspace/);
      dal.deleteProjectFile(dupP.id, project.id);
      dal.deleteWorkspaceFile(dupW.id, workspace.id);
    });

    console.log('\n1b. conversation scope is searched first (FC-01)...');

    await check('reads a file created in this chat (conversation scope)', async () => {
      const res = await executeReadFile({ filename: 'chatnote.md' }, projectCtx);
      assert.ok(!res.isError, res.content);
      assert.match(res.content, /CHAT NOTE BODY/);
      assert.strictEqual(res.display.source, 'conversation');
    });

    await check('a chat file shadows an inherited project file of the same name', async () => {
      const twinP = dal.addProjectFile(project.id, { filename: 'twin.md', driveFileId: 'd_twinp' });
      driveBytes.set('d_twinp', Buffer.from('PROJECT TWIN', 'utf8'));
      dal.addConversationFile(convProject.id, { filename: 'twin.md', driveFileId: 'd_twinc' });
      driveBytes.set('d_twinc', Buffer.from('CHAT TWIN', 'utf8'));
      clearCache();
      const res = await executeReadFile({ filename: 'twin.md' }, projectCtx);
      assert.ok(!res.isError, res.content);
      assert.match(res.content, /CHAT TWIN/, 'reads the chat copy');
      assert.strictEqual(res.display.source, 'conversation');
      assert.deepStrictEqual(res.display.shadowedBy, ['project']);
      // Clean up so the later list_files assertions stay focused.
      dal.deleteProjectFile(twinP.id, project.id);
      dal.deleteConversationFile(dal.getConversationFileByName(convProject.id, 'twin.md').id, convProject.id);
    });

    console.log('\n2. read_file error results...');

    await check('missing filename -> isError', async () => {
      const res = await executeReadFile({}, projectCtx);
      assert.ok(res.isError);
    });

    await check('unknown filename -> isError with a hint', async () => {
      const res = await executeReadFile({ filename: 'nope.md' }, projectCtx);
      assert.ok(res.isError);
      assert.match(res.content, /list_files/);
    });

    await check('Drive-not-connected -> readable isError', async () => {
      driveConnected = false;
      clearCache();
      const res = await executeReadFile({ filename: 'spec.md' }, projectCtx);
      assert.ok(res.isError);
      assert.match(res.content, /Google Drive is not connected/);
      driveConnected = true;
    });

    await check('Drive download failure -> isError, not a throw', async () => {
      clearCache();
      const orphan = dal.addProjectFile(project.id, { filename: 'orphan.md', driveFileId: 'd_missing' });
      const res = await executeReadFile({ filename: 'orphan.md' }, projectCtx);
      assert.ok(res.isError);
      dal.deleteProjectFile(orphan.id, project.id);
    });

    console.log('\n3. read_file budget truncation...');

    await check('content longer than the cap is truncated with a note', async () => {
      clearCache();
      const big = 'A'.repeat(config.projectFiles.toolReadMaxChars + 500);
      dal.addProjectFile(project.id, { filename: 'big.md', driveFileId: 'd_big' });
      driveBytes.set('d_big', Buffer.from(big, 'utf8'));
      const res = await executeReadFile({ filename: 'big.md' }, projectCtx);
      assert.ok(!res.isError, res.content);
      assert.ok(res.display.truncated, 'flagged truncated');
      assert.match(res.content, /truncated to the first/);
      // Body (after the header line) is capped at the configured max.
      const body = res.content.split('\n\n').slice(1).join('\n\n');
      assert.strictEqual(body.length, config.projectFiles.toolReadMaxChars);
    });

    console.log('\n4. list_files...');

    await check('project chat lists project + workspace files with source hints', async () => {
      const res = await executeListFiles({}, projectCtx);
      assert.ok(!res.isError, res.content);
      assert.match(res.content, /spec\.md/);
      assert.match(res.content, /style\.md/);
      assert.match(res.content, /in project/);
      assert.match(res.content, /in workspace/);
    });

    await check('unfiled chat lists its chat scope + Downloads, not project files', async () => {
      // An unfiled chat now spans two read stores (its own conversation scope +
      // legacy Downloads), so source hints ARE shown to tell them apart.
      const res = await executeListFiles({}, unfiledCtx);
      assert.match(res.content, /draft\.txt/);
      assert.match(res.content, /in downloads/);
      assert.doesNotMatch(res.content, /spec\.md/);
    });

    await check('empty scope lists nothing (workspace with no files)', async () => {
      const emptyWs = dal.createWorkspace(userId, { name: 'EMPTY', instructions: '' });
      const res = await executeListFiles({}, { userId, workspace: emptyWs, project: null });
      assert.strictEqual(res.display.count, 0);
      assert.match(res.content, /no files/i);
    });

  } catch (err) {
    console.error('\n✗ read/list test crashed:', err);
    failures++;
  } finally {
    restoreDrive();
    if (userId) db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    closeDb();
  }

  console.log('\n' + '='.repeat(60));
  if (failures === 0) {
    console.log('All read_file + list_files executor tests passed!');
  } else {
    console.log(`${failures} assertion(s) FAILED`);
  }
  console.log('='.repeat(60) + '\n');
  process.exit(failures === 0 ? 0 : 1);
})();
