/**
 * Sign-in allowlist test
 *
 * 1. The pure rules in utils/signInAllowlist.js (parsing, fail-closed outside
 *    development, verified email required, case-insensitive).
 * 2. The real OAuth callback route with Google stubbed: an allowlisted account
 *    gets a session; any other account is redirected to ?error=not_allowed
 *    and leaves NO user row behind.
 *
 * Runs against a throwaway database and production-mode config.
 *
 * Run with: node src/routes/test-signin-allowlist.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solier-allowlist-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.ALLOWED_EMAILS = ' Owner@Example.com , tester@example.com ';
process.env.LOG_LEVEL = 'silent';

const { parseAllowedEmails, isSignInAllowed } = require('../utils/signInAllowlist');

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`   ✓ ${label}`);
  } catch (err) {
    console.log(`   ✗ ${label}`);
    console.log(`      ${err.message}`);
    failures++;
  }
}

// --- Google stub: the callback asks for a token, then the profile -----------
const { google } = require('googleapis');
let nextProfile = null;
google.auth.OAuth2.prototype.getToken = async () => ({
  tokens: { access_token: 'access', refresh_token: 'refresh' },
});
google.oauth2 = () => ({ userinfo: { get: async () => ({ data: nextProfile }) } });

async function main() {
  console.log('='.repeat(60));
  console.log('Sign-in allowlist tests');
  console.log('='.repeat(60));

  console.log('\n1. the rules...');
  const list = parseAllowedEmails(' A@x.com, ,b@x.com ');
  const prod = { allowedEmails: list, isDev: false };

  await check('parses a comma list: trimmed, lowercased, empties dropped', () => {
    assert.deepStrictEqual([...list], ['a@x.com', 'b@x.com']);
  });
  await check('a listed, verified account is allowed (case-insensitive)', () => {
    assert.strictEqual(isSignInAllowed({ email: 'A@X.com', verified_email: true }, prod), true);
  });
  await check('an unlisted account is refused', () => {
    assert.strictEqual(isSignInAllowed({ email: 'c@x.com', verified_email: true }, prod), false);
  });
  await check('a listed but unverified email is refused', () => {
    assert.strictEqual(isSignInAllowed({ email: 'a@x.com', verified_email: false }, prod), false);
    assert.strictEqual(isSignInAllowed({ email: 'a@x.com' }, prod), false);
  });
  await check('outside development, an empty list refuses everyone', () => {
    const empty = { allowedEmails: parseAllowedEmails(''), isDev: false };
    assert.strictEqual(isSignInAllowed({ email: 'a@x.com', verified_email: true }, empty), false);
  });
  await check('in development, an empty list allows everyone', () => {
    const empty = { allowedEmails: parseAllowedEmails(undefined), isDev: true };
    assert.strictEqual(isSignInAllowed({ email: 'a@x.com', verified_email: true }, empty), true);
  });

  console.log('\n2. the OAuth callback route...');
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const dal = require('../db/dal');
  const { closeDb } = require('../db/connection');
  const authRoutes = require('./auth');

  const app = express();
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  async function callback(profile) {
    nextProfile = profile;
    return fetch(`${base}/api/auth/google/callback?code=c&state=s`, {
      headers: { cookie: 'oauth_state=s' },
      redirect: 'manual',
    });
  }

  try {
    await check('an unlisted account is sent to ?error=not_allowed and no user is created', async () => {
      const res = await callback({ id: 'g-stranger', email: 'stranger@example.com', verified_email: true, name: 'S' });
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.headers.get('location'), '/?error=not_allowed');
      assert.ok(!/(^|;\s*)token=/.test(res.headers.get('set-cookie') || ''), 'no session cookie');
      assert.strictEqual(dal.findUserByGoogleId('g-stranger'), undefined);
    });

    await check('an allowlisted account signs in and gets a session', async () => {
      const res = await callback({ id: 'g-owner', email: 'owner@example.com', verified_email: true, name: 'O' });
      assert.strictEqual(res.headers.get('location'), '/?auth=success');
      assert.match(res.headers.get('set-cookie') || '', /token=/);
      assert.ok(dal.findUserByGoogleId('g-owner'), 'user row created');
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('\n' + '='.repeat(60));
  if (failures > 0) {
    console.log(`${failures} sign-in allowlist test(s) FAILED`);
    process.exitCode = 1;
    return;
  }
  console.log('All sign-in allowlist tests passed!');
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
