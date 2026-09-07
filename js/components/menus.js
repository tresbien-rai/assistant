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
    // Placed below for measurement; the vertical block at the foot decides
    // where it actually lands once its height is known.
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
    // Vertical placement. Below the anchor by default; flipped above when that
    // would overflow the bottom.
    //
    // The flip alone is not enough, and this is the case that was clipping
    // menus in practice: when the menu is taller than the space on EITHER side
    // of the anchor — a short viewport, or an anchor near the middle of a tall
    // menu — flipping just moves the overflow from the bottom edge to the top,
    // and clamping to `8` then pushes the far end off-screen. The last item was
    // simply unreachable, with `.context-menu`'s `overflow: hidden` making it
    // invisible rather than merely out of view.
    //
    // So: pick the roomier side, and if the menu still does not fit there, cap
    // its height and let it scroll. A scrolling menu is not ideal; an
    // unreachable Delete is a bug.
    const spaceBelow = window.innerHeight - rect.bottom - 6 - MARGIN;
    const spaceAbove = rect.top - 6 - MARGIN;
    const height = menu.offsetHeight;

    if (height <= spaceBelow) {
        menu.style.top = `${rect.bottom + 6}px`;
    } else if (height <= spaceAbove) {
        menu.style.top = `${rect.top - 6 - height}px`;
    } else {
        // Fits nowhere: use the roomier side, cap the height, and scroll inside
        // the menu.
        //
        // The 96px floor keeps a squeezed menu usable rather than a 12px slit —
        // but it is bounded by the viewport first, and the final top is clamped
        // to both edges. Without that, the floor itself pushed the menu back
        // off-screen on a very short viewport: the exact failure this branch
        // exists to prevent, reintroduced by its own minimum.
        const below = spaceBelow >= spaceAbove;
        const room = Math.min(window.innerHeight - MARGIN * 2,
            Math.max(below ? spaceBelow : spaceAbove, 96));
        menu.style.maxHeight = `${room}px`;
        menu.style.overflowY = 'auto';
        const wanted = below ? rect.bottom + 6 : rect.top - 6 - room;
        menu.style.top = `${Math.min(Math.max(MARGIN, wanted), window.innerHeight - MARGIN - room)}px`;
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
