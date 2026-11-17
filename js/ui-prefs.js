/**
 * Device-local preferences and appearance (R-02, moved verbatim from main.js).
 *
 * `UiPrefs` is the localStorage-backed store for settings that are per-device
 * rather than per-account (theme, sidebar/chat width, dev mode) — a phone and a
 * desktop genuinely want different answers. The theme helpers travel with it
 * because they are the machinery it drives.
 */

import { elements } from './dom.js';

// ===== UI Preferences (device-local layout settings) =====
// Layout prefs (sidebar width, and later chat width / theme / avatar placement)
// are intentionally per-device, so they live in localStorage rather than the
// synced server settings — a phone and a desktop want different layouts.
// All access is guarded: if localStorage is blocked (privacy mode/extensions)
// we fall back to defaults and simply don't persist.
export const UiPrefs = {
    KEY: 'ai_assistant_ui_prefs',
    defaults: {
        sidebarWidth: 220,        // px; desktop sidebar column width (200-360px)
        theme: 'parchment',       // any key of THEME_ACCENTS (UIP-07)
        chatWidth: 'comfortable', // narrow | comfortable | wide
        recentStyle: 'grouped',   // grouped | flat (UIP-03 rail Recent layout)
        activeProject: null,      // id of the entered workspace, or null (home)
        devMode: false,           // show developer tools (e.g. request inspector)
        textareaHeights: {},      // dragged heights by textarea id, px
        filePanelMode: 'auto',    // auto (open on file creation) | click (edge-tab alert only)
        // px; desktop file-panel width, or null for the responsive CSS default
        // (the panel is only pinned to a number once the user has dragged it).
        filePanelWidth: null,
        // F-05. false = Shift+Enter sends, plain Enter inserts a newline (the
        // long-standing default, deliberately kept). true = Enter sends.
        // Device-local on purpose: a phone keyboard and a desktop keyboard want
        // different answers, so syncing this to the account would fight the user.
        enterToSend: false,
        // UIP-01: device-local base font and scope ('all' | 'chat').
        fontFamily: 'inter',
        fontScope: 'all',
    },
    _data: null,
    load() {
        if (this._data) return this._data;
        let saved = {};
        try {
            const raw = localStorage.getItem(this.KEY);
            if (raw) saved = JSON.parse(raw) || {};
        } catch { /* storage blocked */ }
        this._data = { ...this.defaults, ...saved };
        // Clamp persisted sidebarWidth into the UIP-03 200-360px range.
        const sw = Number(this._data.sidebarWidth);
        this._data.sidebarWidth = Number.isFinite(sw) ? Math.max(200, Math.min(360, Math.round(sw))) : this.defaults.sidebarWidth;
        // Migrate retired pre-UIP-07 theme ids and shelved 'custom' theme cleanly.
        const rawTheme = saved.theme;
        if (rawTheme === 'custom' || saved.accent || saved.customPalette || LEGACY_THEME_MAP[rawTheme]) {
            if (rawTheme && rawTheme !== 'custom' && LEGACY_THEME_MAP[rawTheme]) {
                this._data.theme = LEGACY_THEME_MAP[rawTheme];
            } else if ((rawTheme === 'custom' || saved.accent) && !THEMES.includes(rawTheme)) {
                const wasLight = saved.customPalette?.mode === 'light' || rawTheme === 'light' || rawTheme === 'parchment' || rawTheme === 'rose';
                this._data.theme = wasLight ? 'parchment' : 'espresso';
            }
            delete this._data.accent;
            delete this._data.customPalette;
            try { localStorage.setItem(this.KEY, JSON.stringify(this._data)); } catch { /* storage blocked */ }
        }
        return this._data;
    },
    get(key) { return this.load()[key]; },
    set(key, value) {
        this.load()[key] = value;
        try { localStorage.setItem(this.KEY, JSON.stringify(this._data)); } catch { /* storage blocked */ }
    },
    // Push current prefs into CSS custom properties / theme attribute on :root.
    apply() {
        const d = this.load();
        document.documentElement.style.setProperty('--sidebar-width', `${d.sidebarWidth}px`);
        // Only set once dragged — unset leaves the file panel on its responsive
        // clamp() default rather than freezing it at a number we invented.
        if (d.filePanelWidth) {
            document.documentElement.style.setProperty('--file-panel-width', `${d.filePanelWidth}px`);
        }
        applyTheme(d.theme);
        applyChatWidth(d.chatWidth);
        applyRecentStyle(d.recentStyle);
        applyFont(d.fontFamily, d.fontScope);
    },
};

// ===== Appearance: themes, font, chat width (device-local) =====
// 4 Light + 4 Dark curated themes (UIP-07). Palette values live in styles/tokens.css;
// Parchment is the :root default.
const THEME_ACCENTS = {
    parchment: '#9c4a2f',
    alabaster: '#3b5bdb',
    camellia: '#a83258',
    celadon: '#2d6a4f',
    espresso: '#d98a4b',
    nocturne: '#7b84f7',
    verdant: '#57b889',
    abyssal: '#3bbbc9',
};
const LEGACY_THEME_MAP = {
    midnight: 'nocturne',
    slate: 'nocturne',
    forest: 'verdant',
    ocean: 'abyssal',
    light: 'alabaster',
    rose: 'camellia',
};
const THEMES = Object.keys(THEME_ACCENTS);
const LIGHT_THEMES = new Set(['parchment', 'alabaster', 'camellia', 'celadon']);
const CHAT_WIDTHS = { narrow: 620, comfortable: 780, wide: 1040 };
const FONTS = {
    inter: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif",
    jakarta: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    newsreader: "'Newsreader', Georgia, 'Times New Roman', serif",
    'source-serif': "'Source Serif 4', Georgia, 'Times New Roman', serif",
    atkinson: "'Atkinson Hyperlegible', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    'jetbrains-mono': "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
    system: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif",
};
const FONT_SCOPES = new Set(['all', 'chat']);

export function applyTheme(name) {
    const mapped = LEGACY_THEME_MAP[name] || name;
    const theme = THEMES.includes(mapped) ? mapped : 'parchment';
    const root = document.documentElement;
    if (theme === 'parchment') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    applyCodeTheme(theme);
}

// Swap the highlight.js syntax theme: light tokens for light themes, dark
// tokens otherwise. Both stylesheets are preloaded; we just toggle `disabled`.
function applyCodeTheme(theme) {
    const dark = document.getElementById('hljsDark');
    const light = document.getElementById('hljsLight');
    if (!dark || !light) return;
    const useLight = LIGHT_THEMES.has(theme);
    dark.disabled = useLight;
    light.disabled = !useLight;
}

// Run a theme change wrapped in a short transition window so the palette
// cross-fades instead of snapping. Transitions are enabled only while the
// `theme-transition` class is present (see CSS), so normal interactions aren't
// affected, and we never add it on load (no flash).
export function withThemeTransition(fn) {
    const root = document.documentElement;
    root.classList.add('theme-transition');
    fn();
    clearTimeout(withThemeTransition._t);
    withThemeTransition._t = setTimeout(() => root.classList.remove('theme-transition'), 480);
}

export function applyChatWidth(name) {
    const px = CHAT_WIDTHS[name] || CHAT_WIDTHS.comfortable;
    document.documentElement.style.setProperty('--chat-max-width', `${px}px`);
}

export function applyRecentStyle(style) {
    document.documentElement.dataset.recentStyle = style === 'flat' ? 'flat' : 'grouped';
}

export function applyFont(name = UiPrefs.get('fontFamily'), scope = UiPrefs.get('fontScope')) {
    const stack = FONTS[name] || FONTS.inter;
    const resolvedScope = FONT_SCOPES.has(scope) ? scope : 'all';
    const root = document.documentElement;
    if (resolvedScope === 'chat') {
        root.style.removeProperty('--font-main');
        root.style.setProperty('--font-chat', stack);
    } else {
        root.style.setProperty('--font-main', stack);
        root.style.removeProperty('--font-chat');
    }
}

// Reflect current appearance prefs into the settings-modal controls.
export function syncAppearanceControls() {
    const d = UiPrefs.load();
    const theme = THEMES.includes(d.theme) ? d.theme : 'parchment';
    const width = CHAT_WIDTHS[d.chatWidth] ? d.chatWidth : 'comfortable';
    const fontFamily = FONTS[d.fontFamily] ? d.fontFamily : 'inter';
    const fontScope = FONT_SCOPES.has(d.fontScope) ? d.fontScope : 'all';
    const recentStyle = d.recentStyle === 'flat' ? 'flat' : 'grouped';
    document.querySelectorAll('#themeOptions button').forEach(b => {
        b.classList.toggle('active', b.dataset.themeName === theme);
    });
    document.querySelectorAll('#fontFamilyOptions button').forEach(b => {
        b.classList.toggle('active', b.dataset.fontFamily === fontFamily);
    });
    document.querySelectorAll('#fontScopeOptions button').forEach(b => {
        b.classList.toggle('active', b.dataset.fontScope === fontScope);
    });
    document.querySelectorAll('#chatWidthOptions button').forEach(b => {
        b.classList.toggle('active', b.dataset.chatWidth === width);
    });
    document.querySelectorAll('#recentStyleOptions button').forEach(b => {
        b.classList.toggle('active', b.dataset.recentStyle === recentStyle);
    });
    const panelMode = d.filePanelMode === 'click' ? 'click' : 'auto';
    document.querySelectorAll('#filePanelModeOptions button').forEach(b => {
        b.classList.toggle('active', b.dataset.filePanelMode === panelMode);
    });
    const enterBehaviour = d.enterToSend === true ? 'enter' : 'shift';
    document.querySelectorAll('#enterBehaviourOptions button').forEach(b => {
        b.classList.toggle('active', b.dataset.enterBehaviour === enterBehaviour);
    });
    // The composer placeholder names the shortcut, so it has to follow the
    // setting — otherwise the app tells the user the wrong key.
    if (elements.messageInput) {
        elements.messageInput.placeholder = enterBehaviour === 'enter'
            ? 'Type your message... (Enter to send)'
            : 'Type your message... (Shift+Enter to send)';
    }
    if (elements.composerKeyHint) {
        elements.composerKeyHint.textContent = enterBehaviour === 'enter'
            ? 'Enter to send · Shift+Enter for new line'
            : 'Shift+Enter to send · Enter for new line';
    }
}

