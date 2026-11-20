/**
 * Sign-in allowlist: which Google accounts may sign in.
 *
 * Solier is private until release, so the server — not Google's test-user
 * list — decides who gets in. The list comes from the ALLOWED_EMAILS env var
 * (comma-separated, case-insensitive).
 *
 * Fails closed: outside development, an empty or missing list lets NOBODY in,
 * so a forgotten variable locks the site instead of opening it. In development
 * an empty list allows everyone, so local real-Google testing needs no setup.
 */

/**
 * @param {string | undefined} raw  e.g. "a@gmail.com, B@gmail.com"
 * @returns {Set<string>} lowercased, trimmed, empties dropped
 */
function parseAllowedEmails(raw) {
  return new Set(
    String(raw || '')
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * @param {{ email?: string, verified_email?: boolean }} profile  Google userinfo
 * @param {{ allowedEmails: Set<string>, isDev: boolean }} opts
 * @returns {boolean}
 */
function isSignInAllowed(profile, { allowedEmails, isDev }) {
  if (allowedEmails.size === 0) return isDev;
  if (!profile || profile.verified_email !== true) return false;
  const email = String(profile.email || '').trim().toLowerCase();
  return email !== '' && allowedEmails.has(email);
}

module.exports = { parseAllowedEmails, isSignInAllowed };
