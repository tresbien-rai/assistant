/**
 * The message thread (R-05, moved verbatim from main.js).
 *
 * Everything that paints a conversation: the thread itself, one message bubble,
 * attachment cards, tool chips, created-file cards, the typing indicator, and
 * persisting a message to the server.
 *
 * This layer sits BELOW the send path — the send path calls `appendMessage`,
 * never the reverse. The message ACTIONS (copy / edit / delete / re-run) sit
 * above the send path instead, because a re-run re-enters it, so they stay in
 * main.js until js/chat/send.js lands.
 *
 * `renderChatThread` is registered with the shell seam (foot of this file) so
 * the router can paint a chat view without importing the chat code. That
 * registration is also the hook F-03 needs: once the in-progress reply lives in
 * state, this is what paints it on return.
 */

import { state } from '../state.js';
import { elements, scrollToBottom } from '../dom.js';
import { API } from '../api-client.js';
import { CONFIG } from '../config.js';
import { getActivePersona, getActiveConversation } from '../state.js';
import { registerShell } from '../shell.js';
import { getActiveModelConfig } from '../model-layer.js';
import { saveConversations, createConversation } from '../views/chats.js';
import { updateStatusBar } from '../status-bar.js';
import { renderMarkdown, messageActionsHTML } from '../util/markdown.js';
import { escapeHtml, getFileIcon, getFileTypeLabel } from '../util/format.js';
import { showToast } from '../components/toast.js';
import { ImageStore } from '../util/image-store.js';
import { FilePanel } from '../file-panel/index.js';
import { stripExpressionTag, stripPrefillText, splitLeadingExpressionTag } from './expressions.js';

/**
 * Generate a title from the first user message
 * @param {string} content - The first message content
 * @returns {string} A truncated title
 */
export function generateConversationTitle(content) {
    const maxLength = 50;
    const cleaned = content.trim().replace(/\s+/g, ' ');

    if (cleaned.length <= maxLength) {
        return cleaned;
    }

    return cleaned.substring(0, maxLength).trim() + '...';
}

/**
 * Persist a single new message to the server. Returns the server-augmented
 * message (with the server-generated id) so callers can update state.
 * Throws on failure — the caller can decide whether to surface the error.
 */
export async function persistMessage(conversationId, message) {
    return await API.messages.create(conversationId, {
        role: message.role,
        content: message.content,
        attachments: message.attachments || [],
        ...(message.model ? { model: message.model } : {}),
    });
}

/**
 * Display name for a per-message model tag (WR-14). Unlike
 * getModelDisplayName it searches EVERY provider's catalog — an old message
 * may have been generated under a different provider than the active one.
 */
export function modelTagLabel(modelId) {
    for (const models of Object.values(state.settings.customModels)) {
        const m = (models || []).find(x => x.id === modelId);
        if (m) return m.name;
    }
    return modelId; // removed from the catalog — show the raw id
}

/** Render the active conversation's message thread into the main area. */
/**
 * Is the message thread for `convoId` the thing currently on screen?
 *
 * F-03. The router owns the main area, so "is my chat showing?" is a question
 * about `state.ui.mainView` — not something the chat code may assume. Every DOM
 * write below is gated on this; the state updates happen regardless.
 */
export function threadIsVisible(convoId = state.activeConversationId) {
    const v = state.ui.mainView || {};
    return v.type === 'chat' && v.id === convoId;
}

/**
 * The live streaming bubble, RE-DERIVED from the DOM rather than remembered.
 *
 * This replaces `state.streamingMessageDiv`, a DOM node the send path used to
 * hold across every await of a response. Navigating away detached that node and
 * the rest of the reply was written into an orphan (bug 1). Looking it up on
 * each use means a detached node simply cannot be found: the writer no-ops on
 * the DOM, state keeps accumulating, and the bubble is repainted from state on
 * return.
 */
export function streamingBubble() {
    if (!state.streamingConversationId) return null;
    if (!threadIsVisible(state.streamingConversationId)) return null;
    return elements.messagesContainer.querySelector('.message.assistant.streaming');
}

/**
 * Render the accumulated stream text into the live bubble, if it is showing.
 * Shared by the first paint and by every subsequent chunk.
 */
export function renderStreamingContent() {
    const bubble = streamingBubble();
    if (!bubble) return;
    // The LAST segment is the live one: renderLiveToolActivity closes the
    // current segment and opens a fresh one each time a tool fires, so text
    // arriving after a tool card lands below it rather than rewriting the
    // whole reply above it.
    const segments = bubble.querySelectorAll('.message-content');
    const contentDiv = segments[segments.length - 1];
    if (!contentDiv) return;

    const { display, pending } = streamingDisplayText();
    const tail = pending ? '' : display.slice(streamingCutOffset(display));

    // Dots whenever the LIVE segment is still empty — which is the start of the
    // turn, and equally the wait after each tool card while the model resumes
    // writing. `pending` means the opening text might still turn out to be an
    // expression tag, so hold rather than flash a partial "[expre" on screen.
    // The caret is suppressed by the same class, so the two never both show.
    if (!tail) {
        bubble.classList.add('awaiting-first-token');
        contentDiv.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
        return;
    }
    bubble.classList.remove('awaiting-first-token');
    contentDiv.innerHTML = renderMarkdown(tail);
}

/**
 * The in-progress reply as it should be DISPLAYED: prefill removed, expression
 * tag held back. `pending` means the opening text might still turn out to be a
 * tag, so nothing should be painted yet.
 *
 * The expression is deliberately not applied here: the avatar holds `generating`
 * for the whole response, and finalizeStreamingMessage re-detects it from the
 * completed text.
 */
export function streamingDisplayText() {
    let raw = state.streamingAccumulator || '';
    if (state.currentPrefill) raw = stripPrefillText(raw, state.currentPrefill);
    return splitLeadingExpressionTag(raw);
}

/**
 * Convert a raw-accumulator offset into DISPLAY coordinates, by cleaning the
 * prefix exactly as the live view cleans the whole text and measuring it. Safe
 * because both cleanings only remove a leading run (the prefill, then a leading
 * expression tag), so cleaning a prefix yields a prefix of the cleaned text.
 */
export function displayOffsetFor(rawOffset) {
    let prefix = (state.streamingAccumulator || '').slice(0, rawOffset);
    if (state.currentPrefill) prefix = stripPrefillText(prefix, state.currentPrefill);
    return splitLeadingExpressionTag(prefix).display.length;
}

/**
 * Where the live segment starts — the most recent tool event's position, or 0
 * before any tool has run. Clamped, since the accumulator can be shorter than a
 * recorded offset after a reset.
 */
export function streamingCutOffset(display) {
    const events = state.streamingToolEvents || [];
    let cut = 0;
    for (const ev of events) {
        if (!Number.isInteger(ev.rawOffset)) continue;
        const at = displayOffsetFor(ev.rawOffset);
        if (at > cut) cut = at;
    }
    return Math.max(0, Math.min(display.length, cut));
}

/**
 * Paint (or repaint) the in-progress reply from `state.streamingAccumulator`.
 *
 * Called when a stream starts, and again by renderChatThread() when the user
 * comes back to a chat mid-response — which is what makes the live reply
 * survive navigation.
 */
export function paintStreamingBubble() {
    if (!state.streamingConversationId) return null;
    if (!threadIsVisible(state.streamingConversationId)) return null;
    const existing = streamingBubble();
    if (existing) return existing;

    const welcome = elements.messagesContainer.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message assistant streaming awaiting-first-token';

    const labelDiv = document.createElement('div');
    labelDiv.className = 'message-label';
    const persona = getActivePersona();
    labelDiv.textContent = persona ? persona.name : CONFIG.defaults.assistantName;
    messageDiv.appendChild(labelDiv);

    // Rebuild the whole interleaved body from state, not just an empty shell:
    // a reply the user left and came back to may already have tool cards in it,
    // and they have to land back at their point in the text.
    const { display } = streamingDisplayText();
    renderMessageBody(messageDiv, display, (state.streamingToolEvents || []).map(ev => toolEventToAttachment({
        ...ev,
        textOffset: Number.isInteger(ev.rawOffset) ? displayOffsetFor(ev.rawOffset) : undefined,
    })));
    elements.messagesContainer.appendChild(messageDiv);

    renderStreamingContent();
    scrollToBottom();
    return messageDiv;
}

export function renderChatThread() {
    elements.messagesContainer.innerHTML = '';

    const activeConvo = getActiveConversation();
    const messages = activeConvo ? activeConvo.messages : [];
    const persona = getActivePersona();
    const assistantName = persona ? persona.name : CONFIG.defaults.assistantName;

    if (messages.length === 0 && !threadIsVisible(state.streamingConversationId)) {
        const modelConfig = getActiveModelConfig();
        const provider = modelConfig.provider;
        const hasApiKey = !!state.apiKeyStatus[provider]?.hasKey;
        elements.messagesContainer.innerHTML = `
            <div class="welcome-message">
                <h1>Welcome!</h1>
                <p>${hasApiKey ? 'Start chatting with ' + assistantName + '!' : 'Add your API key in the Models tab (☰) to get started.'}</p>
            </div>
        `;
        return;
    }

    messages.forEach((msg, index) => {
        appendMessage(msg.role, msg.content, false, index, msg.attachments, msg.model || null);
    });

    // F-03: a reply may be streaming into this conversation right now. It is not
    // in `messages` yet — finalizeStreamingMessage pushes it at the end — so
    // paint it from the accumulator. This is what makes leaving and returning
    // mid-response show a live, still-growing bubble.
    paintStreamingBubble();

    scrollToBottom();
}

/**
 * Build a message's body: attachments + text, interleaved.
 *
 * A tool attachment carries `textOffset` — the index into the DISPLAY text at
 * which that tool ran, captured live as the reply streamed. Those render inline
 * at their point in the text, so a turn reads the way it happened: narration,
 * the tool card, then the rest of the answer. Everything without an offset
 * (uploads, generated images, and tool events from the non-streaming path,
 * which has no positional information) keeps the original behaviour and renders
 * as one block above the text.
 *
 * Offsets are clamped and sorted here rather than trusted, so a stale or
 * out-of-range value from an older stored message degrades to a sensible
 * position instead of throwing.
 *
 * @param {HTMLElement} messageDiv - the bubble to append into
 * @param {string} displayText - already stripped of prefill/expression tag
 * @param {Array} attachments
 * @returns {HTMLElement} the LAST `.message-content` — what a live stream writes into
 */
export function renderMessageBody(messageDiv, displayText, attachments) {
    const list = Array.isArray(attachments) ? attachments : [];
    const text = displayText || '';
    const at = (a) => Math.max(0, Math.min(text.length, a.textOffset));

    const inline = list
        .filter(a => Number.isInteger(a.textOffset))
        .sort((a, b) => at(a) - at(b));
    const above = list.filter(a => !Number.isInteger(a.textOffset));

    if (above.length > 0) {
        const attachDiv = document.createElement('div');
        attachDiv.className = 'message-attachments';
        renderMessageAttachments(above, attachDiv);
        messageDiv.appendChild(attachDiv);
    }

    const addSegment = (segment) => {
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        contentDiv.innerHTML = renderMarkdown(segment);
        messageDiv.appendChild(contentDiv);
        return contentDiv;
    };

    if (inline.length === 0) return addSegment(text);

    let cursor = 0;
    let i = 0;
    while (i < inline.length) {
        const offset = at(inline[i]);
        const segment = text.slice(cursor, offset);
        // An empty segment means two tools ran back to back with no text
        // between them — emit no empty paragraph, just let the cards stack.
        if (segment.trim()) addSegment(segment);
        cursor = offset;

        // Everything that fired at this same point renders as one group.
        const group = [];
        while (i < inline.length && at(inline[i]) === offset) group.push(inline[i++]);

        const attachDiv = document.createElement('div');
        attachDiv.className = 'message-attachments inline';
        renderMessageAttachments(group, attachDiv);
        messageDiv.appendChild(attachDiv);
    }

    // Always append the tail segment, even when empty: it is the element a live
    // stream keeps writing into after the last tool card.
    return addSegment(text.slice(cursor));
}

export async function appendMessage(role, content, save = true, explicitIndex = null, attachments = null, model = null) {
    // F-03: only touch the DOM when this conversation's thread is the view on
    // screen. Without this, a reply arriving after the user navigated away is
    // appended into whatever list is showing — the defect the harness reports as
    // "1 chat message(s) rendered into the workspaces list". State and
    // persistence below are unconditional; only rendering is gated.
    const visible = threadIsVisible();

    const welcome = visible && elements.messagesContainer.querySelector('.welcome-message');
    if (welcome) {
        welcome.remove();
    }

    // Which model generated this assistant message (WR-14): stored messages
    // pass theirs in; a fresh reply uses the model recorded at request time.
    const messageModel = role === 'assistant'
        ? (model || (save ? state.lastRequestModel : null))
        : null;

    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}`;

    // Add speaker label
    const labelDiv = document.createElement('div');
    labelDiv.className = 'message-label';
    if (role === 'user') {
        labelDiv.textContent = 'You';
    } else if (role === 'assistant') {
        const persona = getActivePersona();
        labelDiv.textContent = persona ? persona.name : CONFIG.defaults.assistantName;
        if (messageModel) {
            const tag = document.createElement('span');
            tag.className = 'message-model-tag';
            tag.textContent = modelTagLabel(messageModel);
            tag.title = messageModel; // full model id on hover
            labelDiv.appendChild(tag);
        }
    }
    messageDiv.appendChild(labelDiv);

    // For assistant messages, strip expression tags before display
    const displayContent = role === 'assistant' ? stripExpressionTag(content) : content;
    renderMessageBody(messageDiv, displayContent, attachments);

    // Add message action buttons (not on error messages)
    if (role === 'user' || role === 'assistant') {
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'message-actions';
        const rerunTitle = role === 'user' ? 'Resend' : 'Regenerate';
        actionsDiv.innerHTML = messageActionsHTML(rerunTitle);
        messageDiv.appendChild(actionsDiv);
    }

    if (visible) elements.messagesContainer.appendChild(messageDiv);

    if (save) {
        // Auto-create conversation if none exists. createConversation is now
        // async (server-generated id), so this whole branch awaits — callers
        // must therefore await appendMessage.
        if (!state.activeConversationId) {
            const title = role === 'user'
                ? generateConversationTitle(displayContent)
                : 'New Chat';
            try {
                await createConversation(title);
            } catch (err) {
                console.error('Auto-create conversation failed:', err);
                return; // can't persist a message without a conversation
            }
        }

        const activeConvo = getActiveConversation();
        if (activeConvo) {
            const msg = {
                role,
                content: displayContent,
                attachments: attachments || [],
                ...(messageModel ? { model: messageModel } : {}),
            };
            activeConvo.messages.push(msg);
            messageDiv.dataset.msgIndex = activeConvo.messages.length - 1;

            // Update title from first user message if still default.
            if (activeConvo.messages.length === 1 && role === 'user' && activeConvo.title === 'New Chat') {
                activeConvo.title = generateConversationTitle(displayContent);
                // Title changed; flush metadata to server.
                saveConversations();
            }
            activeConvo.updatedAt = Date.now();

            // Persist the message and AWAIT the result so msg.id is
            // populated before control returns. Edit/delete handlers depend
            // on msg.id to target the correct server row — a fire-and-forget
            // here let fast follow-up actions (click delete immediately
            // after send) see an undefined id and silently fail to delete
            // server-side, leaving zombie messages on reload.
            try {
                const saved = await persistMessage(activeConvo.id, msg);
                if (saved && saved.id) msg.id = saved.id;
            } catch (err) {
                console.error('Failed to persist message:', err);
            }
        }

        // Update token estimate (rough: 1 token ≈ 4 chars)
        state.estimatedTokens += Math.ceil(content.length / 4);
        updateStatusBar();
    } else {
        // When re-rendering (save=false), use explicit index
        if (explicitIndex !== null) {
            messageDiv.dataset.msgIndex = explicitIndex;
        }
    }

    if (visible) scrollToBottom();
    return messageDiv;
}

export function showTypingIndicator() {
    // F-03: same rule as appendMessage — never write into a thread that is not
    // the view on screen.
    if (!threadIsVisible()) return;
    const indicator = document.createElement('div');
    indicator.className = 'message assistant typing-indicator-container';
    indicator.id = 'typingIndicator';
    indicator.innerHTML = `
        <div class="typing-indicator">
            <span></span>
            <span></span>
            <span></span>
        </div>
    `;
    elements.messagesContainer.appendChild(indicator);
    scrollToBottom();
}

export function hideTypingIndicator() {
    const indicator = document.getElementById('typingIndicator');
    if (indicator) {
        indicator.remove();
    }
}

// Thin wrapper kept for existing call sites; delegates to the P0-17 toast
// system. `type` accepts 'info' | 'success' | 'warning' | 'error'.
export function showNotification(message, type = 'info') {
    showToast(message, { type });
}

/**
 * Delete every message from `fromIndex` onward — both locally and on the
 * server. Server deletes are issued in parallel; individual failures are
 * logged but don't block local truncation, since the user's mental model is
 * "this rerun replaces what came after."
 */
export async function truncateMessagesFrom(convo, fromIndex) {
    const toDelete = convo.messages.slice(fromIndex).filter(m => m.id);
    convo.messages.splice(fromIndex);
    convo.updatedAt = Date.now();
    saveConversations();
    if (toDelete.length > 0) {
        await Promise.all(toDelete.map(m =>
            API.messages.delete(convo.id, m.id).catch(err => {
                console.error(`Failed to delete message ${m.id}:`, err);
            })
        ));
    }
}

// Helper: render attachments in a message
/**
 * Normalize a server tool event (from the tool loop's SSE 'tool-activity'
 * events, or the non-streaming toolEvents array) into a persistable attachment
 * entry, so tool chips + created-file cards survive a reload via the message's
 * existing `attachments` JSON (no schema change — Track A decision).
 * @param {Object} ev - { tool, filename?, ok, + create_file display fields }
 * @returns {Object} attachment entry (type 'created_file' or 'tool_event')
 */
export function toolEventToAttachment(ev) {
    // Where in the reply this tool ran, when the streaming path recorded it.
    // Absent on the non-streaming path (all tools finish before any text
    // exists), which renderMessageBody reads as "render above the text".
    const pos = Number.isInteger(ev.textOffset) ? { textOffset: ev.textOffset } : {};

    // A download url on a successful event IS the "produced a file" signal —
    // read/list tools never carry one, and any future file-producing tool
    // gets a card without touching this list. The tool name is only a label.
    if (ev.ok === true && ev.url) {
        return {
            type: 'created_file',
            tool: ev.tool,
            fileName: ev.filename || 'file',
            url: ev.url,
            mimeType: ev.mimeType || '',
            sizeBytes: ev.sizeBytes || 0,
            overwritten: !!ev.overwritten,
            ...pos,
        };
    }
    return { type: 'tool_event', tool: ev.tool, filename: ev.filename || null, ok: ev.ok !== false, ...pos };
}

/**
 * Append the shared non-image file-card parts (type badge + icon + filename)
 * to `el`. Used by both the uploaded-file attachment card and the model-
 * created-file download card so the structure stays in sync.
 */
export function appendFileCardParts(el, fileName, mimeType) {
    const badge = document.createElement('span');
    badge.className = 'att-badge';
    badge.textContent = getFileTypeLabel(fileName, mimeType);
    el.appendChild(badge);

    const iconDiv = document.createElement('div');
    iconDiv.className = 'att-icon';
    iconDiv.textContent = getFileIcon(mimeType);
    el.appendChild(iconDiv);

    const nameDiv = document.createElement('div');
    nameDiv.className = 'att-name';
    nameDiv.textContent = fileName || 'File';
    nameDiv.title = fileName || 'File';
    el.appendChild(nameDiv);
}

/**
 * Build a card for a model-created file (Track A). The card body is a real
 * <button> that opens the file in the file panel; the corner arrow is the
 * download link. They are DOM siblings (never nested interactives), so
 * keyboard activation and screen readers treat them as two distinct controls.
 */
export function buildCreatedFileCard(att) {
    const el = document.createElement('div');
    el.className = 'message-attachment message-attachment--file tool-file-card';

    const view = document.createElement('button');
    view.type = 'button';
    view.className = 'tool-file-view';
    view.title = `View ${att.fileName || 'file'}`;
    appendFileCardParts(view, att.fileName, att.mimeType);
    view.addEventListener('click', () => FilePanel.open(att));
    el.appendChild(view);

    const dl = document.createElement('a');
    dl.className = 'tool-file-dl';
    dl.href = att.url;
    dl.setAttribute('download', att.fileName || 'file');
    dl.title = `Download ${att.fileName || 'file'}`;
    dl.innerHTML = '&#8681;'; // down arrow
    el.appendChild(dl);

    return el;
}

/** Build a compact chip describing a tool action (read/list, or a failure). */
export function buildToolChip(att) {
    const chip = document.createElement('span');
    chip.className = 'tool-chip' + (att.ok === false ? ' is-error' : '');
    const name = att.filename ? `<code>${escapeHtml(att.filename)}</code>` : '';
    let label;
    if (att.ok === false) {
        label = `${escapeHtml(att.tool || 'tool')} failed${name ? ' — ' + name : ''}`;
    } else if (att.tool === 'read_file') {
        label = `Read ${name || 'a file'}`;
    } else if (att.tool === 'list_files') {
        label = 'Listed files';
    } else if (att.tool === 'create_file') {
        label = `Created ${name || 'a file'}`;
    } else if (att.tool === 'edit_file') {
        label = `Edited ${name || 'a file'}`;
    } else {
        label = escapeHtml(att.tool || 'Tool used');
    }
    chip.innerHTML = `<span class="tool-chip-icon" aria-hidden="true">${att.ok === false ? '⚠' : '✓'}</span> ${label}`;
    return chip;
}

export function renderMessageAttachments(attachments, containerDiv) {
    if (!attachments || attachments.length === 0) return;

    attachments.forEach(att => {
        // Track A tool artifacts: a created-file download card or an action chip.
        if (att.type === 'created_file') {
            containerDiv.appendChild(buildCreatedFileCard(att));
            return;
        }
        if (att.type === 'tool_event') {
            containerDiv.appendChild(buildToolChip(att));
            return;
        }

        const attEl = document.createElement('div');
        attEl.className = 'message-attachment';

        const isImage = (att.type === 'image' || att.type === 'generated') && att.imageStoreKey;

        if (isImage) {
            if (att.type === 'generated') {
                // The "AI Generated" badge is drawn via CSS ::before.
                attEl.classList.add('generated-image');
            } else {
                const badge = document.createElement('span');
                badge.className = 'att-badge';
                badge.textContent = getFileTypeLabel(att.fileName, att.mimeType);
                attEl.appendChild(badge);
            }

            const imgWrapper = document.createElement('div');
            imgWrapper.className = 'attachment-image-wrapper';

            const img = document.createElement('img');
            img.alt = att.fileName || (att.type === 'generated' ? 'Generated image' : 'Attached image');
            img.loading = 'lazy';
            ImageStore.get(att.imageStoreKey).then(url => {
                if (url) img.src = url;
            });
            imgWrapper.appendChild(img);

            if (att.type === 'generated') {
                const downloadBtn = document.createElement('button');
                downloadBtn.className = 'download-btn';
                downloadBtn.innerHTML = '&#8681;'; // Down arrow
                downloadBtn.title = 'Download image';
                downloadBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    downloadGeneratedImage(att);
                });
                imgWrapper.appendChild(downloadBtn);
            }

            attEl.appendChild(imgWrapper);

            // Filename caption for uploaded images (generated ones have no real name).
            if (att.fileName && att.type !== 'generated') {
                const nameDiv = document.createElement('div');
                nameDiv.className = 'att-name';
                nameDiv.textContent = att.fileName;
                nameDiv.title = att.fileName;
                attEl.appendChild(nameDiv);
            }
        } else {
            // Non-image file → compact card (type badge + icon + filename), no preview.
            attEl.classList.add('message-attachment--file');
            appendFileCardParts(attEl, att.fileName, att.mimeType);
        }

        containerDiv.appendChild(attEl);
    });
}

/**
 * Download a generated image from IndexedDB
 * @param {Object} attachment - The attachment metadata
 */
export async function downloadGeneratedImage(attachment) {
    const blob = await ImageStore.getBlob(attachment.imageStoreKey);
    if (!blob) {
        console.error('Image not found for download');
        return;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = attachment.fileName || 'generated-image.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// The router paints a chat view through this; see js/shell.js.
registerShell({ renderChatThread });
