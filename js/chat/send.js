/**
 * The send path (R-05, moved verbatim from main.js).
 *
 * Building a request, calling the provider (streaming and not), rendering the
 * reply as it arrives, live tool activity, re-runs and retries, and stopping a
 * turn.
 *
 * BUG 1 WAS FIXED HERE (F-03). This code used to store a raw DOM node in
 * `state.streamingMessageDiv` and write into it for the whole response — a DOM
 * pointer held across an await, which rule 1 forbids. Navigating away detached
 * that node and the rest of the reply went into an orphan.
 *
 * Now `state.streamingAccumulator` plus `state.streamingConversationId` are the
 * truth, and the bubble is RE-DERIVED on each use via `streamingBubble()`. If
 * the chat is not the view on screen there is simply nothing to paint into: the
 * turn keeps running, state keeps accumulating, and renderChatThread() paints
 * the live bubble when the user returns.
 */

import { state } from '../state.js';
import { elements, scrollToBottom, scrollToBottomIfPinned, isPinnedToBottom } from '../dom.js';
import { API } from '../api-client.js';
import { CONFIG } from '../config.js';
import { getActivePersona, getActiveConversation } from '../state.js';
import { getActiveModelConfig, updateSendButtonState } from '../model-layer.js';
import { createConversation, renderConversation } from '../views/chats.js';
import { UiPrefs } from '../ui-prefs.js';
import { renderMarkdown, messageActionsHTML } from '../util/markdown.js';
import { FilePanel } from '../file-panel/index.js';
import { ImageStore } from '../util/image-store.js';
import { showToast } from '../components/toast.js';
import { displayError } from '../components/errors.js';
import {
    appendMessage, persistMessage, showTypingIndicator, hideTypingIndicator,
    generateConversationTitle, toolEventToAttachment, truncateMessagesFrom,
    renderMessageAttachments, streamingBubble, paintStreamingBubble,
    renderStreamingContent, threadIsVisible, renderChatThread, streamingDisplayText,
    renderMessageBody,
} from './thread.js';
import {
    detectExpression, setExpression, settleGeneratingExpression,
    stripExpressionTag, stripPrefillText, } from './expressions.js';
import {
    buildAttachmentContentBlocks, storeAttachmentsToIndexedDB, renderAttachmentPreviews,
    isTextWorkingFileUpload, createWorkingFilesFromUploads, clearDraft,
} from './composer.js';
import { updateStatusBar } from '../status-bar.js';

export async function rerunFromMessage(msgIndex) {
    const activeConvo = getActiveConversation();
    if (!activeConvo || !activeConvo.messages[msgIndex]) return;
    if (state.isLoading) return;

    const msg = activeConvo.messages[msgIndex];

    // The turn being re-rolled = the user-message count up to (and including) it.
    // Any file the model changed at that turn or later is rolled back first
    // (FC-06a), so the re-run starts from the pre-turn file state rather than the
    // already-edited one.
    const fromTurn = activeConvo.messages.slice(0, msgIndex + 1).filter(m => m.role === 'user').length;
    await revertConversationFilesForRerun(activeConvo.id, fromTurn);

    if (msg.role === 'user') {
        // Truncate everything from this index onward, resend this user message.
        const textToResend = msg.content;
        const attachmentsToResend = msg.attachments || [];
        await truncateMessagesFrom(activeConvo, msgIndex);
        renderConversation();
        sendMessageFromText(textToResend, attachmentsToResend);
    } else if (msg.role === 'assistant') {
        // Find the preceding user message, remove from this assistant onward, resend.
        const precedingUserMsg = activeConvo.messages.slice(0, msgIndex).reverse().find(m => m.role === 'user');
        if (!precedingUserMsg) return;

        await truncateMessagesFrom(activeConvo, msgIndex);
        renderConversation();
        sendMessageFromText(precedingUserMsg.content, precedingUserMsg.attachments || []);
    }
}

/**
 * Roll back model file changes before a re-roll (FC-06a). Best-effort: a failure
 * must not block the re-run, and any files that couldn't be rolled back (e.g.
 * older than the stored snapshots) are surfaced as a warning toast.
 */
export async function revertConversationFilesForRerun(conversationId, fromTurn) {
    try {
        const res = await API.conversations.revertFiles(conversationId, fromTurn);
        if (res && Array.isArray(res.warnings) && res.warnings.length > 0) {
            showToast(res.warnings.join(' '), { type: 'warning' });
        }
        // SP-04: the scratchpad may have been rolled back to its pre-turn state;
        // refresh it if it's open in view mode so the user sees the reverted pad.
        if (res && res.scratchpadReverted) FilePanel.refreshScratchpadFromActivity(conversationId);
    } catch (err) {
        console.error('Failed to roll back files before re-roll:', err);
    }
}

/**
 * Retry the most recent turn after a send failure. Finds the last user
 * message and re-runs generation from it (which truncates any partial reply
 * and resends). Used as the retry handler for inline chat errors (P0-17).
 */
export function retryLastUserMessage() {
    const convo = getActiveConversation();
    if (!convo || state.isLoading) return;
    for (let i = convo.messages.length - 1; i >= 0; i--) {
        if (convo.messages[i].role === 'user') {
            rerunFromMessage(i);
            return;
        }
    }
}

export async function sendMessageFromText(text, attachments = []) {
    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;
    if (!state.apiKeyStatus[provider]?.hasKey || state.isLoading) return;

    // Commit a dirty scratchpad draft first (Decision 11), same as sendMessage.
    await FilePanel.autoSaveScratchpadOnSend();

    state.isLoading = true;
    updateSendButtonState();

    await appendMessage('user', text, true, null, attachments.length > 0 ? attachments : null);
    showTypingIndicator();
    setExpression(CONFIG.generatingExpression); // held until the response completes

    try {
        let response;
        if (modelConfig.modelParams.streaming) {
            hideTypingIndicator();
            elements.sendButton.style.display = 'none';
            elements.stopButton.style.display = '';
            startStreamingMessage();
            // Pin the conversation id at send-time so a mid-stream switch
            // doesn't redirect the assistant reply.
            const targetConvoId = state.activeConversationId;
            try {
                // callAPIStreaming returns { text, generatedImages } always —
                // including on abort, since API.chat.stream swallows
                // AbortError and lets us finalize with the accumulator-so-far.
                response = await callAPIStreaming(text, attachments);
                await finalizeStreamingMessage(response.text || '', response.generatedImages || [], targetConvoId);
            } catch (error) {
                // Real error (network / 4xx / 5xx) — abort is no longer
                // surfaced here because API.chat.stream returns normally on
                // user-initiated abort.
                const failedBubble = streamingBubble();
                if (failedBubble) failedBubble.remove();
                state.streamingConversationId = null;
                throw error;
            } finally {
                if (elements.stopButton) elements.stopButton.style.display = 'none';
                if (elements.sendButton) elements.sendButton.style.display = '';
            }
        } else {
            response = await callAPI(text, attachments);
            hideTypingIndicator();

            let responseText = response.text || '';
            const responseAttachments = response.attachments || [];

            // Strip prefill from response
            if (state.currentPrefill) {
                responseText = stripPrefillText(responseText, state.currentPrefill);
                state.currentPrefill = '';
            }

            const detectedExpr = detectExpression(responseText);
            await setExpression(detectedExpr);
            await appendMessage('assistant', responseText, true, null, responseAttachments.length > 0 ? responseAttachments : null);
        }
    } catch (error) {
        hideTypingIndicator();
        settleGeneratingExpression();
        displayError(error, { surface: 'chat', retryHandler: retryLastUserMessage });
        console.error('API Error:', error);
    } finally {
        state.isLoading = false;
        updateSendButtonState();
    }
}

/**
 * Append a live tool-activity chip/card to the in-progress streaming message
 * (converted to the same attachment shape used at reload, so live and reload
 * render identically). `convoId` is the conversation the stream was started
 * in, so the file panel ignores events from a chat the user has left.
 */
export function renderLiveToolActivity(payload, convoId) {
    const bubble = streamingBubble();
    const att = toolEventToAttachment(payload);
    if (bubble) {
        // Close the current text segment and open a fresh one below the card, so
        // the reply keeps growing UNDER the tool it just ran rather than the card
        // sitting above everything. `payload.textOffset` was recorded when the
        // event arrived, so a reload renders the same order (renderMessageBody).
        const area = document.createElement('div');
        area.className = 'message-attachments inline';
        renderMessageAttachments([att], area);
        bubble.appendChild(area);

        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        bubble.appendChild(contentDiv);
        // The fresh segment is empty, so the turn is "waiting" again: let
        // renderStreamingContent put the dots back until the model resumes.
        renderStreamingContent();
    }
    FilePanel.notifyActivity(att, convoId);
    // Scratchpad writes carry a `scratchpad` marker (no url → a plain chip):
    // refresh the pad if it's open so the user sees the model's edit live.
    if (payload && payload.scratchpad) FilePanel.refreshScratchpadFromActivity(convoId);
    scrollToBottomIfPinned();
}

// ===== API Communication =====
export async function sendMessage() {
    const userMessage = elements.messageInput.value.trim();
    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;
    const hasApiKey = !!state.apiKeyStatus[provider]?.hasKey;

    const hasAttachments = state.pendingAttachments.length > 0;
    if ((!userMessage && !hasAttachments) || !hasApiKey || state.isLoading) {
        return;
    }

    // Commit a dirty scratchpad draft first (Decision 11) so the model sees it
    // this turn, not stale content. Awaited before the request is built.
    await FilePanel.autoSaveScratchpadOnSend();

    elements.messageInput.value = '';
    // F-04: the draft has become a message — drop it so it cannot reappear when
    // the user comes back to this chat.
    clearDraft(state.activeConversationId);
    elements.messageInput.style.height = 'auto';
    state.isLoading = true;
    updateSendButtonState();

    // CF-02: text uploads become chat WORKING FILES (created before the user
    // message so their revision is stamped at currentTurn-1 → FC-03b injects
    // them on this very turn). Images/audio/PDF stay on the inline path.
    // `inlineMeta` (blobs in IndexedDB, base64'd into the request) is what
    // callAPI* inlines; working files are injected server-side, not inlined.
    const pending = state.pendingAttachments;
    const textUploads = pending.filter(isTextWorkingFileUpload);
    const inlineUploads = pending.filter(a => !isTextWorkingFileUpload(a));
    state.pendingAttachments = [];
    renderAttachmentPreviews();

    // Working files need a saved conversation; create one first if this is the
    // opening message of a fresh chat.
    if (textUploads.length > 0 && !state.activeConversationId) {
        try {
            await createConversation(generateConversationTitle(userMessage || '(attached files)'));
        } catch (err) {
            console.error('Could not create conversation for working files:', err);
        }
    }

    let workingFileAtts = [];
    let inlineFallback = [];
    if (textUploads.length > 0 && state.activeConversationId) {
        const result = await createWorkingFilesFromUploads(state.activeConversationId, textUploads);
        workingFileAtts = result.created;
        inlineFallback = result.failed;
    } else {
        inlineFallback = textUploads; // no conversation → fall back to inline
    }

    // Inline attachments (images/audio/PDF + any working-file creation failures)
    // still go through IndexedDB.
    let inlineMeta = [];
    const toInline = [...inlineUploads, ...inlineFallback];
    if (toInline.length > 0) {
        inlineMeta = await storeAttachmentsToIndexedDB(toInline);
    }

    // The message records both: working files as file cards, inline ones as
    // their usual attachment metadata. Only inlineMeta is inlined into the
    // request content below.
    const messageAtts = [...workingFileAtts, ...inlineMeta];

    // Surface the newest working file in the panel/explorer, matching how a
    // model-created file behaves (auto-open or edge dot per filePanelMode).
    if (workingFileAtts.length > 0) {
        FilePanel.notifyActivity(workingFileAtts[workingFileAtts.length - 1], state.activeConversationId);
    }

    await appendMessage('user', userMessage || '(attached files)', true, null, messageAtts.length > 0 ? messageAtts : null);

    if (modelConfig.modelParams.streaming) {
        // Streaming path
        showTypingIndicator();
        elements.sendButton.style.display = 'none';
        elements.stopButton.style.display = '';

        try {
            hideTypingIndicator();
            startStreamingMessage();
            // Hold the generating state for the whole response;
            // finalizeStreamingMessage applies the declared expression at the end.
            setExpression(CONFIG.generatingExpression);
            // Pin the conversation id at send-time so a mid-stream switch
            // doesn't redirect the assistant reply.
            const targetConvoId = state.activeConversationId;

            // callAPIStreaming always returns { text, generatedImages }
            // — including on abort (api-client swallows AbortError and we
            // finalize with the accumulator-so-far).
            const result = await callAPIStreaming(userMessage, inlineMeta);
            await finalizeStreamingMessage(result.text || '', result.generatedImages || [], targetConvoId);
        } catch (error) {
            // Real error path; abort flows through normally now.
            const abortedBubble = streamingBubble();
            if (abortedBubble) abortedBubble.remove();
            state.streamingConversationId = null;
            hideTypingIndicator();
            settleGeneratingExpression();
            displayError(error, { surface: 'chat', retryHandler: retryLastUserMessage });
            console.error('API Error:', error);
        } finally {
            state.isLoading = false;
            elements.sendButton.style.display = '';
            elements.stopButton.style.display = 'none';
            updateSendButtonState();
        }
    } else {
        // Non-streaming path
        showTypingIndicator();
        setExpression(CONFIG.generatingExpression); // restored from the response below

        try {
            const response = await callAPI(userMessage, inlineMeta);

            hideTypingIndicator();

            // callAPI now always returns { text, attachments? } — the
            // dual-shape handling from the old direct-fetch path is gone.
            let responseText = response.text || '';
            const responseAttachments = response.attachments || [];

            // Strip prefill from response
            if (state.currentPrefill) {
                responseText = stripPrefillText(responseText, state.currentPrefill);
                state.currentPrefill = '';
            }

            // Detect expression from response
            const detectedExpr = detectExpression(responseText);
            await setExpression(detectedExpr);

            // Strip expression tag and display (with any generated attachments)
            await appendMessage('assistant', responseText, true, null, responseAttachments.length > 0 ? responseAttachments : null);

        } catch (error) {
            hideTypingIndicator();
            settleGeneratingExpression();
            displayError(error, { surface: 'chat', retryHandler: retryLastUserMessage });
            console.error('API Error:', error);
        } finally {
            state.isLoading = false;
            updateSendButtonState();
        }
    }
}

/**
 * Build the body sent to /api/chat[/stream]. Shared by streaming and
 * non-streaming paths. The server uses the user's stored API key — the
 * frontend doesn't include one in the payload. The server-side providers
 * also append the prefill to messages when assembling the upstream request,
 * so the frontend must NOT push prefill into messages itself.
 */
export function buildChatRequest() {
    const modelConfig = getActiveModelConfig();
    const persona = getActivePersona();
    const activeConvo = getActiveConversation();
    const conversationMessages = activeConvo ? activeConvo.messages : [];
    const systemPrompt = persona ? persona.systemPrompt : CONFIG.defaults.systemPrompt;
    // Prefill is an engine param: it rides on the model profile, not the persona.
    const prefillText = modelConfig.modelParams?.prefill?.trim() || '';

    // The model echoes back the prefill — track it so appendStreamChunk and
    // the non-streaming branch can strip it from displayed/persisted output.
    state.currentPrefill = prefillText;

    // Record which model this request uses so the assistant reply can be
    // tagged with it (WR-14) — read the layer NOW, not at append time, in
    // case the user switches models while the response streams.
    state.lastRequestModel = modelConfig.model;

    const messages = conversationMessages.map(msg => ({
        role: msg.role,
        content: msg.content,
    }));

    return {
        provider: modelConfig.provider,
        model: modelConfig.model,
        messages,
        systemPrompt,
        // The server's Tessera base layer names these in the expression
        // protocol, so the model is told the persona's REAL expression set
        // rather than a list frozen into the prompt text at creation.
        expressionNames: Object.keys(persona ? persona.expressions || {} : {}),
        modelParams: modelConfig.modelParams,
        ...(prefillText ? { prefill: prefillText } : {}),
        // Lets the server resolve this conversation's project and inject its
        // instructions + file context (P1-05). Harmless when there's no project.
        ...(state.activeConversationId ? { conversationId: state.activeConversationId } : {}),
        // When there's no conversation yet, still let the server resolve the
        // active workspace so the preview shows its injected context.
        ...(!state.activeConversationId && state.activeProjectId ? { projectId: state.activeProjectId } : {}),
    };
}

/**
 * Reflect the device-local devMode pref: show/hide the top-bar "view request"
 * button and sync the settings toggle.
 */
export function applyDevMode() {
    const on = !!UiPrefs.get('devMode');
    if (elements.viewRequestBtn) elements.viewRequestBtn.hidden = !on;
    if (elements.devModeToggle) elements.devModeToggle.checked = on;
}

/**
 * Non-streaming chat via the backend proxy. Server returns
 * { text, model, usage?, stopReason?, generatedImages? }.
 * Returns { text, attachments? } where attachments are stored generated
 * images (Gemini multimodal output).
 */
export async function callAPI(userMessage, attachments = []) {
    const params = buildChatRequest();
    if (attachments.length > 0 && params.messages.length > 0) {
        const lastMsg = params.messages[params.messages.length - 1];
        if (lastMsg.role === 'user') {
            lastMsg.content = await buildAttachmentContentBlocks(lastMsg.content, attachments, params.provider);
        }
    }

    // Pinned before the await: if the user switches chats while the request
    // is in flight, the file panel must not react in the wrong conversation.
    const convoId = state.activeConversationId;
    const res = await API.chat.send(params);
    if (res.contextWarning) showProjectContextWarning(res.contextWarning);
    // Track A: a tools-on non-streaming turn returns the tool-event list; turn
    // it into chip/card attachments (same shape as the streaming path).
    const toolAttachments = (res.toolEvents || []).map(toolEventToAttachment);
    // Only the turn's last created file opens/alerts the panel — notifying
    // each one would fetch files that are immediately replaced on screen.
    const lastCreated = [...toolAttachments].reverse().find(a => a.type === 'created_file');
    if (lastCreated) FilePanel.notifyActivity(lastCreated, convoId);
    // If the model wrote to the scratchpad, refresh it if it's open (SP-03a).
    if ((res.toolEvents || []).some(ev => ev && ev.scratchpad)) FilePanel.refreshScratchpadFromActivity(convoId);
    const generatedAttachments = res.generatedImages
        ? await storeGeneratedImages(res.generatedImages)
        : [];
    return { text: res.text || '', attachments: [...toolAttachments, ...generatedAttachments] };
}

/**
 * Show a soft, deduplicated warning when a project's injected context was
 * truncated or partially unavailable (budget exceeded / Drive issue).
 * @param {string} message
 */
export function showProjectContextWarning(message) {
    showToast(message, { type: 'warning', duration: 8000, key: 'project-context-warning' });
}

// ===== Streaming Support =====
/**
 * Streaming chat via /api/chat/stream. Server forwards the provider's native
 * SSE events; we parse the data JSON and dispatch on shape.
 * On abort (user clicked stop), API.chat.stream resolves normally — the
 * accumulator holds the partial text, which is what callers want.
 */
export async function callAPIStreaming(userMessage, attachments = []) {
    const params = buildChatRequest();
    if (attachments.length > 0 && params.messages.length > 0) {
        const lastMsg = params.messages[params.messages.length - 1];
        if (lastMsg.role === 'user') {
            lastMsg.content = await buildAttachmentContentBlocks(lastMsg.content, attachments, params.provider);
        }
    }

    state.streamingAccumulator = '';
    state.streamingGeneratedImages = [];
    state.streamingToolEvents = [];

    // Pinned for the file panel: tool events arriving after the user switches
    // chats mid-stream must not open the panel in the wrong conversation.
    const convoId = state.activeConversationId;

    await API.chat.stream(params, (ev) => {
        // Synthetic event from the client (not provider SSE): project-context
        // budget/Drive warning surfaced from the response header.
        if (ev.event === 'project-context-warning') {
            if (ev.warning) showProjectContextWarning(ev.warning);
            return;
        }
        if (!ev.data) return;
        let payload;
        try { payload = JSON.parse(ev.data); } catch { return; }

        // Track A tool loop (tools-on turns run non-streaming server-side and
        // deliver activity as synthetic events, then the final answer as one
        // provider-native chunk handled below): render a chip per tool as it
        // runs; the done event's list is authoritative but matches what we
        // already collected, so finalize persists state.streamingToolEvents.
        if (payload.type === 'tool_activity') {
            // Stamp WHERE in the reply this tool ran. Capturing it live is the
            // only chance — nothing about the finished text says when a tool
            // fired. Recorded against the RAW accumulator, which is unambiguous;
            // the live view and the stored message clean that text differently
            // (a leading tag vs all tags plus a trim), so each converts this one
            // offset into its own coordinates rather than sharing a guess.
            payload.rawOffset = (state.streamingAccumulator || '').length;
            state.streamingToolEvents.push(payload);
            renderLiveToolActivity(payload, convoId);
            return;
        }
        if (payload.type === 'tool_loop_done') {
            return;
        }

        // C7: providers can emit an error event *mid-stream* (e.g. Anthropic's
        // `{type:'error', error:{type,message}}` for overloaded_error, or a
        // bare `{error:{...}}` from Gemini). The HTTP response was 200, so this
        // is the only place we'd learn the turn failed. Synthesize an
        // ApiError-shaped object and throw — the throw rejects the stream
        // promise, which surfaces in the chat catch (partial bubble removed,
        // inline error + Retry shown).
        if (payload.type === 'error' || (payload.error && typeof payload.error === 'object')) {
            const provErr = payload.error || {};
            const err = new Error(provErr.message || 'The provider reported an error mid-response.');
            err.name = 'ApiError';
            err.code = 'PROVIDER_ERROR';
            err.status = 502;
            err.details = provErr.type ? { providerErrorType: provErr.type } : undefined;
            throw err;
        }

        if (params.provider === 'anthropic') {
            // Anthropic uses named SSE events; we dispatch on payload.type
            // (which mirrors event name) so we don't depend on the api-client
            // parsing the event line.
            if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta') {
                appendStreamChunk(payload.delta.text);
            }
        } else if (params.provider === 'google') {
            // Gemini sends unnamed events; text + inline image data live
            // under candidates[0].content.parts.
            const parts = payload.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
                if (part.text) {
                    appendStreamChunk(part.text);
                } else {
                    const inline = part.inlineData || part.inline_data;
                    if (inline) {
                        state.streamingGeneratedImages.push({
                            mimeType: inline.mimeType || inline.mime_type,
                            base64Data: inline.data,
                        });
                    }
                }
            }
        }
    });

    return {
        text: state.streamingAccumulator,
        generatedImages: state.streamingGeneratedImages,
        toolEvents: state.streamingToolEvents,
    };
}

/**
 * Store generated images from API response to IndexedDB
 * @param {Array} generatedImages - Array of { mimeType, base64Data }
 * @returns {Promise<Array>} - Array of attachment metadata
 */
export async function storeGeneratedImages(generatedImages) {
    const attachments = [];

    for (const img of generatedImages) {
        const key = `gen_${crypto.randomUUID()}`;
        const extension = img.mimeType.split('/')[1] || 'png';
        const fileName = `generated_${Date.now()}.${extension}`;

        // Convert base64 to blob
        const byteCharacters = atob(img.base64Data);
        const byteArray = new Uint8Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            byteArray[i] = byteCharacters.charCodeAt(i);
        }
        const blob = new Blob([byteArray], { type: img.mimeType });

        await ImageStore.store(key, blob);

        attachments.push({
            id: crypto.randomUUID(),
            type: 'generated',
            mimeType: img.mimeType,
            fileName: fileName,
            fileSize: blob.size,
            imageStoreKey: key
        });
    }

    return attachments;
}

export function startStreamingMessage() {
    // F-03: record WHICH conversation this turn belongs to, reset the
    // accumulators, then ask the thread to paint. The bubble is created only if
    // that conversation is the view on screen; if not, the turn still runs and
    // renderChatThread() paints it when the user comes back.
    state.streamingConversationId = state.activeConversationId;
    state.streamingAccumulator = '';
    state.streamingGeneratedImages = [];
    state.streamingToolEvents = [];

    paintStreamingBubble();
}

export function appendStreamChunk(text) {
    // Accumulate unconditionally — this is the source of truth for the reply,
    // and it must keep growing whether or not the chat is on screen.
    state.streamingAccumulator += text;
    // Render if the thread is showing. renderStreamingContent() re-derives the
    // bubble each time, so a chat left mid-stream simply has nothing to paint
    // into, instead of writing into a detached node.
    renderStreamingContent();
    // Only follow if the user is still at the bottom - reading back through
    // the log mid-reply must not be interrupted on every token.
    if (streamingBubble()) scrollToBottomIfPinned();
}

/**
 * Finalize the streaming assistant bubble.
 *
 * @param {string} fullText - the raw accumulator from the stream
 * @param {Array} generatedImages - Gemini multimodal images, if any
 * @param {string} [targetConvoId] - the conversation id this stream was
 *   started against. Pinning the convo here is critical: if the user
 *   switches to a different conversation mid-stream, `getActiveConversation()`
 *   would resolve to the NEW conversation at finalize-time, causing the
 *   assistant reply to be written to the wrong conversation server-side.
 *   Falls back to active for callers that don't pass it.
 */
export async function finalizeStreamingMessage(fullText, generatedImages = [], targetConvoId = null) {
    // F-03: `bubble` may be null because the user navigated away mid-response.
    // That must NOT stop the reply being assembled, persisted and pushed into
    // state — only the DOM work below is skipped, and renderChatThread() paints
    // the finished message when they come back.
    const bubble = streamingBubble();
    if (bubble) bubble.classList.remove('streaming');

    const detectedExpr = detectExpression(fullText);
    setExpression(detectedExpr);

    // Strip prefill + expression tag from the persisted/displayed text.
    const prefill = state.currentPrefill;
    let cleanText = fullText;
    if (prefill) {
        cleanText = stripPrefillText(cleanText, prefill);
        state.currentPrefill = '';
    }
    cleanText = stripExpressionTag(cleanText);

    // Each tool event's raw offset becomes an offset into the STORED text, by
    // cleaning the prefix the same way the whole text was cleaned and measuring
    // it. `stripExpressionTag` trims, so a boundary lands just past the last
    // non-space character — which is where a card wants to sit anyway.
    const storedOffsetFor = (rawOffset) => {
        let prefix = (fullText || '').slice(0, rawOffset);
        if (prefill) prefix = stripPrefillText(prefix, prefill);
        return Math.min(stripExpressionTag(prefix).length, cleanText.length);
    };

    // Assemble this turn's attachments: Track A tool artifacts (chips +
    // created-file cards) first, then any Gemini-generated images. Tool events
    // become persistable entries so they survive a reload — carrying their
    // position, which is what makes a reload reproduce the live order.
    const toolAttachments = (state.streamingToolEvents || []).map(ev => toolEventToAttachment({
        ...ev,
        textOffset: Number.isInteger(ev.rawOffset) ? storedOffsetFor(ev.rawOffset) : undefined,
    }));
    const imageAttachments = await storeGeneratedImages(generatedImages);
    const attachments = [...toolAttachments, ...imageAttachments];

    // Bail-out for empty results (e.g., user clicked Stop before any chunk
    // arrived). Persisting an empty assistant turn would pollute the
    // conversation context on the next send. Remove the empty bubble too.
    if (!cleanText.trim() && attachments.length === 0) {
        if (bubble) bubble.remove();
        state.streamingConversationId = null;
        state.streamingAccumulator = '';
        state.streamingGeneratedImages = [];
        state.streamingToolEvents = [];
        return;
    }

    // The live bubble was built segment by segment as the reply arrived. Rather
    // than patch it into shape, rebuild it from the authoritative attachment
    // set — the same call renderChatThread makes — so the finished turn is
    // byte-for-byte what a reload produces. (The repaint at the end of this
    // function covers the visible case; this keeps the bubble correct for the
    // moment in between, and when the thread is not on screen there is simply
    // no bubble to touch.)
    if (bubble) {
        bubble.querySelectorAll('.message-attachments, .message-content').forEach(el => el.remove());
        if (!cleanText && imageAttachments.length > 0) {
            renderMessageBody(bubble, '', attachments).innerHTML = '<em>Generated image(s)</em>';
        } else {
            renderMessageBody(bubble, cleanText, attachments);
        }

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'message-actions';
        actionsDiv.innerHTML = messageActionsHTML('Regenerate');
        bubble.appendChild(actionsDiv);
    }

    // Persist to server + local state. Awaits persistMessage so the server-
    // generated id is set on the local msg before any subsequent edit/delete.
    // Uses the convo this stream was started against (NOT the current active
    // convo) so a mid-stream conversation switch still writes the reply to
    // the original conversation.
    const targetConvo = targetConvoId
        ? state.conversations[targetConvoId]
        : getActiveConversation();
    if (targetConvo) {
        const msg = { role: 'assistant', content: cleanText, attachments };
        targetConvo.messages.push(msg);
        if (bubble) bubble.dataset.msgIndex = targetConvo.messages.length - 1;
        targetConvo.updatedAt = Date.now();
        try {
            const saved = await persistMessage(targetConvo.id, msg);
            if (saved && saved.id) msg.id = saved.id;
        } catch (err) {
            console.error('Failed to persist assistant message:', err);
        }
    }

    state.estimatedTokens += Math.ceil(fullText.length / 4);
    updateStatusBar();

    const finishedIn = state.streamingConversationId;
    state.streamingConversationId = null;
    state.streamingAccumulator = '';
    state.streamingGeneratedImages = [];
    state.streamingToolEvents = [];

    // F-03: if this conversation is on screen, repaint from state so the
    // finished message is rendered exactly as a reload would render it. This is
    // also what makes a reply that completed while the user was elsewhere
    // appear the moment they return.
    //
    // renderChatThread ends at the bottom, which is right when the user is
    // following along and wrong when they have scrolled up to re-read
    // something: the turn ending would snap them away. Capture where they were
    // and put them back. The finished bubble is near-identical in height to the
    // live one it replaces, so restoring the offset is visually stable.
    if (threadIsVisible(finishedIn)) {
        const pinned = isPinnedToBottom();
        const prevScroll = elements.messagesContainer ? elements.messagesContainer.scrollTop : 0;
        renderChatThread();
        if (!pinned && elements.messagesContainer) {
            elements.messagesContainer.scrollTop = prevScroll;
        }
    }
}

/**
 * Abort the in-flight chat stream. api-client.js handles the AbortController
 * lifecycle; callAPIStreaming returns the accumulator-so-far so partial text
 * is preserved as a normal completion.
 */
export function stopGeneration() {
    API.chat.abort();
}
