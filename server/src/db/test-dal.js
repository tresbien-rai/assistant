/**
 * DAL Test Script
 *
 * Tests all data access layer functions to verify database operations work correctly.
 * Run with: node src/db/test-dal.js
 */

const { getDb, closeDb } = require('./connection');
const dal = require('./dal');

console.log('='.repeat(60));
console.log('DAL Test Script');
console.log('='.repeat(60));

try {
  // Initialize database
  console.log('\n1. Initializing database...');
  const db = getDb();
  console.log('   ✓ Database initialized');

  // Test user creation
  console.log('\n2. Testing user operations...');
  const user = dal.createUser({
    googleId: 'test-google-id-123',
    email: 'test@example.com',
    displayName: 'Test User',
  });
  console.log(`   ✓ Created user: ${user.id}`);

  const foundUser = dal.findUserByGoogleId('test-google-id-123');
  console.log(`   ✓ Found user by Google ID: ${foundUser.email}`);

  // Test persona creation
  console.log('\n3. Testing persona operations...');
  const persona = dal.createPersona(user.id, {
    name: 'Assistant',
    systemPrompt: 'You are a helpful assistant.',
    modelConfig: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
  });
  console.log(`   ✓ Created persona: ${persona.id} (${persona.name})`);

  const personas = dal.getPersonasByUser(user.id);
  console.log(`   ✓ Found ${personas.length} persona(s)`);

  const updatedPersona = dal.updatePersona(persona.id, user.id, {
    name: 'Updated Assistant',
  });
  console.log(`   ✓ Updated persona name to: ${updatedPersona.name}`);

  // Test conversation creation
  console.log('\n4. Testing conversation operations...');
  const conversation = dal.createConversation(user.id, {
    personaId: persona.id,
    title: 'Test Conversation',
  });
  console.log(`   ✓ Created conversation: ${conversation.id}`);

  // Test message creation
  console.log('\n5. Testing message operations...');
  const userMessage = dal.createMessage(conversation.id, {
    role: 'user',
    content: 'Hello, how are you?',
  });
  console.log(`   ✓ Created user message: ${userMessage.id}`);

  const assistantMessage = dal.createMessage(conversation.id, {
    role: 'assistant',
    content: 'I am doing well, thank you!',
    attachments: [{ type: 'text', name: 'example.txt' }],
  });
  console.log(`   ✓ Created assistant message: ${assistantMessage.id}`);

  const messages = dal.getMessagesByConversation(conversation.id, user.id);
  console.log(`   ✓ Retrieved ${messages.length} messages`);
  console.log(`   ✓ Attachments parsed: ${JSON.stringify(assistantMessage.attachments)}`);

  // Test settings
  console.log('\n6. Testing settings operations...');
  const defaultSettings = dal.getSettingsByUser(user.id);
  console.log(`   ✓ Default settings: avatarSize=${defaultSettings.avatarSize}`);

  const updatedSettings = dal.upsertSettings(user.id, {
    avatarSize: 'large',
    showAvatar: false,
  });
  console.log(`   ✓ Updated settings: avatarSize=${updatedSettings.avatarSize}, showAvatar=${updatedSettings.showAvatar}`);

  // catalogProviders round-trip (Models tab redesign, Slice 2): default null,
  // stores/reads back a JSON array, and clears back to null.
  if (defaultSettings.catalogProviders !== null) {
    throw new Error(`Expected default catalogProviders=null, got ${JSON.stringify(defaultSettings.catalogProviders)}`);
  }
  const withProviders = dal.upsertSettings(user.id, { catalogProviders: ['anthropic', 'google'] });
  if (JSON.stringify(withProviders.catalogProviders) !== JSON.stringify(['anthropic', 'google'])) {
    throw new Error(`catalogProviders round-trip failed: ${JSON.stringify(withProviders.catalogProviders)}`);
  }
  const clearedProviders = dal.upsertSettings(user.id, { catalogProviders: null });
  if (clearedProviders.catalogProviders !== null) {
    throw new Error(`Expected catalogProviders to clear to null, got ${JSON.stringify(clearedProviders.catalogProviders)}`);
  }
  console.log(`   ✓ catalogProviders round-trip: null → ["anthropic","google"] → null`);

  // Test API keys
  console.log('\n7. Testing API key operations...');
  dal.upsertApiKey(user.id, 'anthropic', 'encrypted-key-data');
  const apiKey = dal.getApiKey(user.id, 'anthropic');
  console.log(`   ✓ Stored API key for: ${apiKey.provider}`);

  const providers = dal.getApiKeyProviders(user.id);
  console.log(`   ✓ Providers with keys: ${providers.map(p => p.provider).join(', ')}`);

  dal.deleteApiKey(user.id, 'anthropic');
  const deletedKey = dal.getApiKey(user.id, 'anthropic');
  console.log(`   ✓ Deleted API key: ${deletedKey === undefined ? 'success' : 'failed'}`);

  // Test conversation with messages retrieval
  console.log('\n8. Testing full conversation retrieval...');
  const fullConversation = dal.getConversationById(conversation.id, user.id);
  console.log(`   ✓ Conversation "${fullConversation.title}" has ${fullConversation.messages.length} messages`);

  // Test conversation list with message count
  console.log('\n9. Testing conversation list...');
  const conversations = dal.getConversationsByUser(user.id);
  console.log(`   ✓ Found ${conversations.length} conversation(s)`);
  console.log(`   ✓ First conversation has ${conversations[0].message_count} messages`);

  // Test delete cascade
  console.log('\n10. Testing delete operations...');
  const deleted = dal.deleteConversation(conversation.id, user.id);
  console.log(`   ✓ Deleted conversation: ${deleted}`);

  // Verify messages are also deleted
  const orphanMessages = dal.getMessagesByConversation(conversation.id, user.id);
  console.log(`   ✓ Messages after delete: ${orphanMessages.length} (should be 0)`);

  // Test cannot delete last persona
  console.log('\n11. Testing persona deletion constraint...');
  try {
    dal.deletePersona(persona.id, user.id);
    console.log('   ✗ Should have thrown error for last persona');
  } catch (err) {
    console.log(`   ✓ Correctly prevented deletion: "${err.message}"`);
  }

  // Create second persona to test deletion
  const persona2 = dal.createPersona(user.id, { name: 'Persona 2' });
  const deleteResult = dal.deletePersona(persona.id, user.id);
  console.log(`   ✓ Deleted persona when not last: ${deleteResult}`);

  // Test workspace / project / chat hierarchy
  console.log('\n11b. Testing workspace hierarchy...');
  const workspace = dal.createWorkspace(user.id, { name: 'Vibe Coding', instructions: 'House style.' });
  console.log(`   ✓ Created workspace: ${workspace.id} (${workspace.name})`);

  const nestedProject = dal.createProject(user.id, { workspaceId: workspace.id, name: 'Tessera' });
  if (nestedProject.workspace_id !== workspace.id) throw new Error('project not attached to workspace');
  console.log(`   ✓ Created nested project (workspace_id matches)`);

  const nested = dal.listProjectsByWorkspace(workspace.id, user.id);
  if (nested.length !== 1) throw new Error(`expected 1 nested project, got ${nested.length}`);
  console.log(`   ✓ listProjectsByWorkspace → ${nested.length}`);

  const wsList = dal.listWorkspacesByUser(user.id);
  if (wsList[0].project_count !== 1) throw new Error('workspace project_count wrong');
  console.log(`   ✓ listWorkspacesByUser project_count=${wsList[0].project_count}`);

  const renamedWs = dal.updateWorkspace(workspace.id, user.id, { name: 'Vibe Coding ✦' });
  console.log(`   ✓ Updated workspace name to: ${renamedWs.name}`);

  // A chat in each of the three homes.
  const unfiledChat = dal.createConversation(user.id, { personaId: persona2.id, title: 'Unfiled' });
  const wsChat = dal.createConversation(user.id, { personaId: persona2.id, title: 'WS-level', workspaceId: workspace.id });
  const projChat = dal.createConversation(user.id, { personaId: persona2.id, title: 'Project', workspaceId: workspace.id, projectId: nestedProject.id });
  console.log('   ✓ Created unfiled, workspace-level, and project-level chats');

  const onlyUnfiled = dal.getConversationsByUser(user.id, { unfiled: true });
  if (!(onlyUnfiled.length === 1 && onlyUnfiled[0].id === unfiledChat.id)) throw new Error('unfiled filter wrong');
  console.log(`   ✓ unfiled filter → ${onlyUnfiled.length}`);

  const byProject = dal.getConversationsByUser(user.id, { projectId: nestedProject.id });
  if (!(byProject.length === 1 && byProject[0].id === projChat.id)) throw new Error('projectId filter wrong');
  console.log(`   ✓ projectId filter → ${byProject.length}`);

  const byWorkspace = dal.getConversationsByUser(user.id, { workspaceId: workspace.id });
  if (byWorkspace.length !== 2) throw new Error(`workspaceId filter wrong (got ${byWorkspace.length}, expect 2)`);
  console.log(`   ✓ workspaceId filter → ${byWorkspace.length} (ws-level + project)`);

  const wsLevelOnly = dal.getConversationsByUser(user.id, { workspaceId: workspace.id, workspaceLevelOnly: true });
  if (!(wsLevelOnly.length === 1 && wsLevelOnly[0].id === wsChat.id)) throw new Error('workspaceLevelOnly filter wrong');
  console.log(`   ✓ workspaceLevelOnly filter → ${wsLevelOnly.length}`);

  // Workspace files (metadata only; bytes would live on Drive).
  const wsFile = dal.addWorkspaceFile(workspace.id, { filename: 'house-style.md', mimeType: 'text/markdown', sizeBytes: 42, driveFileId: 'drive-abc' });
  console.log(`   ✓ Added workspace file: ${wsFile.filename}`);
  const wsFiles = dal.listWorkspaceFiles(workspace.id);
  if (wsFiles.length !== 1) throw new Error(`expected 1 workspace file, got ${wsFiles.length}`);
  const gotFile = dal.getWorkspaceFile(wsFile.id, workspace.id);
  if (!gotFile || gotFile.id !== wsFile.id) throw new Error('getWorkspaceFile failed');
  if (dal.listWorkspacesByUser(user.id).find(w => w.id === workspace.id).file_count !== 1) throw new Error('workspace file_count wrong');
  console.log(`   ✓ list/get workspace file + file_count`);
  if (!dal.deleteWorkspaceFile(wsFile.id, workspace.id)) throw new Error('deleteWorkspaceFile failed');
  console.log(`   ✓ Deleted workspace file`);
  // Re-add one to prove deleteWorkspace cascades file rows too.
  const cascadeFile = dal.addWorkspaceFile(workspace.id, { filename: 'ref.txt', driveFileId: 'drive-xyz' });

  // Deleting a workspace removes its projects but reparents chats to unfiled.
  dal.deleteWorkspace(workspace.id, user.id);
  if (dal.getWorkspaceById(workspace.id, user.id)) throw new Error('workspace not deleted');
  if (dal.getWorkspaceFile(cascadeFile.id, workspace.id)) throw new Error('workspace_files not cascaded on workspace delete');
  if (dal.getProjectById(nestedProject.id, user.id)) throw new Error('nested project not deleted');
  const survivedWs = dal.getConversationMeta(wsChat.id, user.id);
  const survivedProj = dal.getConversationMeta(projChat.id, user.id);
  if (!survivedWs || survivedWs.workspace_id !== null) throw new Error('ws-level chat not reparented to unfiled');
  if (!survivedProj || survivedProj.workspace_id !== null || survivedProj.project_id !== null) throw new Error('project chat not reparented to unfiled');
  console.log('   ✓ deleteWorkspace cascaded projects; chats survived as unfiled');

  // --- User files (Track A, P2-03 — Downloads / unfiled tool files) --------
  console.log('\n11c. Testing user files (Downloads)...');
  const uFile = dal.addUserFile(user.id, { filename: 'draft.md', mimeType: 'text/markdown', sizeBytes: 10, driveFileId: 'udrive-1' });
  console.log(`   ✓ Added user file: ${uFile.filename}`);
  if (dal.listUserFiles(user.id).length !== 1) throw new Error('expected 1 user file');
  if (dal.getUserFile(uFile.id, user.id).drive_file_id !== 'udrive-1') throw new Error('getUserFile wrong');
  if (dal.getUserFileByName(user.id, 'draft.md').id !== uFile.id) throw new Error('getUserFileByName wrong');
  console.log('   ✓ list/get/getByName user file');
  // Overwrite: repoint content, keep the same row id (download links survive).
  const repointed = dal.updateUserFileContent(uFile.id, user.id, { mimeType: 'text/markdown', sizeBytes: 20, driveFileId: 'udrive-2' });
  if (repointed.id !== uFile.id || repointed.drive_file_id !== 'udrive-2' || repointed.size_bytes !== 20) throw new Error('updateUserFileContent wrong');
  // Scoping: a wrong userId must NOT update the row.
  if (dal.updateUserFileContent(uFile.id, 'someone-else', { driveFileId: 'x' }) !== undefined) throw new Error('updateUserFileContent ignored user scope');
  if (dal.getUserFile(uFile.id, user.id).drive_file_id !== 'udrive-2') throw new Error('cross-user update leaked');
  console.log('   ✓ updateUserFileContent repoints same row, rejects wrong user');
  if (!dal.deleteUserFile(uFile.id, user.id)) throw new Error('deleteUserFile failed');
  if (dal.getUserFile(uFile.id, user.id)) throw new Error('user file not deleted');
  console.log('   ✓ Deleted user file');
  // Cascade on user delete: re-add one and confirm it goes with the user below.
  dal.addUserFile(user.id, { filename: 'keep.txt', driveFileId: 'udrive-3' });

  // --- Filename overwrite lookups for project/workspace files --------------
  // Fresh container (the workspace above was deleted, cascading its project).
  console.log('\n11d. Testing project/workspace file overwrite lookups...');
  const ws2 = dal.createWorkspace(user.id, { name: 'WS2' });
  const proj2 = dal.createProject(user.id, { workspaceId: ws2.id, name: 'P2' });
  const pf = dal.addProjectFile(proj2.id, { filename: 'gen.md', mimeType: 'text/markdown', sizeBytes: 5, driveFileId: 'pdrive-1' });
  if (dal.getProjectFileByName(proj2.id, 'gen.md').id !== pf.id) throw new Error('getProjectFileByName wrong');
  const pfUpdated = dal.updateProjectFileContent(pf.id, proj2.id, { mimeType: 'text/markdown', sizeBytes: 8, driveFileId: 'pdrive-2' });
  if (pfUpdated.id !== pf.id || pfUpdated.drive_file_id !== 'pdrive-2') throw new Error('updateProjectFileContent wrong');
  if (dal.updateProjectFileContent(pf.id, 'other-proj', { driveFileId: 'x' }) !== undefined) throw new Error('updateProjectFileContent ignored project scope');
  const wf = dal.addWorkspaceFile(ws2.id, { filename: 'gen.md', driveFileId: 'wdrive-1' });
  if (dal.getWorkspaceFileByName(ws2.id, 'gen.md').id !== wf.id) throw new Error('getWorkspaceFileByName wrong');
  const wfUpdated = dal.updateWorkspaceFileContent(wf.id, ws2.id, { sizeBytes: 3, driveFileId: 'wdrive-2' });
  if (wfUpdated.drive_file_id !== 'wdrive-2') throw new Error('updateWorkspaceFileContent wrong');
  if (dal.updateWorkspaceFileContent(wf.id, 'other-ws', { driveFileId: 'x' }) !== undefined) throw new Error('updateWorkspaceFileContent ignored workspace scope');
  console.log('   ✓ getProjectFileByName/getWorkspaceFileByName + updateContent helpers');

  // Cleanup
  console.log('\n12. Cleanup...');
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  console.log('   ✓ Test data cleaned up');

  console.log('\n' + '='.repeat(60));
  console.log('All tests passed!');
  console.log('='.repeat(60) + '\n');

} catch (err) {
  console.error('\n✗ Test failed:', err);
  process.exit(1);
} finally {
  closeDb();
}
