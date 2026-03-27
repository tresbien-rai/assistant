/**
 * API Keys Routes
 *
 * Handles encrypted storage of API keys for AI providers.
 * Keys are encrypted at rest and never returned to the frontend.
 *
 * Endpoints:
 * - GET /api/api-keys - List providers with stored keys
 * - PUT /api/api-keys/:provider - Store/update a key
 * - DELETE /api/api-keys/:provider - Remove a key
 */

const express = require('express');
const dal = require('../db/dal');
const { encrypt, decrypt } = require('../utils/encryption');
const { authenticate } = require('../middleware/authenticate');
const { asyncHandler } = require('../middleware/errorHandler');
const AppError = require('../utils/AppError');

const router = express.Router();

// Valid provider names
const VALID_PROVIDERS = ['anthropic', 'google', 'openai'];

/**
 * Validate provider name
 * @param {string} provider - Provider name to validate
 * @throws {AppError} If provider is invalid
 */
function validateProvider(provider) {
  if (!VALID_PROVIDERS.includes(provider)) {
    throw AppError.validation(
      `Invalid provider: ${provider}. Must be one of: ${VALID_PROVIDERS.join(', ')}`
    );
  }
}

// All routes require authentication
router.use(authenticate);

/**
 * GET /api/api-keys
 * Returns list of providers that have keys stored
 * Never returns the actual key values
 */
router.get('/', asyncHandler(async (req, res) => {
  const providers = dal.getApiKeyProviders(req.user.userId);

  // Return all providers with hasKey status
  const result = VALID_PROVIDERS.map(provider => {
    const stored = providers.find(p => p.provider === provider);
    return {
      provider,
      hasKey: Boolean(stored),
      updatedAt: stored?.updatedAt || null,
    };
  });

  res.json(result);
}));

/**
 * PUT /api/api-keys/:provider
 * Store or update an API key for a provider
 * The key is encrypted before storage
 */
router.put('/:provider', asyncHandler(async (req, res) => {
  const { provider } = req.params;
  const { key } = req.body;

  validateProvider(provider);

  if (!key || typeof key !== 'string') {
    throw AppError.validation('API key is required');
  }

  if (key.trim().length === 0) {
    throw AppError.validation('API key cannot be empty');
  }

  // Basic format validation (optional - providers will reject invalid keys anyway)
  if (key.length < 10) {
    throw AppError.validation('API key appears to be too short');
  }

  // Encrypt the key before storage
  const encryptedKey = encrypt(key.trim());

  // Store in database
  dal.upsertApiKey(req.user.userId, provider, encryptedKey);

  res.json({
    provider,
    hasKey: true,
    message: `API key for ${provider} has been saved`,
  });
}));

/**
 * DELETE /api/api-keys/:provider
 * Remove a stored API key
 */
router.delete('/:provider', asyncHandler(async (req, res) => {
  const { provider } = req.params;

  validateProvider(provider);

  const deleted = dal.deleteApiKey(req.user.userId, provider);

  if (!deleted) {
    // Key didn't exist, but that's okay - idempotent delete
  }

  res.json({
    provider,
    hasKey: false,
    message: `API key for ${provider} has been removed`,
  });
}));

// =============================================================================
// Internal Helper (not an API endpoint)
// =============================================================================

/**
 * Get a decrypted API key for a user and provider
 * Used internally by the chat proxy to make API calls
 *
 * @param {string} userId - User's database ID
 * @param {string} provider - Provider name
 * @returns {string} Decrypted API key
 * @throws {AppError} If no key is stored for that provider
 */
function getDecryptedApiKey(userId, provider) {
  const record = dal.getApiKey(userId, provider);

  if (!record) {
    throw AppError.validation(
      `No API key configured for ${provider}. Please add your API key in Settings.`
    );
  }

  try {
    return decrypt(record.encrypted_key);
  } catch (err) {
    throw AppError.server('Failed to decrypt API key. Please re-enter your key.');
  }
}

// Export both the router and the helper function
module.exports = router;
module.exports.getDecryptedApiKey = getDecryptedApiKey;
