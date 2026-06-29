/**
 * Context Layering Test (Workspace Restructure, WR-02a)
 *
 * Verifies that a chat request assembles workspace + project context in the
 * right order (workspace first, then project, then the persona prompt) and that
 * each chat "home" inherits the correct layers. Instructions-only, so no Google
 * Drive is needed. Runs against the app DB and cleans up after itself.
 *
 * Run with: node src/routes/test-context.js
 */

const { getDb, closeDb } = require('../db/connection');
const dal = require('../db/dal');
const { resolveRequestContext, applyRequestContext } = require('./chat');

let failures = 0;
function check(label, cond) {
  console.log(`   ${cond ? '✓' : '✗'} ${label}`);
  if (!cond) failures++;
}

// Minimal req stub: the resolver only reads req.user.userId + req.body.
const reqFor = (userId, body) => ({ user: { userId }, body });

(async () => {
  console.log('='.repeat(60));
  console.log('Context Layering Test (WR-02a)');
  console.log('='.repeat(60));

  const db = getDb();
  let userId;

  try {
    const user = dal.createUser({ googleId: `ctx-test-${Date.now()}`, email: 'ctx@test.local' });
    userId = user.id;
    const persona = dal.createPersona(userId, { name: 'Tester', systemPrompt: 'PERSONA_PROMPT' });

    const workspace = dal.createWorkspace(userId, { name: 'WS', instructions: 'WS_INSTRUCTIONS' });
    const project = dal.createProject(userId, {
      workspaceId: workspace.id,
      name: 'PROJ',
      instructions: 'PROJ_INSTRUCTIONS',
    });

    const projectChat = dal.createConversation(userId, {
      personaId: persona.id, title: 'p', workspaceId: workspace.id, projectId: project.id,
    });
    const workspaceChat = dal.createConversation(userId, {
      personaId: persona.id, title: 'w', workspaceId: workspace.id,
    });
    const unfiledChat = dal.createConversation(userId, { personaId: persona.id, title: 'u' });

    // --- Project-level chat: both layers, workspace BEFORE project ----------
    console.log('\n1. Project-level chat inherits workspace + project (ordered)...');
    const pCtx = await resolveRequestContext(reqFor(userId, { conversationId: projectChat.id }));
    check('context assembled', !!pCtx?.text);
    const wsIdx = pCtx.text.indexOf('WS_INSTRUCTIONS');
    const projIdx = pCtx.text.indexOf('PROJ_INSTRUCTIONS');
    check('workspace instructions present', wsIdx !== -1);
    check('project instructions present', projIdx !== -1);
    check('workspace block precedes project block', wsIdx !== -1 && projIdx !== -1 && wsIdx < projIdx);
    check('has <workspace_context> wrapper', pCtx.text.includes('<workspace_context>'));
    check('has <project_context> wrapper', pCtx.text.includes('<project_context>'));

    const sys = applyRequestContext(pCtx, 'PERSONA_PROMPT');
    check('persona prompt comes last', sys.indexOf('PERSONA_PROMPT') > sys.indexOf('PROJ_INSTRUCTIONS'));

    // --- Workspace-level chat: workspace only -------------------------------
    console.log('\n2. Workspace-level chat inherits workspace only...');
    const wCtx = await resolveRequestContext(reqFor(userId, { conversationId: workspaceChat.id }));
    check('workspace instructions present', wCtx?.text.includes('WS_INSTRUCTIONS'));
    check('project instructions absent', !wCtx.text.includes('PROJ_INSTRUCTIONS'));

    // --- Unfiled chat: no container context ---------------------------------
    console.log('\n3. Unfiled chat inherits nothing...');
    const uCtx = await resolveRequestContext(reqFor(userId, { conversationId: unfiledChat.id }));
    check('no context block', uCtx === null);

    // --- New (unsaved) chat via explicit ids; project derives its workspace --
    console.log('\n4. Explicit projectId derives its workspace...');
    const eCtx = await resolveRequestContext(reqFor(userId, { projectId: project.id }));
    check('workspace derived from project', eCtx?.text.includes('WS_INSTRUCTIONS'));
    check('project present too', eCtx.text.includes('PROJ_INSTRUCTIONS'));

    // --- Workspace files fold in (no Drive here → graceful warning) ----------
    // The test user has no Drive tokens, so file bytes can't load; the assembler
    // must still include instructions and surface a workspace-noun warning
    // (exercises the WR-02b file-gathering path + the generalized warning).
    console.log('\n5. Workspace files fold into context (Drive-less degrade)...');
    dal.addWorkspaceFile(workspace.id, { filename: 'ref.md', driveFileId: 'no-drive' });
    const fCtx = await resolveRequestContext(reqFor(userId, { conversationId: workspaceChat.id }));
    check('instructions still present', fCtx?.text.includes('WS_INSTRUCTIONS'));
    check('workspace-noun degrade warning', !!fCtx?.warning && fCtx.warning.startsWith('Workspace files could not be loaded'));

    console.log('\n' + '='.repeat(60));
    if (failures === 0) {
      console.log('All context layering tests passed!');
    } else {
      console.log(`${failures} assertion(s) FAILED`);
    }
    console.log('='.repeat(60) + '\n');
  } catch (err) {
    console.error('\n✗ Context test failed:', err);
    failures++;
  } finally {
    if (userId) db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    closeDb();
  }

  process.exit(failures === 0 ? 0 : 1);
})();
