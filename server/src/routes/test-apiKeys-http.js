/**
 * API Keys HTTP Test Script
 * Tests the actual HTTP endpoints
 * Run with: node src/routes/test-apiKeys-http.js
 *
 * Note: Uses the same default secrets as config.js for development
 */

const http = require('http');
const { getDb, closeDb } = require('../db/connection');
const dal = require('../db/dal');
const { generateToken } = require('../middleware/authenticate');

const BASE_URL = 'http://localhost:3000';

function makeRequest(method, path, token, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('='.repeat(60));
  console.log('API Keys HTTP Test');
  console.log('='.repeat(60));

  try {
    // Setup
    console.log('\n1. Setting up test user...');
    getDb();

    let user = dal.findUserByGoogleId('http-test-user');
    if (!user) {
      user = dal.createUser({
        googleId: 'http-test-user',
        email: 'http-test@example.com',
        displayName: 'HTTP Test User',
      });
    }

    const token = generateToken({
      userId: user.id,
      email: user.email,
      displayName: user.display_name,
    });
    console.log(`   User ID: ${user.id}`);

    // Test GET (empty)
    console.log('\n2. GET /api/api-keys (no keys yet)...');
    let res = await makeRequest('GET', '/api/api-keys', token);
    console.log(`   Status: ${res.status}`);
    console.log(`   Body: ${JSON.stringify(res.body)}`);
    const noKeys = res.body.every(p => !p.hasKey);
    console.log(`   ✓ All hasKey=false: ${noKeys}`);

    // Test PUT
    console.log('\n3. PUT /api/api-keys/anthropic...');
    res = await makeRequest('PUT', '/api/api-keys/anthropic', token, { key: 'sk-ant-test-key-12345' });
    console.log(`   Status: ${res.status}`);
    console.log(`   Body: ${JSON.stringify(res.body)}`);
    console.log(`   ✓ hasKey: ${res.body.hasKey}`);

    // Test GET (with key)
    console.log('\n4. GET /api/api-keys (with anthropic key)...');
    res = await makeRequest('GET', '/api/api-keys', token);
    console.log(`   Status: ${res.status}`);
    const anthropic = res.body.find(p => p.provider === 'anthropic');
    console.log(`   ✓ anthropic.hasKey: ${anthropic.hasKey}`);
    console.log(`   ✓ Key value NOT returned (correct): ${anthropic.key === undefined}`);

    // Test invalid provider
    console.log('\n5. PUT /api/api-keys/invalid...');
    res = await makeRequest('PUT', '/api/api-keys/invalid', token, { key: 'test' });
    console.log(`   Status: ${res.status} (expected 400)`);
    console.log(`   ✓ Validation error: ${res.body.error?.code === 'VALIDATION_ERROR'}`);

    // Test empty key
    console.log('\n6. PUT /api/api-keys/google (empty key)...');
    res = await makeRequest('PUT', '/api/api-keys/google', token, { key: '' });
    console.log(`   Status: ${res.status} (expected 400)`);
    console.log(`   ✓ Validation error: ${res.body.error?.code === 'VALIDATION_ERROR'}`);

    // Test DELETE
    console.log('\n7. DELETE /api/api-keys/anthropic...');
    res = await makeRequest('DELETE', '/api/api-keys/anthropic', token);
    console.log(`   Status: ${res.status}`);
    console.log(`   ✓ hasKey: ${res.body.hasKey} (should be false)`);

    // Verify deleted
    console.log('\n8. GET /api/api-keys (after delete)...');
    res = await makeRequest('GET', '/api/api-keys', token);
    const afterDelete = res.body.find(p => p.provider === 'anthropic');
    console.log(`   ✓ anthropic.hasKey: ${afterDelete.hasKey} (should be false)`);

    // Cleanup
    console.log('\n9. Cleanup...');
    const db = getDb();
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    console.log('   ✓ Test user cleaned up');

    console.log('\n' + '='.repeat(60));
    console.log('All HTTP tests passed!');
    console.log('='.repeat(60));

  } catch (err) {
    console.error('\n✗ Test failed:', err);
    process.exit(1);
  } finally {
    closeDb();
  }
}

runTests();
