/**
 * The shell seam (R-04a).
 *
 * WHY THIS EXISTS. Before this file, `js/main.js` held one mutually recursive
 * cluster of **60 top-level functions** — the whole view layer, the router and
 * the settings-persistence code, all calling each other. A cluster like that
 * cannot be split by moving code: whichever boundary you draw through it, the
 * two halves import each other, which is the dependency cycle rule 3 of
 * docs/REFACTOR_PLAN.md forbids.
 *
 * Measuring the graph showed the knot is held together by just three
 * "repaint everything" calls. Cutting them shrinks the largest cluster from
 * 60 → 44 → 21 → 13:
 *
 *     navigate()        every view moves the user somewhere
 *     updateUI()        every mutation asks for a global repaint
 *     renderMainView()  the router paints whatever view is current
 *
 * So they are routed through here instead of being called directly. A view
 * imports `navigate` from this module and stays ignorant of the router; the
 * router registers the implementations once at boot. Dependencies point one
 * way again, and the view layer becomes extractable in R-04b.
 *
 * This is rule 2 — "one owner per DOM region; the router decides which view
 * owns the main area" — made enforceable rather than merely stated. It is also
 * the seam F-03 needs: to stop a streaming reply being written into a detached
 * node, the send path has to be able to ask *which view is showing* without
 * reaching into the router.
 *
 * The implementations still live in `main.js` today and register themselves at
 * import time; R-04b moves them into `js/router.js`, which will register them
 * instead. Nothing else about them changes.
 */

import { state } from './state.js';
import { closeSidebar } from './sidebar.js';

/**
 * Filled by registerShell() at boot.
 *
 * The last two are region repaints rather than whole-shell ones, and they are
 * here for the same reason as the first three. Saving a setting repaints the
 * settings surface; saving or clearing an API key repaints the models catalog.
 * Those calls run inside the persistence code, so without a seam the settings
 * store and the models view import each other:
 *
 *     persistSettings → updateSettingsUI → renderModelsCatalog
 *                     → saveCatalogProviders → autoSaveSettings → persistSettings
 *
 * Routed through here, the store depends on the seam and the view registers
 * with it. Same shape as the navigation hubs, same reason. Expect this list to
 * grow by one or two as the remaining view clusters come out — the recurring
 * pattern is "mutate state, then repaint the region that shows it".
 */
const impl = {
    renderShell: null,
    renderMainView: null,
    updateUI: null,
    updateSettingsUI: null,
    renderModelsCatalog: null,
    refreshAddModelModal: null,
};

/**
 * Register the shell implementations. Called once, at module-evaluation time,
 * by whoever owns the main area (today `main.js`, after R-04b `router.js`).
 * @param {{renderShell: Function, renderMainView: Function, updateUI: Function}} fns
 */
export function registerShell(fns) {
    Object.assign(impl, fns);
}

/** Fail loudly rather than silently no-op if a registration is ever missed. */
function call(name, args) {
    if (typeof impl[name] !== 'function') {
        throw new Error(
            `shell.${name}() called before registerShell() — the module that owns ` +
            `the main area must register its implementations at import time.`
        );
    }
    return impl[name].apply(null, args);
}

/**
 * Navigate the main area to a view and repaint the shell.
 * @param {{type:string, id?:string}} view
 */
export function navigate(view) {
    state.ui.mainView = view || { type: 'chats' };
    renderShell();
    renderMainView();
    closeSidebar();
}

/** Which rail section the current view belongs to (for rail highlighting). */
export function currentSection() {
    const v = state.ui.mainView || {};
    if (v.type === 'settings') return 'settings';
    if (v.type === 'models') return 'models';
    if (v.type === 'personas' || v.type === 'persona-edit') return 'personas';
    if (v.type === 'workspaces' || v.type === 'workspace' || v.type === 'project') return 'workspaces';
    if (v.type === 'chat') {
        const c = state.conversations[v.id];
        return (c && (c.workspaceId || c.projectId)) ? 'workspaces' : 'chats';
    }
    return 'chats'; // 'chats' (and any fallback)
}

/** Repaint the navigation shell: rail highlight + contextual top bar + chrome. */
export function renderShell() {
    return call('renderShell', arguments);
}

/** Render the active main-area view. */
export function renderMainView() {
    return call('renderMainView', arguments);
}

/** Global repaint after a state mutation. Returns the implementation's promise. */
export function updateUI() {
    return call('updateUI', arguments);
}

/** Repaint the settings surface after a settings mutation. */
export function updateSettingsUI() {
    return call('updateSettingsUI', arguments);
}

/** Repaint the models catalog after a catalog or API-key mutation. */
export function renderModelsCatalog() {
    return call('renderModelsCatalog', arguments);
}

/** Repaint the add-model modal's provider list, if that modal is open. */
export function refreshAddModelModal() {
    return call('refreshAddModelModal', arguments);
}
