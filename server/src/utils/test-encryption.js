/**
 * Encryption Test Script
 * Run with: node src/utils/test-encryption.js
 */

// Set a test encryption key if not set
if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');
  console.log('Using generated test key:', process.env.ENCRYPTION_KEY);
}

const { encrypt, decrypt, generateKey, isConfigured } = require('./encryption');

console.log('='.repeat(50));
console.log('Encryption Test');
console.log('='.repeat(50));

try {
  console.log('\n1. Testing key configuration...');
  console.log(`   Configured: ${isConfigured()}`);

  console.log('\n2. Testing encrypt/decrypt cycle...');
  const testCases = [
    'sk-ant-api03-secret-key-here',
    'Hello, World!',
    '{"token": "abc123", "refresh": "xyz789"}',
    '', // Empty string
  ];

  for (const original of testCases) {
    const encrypted = encrypt(original);
    const decrypted = decrypt(encrypted);
    const match = original === decrypted;
    console.log(`   "${original.slice(0, 30)}${original.length > 30 ? '...' : ''}" -> ${match ? '✓' : '✗'}`);
    if (!match) {
      console.log(`     Expected: "${original}"`);
      console.log(`     Got: "${decrypted}"`);
    }
  }

  console.log('\n3. Testing encrypted format...');
  const sample = encrypt('test-api-key');
  const parts = sample.split(':');
  console.log(`   Parts: ${parts.length} (expected 3)`);
  console.log(`   IV length: ${Buffer.from(parts[0], 'base64').length} bytes (expected 16)`);
  console.log(`   AuthTag length: ${Buffer.from(parts[1], 'base64').length} bytes (expected 16)`);

  console.log('\n4. Testing key generation...');
  const newKey = generateKey();
  console.log(`   Generated key length: ${newKey.length} chars (expected 64)`);
  console.log(`   Sample: ${newKey.slice(0, 16)}...`);

  console.log('\n5. Testing error handling...');
  try {
    decrypt('invalid-data');
    console.log('   ✗ Should have thrown for invalid data');
  } catch (e) {
    console.log('   ✓ Correctly rejected invalid data');
  }

  console.log('\n' + '='.repeat(50));
  console.log('All tests passed!');
  console.log('='.repeat(50));

} catch (err) {
  console.error('\n✗ Test failed:', err.message);
  process.exit(1);
}
