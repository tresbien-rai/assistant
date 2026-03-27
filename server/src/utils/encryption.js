/**
 * Encryption Utility
 *
 * Provides AES-256-GCM encryption for sensitive data like:
 * - Google Drive access/refresh tokens
 * - API keys for AI providers
 *
 * Uses the ENCRYPTION_KEY environment variable (32-byte hex string).
 */

const crypto = require('crypto');
const config = require('../config');

// AES-256-GCM configuration
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 128 bits
const AUTH_TAG_LENGTH = 16; // 128 bits

/**
 * Get the encryption key as a Buffer
 * @returns {Buffer} 32-byte encryption key
 * @throws {Error} If ENCRYPTION_KEY is not configured or invalid
 */
function getKey() {
  const keyHex = config.encryptionKey;

  if (!keyHex) {
    throw new Error('ENCRYPTION_KEY environment variable is not set');
  }

  if (keyHex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }

  return Buffer.from(keyHex, 'hex');
}

/**
 * Encrypt a plaintext string
 * @param {string} plaintext - The text to encrypt
 * @returns {string} Base64-encoded encrypted data (iv:authTag:ciphertext)
 */
function encrypt(plaintext) {
  if (!plaintext) {
    return '';
  }

  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  // Combine IV, auth tag, and ciphertext into a single string
  // Format: base64(iv):base64(authTag):base64(ciphertext)
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}

/**
 * Decrypt an encrypted string
 * @param {string} encryptedData - Base64-encoded encrypted data from encrypt()
 * @returns {string} The decrypted plaintext
 * @throws {Error} If decryption fails (invalid data or wrong key)
 */
function decrypt(encryptedData) {
  if (!encryptedData) {
    return '';
  }

  const key = getKey();

  // Parse the combined string
  const parts = encryptedData.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format');
  }

  const iv = Buffer.from(parts[0], 'base64');
  const authTag = Buffer.from(parts[1], 'base64');
  const ciphertext = parts[2];

  if (iv.length !== IV_LENGTH) {
    throw new Error('Invalid IV length');
  }

  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('Invalid auth tag length');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Generate a random encryption key (for setup)
 * @returns {string} 64-character hex string suitable for ENCRYPTION_KEY
 */
function generateKey() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Test if the encryption key is configured and valid
 * @returns {boolean} True if encryption is properly configured
 */
function isConfigured() {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  encrypt,
  decrypt,
  generateKey,
  isConfigured,
};
