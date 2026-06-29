/**
 * Database Connection Module
 *
 * Initializes SQLite database using better-sqlite3 and runs schema setup.
 * Provides a singleton database instance for use throughout the application.
 */

const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { runMigrations } = require('./migrate');

let db = null;

/**
 * Get the database instance, initializing it if necessary
 * @returns {Database} The SQLite database instance
 */
function getDb() {
  if (db) {
    return db;
  }

  // Ensure the data directory exists
  const dbPath = path.resolve(__dirname, '../../', config.dbPath);
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    console.log(`[Database] Created data directory: ${dbDir}`);
  }

  // Initialize the database
  db = new Database(dbPath);

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Use WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');

  console.log(`[Database] Connected to: ${dbPath}`);

  // Run schema initialization, then apply any pending migrations. Schema setup
  // is idempotent (CREATE TABLE IF NOT EXISTS); migrations handle changes that
  // can't be — ADD COLUMN and data backfills — on pre-existing databases.
  initializeSchema();
  runMigrations(db);

  return db;
}

/**
 * Initialize the database schema by running schema.sql
 */
function initializeSchema() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  // Execute the schema SQL
  db.exec(schema);

  console.log('[Database] Schema initialized');
}

/**
 * Close the database connection
 */
function closeDb() {
  if (db) {
    db.close();
    db = null;
    console.log('[Database] Connection closed');
  }
}

/**
 * Generate a new UUID for use as a primary key
 * @returns {string} A new UUID
 */
function generateId() {
  return crypto.randomUUID();
}

/**
 * Get the current Unix timestamp in milliseconds
 * @returns {number} Current timestamp
 */
function now() {
  return Date.now();
}

module.exports = {
  getDb,
  closeDb,
  generateId,
  now,
};
