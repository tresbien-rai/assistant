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
