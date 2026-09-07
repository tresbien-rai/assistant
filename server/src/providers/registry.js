/**
 * The provider dispatch map (AX-01).
 *
 * One source of truth for "which providers can this server actually call".
 * That is a narrower question than "which provider ids are valid" — `openai` is
 * a recognised id with API-key storage and validation behind it, but there is
 * no module to dispatch to yet, so anything that intends to MAKE a call must
 * check this list rather than the id list.
 *
 * It lives here rather than in routes/chat.js because the chat loop is no
 * longer the only caller: the aux model (settings) and chat titling (AX-02)
 * both dispatch outside the chat path, and a third copy of the map is how the
 * three drift apart.
 */

const anthropic = require('./anthropic');
const gemini = require('./gemini');

/** Provider id -> module. Add a provider here and every dispatcher sees it. */
const providers = {
  anthropic,
  google: gemini,
  // openai: not implemented yet — see VALID_PROVIDERS in routes/apiKeys.js for
  // the wider set of ids the app accepts keys for.
};

/** Ids this server can actually make a call with. */
const IMPLEMENTED_PROVIDER_IDS = Object.keys(providers);

/**
 * The module for a provider id, or null when it cannot be dispatched to.
 * Returning null rather than throwing lets background work (titling) degrade
 * quietly; the request paths wrap this in their own validation.
 */
function getProviderModule(id) {
  return providers[id] || null;
}

module.exports = { providers, IMPLEMENTED_PROVIDER_IDS, getProviderModule };
