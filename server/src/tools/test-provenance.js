/**
 * File Provenance Test (P-01..P-03, docs/FILE_PROVENANCE_DESIGN.md)
 *
 * Covers the three states (model / user / unknown), the two capture gaps this
 * feature had to close first (container uploads logging no revision at all, and
 * move_file erasing authorship on promote), and the three surfaces that must
 * agree on the wording.
 *
 * Drive is monkeypatched with an in-memory content store (no network). Cleans
 * up after itself.
 *
 * Run with: node src/tools/test-provenance.js
 */

const assert = require('node:assert');
const { getDb, closeDb } = require('../db/connection');
const dal = require('../db/dal');
const drive = require('../utils/drive');
const { executeCreateFile } = require('./createFile');
const { executeListFiles } = require('./readFiles');
const { executeMoveFile } = require('./moveFile');
const { writeContentToStore } = require('./storeWriter');
const { resolveFileStore } = require('./fileStore');
const { describeProvenance, provenanceSuffix } = require('../utils/provenance');
const {
  _buildAvailableFilesSection: buildAvailableFilesSection,
  _gatherFileTexts: gatherFileTexts,
} = require('../utils/projectContext');

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

// --- Drive mock -------------------------------------------------------------
let uploadSeq = 0;
const contents = new Map();
const realDrive = { ...drive };
function installDriveMock() {
  drive.getAuthForUser = () => ({ mock: true });
  drive.ensureConversationFolder = async () => 'folder_conversation';
  drive.ensureProjectFolderId = async () => 'folder_project';
  drive.ensureWorkspaceFolderId = async () => 'folder_workspace';
  drive.uploadFile = async (auth, { name, data }) => {
    const id = `drive_${++uploadSeq}`;
    contents.set(id, Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    return { id, name };
  };
  drive.downloadFileBytes = async (auth, fileId) => {
    if (!contents.has(fileId)) throw new Error(`no such mock file ${fileId}`);
    return Buffer.from(contents.get(fileId), 'utf8');
  };
  drive.moveFileToFolder = async () => true;
  drive.trashFile = async () => true;
  drive.deleteFile = async () => true;
}
function restoreDrive() {
  Object.assign(drive, realDrive);
}

(async () => {
  console.log('='.repeat(60));
  console.log('File Provenance Test (P-01..P-03)');
  console.log('='.repeat(60));

  const db = getDb();
  let userId;
  installDriveMock();

  try {
    const user = dal.createUser({ googleId: `prov-test-${Date.now()}`, email: 'prov@test.local' });
    userId = user.id;
    const workspace = dal.createWorkspace(userId, { name: 'WS', instructions: '' });
    const project = dal.createProject(userId, { workspaceId: workspace.id, name: 'PROJ', instructions: '' });
    const conv = dal.createConversation(userId, { title: 'C', projectId: project.id, workspaceId: workspace.id });
    const ctx = { userId, workspace, project, conversationId: conv.id };

    // -----------------------------------------------------------------------
    console.log('\n1. The three states...');

    await check('a model-created file reads as "model"', async () => {
      const res = await executeCreateFile({ filename: 'mine.md', content: 'by the model' }, ctx);
      assert.ok(!res.isError, res.content);
      const f = dal.getConversationFileByName(conv.id, 'mine.md');
      assert.strictEqual(dal.getFileProvenance('conversation', f.id), 'model');
    });

    await check('a user-uploaded file reads as "user"', async () => {
      // Mirrors routes/conversations.js: the user upload path writes through
      // the shared store with an author:'user' revision.
      const auth = drive.getAuthForUser(userId);
      const store = resolveFileStore(ctx);
      await writeContentToStore(auth, store, {
        filename: 'theirs.md',
        mimeType: 'text/plain',
        bytes: Buffer.from('by the user', 'utf8'),
        userId,
        revision: { author: 'user', conversationId: conv.id, turn: 1 },
      });
      const f = dal.getConversationFileByName(conv.id, 'theirs.md');
      assert.strictEqual(dal.getFileProvenance('conversation', f.id), 'user');
    });

    await check('a file with no revision log reads as "unknown", NOT "user"', () => {
      // The ghost-file case: collapsing unknown into user would have silently
      // attributed it and closed that question wrongly.
      const orphan = dal.addProjectFile(project.id, {
        filename: 'legacy.md', mimeType: 'text/plain', sizeBytes: 5, driveFileId: 'drive_legacy',
      });
      assert.strictEqual(dal.getFileProvenance('project', orphan.id), 'unknown');
      dal.deleteProjectFile(orphan.id, project.id);
    });

    await check('provenance is ORIGIN, not last-touch: a user file the model edits stays "user"', async () => {
      const f = dal.getConversationFileByName(conv.id, 'theirs.md');
      dal.addFileRevision({
        scope: 'conversation', fileId: f.id, conversationId: conv.id,
        author: 'model', op: 'edit', sizeBytes: 9,
      });
      assert.strictEqual(dal.getFileProvenance('conversation', f.id), 'user');
    });

    // -----------------------------------------------------------------------
    console.log('\n2. The batch form...');

    await check('one call answers many files, and omits unknown ones', () => {
      const mine = dal.getConversationFileByName(conv.id, 'mine.md');
      const theirs = dal.getConversationFileByName(conv.id, 'theirs.md');
      const map = dal.getFileProvenanceBatch('conversation', [mine.id, theirs.id, 'no-such-id']);
      assert.strictEqual(map.get(mine.id), 'model');
      assert.strictEqual(map.get(theirs.id), 'user');
      assert.ok(!map.has('no-such-id'), 'an unknown file must be ABSENT, not defaulted');
    });

    await check('an empty list makes no query and returns an empty map', () => {
      assert.strictEqual(dal.getFileProvenanceBatch('conversation', []).size, 0);
      assert.strictEqual(dal.getFileProvenanceBatch('conversation', null).size, 0);
    });

    await check('scope is respected — same id in another scope does not leak', () => {
      const mine = dal.getConversationFileByName(conv.id, 'mine.md');
      assert.ok(!dal.getFileProvenanceBatch('project', [mine.id]).has(mine.id));
    });

    // -----------------------------------------------------------------------
    console.log('\n3. Gap A: container uploads log a revision (P-01)...');

    await check('a project file uploaded through the route path has a user create row', () => {
      // Mirrors routes/projects.js: addProjectFile + its own revision row.
      const rec = dal.addProjectFile(project.id, {
        filename: 'uploaded.md', mimeType: 'text/plain', sizeBytes: 3, driveFileId: 'drive_up',
      });
      dal.addFileRevision({
        scope: 'project', fileId: rec.id, author: 'user', op: 'create',
        sizeBytes: 3, driveFileId: 'drive_up',
      });
      assert.strictEqual(dal.getFileProvenance('project', rec.id), 'user');
      const rows = dal.listFileRevisions('project', rec.id);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].conversation_id, null, 'a container upload belongs to no chat');
    });

    // -----------------------------------------------------------------------
    console.log('\n4. Gap B: move_file carries origin instead of erasing it (P-01)...');

    await check('a model file promoted to the project still reads as "model"', async () => {
      const res = await executeMoveFile({ filename: 'mine.md', destination: 'project' }, ctx);
      assert.ok(!res.isError, res.content);
      const moved = dal.listProjectFiles(project.id).find((f) => f.filename === 'mine.md');
      assert.ok(moved, 'the file landed in the project');
      assert.strictEqual(dal.getFileProvenance('project', moved.id), 'model',
        'promoting a model file must not erase its authorship');
    });

    await check('the re-seeded row carries no conversation or turn', () => {
      const moved = dal.listProjectFiles(project.id).find((f) => f.filename === 'mine.md');
      const rows = dal.listFileRevisions('project', moved.id);
      assert.strictEqual(rows.length, 1, 'one origin row, not the whole transplanted log');
      assert.strictEqual(rows[0].conversation_id, null, 'must not rejoin the re-roll queries it left');
      assert.strictEqual(rows[0].turn, null);
    });

    await check('the source log is still cleared', () => {
      assert.strictEqual(dal.getConversationFileByName(conv.id, 'mine.md'), undefined);
    });

    // -----------------------------------------------------------------------
    console.log('\n5. Wording is shared, and unknown is silent...');

    await check('the three states render as expected', () => {
      assert.strictEqual(describeProvenance('model'), 'you created this');
      assert.strictEqual(describeProvenance('user'), 'uploaded by the user');
      assert.strictEqual(describeProvenance('unknown'), '');
      assert.strictEqual(describeProvenance(undefined), '', 'a missing map key renders as nothing');
    });

    await check('the suffix form parenthesises, and stays empty when unknown', () => {
      assert.strictEqual(provenanceSuffix('model'), ' (you created this)');
      assert.strictEqual(provenanceSuffix('unknown'), '');
    });

    // -----------------------------------------------------------------------
    console.log('\n6. Surface: the <available_files> manifest...');

    const files = [
      { id: 'f1', filename: 'a.md' },
      { id: 'f2', filename: 'b.md' },
      { id: 'f3', filename: 'c.md' },
    ];
    const provMap = new Map([['f1', 'model'], ['f2', 'user']]);

    await check('names carry their origin; an unknown file gets no suffix', () => {
      const out = buildAvailableFilesSection({ name: 'PROJ' }, files, 'project', provMap);
      assert.match(out, /a\.md \(you created this\)/);
      assert.match(out, /b\.md \(uploaded by the user\)/);
      assert.match(out, /c\.md(,|\.)/, 'c.md must appear bare, with no parenthetical');
    });

    await check('the model is told the parenthetical is not part of the filename', () => {
      // Without this the sentence says "call read_file with its exact name"
      // directly before a decorated name.
      const out = buildAvailableFilesSection({ name: 'PROJ' }, files, 'project', provMap);
      assert.match(out, /not part of its name/);
    });

    await check('no provenance at all → no note, and the old wording is unchanged', () => {
      const out = buildAvailableFilesSection({ name: 'PROJ' }, files, 'project', new Map());
      assert.ok(!/not part of its name/.test(out), 'the note must not appear when nothing is tagged');
      assert.match(out, /exact name: a\.md, b\.md, c\.md\./);
    });

    await check('provenance defaults to none when the argument is omitted', () => {
      const out = buildAvailableFilesSection({ name: 'PROJ' }, files, 'project');
      assert.match(out, /exact name: a\.md, b\.md, c\.md\./);
    });

    // -----------------------------------------------------------------------
    console.log('\n7. Surface: the loaded-file header...');

    await check('the header carries the same phrase', async () => {
      const res = await gatherFileTexts(
        userId, { id: project.id, name: 'PROJ' },
        [{ id: 'f1', filename: 'a.md', drive_file_id: 'drive_1', mime_type: 'text/plain' }],
        10000, provMap
      );
      assert.match(res.sections[0], /^### File: a\.md \(you created this\)\n/);
    });

    await check('an unknown file keeps the original bare header', async () => {
      const res = await gatherFileTexts(
        userId, { id: project.id, name: 'PROJ' },
        [{ id: 'f3', filename: 'c.md', drive_file_id: 'drive_1', mime_type: 'text/plain' }],
        10000, provMap
      );
      assert.match(res.sections[0], /^### File: c\.md\n/);
    });

    // -----------------------------------------------------------------------
    console.log('\n8. Surface: list_files...');

    await check('list_files reports the same phrase as the manifest', async () => {
      const out = await executeListFiles({}, ctx);
      assert.ok(!out.isError, out.content);
      assert.match(out.content, /theirs\.md \([^)]*uploaded by the user\)/);
      assert.match(out.content, /mine\.md \([^)]*you created this\)/);
    });

    await check('a file with no origin lists without any provenance phrase', async () => {
      const rec = dal.addProjectFile(project.id, {
        filename: 'orphan.md', mimeType: 'text/plain', sizeBytes: 4, driveFileId: 'drive_o',
      });
      const out = await executeListFiles({}, ctx);
      const line = out.content.split('\n').find((l) => l.includes('orphan.md'));
      assert.ok(line, 'orphan.md is listed');
      assert.ok(!/you created this|uploaded by the user/.test(line),
        'an unknown file must claim no origin');
      dal.deleteProjectFile(rec.id, project.id);
    });

    console.log('');
    if (failures > 0) {
      console.error(`${failures} provenance test(s) FAILED`);
      process.exitCode = 1;
    } else {
      console.log('='.repeat(60));
      console.log('All file provenance tests passed!');
      console.log('='.repeat(60));
    }
  } finally {
    restoreDrive();
    if (userId) {
      try { db.prepare('DELETE FROM users WHERE id = ?').run(userId); } catch { /* noop */ }
    }
    closeDb();
  }
})();
