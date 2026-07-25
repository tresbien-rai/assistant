/**
 * Popover/context-menu primitives (R-01, moved verbatim from app.js).
 *
 * Positioning and outside-click closing only. The menus themselves — avatar,
 * model, conversation, workspace, persona-card — build their own content and
 * stay with their views; they call in here to place and dismiss it.
 */

/**
 * Attach a context-menu/popover to the body and position it relative to its
 * anchor button. `align` controls which edge lines up: 'left' pins the menu's
 * left edge to the anchor's left, 'right' pins its right edge to the anchor's
 * right (so menus opened from the right side of the bar don't overflow
 * off-screen). Appending happens here (not at the call sites) so the menu can
 * be measured and flipped above the anchor when it would overflow the viewport
 * bottom — e.g. anchored to the composer's model chip.
 * @param {HTMLElement} menu
 * @param {HTMLElement} anchorEl
 * @param {'left'|'right'} align
 */
export function positionPopover(menu, anchorEl, align) {
    document.body.appendChild(menu);
    const rect = anchorEl.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${rect.bottom + 6}px`;
    if (align === 'right') {
        menu.style.right = `${window.innerWidth - rect.right}px`;
    } else {
        menu.style.left = `${rect.left}px`;
    }
    // Horizontal clamp. Either alignment can run off-screen when the anchor
    // isn't near the edge it aligns to and the menu is wide relative to the
    // viewport — a phone-width hazard (the composer's Files button sits
    // mid-row, so at 375px it overflows left when right-aligned and right when
    // left-aligned). Re-anchors to `left` only when the menu doesn't already
    // fit, so a menu that fits never moves.
    const MARGIN = 8;
    const box = menu.getBoundingClientRect();
    if (box.left < MARGIN || box.right > window.innerWidth - MARGIN) {
        const maxLeft = window.innerWidth - MARGIN - box.width;
        menu.style.right = 'auto';
        menu.style.left = `${Math.max(MARGIN, Math.min(box.left, maxLeft))}px`;
    }
    if (rect.bottom + 6 + menu.offsetHeight > window.innerHeight) {
        menu.style.top = `${Math.max(8, rect.top - 6 - menu.offsetHeight)}px`;
    }
}

/**
 * Close `menu` on the next outside click. The anchor is excluded so clicking
 * the trigger button again doesn't immediately re-close the freshly opened menu.
 * @param {HTMLElement} menu
 * @param {HTMLElement} anchorEl
 */
export function attachPopoverOutsideClose(menu, anchorEl) {
    setTimeout(() => {
        document.addEventListener('click', function closeMenu(e) {
            if (!menu.contains(e.target) && !anchorEl.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        });
    }, 0);
}
