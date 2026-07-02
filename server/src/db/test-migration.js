/**
 * Migration Test
 *
 * Verifies migration 001 against a legacy-shaped database (pre-Workspace
 * Restructure): no workspace_id columns, projects/conversations seeded the old
 * way. Asserts the backfill produces the intended hierarchy and is idempotent.
 *
 * Runs on an isolated in-memory DB — does NOT touch the app database.
 * Run with: node src/db/test-migration.js
 */

const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const { runMigrations } = require('./migrate');

console.log('='.repeat(60));
console.log('Migration Test (001_workspaces)');
console.log('='.repeat(60));

const uuid = () => crypto.randomUUID();
let failures = 0;
function check(label, cond) {
  console.log(`   ${cond ? '✓' : '✗'} ${label}`);
  if (!cond) failures++;
}

const db = new Database(':memory:');

try {
  // --- Build a LEGACY schema (no workspace_id anywhere) ---------------------
  // projects/conversations are intentionally missing workspace_id; the
  // `workspaces` table exists because in production schema.sql runs first.
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      instructions TEXT DEFAULT '', drive_folder_id TEXT DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, persona_id TEXT,
      project_id TEXT, title TEXT DEFAULT 'New Chat',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      instructions TEXT DEFAULT '', drive_folder_id TEXT DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    -- Legacy settings shape (pre-WR-12: no current_model_config) so
    -- migration 002 is exercised too.
    CREATE TABLE settings (
      id TEXT PRIMARY KEY, user_id TEXT UNIQUE NOT NULL,
      avatar_size TEXT DEFAULT 'medium', avatar_position TEXT DEFAULT 'top-right',
      show_avatar INTEGER DEFAULT 1, custom_models TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);

  // --- Seed legacy data -----------------------------------------------------
  // userA: 2 projects, + a project chat per project + one unfiled chat.
  // userB: no projects, just one unfiled chat (should get NO workspace).
  const t = Date.now();
  const userA = uuid();
  const userB = uuid();
  const p1 = uuid();
  const p2 = uuid();
  const cP1 = uuid();   // chat in p1
  const cP2 = uuid();   // chat in p2
  const cUnfiledA = uuid();
  const cUnfiledB = uuid();

  db.prepare('INSERT INTO users (id) VALUES (?)').run(userA);
  db.prepare('INSERT INTO users (id) VALUES (?)').run(userB);

  const insProj = db.prepare('INSERT INTO projects (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  insProj.run(p1, userA, 'Proj One', t, t);
  insProj.run(p2, userA, 'Proj Two', t, t);

  const insConv = db.prepare('INSERT INTO conversations (id, user_id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  insConv.run(cP1, userA, p1, 'In P1', t, t);
  insConv.run(cP2, userA, p2, 'In P2', t, t);
  insConv.run(cUnfiledA, userA, null, 'Unfiled A', t, t);
  insConv.run(cUnfiledB, userB, null, 'Unfiled B', t, t);

  // --- Run migrations -------------------------------------------------------
  console.log('\n1. Running migrations...');
  const applied = runMigrations(db);
  check(`001_workspaces applied (got: ${applied.join(', ') || 'none'})`, applied.includes('001_workspaces'));

  // --- Assert backfill ------------------------------------------------------
  console.log('\n2. Asserting backfill...');
  const workspacesA = db.prepare('SELECT * FROM workspaces WHERE user_id = ?').all(userA);
  check('userA got exactly one default workspace', workspacesA.length === 1);
  const wsA = workspacesA[0];
  check('default workspace named "General"', wsA && wsA.name === 'General');

  const workspacesB = db.prepare('SELECT * FROM workspaces WHERE user_id = ?').all(userB);
  check('userB (no projects) got NO workspace', workspacesB.length === 0);

  const proj1 = db.prepare('SELECT workspace_id FROM projects WHERE id = ?').get(p1);
  const proj2 = db.prepare('SELECT workspace_id FROM projects WHERE id = ?').get(p2);
  check('project P1 attached to default workspace', proj1.workspace_id === wsA.id);
  check('project P2 attached to default workspace', proj2.workspace_id === wsA.id);

  const conv = (id) => db.prepare('SELECT workspace_id, project_id FROM conversations WHERE id = ?').get(id);
  check('chat in P1 inherited workspace', conv(cP1).workspace_id === wsA.id);
  check('chat in P2 inherited workspace', conv(cP2).workspace_id === wsA.id);
  check('unfiled chat A stays unfiled', conv(cUnfiledA).workspace_id === null);
  check('unfiled chat B stays unfiled', conv(cUnfiledB).workspace_id === null);

  // --- Assert 002 (current_model_config column) -------------------------------
  check('002_current_model_config applied', applied.includes('002_current_model_config'));
  const settingsCols = db.prepare('PRAGMA table_info(settings)').all().map(c => c.name);
  check('settings.current_model_config column added', settingsCols.includes('current_model_config'));

  // --- Assert idempotency ---------------------------------------------------
  console.log('\n3. Asserting idempotency...');
  const applied2 = runMigrations(db);
  check('second run applies nothing', applied2.length === 0);
  const workspaceCount = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n;
  check('no duplicate workspaces created', workspaceCount === 1);

  console.log('\n' + '='.repeat(60));
  if (failures === 0) {
    console.log('All migration tests passed!');
    console.log('='.repeat(60) + '\n');
  } else {
    console.log(`${failures} migration assertion(s) FAILED`);
    console.log('='.repeat(60) + '\n');
    process.exit(1);
  }
} catch (err) {
  console.error('\n✗ Migration test failed:', err);
  process.exit(1);
} finally {
  db.close();
}
