/**
 * File provenance wording (P-03, docs/FILE_PROVENANCE_DESIGN.md).
 *
 * One word per file, telling the model where that file came from. Three
 * surfaces show it — the <available_files> manifest, the header on a loaded
 * file, and list_files — and they MUST agree: a model that reads "you created
 * this" in the manifest and something else from the tool has learned nothing
 * except that Tessera is unreliable. So the phrase lives here once, and each
 * surface only decides how to punctuate it.
 *
 * `unknown` renders as EMPTY everywhere, deliberately. Silence is the honest
 * rendering of "no information", it costs nothing on the legacy files that
 * predate provenance capture, and it avoids teaching the model a tag it might
 * start writing into its own prose.
 */

/** The canonical phrasing. Second person, because it is addressed to the model. */
const PROVENANCE_PHRASE = {
  model: 'you created this',
  user: 'uploaded by the user',
};

/**
 * The bare phrase for a provenance state, or '' when there is nothing to say.
 * @param {'model'|'user'|'unknown'|undefined} state
 * @returns {string}
 */
function describeProvenance(state) {
  return PROVENANCE_PHRASE[state] || '';
}

/**
 * The phrase as a trailing parenthetical, for surfaces that append it to a
 * filename: `alpha.txt (you created this)`. Empty string when unknown, so
 * callers can concatenate unconditionally.
 * @param {'model'|'user'|'unknown'|undefined} state
 * @returns {string}
 */
function provenanceSuffix(state) {
  const phrase = describeProvenance(state);
  return phrase ? ` (${phrase})` : '';
}

/**
 * Look up one file's provenance in a batch map and render the suffix.
 * The map comes from dal.getFileProvenanceBatch, where a MISSING key means
 * unknown — callers must not default it to a person.
 * @param {Map<string, string>} map
 * @param {string} fileId
 * @returns {string}
 */
function suffixFor(map, fileId) {
  return provenanceSuffix(map && map.get(fileId));
}

module.exports = { PROVENANCE_PHRASE, describeProvenance, provenanceSuffix, suffixFor };
