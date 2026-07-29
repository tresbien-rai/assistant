/**
 * The floating avatar (R-05, moved verbatim from main.js).
 *
 * Size and corner presets, free-drag positioning, the persona image or emoji it
 * shows, and the settings controls that drive it. Sizes are stored either as a
 * named preset or as free pixel/percentage values, which is why the parsing and
 * clamping helpers travel with it.
 *
 * It renders the current expression, so js/chat/expressions.js calls in here —
 * one way, expressions → avatar, never the reverse.
 */

import { state } from './state.js';
import { elements } from './dom.js';
import { CONFIG } from './config.js';
import { API } from './api-client.js';
import { getActivePersona } from './state.js';
import { autoSaveSettings } from './settings-store.js';

// ===== Floating avatar size/position (named presets OR free values) =====
// avatarSize: a preset name OR a numeric px string. avatarPosition: a corner
// preset OR "x,y" where x,y are 0..100 fractions of the AVAILABLE travel
// (chat area minus the avatar), so a synced free position stays in-bounds
// across different screen sizes.
export const AVATAR_PRESET_PX = { small: 80, medium: 120, large: 180, xlarge: 240 };

export const AVATAR_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

export const AVATAR_SIZE_MIN = 32;

export const AVATAR_SIZE_MAX = 480;

export const AVATAR_FONT_RATIO = 0.025; // px → rem for the emoji (120px → 3rem, matches presets)


export function isAvatarPreset(size) {
    return Object.prototype.hasOwnProperty.call(AVATAR_PRESET_PX, size);
}

export function isAvatarCorner(pos) {
    return AVATAR_CORNERS.includes(pos);
}

export function avatarSizeToPx(size) {
    if (isAvatarPreset(size)) return AVATAR_PRESET_PX[size];
    const n = parseInt(size, 10);
    if (!Number.isFinite(n)) return AVATAR_PRESET_PX.medium;
    return Math.max(AVATAR_SIZE_MIN, Math.min(AVATAR_SIZE_MAX, n));
}

export function parseAvatarFreePos(pos) {
    if (typeof pos !== 'string') return null;
    const parts = pos.split(',');
    if (parts.length !== 2) return null;
    const x = parseFloat(parts[0]);
    const y = parseFloat(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) };
}

export function applyAvatarSize(image, size) {
    if (isAvatarPreset(size)) {
        image.className = `avatar-image size-${size}`;
        image.style.width = '';
        image.style.height = '';
        image.style.fontSize = '';
    } else {
        const px = avatarSizeToPx(size);
        image.className = 'avatar-image';
        image.style.width = `${px}px`;
        image.style.height = `${px}px`;
        image.style.fontSize = `${px * AVATAR_FONT_RATIO}rem`;
    }
}

export function applyAvatarPosition(avatar, pos) {
    const free = isAvatarCorner(pos) ? null : parseAvatarFreePos(pos);
    if (!free) {
        const corner = isAvatarCorner(pos) ? pos : CONFIG.defaults.avatarPosition;
        avatar.className = `floating-avatar ${corner}`;
        avatar.style.left = '';
        avatar.style.top = '';
        avatar.style.right = '';
        avatar.style.bottom = '';
        return;
    }
    avatar.className = 'floating-avatar';
    const chatArea = document.getElementById('chatArea');
    // Layout sizes (offset/client), NOT getBoundingClientRect(): the rect is
    // shrunk by the hidden state's scale(0.8) while the avatar is hidden or
    // still fading in, which overstates the available travel and pushes a
    // right/bottom-side avatar past the edge on show.
    const maxLeft = Math.max(0, chatArea.clientWidth - avatar.offsetWidth);
    const maxTop = Math.max(0, chatArea.clientHeight - avatar.offsetHeight);
    avatar.style.left = `${(free.x / 100) * maxLeft}px`;
    avatar.style.top = `${(free.y / 100) * maxTop}px`;
    avatar.style.right = 'auto';
    avatar.style.bottom = 'auto';
}

// Reflect the current avatar size into the preset buttons + the slider/value.
export function syncAvatarSizeControls() {
    const size = state.settings.avatarSize;
    document.querySelectorAll('.size-preset-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.size === size);
    });
    const px = avatarSizeToPx(size);
    if (elements.avatarSizeSlider) elements.avatarSizeSlider.value = String(px);
    if (elements.avatarSizeValue) elements.avatarSizeValue.textContent = `${px}px`;
}

// Reflect the current avatar position into the corner preset buttons (none
// active when the avatar is freely placed).
export function syncAvatarPositionControls() {
    const pos = state.settings.avatarPosition;
    document.querySelectorAll('.position-preset-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.position === pos);
    });
}

export async function setAvatarSize(size) {
    state.settings.avatarSize = size;
    syncAvatarSizeControls();
    await updateFloatingAvatar();
    autoSaveSettings();
}

export async function setAvatarPosition(pos) {
    state.settings.avatarPosition = pos;
    syncAvatarPositionControls();
    await updateFloatingAvatar();
    autoSaveSettings();
}

export async function setShowAvatar(show) {
    state.settings.showAvatar = show;
    elements.showAvatar.checked = show;
    await updateFloatingAvatar();
    elements.avatarToggleBtn.classList.toggle('active', show);
    autoSaveSettings();
}

// Drag the floating avatar (by its frame) to position it freely within the
// chat area. The result is stored as "x,y" % of available travel and saved.
export function setupAvatarDrag() {
    const avatar = elements.floatingAvatar;
    if (!avatar) return;
    const frame = avatar.querySelector('.avatar-frame');
    const chatArea = document.getElementById('chatArea');
    if (!frame || !chatArea) return;

    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    frame.addEventListener('pointerdown', (e) => {
        if (!state.settings.showAvatar) return;
        dragging = true;
        moved = false;
        const aRect = avatar.getBoundingClientRect();
        const cRect = chatArea.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startLeft = aRect.left - cRect.left;
        startTop = aRect.top - cRect.top;
        avatar.classList.add('dragging');
        try { frame.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        e.preventDefault();
    });

    frame.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        moved = true;
        // Layout sizes for the travel bounds (transform-immune — see applyAvatarPosition).
        const maxLeft = Math.max(0, chatArea.clientWidth - avatar.offsetWidth);
        const maxTop = Math.max(0, chatArea.clientHeight - avatar.offsetHeight);
        const left = Math.max(0, Math.min(maxLeft, startLeft + (e.clientX - startX)));
        const top = Math.max(0, Math.min(maxTop, startTop + (e.clientY - startY)));
        // Drop any corner preset but keep the base + dragging classes.
        avatar.classList.remove('top-left', 'top-right', 'bottom-left', 'bottom-right');
        avatar.style.left = `${left}px`;
        avatar.style.top = `${top}px`;
        avatar.style.right = 'auto';
        avatar.style.bottom = 'auto';
    });

    const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        avatar.classList.remove('dragging');
        try { frame.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        if (!moved) return;
        const cRect = chatArea.getBoundingClientRect();
        const aRect = avatar.getBoundingClientRect();
        const maxLeft = Math.max(1, chatArea.clientWidth - avatar.offsetWidth);
        const maxTop = Math.max(1, chatArea.clientHeight - avatar.offsetHeight);
        const xPct = Math.max(0, Math.min(100, ((aRect.left - cRect.left) / maxLeft) * 100));
        const yPct = Math.max(0, Math.min(100, ((aRect.top - cRect.top) / maxTop) * 100));
        state.settings.avatarPosition = `${xPct.toFixed(2)},${yPct.toFixed(2)}`;
        syncAvatarPositionControls();
        autoSaveSettings();
    };
    frame.addEventListener('pointerup', endDrag);
    frame.addEventListener('pointercancel', endDrag);

    // Re-clamp a freely-placed avatar when the viewport size changes.
    window.addEventListener('resize', () => {
        if (!isAvatarCorner(state.settings.avatarPosition)) {
            applyAvatarPosition(avatar, state.settings.avatarPosition);
        }
    });
}

export async function updateFloatingAvatar() {
    const avatar = elements.floatingAvatar;
    const image = elements.avatarImage;
    const persona = getActivePersona();
    const expressions = persona ? persona.expressions : CONFIG.defaultExpressions;

    // Size first, so the avatar has correct dimensions before we position it.
    applyAvatarSize(image, state.settings.avatarSize);

    // Position (preset corner OR free "x,y"). This resets the wrapper's
    // className, so apply the hidden state afterwards.
    applyAvatarPosition(avatar, state.settings.avatarPosition);
    // Floating avatar only appears in a chat view (WR-07b), and only if enabled.
    const inChat = (state.ui.mainView || {}).type === 'chat';
    avatar.classList.toggle('hidden', !state.settings.showAvatar || !inChat);

    // Built-in pulse while the model generates (P2-U2). Plays over a custom
    // generating image/gif too, and clears automatically when the expression
    // changes, since this runs on every setExpression().
    avatar.classList.toggle('generating', state.currentExpression === CONFIG.generatingExpression);

    // Update image or emoji.
    // Priority: expression image > default avatar > emoji.
    const currentExpr = expressions[state.currentExpression] || expressions.neutral;
    const cacheBust = persona && persona.updatedAt ? `?v=${persona.updatedAt}` : '';

    // Expression image URL — derive from persona id + expression name.
    let expressionImageUrl = null;
    if (persona && currentExpr && currentExpr.imageKey) {
        expressionImageUrl = `${API.avatars.getExpressionUrl(persona.id, state.currentExpression)}${cacheBust}`;
    }

    // Default avatar URL.
    let avatarImageUrl = null;
    if (persona && persona.avatarFilename) {
        avatarImageUrl = `${API.avatars.getUrl(persona.id)}${cacheBust}`;
    }

    const moodEmoji = (currentExpr && currentExpr.emoji) || '🤖';
    if (expressionImageUrl) {
        // The expression has art of its own — it already conveys the mood, so
        // no badge.
        elements.avatarEmoji.style.display = 'none';
        elements.avatarImg.style.display = 'block';
        elements.avatarImg.src = expressionImageUrl;
        elements.avatarMoodBadge.hidden = true;
    } else if (avatarImageUrl) {
        // Default avatar carries identity; the badge carries mood. Without it,
        // a persona with an avatar but no per-expression art would never
        // visibly change expression at all.
        elements.avatarEmoji.style.display = 'none';
        elements.avatarImg.style.display = 'block';
        elements.avatarImg.src = avatarImageUrl;
        elements.avatarMoodBadge.textContent = moodEmoji;
        elements.avatarMoodBadge.hidden = false;
    } else {
        // Nothing uploaded at all — the emoji IS the avatar, so no badge.
        elements.avatarEmoji.style.display = 'block';
        elements.avatarImg.style.display = 'none';
        elements.avatarEmoji.textContent = moodEmoji;
        elements.avatarMoodBadge.hidden = true;
    }

    // Update name and expression label
    elements.floatingAvatarName.textContent = persona ? persona.name : CONFIG.defaults.assistantName;
    elements.floatingAvatarExpression.textContent = state.currentExpression;
}
