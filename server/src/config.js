/**
 * Configuration module
 * Loads environment variables and exports configuration constants
 */

require('dotenv').config();

const config = {
  // Server
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',

  // Dev-only login bypass. Lets a local stub user sign in WITHOUT Google OAuth
  // for UI testing. Double-gated: only when running in development AND the
  // explicit opt-in env var is set. In production NODE_ENV=production forces
  // this false, so the dev-login route is never even registered. NEVER set
  // ALLOW_DEV_LOGIN in a deployed environment.
  allowDevLogin: (process.env.NODE_ENV || 'development') === 'development'
    && process.env.ALLOW_DEV_LOGIN === 'true',

  // JWT
  // Default secret for development only - MUST be set in production
  jwtSecret: process.env.JWT_SECRET || 'dev-jwt-secret-do-not-use-in-production',
  jwtExpiresIn: '7d',

  // Encryption (for API keys and Drive tokens)
  // Default key for development only - MUST be set in production
  // This is a valid 64-char hex string (32 bytes)
  encryptionKey: process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',

  // Google OAuth
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/auth/google/callback',
  },

  // Database
  dbPath: process.env.DB_PATH || './data/assistant.db',

  // Name of the app's root folder on the user's Google Drive (contains
  // `projects/`). Overridable via env so the brand can change without a code
  // edit; defaults to the app name.
  driveRootFolder: process.env.DRIVE_ROOT_FOLDER || 'Tessera',

  // Project files (Phase 1)
  // Centralizes the limits/allow-list for project knowledge files so they are
  // not scattered across routes. Files live on the user's Google Drive; these
  // govern what may be uploaded and (later, P1-05) how much context is assembled.
  projectFiles: {
    // Per-file upload cap.
    maxFileBytes: parseInt(process.env.PROJECT_FILE_MAX_BYTES, 10) || 10 * 1024 * 1024, // 10MB
    // Assembled project-context budget, in characters. The context assembler
    // (P1-05) truncates and warns once the combined instructions + file text
    // exceed this, so a large knowledge base can't blow up the prompt / cost on
    // every turn. ~4 chars per token, so ~500k chars ≈ ~125k tokens.
    contextBudgetChars: parseInt(process.env.PROJECT_CONTEXT_BUDGET_CHARS, 10) || 500000,
    // Per-call cap for the read_file tool (Track A, P2-04). A single tool result
    // is echoed straight back into the conversation, so it's capped much tighter
    // than the whole-context budget. ~100k chars ≈ ~25k tokens; larger files are
    // truncated with a note so the model knows there's more.
    toolReadMaxChars: parseInt(process.env.TOOL_READ_MAX_CHARS, 10) || 100000,
    // Cap for a single stored revision diff (File Collaboration, FC-02). Kept
    // tight because FC-03 injects the latest diff into the prompt; oversized
    // diffs are truncated with a note. ~20k chars ≈ ~5k tokens.
    revisionDiffMaxChars: parseInt(process.env.REVISION_DIFF_MAX_CHARS, 10) || 20000,
    // Full-text snapshots per revision (File Collaboration, FC-06a): how many of
    // the most recent revisions per file keep their content (older ones prune to
    // NULL), and the per-file size above which no snapshot is stored (diff-only).
    // Snapshots power re-roll rollback + version compare/restore.
    revisionSnapshotKeep: parseInt(process.env.REVISION_SNAPSHOT_KEEP, 10) || 10,
    revisionSnapshotMaxBytes: parseInt(process.env.REVISION_SNAPSHOT_MAX_BYTES, 10) || 256 * 1024,
    // Accepted file extensions: text/code + PDF (Phase 1 decision #2). Lowercase,
    // leading dot. Anything else is rejected on upload. Extension is the reliable
    // signal here because browsers send inconsistent MIME types for source files.
    acceptedExtensions: [
      // Plain text / docs / data
      '.txt', '.text', '.md', '.markdown', '.rst', '.log',
      '.csv', '.tsv', '.json', '.jsonl', '.ndjson',
      '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.xml',
      // Web
      '.html', '.htm', '.css', '.scss', '.sass', '.less',
      // Code
      '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',
      '.py', '.rb', '.go', '.rs', '.java', '.kt', '.scala',
      '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.cs', '.php', '.swift',
      '.sh', '.bash', '.zsh', '.bat', '.ps1',
      '.sql', '.graphql', '.proto', '.tex', '.r', '.lua', '.pl',
      // Documents
      '.pdf',
    ],
  },

  // Scratchpad (SCRATCHPAD_DESIGN.md): a per-conversation, DB-resident shared
  // document the user and model CHURN (replace/overwrite, not append). Injected
  // in full every turn it is non-empty, so its size matters — but the primary
  // size defence is behavioural (the model replaces rather than grows it), so
  // the cap is a high warning threshold, not a tight budget.
  scratchpad: {
    // Soft warning threshold: a write above this succeeds but the tool result
    // nudges the model to trim / churn / promote to a file. High enough that a
    // well-behaved pad never trips it. ~40k chars ≈ ~10k tokens.
    warnBytes: parseInt(process.env.SCRATCHPAD_WARN_BYTES, 10) || 40 * 1024,
    // Hard ceiling: a runaway guard so a pathological write can't bloat the DB
    // or the prompt. Rejected with an error. Well above warnBytes.
    maxBytes: parseInt(process.env.SCRATCHPAD_MAX_BYTES, 10) || 1024 * 1024, // 1MB
    // How many recent changelog diffs to inject (Decision 7). Shows the recent
    // arc of the back-and-forth, not just the last edit.
    injectDiffCount: parseInt(process.env.SCRATCHPAD_INJECT_DIFF_COUNT, 10) || 3,
    // Full-text snapshots kept per pad (mirrors projectFiles.revisionSnapshotKeep):
    // powers the version rail + restore. Older revisions keep their diff only.
    revisionSnapshotKeep: parseInt(process.env.SCRATCHPAD_SNAPSHOT_KEEP, 10) || 10,
  },

  // Static files (frontend) - relative to server/src/, so ../../ goes to project root
  staticPath: process.env.STATIC_PATH || '../../',
};

// Validate required config in production
if (config.nodeEnv === 'production') {
  const required = ['jwtSecret', 'encryptionKey'];
  const missing = required.filter(key => !config[key]);
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

module.exports = config;
