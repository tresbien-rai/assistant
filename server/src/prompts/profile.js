/**
 * Rendering the user profile into prompt text (UP-03)
 *
 * Tier 1 of docs/PROFILE_DESIGN.md. The stored profile is structured — a
 * preferred name plus ordered, individually toggleable sections — and this
 * turns it into the prose the model actually reads.
 *
 * It lives apart from tessera.js on purpose. tessera.js owns the FRAMING (the
 * block that says "here is the person you are talking to, use it like this");
 * this owns the CONTENT. The framing is preset-overridable text and the content
 * never is, so keeping them in one function would make the overridable and the
 * non-overridable halves impossible to separate.
 *
 * Empty in, empty out: a user who has written nothing produces no text, which
 * is what makes the block skip itself rather than emitting an empty heading.
 */

/**
 * Render a profile as the body of the `profile` block.
 *
 * Disabled sections are omitted entirely — not greyed, not labelled, just
 * absent. The toggle means "keep this but don't send it", so anything that
 * reached the prompt would break the promise the UI makes.
 *
 * A section with a title and no body IS emitted: an empty "Health" heading
 * still tells the model the user chose to name that topic. A section with
 * neither is dropped, because it says nothing at all.
 *
 * @param {{preferredName: string, sections: Array}} profile - a NORMALIZED profile
 * @returns {string} the rendered body, or '' when there is nothing to say
 */
function renderProfile(profile) {
  if (!profile) return '';
  const parts = [];

  const name = (profile.preferredName || '').trim();
  if (name) parts.push(`They go by **${name}** — use it naturally.`);

  for (const section of profile.sections || []) {
    if (!section || section.enabled === false) continue;
    const title = (section.title || '').trim();
    const body = (section.body || '').trim();
    if (!title && !body) continue;
    // A heading per section, so the model can tell where one topic ends and
    // the next begins — the user's own division of themselves is information.
    parts.push(title ? `### ${title}\n${body}`.trim() : body);
  }

  return parts.join('\n\n');
}

/**
 * The name to address the user by: their chosen one, else their account name.
 *
 * This is what `{{user}}` resolves to from UP-03 onward. It used to be the
 * Google display name alone, which is frequently not what anyone wants to be
 * called — the whole reason `preferred_name` is a real field (D1).
 *
 * @param {{preferredName: string}|null} profile
 * @param {string} [accountName] - users.display_name
 * @returns {string}
 */
function resolveUserName(profile, accountName) {
  const preferred = (profile && profile.preferredName || '').trim();
  return preferred || (accountName || '').trim();
}

module.exports = { renderProfile, resolveUserName };
