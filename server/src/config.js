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
