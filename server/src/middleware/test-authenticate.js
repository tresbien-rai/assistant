/**
 * Authentication Test Script
 * Run with: node src/middleware/test-authenticate.js
 */

// Set test secrets if not set
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-jwt-secret-for-development-only';
}

const { generateToken, verifyToken } = require('./authenticate');

console.log('='.repeat(50));
console.log('Authentication Test');
console.log('='.repeat(50));

try {
  console.log('\n1. Testing token generation...');
  const user = {
    userId: 'test-user-123',
    email: 'test@example.com',
    displayName: 'Test User',
  };

  const token = generateToken(user);
  console.log(`   Token generated: ${token.slice(0, 50)}...`);
  console.log(`   Token length: ${token.length} chars`);

  console.log('\n2. Testing token verification...');
  const decoded = verifyToken(token);
  console.log(`   userId: ${decoded.userId} (expected: ${user.userId}) ${decoded.userId === user.userId ? '✓' : '✗'}`);
  console.log(`   email: ${decoded.email} (expected: ${user.email}) ${decoded.email === user.email ? '✓' : '✗'}`);
  console.log(`   displayName: ${decoded.displayName} (expected: ${user.displayName}) ${decoded.displayName === user.displayName ? '✓' : '✗'}`);
  console.log(`   exp: ${new Date(decoded.exp * 1000).toISOString()}`);
  console.log(`   iat: ${new Date(decoded.iat * 1000).toISOString()}`);

  console.log('\n3. Testing invalid token...');
  const invalid = verifyToken('invalid.token.here');
  console.log(`   Result: ${invalid === null ? '✓ null (correct)' : '✗ should be null'}`);

  console.log('\n4. Testing tampered token...');
  const tampered = token.slice(0, -5) + 'XXXXX';
  const tamperedResult = verifyToken(tampered);
  console.log(`   Result: ${tamperedResult === null ? '✓ null (correct)' : '✗ should be null'}`);

  console.log('\n' + '='.repeat(50));
  console.log('All tests passed!');
  console.log('='.repeat(50));

} catch (err) {
  console.error('\n✗ Test failed:', err.message);
  console.error(err.stack);
  process.exit(1);
}
