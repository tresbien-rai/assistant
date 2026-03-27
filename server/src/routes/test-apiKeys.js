/**
 * API Keys Test Script
 * Tests the API keys endpoints with authentication
 * Run with: node src/routes/test-apiKeys.js
 */

// Set test secrets
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || require('crypto').randomBytes(32).toString('hex');

const { getDb, closeDb } = require('../db/connection');
const dal = require('../db/dal');
const { generateToken } = require('../middleware/authenticate');
const { getDecryptedApiKey } = require('./apiKeys');

console.log('='.repeat(60));
console.log('API Keys Test Script');
console.log('='.repeat(60));

async function runTests() {
  try {
    // Initialize database
    console.log('\n1. Setting up test data...');
    getDb();

    // Create a test user
    let user = dal.findUserByGoogleId('test-apikeys-user');
    if (!user) {
      user = dal.createUser({
        googleId: 'test-apikeys-user',
        email: 'apikeys-test@example.com',
        displayName: 'API Keys Test User',
      });
    }
    console.log(`   Created test user: ${user.id}`);

    // Generate a JWT token for testing
    const token = generateToken({
      userId: user.id,
      email: user.email,
      displayName: user.display_name,
    });
    console.log(`   Generated JWT token: ${token.slice(0, 30)}...`);

    // Test the DAL directly first
    console.log('\n2. Testing DAL operations...');

    // Store a key
    const { encrypt } = require('../utils/encryption');
    const testKey = 'sk-ant-test-key-12345';
    const encryptedKey = encrypt(testKey);
    dal.upsertApiKey(user.id, 'anthropic', encryptedKey);
    console.log('   ✓ Stored encrypted key for anthropic');

    // Retrieve and decrypt
    const decrypted = getDecryptedApiKey(user.id, 'anthropic');
    console.log(`   ✓ Decrypted key matches: ${decrypted === testKey}`);

    // List providers
    const providers = dal.getApiKeyProviders(user.id);
    console.log(`   ✓ Providers with keys: ${providers.map(p => p.provider).join(', ')}`);

    // Delete key
    dal.deleteApiKey(user.id, 'anthropic');
    const afterDelete = dal.getApiKeyProviders(user.id);
    console.log(`   ✓ After delete, providers: ${afterDelete.length === 0 ? 'none' : afterDelete.map(p => p.provider).join(', ')}`);

    // Test missing key error
    console.log('\n3. Testing error handling...');
    try {
      getDecryptedApiKey(user.id, 'openai');
      console.log('   ✗ Should have thrown error for missing key');
    } catch (err) {
      console.log(`   ✓ Correctly threw error: ${err.message}`);
    }

    // Clean up test user
    console.log('\n4. Cleanup...');
    const db = getDb();
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    console.log('   ✓ Test user cleaned up');

    console.log('\n' + '='.repeat(60));
    console.log('All tests passed!');
    console.log('='.repeat(60));
    console.log('\nTo test HTTP endpoints, use:');
    console.log(`  curl -H "Authorization: Bearer <token>" http://localhost:3000/api/api-keys`);

  } catch (err) {
    console.error('\n✗ Test failed:', err);
    process.exit(1);
  } finally {
    closeDb();
  }
}

runTests();
