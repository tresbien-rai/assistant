/**
 * Migration Runner
 *
 * Applies numbered, one-time schema/data migrations that can't be expressed as
 * idempotent `CREATE TABLE IF NOT EXISTS` statements in schema.sql — e.g.
 * `ALTER TABLE ... ADD COLUMN` and data backfills against existing databases.
 *
 * Migrations live in `./migrations/NNN_name.js` and export `up(db)`. They run in
 * filename order, each inside a transaction, exactly once. Applied migrations are
 * recorded in the `schema_migrations` table (id = filename without extension).
 *
 * Conventions for writing a migration:
 *   - Make `up(db)` idempotent where practical (guard ALTERs by inspecting
 *     `PRAGMA table_info`) so a partially-applied or hand-patched DB stays safe.
 *   - Keep it dependency-free: receive the better-sqlite3 `db` handle, use plain
 *     SQL. Do not import the DAL (which would couple migrations to current code).
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Ensure the bookkeeping table that records which migrations have run.
 * @param {import('better-sqlite3').Database} db
 */
function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
}

/**
 * Run all pending migrations in filename order.
 * @param {import('better-sqlite3').Database} db - The better-sqlite3 instance
 * @returns {string[]} The ids of migrations applied during this call
 */
function runMigrations(db) {
  ensureMigrationsTable(db);

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return [];
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();

  const isApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?');
  const record = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');

  const applied = [];

  for (const file of files) {
    const id = file.replace(/\.js$/, '');

    if (isApplied.get(id)) {
      continue;
    }

    const migration = require(path.join(MIGRATIONS_DIR, file));
    if (typeof migration.up !== 'function') {
      throw new Error(`[Migrate] ${file} does not export an up(db) function`);
    }

    // Each migration is atomic: either the whole `up` + its bookkeeping row
    // commit together, or nothing does.
    const apply = db.transaction(() => {
      migration.up(db);
      record.run(id, Date.now());
    });

    apply();
    applied.push(id);
    console.log(`[Migrate] Applied ${id}`);
  }

  if (applied.length === 0) {
    console.log('[Migrate] No pending migrations');
  }

  return applied;
}

module.exports = { runMigrations };
