/**
 * User profile — shape definition, tolerant read, strict write (UP-01)
 *
 * The Profile is tier 1 of `docs/PROFILE_DESIGN.md`: one per user, authored by
 * the user, and eventually rendered into a `profile` system block (UP-03) that
 * tells the persona who it is talking to.
 *
 * Shape:
 *
 *   {
 *     preferredName: 'Jack',
 *     sections: [ { id, title, body, enabled }, ... ]
 *   }
 *
 * Why `preferredName` is a real field when everything else is freeform (D1):
 * it is the one thing a persona needs on turn one, it should not have to be
 * inferred out of prose, and it takes over the `{{user}}` macro from the Google
 * account display name in UP-03.
 *
 * Why sections are an ORDERED ARRAY rather than a keyed object: the user
 * arranges them, and that order is the order they reach the model. An object
 * would leave ordering to insertion accident.
 *
 * This module mirrors the split in prompts/presets.js, which is the established
 * pattern for user-authored structured data here:
 *
 * - `normalizeProfile` is TOLERANT. It runs on the READ path, over rows that
 *   may have been written by an older version or hand-edited. Anything
 *   unrecognised degrades to a sane default rather than throwing, because a
 *   malformed profile must not be able to break every chat the user owns.
 * - `validateProfile` is STRICT. It runs on the WRITE path and throws
 *   AppError.validation, so bad input is rejected at the door instead of being
 *   silently reshaped into something the user did not ask for.
 */

const crypto = require('crypto');
const AppError = require('./AppError');

/**
 * Caps. Guard rails against accidents — a runaway paste, a loop building a
 * profile — not policy. A genuinely detailed profile fits inside these
 * comfortably. Sized in the same spirit as MAX_BLOCK_CHARS in prompts/presets.js.
 *
 * MAX_PROFILE_CHARS matters most: unlike a file or a scratchpad, the profile is
 * in EVERY request for the rest of time, so its cost is paid on every turn of
 * every conversation forever.
 */
const MAX_PREFERRED_NAME_CHARS = 60;
const MAX_SECTIONS = 12;
const MAX_TITLE_CHARS = 60;
const MAX_BODY_CHARS = 4000;
const MAX_PROFILE_CHARS = 16000;

/** A profile with nothing in it — what a user has before they write one. */
function emptyProfile() {
  return { preferredName: '', sections: [] };
}

/**
 * The sections a brand-new profile is seeded with (D1).
 *
 * Titles only — every body starts empty. They exist because a blank page is a
 * worse prompt than a leading question: the point is to suggest the KIND of
 * thing worth writing without forcing the rigid field grid that most platforms
 * use. The user renames, reorders, deletes and adds freely; nothing here is
 * privileged once the profile exists.
 */
const SUGGESTED_SECTIONS = [
  {
    title: 'About me',
    placeholder: 'Who you are — pronouns, where you are, what you do, anything you want carried into every conversation.',
  },
  {
    title: 'What I am working on',
    placeholder: 'The projects, subjects or problems currently occupying you.',
  },
  {
    title: 'Things I care about',
    placeholder: 'Interests, tastes, commitments — what makes a conversation with you specifically yours.',
  },
];

/** Trim a value to a string, tolerating null/undefined/non-strings. */
function str(v) {
  return typeof v === 'string' ? v : '';
}

/**
 * Coerce stored/incoming profile JSON into the shape the app expects.
 * TOLERANT — see the module comment. Never throws.
 *
 * @param {unknown} raw - parsed `user_profile.sections` JSON, or null
 * @returns {{preferredName: string, sections: Array<{id: string, title: string, body: string, enabled: boolean}>}}
 */
function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return emptyProfile();

  const preferredName = str(raw.preferredName).trim().slice(0, MAX_PREFERRED_NAME_CHARS);

  const sections = [];
  const seenIds = new Set();
  if (Array.isArray(raw.sections)) {
    for (const entry of raw.sections) {
      if (!entry || typeof entry !== 'object') continue;
      // A duplicate or missing id gets a fresh one rather than dropping the
      // section — the user's words matter more than the bookkeeping.
      let id = str(entry.id).trim();
      if (!id || seenIds.has(id)) id = crypto.randomUUID();
      seenIds.add(id);
      sections.push({
        id,
        title: str(entry.title).trim().slice(0, MAX_TITLE_CHARS),
        body: str(entry.body).slice(0, MAX_BODY_CHARS),
        // Absent means enabled: a section written before the toggle existed
        // should keep reaching the model, not silently go quiet.
        enabled: entry.enabled !== false,
      });
      if (sections.length >= MAX_SECTIONS) break;
    }
  }

  return { preferredName, sections };
}

/**
 * Validate incoming profile JSON from a client. STRICT — throws
 * AppError.validation on anything malformed.
 *
 * Returns the value to store, so the caller writes exactly what was checked
 * rather than the raw input.
 *
 * @param {unknown} raw
 * @returns {{preferredName: string, sections: Array<Object>}}
 */
function validateProfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw AppError.validation('Profile must be an object');
  }

  if (raw.preferredName !== undefined && typeof raw.preferredName !== 'string') {
    throw AppError.validation('preferredName must be a string');
  }
  const preferredName = str(raw.preferredName).trim();
  if (preferredName.length > MAX_PREFERRED_NAME_CHARS) {
    throw AppError.validation(`Preferred name must be ${MAX_PREFERRED_NAME_CHARS} characters or fewer`);
  }

  if (raw.sections !== undefined && !Array.isArray(raw.sections)) {
    throw AppError.validation('sections must be an array');
  }
  const rawSections = Array.isArray(raw.sections) ? raw.sections : [];
  if (rawSections.length > MAX_SECTIONS) {
    throw AppError.validation(`A profile may have at most ${MAX_SECTIONS} sections`);
  }

  const sections = [];
  const seenIds = new Set();
  for (const entry of rawSections) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw AppError.validation('Each section must be an object');
    }
    if (typeof entry.title !== 'string' || typeof entry.body !== 'string') {
      throw AppError.validation('Each section needs a title and a body, both strings');
    }
    const title = entry.title.trim();
    if (title.length > MAX_TITLE_CHARS) {
      throw AppError.validation(`Section titles must be ${MAX_TITLE_CHARS} characters or fewer`);
    }
    if (entry.body.length > MAX_BODY_CHARS) {
      throw AppError.validation(`Section text must be ${MAX_BODY_CHARS} characters or fewer`);
    }

    // Ids are client-supplied so an edit round-trips to the same section, but a
    // collision would make two sections indistinguishable — reject rather than
    // silently renaming, since on the WRITE path that means a client bug.
    const id = str(entry.id).trim() || crypto.randomUUID();
    if (seenIds.has(id)) throw AppError.validation('Section ids must be unique');
    seenIds.add(id);

    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      throw AppError.validation('Section enabled must be a boolean');
    }

    sections.push({ id, title, body: entry.body, enabled: entry.enabled !== false });
  }

  const profile = { preferredName, sections };
  const total = JSON.stringify(profile).length;
  if (total > MAX_PROFILE_CHARS) {
    throw AppError.validation(`Profile is too large (${total} characters, limit ${MAX_PROFILE_CHARS})`);
  }
  return profile;
}

/**
 * Characters of profile text that would reach the model — titles and bodies of
 * ENABLED sections, plus the preferred name.
 *
 * Not the stored size: ids, disabled sections and JSON punctuation cost the
 * user nothing per turn, and reporting them as though they did would make the
 * number useless for the thing it is for — deciding whether the profile has
 * grown too expensive to carry in every request.
 *
 * @param {{preferredName: string, sections: Array}} profile - a NORMALIZED profile
 * @returns {number}
 */
function profileTextLength(profile) {
  let total = profile.preferredName.length;
  for (const section of profile.sections) {
    if (!section.enabled) continue;
    total += section.title.length + section.body.length;
  }
  return total;
}

module.exports = {
  emptyProfile,
  normalizeProfile,
  validateProfile,
  profileTextLength,
  SUGGESTED_SECTIONS,
  MAX_PREFERRED_NAME_CHARS,
  MAX_SECTIONS,
  MAX_TITLE_CHARS,
  MAX_BODY_CHARS,
  MAX_PROFILE_CHARS,
};
