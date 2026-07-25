/**
 * Frontend smoke harness (F-02)
 *
 * There is no frontend test runner and no build step, so this is a plain ES
 * module you load into the RUNNING app from the browser console:
 *
 *     const t = await import('/tests/frontend-smoke.js'); await t.run();
 *
 * It drives the real UI — real router, real send path, real DOM — with the
 * provider stubbed out, and asserts invariants that hold between `state` and
 * what is actually on screen.
 *
 * Why it exists: `app.js` is 10,476 lines with no test net, and the refactor in
 * docs/REFACTOR_PLAN.md is about to move all of it. Run this before and after
 * every R-slice.
 *
 * SAFETY
 * - Never touches the network for chat: `API.chat.stream` / `API.chat.send` are
 *   stubbed and restored in a `finally`.
 * - Never touches your existing chats: it creates its own throwaway
 *   conversation, works only in that, and deletes it on the way out (including
 *   on failure). Nothing is left behind.
 *
 * All state it mutates (stubs, API-key status, the streaming flag, the active
 * conversation, the current view) is captured up front and restored in `finally`.
 *
 * @see docs/REFACTOR_PLAN.md
 */

const SCRATCH_TITLE = '[smoke-harness] safe to delete';

/** The deliberate seam exposed by app.js. */
function app() {
    const t = window.__tessera;
    if (!t) {
        throw new Error(
            'window.__tessera is missing — the app.js test seam is gone. ' +
            'If this is after a refactor slice, re-wire it in main.js.'
        );
    }
    return t;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

class CheckFailure extends Error {}

function fail(msg) {
    throw new CheckFailure(msg);
}

function assertEqual(actual, expected, what) {
    if (actual !== expected) {
        fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

// ---------------------------------------------------------------------------
// Observations — the same numbers the investigation compared by hand
// ---------------------------------------------------------------------------

/** Assistant/user message bubbles currently rendered in the main area. */
function domMessages() {
    const { elements } = app();
    return [...elements.messagesContainer.querySelectorAll('.message')]
        .filter((el) => !el.classList.contains('typing-indicator-container'));
}

/** Messages the active conversation holds in state. */
function stateMessages() {
    const { state } = app();
    const convo = state.conversations[state.activeConversationId];
    return (convo && convo.messages) || [];
}

/**
 * The bug-1 invariant: what's on screen matches what's in state. A live
 * streaming bubble is legitimately in the DOM before its message is pushed to
 * the array, so allow exactly one extra when a turn is in flight.
 */
function assertDomMatchesState(context) {
    const dom = domMessages().length;
    const st = stateMessages().length;
    const { state } = app();
    const streaming = !!state.streamingMessageDiv;
    const allowed = streaming ? [st, st + 1] : [st];
    if (!allowed.includes(dom)) {
        fail(
            `${context}: ${dom} message(s) on screen but ${st} in state` +
            `${streaming ? ' (a turn is in flight, so +1 is allowed)' : ''}` +
            ' — a reply exists in the data but is not rendered'
        );
    }
}

/** The bug-1 root cause, checked directly: a DOM pointer that left the document. */
function assertNoOrphanedBubble(context) {
    const { state } = app();
    const div = state.streamingMessageDiv;
    if (div && !document.contains(div)) {
        fail(
            `${context}: state.streamingMessageDiv is detached from the document ` +
            '— stream chunks are being written into an orphaned node'
        );
    }
}

/** Rendered indices must line up with the state array, with no gaps. */
function assertContiguousIndices(context) {
    const idx = domMessages()
        .map((el) => el.dataset.msgIndex)
        .filter((v) => v !== undefined && v !== '')
        .map(Number);
    for (let i = 0; i < idx.length; i++) {
        if (idx[i] !== i) {
            fail(`${context}: data-msg-index runs [${idx.join(', ')}] — expected 0..${idx.length - 1}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Provider stub
// ---------------------------------------------------------------------------

/**
 * Stub `API.chat.stream` with a controllable fake that emits provider-shaped
 * SSE payloads. `chunks` deltas, `gapMs` apart — slow enough that a test can
 * navigate mid-response.
 */
function stubStream({ chunks = 6, gapMs = 120, text = 'chunk' } = {}) {
    const { API } = app();
    API.chat.stream = async function (params, onEvent) {
        for (let i = 0; i < chunks; i++) {
            await sleep(gapMs);
            const piece = `${text}${i} `;
            onEvent({
                data: JSON.stringify(
                    params.provider === 'google'
                        ? { candidates: [{ content: { parts: [{ text: piece }] } }] }
                        : { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } }
                ),
            });
        }
    };
}

/** Stub the non-streaming endpoint with a fixed delay. */
function stubSend({ delayMs = 400, text = 'non-streaming reply' } = {}) {
    const { API } = app();
    API.chat.send = async function () {
        await sleep(delayMs);
        return { text };
    };
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

function railClick(section) {
    const btn = document.querySelector(`.rail-item[data-section="${section}"]`);
    if (!btn) fail(`no rail item for section "${section}"`);
    btn.click();
}

function openChatRow(conversationId) {
    const row = document.querySelector(`.conversation-info[data-conversation-id="${conversationId}"]`);
    if (!row) fail(`conversation ${conversationId} is not in the chats list`);
    row.click();
}

async function typeAndSend(text) {
    const { elements, sendMessage } = app();
    elements.messageInput.value = text;
    elements.messageInput.dispatchEvent(new Event('input'));
    return sendMessage();
}

// ---------------------------------------------------------------------------
// Checks
//
// Each returns nothing and throws CheckFailure on failure. `ctx` carries the
// throwaway conversation ids created by run().
// ---------------------------------------------------------------------------

const CHECKS = [
    {
        id: 'rail-round-trip',
        what: 'compose → leave via each rail section → return → composer is usable',
        // This one passes today. It is here so the refactor cannot break it
        // silently: it is the path the original bug report described.
        async run(ctx) {
            const { state, elements, switchConversation } = app();
            for (const section of ['workspaces', 'personas', 'models', 'settings', 'chats']) {
                await switchConversation(ctx.chatA);
                await sleep(60);
                elements.messageInput.value = `draft via ${section}`;
                elements.messageInput.dispatchEvent(new Event('input'));

                railClick(section);
                await sleep(80);
                assertEqual(elements.inputContainer.hidden, true,
                    `composer must be hidden on the "${section}" view`);

                railClick('chats');
                await sleep(80);
                openChatRow(ctx.chatA);
                await sleep(150);

                assertEqual(state.ui.mainView.type, 'chat', `back in a chat after "${section}"`);
                assertEqual(elements.inputContainer.hidden, false,
                    `composer must be visible again after "${section}"`);
                assertEqual(elements.messagesContainer.hidden, false,
                    `messages container must be visible again after "${section}"`);
                assertEqual(elements.sendButton.disabled, false,
                    `send must be enabled with a draft present after "${section}"`);
            }
        },
    },

    {
        id: 'stream-survives-navigation',
        what: 'leaving and returning mid-response keeps the reply on screen',
        // BUG 1. Currently FAILS.
        async run(ctx) {
            const { switchConversation } = app();
            stubStream({ chunks: 8, gapMs: 120 });

            await switchConversation(ctx.chatA);
            await sleep(60);
            const pending = typeAndSend('stream survives navigation?');

            await sleep(250);                       // mid-response
            assertNoOrphanedBubble('while streaming, before navigating');

            railClick('personas');                  // leave mid-response
            await sleep(200);
            assertNoOrphanedBubble('after navigating away mid-response');

            railClick('chats');
            await sleep(80);
            openChatRow(ctx.chatA);
            await sleep(250);                       // back, still mid-response
            assertNoOrphanedBubble('after returning mid-response');
            assertDomMatchesState('after returning mid-response');

            await pending;
            await sleep(200);
            assertDomMatchesState('after the turn completed');
            assertContiguousIndices('after the turn completed');
        },
    },

    {
        id: 'non-streaming-reply-lands-in-the-chat',
        what: 'a non-streaming reply is not rendered into whatever list is showing',
        // BUG 1, other face. Currently FAILS.
        async run(ctx) {
            const { state, switchConversation, getActiveModelConfig } = app();
            const params = getActiveModelConfig().modelParams;
            const wasStreaming = params.streaming;
            params.streaming = false;
            stubSend({ delayMs: 600 });
            try {
                await switchConversation(ctx.chatA);
                await sleep(60);
                const pending = typeAndSend('non-streaming reply placement?');

                await sleep(150);
                railClick('workspaces');            // leave while the request is in flight
                await pending;
                await sleep(150);

                assertEqual(state.ui.mainView.type, 'workspaces', 'still on the workspaces view');
                const strays = [...app().elements.messagesContainer.querySelectorAll('.message')];
                if (strays.length > 0) {
                    fail(
                        `${strays.length} chat message(s) rendered into the workspaces list ` +
                        `— e.g. "${strays[0].textContent.trim().slice(0, 40)}"`
                    );
                }
            } finally {
                params.streaming = wasStreaming;
            }
        },
    },

    {
        id: 'draft-is-per-conversation',
        what: 'the composer draft and pending attachments do not follow you to another chat',
        // BUG 2. Currently FAILS.
        async run(ctx) {
            const { state, elements, switchConversation } = app();
            await switchConversation(ctx.chatA);
            await sleep(60);
            elements.messageInput.value = 'DRAFT BELONGING TO CHAT A';
            elements.messageInput.dispatchEvent(new Event('input'));

            await switchConversation(ctx.chatB);
            await sleep(120);

            if (elements.messageInput.value !== '') {
                fail(
                    `chat B's composer contains chat A's draft ` +
                    `("${elements.messageInput.value}") — sending would file it under the wrong chat`
                );
            }
            assertEqual(state.pendingAttachments.length, 0,
                "chat B's pending attachments must not carry over from chat A");
        },
    },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run the harness.
 * @param {Object} [opts]
 * @param {string[]} [opts.only] - check ids to run (default: all)
 * @returns {Promise<{passed:number, failed:number, results:Array}>}
 */
export async function run(opts = {}) {
    const t = app();
    const { state, elements, API } = t;

    if (!state.user) throw new Error('Not signed in — sign in (or use dev login) before running the harness.');

    const toRun = opts.only ? CHECKS.filter((c) => opts.only.includes(c.id)) : CHECKS;

    // ---- capture everything we are about to touch -------------------------
    const saved = {
        stream: API.chat.stream,
        send: API.chat.send,
        conversationId: state.activeConversationId,
        view: state.ui.mainView,
        draft: elements.messageInput.value,
        provider: t.getActiveModelConfig().provider,
    };
    const keyStatus = state.apiKeyStatus[saved.provider];
    const savedHasKey = keyStatus ? keyStatus.hasKey : undefined;

    const ctx = { chatA: null, chatB: null };
    const results = [];

    try {
        // A stubbed provider needs no real key, but sendMessage's guard checks
        // one — force it on for the run.
        if (keyStatus) keyStatus.hasKey = true;

        // Throwaway conversations, so nothing here can touch real chats.
        const a = await API.conversations.create({ personaId: state.activePersonaId, title: SCRATCH_TITLE });
        const b = await API.conversations.create({ personaId: state.activePersonaId, title: SCRATCH_TITLE });
        ctx.chatA = a.id;
        ctx.chatB = b.id;
        for (const created of [a, b]) {
            state.conversations[created.id] = {
                id: created.id,
                title: created.title,
                personaId: created.personaId,
                projectId: created.projectId,
                workspaceId: created.workspaceId,
                toolsEnabled: created.toolsEnabled ?? null,
                scratchpadEnabled: created.scratchpadEnabled ?? null,
                createdAt: created.createdAt,
                updatedAt: created.updatedAt,
                messageCount: 0,
                messages: [],
            };
        }

        console.log(`%cFrontend smoke harness — ${toRun.length} check(s)`, 'font-weight:bold');

        for (const check of toRun) {
            stubStream();                      // sane default; checks may re-stub
            stubSend();
            try {
                await check.run(ctx);
                results.push({ id: check.id, pass: true, what: check.what });
                console.log(`%c  PASS  %c${check.id} — ${check.what}`, 'color:#3fb950', 'color:inherit');
            } catch (err) {
                if (!(err instanceof CheckFailure)) throw err;
                results.push({ id: check.id, pass: false, what: check.what, detail: err.message });
                console.log(`%c  FAIL  %c${check.id} — ${check.what}`, 'color:#f85149', 'color:inherit');
                console.log(`        ${err.message}`);
            }
            // Let any turn left in flight settle before the next check.
            for (let i = 0; i < 40 && state.isLoading; i++) await sleep(100);
        }
    } finally {
        API.chat.stream = saved.stream;
        API.chat.send = saved.send;
        if (keyStatus && savedHasKey !== undefined) keyStatus.hasKey = savedHasKey;

        for (const id of [ctx.chatA, ctx.chatB]) {
            if (!id) continue;
            try {
                await API.conversations.delete(id);
            } catch (err) {
                console.warn(`Harness could not delete its scratch chat ${id}:`, err);
            }
            delete state.conversations[id];
        }

        state.activeConversationId = saved.conversationId;
        elements.messageInput.value = saved.draft;
        t.navigate(saved.view);
    }

    const passed = results.filter((r) => r.pass).length;
    const failed = results.length - passed;
    console.log(
        `%c${passed} passed, ${failed} failed`,
        `font-weight:bold;color:${failed ? '#f85149' : '#3fb950'}`
    );
    return { passed, failed, results };
}

export { CHECKS };
