/**
 * The composer's attachments (R-05, moved verbatim from main.js).
 *
 * Pending attachments before a send: their previews, removal, the IndexedDB
 * round trip that makes them survive a reload, the content blocks the request
 * body needs, and promoting a dropped text file into a working file. Plus the
 * textarea auto-resize.
 *
 * F-04 gives this module a second job — making the draft and the pending
 * attachments belong to a conversation instead of to the box — which is why it
 * is a module of its own rather than part of send.js.
 */

import { state } from '../state.js';
import { elements } from '../dom.js';
import { API } from '../api-client.js';
import { ImageStore } from '../util/image-store.js';
import { getFileIcon, getFileTypeLabel } from '../util/format.js';
import { blobToBase64 } from '../util/blob.js';
import { updateSendButtonState } from '../model-layer.js';

/**
 * Per-conversation composer drafts (F-04).
 *
 * The draft and the pending attachments used to live only in the DOM and in
 * `state.pendingAttachments` — that is, they belonged to the input BOX rather
 * than to a conversation. Switching chats carried them along, so a half-typed
 * message could be sent to the wrong chat.
 *
 * Now the box is a view of the active conversation's draft: stash on the way
 * out, restore on the way in. Drafts are session-only and deliberately not
 * persisted; an unsent message is not something to resurrect on another device.
 *
 * Keyed by conversation id. The `null` key holds the draft for a chat that has
 * not been created yet (typing before the first send).
 */
const drafts = new Map();

/** Save the composer's current contents against a conversation id. */
export function stashDraft(conversationId) {
    const text = elements.messageInput ? elements.messageInput.value : '';
    const attachments = state.pendingAttachments || [];
    if (!text && attachments.length === 0) {
        drafts.delete(conversationId ?? null);
        return;
    }
    drafts.set(conversationId ?? null, { text, attachments });
}

/** Put a conversation's draft into the composer, or clear it if there is none. */
export function restoreDraft(conversationId) {
    const draft = drafts.get(conversationId ?? null) || { text: '', attachments: [] };
    if (elements.messageInput) {
        elements.messageInput.value = draft.text;
        autoResizeTextarea(elements.messageInput);
    }
    state.pendingAttachments = draft.attachments;
    renderAttachmentPreviews();
    updateSendButtonState();
}

/**
 * Drop a conversation's draft — called once its contents have been sent, so a
 * sent message never reappears as a draft.
 */
export function clearDraft(conversationId) {
    drafts.delete(conversationId ?? null);
}

/**
 * Whether a pending attachment should become a chat WORKING FILE (CF-02) rather
 * than a static inline attachment. Text/code/markdown qualify; images, audio,
 * and PDFs do not (images are vision content; PDFs need a binary upload path,
 * deferred). Mirrors the server's text allow-list intent — `getFileCategory`
 * buckets PDF as 'document' alongside text, so PDF is excluded explicitly.
 */
export function isTextWorkingFileUpload(att) {
    if (att.mimeType === 'application/pdf') return false;
    if (/\.pdf$/i.test(att.fileName || '')) return false;
    return att.type === 'code' || att.type === 'document';
}

/**
 * Turn text uploads into conversation working files (CF-02). Each is read as
 * text and POSTed to create a conversation file; on success it becomes a
 * 'created_file'-shaped attachment (same card + panel affordance as a
 * model-created file). On failure (Drive unavailable on dev login, transient
 * error) the upload is returned in `failed` so the caller can fall back to the
 * inline path — a file must never silently vanish.
 * @returns {Promise<{ created: Array, failed: Array }>}
 */
export async function createWorkingFilesFromUploads(conversationId, uploads) {
    const created = [];
    const failed = [];
    for (const att of uploads) {
        try {
            const text = await att.file.text();
            const rec = await API.conversations.files.create(conversationId, {
                filename: att.fileName,
                content: text,
                mimeType: att.mimeType || undefined,
            });
            const url = API.conversations.files.contentUrl(conversationId, rec.id);
            created.push({
                type: 'created_file',
                fileName: rec.filename,
                url,
                mimeType: rec.mimeType || att.mimeType || '',
                sizeBytes: rec.sizeBytes || att.fileSize || 0,
            });
        } catch (err) {
            console.error('Failed to create working file from upload:', err);
            failed.push(att);
        }
    }
    return { created, failed };
}

export function renderAttachmentPreviews() {
    const area = elements.attachmentPreviewArea;
    if (!area) return;

    area.innerHTML = '';

    if (state.pendingAttachments.length === 0) {
        area.style.display = 'none';
        return;
    }

    area.style.display = 'flex';

    state.pendingAttachments.forEach(att => {
        const item = document.createElement('div');
        item.className = 'attachment-preview-item';

        const badge = document.createElement('span');
        badge.className = 'att-badge';
        badge.textContent = getFileTypeLabel(att.fileName, att.mimeType);
        item.appendChild(badge);

        if (att.type === 'image' && att.previewUrl) {
            const img = document.createElement('img');
            img.src = att.previewUrl;
            img.alt = att.fileName;
            item.appendChild(img);
        } else {
            const iconDiv = document.createElement('div');
            iconDiv.className = 'att-icon';
            iconDiv.textContent = getFileIcon(att.mimeType);
            item.appendChild(iconDiv);
        }

        const nameDiv = document.createElement('div');
        nameDiv.className = 'att-name';
        nameDiv.textContent = att.fileName;
        nameDiv.title = att.fileName;
        item.appendChild(nameDiv);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-attachment';
        removeBtn.textContent = '\u00D7';
        removeBtn.title = 'Remove';
        removeBtn.addEventListener('click', () => removeAttachment(att.id));
        item.appendChild(removeBtn);

        area.appendChild(item);
    });
}

export function removeAttachment(id) {
    const idx = state.pendingAttachments.findIndex(a => a.id === id);
    if (idx === -1) return;

    const att = state.pendingAttachments[idx];
    if (att.previewUrl) {
        URL.revokeObjectURL(att.previewUrl);
    }

    state.pendingAttachments.splice(idx, 1);
    renderAttachmentPreviews();
    updateSendButtonState();
}

export async function storeAttachmentsToIndexedDB(pendingAttachments) {
    const metadata = [];

    for (const att of pendingAttachments) {
        const storeKey = `attach_${crypto.randomUUID()}`;
        await ImageStore.store(storeKey, att.file);

        // Revoke preview URL
        if (att.previewUrl) {
            URL.revokeObjectURL(att.previewUrl);
        }

        metadata.push({
            id: att.id,
            type: att.type,
            mimeType: att.mimeType,
            fileName: att.fileName,
            fileSize: att.fileSize,
            imageStoreKey: storeKey
        });
    }

    return metadata;
}

/**
 * Build a content-block array (Anthropic-flavored) for a chat message that
 * includes attachments. The backend's Anthropic provider passes this through
 * verbatim; the Gemini provider translates it to Gemini's `parts` shape, so
 * a single client-side build path covers both providers.
 *
 * Note: base64 inflates payload size by ~33%. Express body limit is 10MB
 * server-side — large image batches may hit it. Multipart-upload support is
 * a future task.
 */
/**
 * Build content blocks for the user's message.
 *
 * @param {string} textContent
 * @param {Array} attachments
 * @param {string} [provider] - 'anthropic' | 'google' | 'openai'. Used only
 *   for audio gating today: Anthropic's API rejects audio content blocks,
 *   so we skip them for that provider. The block shape itself is
 *   Anthropic-flavored; the server-side Gemini provider translates it.
 */
export async function buildAttachmentContentBlocks(textContent, attachments, provider) {
    const contentParts = [];

    for (const att of attachments) {
        const blob = await ImageStore.getBlob(att.imageStoreKey);
        if (!blob) continue;

        if (att.type === 'image') {
            const base64 = await blobToBase64(blob);
            contentParts.push({
                type: 'image',
                source: { type: 'base64', media_type: att.mimeType, data: base64 }
            });
        } else if (att.mimeType === 'application/pdf') {
            const base64 = await blobToBase64(blob);
            contentParts.push({
                type: 'document',
                source: { type: 'base64', media_type: att.mimeType, data: base64 }
            });
        } else if (att.type === 'audio') {
            // Anthropic doesn't accept audio content blocks at all — skip.
            // Gemini does, via inline_data; the server-side Gemini provider
            // translates this block.
            if (provider === 'google') {
                const base64 = await blobToBase64(blob);
                contentParts.push({
                    type: 'audio',
                    source: { type: 'base64', media_type: att.mimeType, data: base64 }
                });
            }
        } else if (att.type === 'code' || att.type === 'document') {
            // Read text files as text and include inline
            const text = await blob.text();
            contentParts.push({
                type: 'text',
                text: `[File: ${att.fileName}]\n${text}`
            });
        }
    }

    // Add the user's text message
    if (textContent) {
        contentParts.push({ type: 'text', text: textContent });
    }

    return contentParts;
}

// ===== Utility Functions =====
export function autoResizeTextarea(textarea) {
    // Grow to fit content; CSS max-height caps it (then the textarea scrolls).
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
}
