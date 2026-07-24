/**
 * Context State Test (Context toggles, CT-01)
 *
 * Three parts:
 *   1. Migration 010 against a legacy-shaped database (in-memory): the columns
 *      appear, existing rows backfill to "loaded", and re-running is a no-op.
 *   2. Pure resolution (no DB): the override → container → on layering, the
 *      `source` label, NULL tolerance, and inject-mode fallbacks.
 *   3. DAL round-trip on the app database: setters persist, overrides upsert
 *      rather than accumulate, clearing falls back to the container default,
 *      and deleting a file prunes its overrides. Cleans up after itself.
 *
 * CT-01 changes no behaviour — everything still resolves to loaded/auto until
 * CT-02 teaches the injection path to read it. These tests pin the contract
 * that slice will build on.
 *
 * Run with: node src/utils/test-contextstate.js
 */

const assert = require('node:assert');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { getDb, closeDb } = require('../db/connection');
const dal = require('../db/dal');
const {
  containerDefaultEnabled,
  resolveKnowledgeFiles,
  partitionKnowledgeFiles,
  resolveInjectMode,
  isValidInjectMode,
  isKnowledgeScope,
  INJECT_MODES,
} = require('./contextState');

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`   ✓ ${label}`);
  } catch (err) {
    console.log(`   ✗ ${label}`);
    console.log(`      ${err.message}`);
    failures++;
  }
}

/** A DAL stand-in for the pure tests — resolution's only DB touch. */
function fakeDal(overrideRows) {
  return { listConversationContextOverrides: () => overrideRows };
}

console.log('='.repeat(60));
console.log('Context State Test (CT-01)');
console.log('='.repeat(60));

// ---------------------------------------------------------------------------
// 1. Migration 010 on a legacy-shaped DB
// ---------------------------------------------------------------------------
console.log('\n1. migration 010 (isolated in-memory DB)...');
{
  const mem = new Database(':memory:');
  const hasColumn = (table, column) =>
    mem.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);

  try {
    // Legacy shapes: the three file tables without the CT-01 columns. Only the
    // tables migration 010 touches are needed — it guards on table existence.
    mem.exec(`
      CREATE TABLE project_files (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, filename TEXT NOT NULL,
        mime_type TEXT DEFAULT '', size_bytes INTEGER DEFAULT 0,
        drive_file_id TEXT DEFAULT '', created_at INTEGER NOT NULL
      );
      CREATE TABLE workspace_files (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, filename TEXT NOT NULL,
        mime_type TEXT DEFAULT '', size_bytes INTEGER DEFAULT 0,
        drive_file_id TEXT DEFAULT '', created_at INTEGER NOT NULL
      );
      CREATE TABLE conversation_files (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, filename TEXT NOT NULL,
        mime_type TEXT DEFAULT '', size_bytes INTEGER DEFAULT 0,
        drive_file_id TEXT DEFAULT '', last_touched_turn INTEGER,
        created_at INTEGER NOT NULL
      );
      INSERT INTO project_files (id, project_id, filename, created_at)
        VALUES ('pf1', 'p1', 'legacy.md', 1);
      INSERT INTO workspace_files (id, workspace_id, filename, created_at)
        VALUES ('wf1', 'w1', 'legacy.md', 1);
      INSERT INTO conversation_files (id, conversation_id, filename, created_at)
        VALUES ('cf1', 'c1', 'legacy.md', 1);
    `);

    // Only run 010 — the earlier migrations target tables this fixture omits.
    const migration = require('../db/migrations/010_context_toggles');
    migration.up(mem);

    check('adds project_files.enabled', () => assert.ok(hasColumn('project_files', 'enabled')));
    check('adds workspace_files.enabled', () => assert.ok(hasColumn('workspace_files', 'enabled')));
    check('adds conversation_files.inject_mode', () =>
      assert.ok(hasColumn('conversation_files', 'inject_mode')));

    check('existing knowledge files backfill to enabled=1', () => {
      assert.strictEqual(mem.prepare(`SELECT enabled FROM project_files WHERE id='pf1'`).get().enabled, 1);
      assert.strictEqual(mem.prepare(`SELECT enabled FROM workspace_files WHERE id='wf1'`).get().enabled, 1);
    });
    check('existing chat files backfill to inject_mode NULL (= auto)', () => {
      assert.strictEqual(
        mem.prepare(`SELECT inject_mode FROM conversation_files WHERE id='cf1'`).get().inject_mode,
        null
      );
    });
    check('re-running is a no-op (idempotent)', () => {
      migration.up(mem);
      assert.strictEqual(mem.prepare(`SELECT enabled FROM project_files WHERE id='pf1'`).get().enabled, 1);
    });
    check('tolerates a missing table', () => {
      const bare = new Database(':memory:');
      try {
        migration.up(bare); // no tables at all → must not throw
      } finally {
        bare.close();
      }
    });
    // Runner bookkeeping (applied exactly once, recorded in schema_migrations)
    // is not re-tested here: it is the runner's contract, covered by
    // test-migration.js, and exercised for 010 specifically by section 4, which
    // runs against the real app database.
  } catch (err) {
    console.error('   ✗ migration section crashed:', err.message);
    failures++;
  } finally {
    mem.close();
  }
}

// ---------------------------------------------------------------------------
// 2. Pure resolution
// ---------------------------------------------------------------------------
console.log('\n2. resolution layering (pure)...');

check('enabled=1 / NULL / undefined all mean loaded', () => {
  assert.strictEqual(containerDefaultEnabled({ enabled: 1 }), true);
  assert.strictEqual(containerDefaultEnabled({ enabled: null }), true, 'NULL is loaded');
  assert.strictEqual(containerDefaultEnabled({}), true, 'missing column is loaded');
  assert.strictEqual(containerDefaultEnabled({ enabled: 0 }), false);
});

check('no override → container default, source "container"', () => {
  const files = [{ id: 'a', enabled: 1 }, { id: 'b', enabled: 0 }];
  const out = resolveKnowledgeFiles(fakeDal([]), 'conv1', 'project', files);
  assert.deepStrictEqual(
    out.map((e) => [e.file.id, e.enabled, e.source]),
    [['a', true, 'container'], ['b', false, 'container']]
  );
});

check('override wins over the container default, source "chat"', () => {
  const files = [{ id: 'a', enabled: 1 }, { id: 'b', enabled: 0 }];
  const overrides = [
    { scope: 'project', file_id: 'a', enabled: 0 }, // on by default, off here
    { scope: 'project', file_id: 'b', enabled: 1 }, // off by default, on here
  ];
  const out = resolveKnowledgeFiles(fakeDal(overrides), 'conv1', 'project', files);
  assert.deepStrictEqual(
    out.map((e) => [e.file.id, e.enabled, e.source]),
    [['a', false, 'chat'], ['b', true, 'chat']]
  );
});

check('overrides do not leak across scopes', () => {
  const files = [{ id: 'a', enabled: 1 }];
  // Same file id, but recorded against the workspace scope.
  const out = resolveKnowledgeFiles(fakeDal([{ scope: 'workspace', file_id: 'a', enabled: 0 }]), 'c', 'project', files);
  assert.strictEqual(out[0].enabled, true);
  assert.strictEqual(out[0].source, 'container');
});

check('no conversation → container defaults, no DB read', () => {
  const dalThatThrows = {
    listConversationContextOverrides() { throw new Error('should not be queried'); },
  };
  const out = resolveKnowledgeFiles(dalThatThrows, null, 'project', [{ id: 'a', enabled: 0 }]);
  assert.deepStrictEqual(out.map((e) => [e.enabled, e.source]), [[false, 'container']]);
});

check('empty file list short-circuits', () => {
  const dalThatThrows = {
    listConversationContextOverrides() { throw new Error('should not be queried'); },
  };
  assert.deepStrictEqual(resolveKnowledgeFiles(dalThatThrows, 'conv1', 'project', []), []);
  assert.deepStrictEqual(resolveKnowledgeFiles(dalThatThrows, 'conv1', 'project', null), []);
});

check('partition splits loaded vs not-loaded, preserving order', () => {
  const files = [{ id: 'a', enabled: 1 }, { id: 'b', enabled: 0 }, { id: 'c', enabled: 1 }];
  const { loaded, notLoaded } = partitionKnowledgeFiles(fakeDal([]), 'conv1', 'workspace', files);
  assert.deepStrictEqual(loaded.map((f) => f.id), ['a', 'c']);
  assert.deepStrictEqual(notLoaded.map((f) => f.id), ['b']);
});

console.log('\n3. inject modes (pure)...');

check('NULL / unknown / missing all resolve to auto', () => {
  assert.strictEqual(resolveInjectMode({ inject_mode: null }), 'auto');
  assert.strictEqual(resolveInjectMode({}), 'auto');
  assert.strictEqual(resolveInjectMode(null), 'auto');
  // A junk value must never make a file invisible — fail open, not closed.
  assert.strictEqual(resolveInjectMode({ inject_mode: 'nonsense' }), 'auto');
});

check('pin and mute round-trip', () => {
  assert.strictEqual(resolveInjectMode({ inject_mode: 'pin' }), 'pin');
  assert.strictEqual(resolveInjectMode({ inject_mode: 'mute' }), 'mute');
});

check('validators reject junk', () => {
  assert.deepStrictEqual(INJECT_MODES, ['auto', 'pin', 'mute']);
  assert.ok(isValidInjectMode('pin'));
  assert.ok(!isValidInjectMode('PIN'));
  assert.ok(!isValidInjectMode(''));
  assert.ok(isKnowledgeScope('workspace') && isKnowledgeScope('project'));
  assert.ok(!isKnowledgeScope('conversation'), 'chat files are not a knowledge scope');
  assert.ok(!isKnowledgeScope('downloads'));
});

// ---------------------------------------------------------------------------
// 4. DAL round-trip on the app database
// ---------------------------------------------------------------------------
console.log('\n4. DAL round-trip (app DB, cleaned up)...');
let userId;
try {
  const db = getDb();
  const user = dal.createUser({ googleId: `ct-${crypto.randomUUID()}`, email: 'ct@test.local' });
  userId = user.id;
  const workspace = dal.createWorkspace(userId, { name: 'CT WS' });
  const project = dal.createProject(userId, { name: 'CT Proj', workspaceId: workspace.id });
  const conv = dal.createConversation(userId, { title: 'CT chat', workspaceId: workspace.id, projectId: project.id });

  const pf = dal.addProjectFile(project.id, { filename: 'p.md', sizeBytes: 10 });
  const wf = dal.addWorkspaceFile(workspace.id, { filename: 'w.md', sizeBytes: 10 });

  check('a newly uploaded file arrives enabled', () => {
    // The agreed default: a file that silently does nothing after upload is a
    // worse surprise than a visible truncation warning.
    assert.strictEqual(dal.getProjectFile(pf.id, project.id).enabled, 1);
    assert.strictEqual(dal.getWorkspaceFile(wf.id, workspace.id).enabled, 1);
  });

  check('setProjectFileEnabled / setWorkspaceFileEnabled persist', () => {
    assert.ok(dal.setProjectFileEnabled(pf.id, project.id, false));
    assert.strictEqual(dal.getProjectFile(pf.id, project.id).enabled, 0);
    assert.ok(dal.setWorkspaceFileEnabled(wf.id, workspace.id, false));
    assert.strictEqual(dal.getWorkspaceFile(wf.id, workspace.id).enabled, 0);
    assert.ok(dal.setProjectFileEnabled(pf.id, project.id, true));
    assert.strictEqual(dal.getProjectFile(pf.id, project.id).enabled, 1);
  });

  check('setters are container-scoped (wrong container → no change)', () => {
    assert.strictEqual(dal.setProjectFileEnabled(pf.id, 'not-my-project', false), false);
    assert.strictEqual(dal.getProjectFile(pf.id, project.id).enabled, 1, 'left alone');
  });

  check('override upserts rather than accumulating rows', () => {
    dal.setConversationContextOverride(conv.id, 'project', pf.id, false);
    dal.setConversationContextOverride(conv.id, 'project', pf.id, true);
    dal.setConversationContextOverride(conv.id, 'project', pf.id, false);
    const rows = dal.listConversationContextOverrides(conv.id);
    assert.strictEqual(rows.length, 1, 'one row per (conversation, scope, file)');
    assert.strictEqual(rows[0].enabled, 0, 'last write wins');
  });

  check('resolution reads the real override through the real DAL', () => {
    const out = resolveKnowledgeFiles(dal, conv.id, 'project', [dal.getProjectFile(pf.id, project.id)]);
    assert.strictEqual(out[0].enabled, false, 'chat override says off');
    assert.strictEqual(out[0].source, 'chat');
  });

  check('clearing the override falls back to the container default', () => {
    assert.ok(dal.clearConversationContextOverride(conv.id, 'project', pf.id));
    assert.strictEqual(
      dal.clearConversationContextOverride(conv.id, 'project', pf.id),
      false,
      'clearing twice reports nothing removed'
    );
    const out = resolveKnowledgeFiles(dal, conv.id, 'project', [dal.getProjectFile(pf.id, project.id)]);
    assert.strictEqual(out[0].enabled, true);
    assert.strictEqual(out[0].source, 'container');
  });

  check('a container default change propagates to chats that never disagreed', () => {
    dal.setProjectFileEnabled(pf.id, project.id, false);
    const out = resolveKnowledgeFiles(dal, conv.id, 'project', [dal.getProjectFile(pf.id, project.id)]);
    assert.strictEqual(out[0].enabled, false);
    assert.strictEqual(out[0].source, 'container');
    dal.setProjectFileEnabled(pf.id, project.id, true);
  });

  check('chat-file inject mode round-trips, auto stored as NULL', () => {
    const cf = dal.addConversationFile(conv.id, { filename: 'draft.md', sizeBytes: 5 });
    assert.strictEqual(resolveInjectMode(dal.getConversationFile(cf.id, conv.id)), 'auto');
    assert.ok(dal.setConversationFileInjectMode(cf.id, conv.id, 'pin'));
    assert.strictEqual(resolveInjectMode(dal.getConversationFile(cf.id, conv.id)), 'pin');
    assert.ok(dal.setConversationFileInjectMode(cf.id, conv.id, 'auto'));
    assert.strictEqual(dal.getConversationFile(cf.id, conv.id).inject_mode, null, 'auto is NULL, not "auto"');
    assert.strictEqual(dal.setConversationFileInjectMode(cf.id, 'not-my-chat', 'mute'), false);
  });

  check('deleting a knowledge file prunes its overrides', () => {
    dal.setConversationContextOverride(conv.id, 'workspace', wf.id, false);
    assert.strictEqual(dal.listConversationContextOverrides(conv.id).length, 1);
    dal.deleteWorkspaceFile(wf.id, workspace.id);
    assert.strictEqual(dal.listConversationContextOverrides(conv.id).length, 0, 'pruned with the file');
  });

  check('a mis-scoped delete prunes nothing', () => {
    dal.setConversationContextOverride(conv.id, 'project', pf.id, false);
    dal.deleteProjectFile(pf.id, 'not-my-project');
    assert.strictEqual(
      dal.listConversationContextOverrides(conv.id).length,
      1,
      'override survives a delete that matched no file'
    );
  });

  check('deleting the conversation cascades its overrides away', () => {
    dal.deleteConversation(conv.id, userId);
    const left = db
      .prepare('SELECT COUNT(*) AS n FROM conversation_context_overrides WHERE conversation_id = ?')
      .get(conv.id).n;
    assert.strictEqual(left, 0);
  });
} catch (err) {
  console.error('\n✗ DAL section crashed:', err);
  failures++;
} finally {
  try {
    if (userId) getDb().prepare('DELETE FROM users WHERE id = ?').run(userId);
  } catch (err) {
    console.error('   (cleanup failed:', err.message, ')');
  }
  closeDb();
}

console.log('\n' + '='.repeat(60));
console.log(failures === 0 ? 'All context state tests passed!' : `${failures} assertion(s) FAILED`);
console.log('='.repeat(60) + '\n');
process.exit(failures === 0 ? 0 : 1);
