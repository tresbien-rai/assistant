/**
 * The one writer of `state.activeConversationId`.
 *
 * WHY THIS EXISTS. Changing which conversation is active is never just an
 * assignment: the composer belongs to the conversation you are leaving (F-04),
 * so a change has to stash the outgoing draft and restore the incoming one. That
 * rule was implemented inside `switchConversation`, which was one of EIGHT places
 * that assigned `state.activeConversationId`. The other seven silently kept the
 * old behaviour, and three of them were reachable bugs:
 *
 *   createConversation()        "+ New chat" carried the previous chat's draft
 *                               into the new chat, ready to be sent to it
 *   deleteConversationPrompt()  deleting the open chat left its draft in the box
 *   deletePersona()             the cascade delete did the same, and orphaned a
 *                               draft entry per deleted conversation
 *
 * The first two were found and fixed one at a time; the third was found only by
 * enumerating every assignment site. That is the tell for a missing chokepoint —
 * fixing call sites one by one cannot converge, because the next caller someone
 * adds reintroduces the bug. So the sequence lives here once, and the views ask
 * for the transition they mean rather than performing it themselves.
 *
 * This module deliberately owns nothing else. It is a leaf plus composer: it
 * imports state.js and the draft store, and nothing imports it except the code
 * that changes conversations. Adding another thing that must happen on a
 * conversation change (a panel reset, an abort) belongs here, in one place, not
 * scattered across the eight callers again.
 */

import { state } from './state.js';
import { stashDraft, restoreDraft, clearDraft } from './chat/composer.js';

/**
 * Point the app at a different conversation, moving the composer with it.
 *
 * @param {string|null} nextId - the conversation to make active, or null for none.
 * @param {Object}  [options]
 * @param {'stash'|'discard'|'none'} [options.outgoing='stash'] - what to do with
 *   the draft of the conversation being left:
 *     'stash'   the user is navigating away and may come back — keep it (default)
 *     'discard' that conversation no longer exists — drop it, so it can never be
 *               restored into an unrelated chat
 *     'none'    there is no outgoing conversation (first assignment during boot)
 * @returns {boolean} whether the active conversation actually changed.
 */
export function setActiveConversation(nextId, { outgoing = 'stash' } = {}) {
    const leaving = state.activeConversationId;
    const changed = leaving !== nextId;

    // A same-conversation "switch" is a real call pattern — it is how you return
    // to the chat you were already on from another section — so it must not be
    // rejected. There is just no draft to move.
    if (changed) {
        if (outgoing === 'stash') stashDraft(leaving);
        else if (outgoing === 'discard') clearDraft(leaving);
    }

    state.activeConversationId = nextId;

    // Always restore on a real change: for a conversation with no stored draft
    // this empties the composer, which is exactly right when arriving somewhere
    // new or when the previous chat was just deleted.
    if (changed) restoreDraft(nextId);

    return changed;
}

/**
 * Forget a conversation's draft without touching which conversation is active.
 *
 * For conversations destroyed while some OTHER chat is open — most obviously the
 * ones swept up by a persona's cascade delete. Without this their drafts (and the
 * File objects and blob URLs they hold) sit in the store for the rest of the
 * session, keyed by an id that no longer resolves to anything.
 *
 * @param {string|null} conversationId
 */
export function forgetConversationDraft(conversationId) {
    clearDraft(conversationId);
}
