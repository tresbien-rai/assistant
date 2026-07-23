/**
 * Tessera - Main Application Logic
 * 
 * Features:
 * - Multi-provider API support (Claude, with OpenAI/Gemini coming)
 * - Customizable personas with system prompts
 * - Floating avatar with expression system
 * - Status bar with session info
 * - Settings persistence via the server API (api-client.js → /api/*)
 */

// ===== Configuration =====
// Provider endpoints are gone from the frontend after P0-16 — all chat and
// model-list traffic goes through window.API → /api/chat[/stream] and
// /api/models/:provider, and the backend holds the keys.
const CONFIG = {
    defaults: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        assistantName: 'Assistant',
        // Persona voice only. The expression protocol is NOT stated here — the
        // server's Tessera base layer supplies it, generated from the persona's
        // real expression set, so it can never go stale the way this text did.
        systemPrompt: `You are a helpful, friendly assistant. You provide clear and concise answers while being warm and personable.`,
        avatarSize: 'medium',
        avatarPosition: 'top-right',
        showAvatar: true,
        activeFileTurns: 1
    },
    // `keywords` is gone — expressions are declared by the model, never inferred
    // from the text. `generating` is the one reserved slot: it's the UI's own
    // "working on it" state, held for the whole response, and the model may
    // never declare it. Everything else here is an ordinary expression —
    // including `thinking`, which used to be reserved and is now free to be a
    // real character pose (hand on chin).
    defaultExpressions: {
        neutral: { emoji: '😊', imageKey: '' },
        happy: { emoji: '😄', imageKey: '' },
        sad: { emoji: '😢', imageKey: '' },
        thinking: { emoji: '🤔', imageKey: '' },
        excited: { emoji: '🎉', imageKey: '' },
        confused: { emoji: '😕', imageKey: '' },
        generating: { emoji: '💭', imageKey: '' }
    },
    /** The expression slot driven by the UI, never by the model. */
    generatingExpression: 'generating',
    attachments: {
        maxImageSize: 20 * 1024 * 1024,  // 20MB for images
        maxFileSize: 10 * 1024 * 1024,   // 10MB for other files
        maxAttachments: 10,               // Max files per message
        supportedTypes: [
            'image/png', 'image/jpeg', 'image/gif', 'image/webp',
            'application/pdf', 'text/plain', 'text/csv', 'text/markdown',
            'text/javascript', 'text/html', 'text/css', 'application/json',
            'text/xml', 'application/xml', 'text/yaml',
            'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm'
        ]
    }
};

// ===== Markdown Rendering =====

/**
 * Configure marked.js for Markdown rendering with syntax highlighting
 */
marked.setOptions({
    breaks: true,       // Convert \n to <br> in paragraphs
    gfm: true,          // GitHub Flavored Markdown
    headerIds: false,   // Don't add IDs to headers (cleaner output)
    mangle: false       // Don't escape email addresses
});

/**
 * Custom renderer to add syntax highlighting to code blocks
 */
const markedRenderer = new marked.Renderer();

// Override code block rendering to use highlight.js
markedRenderer.code = function(code, language) {
    // Handle the case where marked passes an object instead of separate params
    if (typeof code === 'object') {
        language = code.lang;
        code = code.text;
    }

    const validLanguage = language && hljs.getLanguage(language);
    const highlighted = validLanguage
        ? hljs.highlight(code, { language }).value
        : hljs.highlightAuto(code).value;

    const langClass = validLanguage ? ` class="language-${language}"` : '';
    // Wrap in a positioned container so a copy button can float in the corner.
    // The button carries no code payload itself — the click handler reads the
    // raw text from the sibling <code> element's textContent (markup stripped).
    return `<div class="code-block"><button class="code-copy-btn" type="button" data-action="copy-code" title="Copy code" aria-label="Copy code">${ICON_SVG.copy}</button><pre><code${langClass}>${highlighted}</code></pre></div>`;
};

// Make links open in new tab
markedRenderer.link = function(href, title, text) {
    // Handle the case where marked passes an object
    if (typeof href === 'object') {
        text = href.text;
        title = href.title;
        href = href.href;
    }

    const titleAttr = title ? ` title="${title}"` : '';
    return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
};

marked.setOptions({ renderer: markedRenderer });

/**
 * Render Markdown content to HTML
 * @param {string} content - Raw markdown text
 * @returns {string} - HTML string
 */
function renderMarkdown(content) {
    if (!content) return '';
    return marked.parse(content);
}

// Feather-style SVG icons for message action buttons — consistent with the
// app's other SVG buttons (send/attach/gear). stroke=currentColor so they
// inherit the theme text color and the hover color.
const ICON_SVG = {
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>',
    rerun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>',
    delete: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>',
};

// Single source of truth for the per-message action buttons (was duplicated in
// the streaming and static render paths). rerunTitle differs by role.
function messageActionsHTML(rerunTitle) {
    return `
        <button class="message-action-btn" data-action="copy" title="Copy" aria-label="Copy">${ICON_SVG.copy}</button>
        <button class="message-action-btn" data-action="edit" title="Edit" aria-label="Edit">${ICON_SVG.edit}</button>
        <button class="message-action-btn" data-action="rerun" title="${rerunTitle}" aria-label="${rerunTitle}">${ICON_SVG.rerun}</button>
        <button class="message-action-btn danger" data-action="delete" title="Delete" aria-label="Delete">${ICON_SVG.delete}</button>
    `;
}

// ===== UI Preferences (device-local layout settings) =====
// Layout prefs (sidebar width, and later chat width / theme / avatar placement)
// are intentionally per-device, so they live in localStorage rather than the
// synced server settings — a phone and a desktop want different layouts.
// All access is guarded: if localStorage is blocked (privacy mode/extensions)
// we fall back to defaults and simply don't persist.
const UiPrefs = {
    KEY: 'ai_assistant_ui_prefs',
    defaults: {
        sidebarWidth: 320,        // px; desktop sidebar column width
        theme: 'midnight',        // any key of THEME_ACCENTS, or 'custom' (palette derived from customPalette)
        customPalette: { base: '#6c63ff', mode: 'dark', tint: 50 }, // the Custom theme: one base color + light/dark + bg tint strength
        chatWidth: 'comfortable', // narrow | comfortable | wide
        activeProject: null,      // id of the entered workspace, or null (home)
        devMode: false,           // show developer tools (e.g. request inspector)
        textareaHeights: {},      // dragged heights by textarea id, px
        filePanelMode: 'auto',    // auto (open on file creation) | click (edge-tab alert only)
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
        // Own copy of the nested palette (never mutate `defaults`); tolerates
        // old/partial saved shapes.
        this._data.customPalette = { ...this.defaults.customPalette, ...(saved.customPalette || {}) };
        // Migration: the retired per-theme 'accent' override becomes the
        // Custom palette's base color (closest match to the old intent).
        if (saved.accent) {
            this._data.customPalette.base = saved.accent;
            this._data.customPalette.mode = LIGHT_THEMES.has(saved.theme) ? 'light' : 'dark';
            this._data.theme = 'custom';
            delete this._data.accent;
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
        applyTheme(d.theme);
        applyChatWidth(d.chatWidth);
    },
};

// ===== Appearance: themes, accent color, chat width (device-local) =====
// Each theme ships its own default accent (shown in the picker when no custom
// accent is set). Palette values live in styles.css; this map only mirrors the
// accents so the UI can display them.
const THEME_ACCENTS = {
    midnight: '#6c63ff',
    slate: '#7aa2f7',
    forest: '#52b788',
    ocean: '#35c0ce',
    light: '#6c63ff',
    parchment: '#9c4a2f',
    rose: '#b02a5b',
};
const THEMES = [...Object.keys(THEME_ACCENTS), 'custom'];
const LIGHT_THEMES = new Set(['light', 'parchment', 'rose']);
const CHAT_WIDTHS = { narrow: 620, comfortable: 780, wide: 1040 };

function hexToRgb(hex) {
    const h = String(hex || '').replace('#', '');
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    const n = parseInt(full, 16);
    if (!Number.isFinite(n) || full.length !== 6) return null;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
}

function applyTheme(name) {
    const theme = THEMES.includes(name) ? name : 'midnight';
    const root = document.documentElement;
    if (theme === 'custom') {
        const cp = UiPrefs.get('customPalette');
        // Structural bits we don't derive (shadows, code backgrounds, syntax
        // tokens) come from the closest stock theme for the palette's mode;
        // everything else is set inline by applyCustomPalette.
        if (cp.mode === 'light') root.setAttribute('data-theme', 'light');
        else root.removeAttribute('data-theme');
        applyCustomPalette(cp);
        applyCodeTheme(cp.mode === 'light' ? 'light' : 'midnight');
        return;
    }
    clearPaletteVars();
    root.setAttribute('data-theme', theme);
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

// Run a theme/accent change wrapped in a short transition window so the palette
// cross-fades instead of snapping. Transitions are enabled only while the
// `theme-transition` class is present (see CSS), so normal interactions aren't
// affected, and we never add it on load (no flash).
function withThemeTransition(fn) {
    const root = document.documentElement;
    root.classList.add('theme-transition');
    fn();
    clearTimeout(withThemeTransition._t);
    withThemeTransition._t = setTimeout(() => root.classList.remove('theme-transition'), 480);
}

// WCAG relative luminance (0 = black, 1 = white); used to keep text readable
// on top of whatever accent color the user picks.
function relativeLuminance({ r, g, b }) {
    const lin = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(hexA, hexB) {
    const la = relativeLuminance(hexToRgb(hexA));
    const lb = relativeLuminance(hexToRgb(hexB));
    const [hi, lo] = la > lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
}

// ===== Custom palette engine (OKLCH) =====
// The Custom theme derives a full palette from one base color. The math runs
// in OKLCH because its lightness is perceptually uniform across hues (HSL's
// is not), so one recipe works whether the base is gold or indigo.
function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
function linearToSrgb(c) { return c <= 0.0031308 ? 12.92 * c : 1.055 * (c ** (1 / 2.4)) - 0.055; }

function rgbToOklch({ r, g, b }) {
    const lr = srgbToLinear(r / 255), lg = srgbToLinear(g / 255), lb = srgbToLinear(b / 255);
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    const bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    return { L, C: Math.hypot(a, bb), H: Math.atan2(bb, a) * 180 / Math.PI };
}

function oklchToRgbLinear(L, C, H) {
    const hr = H * Math.PI / 180;
    const a = C * Math.cos(hr), b = C * Math.sin(hr);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ];
}

// OKLCH -> hex, walking chroma down until the color fits the sRGB gamut
// (very saturated corners would otherwise clip channels and shift hue).
function oklchToHex(L, C, H) {
    let c = C;
    for (let i = 0; i < 12; i++) {
        const rgb = oklchToRgbLinear(L, c, H);
        if (rgb.every(v => v >= -0.001 && v <= 1.001)) {
            return rgbToHex(...rgb.map(v => linearToSrgb(Math.min(1, Math.max(0, v))) * 255));
        }
        c *= 0.8;
    }
    return rgbToHex(...oklchToRgbLinear(L, 0, H).map(v => linearToSrgb(Math.min(1, Math.max(0, v))) * 255));
}

const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

// All CSS variables the Custom theme manages inline on :root.
const PALETTE_VARS = [
    '--accent', '--accent-hover', '--accent-subtle', '--accent-light', '--on-accent',
    '--user-bubble', '--user-bubble-text', '--bg-primary', '--bg-secondary', '--bg-tertiary',
    '--text-primary', '--text-secondary', '--text-muted', '--assistant-bubble',
    '--border-color', '--scrollbar-thumb', '--scrollbar-thumb-hover',
];

// Derive the full Custom-theme palette from one base color.
// `tint` (0-100) controls how much of the base hue bleeds into backgrounds:
// 0 = neutral grays, ~50 = preset-theme level (like Forest/Ocean), 100 = bold.
function derivePalette(base, mode, tint) {
    const rgb = hexToRgb(base) || hexToRgb('#6c63ff');
    const { L, C, H } = rgbToOklch(rgb);
    const t = clampN(tint, 0, 100) / 100;
    const bgC = Math.min(C * 0.5, 0.08) * t;   // background tint chroma
    const txC = Math.min(C * 0.3, 0.04) * t;   // text tint (fainter still)
    const col = (l, c) => oklchToHex(l, c, H);
    let p, bubbleL, bubbleC;
    if (mode === 'light') {
        const accL = clampN(L, 0.42, 0.55), accC = clampN(C, 0.03, 0.21);
        bubbleL = clampN(L, 0.42, 0.52); bubbleC = clampN(C, 0.03, 0.19);
        p = {
            '--accent': col(accL, accC),
            '--accent-hover': col(accL - 0.05, accC),
            '--accent-light': col(clampN(L - 0.05, 0.38, 0.5), clampN(C, 0.03, 0.19)),
            '--bg-primary': col(0.955, bgC * 0.25),
            '--bg-secondary': col(0.985, bgC * 0.12),
            '--bg-tertiary': col(0.92, bgC * 0.3),
            '--text-primary': col(0.28, txC),
            '--text-secondary': col(0.5, txC),
            '--text-muted': col(0.63, txC),
            '--assistant-bubble': col(0.91, bgC * 0.35),
            '--border-color': col(0.87, bgC * 0.3),
            '--scrollbar-thumb': col(0.78, bgC * 0.3),
            '--scrollbar-thumb-hover': col(0.7, bgC * 0.3),
        };
    } else {
        const accL = clampN(L, 0.62, 0.82), accC = clampN(C, 0.03, 0.23);
        bubbleL = 0.45; bubbleC = clampN(C * 0.8, 0.03, 0.13);
        p = {
            '--accent': col(accL, accC),
            '--accent-hover': col(accL - 0.06, accC),
            '--accent-light': col(clampN(L + 0.12, 0.7, 0.87), clampN(C * 0.9, 0.03, 0.18)),
            '--bg-primary': col(0.225, bgC * 0.55),
            '--bg-secondary': col(0.26, bgC * 0.55),
            '--bg-tertiary': col(0.19, bgC * 0.55),
            '--text-primary': col(0.93, txC * 0.3),
            '--text-secondary': col(0.71, txC * 0.6),
            '--text-muted': col(0.55, txC * 0.6),
            '--assistant-bubble': col(0.29, bgC * 0.6),
            '--border-color': col(0.33, bgC * 0.6),
            '--scrollbar-thumb': col(0.37, bgC * 0.5),
            '--scrollbar-thumb-hover': col(0.44, bgC * 0.5),
        };
    }
    p['--user-bubble'] = col(bubbleL, bubbleC);
    p['--user-bubble-text'] = '#ffffff';
    // Guardrail: keep white bubble text >= 4.5:1 even for odd base colors.
    for (let i = 0; i < 6 && contrastRatio('#ffffff', p['--user-bubble']) < 4.5; i++) {
        bubbleL -= 0.04;
        p['--user-bubble'] = col(bubbleL, bubbleC);
    }
    p['--on-accent'] = relativeLuminance(hexToRgb(p['--accent'])) > 0.2 ? '#14181f' : '#ffffff';
    const argb = hexToRgb(p['--accent']);
    p['--accent-subtle'] = `rgba(${argb.r}, ${argb.g}, ${argb.b}, ${mode === 'light' ? 0.12 : 0.18})`;
    return p;
}

function applyCustomPalette(cp) {
    const root = document.documentElement;
    const p = derivePalette(cp.base, cp.mode, cp.tint);
    for (const [k, v] of Object.entries(p)) root.style.setProperty(k, v);
}

function clearPaletteVars() {
    const root = document.documentElement;
    PALETTE_VARS.forEach(v => root.style.removeProperty(v));
}

function applyChatWidth(name) {
    const px = CHAT_WIDTHS[name] || CHAT_WIDTHS.comfortable;
    document.documentElement.style.setProperty('--chat-max-width', `${px}px`);
}

// Reflect current appearance prefs into the settings-modal controls.
function syncAppearanceControls() {
    const d = UiPrefs.load();
    const theme = THEMES.includes(d.theme) ? d.theme : 'midnight';
    const width = CHAT_WIDTHS[d.chatWidth] ? d.chatWidth : 'comfortable';
    document.querySelectorAll('#themeOptions button').forEach(b => {
        b.classList.toggle('active', b.dataset.themeName === theme);
    });
    document.querySelectorAll('#chatWidthOptions button').forEach(b => {
        b.classList.toggle('active', b.dataset.chatWidth === width);
    });
    const panelMode = d.filePanelMode === 'click' ? 'click' : 'auto';
    document.querySelectorAll('#filePanelModeOptions button').forEach(b => {
        b.classList.toggle('active', b.dataset.filePanelMode === panelMode);
    });
    const cp = d.customPalette;
    if (elements.paletteBase) elements.paletteBase.value = cp.base;
    if (elements.paletteTint) elements.paletteTint.value = cp.tint;
    document.querySelectorAll('#paletteModeOptions button').forEach(b => {
        b.classList.toggle('active', b.dataset.paletteMode === cp.mode);
    });
    // The Custom button's swatch dot previews the currently derived palette.
    const customBtn = document.querySelector('#themeOptions button[data-theme-name="custom"]');
    if (customBtn) {
        const p = derivePalette(cp.base, cp.mode, cp.tint);
        customBtn.style.setProperty('--swatch-bg', p['--bg-primary']);
        customBtn.style.setProperty('--swatch-accent', p['--accent']);
    }
}

// ===== IndexedDB Image Store =====
// Retained ONLY for transient pre-send attachment blobs (state.pendingAttachments
// → IndexedDB → reload-resilient until send). Avatars and persona/expression
// images now live on the server (see API.avatars.*). To be removed in P0-16
// when the chat path also moves server-side.
// Usage:
//   await ImageStore.init()           - Initialize the database
//   await ImageStore.store(key, blob) - Store a blob with a unique key
//   await ImageStore.get(key)         - Get object URL for stored image
//   await ImageStore.delete(key)      - Delete an image
//   ImageStore.revokeURL(url)         - Clean up an object URL
const ImageStore = {
    dbName: 'ai_assistant_images',
    dbVersion: 1,
    storeName: 'images',
    db: null,
    urlCache: new Map(), // key -> objectURL mapping for cleanup

    /**
     * Initialize IndexedDB connection
     * @returns {Promise<IDBDatabase>}
     */
    async init() {
        if (this.db) return this.db;

        // IndexedDB can be entirely absent or blocked by the browser context
        // (private mode in some browsers, or privacy/ad-block extensions that
        // disable site storage). Guard so a missing global or a synchronous
        // throw from open() surfaces as a clean rejection instead of an
        // uncaught error that would abort app startup.
        if (typeof indexedDB === 'undefined' || !indexedDB) {
            throw new Error('IndexedDB is unavailable in this browser context');
        }

        return new Promise((resolve, reject) => {
            let request;
            try {
                request = indexedDB.open(this.dbName, this.dbVersion);
            } catch (err) {
                console.error('Failed to open IndexedDB:', err);
                reject(err);
                return;
            }

            request.onerror = () => {
                console.error('Failed to open IndexedDB:', request.error);
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                console.log('ImageStore: IndexedDB initialized');
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Create object store for images if it doesn't exist
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: 'key' });
                    console.log('ImageStore: Created images object store');
                }
            };
        });
    },

    /**
     * Store an image blob with a unique key
     * @param {string} key - Unique identifier (e.g., 'avatar_main', 'expr_happy')
     * @param {Blob} blob - Image blob to store
     * @returns {Promise<string>} - The key used for storage
     */
    async store(key, blob) {
        await this.init();

        // Revoke any existing URL for this key
        this.revokeURLForKey(key);

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);

            const request = store.put({ key, blob, timestamp: Date.now() });

            request.onsuccess = () => {
                console.log(`ImageStore: Stored image with key "${key}"`);
                resolve(key);
            };

            request.onerror = () => {
                console.error('ImageStore: Failed to store image:', request.error);
                reject(request.error);
            };
        });
    },

    /**
     * Get an image as an object URL
     * @param {string} key - The key to retrieve
     * @returns {Promise<string|null>} - Object URL or null if not found
     */
    async get(key) {
        if (!key) return null;
        await this.init();

        // Return cached URL if available
        if (this.urlCache.has(key)) {
            return this.urlCache.get(key);
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);

            const request = store.get(key);

            request.onsuccess = () => {
                if (request.result && request.result.blob) {
                    const url = URL.createObjectURL(request.result.blob);
                    this.urlCache.set(key, url);
                    resolve(url);
                } else {
                    resolve(null);
                }
            };

            request.onerror = () => {
                console.error('ImageStore: Failed to get image:', request.error);
                reject(request.error);
            };
        });
    },

    /**
     * Delete an image from storage
     * @param {string} key - The key to delete
     * @returns {Promise<void>}
     */
    async delete(key) {
        if (!key) return;
        await this.init();

        // Revoke the URL first
        this.revokeURLForKey(key);

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);

            const request = store.delete(key);

            request.onsuccess = () => {
                console.log(`ImageStore: Deleted image with key "${key}"`);
                resolve();
            };

            request.onerror = () => {
                console.error('ImageStore: Failed to delete image:', request.error);
                reject(request.error);
            };
        });
    },

    /**
     * Get the raw Blob from storage (for API uploads)
     * @param {string} key - The key to retrieve
     * @returns {Promise<Blob|null>} - The blob or null if not found
     */
    async getBlob(key) {
        if (!key) return null;
        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(key);

            request.onsuccess = () => {
                if (request.result && request.result.blob) {
                    resolve(request.result.blob);
                } else {
                    resolve(null);
                }
            };

            request.onerror = () => {
                reject(request.error);
            };
        });
    },

    /**
     * Check if a key exists in storage
     * @param {string} key - The key to check
     * @returns {Promise<boolean>}
     */
    async has(key) {
        if (!key) return false;
        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);

            const request = store.getKey(key);

            request.onsuccess = () => {
                resolve(request.result !== undefined);
            };

            request.onerror = () => {
                reject(request.error);
            };
        });
    },

    /**
     * Revoke an object URL and remove from cache
     * @param {string} key - The key whose URL should be revoked
     */
    revokeURLForKey(key) {
        if (this.urlCache.has(key)) {
            URL.revokeObjectURL(this.urlCache.get(key));
            this.urlCache.delete(key);
        }
    },

    /**
     * Revoke all cached object URLs (call on page unload or cleanup)
     */
    revokeAllURLs() {
        for (const url of this.urlCache.values()) {
            URL.revokeObjectURL(url);
        }
        this.urlCache.clear();
    },

    /**
     * Convert a Base64 data URL to a Blob
     * @param {string} dataUrl - Base64 data URL (e.g., "data:image/png;base64,...")
     * @returns {Blob}
     */
    dataUrlToBlob(dataUrl) {
        const parts = dataUrl.split(',');
        const mime = parts[0].match(/:(.*?);/)[1];
        const binaryString = atob(parts[1]);
        const bytes = new Uint8Array(binaryString.length);

        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        return new Blob([bytes], { type: mime });
    },

    /**
     * Convert a File to a Blob (strips File metadata, keeps just the data)
     * @param {File} file - File object from input
     * @returns {Promise<Blob>}
     */
    async fileToBlob(file) {
        return new Blob([await file.arrayBuffer()], { type: file.type });
    }
};

// ===== State Management =====
const state = {
    // Authenticated user (set after API.auth.status() / API.auth.me())
    // null when unauthenticated. Shape: { id, email, displayName }.
    user: null,
    // App-level preferences from API.settings.get(). Model params live on
    // each catalog model's profile (customModels[provider][i].params).
    settings: {
        avatarSize: CONFIG.defaults.avatarSize,
        avatarPosition: CONFIG.defaults.avatarPosition,
        showAvatar: CONFIG.defaults.showAvatar,
        // User-defined models keyed by provider — persisted server-side as
        // part of the settings row. Each entry is { id, name, params? } where
        // `params` is the model's own profile (full modelParams bag, prefill
        // included) — the "engine" settings that load when it's selected.
        customModels: {
            anthropic: [],
            google: [],
            openai: []
        },
        // Models catalog "daily drivers" filter (Models tab redesign): an array
        // of provider ids the catalog shows, or null for "All". Persisted in the
        // settings row. The provider chips (a later slice) are the only writer.
        catalogProviders: null
    },
    // The active model layer (WR-12): provider + model + params that every
    // chat send and the model/params UI use. User-level, persisted in
    // settings.currentModelConfig. Effectively "the loaded model profile" —
    // switching models saves/loads profiles (docs/MODEL_PROFILES_DESIGN.md);
    // fixed-mode personas pin a model (docs/MODEL_DESYNC_DESIGN.md). Seeded
    // in init(); the default here only covers pre-hydration.
    currentModelConfig: getDefaultModelConfig(),
    // Per-provider key presence metadata from API.apiKeys.list().
    // Never the keys themselves — the backend never returns plaintext.
    apiKeyStatus: {
        anthropic: { hasKey: false, updatedAt: null },
        google: { hasKey: false, updatedAt: null },
        openai: { hasKey: false, updatedAt: null }
    },
    // Personas stored by ID for multi-persona support (from API.personas.list).
    personas: {},
    activePersonaId: null,
    // Conversations stored by ID. Metadata loaded eagerly via
    // API.conversations.list(); messages are loaded lazily via
    // API.conversations.get(id) when the conversation becomes active.
    conversations: {},
    activeConversationId: null,
    // Workspaces stored by ID (from API.workspaces.list). Outer container in the
    // hierarchy workspace ⊃ project ⊃ chat. Metadata only.
    workspaces: {},
    activeWorkspaceId: null,
    // Projects stored by ID (from API.projects.list). Metadata only — file lists
    // are fetched on demand via API.projects.files.list(id). Each has a workspaceId.
    projects: {},
    activeProjectId: null,
    // UI state (session-local, no server source)
    ui: {
        // Main-area router (WR-07): the single content surface shows exactly one
        // view. The sidebar is a section rail that navigates between these.
        //   { type: 'chats' }                 unfiled chats list
        //   { type: 'workspaces' }            all workspaces list
        //   { type: 'workspace', id }         a workspace page (instr/files/projects/chats)
        //   { type: 'project', id }           a project page
        //   { type: 'chat', id }              an open conversation
        // Settings/Personas are reached via the rail too (interim: modal/popover).
        mainView: { type: 'chats' },
        // Persona group ids collapsed in the chats list (session-only).
        collapsedPersonaGroups: new Set()
    },
    currentExpression: 'neutral',
    isLoading: false,
    currentPrefill: '',  // Tracks active prefill for response stripping
    lastRequestModel: null, // Model id of the in-flight/last request, for the per-message tag (WR-14)
    estimatedTokens: 0,
    tempExpressionBlob: null, // Blob waiting to be saved when expression is saved
    tempExpressionPreviewUrl: '', // Object URL for preview in modal
    tempExpressionCleared: false, // Flag indicating user explicitly cleared the image
    // Streaming state. abortController is no longer needed in the frontend —
    // api-client.js manages its own AbortController for the chat stream, and
    // stopGeneration() just calls API.chat.abort().
    streamingMessageDiv: null,
    streamingAccumulator: '',
    streamingGeneratedImages: [],
    // Attachment state
    pendingAttachments: [] // Array of { id, file, previewUrl, type, mimeType, fileName, fileSize }
};

// ===== Conversation Helpers =====

/**
 * Create a new conversation server-side and set it as active.
 * The server generates the id — callers must await this.
 * @param {string} [title] - Optional title, defaults to "New Chat"
 * @returns {Promise<string>} The server-generated conversation ID
 */
async function createConversation(title = 'New Chat', container = null) {
    // Container is explicit (caller decides the home): the Chats tab creates
    // unfiled chats; the Workspaces drill-in creates workspace-/project-level
    // ones. The server derives workspace_id from a project. Persona is always
    // the currently-active one (P2-U3b model).
    const target = container || {};
    const created = await API.conversations.create({
        personaId: state.activePersonaId,
        projectId: target.projectId || null,
        workspaceId: target.workspaceId || null,
        title,
    });
    state.conversations[created.id] = {
        id: created.id,
        title: created.title,
        personaId: created.personaId,
        projectId: created.projectId,
        workspaceId: created.workspaceId,
        toolsEnabled: created.toolsEnabled ?? null,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        messageCount: 0,
        messages: [],
    };
    state.activeConversationId = created.id;

    // Apply a per-chat file-tools override chosen BEFORE the chat was persisted
    // (the toggle was flipped on a fresh, unsaved chat).
    if (state.pendingToolsOverride != null) {
        const override = state.pendingToolsOverride;
        state.pendingToolsOverride = undefined;
        state.conversations[created.id].toolsEnabled = override;
        try {
            await API.conversations.update(created.id, { toolsEnabled: override });
        } catch (err) {
            console.error('Failed to persist pending tools override:', err);
        }
    }

    return created.id;
}

// ===== File-tools toggle (Track A, P2-05b) =====

/**
 * The persona's base file-tools setting (its default for new chats). Stored in
 * the persona's model_config JSON; absent = off.
 * @param {Object} persona
 * @returns {boolean}
 */
function personaToolsBase(persona) {
    return persona?.modelConfig?.toolsEnabled === true;
}

/**
 * The active chat's per-conversation file-tools override: the saved
 * conversation value, or the pending choice for a fresh unsaved chat.
 * true/false = forced, null/undefined = inherit the persona base.
 */
function getToolsOverride() {
    const convo = getActiveConversation();
    return convo ? convo.toolsEnabled : state.pendingToolsOverride;
}

/**
 * The EFFECTIVE file-tools state for the active chat: the per-conversation
 * override wins, else the active persona's base. Mirrors the server's
 * resolveToolsEnabled precedence so the UI matches what a send will do.
 * @returns {boolean}
 */
function effectiveToolsEnabled() {
    const override = getToolsOverride();
    if (override === true) return true;
    if (override === false) return false;
    return personaToolsBase(getActivePersona());
}

/** Whether the effective state comes from a per-chat override vs the persona base. */
function toolsOverrideActive() {
    const override = getToolsOverride();
    return override === true || override === false;
}

/**
 * Reflect the effective file-tools state on the composer toggle: filled when
 * on, muted when off, with a tooltip naming the source (persona default vs
 * this-chat override).
 */
function syncToolsToggle() {
    const btn = elements.toolsToggleBtn;
    if (!btn) return;
    const on = effectiveToolsEnabled();
    const overridden = toolsOverrideActive();
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    const source = overridden ? 'this chat' : 'persona default';
    btn.title = `File tools ${on ? 'on' : 'off'} (${source}) — click to turn ${on ? 'off' : 'on'}`;
}

/**
 * Composer toggle click: flip the EFFECTIVE state and pin it as a per-chat
 * override. Persisted immediately when the chat exists; stashed as pending for
 * a fresh chat (applied on createConversation).
 */
async function toggleChatTools() {
    const next = !effectiveToolsEnabled();
    const convo = getActiveConversation();
    if (convo) {
        convo.toolsEnabled = next;
        syncToolsToggle();
        try {
            await API.conversations.update(convo.id, { toolsEnabled: next });
        } catch (err) {
            console.error('Failed to save file-tools override:', err);
        }
    } else {
        state.pendingToolsOverride = next;
        syncToolsToggle();
    }
}

/**
 * Persona editor checkbox: set the active persona's base file-tools default.
 */
function setPersonaToolsBase(on) {
    const persona = getActivePersona();
    if (!persona) return;
    persona.modelConfig = { ...persona.modelConfig };
    if (on) persona.modelConfig.toolsEnabled = true;
    else delete persona.modelConfig.toolsEnabled;
    persona.updatedAt = Date.now();
    savePersonas();
    syncToolsToggle();
}

/** Reflect the active persona's base setting into the editor checkbox. */
function syncPersonaToolsBaseControl() {
    if (elements.personaToolsBase) {
        elements.personaToolsBase.checked = personaToolsBase(getActivePersona());
    }
}

/**
 * Get the currently active conversation object
 * @returns {Object|null} The active conversation or null if none
 */
function getActiveConversation() {
    if (!state.activeConversationId) {
        return null;
    }
    return state.conversations[state.activeConversationId] || null;
}

/**
 * Update a conversation with partial data
 * @param {string} id - The conversation ID to update
 * @param {Object} updates - Partial updates to apply
 */
function updateConversation(id, updates) {
    if (!state.conversations[id]) {
        console.warn(`Conversation ${id} not found`);
        return;
    }

    state.conversations[id] = {
        ...state.conversations[id],
        ...updates,
        updatedAt: Date.now()
    };

    saveConversations();
}

/**
 * Generate a title from the first user message
 * @param {string} content - The first message content
 * @returns {string} A truncated title
 */
function generateConversationTitle(content) {
    const maxLength = 50;
    const cleaned = content.trim().replace(/\s+/g, ' ');

    if (cleaned.length <= maxLength) {
        return cleaned;
    }

    return cleaned.substring(0, maxLength).trim() + '...';
}

// ===== Persona Helpers =====

/**
 * Create a new persona server-side and set it as active.
 * Server generates the id — callers must await this.
 * @param {string} [name] - Optional name, defaults to "Assistant"
 * @returns {Promise<string>} The server-generated persona ID
 */
async function createPersona(name = CONFIG.defaults.assistantName) {
    // New personas are pure skin: shared model mode, no pin. Engine settings
    // (params, prefill) live on model profiles, not here.
    const modelConfig = {};
    const expressions = { ...CONFIG.defaultExpressions };

    const created = await API.personas.create({
        name,
        systemPrompt: CONFIG.defaults.systemPrompt,
        prefill: '',
        expressions,
        modelConfig,
    });

    state.personas[created.id] = {
        id: created.id,
        name: created.name,
        tagline: created.tagline || '',
        roleLabel: created.roleLabel || '',
        systemPrompt: created.systemPrompt || '',
        prefill: created.prefill || '',
        avatarFilename: created.avatarFilename || '',
        expressions: (created.expressions && typeof created.expressions === 'object')
            ? created.expressions
            : expressions,
        modelConfig: (created.modelConfig && typeof created.modelConfig === 'object')
            ? created.modelConfig
            : modelConfig,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
    };
    state.activePersonaId = created.id;
    return created.id;
}

/**
 * Get the currently active persona object
 * @returns {Object|null} The active persona or null if none
 */
function getActivePersona() {
    if (!state.activePersonaId) {
        return null;
    }
    return state.personas[state.activePersonaId] || null;
}

/**
 * Get the ACTIVE MODEL LAYER (WR-12) — the provider/model/params every send
 * and the model UI use. Callers may mutate the returned object; persistence
 * goes through persistSettings (+ mirrorLayerToModelProfile so the active
 * model's profile remembers the edits).
 * @returns {Object} The model configuration (provider, model, modelParams)
 */
function getActiveModelConfig() {
    return state.currentModelConfig;
}

/**
 * Get the default model configuration structure
 * @returns {Object} Default model config
 */
function getDefaultModelConfig() {
    return {
        provider: CONFIG.defaults.provider,
        model: CONFIG.defaults.model,
        modelParams: {
            temperature: 1.0,
            topP: 0.95,
            topK: 40,
            maxTokens: 4096,
            stopSequences: [],
            // Response prefill — an "engine" param like temperature, saved per
            // model profile (moved off the persona; personas are pure skin).
            prefill: '',
            streaming: false,
            temperatureEnabled: true,
            topPEnabled: true,
            topKEnabled: true,
            anthropic: {
                thinkingEnabled: false,
                thinkingBudget: 4000
            },
            google: {
                // thinkingApi selects which thinking control is sent: 'off',
                // 'level' (Gemini 3+ thinkingLevel) or 'budget' (Gemini 2.5
                // thinkingBudget). They're mutually exclusive in the API.
                thinkingApi: 'off',
                thinkingLevel: 'medium',
                thinkingBudget: -1,
                safetyHarassment: 'BLOCK_MEDIUM_AND_ABOVE',
                safetyHate: 'BLOCK_MEDIUM_AND_ABOVE',
                safetySexual: 'BLOCK_MEDIUM_AND_ABOVE',
                safetyDangerous: 'BLOCK_MEDIUM_AND_ABOVE'
            }
        }
    };
}

// ===== Model profiles =====
// Each catalog model (settings.customModels[provider][i]) owns a `params`
// profile — the full modelParams bag, prefill included. The active layer is
// just "the currently loaded profile": switching models saves the outgoing
// model's params to its profile and loads the incoming one's. A model that
// has never been used keeps the carried-over params (and starts remembering
// from there), so nothing resets unexpectedly.

/** Find a model's catalog entry, or null. */
function getCatalogEntry(provider, modelId) {
    const models = state.settings.customModels[provider] || [];
    return models.find(m => m.id === modelId) || null;
}

/**
 * Save the active layer's params into the profile of the layer's current
 * model. State-only — persistence rides on the caller's persistSettings()
 * (customModels is part of the settings payload).
 */
function mirrorLayerToModelProfile() {
    const layer = getActiveModelConfig();
    const entry = getCatalogEntry(layer.provider, layer.model);
    if (!entry) return;
    entry.params = JSON.parse(JSON.stringify(layer.modelParams));
}

/**
 * Load the layer's current model's saved profile into the layer. Models with
 * no profile yet keep the carried-over params (today's behavior) — their
 * profile is written on the next edit/switch. Deep-copied so later layer
 * edits don't silently mutate the stored profile.
 */
function loadModelProfileIntoLayer() {
    const layer = getActiveModelConfig();
    const entry = getCatalogEntry(layer.provider, layer.model);
    if (!entry || !entry.params) return;
    const merged = mergeModelConfig({ modelParams: entry.params });
    layer.modelParams = JSON.parse(JSON.stringify(merged.modelParams));
}

/**
 * Core model switch: remember the outgoing model's params in its profile,
 * move the layer to the new provider/model, and load the incoming profile.
 * @returns {boolean} true if the layer actually changed.
 */
function applyModelToLayer(provider, modelId) {
    const layer = getActiveModelConfig();
    if (layer.provider === provider && layer.model === modelId) return false;
    mirrorLayerToModelProfile();
    if (layer.provider !== provider) {
        layer.provider = provider;
        // Provider-switch housekeeping. The old provider <select>, model
        // dropdown, API-key field, and static Advanced params are gone (Slices
        // 4–5) — switching is via catalog cards, the key is provider-owned, and
        // params live in the per-model detail view. The send button still needs
        // a refresh; the catalog/chips refresh on the ensuing updateUI.
        updateSendButtonState();
    }
    layer.model = modelId;
    loadModelProfileIntoLayer();
    return true;
}

/** Find which provider a catalog model id belongs to, or null if not saved. */
function findModelProvider(modelId) {
    for (const provider of Object.keys(state.settings.customModels)) {
        if ((state.settings.customModels[provider] || []).some(m => m.id === modelId)) {
            return provider;
        }
    }
    return null;
}

/**
 * Restore a chat's model on open: the model that produced its last assistant
 * reply (per-message tag, WR-14) becomes the active model again, profile and
 * all — so coming back to a conversation keeps the engine it was running on.
 * Skipped when the chat's persona pins a model (fixed mode wins), when the
 * chat has no tagged replies yet, or when the tagged model is no longer in
 * the catalog. Requires convo.messages to be loaded.
 */
function restoreConversationModel(convo) {
    if (!convo || !Array.isArray(convo.messages)) return;
    if (personaModelMode(getActivePersona()) === 'fixed') return;
    const lastTagged = [...convo.messages].reverse()
        .find(m => m.role === 'assistant' && m.model);
    if (!lastTagged) return;
    const provider = findModelProvider(lastTagged.model);
    if (!provider) return; // removed from the catalog — keep the current model
    if (applyModelToLayer(provider, lastTagged.model)) {
        persistSettings();
    }
}

// ===== Persona model-settings mode (WR-12, reshaped by model profiles) =====
// A persona's modelConfig JSON is now a PIN, not a snapshot:
//   'shared' (default) — modelConfig is {}; the persona never touches the
//                        active layer. Pure skin.
//   'fixed'            — modelConfig is { mode:'fixed', provider, model }:
//                        activating the persona selects that model, which
//                        loads the model's own profile. The params live on
//                        the model, never on the persona.

/** @returns {'shared'|'fixed'} */
function personaModelMode(persona) {
    return persona?.modelConfig?.mode === 'fixed' ? 'fixed' : 'shared';
}

/**
 * Deep-clone a persona's saved modelConfig into layer shape (no mode flag).
 * Legacy-seed helper: only used by init() to seed the layer on the first load
 * after the WR-12 de-sync upgrade, when personas still held full snapshots.
 */
function layerFromPersona(persona) {
    const cfg = mergeModelConfig(persona?.modelConfig);
    delete cfg.mode;
    return cfg;
}

/**
 * Keep the active fixed persona's pin pointing at the layer's current model.
 * A model/provider switch made while a fixed persona is active re-pins it
 * (last-used auto-save, same spirit as pre-profiles WR-12). State-only;
 * persistSettings()'s savePersonas ride-along persists it.
 */
function updateFixedPersonaPin() {
    const persona = getActivePersona();
    if (!persona || personaModelMode(persona) !== 'fixed') return;
    const layer = getActiveModelConfig();
    const cfg = persona.modelConfig || {};
    // `modelParams` present = legacy full snapshot → rewrite to a slim pin.
    if (cfg.provider === layer.provider && cfg.model === layer.model && !cfg.modelParams) return;
    persona.modelConfig = { mode: 'fixed', provider: layer.provider, model: layer.model };
    persona.updatedAt = Date.now();
}

/**
 * Apply a persona's model-settings mode on activation: 'fixed' selects its
 * pinned model (loading that model's profile); 'shared' leaves the layer
 * untouched.
 */
function applyPersonaModelSettings(persona) {
    if (!persona || personaModelMode(persona) !== 'fixed') return;
    const pin = persona.modelConfig || {};
    if (!pin.provider || !pin.model) return;
    // One-time legacy migration: pre-profiles fixed personas snapshotted full
    // params. Seed the pinned model's profile from them (unless it already
    // has one), fold in the persona's old prefill, then slim to a pure pin.
    if (pin.modelParams) {
        const entry = getCatalogEntry(pin.provider, pin.model);
        if (entry && !entry.params) {
            entry.params = JSON.parse(JSON.stringify(pin.modelParams));
            if (persona.prefill && entry.params.prefill === undefined) {
                entry.params.prefill = persona.prefill;
            }
        }
        persona.modelConfig = { mode: 'fixed', provider: pin.provider, model: pin.model };
        persona.updatedAt = Date.now();
    }
    applyModelToLayer(pin.provider, pin.model);
    persistSettings();
}

/** Reflect the active persona's model-settings mode into the editor toggle. */
function syncPersonaModelModeControls() {
    const persona = getActivePersona();
    const mode = personaModelMode(persona);
    document.querySelectorAll('#personaModelModeOptions button').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.modelMode === mode);
    });
    const hint = document.getElementById('personaModelModeHint');
    if (hint) {
        if (mode === 'fixed') {
            const pinnedModel = persona?.modelConfig?.model || '';
            const label = pinnedModel ? getModelDisplayName(pinnedModel) : 'its pinned model';
            hint.textContent = `Fixed: activating this persona always loads ${label} and that model's saved parameters.`;
        } else {
            hint.textContent = 'Shared: this persona uses whatever model (and its saved parameters) is currently active.';
        }
    }
}

/**
 * Set the active persona's model-settings mode (from the editor toggle).
 * Flipping to 'fixed' pins the CURRENTLY selected model — the params stay on
 * the model's own profile, never on the persona. Flipping to 'shared' drops
 * the pin.
 */
function setPersonaModelMode(mode) {
    const persona = getActivePersona();
    if (!persona || personaModelMode(persona) === mode) return;
    if (mode === 'fixed') {
        const layer = getActiveModelConfig();
        persona.modelConfig = { mode: 'fixed', provider: layer.provider, model: layer.model };
    } else {
        persona.modelConfig = {};
    }
    persona.updatedAt = Date.now();
    savePersonas();
    syncPersonaModelModeControls();
}

/**
 * Update a persona with partial data
 * @param {string} id - The persona ID to update
 * @param {Object} updates - Partial updates to apply
 */
function updatePersona(id, updates) {
    if (!state.personas[id]) {
        console.warn(`Persona ${id} not found`);
        return;
    }

    state.personas[id] = {
        ...state.personas[id],
        ...updates,
        updatedAt: Date.now()
    };

    savePersonas();
}

/**
 * Persist all personas to the server.
 * Fire-and-forget by design: most callers are UI handlers that don't need to
 * block on the round-trip; failures are logged but don't surface in P0-15
 * (toast UX comes in P0-17). Runs the updates in parallel.
 */
function savePersonas() {
    const personas = Object.values(state.personas);
    Promise.all(personas.map(p =>
        API.personas.update(p.id, {
            name: p.name,
            tagline: p.tagline || '',
            roleLabel: p.roleLabel || '',
            systemPrompt: p.systemPrompt,
            prefill: p.prefill,
            // avatarFilename is INTENTIONALLY omitted. It's owned by the avatar
            // endpoints (POST/DELETE /api/personas/:id/avatar) — including it
            // here would let the client's in-memory '1' sentinel from
            // handleAvatarUpload clobber the server's real filename, breaking
            // the avatar permanently on the next GET.
            expressions: p.expressions,
            modelConfig: p.modelConfig,
        }).catch(err => {
            console.error(`Failed to persist persona ${p.id}:`, err);
        })
    ));
}

// ===== DOM Elements =====
const elements = {
    // Sidebar
    sidebar: document.getElementById('sidebar'),
    openSidebar: document.getElementById('openSidebar'),
    closeSidebar: document.getElementById('closeSidebar'),

    // Sidebar tabs (Personas tab retired in P2-U3b part 2 — persona management
    // now lives in the top-bar persona popover)
    chatsTab: document.getElementById('chatsTab'),
    projectsTab: document.getElementById('projectsTab'),

    // Settings modal (relocated out of the sidebar)
    settingsModal: document.getElementById('settingsModal'),
    closeSettingsModal: document.getElementById('closeSettingsModal'),

    // Appearance controls
    paletteBase: document.getElementById('paletteBase'),
    paletteTint: document.getElementById('paletteTint'),
    paletteResetBtn: document.getElementById('paletteResetBtn'),
    devModeToggle: document.getElementById('devModeToggle'),

    // Request inspector (developer mode)
    viewRequestBtn: document.getElementById('viewRequestBtn'),
    requestInspectorModal: document.getElementById('requestInspectorModal'),
    closeRequestInspector: document.getElementById('closeRequestInspector'),
    requestInspectorJson: document.getElementById('requestInspectorJson'),
    requestInspectorMeta: document.getElementById('requestInspectorMeta'),
    copyRequestBtn: document.getElementById('copyRequestBtn'),

    // File panel (edit-in-context slice 1: viewer)
    filePanel: document.getElementById('filePanel'),
    filePanelBadge: document.getElementById('filePanelBadge'),
    filePanelName: document.getElementById('filePanelName'),
    filePanelRawToggle: document.getElementById('filePanelRawToggle'),
    filePanelHistoryBtn: document.getElementById('filePanelHistoryBtn'),
    filePanelEditBtn: document.getElementById('filePanelEditBtn'),
    filePanelDownload: document.getElementById('filePanelDownload'),
    filePanelClose: document.getElementById('filePanelClose'),
    filePanelBody: document.getElementById('filePanelBody'),
    filePanelFooter: document.getElementById('filePanelFooter'),
    filePanelConflict: document.getElementById('filePanelConflict'),
    filePanelCancelBtn: document.getElementById('filePanelCancelBtn'),
    filePanelSaveBtn: document.getElementById('filePanelSaveBtn'),
    filePanelTab: document.getElementById('filePanelTab'),
    filePanelTabDot: document.getElementById('filePanelTabDot'),

    // Name-only create modal (shared by workspace + project creation; the full
    // edit UI lives inline on the container page — WR-05).
    nameModal: document.getElementById('nameModal'),
    nameModalTitle: document.getElementById('nameModalTitle'),
    nameModalLabel: document.getElementById('nameModalLabel'),
    nameModalInput: document.getElementById('nameModalInput'),
    nameModalSaveBtn: document.getElementById('nameModalSaveBtn'),
    closeNameModal: document.getElementById('closeNameModal'),

    // Shared confirm dialog (replaces window.confirm — see confirmDialog()).
    confirmModal: document.getElementById('confirmModal'),
    confirmModalTitle: document.getElementById('confirmModalTitle'),
    confirmModalBody: document.getElementById('confirmModalBody'),
    confirmModalCancelBtn: document.getElementById('confirmModalCancelBtn'),
    confirmModalConfirmBtn: document.getElementById('confirmModalConfirmBtn'),

    // Top-bar breadcrumb indicator (No workspace / WS / WS › Project)
    workspaceBreadcrumb: document.getElementById('workspaceBreadcrumb'),

    // Settings inputs
    assistantName: document.getElementById('assistantName'),
    personaTagline: document.getElementById('personaTagline'),
    personaTaglineCount: document.getElementById('personaTaglineCount'),
    personaRoleLabel: document.getElementById('personaRoleLabel'),
    personaRoleLabelCount: document.getElementById('personaRoleLabelCount'),
    systemPrompt: document.getElementById('systemPrompt'),
    // Model parameter controls (temperature, prefill, thinking, safety, …) moved
    // to the per-model detail view (renderModelDetail, Slice 5) — rendered from
    // PROVIDERS descriptors, so no static element refs here.

    // Avatar settings
    avatarFileInput: document.getElementById('avatarFileInput'),
    avatarUploadBtn: document.getElementById('avatarUploadBtn'),
    avatarClearBtn: document.getElementById('avatarClearBtn'),
    avatarMoodBadge: document.getElementById('avatarMoodBadge'),
    avatarPreview: document.getElementById('avatarPreview'),
    avatarPreviewName: document.getElementById('avatarPreviewName'),
    avatarPreviewTagline: document.getElementById('avatarPreviewTagline'),
    avatarPreviewStatus: document.getElementById('avatarPreviewStatus'),
    showAvatar: document.getElementById('showAvatar'),
    activeFileTurns: document.getElementById('activeFileTurns'),

    // Expression settings
    expressionList: document.getElementById('expressionList'),
    addExpressionBtn: document.getElementById('addExpressionBtn'),
    
    // Expression modal
    expressionModal: document.getElementById('expressionModal'),
    closeExpressionModal: document.getElementById('closeExpressionModal'),
    expressionModalTitle: document.getElementById('expressionModalTitle'),
    expressionName: document.getElementById('expressionName'),
    expressionEmoji: document.getElementById('expressionEmoji'),
    expressionFileInput: document.getElementById('expressionFileInput'),
    expressionUploadBtn: document.getElementById('expressionUploadBtn'),
    expressionClearBtn: document.getElementById('expressionClearBtn'),
    expressionImagePreview: document.getElementById('expressionImagePreview'),
    saveExpressionBtn: document.getElementById('saveExpressionBtn'),
    deleteExpressionBtn: document.getElementById('deleteExpressionBtn'),

    // Model management
    modelModal: document.getElementById('modelModal'),
    closeModelModal: document.getElementById('closeModelModal'),
    modelModalProviders: document.getElementById('modelModalProviders'),
    fetchModelsBtn: document.getElementById('fetchModelsBtn'),
    fetchModelsHelp: document.getElementById('fetchModelsHelp'),
    modalKeyBtn: document.getElementById('modalKeyBtn'),
    availableModelsGrid: document.getElementById('availableModelsGrid'),
    newModelId: document.getElementById('newModelId'),
    newModelName: document.getElementById('newModelName'),
    addModelBtn: document.getElementById('addModelBtn'),

    // Chat area
    chatArea: document.getElementById('chatArea'),
    dragOverlay: document.getElementById('dragOverlay'),
    messagesContainer: document.getElementById('messagesContainer'),
    settingsView: document.getElementById('settingsView'),
    personaEditView: document.getElementById('personaEditView'),
    modelsView: document.getElementById('modelsView'),
    inputContainer: document.getElementById('inputContainer'),
    messageInput: document.getElementById('messageInput'),
    sendButton: document.getElementById('sendButton'),
    stopButton: document.getElementById('stopButton'),
    attachButton: document.getElementById('attachButton'),
    fileAttachInput: document.getElementById('fileAttachInput'),
    attachmentPreviewArea: document.getElementById('attachmentPreviewArea'),
    composerModelButton: document.getElementById('composerModelButton'),
    composerModelName: document.getElementById('composerModelName'),
    toolsToggleBtn: document.getElementById('toolsToggleBtn'),
    personaToolsBase: document.getElementById('personaToolsBase'),
    
    // Status bar
    headerAssistantName: document.getElementById('headerAssistantName'),
    modelIndicator: document.getElementById('modelIndicator'),
    personaButton: document.getElementById('personaButton'),
    modelButton: document.getElementById('modelButton'),
    statusTokens: document.getElementById('statusTokens'),
    avatarToggleBtn: document.getElementById('avatarToggleBtn'),
    
    // Floating avatar
    floatingAvatar: document.getElementById('floatingAvatar'),
    avatarImage: document.getElementById('avatarImage'),
    avatarSizeSlider: document.getElementById('avatarSizeSlider'),
    avatarSizeValue: document.getElementById('avatarSizeValue'),
    avatarEmoji: document.getElementById('avatarEmoji'),
    avatarImg: document.getElementById('avatarImg'),
    floatingAvatarName: document.getElementById('floatingAvatarName'),
    floatingAvatarExpression: document.getElementById('floatingAvatarExpression'),

    // Error display system (P0-17)
    toastContainer: document.getElementById('toastContainer'),
    criticalBanner: document.getElementById('criticalBanner'),
    criticalBannerMessage: document.getElementById('criticalBannerMessage'),
    criticalBannerAction: document.getElementById('criticalBannerAction'),
    criticalBannerDismiss: document.getElementById('criticalBannerDismiss')
};

// ===== Initialization =====
// init() is called by bootstrap() in the auth-gate block (P0-14) once the
// user is authenticated. It fetches all server-side state in parallel,
// hydrates the in-memory `state` object, then wires the UI.
async function init() {
    // Parallel fetch — these are independent endpoints.
    const [settings, personas, conversations, apiKeyStatus, workspaces, projects] = await Promise.all([
        API.settings.get(),
        API.personas.list(),
        API.conversations.list(),
        API.apiKeys.list(),
        // Workspaces + projects are non-essential to core chat — degrade to empty
        // on failure rather than blocking the whole app load (the others are
        // essential and intentionally fail-fast).
        API.workspaces.list().catch(err => {
            console.warn('Failed to load workspaces; continuing without them:', err);
            return [];
        }),
        API.projects.list().catch(err => {
            console.warn('Failed to load projects; continuing without them:', err);
            return [];
        }),
    ]);

    hydrateSettings(settings);
    hydratePersonas(personas);
    hydrateConversations(conversations);
    hydrateApiKeyStatus(apiKeyStatus);
    hydrateWorkspaces(workspaces);
    hydrateProjects(projects);

    // Pick the most recently updated persona/conversation as active.
    pickActivePersona();
    pickActiveConversation();

    // Seed the active model layer (WR-12) on first load after the de-sync
    // upgrade: adopt the active persona's saved config so nothing visibly
    // changes. Persisted immediately so the seed is stable across devices.
    if (!state.currentModelConfig) {
        state.currentModelConfig = layerFromPersona(getActivePersona());
        API.settings.update({ currentModelConfig: state.currentModelConfig }).catch(err => {
            console.error('Failed to persist seeded model layer:', err);
        });
    }

    // One-time migration (model profiles): prefill used to live on the
    // persona. When the saved layer predates the move, adopt the active
    // persona's prefill into the layer + the active model's profile so
    // existing setups keep responding the same after the upgrade.
    if (layerNeedsPrefillSeed && getActivePersona()?.prefill) {
        state.currentModelConfig.modelParams.prefill = getActivePersona().prefill;
        mirrorLayerToModelProfile();
        API.settings.update({
            currentModelConfig: state.currentModelConfig,
            customModels: state.settings.customModels,
        }).catch(err => {
            console.error('Failed to persist migrated prefill:', err);
        });
    }

    // Restore the entered container (device-local). A project implies its
    // workspace; otherwise restore a bare workspace. Stale ids are cleared. If
    // the picked conversation isn't in the restored container, drop it so the
    // container's view shows on load instead of an unrelated chat.
    restoreActiveContainer();

    // Fetch messages for the active conversation eagerly so the first
    // render isn't empty. Other conversations are lazy-loaded on switch.
    if (state.activeConversationId) {
        await loadConversationMessages(state.activeConversationId);
    }

    // Reload = reopening the chat: align the persona with the restored
    // conversation (pickActivePersona's most-recently-edited guess above is
    // only a fallback for when no chat is restored) and bring back the chat's
    // model — same behavior as switchConversation, so a reload never swaps
    // the persona or engine mid-conversation.
    const restoredConvo = getActiveConversation();
    if (restoredConvo) {
        if (restoredConvo.personaId && state.personas[restoredConvo.personaId]) {
            state.activePersonaId = restoredConvo.personaId;
            applyPersonaModelSettings(getActivePersona()); // fixed pin wins
        }
        restoreConversationModel(restoredConvo);
    }

    // (Appearance/layout prefs are applied early in bootstrap so they cover the
    // login screen too — no need to re-apply here.)

    // Wire UI after state is populated so listeners read coherent state.
    setupEventListeners();
    applyDevMode(); // reflect the device-local developer-mode pref
    await updateUI();
    createSidebarOverlay();

    // ImageStore is retained for transient pre-send attachment blobs only.
    // It is NOT required to run the app — avatars and all persisted data come
    // from the server. If IndexedDB is unavailable (private mode, or a privacy/
    // ad-block extension blocking site storage), degrade gracefully: the app
    // loads normally and only image attachments are disabled for the session.
    // Crashing init() here would log the user straight back out.
    try {
        await ImageStore.init();
        window.addEventListener('beforeunload', () => {
            ImageStore.revokeAllURLs();
        });
    } catch (err) {
        console.warn('ImageStore (IndexedDB) unavailable — image attachments disabled this session:', err);
        showToast(
            'Image attachments are unavailable because this browser is blocking local storage (often a privacy extension or private mode). The rest of the app works normally.',
            { type: 'warning', duration: 9000, key: 'imagestore-unavailable' }
        );
    }

    console.log('Tessera initialized!');
}

// ===== Server → state hydration =====

// True when the saved layer predates the prefill move into model params —
// init() then adopts the active persona's legacy prefill once.
let layerNeedsPrefillSeed = false;

function hydrateSettings(settings) {
    if (!settings) return;
    layerNeedsPrefillSeed = settings.currentModelConfig?.modelParams?.prefill === undefined;
    state.settings.avatarSize = settings.avatarSize || CONFIG.defaults.avatarSize;
    state.settings.avatarPosition = settings.avatarPosition || CONFIG.defaults.avatarPosition;
    state.settings.showAvatar = settings.showAvatar !== undefined ? settings.showAvatar : CONFIG.defaults.showAvatar;
    state.settings.activeFileTurns = settings.activeFileTurns !== undefined ? settings.activeFileTurns : CONFIG.defaults.activeFileTurns;
    // customModels arrives as an object keyed by provider (parsed JSON from
    // the server). Default empty arrays per provider if absent.
    const cm = settings.customModels || {};
    state.settings.customModels = {
        anthropic: Array.isArray(cm.anthropic) ? cm.anthropic : [],
        google: Array.isArray(cm.google) ? cm.google : [],
        openai: Array.isArray(cm.openai) ? cm.openai : [],
    };
    // Models catalog "daily drivers" filter. null (server default) = "All".
    state.settings.catalogProviders = Array.isArray(settings.catalogProviders)
        ? settings.catalogProviders
        : null;
    // The active model layer (WR-12). NULL sentinel = not yet seeded (first
    // load after the de-sync upgrade) — init() seeds it from the active
    // persona once personas are hydrated.
    state.currentModelConfig = settings.currentModelConfig
        ? (() => { const cfg = mergeModelConfig(settings.currentModelConfig); delete cfg.mode; return cfg; })()
        : null;
}

function hydratePersonas(personas) {
    state.personas = {};
    for (const p of (personas || [])) {
        // Server returns `expressions` as a parsed object. Backfill defaults
        // when it is missing OR an empty object. Server-created default
        // personas (e.g. the one made during the OAuth callback) have no
        // expressions, which the DAL JSON-parses to `{}`. An empty object is
        // truthy, so without the key-count check the persona would run with no
        // expressions and the UI would crash reading e.g. expressions.neutral.emoji.
        const hasExpressions = p.expressions
            && typeof p.expressions === 'object'
            && Object.keys(p.expressions).length > 0;
        const expressions = hasExpressions
            ? p.expressions
            : { ...CONFIG.defaultExpressions };
        // The generating slot must always exist — otherwise setExpression()
        // silently no-ops while the model works and the slot never appears in
        // the expression editor. Personas predating it get it backfilled.
        // Note this deliberately leaves any existing `thinking` entry alone:
        // it used to be this reserved slot, and now demotes to an ordinary
        // expression, art and all.
        if (!expressions[CONFIG.generatingExpression]) {
            expressions[CONFIG.generatingExpression] = { ...CONFIG.defaultExpressions.generating };
        }
        state.personas[p.id] = {
            id: p.id,
            name: p.name,
            tagline: p.tagline || '',
            roleLabel: p.roleLabel || '',
            systemPrompt: p.systemPrompt || '',
            prefill: p.prefill || '',
            avatarFilename: p.avatarFilename || '',
            expressions,
            // Model profiles: a persona's modelConfig is a slim pin
            // ({ mode:'fixed', provider, model }) or {} for shared. Kept raw —
            // legacy full snapshots keep their modelParams so
            // applyPersonaModelSettings can seed the pinned model's profile
            // once, then slims them down.
            modelConfig: (p.modelConfig && typeof p.modelConfig === 'object') ? p.modelConfig : {},
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
        };
    }
}

/**
 * Merge a (possibly incomplete) modelConfig from the server with the
 * frontend's default structure. Server-provided values win; missing fields
 * are filled from the default. Returns a brand-new object — never mutates
 * the default.
 */
function mergeModelConfig(serverConfig) {
    const defaults = getDefaultModelConfig();
    if (!serverConfig || typeof serverConfig !== 'object') return defaults;
    const incoming = serverConfig.modelParams || {};
    const incomingAnthropic = incoming.anthropic || {};
    const incomingGoogle = incoming.google || {};
    return {
        provider: serverConfig.provider || defaults.provider,
        model: serverConfig.model || defaults.model,
        // Persona model-settings mode (WR-12). Absent = 'shared'; must survive
        // the merge or fixed personas would reset on every reload.
        ...(serverConfig.mode === 'fixed' ? { mode: 'fixed' } : {}),
        modelParams: {
            ...defaults.modelParams,
            ...incoming,
            anthropic: { ...defaults.modelParams.anthropic, ...incomingAnthropic },
            google: { ...defaults.modelParams.google, ...incomingGoogle },
        },
    };
}

function hydrateConversations(conversations) {
    state.conversations = {};
    for (const c of (conversations || [])) {
        // List endpoint returns metadata only — messages are loaded lazily
        // via API.conversations.get(id). `messages: undefined` is the sentinel
        // for "not yet loaded"; `messages: []` is "loaded, empty".
        state.conversations[c.id] = {
            id: c.id,
            title: c.title,
            personaId: c.personaId,
            projectId: c.projectId,
            workspaceId: c.workspaceId,
            // Track A per-chat file-tools override: null = inherit persona base,
            // true/false = forced. Preserved so the composer toggle reflects it.
            toolsEnabled: c.toolsEnabled ?? null,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            messageCount: c.messageCount || 0,
            messages: undefined,
        };
    }
}

function hydrateProjects(projects) {
    state.projects = {};
    for (const p of (projects || [])) {
        state.projects[p.id] = {
            id: p.id,
            workspaceId: p.workspaceId || null,
            name: p.name,
            instructions: p.instructions || '',
            fileCount: p.fileCount || 0,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
        };
    }
}

function hydrateWorkspaces(workspaces) {
    state.workspaces = {};
    for (const w of (workspaces || [])) {
        state.workspaces[w.id] = {
            id: w.id,
            name: w.name,
            instructions: w.instructions || '',
            projectCount: w.projectCount || 0,
            fileCount: w.fileCount || 0,
            createdAt: w.createdAt,
            updatedAt: w.updatedAt,
        };
    }
}

/**
 * Restore the device-local "entered container" on load. A saved project implies
 * its workspace; a bare saved workspace restores just that. Stale ids (deleted
 * since) are dropped. If the active conversation doesn't belong to the restored
 * container, it's cleared so the container's view shows instead of a stray chat.
 */
function restoreActiveContainer() {
    const savedProject = UiPrefs.get('activeProject');
    const savedWorkspace = UiPrefs.get('activeWorkspace');

    if (savedProject && state.projects[savedProject]) {
        state.activeProjectId = savedProject;
        state.activeWorkspaceId = state.projects[savedProject].workspaceId || null;
    } else if (savedWorkspace && state.workspaces[savedWorkspace]) {
        state.activeWorkspaceId = savedWorkspace;
        state.activeProjectId = null;
    } else {
        state.activeProjectId = null;
        state.activeWorkspaceId = null;
    }

    // Persist the reconciled state (clears any stale stored ids).
    UiPrefs.set('activeProject', state.activeProjectId);
    UiPrefs.set('activeWorkspace', state.activeWorkspaceId);

    const convo = getActiveConversation();
    if (convo) {
        const inContainer = state.activeProjectId
            ? convo.projectId === state.activeProjectId
            : (state.activeWorkspaceId ? convo.workspaceId === state.activeWorkspaceId : false);
        if (!inContainer && (state.activeProjectId || state.activeWorkspaceId)) {
            state.activeConversationId = null;
        }
    }

    // Initial main-area view (WR-07): resume the active chat, else the active
    // container page, else the Chats list.
    if (state.activeConversationId) {
        state.ui.mainView = { type: 'chat', id: state.activeConversationId };
    } else if (state.activeProjectId) {
        state.ui.mainView = { type: 'project', id: state.activeProjectId };
    } else if (state.activeWorkspaceId) {
        state.ui.mainView = { type: 'workspace', id: state.activeWorkspaceId };
    } else {
        state.ui.mainView = { type: 'chats' };
    }
}

function hydrateApiKeyStatus(apiKeyStatus) {
    // Server returns [{ provider, hasKey, updatedAt }]. Map to per-provider.
    for (const entry of (apiKeyStatus || [])) {
        if (state.apiKeyStatus[entry.provider]) {
            state.apiKeyStatus[entry.provider] = {
                hasKey: !!entry.hasKey,
                updatedAt: entry.updatedAt || null,
            };
        }
    }
}

function pickActivePersona() {
    const personas = Object.values(state.personas);
    if (personas.length === 0) {
        state.activePersonaId = null;
        return;
    }
    const mostRecent = personas.reduce((a, b) =>
        (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a
    );
    state.activePersonaId = mostRecent.id;
}

function pickActiveConversation() {
    const convos = Object.values(state.conversations);
    if (convos.length === 0) {
        state.activeConversationId = null;
        return;
    }
    const mostRecent = convos.reduce((a, b) =>
        (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a
    );
    state.activeConversationId = mostRecent.id;
}

/**
 * Lazy-load a conversation's full message history. Idempotent: if messages
 * are already loaded (or being loaded), returns without an extra fetch.
 */
async function loadConversationMessages(conversationId) {
    const convo = state.conversations[conversationId];
    if (!convo) return;
    if (convo.messages !== undefined) return; // already loaded
    try {
        const full = await API.conversations.get(conversationId);
        convo.messages = (full && full.messages) || [];
    } catch (err) {
        console.error(`Failed to load messages for ${conversationId}:`, err);
        convo.messages = []; // surface as empty rather than retry-storming
    }
}

// ===== Settings Management =====

// ===== Real-Time Auto-Save =====
// Debounces the settings PUT so a slider drag or a fast typist doesn't churn
// /api/settings. API keys have their own explicit save path now (saveProviderKey
// from the provider key popover), not this settings tick.
let autoSaveTimeout = null;

/**
 * Debounced auto-save function
 * Saves settings after 300ms of no changes to avoid excessive writes
 */
function autoSaveSettings() {
    if (autoSaveTimeout) {
        clearTimeout(autoSaveTimeout);
    }
    autoSaveTimeout = setTimeout(() => {
        saveAllSettingsFromUI();
        persistSettings();
    }, 300);
}

/**
 * Set the Models catalog "daily drivers" provider filter and persist it
 * (debounced). `providers` is an array of provider ids, or null/[] for "All" —
 * an empty selection normalises to null so the catalog never renders blank
 * (docs/MODELS_TAB_REDESIGN.md). Plumbing only in this slice; the provider
 * chips are the caller in a later slice.
 * @param {string[] | null} providers
 */
function saveCatalogProviders(providers) {
    state.settings.catalogProviders =
        Array.isArray(providers) && providers.length ? providers : null;
    autoSaveSettings();
}

/**
 * Collect all current UI values into state
 */
function saveAllSettingsFromUI() {
    const persona = getActivePersona();

    // The active model/provider are no longer read from UI selects (removed in
    // Slice 4) — they're maintained directly in the layer by selectModel /
    // applyModelToLayer (catalog cards). The API key is provider-owned and saved
    // straight from its popover (saveProviderKey), not via this settings tick.

    // Avatar visibility is read here; size/position are kept authoritative in
    // state by their own controls (presets, the size slider, and drag), so we
    // don't read the preset buttons — that would clobber a free value.
    state.settings.showAvatar = elements.showAvatar.checked;

    // Model params are edited in the per-model detail view (Slice 5), which
    // writes them straight into the profile. This tick still mirrors the active
    // layer to its profile (so a detail-view edit to the active model persists)
    // and re-pins a fixed persona to the current model.
    mirrorLayerToModelProfile();
    updateFixedPersonaPin();

    // Persona settings (name, system prompt — prefill lives in model params now)
    if (persona) {
        persona.name = elements.assistantName.value || CONFIG.defaults.assistantName;
        persona.tagline = elements.personaTagline.value.trim();
        persona.roleLabel = elements.personaRoleLabel.value.trim();
        persona.systemPrompt = elements.systemPrompt.value || CONFIG.defaults.systemPrompt;
        persona.updatedAt = Date.now();
    }
}

/**
 * Save a provider's API key to the server (explicit, from the provider key
 * popover). Optimistically flips apiKeyStatus.hasKey so the catalog badge / send
 * button unlock immediately; on failure, resyncs from the server and toasts.
 * The key value never lives in `state` — it goes straight to the API.
 * @param {string} provider
 * @param {string} value - the plaintext key (non-empty)
 */
async function saveProviderKey(provider, value) {
    if (!provider || !value) return;
    // Optimistic: reflect a saved key in the catalog + chips right away.
    state.apiKeyStatus[provider] = { ...state.apiKeyStatus[provider], hasKey: true };
    renderModelsCatalog();
    updateSendButtonState();
    try {
        const result = await API.apiKeys.set(provider, value);
        state.apiKeyStatus[provider] = {
            hasKey: true,
            updatedAt: (result && result.updatedAt) || Date.now(),
        };
    } catch (err) {
        console.error(`Failed to persist API key for ${provider}:`, err);
        // Resync so the optimistic hasKey doesn't mislead about what's saved.
        try {
            hydrateApiKeyStatus(await API.apiKeys.list());
        } catch (refetchErr) {
            console.error('Failed to refetch apiKeyStatus:', refetchErr);
        }
        displayError(err, { action: `save your ${provider} API key` });
    }
    renderModelsCatalog();
    refreshAddModelModal(); // the key popover can be opened from inside the modal
    updateSendButtonState();
}

/**
 * Explicit user-initiated delete of a provider's stored API key (from the
 * provider key popover). Confirms first because it's destructive.
 * @param {string} provider
 */
async function clearStoredApiKey(provider) {
    if (!provider || !state.apiKeyStatus[provider]?.hasKey) return;

    const ok = await confirmDialog({
        title: 'Clear stored API key?',
        body: `Your saved ${provider} key will be removed from the server. You'll need to re-enter it before you can chat.`,
        confirmLabel: 'Clear key',
        danger: true,
    });
    if (!ok) return;

    try {
        await API.apiKeys.delete(provider);
    } catch (err) {
        console.error(`Failed to delete API key for ${provider}:`, err);
        displayError(err, { action: 'clear the saved key' });
        return;
    }

    state.apiKeyStatus[provider] = { hasKey: false, updatedAt: Date.now() };
    renderModelsCatalog(); // refresh the group-header badge + chip dot
    refreshAddModelModal();
    updateSendButtonState();
}

/**
 * Persist non-API-key settings (avatar prefs, customModels) AND the active
 * persona. Fire-and-forget; the auto-save debounce coalesces frequent edits.
 */
function persistSettings() {
    const settingsPayload = {
        avatarSize: state.settings.avatarSize,
        avatarPosition: state.settings.avatarPosition,
        showAvatar: state.settings.showAvatar,
        activeFileTurns: state.settings.activeFileTurns,
        customModels: state.settings.customModels,
        currentModelConfig: state.currentModelConfig, // the active layer (WR-12)
        catalogProviders: state.settings.catalogProviders, // Models catalog filter
    };
    API.settings.update(settingsPayload).catch(err => {
        console.error('Failed to persist settings:', err);
    });
    // Persona edits ride along on the same auto-save tick.
    if (getActivePersona()) {
        savePersonas();
    }
    updateSettingsUI();
}

/**
 * Update only settings-related UI elements (not conversation)
 * Used by auto-save to avoid re-rendering messages and causing flicker
 */
function updateSettingsUI() {
    const persona = getActivePersona();

    // Update header with assistant name
    const headerName = document.querySelector('.assistant-name');
    if (headerName) {
        headerName.textContent = persona ? persona.name : CONFIG.defaults.assistantName;
    }

    // Update model display
    const modelDisplay = document.querySelector('.model-display');
    if (modelDisplay) {
        const modelConfig = getActiveModelConfig();
        modelDisplay.textContent = modelConfig.model;
    }

    // Update status bar
    updateStatusBar();

    // Keep the Models catalog's key badges current while it's open (e.g. a
    // key was just typed — the optimistic hasKey update lands on this path).
    if ((state.ui.mainView || {}).type === 'models') renderModelsCatalog();
}

/**
 * Persist conversation metadata for the active conversation (title, personaId).
 * Fire-and-forget. Per-message persistence is NOT handled here — see
 * persistMessage() for that path. Most call sites just want "I tweaked the
 * conversation; flush it" and that's what this does.
 */
function saveConversations() {
    const id = state.activeConversationId;
    if (!id) return;
    const convo = state.conversations[id];
    if (!convo) return;
    API.conversations.update(id, {
        title: convo.title,
        personaId: convo.personaId,
    }).catch(err => {
        console.error(`Failed to persist conversation ${id}:`, err);
    });
}

/**
 * Persist a single new message to the server. Returns the server-augmented
 * message (with the server-generated id) so callers can update state.
 * Throws on failure — the caller can decide whether to surface the error.
 */
async function persistMessage(conversationId, message) {
    return await API.messages.create(conversationId, {
        role: message.role,
        content: message.content,
        attachments: message.attachments || [],
        ...(message.model ? { model: message.model } : {}),
    });
}

// ===== UI Updates =====
async function updateUI() {
    const persona = getActivePersona();
    const modelConfig = getActiveModelConfig();

    // The active model/provider live on the layer; the old provider/model
    // <select>s and API-key field are gone (Slice 4). Switching is via catalog
    // cards; the key is provider-owned. Just keep the layer pointing at a valid
    // model (fall back if the active one was removed from its provider).
    ensureActiveModelValid();
    elements.assistantName.value = persona ? persona.name : CONFIG.defaults.assistantName;
    elements.personaTagline.value = persona ? (persona.tagline || '') : '';
    elements.personaRoleLabel.value = persona ? (persona.roleLabel || '') : '';
    syncPersonaFieldCounters();
    elements.systemPrompt.value = persona ? persona.systemPrompt : CONFIG.defaults.systemPrompt;
    elements.showAvatar.checked = state.settings.showAvatar;
    if (elements.activeFileTurns) elements.activeFileTurns.value = state.settings.activeFileTurns;

    // Model params are shown/edited in the per-model detail view (Slice 5), not
    // a static section here — nothing to load into on a general updateUI.

    // Reflect avatar size (presets + slider) and position (presets) into the UI.
    syncAvatarSizeControls();
    syncAvatarPositionControls();

    // Reflect appearance prefs (theme / accent / chat width) into the controls.
    syncAppearanceControls();

    // Reflect the active persona's model-settings mode (persona editor toggle).
    syncPersonaModelModeControls();
    // Reflect the persona's file-tools base default + the composer toggle
    // (effective state depends on both persona base and per-chat override).
    syncPersonaToolsBaseControl();
    syncToolsToggle();

    // Keep the Models catalog current (Active badge, key badges) while open.
    if ((state.ui.mainView || {}).type === 'models') renderModelsCatalog();

    // Update header
    elements.headerAssistantName.textContent = persona ? persona.name : CONFIG.defaults.assistantName;
    setModelIndicator(getModelDisplayName(modelConfig.model));
    syncPersonaEditTitle();

    // Reflect the active workspace in the top-bar chip + sidebar scope.
    updateWorkspaceUI();

    // Update avatar preview in settings (async - loads from IndexedDB)
    await updateAvatarPreview();

    // Update floating avatar (async - loads from IndexedDB)
    await updateFloatingAvatar();

    // Update avatar toggle button
    elements.avatarToggleBtn.classList.toggle('active', state.settings.showAvatar);

    // Update status bar
    updateStatusBar();

    // Update expression list (async - loads from IndexedDB)
    await renderExpressionList();

    // Update send button state
    updateSendButtonState();

    // Render conversation
    renderConversation();

    // Update sidebar lists
    renderConversationList();
}

// ===== Per-model detail view (Models tab redesign, Slice 5) =====
// The static Advanced Settings section is gone. A model's params are edited in a
// descriptor-driven detail view rendered from PROVIDERS[provider].params — the
// first real consumer of the param-descriptor engine set up in Slice 1. Provider
// alignment is by omission (a provider lists fewer descriptors); showWhen gates
// dependent params (Anthropic thinking budget, Gemini thinking mode); enableKey
// is the per-param on/off override for temp/topP/topK.

/** Read a value from a params bag by descriptor path ('temperature' or 'google.x'). */
function getParamByPath(params, path) {
    if (!path.includes('.')) return params[path];
    const [ns, key] = path.split('.');
    return (params[ns] || {})[key];
}

/** Write a value into a params bag by descriptor path, creating the namespace. */
function setParamByPath(params, path, value) {
    if (!path.includes('.')) { params[path] = value; return; }
    const [ns, key] = path.split('.');
    if (!params[ns]) params[ns] = {};
    params[ns][key] = value;
}

/** A descriptor is visible unless its showWhen dependency isn't met. */
function paramVisible(d, params) {
    if (!d.showWhen) return true;
    return getParamByPath(params, d.showWhen.path) === d.showWhen.eq;
}

/** Find a provider's descriptor by path. */
function descByPath(provider, path) {
    return (PROVIDERS[provider]?.params || []).find(d => d.path === path) || null;
}

/** Format a numeric value for display (2 dp for fractional ranges, else integer). */
function fmtParamValue(v, d) {
    if (d && d.control === 'range' && d.step && d.step < 1) return Number(v).toFixed(2);
    return String(v);
}

/**
 * The editable params object for a model. For the active model it's the live
 * layer (edits take effect immediately); otherwise it's the model's stored
 * profile (seeded from defaults on first edit). Returns null if the model isn't
 * in the catalog.
 */
function getModelParamsForEdit(provider, modelId) {
    const layer = getActiveModelConfig();
    if (layer.provider === provider && layer.model === modelId) return layer.modelParams;
    const entry = getCatalogEntry(provider, modelId);
    if (!entry) return null;
    if (!entry.params) entry.params = JSON.parse(JSON.stringify(getDefaultModelConfig().modelParams));
    return entry.params;
}

/** Render one param control from its descriptor + current value. */
function renderParamControl(d, params) {
    const raw = getParamByPath(params, d.path);
    const v = raw === undefined ? d.default : raw;
    const enabled = d.enableKey ? (getParamByPath(params, d.enableKey) !== false) : true;
    const p = escapeHtml(d.path);
    const label = escapeHtml(d.label) + (d.unit ? ` <span class="param-unit">(${escapeHtml(d.unit)})</span>` : '');
    const enableBox = d.enableKey
        ? `<input type="checkbox" class="param-enable" data-enable="${escapeHtml(d.enableKey)}" ${enabled ? 'checked' : ''}> `
        : '';
    const help = d.help ? `<p class="param-help">${escapeHtml(d.help)}</p>` : '';
    const dis = enabled ? '' : 'disabled';
    let control = '';
    switch (d.control) {
        case 'range':
            control = `<div class="param-row">
                <div class="param-label">${enableBox}${label}<span class="param-val" data-valfor="${p}">${fmtParamValue(v, d)}</span></div>
                <input type="range" data-path="${p}" min="${d.min}" max="${d.max}" step="${d.step || 1}" value="${v}" ${dis}>
            </div>`;
            break;
        case 'number':
            control = `<div class="param-row param-row-inline">
                <div class="param-label">${enableBox}${label}</div>
                <input type="number" data-path="${p}" ${d.min !== undefined ? `min="${d.min}"` : ''} ${d.max !== undefined ? `max="${d.max}"` : ''} value="${v}" ${dis}>
            </div>`;
            break;
        case 'toggle':
            control = `<div class="param-row param-row-inline">
                <label class="param-label"><input type="checkbox" data-path="${p}" ${v ? 'checked' : ''}> ${label}</label>
            </div>`;
            break;
        case 'select': {
            const opts = (d.options || []).map(o => {
                const ov = typeof o === 'string' ? o : o.value;
                const ol = typeof o === 'string' ? (o.charAt(0).toUpperCase() + o.slice(1)) : o.label;
                return `<option value="${escapeHtml(ov)}" ${ov === v ? 'selected' : ''}>${escapeHtml(ol)}</option>`;
            }).join('');
            control = `<div class="param-row param-row-inline">
                <div class="param-label">${label}</div>
                <select data-path="${p}">${opts}</select>
            </div>`;
            break;
        }
        case 'textarea':
            control = `<div class="param-row">
                <div class="param-label">${label}</div>
                <textarea data-path="${p}" rows="3" placeholder="Text to start the reply with…">${escapeHtml(v || '')}</textarea>
            </div>`;
            break;
        case 'tags': {
            const tags = (Array.isArray(v) ? v : []).map((t, i) =>
                `<span class="param-tag" data-tagindex="${i}">${escapeHtml(t)}<span class="param-tag-x">×</span></span>`).join('');
            control = `<div class="param-row">
                <div class="param-label">${label}</div>
                <div class="param-tags" data-tagsfor="${p}">${tags}</div>
                <input type="text" class="param-tag-input" data-tagsinput="${p}" placeholder="Type and press Enter">
            </div>`;
            break;
        }
    }
    return control + help;
}

/**
 * Render the per-model detail view into #modelDetailPanel: header (back, name,
 * id, Active/Use), then Sampling and Behaviour groups built from the provider's
 * visible descriptors (Safety folded into a collapsible subgroup).
 */
function renderModelDetail(provider, modelId) {
    const panel = document.getElementById('modelDetailPanel');
    if (!panel) return;
    const meta = PROVIDERS[provider];
    const entry = getCatalogEntry(provider, modelId);
    if (!meta || !entry) { navigate({ type: 'models' }); return; }
    const layer = getActiveModelConfig();
    const isActive = layer.provider === provider && layer.model === modelId;
    const params = getModelParamsForEdit(provider, modelId);

    const visible = meta.params.filter(d => paramVisible(d, params));
    let html = `
        <div class="model-detail-head">
            <button class="back-link" id="modelDetailBack" type="button">‹ Models</button>
            <div class="model-detail-title">
                <span class="model-detail-name">${escapeHtml(entry.name)}</span>
                ${isActive ? '<span class="persona-card-badge">Active</span>'
                           : '<button class="modal-btn primary" id="modelDetailUse" type="button">Use this model</button>'}
            </div>
            <p class="model-detail-sub">${escapeHtml(entry.id)} · ${escapeHtml(meta.label)}</p>
        </div>`;

    for (const [group, gLabel] of [['sampling', 'Sampling'], ['behaviour', 'Behaviour']]) {
        const descs = visible.filter(d => d.group === group);
        if (descs.length === 0) continue;
        html += `<div class="param-group-title">${gLabel}</div><div class="param-card">`;
        descs.filter(d => !d.subgroup).forEach(d => html += renderParamControl(d, params));
        const subs = [...new Set(descs.filter(d => d.subgroup).map(d => d.subgroup))];
        subs.forEach(sub => {
            html += `<details class="param-subgroup"><summary>${escapeHtml(sub.charAt(0).toUpperCase() + sub.slice(1))}</summary>`;
            descs.filter(d => d.subgroup === sub).forEach(d => html += renderParamControl(d, params));
            html += `</details>`;
        });
        html += `</div>`;
    }
    panel.innerHTML = html;

    document.getElementById('modelDetailBack').addEventListener('click', () => navigate({ type: 'models' }));
    const useBtn = document.getElementById('modelDetailUse');
    if (useBtn) useBtn.addEventListener('click', () => { selectModel(modelId, provider); renderModelsView(); });
    wireParamControls(panel, provider, modelId, params, isActive);
}

/**
 * Attach change handlers to a detail view's controls. Every edit writes through
 * the descriptor path into the params bag, then persists (debounced via
 * autoSaveSettings, which mirrors the active layer to its profile). Controls
 * that can change what's visible/enabled (selects, toggles, enable boxes, tags)
 * re-render the view; value-only controls (range/number/textarea) update live.
 */
function wireParamControls(panel, provider, modelId, params, isActive) {
    const commit = () => autoSaveSettings();
    const rerender = () => renderModelDetail(provider, modelId);

    panel.querySelectorAll('input[type=range][data-path]').forEach(inp =>
        inp.addEventListener('input', () => {
            setParamByPath(params, inp.dataset.path, parseFloat(inp.value));
            const disp = panel.querySelector(`.param-val[data-valfor="${inp.dataset.path}"]`);
            if (disp) disp.textContent = fmtParamValue(parseFloat(inp.value), descByPath(provider, inp.dataset.path));
            commit();
        }));
    panel.querySelectorAll('input[type=number][data-path]').forEach(inp =>
        inp.addEventListener('input', () => {
            const n = parseFloat(inp.value);
            setParamByPath(params, inp.dataset.path, Number.isFinite(n) ? n : 0);
            commit();
        }));
    panel.querySelectorAll('input[type=checkbox][data-path]').forEach(inp =>
        inp.addEventListener('change', () => {
            setParamByPath(params, inp.dataset.path, inp.checked);
            commit(); rerender();
        }));
    panel.querySelectorAll('.param-enable[data-enable]').forEach(inp =>
        inp.addEventListener('change', () => {
            setParamByPath(params, inp.dataset.enable, inp.checked);
            commit(); rerender();
        }));
    panel.querySelectorAll('select[data-path]').forEach(sel =>
        sel.addEventListener('change', () => {
            setParamByPath(params, sel.dataset.path, sel.value);
            commit(); rerender();
        }));
    panel.querySelectorAll('textarea[data-path]').forEach(ta =>
        ta.addEventListener('input', () => {
            setParamByPath(params, ta.dataset.path, ta.value);
            commit();
        }));
    panel.querySelectorAll('.param-tag-input[data-tagsinput]').forEach(inp =>
        inp.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || !inp.value.trim()) return;
            e.preventDefault();
            const path = inp.dataset.tagsinput;
            const arr = [...(getParamByPath(params, path) || [])];
            if (!arr.includes(inp.value.trim())) arr.push(inp.value.trim());
            setParamByPath(params, path, arr);
            commit(); rerender();
        }));
    panel.querySelectorAll('.param-tags .param-tag').forEach(tag =>
        tag.addEventListener('click', () => {
            const path = tag.closest('[data-tagsfor]').dataset.tagsfor;
            const arr = [...(getParamByPath(params, path) || [])];
            arr.splice(parseInt(tag.dataset.tagindex, 10), 1);
            setParamByPath(params, path, arr);
            commit(); rerender();
        }));
}

/**
 * Models view dispatcher: the catalog (chips + cards) or a single model's detail
 * view, chosen by state.ui.mainView.detail.
 */
function renderModelsView() {
    const catPanel = document.getElementById('modelsCatalogPanel');
    const detPanel = document.getElementById('modelDetailPanel');
    if (!catPanel || !detPanel) return;
    const detail = (state.ui.mainView || {}).detail;
    if (detail) {
        catPanel.hidden = true;
        detPanel.hidden = false;
        renderModelDetail(detail.provider, detail.model);
    } else {
        detPanel.hidden = true;
        catPanel.hidden = false;
        renderModelsCatalog();
    }
}

function updateAvatarPreview() {
    const preview = elements.avatarPreview;
    const name = elements.avatarPreviewName;
    const tagline = elements.avatarPreviewTagline;
    const status = elements.avatarPreviewStatus;
    const persona = getActivePersona();

    name.textContent = persona ? persona.name : CONFIG.defaults.assistantName;
    tagline.textContent = persona ? (persona.tagline || '') : '';

    if (persona && persona.avatarFilename) {
        // Cache-bust on updatedAt so re-uploads are immediately visible.
        const url = `${API.avatars.getUrl(persona.id)}?v=${persona.updatedAt || 0}`;
        preview.innerHTML = `<img src="${url}" alt="Avatar">`;
        status.textContent = 'Custom Avatar';
    } else {
        preview.textContent = '🤖';
        status.textContent = 'Default Avatar';
    }
}

/**
 * Refresh the "n/max" counters next to the tagline and role inputs. Both are
 * capped by `maxlength` on the input, so this only reports — it never trims.
 */
function syncPersonaFieldCounters() {
    const pairs = [
        [elements.personaTagline, elements.personaTaglineCount],
        [elements.personaRoleLabel, elements.personaRoleLabelCount],
    ];
    for (const [input, counter] of pairs) {
        if (!input || !counter) continue;
        counter.textContent = `${input.value.length}/${input.maxLength}`;
    }
}

// ===== Floating avatar size/position (named presets OR free values) =====
// avatarSize: a preset name OR a numeric px string. avatarPosition: a corner
// preset OR "x,y" where x,y are 0..100 fractions of the AVAILABLE travel
// (chat area minus the avatar), so a synced free position stays in-bounds
// across different screen sizes.
const AVATAR_PRESET_PX = { small: 80, medium: 120, large: 180, xlarge: 240 };
const AVATAR_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const AVATAR_SIZE_MIN = 32;
const AVATAR_SIZE_MAX = 480;
const AVATAR_FONT_RATIO = 0.025; // px → rem for the emoji (120px → 3rem, matches presets)

function isAvatarPreset(size) {
    return Object.prototype.hasOwnProperty.call(AVATAR_PRESET_PX, size);
}
function isAvatarCorner(pos) {
    return AVATAR_CORNERS.includes(pos);
}
function avatarSizeToPx(size) {
    if (isAvatarPreset(size)) return AVATAR_PRESET_PX[size];
    const n = parseInt(size, 10);
    if (!Number.isFinite(n)) return AVATAR_PRESET_PX.medium;
    return Math.max(AVATAR_SIZE_MIN, Math.min(AVATAR_SIZE_MAX, n));
}
function parseAvatarFreePos(pos) {
    if (typeof pos !== 'string') return null;
    const parts = pos.split(',');
    if (parts.length !== 2) return null;
    const x = parseFloat(parts[0]);
    const y = parseFloat(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) };
}

function applyAvatarSize(image, size) {
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

function applyAvatarPosition(avatar, pos) {
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
function syncAvatarSizeControls() {
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
function syncAvatarPositionControls() {
    const pos = state.settings.avatarPosition;
    document.querySelectorAll('.position-preset-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.position === pos);
    });
}

// ===== Avatar display setters =====
// Shared by the Settings "Avatar Display" controls and the top-bar avatar
// popover (WR-10). The sync helpers above match buttons by class, so both
// UIs stay consistent whichever one made the change.

async function setAvatarSize(size) {
    state.settings.avatarSize = size;
    syncAvatarSizeControls();
    await updateFloatingAvatar();
    autoSaveSettings();
}

async function setAvatarPosition(pos) {
    state.settings.avatarPosition = pos;
    syncAvatarPositionControls();
    await updateFloatingAvatar();
    autoSaveSettings();
}

async function setShowAvatar(show) {
    state.settings.showAvatar = show;
    elements.showAvatar.checked = show;
    await updateFloatingAvatar();
    elements.avatarToggleBtn.classList.toggle('active', show);
    autoSaveSettings();
}

// Drag the floating avatar (by its frame) to position it freely within the
// chat area. The result is stored as "x,y" % of available travel and saved.
function setupAvatarDrag() {
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

async function updateFloatingAvatar() {
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

// Slimmed to tokens only (WR-10): mood is the avatar itself, and the message
// count / session timer never informed a decision.
function updateStatusBar() {
    elements.statusTokens.textContent = `~${formatNumber(state.estimatedTokens)}`;
}

function formatNumber(num) {
    if (num >= 1000) {
        return (num / 1000).toFixed(1) + 'k';
    }
    return num.toString();
}

function getModelDisplayName(modelId) {
    if (!modelId) return 'No model selected';

    // Look up in custom models for current persona's provider
    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;
    const providerModels = state.settings.customModels[provider] || [];
    const customModel = providerModels.find(m => m.id === modelId);
    if (customModel) {
        return customModel.name;
    }

    // Fallback to model ID
    return modelId;
}

/**
 * Display name for a per-message model tag (WR-14). Unlike
 * getModelDisplayName it searches EVERY provider's catalog — an old message
 * may have been generated under a different provider than the active one.
 */
function modelTagLabel(modelId) {
    for (const models of Object.values(state.settings.customModels)) {
        const m = (models || []).find(x => x.id === modelId);
        if (m) return m.name;
    }
    return modelId; // removed from the catalog — show the raw id
}

function updateSendButtonState() {
    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;
    const hasApiKey = !!state.apiKeyStatus[provider]?.hasKey;
    const hasMessage = elements.messageInput.value.trim().length > 0;
    const hasAttachments = state.pendingAttachments.length > 0;
    const notLoading = !state.isLoading;

    elements.sendButton.disabled = !(hasApiKey && (hasMessage || hasAttachments) && notLoading);
}

// ===== Expression Management =====
/**
 * Render the persona's expression set as a grid of face tiles. Image-first:
 * the art is the point, so each slot shows the actual expression image at a
 * size you can judge, reusing the persona-card portrait language. Slots with
 * no image show their emoji and read as "unfilled" so gaps are obvious.
 */
async function renderExpressionList() {
    const list = elements.expressionList;
    list.innerHTML = '';

    const persona = getActivePersona();
    const expressions = persona ? persona.expressions : CONFIG.defaultExpressions;

    const cacheBust = persona && persona.updatedAt ? `?v=${persona.updatedAt}` : '';
    const avatarUrl = persona && persona.avatarFilename
        ? `${API.avatars.getUrl(persona.id)}${cacheBust}`
        : null;
    for (const [name, expr] of Object.entries(expressions)) {
        const hasImage = !!(persona && expr.imageKey);
        // Three states worth distinguishing visually: has its own art, falls
        // back to the avatar + badge, or is a genuinely empty slot (dashed).
        const fallbackClass = hasImage ? '' : (avatarUrl ? ' fallback-avatar' : ' no-image');
        const item = document.createElement('div');
        item.className = `expression-slot${fallbackClass}`;
        item.setAttribute('role', 'button');
        item.tabIndex = 0;
        item.title = `Edit "${name}"`;
        item.onclick = () => openExpressionModal(name);
        item.onkeydown = (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openExpressionModal(name);
            }
        };

        // Mirrors exactly what the chat will render for this expression:
        // its own art if it has any, otherwise the default avatar wearing the
        // emoji as a mood badge, otherwise the bare emoji.
        let face;
        if (hasImage) {
            face = `<img src="${API.avatars.getExpressionUrl(persona.id, name)}${cacheBust}" alt="${escapeHtml(name)}">`;
        } else if (avatarUrl) {
            face = `<img src="${avatarUrl}" alt="${escapeHtml(name)}">
                    <span class="expression-slot-badge">${expr.emoji || '🙂'}</span>`;
        } else {
            face = `<span class="expression-slot-emoji">${expr.emoji || '🙂'}</span>`;
        }

        item.innerHTML = `
            <div class="expression-slot-face">${face}</div>
            <span class="expression-slot-name">${escapeHtml(name)}</span>
            ${name === CONFIG.generatingExpression ? '<span class="expression-slot-tag">auto</span>' : ''}
        `;

        list.appendChild(item);
    }
}

let editingExpression = null;

async function openExpressionModal(name = null) {
    editingExpression = name;

    // Reset temp state
    if (state.tempExpressionPreviewUrl) {
        URL.revokeObjectURL(state.tempExpressionPreviewUrl);
    }
    state.tempExpressionBlob = null;
    state.tempExpressionPreviewUrl = '';
    state.tempExpressionCleared = false;

    const persona = getActivePersona();
    const expressions = persona ? persona.expressions : {};

    if (name && expressions[name]) {
        const expr = expressions[name];
        elements.expressionModalTitle.textContent = 'Edit Expression';
        elements.expressionName.value = name;
        elements.expressionEmoji.value = expr.emoji;
        // The generating slot is the UI's own state, not a declarable mood —
        // its art is editable but the slot itself can't be removed.
        elements.deleteExpressionBtn.style.display =
            name === CONFIG.generatingExpression ? 'none' : 'block';

        // Server URL for the expression image (cache-busted).
        if (persona && expr.imageKey) {
            const cacheBust = persona.updatedAt ? `?v=${persona.updatedAt}` : '';
            const imageUrl = `${API.avatars.getExpressionUrl(persona.id, name)}${cacheBust}`;
            elements.expressionImagePreview.innerHTML = `<img src="${imageUrl}" alt="${name}">`;
        } else {
            elements.expressionImagePreview.innerHTML = '<span class="preview-placeholder">No image</span>';
        }
    } else {
        elements.expressionModalTitle.textContent = 'Add Expression';
        elements.expressionName.value = '';
        elements.expressionEmoji.value = '';
        elements.deleteExpressionBtn.style.display = 'none';
        elements.expressionImagePreview.innerHTML = '<span class="preview-placeholder">No image</span>';
    }

    elements.expressionModal.classList.add('visible');
}

function closeExpressionModal() {
    elements.expressionModal.classList.remove('visible');
    editingExpression = null;

    // Clean up temp resources
    if (state.tempExpressionPreviewUrl) {
        URL.revokeObjectURL(state.tempExpressionPreviewUrl);
    }
    state.tempExpressionBlob = null;
    state.tempExpressionPreviewUrl = '';
    state.tempExpressionCleared = false;
}

async function saveExpression() {
    const name = elements.expressionName.value.trim().toLowerCase();
    const emoji = elements.expressionEmoji.value.trim() || '😊';

    if (!name) {
        showToast('Please enter an expression name', { type: 'warning' });
        return;
    }
    // The name is interpolated into the model's expression protocol AND used as
    // a filename + URL segment by the avatar routes, so all three agree on this
    // charset. No spaces: the image endpoints reject them, which would leave the
    // expression permanently unable to hold art.
    if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(name)) {
        showToast('Use letters, numbers, - or _ (no spaces, max 31 characters)', { type: 'warning' });
        return;
    }
    if (name === CONFIG.generatingExpression && editingExpression !== CONFIG.generatingExpression) {
        showToast(`"${CONFIG.generatingExpression}" is reserved for the working-on-it state`, { type: 'warning' });
        return;
    }

    const persona = getActivePersona();
    if (!persona) {
        showToast('No active persona', { type: 'warning' });
        return;
    }

    const oldExpr = editingExpression ? persona.expressions[editingExpression] : null;
    const oldImageKey = oldExpr?.imageKey || '';
    const isRename = editingExpression && editingExpression !== name;

    // Build the new expressions object. imageKey is preserved from the old
    // entry unless the user uploaded a new image, cleared it, or renamed
    // (rename-with-image is not preserved in this iteration — user re-uploads).
    const newExpressions = { ...persona.expressions };
    if (isRename) delete newExpressions[editingExpression];
    const initialImageKey = state.tempExpressionCleared
        ? ''
        : (state.tempExpressionBlob || isRename ? '' : oldImageKey);
    newExpressions[name] = { emoji, imageKey: initialImageKey };

    try {
        // 1. Push the metadata change.
        await API.personas.update(persona.id, { expressions: newExpressions });

        // 2. Image-side operations.
        if (state.tempExpressionBlob) {
            const file = new File([state.tempExpressionBlob], `${name}.png`, {
                type: state.tempExpressionBlob.type || 'image/png',
            });
            await API.avatars.uploadExpression(persona.id, name, file);
        }
        if (isRename && oldImageKey) {
            // Old expression renamed; clean up its image file. (We don't
            // preserve it across rename — would require download + re-upload.)
            try {
                await API.avatars.deleteExpression(persona.id, editingExpression);
            } catch (e) { /* file may already be gone — non-fatal */ }
        } else if (state.tempExpressionCleared && oldImageKey) {
            await API.avatars.deleteExpression(persona.id, name);
        }

        // 3. Refetch persona so local state matches server's authoritative
        // imageKey values for each expression.
        const fresh = await API.personas.get(persona.id);
        state.personas[fresh.id] = {
            ...state.personas[fresh.id],
            ...fresh,
            expressions: (fresh.expressions && typeof fresh.expressions === 'object')
                ? fresh.expressions
                : newExpressions,
        };
    } catch (err) {
        console.error('Failed to save expression:', err);
        displayError(err, { action: 'save expression' });
        return;
    }

    await renderExpressionList();
    closeExpressionModal();
    await updateFloatingAvatar();
    updateSystemPromptExpressions();
}

async function deleteExpression() {
    if (!editingExpression) return;

    const persona = getActivePersona();
    if (!persona) return;

    if (Object.keys(persona.expressions).length <= 1) {
        showToast('You must have at least one expression', { type: 'warning' });
        return;
    }

    // Pin the name: confirming is async now, so don't trust the module-level
    // `editingExpression` to still point at the same thing afterwards.
    const name = editingExpression;
    const expr = persona.expressions[name];

    const ok = await confirmDialog({
        title: 'Delete expression?',
        body: expr?.imageKey
            ? `"${name}" and its uploaded image will be removed from this persona. This can't be undone.`
            : `"${name}" will be removed from this persona. This can't be undone.`,
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;

    // Local optimistic delete.
    const newExpressions = { ...persona.expressions };
    delete newExpressions[name];

    try {
        // 1. Persist expression-set change.
        await API.personas.update(persona.id, { expressions: newExpressions });
        // 2. Drop the server-side image file too (best-effort).
        if (expr?.imageKey) {
            try {
                await API.avatars.deleteExpression(persona.id, name);
            } catch (e) { /* file may already be gone — non-fatal */ }
        }
        // 3. Sync local state with the result.
        persona.expressions = newExpressions;
        persona.updatedAt = Date.now();
    } catch (err) {
        console.error('Failed to delete expression:', err);
        displayError(err, { action: 'delete expression' });
        return;
    }

    await renderExpressionList();
    closeExpressionModal();
}

function updateSystemPromptExpressions() {
    // This could automatically update the system prompt with available expressions
    // For now, we'll leave it manual since users customize their prompts
}

// ===== Model Management =====

/**
 * Fetch the available models from a provider's API. Not every provider offers a
 * list endpoint — the server throws VALIDATION_ERROR for one whose module has no
 * listModels(), which surfaces as a normal error toast.
 * @param {string} provider
 * @returns {Promise<Array>} Array of { id, display_name } objects
 */
async function fetchAvailableModels(provider) {
    if (!state.apiKeyStatus[provider]?.hasKey) {
        throw new Error('API key required to fetch models');
    }

    // Server proxies the request using the user's stored key and returns the
    // provider's raw model list. Different providers have slightly different
    // shapes (Anthropic: { id, display_name }; Gemini: { id, name, ... }) —
    // normalize for the existing renderer.
    const list = await API.models.list(provider);
    return list.map(m => ({
        id: m.id,
        display_name: m.display_name || m.displayName || m.name || m.id,
    }));
}

/**
 * Add a custom model to a provider's catalog.
 * @param {string} id - The model ID
 * @param {string} name - The display name
 * @param {string} provider - The provider that owns the model
 * @returns {boolean} True if added, false if already exists
 */
function addCustomModel(id, name, provider) {
    if (!id || !name || !provider) return false;

    const providerModels = state.settings.customModels[provider];
    if (!providerModels) return false;

    // Check if already exists
    const exists = providerModels.some(m => m.id === id);
    if (exists) return false;

    providerModels.push({ id, name });
    saveCustomModels();
    return true;
}

/**
 * Remove a custom model from its provider's catalog.
 * @param {string} id - The model ID to remove
 * @param {string} provider - The provider that owns it (the catalog card knows it)
 */
function removeCustomModel(id, provider) {
    const modelConfig = getActiveModelConfig();
    const providerModels = state.settings.customModels[provider];
    if (!providerModels) return;
    const index = providerModels.findIndex(m => m.id === id);
    if (index === -1) return;

    providerModels.splice(index, 1);
    saveCustomModels();

    // If the removed model was the layer's selected one, fall back
    if (modelConfig.provider === provider && modelConfig.model === id) {
        modelConfig.model = providerModels.length > 0 ? providerModels[0].id : '';
        loadModelProfileIntoLayer();
        updateFixedPersonaPin();
        persistSettings();
    }
}

/**
 * Save custom models to storage
 */
/**
 * Persist customModels via /api/settings (it lives under settings server-side).
 * Fire-and-forget.
 */
function saveCustomModels() {
    API.settings.update({ customModels: state.settings.customModels }).catch(err => {
        console.error('Failed to persist custom models:', err);
    });
}

/**
 * Safety net (formerly folded into the model dropdown, removed in Slice 4): if
 * the active layer points at a model no longer in its provider's catalog — e.g.
 * it was removed while active — fall back to the provider's first model and load
 * that model's profile so its params come along. No-op when the active model is
 * valid or the provider has no models. The ensuing updateUI refreshes the
 * indicator, params UI, and catalog.
 */
function ensureActiveModelValid() {
    const modelConfig = getActiveModelConfig();
    const providerModels = state.settings.customModels[modelConfig.provider] || [];
    if (providerModels.length === 0) return;
    if (!providerModels.some(m => m.id === modelConfig.model)) {
        modelConfig.model = providerModels[0].id;
        loadModelProfileIntoLayer();
    }
}

/**
 * Refresh UI after the model catalog changes from the modal (add/remove): keep
 * the active model valid, then refresh the Models catalog, the model indicator,
 * and the send button. Replaces the old populateModelDropdown() refresh now that
 * the dropdown is gone (Slice 4).
 */
function refreshAfterModelChange() {
    ensureActiveModelValid();
    renderModelsCatalog();
    setModelIndicator(getModelDisplayName(getActiveModelConfig().model));
    updateSendButtonState();
}

/**
 * Render available models grid after fetching from API
 * @param {Array} models - Array of { id, display_name } from API
 * @param {string} provider - The provider they were fetched from
 */
function renderAvailableModelsGrid(models, provider) {
    const grid = elements.availableModelsGrid;
    const providerModels = state.settings.customModels[provider] || [];
    grid.innerHTML = '';
    grid.style.display = 'grid';

    if (models.length === 0) {
        grid.innerHTML = '<p class="help-text">No models available</p>';
        return;
    }

    models.forEach(model => {
        const alreadyAdded = providerModels.some(m => m.id === model.id);
        const card = document.createElement('div');
        card.className = `available-model-card ${alreadyAdded ? 'already-added' : ''}`;
        card.innerHTML = `
            <span class="available-model-name">${model.display_name}</span>
            <span class="available-model-id">${model.id}</span>
            <button class="add-available-model-btn" data-model-id="${model.id}" data-model-name="${model.display_name}" ${alreadyAdded ? 'disabled' : ''}>
                ${alreadyAdded ? 'Added' : '+ Add'}
            </button>
        `;
        grid.appendChild(card);
    });

    // Add click listeners for add buttons
    grid.querySelectorAll('.add-available-model-btn:not([disabled])').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const modelId = e.target.dataset.modelId;
            const modelName = e.target.dataset.modelName;
            if (addCustomModel(modelId, modelName, provider)) {
                refreshAfterModelChange();
                // Update the button
                e.target.textContent = 'Added';
                e.target.disabled = true;
                e.target.closest('.available-model-card').classList.add('already-added');
            }
        });
    });
}

/**
 * The provider the add-model modal is currently working on. Set from the modal's
 * chip row; every operation in the modal (fetch, manual add) is scoped to it.
 * Before Slice 7 the modal silently used the *active model's* provider, which
 * made adding a model for any other provider unreachable.
 */
let modelModalProvider = null;

/**
 * Provider chips inside the add-model modal — single-select, unlike the
 * catalog's multi-select filter chips (hence `.single` + role=radio).
 * `status: 'soon'` providers are shown but not selectable.
 */
function renderModelModalProviders() {
    const row = elements.modelModalProviders;
    if (!row) return;

    let html = '';
    for (const [id, meta] of Object.entries(PROVIDERS)) {
        const soon = meta.status === 'soon';
        const hasKey = !!state.apiKeyStatus[id]?.hasKey;
        const active = id === modelModalProvider;
        const trailing = soon
            ? '<span class="chip-soon">soon</span>'
            : `<span class="chip-dot${hasKey ? ' has-key' : ''}" title="${hasKey ? 'API key saved' : 'no API key'}"></span>`;
        html += `<button class="provider-chip${active ? ' active' : ''}${soon ? ' soon' : ''}" data-modal-provider="${id}"
                type="button" role="radio" aria-checked="${active}"${soon ? ' disabled' : ''}>
                ${providerIconHtml(id)}<span class="chip-label">${escapeHtml(meta.label)}</span>${trailing}
            </button>`;
    }
    row.innerHTML = html;

    row.querySelectorAll('[data-modal-provider]').forEach(btn =>
        btn.addEventListener('click', () => selectModalProvider(btn.dataset.modalProvider)));

    renderFetchSection();
}

/**
 * Switch the modal to another provider: the fetched grid belongs to the old
 * provider, so it's cleared. The manual-add fields are left alone — a half-typed
 * model id is still valid for the newly picked provider.
 * @param {string} provider
 */
function selectModalProvider(provider) {
    if (!PROVIDERS[provider] || provider === modelModalProvider) return;
    modelModalProvider = provider;
    elements.availableModelsGrid.style.display = 'none';
    elements.availableModelsGrid.innerHTML = '';
    renderModelModalProviders();
}

/**
 * Fetch button + help text for the selected provider. The "not every provider"
 * caveat is literal: the server rejects a provider whose module has no
 * listModels() (see server/src/routes/chat.js).
 */
function renderFetchSection() {
    const provider = modelModalProvider;
    const meta = PROVIDERS[provider];
    const hasKey = !!state.apiKeyStatus[provider]?.hasKey;

    elements.fetchModelsBtn.disabled = !hasKey;
    elements.fetchModelsHelp.innerHTML = hasKey
        ? `Fetches the model list from ${escapeHtml(meta.label)}'s API. Not every provider offers a list endpoint — add the model manually below if this comes up empty.`
        : `No ${escapeHtml(meta.label)} API key saved. Add one to fetch the model list, or add a model manually below.`;

    // "Add key" opens the same provider-key popover the catalog uses. It renders
    // at body level (z-index 1000) above the modal overlay (250), so it stacks.
    elements.modalKeyBtn.hidden = hasKey;
    elements.modalKeyBtn.textContent = `Add ${meta.label} key`;
}

/**
 * Re-render the add-model modal after an API key changed elsewhere (the key
 * popover writes through saveProviderKey/clearStoredApiKey). No-op when closed.
 */
function refreshAddModelModal() {
    if (!elements.modelModal?.classList.contains('visible')) return;
    renderModelModalProviders();
}

/**
 * Open the add-model modal.
 * @param {string} [provider] - Preselect this provider (a catalog group's
 *   "+ Add"); defaults to the active model's provider.
 */
function openModelModal(provider) {
    const preferred = PROVIDERS[provider] && PROVIDERS[provider].status !== 'soon'
        ? provider
        : getActiveModelConfig().provider;
    modelModalProvider = PROVIDERS[preferred] ? preferred : Object.keys(PROVIDERS)[0];

    elements.availableModelsGrid.style.display = 'none';
    elements.availableModelsGrid.innerHTML = '';
    elements.newModelId.value = '';
    elements.newModelName.value = '';
    renderModelModalProviders();

    elements.modelModal.classList.add('visible');
}

/**
 * Close the model management modal
 */
function closeModelModal() {
    elements.modelModal.classList.remove('visible');
}

/**
 * Handle fetch models button click
 */
async function handleFetchModels() {
    const btn = elements.fetchModelsBtn;
    const originalText = btn.textContent;
    // Capture the provider: the user can switch chips while the request is in
    // flight, and the results belong to the provider that was asked.
    const provider = modelModalProvider;

    try {
        btn.disabled = true;
        btn.textContent = 'Fetching...';

        const models = await fetchAvailableModels(provider);
        if (provider !== modelModalProvider) return; // switched away mid-flight
        renderAvailableModelsGrid(models, provider);
    } catch (error) {
        console.error('Failed to fetch models:', error);
        displayError(error, { action: `fetch ${PROVIDERS[provider]?.label || provider} models` });
    } finally {
        btn.disabled = !state.apiKeyStatus[modelModalProvider]?.hasKey;
        btn.textContent = originalText;
    }
}

/**
 * Handle manual add model button click
 */
function handleAddModelManually() {
    const id = elements.newModelId.value.trim();
    const name = elements.newModelName.value.trim();

    if (!id) {
        showToast('Please enter a model ID', { type: 'warning' });
        return;
    }

    if (!name) {
        showToast('Please enter a display name', { type: 'warning' });
        return;
    }

    const provider = modelModalProvider;
    if (addCustomModel(id, name, provider)) {
        refreshAfterModelChange();
        elements.newModelId.value = '';
        elements.newModelName.value = '';
        // The modal no longer lists your models (the catalog does), so say so.
        showToast(`${name} added to ${PROVIDERS[provider]?.label || provider}`);

        // Update available grid if visible
        if (elements.availableModelsGrid.style.display !== 'none') {
            const addedCard = elements.availableModelsGrid.querySelector(`[data-model-id="${id}"]`);
            if (addedCard) {
                addedCard.textContent = 'Added';
                addedCard.disabled = true;
                addedCard.closest('.available-model-card')?.classList.add('already-added');
            }
        }
    } else {
        showToast('Model already exists', { type: 'warning' });
    }
}

// ===== Sidebar Tab Management =====

/**
 * Back-compat shim: the old sidebar tabs ('chats' / 'projects') map to the
 * WR-07 main-area router sections.
 * @param {string} tabName - 'chats' or 'projects'
 */
function switchTab(tabName) {
    navigate({ type: tabName === 'projects' ? 'workspaces' : 'chats' });
}

/**
 * Inner avatar markup (img or emoji) for a persona. Shared by the persona-
 * grouped chat list and the workspace chat rows.
 * @param {Object} persona
 * @returns {string}
 */
function personaAvatarHTML(persona) {
    if (!persona) return `<span class="avatar-emoji">🤖</span>`;
    if (persona.avatarFilename) {
        // Cache-bust by updatedAt so a re-upload is reflected immediately.
        const cacheBust = persona.updatedAt ? `?v=${persona.updatedAt}` : '';
        const imageUrl = `${API.avatars.getUrl(persona.id)}${cacheBust}`;
        return `<img src="${imageUrl}" alt="${escapeHtml(persona.name || '')}">`;
    }
    const firstExpr = Object.values(persona.expressions || {})[0];
    const avatarEmoji = firstExpr?.emoji || '🤖';
    return `<span class="avatar-emoji">${avatarEmoji}</span>`;
}

/**
 * Markup for a single conversation row. `showPersonaAvatar` adds the owning
 * persona's avatar (used in the workspace list where personas are mixed; the
 * home list shows the avatar on the group header instead).
 * @param {Object} convo
 * @param {boolean} showPersonaAvatar
 * @returns {string}
 */
function conversationRowHTML(convo, showPersonaAvatar) {
    const timeAgo = formatTimeAgo(convo.updatedAt || convo.createdAt);
    const active = convo.id === state.activeConversationId ? 'active' : '';
    const avatar = showPersonaAvatar
        ? `<div class="conversation-persona-avatar">${personaAvatarHTML(state.personas[convo.personaId])}</div>`
        : '';
    return `
        <div class="conversation-item ${active}" data-conversation-id="${convo.id}">
            ${avatar}
            <div class="conversation-info" data-conversation-id="${convo.id}">
                <span class="conversation-title">${escapeHtml(convo.title || 'New Chat')}</span>
                <span class="conversation-time">${timeAgo}</span>
            </div>
            <button class="conversation-menu-btn" data-conversation-id="${convo.id}" title="Options">⋯</button>
        </div>
    `;
}

/**
 * Wire click + menu listeners for all conversation rows currently in `container`.
 * @param {HTMLElement} container
 */
function wireConversationRows(container) {
    container.querySelectorAll('.conversation-info').forEach(info => {
        info.addEventListener('click', () => switchConversation(info.dataset.conversationId));
    });
    container.querySelectorAll('.conversation-menu-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            showConversationMenu(btn, btn.dataset.conversationId);
        });
    });
}

/**
 * Refresh the chats list if it's the view currently showing in the main area.
 * (WR-07: the unfiled chat list lives in the main area, not the sidebar; many
 * callers poke this after a conversation mutation, so it no-ops when a different
 * view is open.)
 */
function renderConversationList() {
    if ((state.ui.mainView || {}).type === 'chats') renderChatsListMain();
}

/**
 * Home ("Chats") view: only UNFILED chats — those not in any workspace or
 * project — grouped by persona under collapsible headers ("chats with X").
 * Workspace/project chats live in their own container, never here (Workspace
 * Restructure: a chat appears in exactly one home, no cross-container leakage).
 * The active persona's group sorts first, the rest by most-recent activity.
 * @param {HTMLElement} container
 */
function renderGroupedChatList(container) {
    const all = Object.values(state.conversations)
        .filter(c => !c.projectId && !c.workspaceId);

    if (all.length === 0) {
        container.innerHTML = `<p class="empty-state small">No chats yet. Start a new one above.</p>`;
        return;
    }

    // Group conversations by persona, tracking each group's latest activity.
    const groups = new Map(); // personaId -> { convos: [], latest }
    for (const c of all) {
        const pid = c.personaId || '__none__';
        if (!groups.has(pid)) groups.set(pid, { convos: [], latest: 0 });
        const g = groups.get(pid);
        g.convos.push(c);
        g.latest = Math.max(g.latest, c.updatedAt || c.createdAt || 0);
    }

    // Order: active persona first, then by most-recent activity.
    const ordered = [...groups.entries()].sort((a, b) => {
        if (a[0] === state.activePersonaId) return -1;
        if (b[0] === state.activePersonaId) return 1;
        return b[1].latest - a[1].latest;
    });

    let html = '';
    for (const [pid, g] of ordered) {
        const persona = state.personas[pid];
        const name = persona ? (persona.name || 'Untitled') : 'No persona';
        const collapsed = state.ui.collapsedPersonaGroups.has(pid);
        const rows = g.convos
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            .map(c => conversationRowHTML(c, false))
            .join('');
        html += `
            <div class="persona-group" data-persona-id="${escapeHtml(pid)}">
                <button class="persona-group-header" data-persona-id="${escapeHtml(pid)}" type="button">
                    <svg class="group-chevron ${collapsed ? 'collapsed' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
                    <div class="conversation-persona-avatar">${personaAvatarHTML(persona)}</div>
                    <span class="persona-group-name">${escapeHtml(name)}</span>
                    <span class="persona-group-count">${g.convos.length}</span>
                </button>
                <div class="persona-group-body" ${collapsed ? 'hidden' : ''}>${rows}</div>
            </div>
        `;
    }
    container.innerHTML = html;

    // Collapse/expand on header click.
    container.querySelectorAll('.persona-group-header').forEach(header => {
        header.addEventListener('click', () => {
            const pid = header.dataset.personaId;
            if (state.ui.collapsedPersonaGroups.has(pid)) {
                state.ui.collapsedPersonaGroups.delete(pid);
            } else {
                state.ui.collapsedPersonaGroups.add(pid);
            }
            renderConversationList();
        });
    });

    wireConversationRows(container);
}

/**
 * Switch to a different conversation. Lazy-loads its messages on first
 * access — without this, renderConversation crashes on `messages.length`
 * because hydrateConversations seeds messages=undefined as a "not loaded"
 * sentinel for non-active conversations.
 * @param {string} conversationId
 */
async function switchConversation(conversationId) {
    if (!state.conversations[conversationId]) return;

    state.activeConversationId = conversationId;

    // Track the chat's container so breadcrumb + restore have context.
    const convo = state.conversations[conversationId];
    state.activeProjectId = convo.projectId || null;
    state.activeWorkspaceId = convo.workspaceId || (convo.projectId && state.projects[convo.projectId] ? state.projects[convo.projectId].workspaceId : null) || null;

    // Also switch to the persona that owns this conversation. activePersonaId
    // is session state — not persisted server-side — so no savePersonas() call
    // is needed (and including one would also re-PUT every persona, wasting
    // bandwidth and risking cross-write clobbers).
    if (convo.personaId && convo.personaId !== state.activePersonaId) {
        state.activePersonaId = convo.personaId;
        // A fixed-mode persona brings its own model settings along (WR-12).
        applyPersonaModelSettings(getActivePersona());
    }

    // Lazy-load messages if this is the first time we're activating this
    // conversation in the session.
    await loadConversationMessages(conversationId);

    // The chat also remembers its engine: reactivate the model that wrote its
    // last reply (unless the persona above pinned one — fixed mode wins).
    restoreConversationModel(convo);

    navigate({ type: 'chat', id: conversationId });
    updateUI();
}

/**
 * Show context menu for a conversation
 * @param {HTMLElement} anchorEl - The button that was clicked
 * @param {string} conversationId
 */
function showConversationMenu(anchorEl, conversationId) {
    // Remove any existing menu
    const existingMenu = document.querySelector('.context-menu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = `
        <button class="context-menu-item" data-action="rename">Rename</button>
        <button class="context-menu-item danger" data-action="delete">Delete</button>
    `;

    // Position the menu
    const rect = anchorEl.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${rect.left - 80}px`;

    document.body.appendChild(menu);

    // Handle menu item clicks
    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', () => {
            const action = item.dataset.action;
            menu.remove();

            if (action === 'rename') {
                renameConversationPrompt(conversationId);
            } else if (action === 'delete') {
                deleteConversationPrompt(conversationId);
            }
        });
    });

    // Close menu on outside click
    setTimeout(() => {
        document.addEventListener('click', function closeMenu(e) {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        });
    }, 0);
}

/**
 * Prompt to rename a conversation
 * @param {string} conversationId
 */
async function renameConversationPrompt(conversationId) {
    const convo = state.conversations[conversationId];
    if (!convo) return;

    const newTitle = await promptName({
        title: 'Rename chat',
        label: 'Chat name',
        value: convo.title || 'New Chat',
        confirmLabel: 'Rename',
    });
    if (!newTitle) return;

    // Prompting is async now — the chat may have been deleted meanwhile.
    if (!state.conversations[conversationId]) return;

    convo.title = newTitle;
    convo.updatedAt = Date.now();
    saveConversations();
    renderConversationList();
}

/**
 * Prompt to delete a conversation. Server delete first (so the local state
 * never goes out of sync with the server on failure), then local cleanup.
 * @param {string} conversationId
 */
async function deleteConversationPrompt(conversationId) {
    const convo = state.conversations[conversationId];
    if (!convo) return;

    const ok = await confirmDialog({
        title: 'Delete chat?',
        body: `"${convo.title || 'New Chat'}" and all of its messages will be deleted. This can't be undone.`,
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;

    try {
        await API.conversations.delete(conversationId);
    } catch (err) {
        console.error('Failed to delete conversation:', err);
        displayError(err, { action: 'delete conversation' });
        return;
    }

    delete state.conversations[conversationId];

    // If we deleted the active conversation, switch to another or clear.
    if (state.activeConversationId === conversationId) {
        const remaining = Object.values(state.conversations);
        if (remaining.length > 0) {
            const mostRecent = remaining.reduce((a, b) =>
                (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a
            );
            state.activeConversationId = mostRecent.id;
            // Lazy-load the newly-active conversation's messages.
            await loadConversationMessages(state.activeConversationId);
        } else {
            state.activeConversationId = null;
        }
    }

    renderConversationList();
    renderConversation();
}

/**
 * Create a new conversation and switch to it
 */
async function startNewConversation() {
    try {
        await createConversation('New Chat');
    } catch (err) {
        console.error('Failed to create conversation:', err);
        return;
    }
    state.activeProjectId = null;
    state.activeWorkspaceId = null;
    navigate({ type: 'chat', id: state.activeConversationId });
}

/**
 * Switch the active persona (from the top-bar persona popover). With the home
 * chat list grouped by persona, this just sets the active persona, makes sure
 * its group is expanded, and shows the home view scrolled to that group.
 * @param {string} personaId
 */
async function switchPersona(personaId) {
    if (!state.personas[personaId]) return;

    state.activePersonaId = personaId;
    applyPersonaModelSettings(getActivePersona()); // fixed mode loads its settings
    state.ui.collapsedPersonaGroups.delete(personaId);

    // Leaving any workspace so the persona's grouped chats are actually visible
    // (inside a workspace the list is workspace-scoped, not persona-grouped).
    if (state.activeProjectId) {
        state.activeProjectId = null;
        UiPrefs.set('activeProject', null);
    }

    savePersonas();
    await updateUI();
    await switchTab('chats');

    const groupEl = document.querySelector(`.persona-group[data-persona-id="${CSS.escape(personaId)}"]`);
    if (groupEl) groupEl.scrollIntoView({ block: 'nearest' });
}

/**
 * Edit a persona - switch to it and open settings tab
 * @param {string} personaId
 */
function editPersona(personaId) {
    if (!state.personas[personaId]) return;

    state.activePersonaId = personaId;
    applyPersonaModelSettings(getActivePersona()); // fixed mode loads its settings
    savePersonas();
    updateUI();
    navigate({ type: 'persona-edit' });
}

/** Keep the persona editor's page title in sync with the active persona's name. */
function syncPersonaEditTitle() {
    const title = document.getElementById('personaEditTitle');
    if (!title) return;
    const persona = getActivePersona();
    title.textContent = persona ? (persona.name || 'Untitled') : 'Persona';
}

// ===== Top-bar popovers (P2-U3a) =====

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
function positionPopover(menu, anchorEl, align) {
    document.body.appendChild(menu);
    const rect = anchorEl.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${rect.bottom + 6}px`;
    if (align === 'right') {
        menu.style.right = `${window.innerWidth - rect.right}px`;
    } else {
        menu.style.left = `${rect.left}px`;
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
function attachPopoverOutsideClose(menu, anchorEl) {
    setTimeout(() => {
        document.addEventListener('click', function closeMenu(e) {
            if (!menu.contains(e.target) && !anchorEl.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        });
    }, 0);
}

/**
 * Top-bar avatar options popover (WR-10): show/hide toggle + size and corner
 * presets, with a link to the full Avatar Display settings. Replaces the old
 * click-to-toggle behavior of the avatar button (and the top-bar gear — the
 * general Settings section lives on the rail now).
 */
function showAvatarMenu(anchorEl) {
    const existing = document.querySelector('.context-menu');
    if (existing) existing.remove();

    const sizes = [['small', 'S'], ['medium', 'M'], ['large', 'L'], ['xlarge', 'XL']];
    const corners = [['top-left', '↖'], ['top-right', '↗'], ['bottom-left', '↙'], ['bottom-right', '↘']];

    const menu = document.createElement('div');
    menu.className = 'context-menu avatar-menu';
    menu.innerHTML = `
        <button class="context-menu-item avatar-menu-toggle" data-avatar-show type="button">
            <span>Show floating avatar</span>
            <span class="avatar-menu-check${state.settings.showAvatar ? '' : ' off'}">✓</span>
        </button>
        <div class="context-menu-separator"></div>
        <div class="context-menu-label">Size</div>
        <div class="avatar-menu-row size-preset-buttons">
            ${sizes.map(([s, label]) =>
                `<button class="size-preset-btn${state.settings.avatarSize === s ? ' active' : ''}" data-size="${s}" type="button">${label}</button>`).join('')}
        </div>
        <div class="context-menu-label">Position</div>
        <div class="avatar-menu-row position-preset-buttons">
            ${corners.map(([pos, glyph]) =>
                `<button class="position-preset-btn${state.settings.avatarPosition === pos ? ' active' : ''}" data-position="${pos}" type="button" aria-label="Position ${pos}">${glyph}</button>`).join('')}
        </div>
        <div class="context-menu-separator"></div>
        <button class="context-menu-item" data-avatar-settings type="button">All avatar settings…</button>
    `;
    positionPopover(menu, anchorEl, 'right');

    // Controls act immediately and keep the popover open (it's a mini panel,
    // not a pick-one menu); only the settings link closes it.
    menu.querySelector('[data-avatar-show]').addEventListener('click', async () => {
        await setShowAvatar(!state.settings.showAvatar);
        menu.querySelector('.avatar-menu-check').classList.toggle('off', !state.settings.showAvatar);
    });
    menu.querySelectorAll('.size-preset-btn').forEach(btn =>
        btn.addEventListener('click', () => setAvatarSize(btn.dataset.size)));
    menu.querySelectorAll('.position-preset-btn').forEach(btn =>
        btn.addEventListener('click', () => setAvatarPosition(btn.dataset.position)));
    menu.querySelector('[data-avatar-settings]').addEventListener('click', () => {
        menu.remove();
        navigate({ type: 'settings' });
    });

    attachPopoverOutsideClose(menu, anchorEl);
}

// Provider registry — single source of truth for everything a provider carries:
// human label + tagline, availability, API-key placeholder, and the parameter
// descriptors the (future) per-model detail view renders from. Grew out of the
// old PROVIDER_LABELS map. Order here = display order in the model menu, catalog,
// and provider chips. See docs/MODELS_TAB_REDESIGN.md.
//
// A param descriptor drives one control:
//   path      location of the value in the model's params bag. A bare key sits
//             flat on modelParams ('temperature'); a dotted key nests under a
//             provider namespace the backend already reads
//             ('anthropic.thinkingBudget', 'google.thinkingLevel').
//   group     'sampling' | 'behaviour' — which detail-view section it lands in.
//   subgroup  optional finer grouping (e.g. 'safety' → a collapsible block).
//   control   'range' | 'number' | 'tags' | 'toggle' | 'select' | 'textarea'.
//   enableKey optional companion on/off key (advanced override) — temp/topP/topK.
//   showWhen  optional conditional visibility ({ path, eq }).
// Array order = render order. Params are NOT consumed yet (detail view is a later
// slice); defined here so the registry is the one place providers are described.

const SAMPLING_PARAMS = [
    { path: 'temperature', label: 'Temperature', group: 'sampling',
      control: 'range', min: 0, max: 2, step: 0.01, default: 1.0,
      enableKey: 'temperatureEnabled',
      help: 'Higher = more creative, lower = more focused.' },
    { path: 'topP', label: 'Top P', group: 'sampling',
      control: 'range', min: 0, max: 1, step: 0.01, default: 0.95,
      enableKey: 'topPEnabled' },
    { path: 'topK', label: 'Top K', group: 'sampling',
      control: 'number', min: 1, max: 100, default: 40, enableKey: 'topKEnabled' },
    { path: 'maxTokens', label: 'Max tokens', group: 'sampling',
      control: 'number', min: 1, max: 32000, default: 4096 },
    { path: 'stopSequences', label: 'Stop sequences', group: 'sampling',
      control: 'tags', default: [] },
];

const BEHAVIOUR_PARAMS = [
    { path: 'streaming', label: 'Streaming', group: 'behaviour',
      control: 'toggle', default: false },
    { path: 'prefill', label: 'Response prefill', group: 'behaviour',
      control: 'textarea', default: '',
      help: 'The model continues from this text (hidden in responses).' },
];

const ANTHROPIC_EXTRA_PARAMS = [
    { path: 'anthropic.thinkingEnabled', label: 'Extended thinking', group: 'behaviour',
      control: 'toggle', default: false, help: 'Deeper reasoning (Claude 4+).' },
    { path: 'anthropic.thinkingBudget', label: 'Thinking budget', group: 'behaviour',
      control: 'number', min: 1024, max: 32000, default: 4000, unit: 'tokens',
      showWhen: { path: 'anthropic.thinkingEnabled', eq: true } },
];

const GEMINI_SAFETY_PARAMS = ['Harassment', 'Hate', 'Sexual', 'Dangerous'].map(cat => ({
    path: `google.safety${cat}`, label: cat, group: 'behaviour', subgroup: 'safety',
    control: 'select', default: 'BLOCK_MEDIUM_AND_ABOVE',
    options: [
        { value: 'BLOCK_LOW_AND_ABOVE',    label: 'Block most' },
        { value: 'BLOCK_MEDIUM_AND_ABOVE', label: 'Block some' },
        { value: 'BLOCK_ONLY_HIGH',        label: 'Block few'  },
        { value: 'BLOCK_NONE',             label: 'Block none' },
        { value: 'OFF',                    label: 'Off'        },
    ],
}));

const GEMINI_EXTRA_PARAMS = [
    // Gemini's thinking control split by model generation, exposed via a
    // user-set mode switch (the general model-variant pattern): 'level' and
    // 'budget' are mutually exclusive in the API and can't be auto-detected
    // from an arbitrary model id. mediaResolution was dropped — it's Gemini-3
    // only, per-attachment, and was never sent by the backend.
    { path: 'google.thinkingApi', label: 'Thinking control', group: 'behaviour',
      control: 'select', default: 'off',
      options: [
        { value: 'off',    label: 'Off' },
        { value: 'level',  label: 'Level (Gemini 3+)' },
        { value: 'budget', label: 'Budget (Gemini 2.5)' },
      ] },
    { path: 'google.thinkingLevel', label: 'Thinking level', group: 'behaviour',
      control: 'select', default: 'medium',
      options: ['minimal', 'low', 'medium', 'high'],
      showWhen: { path: 'google.thinkingApi', eq: 'level' } },
    { path: 'google.thinkingBudget', label: 'Thinking budget', group: 'behaviour',
      control: 'number', min: -1, max: 32000, default: -1, unit: 'tokens',
      help: '0 = off, -1 = dynamic.',
      showWhen: { path: 'google.thinkingApi', eq: 'budget' } },
    ...GEMINI_SAFETY_PARAMS,
];

// Provider brand marks — monochrome SVGs from Simple Icons (simpleicons.org),
// vendored inline so there are no external requests and they work offline. They
// inherit text color via fill="currentColor", so they adapt to theme and to a
// chip's active/hover state for free. Sized by the .provider-icon CSS class.
const PROVIDER_ICON_ANTHROPIC = '<svg class="provider-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/></svg>';
const PROVIDER_ICON_GEMINI = '<svg class="provider-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"/></svg>';
const PROVIDER_ICON_OPENAI = '<svg class="provider-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>';
// Generic fallback (chip outline) for providers with no bundled mark, so the
// chip row and headers never break as new providers are added.
const PROVIDER_ICON_FALLBACK = '<svg class="provider-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></svg>';

/** Inline brand mark for a provider, or the generic fallback. */
function providerIconHtml(provider) {
    return PROVIDERS[provider]?.icon || PROVIDER_ICON_FALLBACK;
}

const PROVIDERS = {
    anthropic: {
        id: 'anthropic', label: 'Anthropic', tagline: 'Claude', status: 'live',
        icon: PROVIDER_ICON_ANTHROPIC, keyPlaceholder: 'sk-ant-…',
        params: [...SAMPLING_PARAMS, ...BEHAVIOUR_PARAMS, ...ANTHROPIC_EXTRA_PARAMS],
    },
    google: {
        id: 'google', label: 'Google', tagline: 'Gemini', status: 'live',
        icon: PROVIDER_ICON_GEMINI, keyPlaceholder: 'AIza…',
        params: [...SAMPLING_PARAMS, ...BEHAVIOUR_PARAMS, ...GEMINI_EXTRA_PARAMS],
    },
    openai: {
        id: 'openai', label: 'OpenAI', tagline: 'GPT', status: 'soon',
        icon: PROVIDER_ICON_OPENAI, keyPlaceholder: 'sk-…',
        params: [],
    },
};

/**
 * Switch the active model — and, when the model belongs to another provider,
 * the provider with it (WR-11: the top-bar menu lists all providers' models;
 * persona/character is retained across the switch by design). Saves the
 * outgoing model's params to its profile and loads the incoming model's
 * (model profiles). No-op if unchanged.
 * @param {string} modelId
 * @param {string} [provider] - the model's provider; defaults to the current one.
 */
function selectModel(modelId, provider) {
    const layer = getActiveModelConfig();
    if (!applyModelToLayer(provider || layer.provider, modelId)) return;
    updateFixedPersonaPin();
    persistSettings();
    updateUI();
}

/**
 * Top-bar model button popover (WR-11): every configured model across ALL
 * providers, grouped by provider, with a "no key" badge on providers that
 * have no stored API key. Picking a model sets provider+model together while
 * retaining the persona — plus a link to the Manage Models modal.
 * @param {HTMLElement} anchorEl
 */
function showModelMenu(anchorEl) {
    const existing = document.querySelector('.context-menu');
    if (existing) existing.remove();

    const modelConfig = getActiveModelConfig();

    const menu = document.createElement('div');
    menu.className = 'context-menu context-menu-wide model-menu';

    let html = '';
    let total = 0;
    for (const [provider, { label }] of Object.entries(PROVIDERS)) {
        const models = state.settings.customModels[provider] || [];
        if (models.length === 0) continue; // hide empty providers entirely
        const hasKey = !!state.apiKeyStatus[provider]?.hasKey;
        html += `<div class="context-menu-label">${label}${hasKey ? '' : '<span class="model-menu-nokey">no key</span>'}</div>`;
        models.forEach(m => {
            const active = provider === modelConfig.provider && m.id === modelConfig.model;
            total++;
            html += `<button class="context-menu-item${active ? ' active' : ''}" data-model-id="${escapeHtml(m.id)}" data-provider="${provider}">${escapeHtml(m.name)}</button>`;
        });
    }
    if (total === 0) {
        html = `<div class="context-menu-empty">No models configured</div>`;
    }
    html += `<div class="context-menu-separator"></div>`;
    html += `<button class="context-menu-item" data-action="manage">Manage models…</button>`;
    menu.innerHTML = html;

    positionPopover(menu, anchorEl, 'right');

    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', () => {
            menu.remove();
            if (item.dataset.action === 'manage') {
                navigate({ type: 'models' }); // the Models section (WR-13) is the catalog's home
                return;
            }
            if (item.dataset.modelId) {
                selectModel(item.dataset.modelId, item.dataset.provider);
            }
        });
    });

    attachPopoverOutsideClose(menu, anchorEl);
}

/**
 * Top-bar persona button popover: edit the current persona, create a new one,
 * or jump to another persona's chats. Switching does NOT reassign the current
 * conversation — see docs/PHASE2_UX_DESIGN.md.
 * @param {HTMLElement} anchorEl
 */
function showPersonaPopover(anchorEl) {
    const existing = document.querySelector('.context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu context-menu-wide';

    let html = '';
    html += `<button class="context-menu-item" data-action="edit">Edit persona</button>`;
    html += `<button class="context-menu-item" data-action="new">+ New persona</button>`;
    if (state.activePersonaId) {
        html += `<button class="context-menu-item danger" data-action="delete">Delete persona</button>`;
    }

    const personas = Object.values(state.personas)
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (personas.length > 0) {
        html += `<div class="context-menu-separator"></div>`;
        html += `<div class="context-menu-label">Switch persona</div>`;
        personas.forEach(p => {
            const active = p.id === state.activePersonaId ? ' active' : '';
            html += `<button class="context-menu-item${active}" data-persona-id="${escapeHtml(p.id)}">${escapeHtml(p.name || 'Untitled')}</button>`;
        });
    }
    menu.innerHTML = html;

    positionPopover(menu, anchorEl, 'left');

    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', () => {
            menu.remove();
            const action = item.dataset.action;
            if (action === 'edit') {
                if (state.activePersonaId) editPersona(state.activePersonaId);
            } else if (action === 'new') {
                startNewPersona();
            } else if (action === 'delete') {
                if (state.activePersonaId) deletePersonaPrompt(state.activePersonaId);
            } else if (item.dataset.personaId) {
                switchPersona(item.dataset.personaId);
            }
        });
    });

    attachPopoverOutsideClose(menu, anchorEl);
}

/**
 * Prompt to delete a persona
 * @param {string} personaId
 */
async function deletePersonaPrompt(personaId) {
    const persona = state.personas[personaId];
    if (!persona) return;

    // Count linked conversations
    const linkedConvos = Object.values(state.conversations).filter(c => c.personaId === personaId);

    let body = `"${persona.name}", its avatar, and its expressions will be deleted.`;
    if (linkedConvos.length > 0) {
        body += ` This also deletes ${linkedConvos.length} linked chat${linkedConvos.length !== 1 ? 's' : ''}.`;
    }
    body += " This can't be undone.";

    const ok = await confirmDialog({
        title: 'Delete persona?',
        body,
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;

    // Server-side delete cascades to linked conversations (and messages).
    // Backend refuses to delete the user's last persona — that surfaces as
    // a VALIDATION_ERROR, which we catch and show to the user.
    try {
        await API.personas.delete(personaId);
    } catch (err) {
        console.error('Failed to delete persona:', err);
        displayError(err, { action: 'delete persona' });
        return;
    }

    // Local cleanup mirrors the server cascade.
    linkedConvos.forEach(convo => {
        delete state.conversations[convo.id];
    });
    delete state.personas[personaId];

    // If we deleted the active persona, switch to another.
    if (state.activePersonaId === personaId) {
        const remaining = Object.values(state.personas);
        state.activePersonaId = remaining.length > 0 ? remaining[0].id : null;
        applyPersonaModelSettings(getActivePersona()); // fixed mode loads its settings
    }

    // Clear active conversation if it was deleted by the cascade.
    if (state.activeConversationId && !state.conversations[state.activeConversationId]) {
        state.activeConversationId = null;
    }

    // The persona editor always shows the active persona, which just got
    // deleted (or swapped) — fall back to the Personas list instead of
    // silently re-targeting the editor at another persona.
    if ((state.ui.mainView || {}).type === 'persona-edit') {
        state.ui.mainView = { type: 'personas' };
    }

    renderConversationList();
    renderConversation();
    await updateUI();
}

/**
 * Create a new persona and switch to editing it
 */
async function startNewPersona() {
    let id;
    try {
        id = await createPersona('New Persona');
    } catch (err) {
        console.error('Failed to create persona:', err);
        return;
    }
    editPersona(id);
}

// ===== Workspace/project row helpers (shared by the main-area lists + pages) =====

const byUpdatedDesc = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);

function workspaceRowHTML(w) {
    const pc = w.projectCount || 0;
    const fc = w.fileCount || 0;
    const meta = `${pc} project${pc !== 1 ? 's' : ''} · ${fc} file${fc !== 1 ? 's' : ''}`;
    return `
        <div class="project-item" data-workspace-id="${w.id}">
            <div class="project-info ws-info" data-workspace-id="${w.id}">
                <span class="project-name">${escapeHtml(w.name || 'Untitled workspace')}</span>
                <span class="project-meta">${meta}</span>
            </div>
            <button class="project-menu-btn ws-menu-btn" data-workspace-id="${w.id}" title="Options">⋯</button>
        </div>
    `;
}

function projectRowHTML(p) {
    const count = p.fileCount || 0;
    const meta = `${count} file${count !== 1 ? 's' : ''}`;
    return `
        <div class="project-item" data-project-id="${p.id}">
            <div class="project-info" data-project-id="${p.id}">
                <span class="project-name">${escapeHtml(p.name || 'Untitled project')}</span>
                <span class="project-meta">${meta}</span>
            </div>
            <button class="project-menu-btn" data-project-id="${p.id}" title="Options">⋯</button>
        </div>
    `;
}

/**
 * Show the context menu for a project (Edit / Delete).
 * @param {HTMLElement} anchorEl
 * @param {string} projectId
 */
function showProjectMenu(anchorEl, projectId) {
    const existingMenu = document.querySelector('.context-menu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = `
        <button class="context-menu-item" data-action="edit">Edit</button>
        <button class="context-menu-item danger" data-action="delete">Delete</button>
    `;

    const rect = anchorEl.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${rect.left - 80}px`;

    document.body.appendChild(menu);

    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', () => {
            const action = item.dataset.action;
            menu.remove();
            if (action === 'edit') {
                editProject(projectId);
            } else if (action === 'delete') {
                deleteProjectPrompt(projectId);
            }
        });
    });

    setTimeout(() => {
        document.addEventListener('click', function closeMenu(e) {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        });
    }, 0);
}

/**
 * Create a new project (name-only step) nested under the given workspace, then
 * open its inline page so the user can fill in instructions/files.
 * @param {string} workspaceId - The owning workspace (defaults to the active one)
 */
async function startNewProjectIn(workspaceId) {
    const wsId = workspaceId || state.activeWorkspaceId || null;
    const name = await promptName({
        title: 'New project',
        label: 'Project name',
        placeholder: 'e.g., Q3 launch',
    });
    if (!name) return;

    let created;
    try {
        created = await API.projects.create({ name, workspaceId: wsId || undefined });
    } catch (err) {
        console.error('Failed to create project:', err);
        displayError(err, { action: 'create project' });
        return;
    }
    state.projects[created.id] = {
        id: created.id,
        workspaceId: created.workspaceId || null,
        name: created.name,
        instructions: created.instructions || '',
        fileCount: created.fileCount || 0,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
    };
    openContainerPage('project', created.id);
}

/**
 * Open a project's inline page to edit its name/instructions/files.
 * @param {string} projectId
 */
function editProject(projectId) {
    if (!state.projects[projectId]) return;
    openContainerPage('project', projectId);
}

/**
 * Confirm and delete a project. The backend moves its Drive folder to the trash
 * (recoverable) and removes the DB rows. Conversations that referenced the
 * project keep working — they just stop receiving its context.
 * @param {string} projectId
 */
async function deleteProjectPrompt(projectId) {
    const project = state.projects[projectId];
    if (!project) return;

    const count = project.fileCount || 0;
    let body = `"${project.name}" will be deleted.`;
    if (count > 0) {
        body += ` Its ${count} file${count !== 1 ? 's' : ''} will be moved to your Google Drive trash.`;
    }
    body += ' Chats in this project will keep working, but without its context.';

    const ok = await confirmDialog({
        title: 'Delete project?',
        body,
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;

    try {
        await API.projects.delete(projectId);
    } catch (err) {
        console.error('Failed to delete project:', err);
        displayError(err, { action: 'delete project' });
        return;
    }

    delete state.projects[projectId];

    // If we're viewing the deleted project's page, climb to its workspace.
    const v = state.ui.mainView || {};
    if (v.type === 'project' && v.id === projectId) {
        backToWorkspace();
    } else {
        renderMainView(); // refresh any list/page that showed it
        renderShell();
    }
}

// ===== Workspace create + edit =====
// Name + shared instructions + reference files are all edited inline on the
// workspace page (renderContainerPage). Creation is a name-only step that lands
// on that page.

/**
 * Create a new workspace (name-only step), then open its inline page so the user
 * can fill in shared instructions and add reference files.
 */
async function startNewWorkspace() {
    const name = await promptName({
        title: 'New workspace',
        label: 'Workspace name',
        placeholder: 'e.g., Vibe Coding',
    });
    if (!name) return;

    let created;
    try {
        created = await API.workspaces.create({ name });
    } catch (err) {
        console.error('Failed to create workspace:', err);
        displayError(err, { action: 'create workspace' });
        return;
    }
    state.workspaces[created.id] = {
        id: created.id,
        name: created.name,
        instructions: created.instructions || '',
        projectCount: created.projectCount || 0,
        fileCount: created.fileCount || 0,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
    };
    openContainerPage('workspace', created.id);
}

/**
 * Open a workspace's inline page to edit its name/instructions/files.
 * @param {string} workspaceId
 */
function editWorkspace(workspaceId) {
    if (!state.workspaces[workspaceId]) return;
    openContainerPage('workspace', workspaceId);
}

/**
 * Confirm and delete a workspace. The backend trashes its Drive folder (and
 * nested projects/files) and reparents its chats to unfiled (kept).
 * @param {string} workspaceId
 */
async function deleteWorkspacePrompt(workspaceId) {
    const ws = state.workspaces[workspaceId];
    if (!ws) return;

    const pc = ws.projectCount || 0;
    const fc = ws.fileCount || 0;
    let body = `"${ws.name}" will be deleted.`;
    if (pc > 0 || fc > 0) {
        body += ` Its ${pc} project${pc !== 1 ? 's' : ''} and ${fc} file${fc !== 1 ? 's' : ''} will be moved to your Google Drive trash.`;
    }
    body += ' Chats in this workspace become unfiled — kept, but without its context.';

    const ok = await confirmDialog({
        title: 'Delete workspace?',
        body,
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;

    try {
        await API.workspaces.delete(workspaceId);
    } catch (err) {
        console.error('Failed to delete workspace:', err);
        displayError(err, { action: 'delete workspace' });
        return;
    }

    // Mirror the server-side cascade locally: projects gone, chats unfiled.
    delete state.workspaces[workspaceId];
    for (const pid of Object.keys(state.projects)) {
        if (state.projects[pid].workspaceId === workspaceId) delete state.projects[pid];
    }
    for (const c of Object.values(state.conversations)) {
        if (c.workspaceId === workspaceId) {
            c.workspaceId = null;
            c.projectId = null;
        }
    }

    // If we're viewing this workspace's page (or one of its now-deleted
    // projects' pages), drop back to the workspaces list.
    const v = state.ui.mainView || {};
    const viewingDeleted =
        (v.type === 'workspace' && v.id === workspaceId) ||
        (v.type === 'project' && !state.projects[v.id]);

    if (state.activeWorkspaceId === workspaceId) {
        state.activeWorkspaceId = null;
        state.activeProjectId = null;
        UiPrefs.set('activeWorkspace', null);
        UiPrefs.set('activeProject', null);
    }

    if (viewingDeleted) {
        navigate({ type: 'workspaces' });
    } else {
        renderMainView();
        renderShell();
    }
}

// ===== Breadcrumb + container navigation (WR-07) =====
// The hierarchy is workspace ⊃ project ⊃ chat. activeWorkspaceId/activeProjectId
// track the container the current view is about (set by openContainerPage and on
// opening a chat) — used for restore and for where "New chat/project" land.

const BREADCRUMB_FOLDER_SVG = '<svg class="breadcrumb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>';

/** Shell-only refresh (rail highlight + contextual top bar + breadcrumb). */
function updateWorkspaceUI() {
    renderShell();
}

/**
 * Render the top-bar breadcrumb for the OPEN CHAT's container: "Chats" (unfiled)
 * / "<Workspace>" / "<Workspace> › <Project>". Shown only while a chat is open
 * (renderTopBar toggles visibility); segments navigate the main-area router.
 */
function renderBreadcrumb() {
    const el = elements.workspaceBreadcrumb;
    if (!el) return;

    const v = state.ui.mainView || {};
    const convo = v.type === 'chat' ? state.conversations[v.id] : null;
    if (!convo) { el.innerHTML = ''; el.classList.remove('active'); return; }

    const workspace = convo.workspaceId ? state.workspaces[convo.workspaceId] : null;
    const project = convo.projectId ? state.projects[convo.projectId] : null;

    let html = '';
    if (!workspace && !project) {
        html = `<span class="breadcrumb-seg" data-nav="chats">${BREADCRUMB_FOLDER_SVG}<span>Chats</span></span>`;
    } else {
        html = `<span class="breadcrumb-seg" data-nav="workspace">${BREADCRUMB_FOLDER_SVG}<span>${escapeHtml(workspace ? (workspace.name || 'Untitled workspace') : 'Workspace')}</span></span>`;
        if (project) {
            html += `<span class="breadcrumb-sep" aria-hidden="true">›</span>`;
            html += `<span class="breadcrumb-seg" data-nav="project"><span>${escapeHtml(project.name || 'Untitled project')}</span></span>`;
        }
    }
    el.innerHTML = html;
    el.classList.toggle('active', !!(workspace || project));

    el.querySelectorAll('[data-nav]').forEach(seg => {
        seg.addEventListener('click', () => {
            const nav = seg.dataset.nav;
            if (nav === 'project' && project) navigate({ type: 'project', id: project.id });
            else if (nav === 'workspace' && workspace) navigate({ type: 'workspace', id: workspace.id });
            else navigate({ type: 'chats' });
        });
    });
}

/** Open a workspace's page (its instructions/files/projects/chats). */
function enterWorkspace(workspaceId) {
    openContainerPage('workspace', workspaceId);
}

/** Open a project's page (its instructions/files/chats). */
function enterProject(projectId) {
    openContainerPage('project', projectId);
}

/** From a project, go up to its workspace page (or the workspaces list). */
function backToWorkspace() {
    if (state.activeWorkspaceId && state.workspaces[state.activeWorkspaceId]) {
        openContainerPage('workspace', state.activeWorkspaceId);
    } else {
        navigate({ type: 'workspaces' });
    }
}

/** Go to the workspaces list. */
function backToWorkspaces() {
    state.activeProjectId = null;
    state.activeWorkspaceId = null;
    UiPrefs.set('activeProject', null);
    UiPrefs.set('activeWorkspace', null);
    navigate({ type: 'workspaces' });
}

/**
 * Create a chat in the container of the current view (a workspace or project
 * page → workspace-/project-level; otherwise unfiled), then open it.
 */
async function startNewChatInContainer() {
    const v = state.ui.mainView || {};
    let container = null;
    if (v.type === 'project') container = { projectId: v.id };
    else if (v.type === 'workspace') container = { workspaceId: v.id };

    try {
        await createConversation('New Chat', container);
    } catch (err) {
        console.error('Failed to create conversation:', err);
        displayError(err, { action: 'create chat' });
        return;
    }
    navigate({ type: 'chat', id: state.activeConversationId });
}

/**
 * Context menu for a workspace row (Edit / Delete).
 * @param {HTMLElement} anchorEl
 * @param {string} workspaceId
 */
function showWorkspaceContextMenu(anchorEl, workspaceId) {
    const existing = document.querySelector('.context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = `
        <button class="context-menu-item" data-action="edit">Edit</button>
        <button class="context-menu-item danger" data-action="delete">Delete</button>
    `;

    positionPopover(menu, anchorEl, 'left');

    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', () => {
            menu.remove();
            if (item.dataset.action === 'edit') {
                editWorkspace(workspaceId);
            } else if (item.dataset.action === 'delete') {
                deleteWorkspacePrompt(workspaceId);
            }
        });
    });

    attachPopoverOutsideClose(menu, anchorEl);
}

/**
 * Format a byte count as a short human-readable size.
 *
 * NOTE: mirrors the server-side `formatFileSize` in
 * server/src/utils/format.js. The two are intentionally independent across
 * the client/server boundary (no shared bundle); keep their thresholds and
 * formatting in sync if either changes.
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format a timestamp as relative time (e.g., "2 hours ago")
 * @param {number} timestamp
 * @returns {string}
 */
function formatTimeAgo(timestamp) {
    if (!timestamp) return '';

    const now = Date.now();
    const diff = now - timestamp;

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;

    // Format as date for older items
    const date = new Date(timestamp);
    return date.toLocaleDateString();
}

/**
 * Escape HTML entities to prevent XSS
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ===== Expression Detection =====
/**
 * Resolve the expression a response declares.
 *
 * Declaration is the ONLY signal. The old keyword fallback was removed: it
 * matched substrings anywhere in the reply, so 'sorry', 'unfortunately' and
 * 'difficult' pushed the avatar to `sad` constantly during ordinary work talk,
 * and which expression won depended on insertion order in the expression map.
 * A missed tag now just holds the current expression — stale beats wrong.
 *
 * @param {string} text - The full response text
 * @returns {string} The expression name to display
 */
function detectExpression(text) {
    const persona = getActivePersona();
    const expressions = persona ? persona.expressions : CONFIG.defaultExpressions;

    // The generating slot is the UI's own state, so a model that declares it
    // is ignored.
    const tagMatch = text.match(/\[expression:\s*([\w -]+)\]/i);
    if (tagMatch) {
        const exprName = tagMatch[1].trim().toLowerCase();
        if (expressions[exprName] && exprName !== CONFIG.generatingExpression) {
            return exprName;
        }
    }

    // Nothing declared: hold the current expression, except settle the
    // transient generating state back to neutral.
    return state.currentExpression === CONFIG.generatingExpression ? 'neutral' : state.currentExpression;
}

/**
 * Drop the avatar out of the `generating` state after a failed or abandoned
 * request. Without this the pulse runs forever: nothing else clears it, since
 * the settled expression is normally applied when a response finalizes.
 * No-op if the avatar has already moved on.
 */
function settleGeneratingExpression() {
    if (state.currentExpression === CONFIG.generatingExpression) {
        setExpression('neutral');
    }
}

function stripExpressionTag(text) {
    return text.replace(/\[expression:\s*\w+\]\s*/gi, '').trim();
}

/**
 * Strip prefill text from the start of a response
 * @param {string} text - The full response text
 * @param {string} prefill - The prefill text to strip
 * @returns {string} Text with prefill removed
 */
function stripPrefillText(text, prefill) {
    if (!prefill || !text) return text;
    const trimmedPrefill = prefill.trim();
    const trimmedText = text.trimStart();
    if (trimmedText.startsWith(trimmedPrefill)) {
        return trimmedText.slice(trimmedPrefill.length).trimStart();
    }
    return text;
}

async function setExpression(exprName) {
    const persona = getActivePersona();
    const expressions = persona ? persona.expressions : CONFIG.defaultExpressions;

    if (expressions[exprName]) {
        state.currentExpression = exprName;
        await updateFloatingAvatar();
        updateStatusBar();
    }
}

// ===== Main-area router (WR-07) =====
// The main area shows exactly one view, chosen by state.ui.mainView. The sidebar
// is a section rail that navigates between views. navigate() is the single entry
// point: it sets the view, repaints the shell (rail highlight + contextual top
// bar) and the main content, and closes the mobile drawer.

/**
 * Navigate the main area to a view and repaint the shell.
 * @param {{type:string, id?:string}} view
 */
function navigate(view) {
    state.ui.mainView = view || { type: 'chats' };
    renderShell();
    renderMainView();
    closeSidebar();
}

/** Which rail section the current view belongs to (for rail highlighting). */
function currentSection() {
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
function renderShell() {
    renderRail();
    renderTopBar();
    renderBreadcrumb();
    syncChatChrome();
}

/**
 * Show the message composer + floating avatar only in a chat view — they're
 * irrelevant (and visually noisy) on the lists / settings / container pages.
 */
function syncChatChrome() {
    const inChat = (state.ui.mainView || {}).type === 'chat';
    if (elements.inputContainer) elements.inputContainer.hidden = !inChat;
    if (elements.floatingAvatar) {
        elements.floatingAvatar.classList.toggle('hidden', !inChat || !state.settings.showAvatar);
    }
    // Reflect this chat's effective file-tools state on the composer toggle.
    if (inChat) syncToolsToggle();
    // File panel + edge tab follow the active chat (hidden while browsing).
    FilePanel.syncUi();
}

/**
 * Render the active main-area view. Guards against views whose entity was
 * deleted by falling back to the owning list.
 */
function renderMainView() {
    const v = state.ui.mainView || { type: 'chats' };

    // Toggle the two persistent main-area panels: the messages/lists surface vs
    // the settings form (which lives in #settingsView so its inputs + listeners
    // survive — it is shown, not re-rendered).
    const isSettings = v.type === 'settings';
    const isPersonaEdit = v.type === 'persona-edit';
    const isModels = v.type === 'models';
    if (elements.settingsView) elements.settingsView.hidden = !isSettings;
    if (elements.personaEditView) elements.personaEditView.hidden = !isPersonaEdit;
    if (elements.modelsView) elements.modelsView.hidden = !isModels;
    if (elements.messagesContainer) elements.messagesContainer.hidden = isSettings || isPersonaEdit || isModels;
    if (isModels) {
        renderModelsView();
        return;
    }
    if (isPersonaEdit) {
        // The editor's inputs always edit the *active* persona (editPersona
        // activates before navigating); the title just needs to match it.
        if (!getActivePersona()) return navigate({ type: 'personas' });
        syncPersonaEditTitle();
        return;
    }
    if (isSettings) return;

    if (v.type === 'workspace') {
        if (!state.workspaces[v.id]) return navigate({ type: 'workspaces' });
        elements.messagesContainer.innerHTML = '';
        renderContainerPage('workspace', v.id);
        return;
    }
    if (v.type === 'project') {
        if (!state.projects[v.id]) return navigate({ type: 'workspaces' });
        elements.messagesContainer.innerHTML = '';
        renderContainerPage('project', v.id);
        return;
    }
    if (v.type === 'workspaces') {
        renderWorkspacesListMain();
        return;
    }
    if (v.type === 'personas') {
        renderPersonasListMain();
        return;
    }
    if (v.type === 'chat') {
        if (!state.conversations[v.id]) return navigate({ type: 'chats' });
        renderChatThread();
        return;
    }
    // 'chats' (default)
    renderChatsListMain();
}

/**
 * Back-compat shim. Older call sites call renderConversation() to mean "repaint
 * the main area"; route them through the view dispatcher (+ shell) so the rail
 * and top bar stay in sync.
 */
function renderConversation() {
    renderShell();
    renderMainView();
}

/** Render the active conversation's message thread into the main area. */
function renderChatThread() {
    elements.messagesContainer.innerHTML = '';

    const activeConvo = getActiveConversation();
    const messages = activeConvo ? activeConvo.messages : [];
    const persona = getActivePersona();
    const assistantName = persona ? persona.name : CONFIG.defaults.assistantName;

    if (messages.length === 0) {
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

    scrollToBottom();
}

/** Highlight the rail item for the section the current view belongs to. */
function renderRail() {
    const section = currentSection();
    document.querySelectorAll('.rail-item[data-section]').forEach(b =>
        b.classList.toggle('active', b.dataset.section === section));
}

/**
 * Contextual top bar (WR-07, amended by P2-05a): in a chat show only the
 * workspace breadcrumb — the model chip lives in the composer's control row.
 * While browsing (composer hidden) show the persona selector (who the next
 * chat will be) plus the model button, since there's no composer to host it.
 */
function renderTopBar() {
    const inChat = (state.ui.mainView || {}).type === 'chat';
    if (elements.personaButton) elements.personaButton.hidden = inChat;
    if (elements.workspaceBreadcrumb) elements.workspaceBreadcrumb.hidden = !inChat;
    if (elements.modelButton) elements.modelButton.hidden = inChat;
}

/** Update the model name shown on the top-bar button and the composer chip. */
function setModelIndicator(name) {
    if (elements.modelIndicator) elements.modelIndicator.textContent = name;
    if (elements.composerModelName) elements.composerModelName.textContent = name;
}

/** Main-area "Chats" section: unfiled chats grouped by persona + a New-chat action. */
function renderChatsListMain() {
    const c = elements.messagesContainer;
    c.innerHTML = `
        <div class="section-view">
            <div class="section-head">
                <h1 class="section-title">Chats</h1>
                <button class="section-new-btn" id="chatsNewBtn" type="button">+ New chat</button>
            </div>
            <div class="section-list" id="chatsListBody"></div>
        </div>`;
    renderGroupedChatList(c.querySelector('#chatsListBody'));
    const nb = c.querySelector('#chatsNewBtn');
    if (nb) nb.addEventListener('click', startNewConversation);
}

/** Main-area "Workspaces" section: the list of workspaces + a New-workspace action. */
function renderWorkspacesListMain() {
    const c = elements.messagesContainer;
    const workspaces = Object.values(state.workspaces).sort(byUpdatedDesc);
    const list = workspaces.length
        ? `<div class="drill-list">${workspaces.map(workspaceRowHTML).join('')}</div>`
        : `<p class="empty-state small">No workspaces yet. Create one to group projects and share instructions + files.</p>`;
    c.innerHTML = `
        <div class="section-view">
            <div class="section-head">
                <h1 class="section-title">Workspaces</h1>
                <button class="section-new-btn" id="wsNewBtn" type="button">+ New workspace</button>
            </div>
            ${list}
        </div>`;
    const nb = c.querySelector('#wsNewBtn');
    if (nb) nb.addEventListener('click', startNewWorkspace);
    c.querySelectorAll('.ws-info[data-workspace-id]').forEach(el =>
        el.addEventListener('click', () => navigate({ type: 'workspace', id: el.dataset.workspaceId })));
    c.querySelectorAll('.ws-menu-btn[data-workspace-id]').forEach(btn =>
        btn.addEventListener('click', (e) => { e.stopPropagation(); showWorkspaceContextMenu(btn, btn.dataset.workspaceId); }));
}

/**
 * Main-area "Personas" section: a character-select grid of portrait tiles —
 * large 1:1 avatar, name, optional role chip, and the persona's tagline. Click
 * a tile to make it active (stays here); the ⋯ menu edits (→ persona editor)
 * or deletes. The top-bar persona popover still handles quick-switch.
 */
function renderPersonasListMain() {
    const c = elements.messagesContainer;
    const personas = Object.values(state.personas)
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    const cards = personas.map(p => {
        const active = p.id === state.activePersonaId;
        const tagline = (p.tagline || '').trim();
        const role = (p.roleLabel || '').trim();
        return `
            <div class="persona-tile${active ? ' active' : ''}">
                <div class="persona-tile-open" data-persona-open="${escapeHtml(p.id)}" role="button" tabindex="0">
                    <div class="persona-tile-portrait">
                        ${personaAvatarHTML(p)}
                        ${active ? '<span class="persona-tile-active">Active</span>' : ''}
                    </div>
                    <div class="persona-tile-caption">
                        <span class="persona-tile-name">${escapeHtml(p.name || 'Untitled')}</span>
                        ${role ? `<span class="persona-tile-role">${escapeHtml(role)}</span>` : ''}
                        <span class="persona-tile-tagline${tagline ? '' : ' empty'}">${tagline ? escapeHtml(tagline) : 'Add a tagline'}</span>
                    </div>
                </div>
                <button class="project-menu-btn persona-tile-menu" data-persona-menu="${escapeHtml(p.id)}" title="Options">⋯</button>
            </div>`;
    }).join('');

    c.innerHTML = `
        <div class="section-view">
            <div class="section-head">
                <h1 class="section-title">Personas</h1>
                <div class="section-head-actions">
                    <button class="section-secondary-btn" id="personaImportBtn" type="button">Import</button>
                    <button class="section-new-btn" id="personaNewBtn" type="button">+ New persona</button>
                </div>
            </div>
            ${personas.length ? `<div class="persona-tile-grid">${cards}</div>` : `<p class="empty-state small">No personas yet.</p>`}
        </div>`;

    const nb = c.querySelector('#personaNewBtn');
    if (nb) nb.addEventListener('click', startNewPersona);
    const ib = c.querySelector('#personaImportBtn');
    if (ib) ib.addEventListener('click', promptPersonaImport);
    c.querySelectorAll('[data-persona-open]').forEach(el => {
        el.addEventListener('click', () => activatePersona(el.dataset.personaOpen));
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                activatePersona(el.dataset.personaOpen);
            }
        });
    });
    c.querySelectorAll('[data-persona-menu]').forEach(btn =>
        btn.addEventListener('click', (e) => { e.stopPropagation(); showPersonaCardMenu(btn, btn.dataset.personaMenu); }));
}

/**
 * Provider chips above the Models catalog (Layout B, Models tab redesign): an
 * "All" chip plus one per provider. The chips are the writer for the "daily
 * drivers" filter (state.settings.catalogProviders) — multi-select, "All" =
 * show every provider. A status dot shows API-key presence; 'soon' providers
 * render disabled. See docs/MODELS_TAB_REDESIGN.md.
 */
function renderProviderChips() {
    const row = document.getElementById('providerChips');
    if (!row) return;
    const selected = state.settings.catalogProviders;
    const isAll = !Array.isArray(selected) || selected.length === 0;

    let html = `<button class="provider-chip${isAll ? ' active' : ''}" data-chip="all" type="button">All</button>`;
    for (const [id, meta] of Object.entries(PROVIDERS)) {
        const soon = meta.status === 'soon';
        const hasKey = !!state.apiKeyStatus[id]?.hasKey;
        const active = !isAll && selected.includes(id);
        const trailing = soon
            ? '<span class="chip-soon">soon</span>'
            : `<span class="chip-dot${hasKey ? ' has-key' : ''}" title="${hasKey ? 'API key saved' : 'no API key'}"></span>`;
        html += `<button class="provider-chip${active ? ' active' : ''}${soon ? ' soon' : ''}" data-chip="${id}" type="button"${soon ? ' disabled' : ''}>
                ${providerIconHtml(id)}<span class="chip-label">${escapeHtml(meta.label)}</span>${trailing}
            </button>`;
    }
    row.innerHTML = html;

    row.querySelectorAll('[data-chip]').forEach(btn =>
        btn.addEventListener('click', () => toggleProviderChip(btn.dataset.chip)));
}

/**
 * Toggle a provider chip, persist, and re-render. "All" clears the filter to
 * null (show every provider). From "All", picking a provider narrows to just
 * it; within a subset, a provider is added or removed. Emptying the subset
 * falls back to "All" (saveCatalogProviders normalises []→null).
 * @param {string} chip - a provider id, or 'all'
 */
function toggleProviderChip(chip) {
    const current = Array.isArray(state.settings.catalogProviders)
        ? [...state.settings.catalogProviders]
        : null;
    let next;
    if (chip === 'all') {
        next = null;
    } else if (current === null) {
        next = [chip];
    } else if (current.includes(chip)) {
        next = current.filter(p => p !== chip);
    } else {
        next = [...current, chip];
    }
    saveCatalogProviders(next); // updates state + debounced persist ([]→null)
    renderModelsCatalog();      // re-renders chips (below) + the filtered catalog
}

/**
 * Models & Providers catalog (WR-13): every added model, grouped by provider,
 * with the provider's API-key status in the group header. Clicking a card
 * makes that model the active layer's (provider switches along); the ⋯ menu
 * removes the model from the catalog. Filtered by the provider chips
 * (state.settings.catalogProviders); null/empty = show all.
 */
function renderModelsCatalog() {
    const c = document.getElementById('modelsCatalog');
    if (!c) return;
    renderProviderChips(); // chips + catalog always render together, stay in sync
    const layer = getActiveModelConfig();
    const selected = state.settings.catalogProviders;
    const showAll = !Array.isArray(selected) || selected.length === 0;

    let html = '';
    for (const [provider, { label }] of Object.entries(PROVIDERS)) {
        if (!showAll && !selected.includes(provider)) continue;
        const models = state.settings.customModels[provider] || [];
        const hasKey = !!state.apiKeyStatus[provider]?.hasKey;
        const soon = PROVIDERS[provider].status === 'soon';
        const keyBtn = soon ? '' :
            `<button class="group-key-btn" data-key-provider="${provider}" type="button">${hasKey ? 'Manage key' : 'Add key'}</button>`;
        // Per-group add (Slice 7): opens the modal already pointed at this
        // provider, so "how do I add a Google model?" is answered in place.
        const addBtn = soon ? '' :
            `<button class="group-key-btn" data-add-provider="${provider}" type="button">+ Add</button>`;
        html += `
            <div class="model-group-head">
                <span class="model-group-name">${providerIconHtml(provider)}${label}</span>
                <span class="model-group-right">
                    <span class="model-key-badge${hasKey ? ' has-key' : ''}">${hasKey ? 'API key saved' : 'no API key'}</span>
                    ${keyBtn}
                    ${addBtn}
                </span>
            </div>`;
        if (models.length === 0) {
            html += `<p class="empty-state small">No ${label} models added.</p>`;
            continue;
        }
        models.forEach(m => {
            const active = provider === layer.provider && m.id === layer.model;
            html += `
                <div class="model-card${active ? ' active' : ''}">
                    <div class="model-card-open" data-model-select="${escapeHtml(m.id)}" data-provider="${provider}">
                        <div class="model-card-info">
                            <span class="model-card-name">${escapeHtml(m.name)}${active ? '<span class="persona-card-badge">Active</span>' : ''}</span>
                            <span class="model-card-sub">${escapeHtml(m.id)}</span>
                        </div>
                    </div>
                    <button class="project-menu-btn model-card-menu" data-model-menu="${escapeHtml(m.id)}" data-provider="${provider}" title="Options">⋯</button>
                </div>`;
        });
    }
    c.innerHTML = html;

    c.querySelectorAll('[data-model-select]').forEach(el =>
        el.addEventListener('click', () => {
            selectModel(el.dataset.modelSelect, el.dataset.provider);
            renderModelsCatalog(); // refresh the Active badge
        }));
    c.querySelectorAll('[data-model-menu]').forEach(btn =>
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            showModelCardMenu(btn, btn.dataset.modelMenu, btn.dataset.provider);
        }));
    c.querySelectorAll('[data-key-provider]').forEach(btn =>
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            showProviderKeyPopover(btn, btn.dataset.keyProvider);
        }));
    c.querySelectorAll('[data-add-provider]').forEach(btn =>
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openModelModal(btn.dataset.addProvider);
        }));
}

/**
 * Provider API-key editor popover (Models tab redesign, Slice 4). Anchored to a
 * provider's "Manage key"/"Add key" button on its catalog group header. The key
 * is provider-owned — one per provider, shared by all its models. The stored key
 * is never echoed back: the field starts empty (placeholder notes a saved key),
 * Save PUTs a new value, Clear deletes.
 * @param {HTMLElement} anchorEl
 * @param {string} provider
 */
function showProviderKeyPopover(anchorEl, provider) {
    const existing = document.querySelector('.context-menu, .key-popover');
    if (existing) existing.remove();
    const meta = PROVIDERS[provider];
    if (!meta) return;
    const hasKey = !!state.apiKeyStatus[provider]?.hasKey;

    const pop = document.createElement('div');
    pop.className = 'key-popover';
    pop.innerHTML = `
        <div class="key-popover-title">${escapeHtml(meta.label)} API key</div>
        <div class="key-popover-field">
            <input type="password" class="key-popover-input" autocomplete="off" spellcheck="false"
                placeholder="${hasKey ? 'Key saved — paste to replace' : escapeHtml(meta.keyPlaceholder || 'API key')}">
            <button class="key-popover-eye" type="button">Show</button>
        </div>
        <p class="key-popover-help">Stored encrypted on the server. Shared by all ${escapeHtml(meta.label)} models.</p>
        <div class="key-popover-actions">
            ${hasKey ? '<button class="key-popover-clear" type="button">Clear</button>' : ''}
            <button class="key-popover-save" type="button">Save</button>
        </div>`;
    positionPopover(pop, anchorEl, 'right');

    const input = pop.querySelector('.key-popover-input');
    const save = () => {
        const value = input.value.trim();
        pop.remove();
        if (value) saveProviderKey(provider, value);
    };
    pop.querySelector('.key-popover-eye').addEventListener('click', (e) => {
        const showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        e.target.textContent = showing ? 'Show' : 'Hide';
        input.focus();
    });
    pop.querySelector('.key-popover-save').addEventListener('click', save);
    const clearBtn = pop.querySelector('.key-popover-clear');
    if (clearBtn) clearBtn.addEventListener('click', () => { pop.remove(); clearStoredApiKey(provider); });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
    });

    attachPopoverOutsideClose(pop, anchorEl);
    input.focus();
}

/** Per-card ⋯ menu on the Models section: Remove from catalog. */
function showModelCardMenu(anchorEl, modelId, provider) {
    const existing = document.querySelector('.context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = `
        <button class="context-menu-item" data-action="edit">Edit settings</button>
        <button class="context-menu-item danger" data-action="remove">Remove</button>`;
    positionPopover(menu, anchorEl, 'right');

    menu.querySelector('[data-action="edit"]').addEventListener('click', () => {
        menu.remove();
        navigate({ type: 'models', detail: { provider, model: modelId } });
    });
    menu.querySelector('[data-action="remove"]').addEventListener('click', () => {
        menu.remove();
        removeCustomModel(modelId, provider);
        renderModelsCatalog();
    });
    attachPopoverOutsideClose(menu, anchorEl);
}

/** Make a persona active from the Personas section (stays on the section). */
function activatePersona(personaId) {
    if (!state.personas[personaId]) return;
    state.activePersonaId = personaId;
    applyPersonaModelSettings(getActivePersona()); // fixed mode loads its settings
    savePersonas();
    updateUI(); // refreshes the section (Active badge) + header
}

/** Per-card context menu on the Personas section: Edit (→ Settings) / Delete. */
// ===== Persona export / import (`.tessera` bundles) =====
// A bundle is one self-contained JSON file: persona text plus its art inlined
// as base64. Built in the browser rather than on the server because <canvas>
// gives us resizing and WebP encoding for free — doing it server-side would
// mean adding a native image library (sharp) for what the browser already has.

const BUNDLE_FORMAT = 'tessera.bundle';
const BUNDLE_VERSION = 1;
/** Longest edge for normalized art. The UI never renders above 480px. */
const BUNDLE_IMAGE_MAX_EDGE = 512;
const BUNDLE_IMAGE_QUALITY = 0.82;

/**
 * Fetch an image URL and return it as `{ mimeType, data }` with base64 data.
 * Normalizes to WebP within BUNDLE_IMAGE_MAX_EDGE unless `fullQuality`, which
 * ships the original bytes untouched.
 * @param {string} url
 * @param {boolean} fullQuality
 * @returns {Promise<{mimeType: string, data: string}|null>} null if unavailable
 */
async function imageToBundleEntry(url, fullQuality) {
    let blob;
    try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) return null;
        blob = await res.blob();
    } catch {
        return null;
    }
    if (!blob || blob.size === 0) return null;

    if (!fullQuality) {
        try {
            blob = await normalizeImageBlob(blob);
        } catch {
            /* fall through and ship the original */
        }
    }
    const data = await blobToBase64(blob);
    return data ? { mimeType: blob.type || 'image/png', data } : null;
}

/**
 * Downscale a blob to fit BUNDLE_IMAGE_MAX_EDGE and re-encode as WebP.
 * Images already within bounds are still re-encoded — that's usually where
 * most of the size saving comes from.
 * @param {Blob} blob
 * @returns {Promise<Blob>}
 */
async function normalizeImageBlob(blob) {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, BUNDLE_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const out = await new Promise(r => canvas.toBlob(r, 'image/webp', BUNDLE_IMAGE_QUALITY));
    return out || blob;
}

/**
 * Base64 (no data: prefix) for a blob.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToBase64(blob) {
    return new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            resolve(result.slice(result.indexOf(',') + 1));
        };
        reader.onerror = () => resolve('');
        reader.readAsDataURL(blob);
    });
}

/**
 * Build and download a `.tessera` bundle for a persona.
 *
 * The model pin and file-tools flag are deliberately left out: neither is the
 * exporter's decision to make about whoever imports this.
 * @param {string} personaId
 * @param {{fullQuality?: boolean}} [opts]
 */
async function exportPersona(personaId, opts = {}) {
    const persona = state.personas[personaId];
    if (!persona) return;
    const fullQuality = !!opts.fullQuality;

    showToast(`Preparing ${persona.name}…`);
    try {
        const cacheBust = persona.updatedAt ? `?v=${persona.updatedAt}` : '';
        const avatar = persona.avatarFilename
            ? await imageToBundleEntry(`${API.avatars.getUrl(persona.id)}${cacheBust}`, fullQuality)
            : null;

        const expressions = {};
        for (const [name, expr] of Object.entries(persona.expressions || {})) {
            if (name === CONFIG.generatingExpression) continue; // UI state, not character
            expressions[name] = {
                emoji: expr.emoji || '🙂',
                image: expr.imageKey
                    ? await imageToBundleEntry(`${API.avatars.getExpressionUrl(persona.id, name)}${cacheBust}`, fullQuality)
                    : null,
            };
        }

        const bundle = {
            format: BUNDLE_FORMAT,
            version: BUNDLE_VERSION,
            kind: 'persona',
            exportedAt: Date.now(),
            persona: {
                name: persona.name || 'Untitled',
                tagline: persona.tagline || '',
                roleLabel: persona.roleLabel || '',
                systemPrompt: persona.systemPrompt || '',
                avatar,
                expressions,
            },
        };

        const json = JSON.stringify(bundle, null, 2);
        const filename = `${(persona.name || 'persona').replace(/[^\w-]+/g, '_')}.tessera`;
        downloadBlob(new Blob([json], { type: 'application/json' }), filename);
        showToast(`Exported ${filename} (${formatBytes(json.length)})`, { type: 'success' });
    } catch (err) {
        console.error('Failed to export persona:', err);
        displayError(err, { action: 'export this persona' });
    }
}

/**
 * Trigger a browser download for a blob.
 * @param {Blob} blob
 * @param {string} filename
 */
function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Human-readable byte count. */
function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Read a `.tessera` file and import it as a new persona. The file is parsed
 * here only to fail fast on malformed JSON — the server does the real
 * validation, since the file is untrusted.
 * @param {File} file
 */
async function importPersonaFromFile(file) {
    if (!file) return;
    let bundle;
    try {
        bundle = JSON.parse(await file.text());
    } catch {
        showToast("That file isn't a readable Tessera bundle", { type: 'warning' });
        return;
    }

    try {
        const created = await API.personas.import(bundle);
        hydratePersonas(await API.personas.list());
        renderPersonasListMain();
        showToast(`Imported "${created.name}"`, { type: 'success' });
    } catch (err) {
        console.error('Failed to import persona:', err);
        displayError(err, { action: 'import this persona' });
    }
}

/** Open a file picker and import the chosen `.tessera` bundle. */
function promptPersonaImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.tessera,application/json';
    input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (file) importPersonaFromFile(file);
    });
    input.click();
}

function showPersonaCardMenu(anchorEl, personaId) {
    const existing = document.querySelector('.context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = `
        <button class="context-menu-item" data-action="edit">Edit</button>
        <button class="context-menu-item" data-action="export">Export…</button>
        <button class="context-menu-item" data-action="export-full">Export (full quality)</button>
        <button class="context-menu-item danger" data-action="delete">Delete</button>
    `;
    positionPopover(menu, anchorEl, 'right');

    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', () => {
            menu.remove();
            const action = item.dataset.action;
            if (action === 'edit') editPersona(personaId);
            else if (action === 'export') exportPersona(personaId);
            else if (action === 'export-full') exportPersona(personaId, { fullQuality: true });
            else if (action === 'delete') deletePersonaPrompt(personaId);
        });
    });
    attachPopoverOutsideClose(menu, anchorEl);
}

// ===== Inline container pages (workspace / project) =====
// A workspace/project page is a main-area router view (WR-07): renderMainView
// calls renderContainerPage for mainView {type:'workspace'|'project'}. The page
// edits name + instructions + files inline and lists the container's projects/
// chats. Entry points: the workspaces list, the in-chat breadcrumb, the project
// rows, and the name-only create step (which lands here after creating).

const CONTAINER_FOLDER_SVG = '<svg class="cp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>';
const CONTAINER_UPLOAD_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';

// ===== Confirm dialog =====
// Replaces window.confirm(). Browsers let users permanently suppress native
// dialogs ("prevent this page from creating additional dialogs"); once ticked,
// confirm() returns false forever and every guarded action silently does
// nothing. Promise-based — resolves true to proceed, false to cancel.
let _confirmResolve = null;
let _confirmLastFocus = null;
let _confirmPrevOverflow = '';

/**
 * Ask the user to confirm an action.
 * `title` and `body` are set as text, never HTML — they routinely interpolate
 * user-controlled names (personas, files, imported .tessera bundles).
 * @param {{title?:string, body?:string, confirmLabel?:string, cancelLabel?:string, danger?:boolean}} [opts]
 * @returns {Promise<boolean>}
 */
function confirmDialog({
    title = 'Are you sure?',
    body = '',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    danger = false,
} = {}) {
    // Never stack: a second call cancels whatever is already on screen.
    if (_confirmResolve) closeConfirmDialog(false);

    return new Promise(resolve => {
        _confirmResolve = resolve;
        _confirmLastFocus = document.activeElement;

        elements.confirmModalTitle.textContent = title;
        elements.confirmModalBody.textContent = body;
        elements.confirmModalBody.style.display = body ? '' : 'none';
        elements.confirmModalConfirmBtn.textContent = confirmLabel;
        elements.confirmModalCancelBtn.textContent = cancelLabel;
        elements.confirmModalConfirmBtn.classList.toggle('danger', danger);
        elements.confirmModalConfirmBtn.classList.toggle('primary', !danger);

        _confirmPrevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        elements.confirmModal.classList.add('visible');

        // Esc/Tab are handled on the document (capture) rather than on the
        // dialog, so they still work if focus is somehow outside it.
        document.addEventListener('keydown', _confirmKeydown, true);

        // Destructive actions focus Cancel, so a stray Enter can't destroy
        // anything; everything else focuses Confirm. Enter then activates the
        // focused button natively — no extra key handling needed.
        // The styles deliberately keep `visibility` out of this dialog's
        // transitions so the buttons are focusable in this same tick; the
        // next-frame retry is a backstop in case that ever regresses.
        const initial = danger ? elements.confirmModalCancelBtn : elements.confirmModalConfirmBtn;
        initial.focus();
        if (document.activeElement !== initial) {
            requestAnimationFrame(() => {
                if (_confirmResolve) initial.focus();
            });
        }
    });
}

/**
 * Key handling while the confirm dialog is open. Bound to the document in the
 * capture phase so it runs before anything underneath (the dialog can be opened
 * from inside another modal that has its own Esc handler).
 */
function _confirmKeydown(e) {
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeConfirmDialog(false);
        return;
    }
    if (e.key === 'Tab') {
        // Two focusable elements, so Tab just toggles. Starting from anywhere
        // else — including <body> — this pulls focus into the dialog rather
        // than letting it walk the page behind.
        e.preventDefault();
        e.stopPropagation();
        const next = document.activeElement === elements.confirmModalCancelBtn
            ? elements.confirmModalConfirmBtn
            : elements.confirmModalCancelBtn;
        next.focus();
    }
}

/** Close the confirm dialog, resolving the pending promise with `result`. */
function closeConfirmDialog(result) {
    document.removeEventListener('keydown', _confirmKeydown, true);
    elements.confirmModal.classList.remove('visible');
    document.body.style.overflow = _confirmPrevOverflow;

    // Hand focus back to whatever opened the dialog, if it's still around.
    if (_confirmLastFocus?.isConnected) _confirmLastFocus.focus();
    _confirmLastFocus = null;

    const resolve = _confirmResolve;
    _confirmResolve = null;
    if (resolve) resolve(result);
}

// ===== Name modal =====
// Asks for a single line of text. Used to create containers (the caller then
// opens the new container's inline page to fill in the rest) and to rename a
// chat. Promise-based — resolves to the trimmed name, or null if cancelled.
// Also the replacement for window.prompt(), which browsers can suppress just
// like confirm() — see the note on confirmDialog().
let _namePromptResolve = null;

/**
 * Show the name modal and resolve with the entered name (or null).
 * @param {{title?:string, label?:string, placeholder?:string, value?:string, confirmLabel?:string}} [opts]
 * @returns {Promise<string|null>}
 */
function promptName({ title = 'New', label = 'Name', placeholder = '', value = '', confirmLabel = 'Create' } = {}) {
    // If one is somehow already open, cancel it before reusing the modal.
    if (_namePromptResolve) closeNameModal(null);
    return new Promise(resolve => {
        _namePromptResolve = resolve;
        elements.nameModalTitle.textContent = title;
        elements.nameModalLabel.textContent = label;
        elements.nameModalInput.value = value;
        elements.nameModalInput.placeholder = placeholder;
        elements.nameModalSaveBtn.textContent = confirmLabel;
        closeSidebar(); // close the mobile drawer if open
        elements.nameModal.classList.add('visible');
        // Works because .modal-overlay flips visibility without waiting on the
        // transition — see the comment on .modal-overlay in styles.css.
        elements.nameModalInput.focus();
        // Renaming starts with the old name in place: select it so typing
        // replaces it, rather than landing the caret at position 0.
        if (value) elements.nameModalInput.select();
    });
}

/** Close the name modal, resolving the pending promise with `result`. */
function closeNameModal(result = null) {
    elements.nameModal.classList.remove('visible');
    const resolve = _namePromptResolve;
    _namePromptResolve = null;
    if (resolve) resolve(result);
}

/** Submit the name modal (Create button / Enter): resolve with the trimmed name. */
function submitNameModal() {
    const name = elements.nameModalInput.value.trim();
    if (!name) {
        elements.nameModalInput.focus();
        return;
    }
    closeNameModal(name);
}

/**
 * Open a container's inline page in the main area. Also syncs the active-
 * container navigation (breadcrumb + sidebar drill level) to match.
 * @param {'workspace'|'project'} kind
 * @param {string} id
 */
function openContainerPage(kind, id) {
    if (kind === 'workspace') {
        if (!state.workspaces[id]) return;
        state.activeWorkspaceId = id;
        state.activeProjectId = null;
        UiPrefs.set('activeWorkspace', id);
        UiPrefs.set('activeProject', null);
    } else {
        const project = state.projects[id];
        if (!project) return;
        state.activeProjectId = id;
        state.activeWorkspaceId = project.workspaceId || null;
        UiPrefs.set('activeProject', id);
        UiPrefs.set('activeWorkspace', state.activeWorkspaceId);
    }
    navigate({ type: kind, id });
}

/**
 * Render the inline container page (workspace or project) into the main area.
 * @param {'workspace'|'project'} kind
 * @param {string} id
 */
function renderContainerPage(kind, id) {
    const isWs = kind === 'workspace';
    const entity = isWs ? state.workspaces[id] : state.projects[id];
    if (!entity) return;
    const workspace = isWs ? entity : state.workspaces[entity.workspaceId];

    // Breadcrumb row at the top of the page (climbs out of the page).
    const crumbs = isWs
        ? `<span class="cp-crumb" data-nav="workspaces">‹ Workspaces</span>`
        : `<span class="cp-crumb" data-nav="workspace">‹ ${escapeHtml(workspace ? (workspace.name || 'Workspace') : 'Workspace')}</span>`;

    const instrPlaceholder = isWs
        ? 'Shared context injected into every chat in this workspace and its projects (optional).'
        : 'Context injected into every chat in this project — on top of its workspace (optional).';

    const inheritNote = (!isWs && workspace)
        ? `<p class="cp-inherit-note">Inherits <strong>${escapeHtml(workspace.name || 'workspace')}</strong> context (its instructions + files apply here too).</p>`
        : '';

    const listsHTML = isWs
        ? containerProjectsListHTML(entity) + containerChatsListHTML(kind, entity)
        : containerChatsListHTML(kind, entity);

    elements.messagesContainer.innerHTML = `
        <div class="container-page" data-kind="${kind}" data-id="${escapeHtml(id)}">
            <div class="cp-breadcrumb">${crumbs}</div>

            <div class="cp-head">
                ${CONTAINER_FOLDER_SVG}
                <input class="cp-name" id="cpName" type="text" maxlength="100" placeholder="${isWs ? 'Workspace name' : 'Project name'}">
            </div>
            ${inheritNote}

            <label class="cp-label" for="cpInstructions">Instructions</label>
            <div class="textarea-resizable">
                <textarea class="cp-instructions" id="cpInstructions" rows="8" placeholder="${instrPlaceholder}"></textarea>
                <div class="textarea-resize-handle" aria-hidden="true" title="Drag to resize"></div>
            </div>
            <div class="cp-save-row">
                <button class="cp-save-btn" id="cpSave" type="button" disabled>Save</button>
                <span class="cp-save-hint" id="cpSaveHint" aria-live="polite"></span>
            </div>

            <div class="cp-section">
                <div class="cp-section-label">Files</div>
                <div class="project-file-list" id="cpFileList"></div>
                <p class="empty-state small" id="cpNoFiles" hidden>No files yet.</p>
                <div class="file-upload-wrapper">
                    <input type="file" id="cpFileInput" class="file-input-hidden" multiple>
                    <button type="button" class="file-upload-btn" id="cpUploadBtn">${CONTAINER_UPLOAD_SVG} Upload files</button>
                </div>
                <p class="help-text">Text, code, and PDF files up to 10MB each.</p>
            </div>

            ${listsHTML}
        </div>
    `;

    wireContainerPage(kind, id);
    setupTextareaResizers(); // the page's Instructions handle is freshly rendered
    loadContainerFiles(kind, id);
}

/** Projects list for a workspace page (each row opens that project's page). */
function containerProjectsListHTML(workspace) {
    const projects = Object.values(state.projects)
        .filter(p => p.workspaceId === workspace.id)
        .sort(byUpdatedDesc);

    let h = `<div class="cp-section"><div class="cp-section-label">Projects</div>`;
    if (projects.length > 0) {
        h += `<div class="drill-list">${projects.map(projectRowHTML).join('')}</div>`;
    } else {
        h += `<p class="empty-state small">No projects yet.</p>`;
    }
    h += `<button class="cp-add-btn" data-action="new-project" type="button">+ New project</button></div>`;
    return h;
}

/** Chats list for a container page (workspace-level or project-level chats). */
function containerChatsListHTML(kind, entity) {
    const chats = (kind === 'workspace'
        ? Object.values(state.conversations).filter(c => c.workspaceId === entity.id && !c.projectId)
        : Object.values(state.conversations).filter(c => c.projectId === entity.id)
    ).sort(byUpdatedDesc);

    const sectionLabel = kind === 'workspace' ? 'Chats here' : 'Chats';
    const addLabel = kind === 'workspace' ? '+ New chat here' : '+ New chat';

    let h = `<div class="cp-section"><div class="cp-section-label">${sectionLabel}</div>`;
    if (chats.length > 0) {
        h += `<div class="cp-row-list">` + chats.map(ch =>
            `<button class="cp-row" data-open-chat="${escapeHtml(ch.id)}" type="button">
                <span class="cp-row-name">${escapeHtml(ch.title || 'New Chat')}</span>
                <span class="cp-row-meta">${formatTimeAgo(ch.updatedAt || ch.createdAt)}</span>
            </button>`).join('') + `</div>`;
    } else {
        h += `<p class="empty-state small">No chats yet.</p>`;
    }
    h += `<button class="cp-add-btn" data-action="new-chat" type="button">${addLabel}</button></div>`;
    return h;
}

/** Wire the interactive elements of the currently-rendered container page. */
function wireContainerPage(kind, id) {
    const page = elements.messagesContainer.querySelector('.container-page');
    if (!page) return;
    const isWs = kind === 'workspace';
    const entity = isWs ? state.workspaces[id] : state.projects[id];
    if (!entity) return;

    const nameEl = page.querySelector('#cpName');
    const instrEl = page.querySelector('#cpInstructions');
    const saveBtn = page.querySelector('#cpSave');
    const hintEl = page.querySelector('#cpSaveHint');

    // Set values via property (avoids HTML-escaping pitfalls in attributes/body).
    if (nameEl) nameEl.value = entity.name || '';
    if (instrEl) instrEl.value = entity.instructions || '';

    const markDirty = () => { if (saveBtn) saveBtn.disabled = false; if (hintEl) hintEl.textContent = ''; };
    if (nameEl) {
        nameEl.addEventListener('input', markDirty);
        nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveBtn?.click(); } });
    }
    if (instrEl) instrEl.addEventListener('input', markDirty);
    if (saveBtn) saveBtn.addEventListener('click', () => saveContainerEdits(kind, id, { saveBtn, nameEl, instrEl, hintEl }));

    // Breadcrumb out of the page (into the main-area router).
    page.querySelectorAll('.cp-crumb[data-nav]').forEach(el => el.addEventListener('click', () => {
        const nav = el.dataset.nav;
        if (nav === 'workspace' && entity.workspaceId) {
            openContainerPage('workspace', entity.workspaceId);
        } else { // 'workspaces' — back to the workspaces list
            navigate({ type: 'workspaces' });
        }
    }));

    // Files.
    const uploadBtn = page.querySelector('#cpUploadBtn');
    const fileInput = page.querySelector('#cpFileInput');
    if (uploadBtn && fileInput) {
        uploadBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => uploadContainerFiles(kind, id, fileInput.files));
    }

    // Project rows (workspace page): open on the info area, ⋯ menu for edit/delete.
    page.querySelectorAll('.project-info[data-project-id]').forEach(el =>
        el.addEventListener('click', () => openContainerPage('project', el.dataset.projectId)));
    page.querySelectorAll('.project-menu-btn[data-project-id]').forEach(btn =>
        btn.addEventListener('click', (e) => { e.stopPropagation(); showProjectMenu(btn, btn.dataset.projectId); }));

    // Chat rows + add buttons.
    page.querySelectorAll('[data-open-chat]').forEach(b =>
        b.addEventListener('click', () => switchConversation(b.dataset.openChat)));
    page.querySelectorAll('[data-action="new-project"]').forEach(b =>
        b.addEventListener('click', () => startNewProjectIn(id)));
    page.querySelectorAll('[data-action="new-chat"]').forEach(b =>
        b.addEventListener('click', startNewChatInContainer));
}

/**
 * Persist the inline name + instructions edits for a container.
 * @param {'workspace'|'project'} kind
 * @param {string} id
 * @param {{saveBtn:HTMLElement, nameEl:HTMLInputElement, instrEl:HTMLTextAreaElement, hintEl:HTMLElement}} els
 */
async function saveContainerEdits(kind, id, els) {
    const { saveBtn, nameEl, instrEl, hintEl } = els;
    const name = (nameEl?.value || '').trim();
    const instructions = instrEl?.value || '';
    const label = kind === 'workspace' ? 'Workspace' : 'Project';

    if (!name) {
        showToast(`${label} name is required.`, { type: 'error' });
        nameEl?.focus();
        return;
    }

    if (saveBtn) saveBtn.disabled = true;
    try {
        if (kind === 'workspace') {
            const u = await API.workspaces.update(id, { name, instructions });
            state.workspaces[id] = { ...state.workspaces[id], name: u.name, instructions: u.instructions, updatedAt: u.updatedAt };
        } else {
            const u = await API.projects.update(id, { name, instructions });
            state.projects[id] = { ...state.projects[id], name: u.name, instructions: u.instructions, updatedAt: u.updatedAt };
        }
    } catch (err) {
        console.error('Failed to save container:', err);
        displayError(err, { action: 'save changes' });
        if (saveBtn) saveBtn.disabled = false;
        return;
    }

    if (hintEl) {
        hintEl.textContent = 'Saved';
        setTimeout(() => { if (hintEl.isConnected) hintEl.textContent = ''; }, 1500);
    }
    updateWorkspaceUI(); // refresh breadcrumb + sidebar names (leaves the page intact)
}

/** The files API namespace for a container kind. */
function containerFilesApi(kind) {
    return kind === 'workspace' ? API.workspaces.files : API.projects.files;
}

/**
 * Load and render the file list for the open container page, keeping the cached
 * file count (and the sidebar/breadcrumb meta) in sync.
 * @param {'workspace'|'project'} kind
 * @param {string} id
 */
async function loadContainerFiles(kind, id) {
    const listEl = document.getElementById('cpFileList');
    if (!listEl) return;

    let files;
    try {
        files = await containerFilesApi(kind).list(id);
    } catch (err) {
        console.error('Failed to load files:', err);
        displayError(err, { action: 'load files' });
        return;
    }

    // Keep the cached count current, then refresh the sidebar/breadcrumb meta.
    if (kind === 'workspace' && state.workspaces[id]) state.workspaces[id].fileCount = files.length;
    if (kind === 'project' && state.projects[id]) state.projects[id].fileCount = files.length;
    updateWorkspaceUI(); // sidebar/breadcrumb only — does not touch the main page

    if (!listEl.isConnected) return; // navigated away during the await
    listEl.innerHTML = '';
    const noEl = document.getElementById('cpNoFiles');

    if (files.length === 0) {
        if (noEl) noEl.hidden = false;
        return;
    }
    if (noEl) noEl.hidden = true;

    files.forEach(f => {
        const row = document.createElement('div');
        row.className = 'project-file-item';
        const label = getFileTypeLabel(f.filename, f.mimeType);
        const href = containerFilesApi(kind).contentUrl(id, f.id);
        // Text files open in the file panel for view/edit/history (FC-04); PDFs
        // and other binaries are download-only.
        const viewable = !/\.pdf$/i.test(f.filename || '');
        row.innerHTML = `
            <span class="project-file-badge">${escapeHtml(label)}</span>
            <span class="project-file-name${viewable ? ' clickable' : ''}" title="${escapeHtml(f.filename)}">${escapeHtml(f.filename)}</span>
            <span class="project-file-size">${escapeHtml(formatFileSize(f.sizeBytes))}</span>
            <a class="project-file-download" href="${href}" download title="Download">⤓</a>
            <button class="project-file-delete" type="button" title="Delete">✕</button>
        `;
        if (viewable) {
            row.querySelector('.project-file-name').addEventListener('click', () => {
                FilePanel.openStandalone({ fileName: f.filename, url: href, mimeType: f.mimeType, sizeBytes: f.sizeBytes });
            });
        }
        row.querySelector('.project-file-delete')
            .addEventListener('click', () => deleteContainerFilePrompt(kind, id, f.id, f.filename));
        listEl.appendChild(row);
    });
}

/**
 * Upload one or more files to the open container, then refresh the list.
 * @param {'workspace'|'project'} kind
 * @param {string} id
 * @param {FileList|File[]} fileList
 */
async function uploadContainerFiles(kind, id, fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    const btn = document.getElementById('cpUploadBtn');
    const originalHTML = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.classList.add('is-uploading');
        btn.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span> Uploading…`;
    }

    let failures = 0;
    for (const file of files) {
        try {
            await containerFilesApi(kind).upload(id, file);
        } catch (err) {
            failures++;
            console.error('Failed to upload file:', file.name, err);
            displayError(err, { action: 'upload file' });
        }
    }

    if (btn && btn.isConnected) {
        btn.classList.remove('is-uploading');
        btn.innerHTML = originalHTML;
        btn.disabled = false;
    }
    const input = document.getElementById('cpFileInput');
    if (input) input.value = ''; // allow re-selecting the same file
    await loadContainerFiles(kind, id);

    const ok = files.length - failures;
    if (ok > 0) showToast(`Uploaded ${ok} file${ok !== 1 ? 's' : ''}.`, { type: 'success' });
}

/**
 * Confirm and delete a single container file (from Drive + DB), then refresh.
 * @param {'workspace'|'project'} kind
 * @param {string} id
 * @param {string} fileId
 * @param {string} filename
 */
async function deleteContainerFilePrompt(kind, id, fileId, filename) {
    const where = kind === 'workspace' ? 'workspace' : 'project';
    const ok = await confirmDialog({
        title: 'Delete file?',
        body: `"${filename}" will be removed from this ${where} and from your Google Drive.`,
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;
    try {
        await containerFilesApi(kind).delete(id, fileId);
    } catch (err) {
        console.error('Failed to delete file:', err);
        displayError(err, { action: 'delete file' });
        return;
    }
    await loadContainerFiles(kind, id);
}

async function appendMessage(role, content, save = true, explicitIndex = null, attachments = null, model = null) {
    const welcome = elements.messagesContainer.querySelector('.welcome-message');
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

    // Render attachments above text content if present
    if (attachments && attachments.length > 0) {
        const attachDiv = document.createElement('div');
        attachDiv.className = 'message-attachments';
        renderMessageAttachments(attachments, attachDiv);
        messageDiv.appendChild(attachDiv);
    }

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    // For assistant messages, strip expression tags before display
    const displayContent = role === 'assistant' ? stripExpressionTag(content) : content;
    // Render Markdown to HTML
    contentDiv.innerHTML = renderMarkdown(displayContent);

    messageDiv.appendChild(contentDiv);

    // Add message action buttons (not on error messages)
    if (role === 'user' || role === 'assistant') {
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'message-actions';
        const rerunTitle = role === 'user' ? 'Resend' : 'Regenerate';
        actionsDiv.innerHTML = messageActionsHTML(rerunTitle);
        messageDiv.appendChild(actionsDiv);
    }

    elements.messagesContainer.appendChild(messageDiv);

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

    scrollToBottom();
    return messageDiv;
}

// ===== Error Display System (P0-17) =====
//
// Three presentation surfaces, chosen by severity/context:
//   - showToast()          : transient notifications (bottom-right, auto-dismiss)
//   - appendErrorMessage() : inline chat errors (tied to a conversation turn)
//   - showCriticalBanner() : persistent top banner for errors needing action
//
// displayError() is the central dispatcher: hand it any thrown error and a
// context hint, and it routes to the right surface based on the ApiError code.

// --- Toast manager ---
const TOAST_MAX = 3;
const TOAST_DEFAULT_MS = 5000;
const TOAST_DEDUPE_MS = 2000;
const _toastIcons = { error: '⛔', warning: '⚠️', success: '✓', info: 'ℹ️' };
// Tracks recently-shown toast keys to suppress duplicate spam.
const _recentToasts = new Map(); // key -> timestamp

/**
 * Show a transient toast notification.
 * @param {string} message - Text to display.
 * @param {Object} [opts]
 * @param {'error'|'warning'|'success'|'info'} [opts.type='info']
 * @param {number} [opts.duration] - ms before auto-dismiss; 0 = sticky. Defaults by type.
 * @param {string} [opts.key] - Dedupe key; defaults to type+message.
 * @returns {HTMLElement|null} The toast element (or null if deduped/suppressed).
 */
function showToast(message, opts = {}) {
    const container = elements.toastContainer;
    if (!container) return null;

    const type = opts.type || 'info';
    const key = opts.key || `${type}:${message}`;
    const now = Date.now();

    // Prune dedupe entries older than the window so the Map can't grow
    // unbounded over a long session with many distinct messages.
    for (const [k, t] of _recentToasts) {
        if (now - t >= TOAST_DEDUPE_MS) _recentToasts.delete(k);
    }

    // Dedupe: skip if an identical toast fired within the dedupe window.
    const last = _recentToasts.get(key);
    if (last && now - last < TOAST_DEDUPE_MS) return null;
    _recentToasts.set(key, now);

    // Cap stacked toasts: drop the oldest *non-hiding* toast when over the
    // limit. Toasts mid-dismiss (class toast-hiding) linger ~300ms during the
    // fade; counting them would let the cap evict a fully-visible newer toast.
    let live = Array.from(container.children).filter(c => !c.classList.contains('toast-hiding'));
    while (live.length >= TOAST_MAX) {
        const oldest = live.shift();
        if (oldest) oldest.remove();
    }

    const duration = opts.duration !== undefined
        ? opts.duration
        : (type === 'error' ? 8000 : TOAST_DEFAULT_MS);

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = _toastIcons[type] || _toastIcons.info;

    const body = document.createElement('div');
    body.className = 'toast-body';
    const msg = document.createElement('div');
    msg.className = 'toast-message';
    msg.textContent = message;
    body.appendChild(msg);

    const dismiss = document.createElement('button');
    dismiss.className = 'toast-dismiss';
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Dismiss notification');
    dismiss.textContent = '×';

    let timer = null;
    const remove = () => {
        if (timer) clearTimeout(timer);
        if (!toast.parentNode) return;
        toast.classList.add('toast-hiding');
        toast.addEventListener('animationend', () => toast.remove(), { once: true });
        // Fallback in case animationend doesn't fire.
        setTimeout(() => { if (toast.parentNode) toast.remove(); }, 300);
    };
    dismiss.addEventListener('click', remove);

    toast.appendChild(icon);
    toast.appendChild(body);
    toast.appendChild(dismiss);
    container.appendChild(toast);

    if (duration > 0) {
        timer = setTimeout(remove, duration);
    }

    return toast;
}

/**
 * Show the persistent critical banner at the top of the page.
 * @param {string} message
 * @param {Object} [opts]
 * @param {string} [opts.actionLabel] - If set, shows an action button.
 * @param {Function} [opts.onAction] - Click handler for the action button.
 */
function showCriticalBanner(message, opts = {}) {
    const banner = elements.criticalBanner;
    // Guard the inner nodes too — a partial HTML edit shouldn't turn an error
    // display into an uncaught TypeError.
    if (!banner || !elements.criticalBannerMessage) return;

    elements.criticalBannerMessage.textContent = message;

    const actionBtn = elements.criticalBannerAction;
    if (actionBtn && opts.actionLabel && typeof opts.onAction === 'function') {
        actionBtn.textContent = opts.actionLabel;
        actionBtn.hidden = false;
        // Replace handler by cloning to drop any prior listeners.
        const fresh = actionBtn.cloneNode(true);
        fresh.addEventListener('click', opts.onAction);
        actionBtn.parentNode.replaceChild(fresh, actionBtn);
        elements.criticalBannerAction = fresh;
    } else if (actionBtn) {
        actionBtn.hidden = true;
    }

    banner.hidden = false;
}

function hideCriticalBanner() {
    if (elements.criticalBanner) elements.criticalBanner.hidden = true;
}

/**
 * Render an inline error message inside the chat thread.
 * @param {Error|string} error - An ApiError, generic Error, or plain string.
 * @param {Object} [opts]
 * @param {Function} [opts.retryHandler] - If set, renders a Retry button.
 */
function appendErrorMessage(error, opts = {}) {
    const isApiError = error && error.name === 'ApiError';
    const code = isApiError ? error.code : null;
    const message = (typeof error === 'string')
        ? error
        : (error && error.message) || 'An unexpected error occurred.';

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message error';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    // Headline with optional code badge.
    const headline = document.createElement('div');
    headline.className = 'error-headline';
    const headlineText = document.createElement('span');
    headlineText.textContent = 'Something went wrong';
    headline.appendChild(headlineText);
    if (code) {
        const badge = document.createElement('span');
        badge.className = 'error-code-badge';
        badge.textContent = code;
        headline.appendChild(badge);
    }
    contentDiv.appendChild(headline);

    // Human-readable message.
    const detail = document.createElement('p');
    detail.className = 'error-detail-text';
    detail.textContent = message;
    contentDiv.appendChild(detail);

    // Collapsible technical details (status + any structured details).
    if (isApiError && (error.status || error.details)) {
        const details = document.createElement('details');
        details.className = 'error-details';
        const summary = document.createElement('summary');
        summary.textContent = 'Technical details';
        details.appendChild(summary);
        const pre = document.createElement('pre');
        const techLines = [];
        if (error.status) techLines.push(`HTTP ${error.status}`);
        if (error.details) {
            try {
                techLines.push(typeof error.details === 'string'
                    ? error.details
                    : JSON.stringify(error.details, null, 2));
            } catch (_) { /* ignore serialization issues */ }
        }
        pre.textContent = techLines.join('\n');
        details.appendChild(pre);
        contentDiv.appendChild(details);
    }

    // Optional retry button.
    if (typeof opts.retryHandler === 'function') {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'error-retry-btn';
        retryBtn.type = 'button';
        retryBtn.textContent = 'Retry';
        // Not {once:true}: if a send is still in flight we keep the button (and
        // the error bubble) so the user can retry once it settles. Only remove
        // the bubble when we actually hand off to the retry handler — otherwise
        // a no-op retry (isLoading) would destroy the error + retry affordance.
        retryBtn.addEventListener('click', () => {
            if (state.isLoading) {
                showToast('Please wait for the current response to finish, then retry.', { type: 'warning' });
                return;
            }
            messageDiv.remove();
            opts.retryHandler();
        });
        contentDiv.appendChild(retryBtn);
    }

    messageDiv.appendChild(contentDiv);
    elements.messagesContainer.appendChild(messageDiv);
    scrollToBottom();
    return messageDiv;
}

/**
 * Central error dispatcher. Routes any caught error to the appropriate
 * presentation surface based on its ApiError code.
 * @param {Error} error - The caught error (ideally an ApiError).
 * @param {Object} [context]
 * @param {'chat'|'background'} [context.surface='background'] - Where the
 *        error originated. 'chat' allows inline rendering for provider errors.
 * @param {Function} [context.retryHandler] - Retry callback for chat errors.
 * @param {string} [context.action] - Short verb describing the failed action,
 *        e.g. "save settings", used to make toast text specific.
 */
function displayError(error, context = {}) {
    // Swallow user-initiated aborts entirely — not an error to surface.
    if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERROR')) {
        return;
    }

    const surface = context.surface || 'background';
    const code = (error && error.name === 'ApiError') ? error.code : 'UNKNOWN_ERROR';
    const baseMsg = (error && error.message) || 'An unexpected error occurred.';
    const actionPrefix = context.action ? `Couldn't ${context.action}: ` : '';
    // retryAfter may legitimately be 0 (retry immediately); only fall back to
    // 60 when it's actually absent.
    const retrySecs = (error && typeof error.retryAfter === 'number') ? error.retryAfter : 60;

    // 401s are handled globally (the on401 handler reloads to the login
    // screen). Rendering a chat bubble that the imminent reload discards is
    // pointless, so AUTH_ERROR always takes the toast fallback regardless of
    // surface.
    if (code === 'AUTH_ERROR') {
        showToast('Your session has expired. Please sign in again.', {
            type: 'warning', key: 'auth-expired',
        });
        return;
    }

    // Chat-turn failures get a DURABLE inline error in the thread (with Retry),
    // whatever the code. The user's message is sitting there awaiting a reply,
    // so an auto-dismissing toast would lose that context once it fades. For
    // rate limits we additionally toast the wait time.
    if (surface === 'chat') {
        appendErrorMessage(error, { retryHandler: context.retryHandler });
        if (code === 'RATE_LIMITED') {
            showToast(`Rate limit reached. Try again in ${retrySecs}s.`, {
                type: 'warning', key: 'rate-limited',
            });
        }
        return;
    }

    // Background (non-chat) failures route by code to the right surface.
    switch (code) {
        case 'RATE_LIMITED':
            showToast(`Rate limit reached. Try again in ${retrySecs}s.`, {
                type: 'warning', key: 'rate-limited',
            });
            return;

        case 'VALIDATION_ERROR':
            showToast(`${actionPrefix}${baseMsg}`, { type: 'warning' });
            return;

        case 'DRIVE_ERROR':
            // Drive integration is Phase 1; banner path is dormant but wired.
            showCriticalBanner(`Google Drive error: ${baseMsg}`);
            return;

        case 'PROVIDER_ERROR':
        case 'NOT_FOUND':
        case 'SERVER_ERROR':
        case 'NETWORK_ERROR':
        default:
            showToast(`${actionPrefix}${baseMsg}`, { type: 'error' });
            return;
    }
}

function showTypingIndicator() {
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

function hideTypingIndicator() {
    const indicator = document.getElementById('typingIndicator');
    if (indicator) {
        indicator.remove();
    }
}

function scrollToBottom() {
    elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
}

// Thin wrapper kept for existing call sites; delegates to the P0-17 toast
// system. `type` accepts 'info' | 'success' | 'warning' | 'error'.
function showNotification(message, type = 'info') {
    showToast(message, { type });
}

// ===== Message Actions =====
function handleMessageAction(messageDiv, action, msgIndex) {
    switch (action) {
        case 'copy':
            copyMessageText(msgIndex);
            break;
        case 'edit':
            editMessageInPlace(messageDiv, msgIndex);
            break;
        case 'delete':
            deleteMessage(msgIndex);
            break;
        case 'rerun':
            rerunFromMessage(msgIndex);
            break;
    }
}

function copyMessageText(msgIndex) {
    const activeConvo = getActiveConversation();
    if (!activeConvo || !activeConvo.messages[msgIndex]) return;

    const text = activeConvo.messages[msgIndex].content;
    navigator.clipboard.writeText(text).then(() => {
        showNotification('Copied to clipboard');
    }).catch(err => {
        console.error('Failed to copy:', err);
    });
}

async function deleteMessage(msgIndex) {
    const activeConvo = getActiveConversation();
    if (!activeConvo || !activeConvo.messages[msgIndex]) return;

    const ok = await confirmDialog({
        title: 'Delete message?',
        body: "This message will be removed from the conversation. This can't be undone.",
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;

    // Confirming is async now — re-check that the message is still there and
    // that we're still looking at the same conversation.
    if (getActiveConversation() !== activeConvo || !activeConvo.messages[msgIndex]) return;

    const msg = activeConvo.messages[msgIndex];

    // Server-side delete first so failure can short-circuit before the local
    // mutation. If the message has no id yet, its persistMessage POST never
    // completed (e.g., still in flight / failed). In that case it doesn't
    // exist server-side and a local-only delete is correct.
    if (msg.id) {
        try {
            await API.messages.delete(activeConvo.id, msg.id);
        } catch (err) {
            console.error('Failed to delete message:', err);
            displayError(err, { action: 'delete message' });
            return;
        }
    }

    // Clean up any attachments from IndexedDB
    if (msg.attachments && msg.attachments.length > 0) {
        msg.attachments.forEach(att => {
            if (att.imageStoreKey) {
                ImageStore.delete(att.imageStoreKey);
            }
        });
    }

    activeConvo.messages.splice(msgIndex, 1);
    activeConvo.updatedAt = Date.now();
    saveConversations();
    renderConversation();
}

function editMessageInPlace(messageDiv, msgIndex) {
    const activeConvo = getActiveConversation();
    if (!activeConvo || !activeConvo.messages[msgIndex]) return;

    const msg = activeConvo.messages[msgIndex];
    const contentDiv = messageDiv.querySelector('.message-content');
    const actionsDiv = messageDiv.querySelector('.message-actions');

    // Hide actions while editing
    if (actionsDiv) actionsDiv.style.display = 'none';

    // Store original content for cancel
    const originalContent = msg.content;
    const originalHTML = contentDiv.innerHTML;

    // Replace content with textarea
    const editContainer = document.createElement('div');
    editContainer.className = 'message-edit-container';

    const textarea = document.createElement('textarea');
    textarea.className = 'message-edit-textarea';
    textarea.value = originalContent;

    const buttonsDiv = document.createElement('div');
    buttonsDiv.className = 'message-edit-actions';
    buttonsDiv.innerHTML = `
        <button class="message-edit-cancel">Cancel</button>
        <button class="message-edit-save">Save</button>
    `;

    editContainer.appendChild(textarea);
    editContainer.appendChild(buttonsDiv);

    contentDiv.replaceWith(editContainer);

    // Auto-resize textarea
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
    textarea.focus();

    // Save handler
    buttonsDiv.querySelector('.message-edit-save').addEventListener('click', async () => {
        const newContent = textarea.value.trim();
        if (!newContent) return;

        // Persist to server first. If the message hasn't been POSTed yet
        // (no id), there's nothing to update — the in-memory edit is enough
        // and the eventual persistMessage in appendMessage hasn't completed.
        if (msg.id) {
            try {
                await API.messages.update(activeConvo.id, msg.id, { content: newContent });
            } catch (err) {
                console.error('Failed to update message:', err);
                displayError(err, { action: 'save edit' });
                return;
            }
        }

        // Update conversation data
        msg.content = newContent;
        activeConvo.updatedAt = Date.now();
        saveConversations();

        // Restore content div with new content
        const newContentDiv = document.createElement('div');
        newContentDiv.className = 'message-content';
        newContentDiv.innerHTML = renderMarkdown(newContent);
        editContainer.replaceWith(newContentDiv);

        if (actionsDiv) actionsDiv.style.display = '';
    });

    // Cancel handler
    buttonsDiv.querySelector('.message-edit-cancel').addEventListener('click', () => {
        const restoredDiv = document.createElement('div');
        restoredDiv.className = 'message-content';
        restoredDiv.innerHTML = originalHTML;
        editContainer.replaceWith(restoredDiv);

        if (actionsDiv) actionsDiv.style.display = '';
    });
}

async function rerunFromMessage(msgIndex) {
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
async function revertConversationFilesForRerun(conversationId, fromTurn) {
    try {
        const res = await API.conversations.revertFiles(conversationId, fromTurn);
        if (res && Array.isArray(res.warnings) && res.warnings.length > 0) {
            showToast(res.warnings.join(' '), { type: 'warning' });
        }
    } catch (err) {
        console.error('Failed to roll back files before re-roll:', err);
    }
}

/**
 * Retry the most recent turn after a send failure. Finds the last user
 * message and re-runs generation from it (which truncates any partial reply
 * and resends). Used as the retry handler for inline chat errors (P0-17).
 */
function retryLastUserMessage() {
    const convo = getActiveConversation();
    if (!convo || state.isLoading) return;
    for (let i = convo.messages.length - 1; i >= 0; i--) {
        if (convo.messages[i].role === 'user') {
            rerunFromMessage(i);
            return;
        }
    }
}

/**
 * Delete every message from `fromIndex` onward — both locally and on the
 * server. Server deletes are issued in parallel; individual failures are
 * logged but don't block local truncation, since the user's mental model is
 * "this rerun replaces what came after."
 */
async function truncateMessagesFrom(convo, fromIndex) {
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

async function sendMessageFromText(text, attachments = []) {
    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;
    if (!state.apiKeyStatus[provider]?.hasKey || state.isLoading) return;

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
                if (state.streamingMessageDiv) {
                    state.streamingMessageDiv.remove();
                    state.streamingMessageDiv = null;
                }
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

// Helper: render attachments in a message
/**
 * Normalize a server tool event (from the tool loop's SSE 'tool-activity'
 * events, or the non-streaming toolEvents array) into a persistable attachment
 * entry, so tool chips + created-file cards survive a reload via the message's
 * existing `attachments` JSON (no schema change — Track A decision).
 * @param {Object} ev - { tool, filename?, ok, + create_file display fields }
 * @returns {Object} attachment entry (type 'created_file' or 'tool_event')
 */
function toolEventToAttachment(ev) {
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
        };
    }
    return { type: 'tool_event', tool: ev.tool, filename: ev.filename || null, ok: ev.ok !== false };
}

/**
 * Append the shared non-image file-card parts (type badge + icon + filename)
 * to `el`. Used by both the uploaded-file attachment card and the model-
 * created-file download card so the structure stays in sync.
 */
function appendFileCardParts(el, fileName, mimeType) {
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
function buildCreatedFileCard(att) {
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
function buildToolChip(att) {
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

// ===== Rich diff viewer helpers (FC-06b) =====

/** Compact relative time for version labels: "2m ago", "3h ago", "2d ago". */
function formatRelativeTime(ms) {
    const diff = Date.now() - ms;
    if (diff < 60000) return 'just now';
    const m = Math.floor(diff / 60000);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d ago`;
    return new Date(ms).toLocaleDateString();
}

/** Count added / deleted lines in a unified diff (hunk headers excluded). */
function diffStats(diffText) {
    let adds = 0, dels = 0;
    if (diffText) {
        for (const line of diffText.split('\n')) {
            const c = line.charAt(0);
            if (c === '+') adds++;
            else if (c === '-') dels++;
        }
    }
    return { adds, dels };
}

/** Split a string into word / whitespace / punctuation tokens (for word diff). */
function tokenizeLine(s) {
    return s.match(/(\s+|\w+|[^\w\s])/g) || [];
}

/**
 * Token-level LCS diff between two strings → { oldParts, newParts }, each a list
 * of { text, changed } runs. Powers the intra-line word highlighting so the eye
 * lands on exactly what changed, not just which line changed.
 */
function computeWordDiff(oldStr, newStr) {
    const a = tokenizeLine(oldStr), b = tokenizeLine(newStr);
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const oldParts = [], newParts = [];
    const push = (arr, text, changed) => {
        const last = arr[arr.length - 1];
        if (last && last.changed === changed) last.text += text;
        else arr.push({ text, changed });
    };
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { push(oldParts, a[i], false); push(newParts, b[j], false); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { push(oldParts, a[i], true); i++; }
        else { push(newParts, b[j], true); j++; }
    }
    while (i < n) { push(oldParts, a[i], true); i++; }
    while (j < m) { push(newParts, b[j], true); j++; }
    return { oldParts, newParts };
}

/** One diff line (prefix stripped); `kind` is hunk|ctx|del|add. */
function rdiffLine(kind, rawLine) {
    const div = document.createElement('div');
    div.className = 'fp-rline fp-r' + kind;
    div.textContent = kind === 'hunk' ? rawLine : rawLine.slice(1);
    return div;
}

/** A del/add line rendered from word-diff parts, changed tokens highlighted. */
function rdiffLineTokens(kind, parts) {
    const div = document.createElement('div');
    div.className = 'fp-rline fp-r' + kind;
    parts.forEach(p => {
        if (p.changed) {
            const mark = document.createElement('span');
            mark.className = 'fp-tok';
            mark.textContent = p.text;
            div.appendChild(mark);
        } else {
            div.appendChild(document.createTextNode(p.text));
        }
    });
    return div;
}

/**
 * Render a unified diff into an editorial-minimal element with word-level
 * highlighting: consecutive − / + runs are paired by index and token-diffed so
 * the changed words stand out; unpaired lines render plainly.
 */
function buildRichDiff(diffText) {
    const container = document.createElement('div');
    container.className = 'fp-rdiff';
    if (!diffText) {
        container.innerHTML = '<p class="file-panel-empty">No content changes recorded for this version.</p>';
        return container;
    }
    const lines = diffText.split('\n');
    let i = 0;
    while (i < lines.length) {
        const c = lines[i].charAt(0);
        if (c === '@') {
            container.appendChild(rdiffLine('hunk', lines[i]));
            i++;
        } else if (c === '-') {
            const dels = []; while (i < lines.length && lines[i].charAt(0) === '-') { dels.push(lines[i]); i++; }
            const adds = []; while (i < lines.length && lines[i].charAt(0) === '+') { adds.push(lines[i]); i++; }
            // Pair by index for word-level highlights; show all − then all +.
            const oldEls = [], newEls = [];
            const pairs = Math.max(dels.length, adds.length);
            for (let k = 0; k < pairs; k++) {
                const d = dels[k], a = adds[k];
                if (d != null && a != null) {
                    const { oldParts, newParts } = computeWordDiff(d.slice(1), a.slice(1));
                    oldEls.push(rdiffLineTokens('del', oldParts));
                    newEls.push(rdiffLineTokens('add', newParts));
                } else if (d != null) { oldEls.push(rdiffLine('del', d)); }
                else if (a != null) { newEls.push(rdiffLine('add', a)); }
            }
            oldEls.forEach(el => container.appendChild(el));
            newEls.forEach(el => container.appendChild(el));
        } else if (c === '+') {
            const adds = []; while (i < lines.length && lines[i].charAt(0) === '+') { adds.push(lines[i]); i++; }
            adds.forEach(l => container.appendChild(rdiffLine('add', l)));
        } else {
            // Context, or one of our note lines ("… (diff truncated …)").
            container.appendChild(rdiffLine('ctx', lines[i]));
            i++;
        }
    }
    return container;
}

// ===== File Panel (edit-in-context slice 1: viewer) =====
// Shows a model-created file beside the chat instead of only as a download
// card. Device-local filePanelMode picks between auto-opening on create_file
// activity and a quiet edge-tab alert; small screens never auto-open (the
// panel is a full-screen overlay there).
const FilePanel = {
    // File currently associated with the panel: { fileName, url, mimeType,
    // sizeBytes } (the created_file attachment shape). Kept even while the
    // panel is closed so the edge tab can reopen it.
    file: null,
    // Which conversation `file` belongs to — syncUi re-derives on mismatch.
    conversationId: null,
    isOpen: false,
    unseen: false,   // live activity arrived while closed → tab dot pulses
    rawMode: false,  // markdown only: show source instead of rendered
    editMode: false, // user is editing in a textarea (slice 3)
    // FC-04: a container/Downloads file opened from a file LIST (not a chat).
    // `standalone` decouples the panel from conversation plumbing; historyMode
    // shows the revision log instead of the file's content.
    standalone: false,
    standaloneView: null, // the mainView key it was opened on (dismiss on nav away)
    historyMode: false,
    historyRevisions: [],  // FC-06b: fetched revisions, NEWEST first
    selectedRevId: null,   // the version shown in the detail pane
    conflict: false, // the assistant rewrote the file mid-edit (Save confirms)
    _fetchSeq: 0,    // ignore stale fetch responses after rapid updates
    _cache: null,    // { url, text } — last fetched content, so raw/rendered
                     // toggles and card re-clicks don't re-download
    _draftBaseline: null,   // text the open draft started from (dirty check)
    _pendingActivity: null, // { att, convoId } that arrived mid-edit; re-
                            // dispatched when the draft closes

    MAX_RENDER_CHARS: 500000,
    // Above this size, skip markdown/highlight parsing and show plain text —
    // a synchronous parse of hundreds of KB visibly janks the main thread.
    MAX_RICH_RENDER_CHARS: 150000,

    isMobile() {
        return window.matchMedia('(max-width: 768px)').matches;
    },

    mode() {
        return UiPrefs.get('filePanelMode') === 'click' ? 'click' : 'auto';
    },

    /**
     * Live create_file activity. `convoId` is the conversation the turn was
     * sent in, pinned at request time — if the user switched chats while the
     * turn was in flight, the event is ignored here (the file still persists
     * in that chat's message attachments, so its edge tab reappears on
     * return via syncUi's re-derivation).
     */
    notifyActivity(att, convoId) {
        if (!att || att.type !== 'created_file' || !att.url) return;
        if (convoId && convoId !== state.activeConversationId) return;
        // The file's content just changed server-side — drop the stale cache.
        if (this._cache && this._cache.url === att.url) this._cache = null;
        // Never clobber an in-progress user edit: same file → flag the
        // conflict so Save asks before overwriting; a different file is
        // queued and re-dispatched when the edit ends, so its panel/edge-tab
        // signal isn't lost.
        if (this.editMode) {
            if (this.file && this.file.url === att.url) {
                this.conflict = true;
                if (elements.filePanelConflict) elements.filePanelConflict.hidden = false;
            } else {
                this._pendingActivity = { att, convoId };
            }
            return;
        }
        if (this.isOpen || (this.mode() === 'auto' && !this.isMobile())) {
            this.open(att);
        } else {
            this.file = att;
            this.conversationId = state.activeConversationId;
            this.unseen = true;
            this.syncUi();
        }
    },

    /** Open the panel on a file (from activity, a card click, or the tab). */
    open(att) {
        if (!att || !att.url) return;
        // A card click while editing another file must not discard the draft.
        if (this.editMode && this.file && this.file.url !== att.url) {
            showToast('Finish or cancel your edit first.', { type: 'warning' });
            return;
        }
        // Re-clicking the edited file's own card leaves edit mode — warn if
        // the draft had changes (same courtesy as close/switch).
        this.discardDraft();
        this.standalone = false;
        this.historyMode = false;
        this.file = att;
        this.conversationId = state.activeConversationId;
        this.isOpen = true;
        this.unseen = false;
        this.rawMode = false;
        this.renderHeader();
        this.loadContent();
        this.syncUi();
    },

    /**
     * Open a container/Downloads file from a file list (FC-04). Unlike open(),
     * this is not tied to a conversation — the panel floats beside the
     * project/workspace page it was opened on and is dismissed on navigation.
     * @param {{fileName:string, url:string, mimeType?:string, sizeBytes?:number}} descriptor
     */
    openStandalone(descriptor) {
        if (!descriptor || !descriptor.url) return;
        this.discardDraft();
        const view = state.ui.mainView || {};
        this.standalone = true;
        this.standaloneView = `${view.type}:${view.id || ''}`;
        this.historyMode = false;
        this.file = descriptor;
        this.conversationId = null;
        this.isOpen = true;
        this.unseen = false;
        this.rawMode = false;
        this.renderHeader();
        this.loadContent();
        this.syncUi();
    },

    close() {
        this.discardDraft();
        this.isOpen = false;
        this.syncUi();
    },

    /**
     * Leave edit mode without saving, warning only when the draft actually
     * differed from its baseline (silent for an untouched editor). The
     * baseline is captured at enterEdit — deliberately not the fetch cache,
     * which a mid-edit assistant rewrite invalidates.
     */
    discardDraft() {
        if (!this.editMode) return;
        const ta = document.getElementById('filePanelEditor');
        const dirty = ta && typeof this._draftBaseline === 'string' && ta.value !== this._draftBaseline;
        this.exitEditMode();
        if (dirty) showToast('Your unsaved edit was discarded.', { type: 'warning' });
    },

    /**
     * Central visibility sync, called from syncChatChrome on every navigation.
     * Panel + tab exist only in a chat view; when the active conversation
     * changed underneath us, re-derive the file from its messages.
     */
    syncUi() {
        if (!elements.filePanel || !elements.filePanelTab) return;
        const view = state.ui.mainView || {};
        const inChat = view.type === 'chat';

        // FC-04 standalone viewer: a file opened from a container/Downloads list.
        // It floats beside the page it was opened on, with no edge tab; opening a
        // chat or navigating to any other page dismisses it.
        if (this.standalone) {
            const viewKey = `${view.type}:${view.id || ''}`;
            if (inChat || viewKey !== this.standaloneView) {
                this.discardDraft();
                this.standalone = false;
                this.historyMode = false;
                this.isOpen = false;
                this.file = null;
                // fall through to the chat logic below (hides or re-derives)
            } else {
                elements.filePanel.hidden = !(this.isOpen && !!this.file);
                elements.filePanelTab.hidden = true;
                if (elements.filePanelTabDot) elements.filePanelTabDot.hidden = true;
                return;
            }
        }

        if (inChat && this.conversationId !== state.activeConversationId) {
            this.discardDraft();
            this.conversationId = state.activeConversationId;
            this.file = this.deriveConversationFile();
            this.isOpen = false;
            this.unseen = false;
            this.historyMode = false;
        }

        const showPanel = inChat && this.isOpen && !!this.file;
        const showTab = inChat && !showPanel && !!this.file;
        elements.filePanel.hidden = !showPanel;
        elements.filePanelTab.hidden = !showTab;
        if (elements.filePanelTabDot) elements.filePanelTabDot.hidden = !(showTab && this.unseen);
    },

    /** Most recent created_file attachment in the active conversation, if any. */
    deriveConversationFile() {
        const convo = state.conversations[state.activeConversationId];
        if (!convo || !Array.isArray(convo.messages)) return null;
        for (let i = convo.messages.length - 1; i >= 0; i--) {
            const atts = convo.messages[i].attachments;
            if (!Array.isArray(atts)) continue;
            for (let j = atts.length - 1; j >= 0; j--) {
                if (atts[j] && atts[j].type === 'created_file' && atts[j].url) return atts[j];
            }
        }
        return null;
    },

    renderHeader() {
        const f = this.file;
        if (!f) return;
        if (elements.filePanelBadge) elements.filePanelBadge.textContent = getFileTypeLabel(f.fileName, f.mimeType);
        if (elements.filePanelName) {
            elements.filePanelName.textContent = f.fileName || 'File';
            elements.filePanelName.title = f.fileName || 'File';
        }
        if (elements.filePanelDownload) {
            elements.filePanelDownload.href = f.url;
            elements.filePanelDownload.setAttribute('download', f.fileName || 'file');
        }
        if (elements.filePanelRawToggle) {
            elements.filePanelRawToggle.hidden = this.editMode || this.historyMode || !this.isMarkdown();
            elements.filePanelRawToggle.classList.toggle('active', this.rawMode);
        }
        // History toggle (FC-04): available except while editing; active shows
        // the revision log instead of the content.
        if (elements.filePanelHistoryBtn) {
            elements.filePanelHistoryBtn.hidden = this.editMode;
            elements.filePanelHistoryBtn.classList.toggle('active', this.historyMode);
        }
        // All panel files are text in v1 — editable unless a draft or history is open.
        if (elements.filePanelEditBtn) elements.filePanelEditBtn.hidden = this.editMode || this.historyMode;
    },

    isMarkdown() {
        const name = (this.file && this.file.fileName || '').toLowerCase();
        return name.endsWith('.md') || name.endsWith('.markdown');
    },

    toggleRaw() {
        this.rawMode = !this.rawMode;
        this.renderHeader();
        this.loadContent();
    },

    // ---- Change history (FC-04) ----

    /** The file's revisions URL, derived from its content URL (all scopes). */
    revisionsUrl() {
        return this.file ? this.file.url.replace(/\/content$/, '/revisions') : null;
    },

    /** Toggle between the file's content and its revision history. */
    toggleHistory() {
        if (!this.file || this.editMode) return;
        if (this.historyMode) {
            this.historyMode = false;
            this.renderHeader();
            this.loadContent();
        } else {
            this.showHistory();
        }
    },

    /** Fetch the file's revisions and render the version viewer (FC-06b). */
    async showHistory() {
        if (!this.file) return;
        this.historyMode = true;
        this.renderHeader();
        const body = elements.filePanelBody;
        if (body) body.innerHTML = '<p class="file-panel-empty">Loading history…</p>';
        const seq = ++this._fetchSeq;
        let revs;
        try {
            revs = await API.files.revisions(this.file.url);
        } catch (err) {
            console.error('Failed to load file history:', err);
            if (seq === this._fetchSeq && this.historyMode && body) {
                body.innerHTML = '<p class="file-panel-empty">Could not load history.</p>';
            }
            return;
        }
        // Ignore a stale response (panel switched files / left history since).
        if (seq !== this._fetchSeq || !this.historyMode) return;
        // Newest first; select the newest version by default.
        this.historyRevisions = Array.isArray(revs) ? [...revs].reverse() : [];
        this.selectedRevId = this.historyRevisions.length ? this.historyRevisions[0].id : null;
        this.renderHistory();
    },

    /** Render the version list + the selected version's detail (FC-06b). */
    renderHistory() {
        const body = elements.filePanelBody;
        if (!body) return;
        const revs = this.historyRevisions;
        if (!revs.length) {
            body.innerHTML = '<p class="file-panel-empty">No changes recorded yet.</p>';
            return;
        }

        const wrap = document.createElement('div');
        wrap.className = 'fp-history';

        // Version rail (newest first). Index 0 is the current version.
        const rail = document.createElement('div');
        rail.className = 'fp-versions';
        revs.forEach((rev, i) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'fp-version' + (rev.id === this.selectedRevId ? ' is-selected' : '');
            const { adds, dels } = diffStats(rev.diff);
            const who = rev.author === 'user' ? 'You' : 'Assistant';
            btn.innerHTML =
                `<span class="fp-version-line">`
                + `<span class="fp-version-who">${escapeHtml(who)}</span>`
                + `<span class="fp-version-op">${escapeHtml(rev.op)}</span>`
                + (i === 0 ? `<span class="fp-version-current">current</span>` : '')
                + `</span>`
                + `<span class="fp-version-line fp-version-sub">`
                + `<span class="fp-version-when">${escapeHtml(formatRelativeTime(rev.createdAt))}</span>`
                + `<span class="fp-version-stat">`
                + (adds ? `<span class="fp-add">+${adds}</span>` : '')
                + (dels ? `<span class="fp-del">−${dels}</span>` : '')
                + `</span></span>`;
            btn.addEventListener('click', () => this.selectVersion(rev.id));
            rail.appendChild(btn);
        });
        wrap.appendChild(rail);

        // Detail pane for the selected version.
        const detail = document.createElement('div');
        detail.className = 'fp-detail';
        const rev = revs.find(r => r.id === this.selectedRevId) || revs[0];
        const isCurrent = rev.id === revs[0].id;

        const head = document.createElement('div');
        head.className = 'fp-detail-head';
        const who = rev.author === 'user' ? 'You' : 'Assistant';
        head.innerHTML = `<span class="fp-detail-title">${escapeHtml(who)} · ${escapeHtml(rev.op)} · ${escapeHtml(new Date(rev.createdAt).toLocaleString())}</span>`;
        if (!isCurrent && rev.hasSnapshot) {
            const restore = document.createElement('button');
            restore.type = 'button';
            restore.className = 'fp-restore-btn';
            restore.textContent = 'Restore this version';
            restore.addEventListener('click', () => this.restoreVersion(rev.id));
            head.appendChild(restore);
        }
        detail.appendChild(head);
        detail.appendChild(buildRichDiff(rev.diff));
        wrap.appendChild(detail);

        body.innerHTML = '';
        body.appendChild(wrap);
    },

    /** Show a different version in the detail pane. */
    selectVersion(revId) {
        this.selectedRevId = revId;
        if (this.historyMode) this.renderHistory();
    },

    /** Restore the file to a stored version (adds a new version, FC-06b). */
    async restoreVersion(revId) {
        if (!this.file || state.isLoading) {
            if (state.isLoading) showToast('Wait for the assistant to finish its turn first.', { type: 'warning' });
            return;
        }
        const ok = await confirmDialog({
            title: 'Restore this version?',
            body: 'The file’s current content is replaced with this version, and the replacement is added as a new entry in the history.',
            confirmLabel: 'Restore',
        });
        if (!ok) return;
        try {
            const updated = await API.files.restoreRevision(this.file.url, revId);
            if (updated && typeof updated.sizeBytes === 'number') this.file.sizeBytes = updated.sizeBytes;
            this._cache = null; // content changed server-side
            showToast('Restored.', { type: 'success' });
            this.showHistory(); // refresh the log (restore appended a version)
        } catch (err) {
            console.error('Failed to restore version:', err);
            displayError(err, { action: 'restore the version' });
        }
    },

    // ---- User editing (slice 3) ----

    /** Switch the body to a textarea holding the file's full current text. */
    enterEdit() {
        if (this.editMode || !this.file) return;
        if (state.isLoading) {
            showToast('Wait for the assistant to finish its turn first.', { type: 'warning' });
            return;
        }
        // The full text lives in the fetch cache; without it (load still in
        // flight or failed) there is nothing safe to edit yet.
        if (!this._cache || this._cache.url !== this.file.url) {
            showToast('Still loading the file — try again in a moment.', { type: 'warning' });
            return;
        }
        if (this._cache.text.length > this.MAX_RENDER_CHARS) {
            showToast('This file is too large to edit here. Download it instead.', { type: 'warning' });
            return;
        }
        this.editMode = true;
        this.conflict = false;
        // Dirty-detection baseline: what the draft started from. Kept apart
        // from the fetch cache, which a mid-edit assistant rewrite nulls.
        this._draftBaseline = this._cache.text;
        this.renderHeader();
        if (elements.filePanel) elements.filePanel.classList.add('is-editing');
        if (elements.filePanelBody) {
            elements.filePanelBody.innerHTML = '';
            const ta = document.createElement('textarea');
            ta.className = 'file-panel-editor';
            ta.id = 'filePanelEditor';
            ta.setAttribute('aria-label', `Edit ${this.file.fileName || 'file'}`);
            ta.value = this._cache.text;
            elements.filePanelBody.appendChild(ta);
            ta.focus();
        }
        if (elements.filePanelFooter) elements.filePanelFooter.hidden = false;
        if (elements.filePanelConflict) elements.filePanelConflict.hidden = true;
    },

    /**
     * Clear edit-mode state + chrome (does not repaint the body), then
     * re-dispatch any file activity that arrived while the draft was open so
     * its panel/edge-tab signal is delivered, not lost.
     */
    exitEditMode() {
        this.editMode = false;
        this.conflict = false;
        this._draftBaseline = null;
        if (elements.filePanel) elements.filePanel.classList.remove('is-editing');
        if (elements.filePanelFooter) elements.filePanelFooter.hidden = true;
        if (elements.filePanelConflict) elements.filePanelConflict.hidden = true;
        const pending = this._pendingActivity;
        this._pendingActivity = null;
        // Re-dispatch outside edit mode: normal open/tab-dot behavior, and the
        // stale-conversation guard drops it if the user has switched chats.
        if (pending) this.notifyActivity(pending.att, pending.convoId);
    },

    /** Return the panel to view mode showing the file's current content. */
    returnToView() {
        this.exitEditMode();
        this.renderHeader();
        this.loadContent();
    },

    /** Discard the draft and show the file's current content again. */
    cancelEdit() {
        if (!this.editMode) return;
        this.returnToView();
    },

    /** Save the draft to the server, then return to view mode. */
    async saveEdit() {
        if (!this.editMode || !this.file) return;
        if (state.isLoading) {
            showToast('Wait for the assistant to finish its turn first.', { type: 'warning' });
            return;
        }
        const ta = document.getElementById('filePanelEditor');
        if (!ta) return;
        const text = ta.value;

        // Mirrors the server's PROJECT_FILE_MAX_BYTES default — a friendlier
        // stop than the request bouncing off the body-size limit.
        if (new TextEncoder().encode(text).length > 10 * 1024 * 1024) {
            showToast('This is too large to save (limit 10MB). Trim the content or download and edit locally.', { type: 'warning' });
            return;
        }

        // The assistant rewrote this file mid-edit — saving is a deliberate
        // choice to overwrite its version, so ask.
        if (this.conflict) {
            const ok = await confirmDialog({
                title: 'Overwrite the assistant’s version?',
                body: 'The assistant updated this file while you were editing. Saving replaces its version with yours.',
                confirmLabel: 'Save anyway',
                danger: true,
            });
            if (!ok) return;
        }

        // Pinned: a conversation switch or panel close while the PUT is in
        // flight reassigns this.file — the result must apply to THIS file.
        const file = this.file;
        const saveBtn = elements.filePanelSaveBtn;
        const cancelBtn = elements.filePanelCancelBtn;
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
        if (cancelBtn) cancelBtn.disabled = true;
        try {
            const updated = await API.files.saveText(file.url, text);
            if (updated && typeof updated.sizeBytes === 'number') file.sizeBytes = updated.sizeBytes;
            // The saved text is now the freshest content for this url — cache
            // it under the PINNED url (url-keyed, so this can never mislabel
            // another file's content even after a mid-save switch).
            this._cache = { url: file.url, text };
            // Only repaint if the panel still shows the file we saved; a
            // mid-save conversation switch already tore the editor down.
            if (this.file === file && this.editMode) {
                this.returnToView();
            }
            showToast('Saved.', { type: 'success' });
        } catch (err) {
            console.error('Failed to save file:', err);
            displayError(err, { action: 'save the file' });
        } finally {
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
            if (cancelBtn) cancelBtn.disabled = false;
        }
    },

    /**
     * Fetch the file's text (same content URL the download uses, via the
     * api-client so 401s trigger the app's re-auth flow) and render. Serves
     * from the in-memory cache when the content hasn't changed — raw/rendered
     * toggles and repeat card clicks cost no network round-trip.
     */
    async loadContent() {
        if (!this.file || !elements.filePanelBody) return;
        if (this.editMode) return; // never repaint over an open draft
        const seq = ++this._fetchSeq;

        let text;
        if (this._cache && this._cache.url === this.file.url) {
            text = this._cache.text;
        } else {
            elements.filePanelBody.innerHTML = '<div class="file-panel-loading">Loading…</div>';
            try {
                text = await API.files.fetchText(this.file.url);
            } catch (err) {
                if (seq !== this._fetchSeq) return;
                elements.filePanelBody.innerHTML =
                    '<div class="file-panel-error">Could not load the file. It may have been deleted — try the download button, or ask the assistant to recreate it.</div>';
                return;
            }
            if (seq !== this._fetchSeq) return;
            this._cache = { url: this.file.url, text };
        }

        let truncated = false;
        if (text.length > this.MAX_RENDER_CHARS) {
            text = text.slice(0, this.MAX_RENDER_CHARS);
            truncated = true;
        }
        this.renderContent(text, truncated);
    },

    renderContent(text, truncated) {
        const body = elements.filePanelBody;
        body.innerHTML = '';

        // Oversized content renders as plain text: parsing it would jank, and
        // a mid-source truncation would corrupt rendered markdown anyway.
        const plainOnly = text.length > this.MAX_RICH_RENDER_CHARS;

        if (this.isMarkdown() && !this.rawMode && !plainOnly) {
            const div = document.createElement('div');
            div.className = 'message-content';
            div.innerHTML = renderMarkdown(text);
            body.appendChild(div);
        } else {
            const pre = document.createElement('pre');
            pre.className = 'file-panel-raw';
            const code = document.createElement('code');
            const lang = plainOnly ? null : this.hljsLanguage();
            if (lang) {
                try {
                    code.innerHTML = hljs.highlight(text, { language: lang }).value;
                } catch {
                    code.textContent = text;
                }
            } else {
                code.textContent = text;
            }
            pre.appendChild(code);
            body.appendChild(pre);
        }

        if (truncated) {
            const note = document.createElement('div');
            note.className = 'file-panel-error';
            note.textContent = 'File is large — showing the beginning only. Use download for the full content.';
            body.appendChild(note);
        }
    },

    /**
     * hljs language for the file's extension, or null for plain text. hljs
     * resolves common extensions as aliases itself (js, ts, py, yml, html,
     * md, …), so the extension is the language id — no mapping table.
     */
    hljsLanguage() {
        const name = (this.file && this.file.fileName || '').toLowerCase();
        const ext = name.slice(name.lastIndexOf('.') + 1);
        return ext && hljs.getLanguage(ext) ? ext : null;
    },
};

/**
 * Append a live tool-activity chip/card to the in-progress streaming message
 * (converted to the same attachment shape used at reload, so live and reload
 * render identically). `convoId` is the conversation the stream was started
 * in, so the file panel ignores events from a chat the user has left.
 */
function renderLiveToolActivity(payload, convoId) {
    if (!state.streamingMessageDiv) return;
    let area = state.streamingMessageDiv.querySelector('.message-attachments');
    if (!area) {
        area = document.createElement('div');
        area.className = 'message-attachments';
        const contentDiv = state.streamingMessageDiv.querySelector('.message-content');
        state.streamingMessageDiv.insertBefore(area, contentDiv);
    }
    const att = toolEventToAttachment(payload);
    renderMessageAttachments([att], area);
    FilePanel.notifyActivity(att, convoId);
    scrollToBottom();
}

function renderMessageAttachments(attachments, containerDiv) {
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

function getFileCategory(mimeType) {
    if (!mimeType) return 'document';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType === 'application/pdf' || mimeType === 'text/plain' || mimeType === 'text/csv' || mimeType === 'text/markdown') return 'document';
    if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') return 'code';
    return 'document';
}

function getFileIcon(mimeType) {
    const category = getFileCategory(mimeType);
    switch (category) {
        case 'image': return '\u{1F5BC}';
        case 'audio': return '\u{1F3B5}';
        case 'code': return '\u{1F4BB}';
        case 'document': return '\u{1F4C4}';
        default: return '\u{1F4CE}';
    }
}

// Short uppercase label for an attachment's type badge — the file extension
// when it's a sane length, else a category fallback (IMG/AUDIO/CODE/DOC).
function getFileTypeLabel(fileName, mimeType) {
    if (fileName && fileName.includes('.')) {
        const ext = fileName.split('.').pop();
        if (ext && ext.length >= 1 && ext.length <= 4 && /^[a-z0-9]+$/i.test(ext)) {
            return ext.toUpperCase();
        }
    }
    return ({ image: 'IMG', audio: 'AUDIO', code: 'CODE', document: 'DOC' })[getFileCategory(mimeType)] || 'FILE';
}

// ===== API Communication =====
async function sendMessage() {
    const userMessage = elements.messageInput.value.trim();
    const modelConfig = getActiveModelConfig();
    const provider = modelConfig.provider;
    const hasApiKey = !!state.apiKeyStatus[provider]?.hasKey;

    const hasAttachments = state.pendingAttachments.length > 0;
    if ((!userMessage && !hasAttachments) || !hasApiKey || state.isLoading) {
        return;
    }

    elements.messageInput.value = '';
    elements.messageInput.style.height = 'auto';
    state.isLoading = true;
    updateSendButtonState();

    // Store attachments to IndexedDB and get metadata
    let attachmentMeta = [];
    if (hasAttachments) {
        attachmentMeta = await storeAttachmentsToIndexedDB(state.pendingAttachments);
        state.pendingAttachments = [];
        renderAttachmentPreviews();
    }

    await appendMessage('user', userMessage || '(attached files)', true, null, attachmentMeta.length > 0 ? attachmentMeta : null);

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
            const result = await callAPIStreaming(userMessage, attachmentMeta);
            await finalizeStreamingMessage(result.text || '', result.generatedImages || [], targetConvoId);
        } catch (error) {
            // Real error path; abort flows through normally now.
            if (state.streamingMessageDiv) {
                state.streamingMessageDiv.remove();
                state.streamingMessageDiv = null;
            }
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
            const response = await callAPI(userMessage, attachmentMeta);

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
function buildChatRequest() {
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

// ===== Request Inspector (P2-U4, developer mode) =====

/**
 * Reflect the device-local devMode pref: show/hide the top-bar "view request"
 * button and sync the settings toggle.
 */
function applyDevMode() {
    const on = !!UiPrefs.get('devMode');
    if (elements.viewRequestBtn) elements.viewRequestBtn.hidden = !on;
    if (elements.devModeToggle) elements.devModeToggle.checked = on;
}

/**
 * Build the same request params a send would, plus the current composer draft
 * as a trailing user message (so the preview reflects what the NEXT turn sends).
 * Note: delegates to buildChatRequest(), which sets state.currentPrefill as a
 * side effect — benign, since it's recomputed on every real send.
 */
function buildPreviewParams() {
    const params = buildChatRequest();
    const draft = elements.messageInput?.value.trim();
    if (draft) {
        params.messages = [...params.messages, { role: 'user', content: draft }];
    }
    return params;
}

/**
 * Open the request inspector: ask the server to assemble (but not send) the
 * exact provider request body, then show it as pretty-printed JSON.
 */
async function previewCurrentRequest() {
    let result;
    try {
        result = await API.chat.preview(buildPreviewParams());
    } catch (err) {
        console.error('Failed to preview request:', err);
        displayError(err, { action: 'preview the request' });
        return;
    }

    if (elements.requestInspectorMeta) {
        const warn = result.contextWarning ? ` · ⚠ ${result.contextWarning}` : '';
        elements.requestInspectorMeta.textContent =
            `POST to ${result.provider} · model ${result.model} · key ${result.apiKeyLocation}${warn}`;
    }
    if (elements.requestInspectorJson) {
        elements.requestInspectorJson.textContent = JSON.stringify(result.body, null, 2);
    }
    if (elements.requestInspectorModal) {
        elements.requestInspectorModal.classList.add('visible');
    }
}

function closeRequestInspectorModal() {
    if (elements.requestInspectorModal) {
        elements.requestInspectorModal.classList.remove('visible');
    }
}

/**
 * Non-streaming chat via the backend proxy. Server returns
 * { text, model, usage?, stopReason?, generatedImages? }.
 * Returns { text, attachments? } where attachments are stored generated
 * images (Gemini multimodal output).
 */
async function callAPI(userMessage, attachments = []) {
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
function showProjectContextWarning(message) {
    showToast(message, { type: 'warning', duration: 8000, key: 'project-context-warning' });
}

// ===== Streaming Support =====
/**
 * Streaming chat via /api/chat/stream. Server forwards the provider's native
 * SSE events; we parse the data JSON and dispatch on shape.
 * On abort (user clicked stop), API.chat.stream resolves normally — the
 * accumulator holds the partial text, which is what callers want.
 */
async function callAPIStreaming(userMessage, attachments = []) {
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
async function storeGeneratedImages(generatedImages) {
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

// ===== Streaming UI helpers =====
// These render and finalize the in-progress assistant message bubble while
// API.chat.stream forwards SSE events to callAPIStreaming.

function startStreamingMessage() {
    const welcome = elements.messagesContainer.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message assistant streaming';

    const labelDiv = document.createElement('div');
    labelDiv.className = 'message-label';
    const persona = getActivePersona();
    labelDiv.textContent = persona ? persona.name : CONFIG.defaults.assistantName;
    messageDiv.appendChild(labelDiv);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    // Pre-token placeholder: show the animated "typing" dots until the first
    // chunk arrives (appendStreamChunk overwrites this). The `awaiting-first-token`
    // class suppresses the trailing block cursor so we don't show both.
    messageDiv.classList.add('awaiting-first-token');
    contentDiv.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    messageDiv.appendChild(contentDiv);
    elements.messagesContainer.appendChild(messageDiv);

    state.streamingMessageDiv = messageDiv;
    state.streamingAccumulator = '';
    state.streamingDeclaredExpression = null;
    state.streamingGeneratedImages = [];
    state.streamingToolEvents = [];

    scrollToBottom();
}

// A leading "[expression: name]" is a control token, not content: it must set
// the avatar and then never reach the screen. Since chunks arrive split at
// arbitrary boundaries, the opening of a stream can be an INCOMPLETE tag
// ("[expr"), so we withhold display until we know whether it will close into
// one. This matches the tag against a growing prefix of the expected shape.
const TAG_OPEN = '[expression:';
const LEADING_EXPRESSION_TAG = /^\[expression:\s*([\w -]+)\]\s*/i;
// Stop waiting if an unclosed tag runs longer than any real name would — a
// malformed opener must never buffer the whole response.
const MAX_TAG_NAME_LENGTH = 40;

/**
 * Could `text` still grow into a complete leading expression tag?
 * Two phases: still typing out "[expression:" itself, or past the opener and
 * accumulating a plausible name that hasn't closed yet.
 * @param {string} text
 * @returns {boolean}
 */
function isPartialExpressionTag(text) {
    const lower = text.toLowerCase();
    if (lower.length < TAG_OPEN.length) return TAG_OPEN.startsWith(lower);
    if (!lower.startsWith(TAG_OPEN)) return false;
    const name = text.slice(TAG_OPEN.length);
    // A ']' here means the full-tag regex already declined it — malformed.
    return !name.includes(']') && name.length <= MAX_TAG_NAME_LENGTH && /^[\w -]*$/.test(name);
}

/**
 * Decide what of the stream so far is safe to render.
 * @param {string} text - Accumulated text (prefill already stripped)
 * @returns {{ display: string, expression: string|null, pending: boolean }}
 *   `pending` means "still might become a tag — render nothing yet".
 */
function splitLeadingExpressionTag(text) {
    const done = text.match(LEADING_EXPRESSION_TAG);
    if (done) {
        return { display: text.slice(done[0].length), expression: done[1].trim().toLowerCase(), pending: false };
    }
    if (isPartialExpressionTag(text)) {
        return { display: '', expression: null, pending: true };
    }
    return { display: text, expression: null, pending: false };
}

function appendStreamChunk(text) {
    state.streamingAccumulator += text;
    if (state.streamingMessageDiv) {
        const contentDiv = state.streamingMessageDiv.querySelector('.message-content');
        if (contentDiv) {
            let displayText = state.streamingAccumulator;
            if (state.currentPrefill) {
                displayText = stripPrefillText(displayText, state.currentPrefill);
            }

            const { display, expression, pending } = splitLeadingExpressionTag(displayText);
            // Still waiting to see if this is a tag — keep the typing dots up
            // rather than flashing a partial "[expre" on screen.
            if (pending) {
                scrollToBottom();
                return;
            }
            // The tag is parsed and stripped here but deliberately NOT applied
            // yet: the avatar holds the `generating` state for the whole
            // response, so "working on it" stays legible instead of flickering
            // for the four tokens it takes the tag to close. The declared
            // expression lands in finalizeStreamingMessage, which re-reads it
            // from the full text via detectExpression.
            if (expression) state.streamingDeclaredExpression = expression;

            // First real content: drop the pre-token placeholder state so the
            // trailing block cursor takes over from the typing dots.
            state.streamingMessageDiv.classList.remove('awaiting-first-token');
            contentDiv.innerHTML = renderMarkdown(display);
        }
        scrollToBottom();
    }
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
async function finalizeStreamingMessage(fullText, generatedImages = [], targetConvoId = null) {
    if (!state.streamingMessageDiv) return;

    state.streamingMessageDiv.classList.remove('streaming');

    const detectedExpr = detectExpression(fullText);
    setExpression(detectedExpr);

    // Strip prefill + expression tag from the persisted/displayed text.
    let cleanText = fullText;
    if (state.currentPrefill) {
        cleanText = stripPrefillText(cleanText, state.currentPrefill);
        state.currentPrefill = '';
    }
    cleanText = stripExpressionTag(cleanText);

    // Assemble this turn's attachments: Track A tool artifacts (chips +
    // created-file cards) first, then any Gemini-generated images. Tool events
    // become persistable entries so they survive a reload.
    const toolAttachments = (state.streamingToolEvents || []).map(toolEventToAttachment);
    const imageAttachments = await storeGeneratedImages(generatedImages);
    const attachments = [...toolAttachments, ...imageAttachments];

    // Bail-out for empty results (e.g., user clicked Stop before any chunk
    // arrived). Persisting an empty assistant turn would pollute the
    // conversation context on the next send. Remove the empty bubble too.
    if (!cleanText.trim() && attachments.length === 0) {
        state.streamingMessageDiv.remove();
        state.streamingMessageDiv = null;
        state.streamingAccumulator = '';
        state.streamingGeneratedImages = [];
        state.streamingToolEvents = [];
        return;
    }

    // Reconcile the attachments row to the authoritative set: drop any live
    // tool chips rendered mid-stream and re-render everything once, so the DOM
    // matches exactly what a reload will produce from the persisted data.
    const liveArea = state.streamingMessageDiv.querySelector('.message-attachments');
    if (liveArea) liveArea.remove();
    if (attachments.length > 0) {
        const attachDiv = document.createElement('div');
        attachDiv.className = 'message-attachments';
        renderMessageAttachments(attachments, attachDiv);
        const contentDiv = state.streamingMessageDiv.querySelector('.message-content');
        if (contentDiv) state.streamingMessageDiv.insertBefore(attachDiv, contentDiv);
    }

    const contentDiv = state.streamingMessageDiv.querySelector('.message-content');
    if (contentDiv) {
        if (!cleanText && imageAttachments.length > 0) {
            contentDiv.innerHTML = '<em>Generated image(s)</em>';
        } else {
            contentDiv.innerHTML = renderMarkdown(cleanText);
        }
    }

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'message-actions';
    actionsDiv.innerHTML = messageActionsHTML('Regenerate');
    state.streamingMessageDiv.appendChild(actionsDiv);

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
        state.streamingMessageDiv.dataset.msgIndex = targetConvo.messages.length - 1;
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

    state.streamingMessageDiv = null;
    state.streamingAccumulator = '';
    state.streamingGeneratedImages = [];
    state.streamingToolEvents = [];
}

/**
 * Abort the in-flight chat stream. api-client.js handles the AbortController
 * lifecycle; callAPIStreaming returns the accumulator-so-far so partial text
 * is preserved as a normal completion.
 */
function stopGeneration() {
    API.chat.abort();
}

/**
 * Download a generated image from IndexedDB
 * @param {Object} attachment - The attachment metadata
 */
async function downloadGeneratedImage(attachment) {
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

// ===== File Attachment Handling =====
function handleFileAttachment(files) {
    const maxFiles = CONFIG.attachments.maxAttachments;
    const currentCount = state.pendingAttachments.length;

    for (let i = 0; i < files.length; i++) {
        if (currentCount + i >= maxFiles) {
            showNotification(`Maximum ${maxFiles} files per message`);
            break;
        }

        const file = files[i];
        const category = getFileCategory(file.type);
        const maxSize = category === 'image' ? CONFIG.attachments.maxImageSize : CONFIG.attachments.maxFileSize;

        if (file.size > maxSize) {
            showNotification(`File "${file.name}" exceeds ${Math.round(maxSize / 1024 / 1024)}MB limit`);
            continue;
        }

        const id = crypto.randomUUID();
        const previewUrl = category === 'image' ? URL.createObjectURL(file) : null;

        state.pendingAttachments.push({
            id,
            file,
            previewUrl,
            type: category,
            mimeType: file.type || 'application/octet-stream',
            fileName: file.name,
            fileSize: file.size
        });
    }

    renderAttachmentPreviews();
    updateSendButtonState();
}

function renderAttachmentPreviews() {
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

function removeAttachment(id) {
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

async function storeAttachmentsToIndexedDB(pendingAttachments) {
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

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            // Remove data URL prefix (e.g., "data:image/png;base64,")
            const base64 = reader.result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
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
async function buildAttachmentContentBlocks(textContent, attachments, provider) {
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

// ===== Event Listeners =====
function setupEventListeners() {
    // Sidebar toggle
    elements.openSidebar.addEventListener('click', openSidebar);
    elements.closeSidebar.addEventListener('click', closeSidebar);

    // Sidebar resize (desktop drag handle)
    setupSidebarResize();

    // Resizable settings textboxes (themed bottom drag-bar)
    setupTextareaResizers();

    // Critical banner dismiss (P0-17)
    if (elements.criticalBannerDismiss) {
        elements.criticalBannerDismiss.addEventListener('click', hideCriticalBanner);
    }

    // Section rail → main-area router (Chats/Workspaces). Personas + Settings are
    // interim: they open the existing popover/modal until WR-07b/c make them
    // full main-area sections.
    document.querySelectorAll('.rail-item[data-section]').forEach(item => {
        item.addEventListener('click', (e) => {
            const section = item.dataset.section;
            if (section === 'chats') navigate({ type: 'chats' });
            else if (section === 'workspaces') navigate({ type: 'workspaces' });
            else if (section === 'personas') navigate({ type: 'personas' });
            else if (section === 'models') navigate({ type: 'models' });
            else if (section === 'settings') navigate({ type: 'settings' });
        });
    });

    // Settings section (WR-07b): re-parent the settings form out of #settingsModal
    // into the main-area panel #settingsView. All settings inputs are cached by id
    // and wired below, so moving the subtree keeps every ref + listener valid — the
    // settings form is now a router view, not a modal.
    const settingsBody = document.querySelector('#settingsModal .settings-modal-body');
    if (settingsBody && elements.settingsView) {
        const heading = document.createElement('h1');
        heading.className = 'settings-view-title';
        heading.textContent = 'Settings';
        elements.settingsView.appendChild(heading);
        elements.settingsView.appendChild(settingsBody);
        if (elements.settingsModal) elements.settingsModal.remove(); // discard the empty modal shell
    }

    // Persona editor (WR-08): pull the persona-identity sections (profile /
    // avatar image / expressions) out of the settings form into their own
    // main-area panel, reached from the Personas section. Same re-parenting
    // trick as above — inputs stay cached by id, listeners survive the move.
    if (elements.personaEditView) {
        elements.personaEditView.innerHTML = `
            <div class="settings-view-crumb"><span class="cp-crumb" id="personaEditBack">‹ Personas</span></div>
            <h1 class="settings-view-title" id="personaEditTitle">Persona</h1>`;
        const editorBody = document.createElement('div');
        editorBody.className = 'settings-modal-body';
        ['personaProfileSection', 'personaAvatarSection', 'personaExpressionsSection'].forEach(id => {
            const section = document.getElementById(id);
            if (section) editorBody.appendChild(section);
        });
        elements.personaEditView.appendChild(editorBody);
        document.getElementById('personaEditBack')
            .addEventListener('click', () => navigate({ type: 'personas' }));
    }

    // Models & Providers section (WR-13): a title row + the model catalog
    // (rendered per-visit by renderModelsCatalog) + the active-model/API-key
    // and advanced-params sections re-parented out of the settings form.
    // Same re-parenting trick — every input keeps its id-cached ref + listeners.
    if (elements.modelsView) {
        // Two sibling panels toggled by renderModelsView: the catalog (chips +
        // cards) and the per-model detail view (Slice 5). The static Advanced
        // Settings section is no longer re-parented in — it was retired.
        elements.modelsView.innerHTML = `
            <div class="models-catalog-panel" id="modelsCatalogPanel">
                <div class="models-head">
                    <h1 class="settings-view-title">Models</h1>
                    <button class="section-new-btn" id="modelsAddBtn" type="button">+ Add model</button>
                </div>
                <div class="provider-chips" id="providerChips"></div>
                <div class="models-catalog" id="modelsCatalog"></div>
            </div>
            <div class="model-detail-panel" id="modelDetailPanel" hidden></div>`;
        // No argument: the header button is provider-agnostic, so the modal
        // defaults to the active model's provider (a group's "+ Add" passes one).
        document.getElementById('modelsAddBtn').addEventListener('click', () => openModelModal());
    }
    if (elements.personaButton) {
        elements.personaButton.addEventListener('click', (e) => {
            e.stopPropagation();
            showPersonaPopover(elements.personaButton);
        });
    }
    // The model menu opens from either the top-bar button (browsing) or the
    // composer chip (in chat) — same menu, anchored to whichever was clicked.
    [elements.modelButton, elements.composerModelButton].forEach((btn) => {
        if (!btn) return;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            showModelMenu(btn);
        });
    });

    // Appearance: theme / accent / chat width (device-local, applied live)
    document.querySelectorAll('#themeOptions button').forEach(btn => {
        btn.addEventListener('click', () => {
            UiPrefs.set('theme', btn.dataset.themeName);
            withThemeTransition(() => applyTheme(btn.dataset.themeName));
            syncAppearanceControls();
        });
    });
    document.querySelectorAll('#chatWidthOptions button').forEach(btn => {
        btn.addEventListener('click', () => {
            UiPrefs.set('chatWidth', btn.dataset.chatWidth);
            applyChatWidth(btn.dataset.chatWidth);
            syncAppearanceControls();
        });
    });
    document.querySelectorAll('#filePanelModeOptions button').forEach(btn => {
        btn.addEventListener('click', () => {
            UiPrefs.set('filePanelMode', btn.dataset.filePanelMode);
            syncAppearanceControls();
        });
    });

    // File panel (viewer): close, raw/rendered toggle, and the edge tab.
    if (elements.filePanelClose) {
        elements.filePanelClose.addEventListener('click', () => FilePanel.close());
    }
    if (elements.filePanelRawToggle) {
        elements.filePanelRawToggle.addEventListener('click', () => FilePanel.toggleRaw());
    }
    if (elements.filePanelHistoryBtn) {
        elements.filePanelHistoryBtn.addEventListener('click', () => FilePanel.toggleHistory());
    }
    if (elements.filePanelTab) {
        elements.filePanelTab.addEventListener('click', () => {
            if (FilePanel.file) FilePanel.open(FilePanel.file);
        });
    }
    // File panel (user editing, slice 3): edit / save / cancel.
    if (elements.filePanelEditBtn) {
        elements.filePanelEditBtn.addEventListener('click', () => FilePanel.enterEdit());
    }
    if (elements.filePanelSaveBtn) {
        elements.filePanelSaveBtn.addEventListener('click', () => FilePanel.saveEdit());
    }
    if (elements.filePanelCancelBtn) {
        elements.filePanelCancelBtn.addEventListener('click', () => FilePanel.cancelEdit());
    }
    // Custom palette controls: touching any of them activates the Custom theme.
    const setCustomPalette = (patch) => {
        UiPrefs.set('customPalette', { ...UiPrefs.get('customPalette'), ...patch });
        UiPrefs.set('theme', 'custom');
        withThemeTransition(() => applyTheme('custom'));
        syncAppearanceControls();
    };
    if (elements.paletteBase) {
        elements.paletteBase.addEventListener('input', () => setCustomPalette({ base: elements.paletteBase.value }));
    }
    if (elements.paletteTint) {
        elements.paletteTint.addEventListener('input', () => setCustomPalette({ tint: Number(elements.paletteTint.value) }));
    }
    document.querySelectorAll('#paletteModeOptions button').forEach(btn => {
        btn.addEventListener('click', () => setCustomPalette({ mode: btn.dataset.paletteMode }));
    });
    if (elements.paletteResetBtn) {
        elements.paletteResetBtn.addEventListener('click', () => setCustomPalette({ ...UiPrefs.defaults.customPalette }));
    }

    // Developer mode + request inspector (P2-U4)
    if (elements.devModeToggle) {
        elements.devModeToggle.addEventListener('change', () => {
            UiPrefs.set('devMode', elements.devModeToggle.checked);
            applyDevMode();
        });
    }
    // Files-in-context: how many turns a changed file stays live (FC-03b).
    // Server-backed, so it rides the settings auto-save. Clamp to the same
    // 0–20 the API enforces and reflect the clamped value back in the field.
    if (elements.activeFileTurns) {
        elements.activeFileTurns.addEventListener('change', () => {
            let v = parseInt(elements.activeFileTurns.value, 10);
            if (!Number.isFinite(v)) v = CONFIG.defaults.activeFileTurns;
            v = Math.max(0, Math.min(20, v));
            elements.activeFileTurns.value = v;
            state.settings.activeFileTurns = v;
            autoSaveSettings();
        });
    }

    if (elements.viewRequestBtn) {
        elements.viewRequestBtn.addEventListener('click', previewCurrentRequest);
    }
    if (elements.closeRequestInspector) {
        elements.closeRequestInspector.addEventListener('click', closeRequestInspectorModal);
    }
    if (elements.requestInspectorModal) {
        elements.requestInspectorModal.addEventListener('click', (e) => {
            if (e.target === elements.requestInspectorModal) closeRequestInspectorModal();
        });
    }
    if (elements.copyRequestBtn) {
        elements.copyRequestBtn.addEventListener('click', () => {
            const text = elements.requestInspectorJson?.textContent || '';
            navigator.clipboard?.writeText(text).then(
                () => showToast('Request JSON copied.', { type: 'success' }),
                () => showToast('Copy failed.', { type: 'error' })
            );
        });
    }

    // Copy button on rendered code blocks (delegated — blocks are injected as
    // message HTML, so we can't bind them individually). Reads the raw code from
    // the sibling <code> element and briefly swaps the icon to a checkmark.
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.code-copy-btn');
        if (!btn) return;
        const codeEl = btn.parentElement?.querySelector('pre code');
        const text = codeEl ? codeEl.textContent : '';
        if (!text) return;
        navigator.clipboard?.writeText(text).then(() => {
            btn.classList.add('copied');
            btn.innerHTML = ICON_SVG.check;
            clearTimeout(btn._copyResetTimer);
            btn._copyResetTimer = setTimeout(() => {
                btn.classList.remove('copied');
                btn.innerHTML = ICON_SVG.copy;
            }, 1500);
        }, () => showToast('Copy failed.', { type: 'error' }));
    });

    // (The "+ New chat" button lives in the main-area Chats list, wired per
    // render in renderChatsListMain.)

    // Shared confirm dialog. No close ×: a confirm has exactly two exits.
    elements.confirmModalCancelBtn.addEventListener('click', () => closeConfirmDialog(false));
    elements.confirmModalConfirmBtn.addEventListener('click', () => closeConfirmDialog(true));
    elements.confirmModal.addEventListener('click', (e) => {
        if (e.target === elements.confirmModal) closeConfirmDialog(false);
    });
    // Esc and the Tab trap are bound to the document while the dialog is open —
    // see _confirmKeydown.

    // Name-only create modal (workspace + project creation). The create/edit
    // triggers live in the Workspaces drill-in and the inline container pages,
    // wired per-render. Container instructions/files are edited inline, not here.
    elements.closeNameModal.addEventListener('click', () => closeNameModal(null));
    elements.nameModalSaveBtn.addEventListener('click', submitNameModal);
    elements.nameModal.addEventListener('click', (e) => {
        if (e.target === elements.nameModal) closeNameModal(null);
    });
    elements.nameModalInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitNameModal(); }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && elements.nameModal.classList.contains('visible')) {
            closeNameModal(null);
        }
    });
    // The top-bar breadcrumb and inline container pages wire their own controls
    // per render (renderBreadcrumb / wireContainerPage).

    // Close any open context menus when clicking elsewhere
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.context-menu') && !e.target.closest('.conversation-menu-btn') && !e.target.closest('.persona-menu-btn') && !e.target.closest('.project-menu-btn')) {
            const existingMenu = document.querySelector('.context-menu');
            if (existingMenu) existingMenu.remove();
        }
    });

    // Persona model-settings mode toggle (persona editor, WR-12)
    document.querySelectorAll('#personaModelModeOptions button').forEach(btn => {
        btn.addEventListener('click', () => setPersonaModelMode(btn.dataset.modelMode));
    });

    // File-tools: composer per-chat toggle + persona base default (Track A).
    if (elements.toolsToggleBtn) {
        elements.toolsToggleBtn.addEventListener('click', toggleChatTools);
    }
    if (elements.personaToolsBase) {
        elements.personaToolsBase.addEventListener('change', () => setPersonaToolsBase(elements.personaToolsBase.checked));
    }

    // Provider/model switching and the API-key field moved out of Settings in
    // Slice 4 (catalog cards + provider key popover), so no listeners here.

    // Model parameter controls are wired per-instance by the detail view
    // (wireParamControls in renderModelDetail), not here — the static Advanced
    // Settings section was retired in Slice 5.

    // Persona settings - auto-save
    elements.assistantName.addEventListener('input', autoSaveSettings);
    elements.personaTagline.addEventListener('input', autoSaveSettings);
    elements.personaRoleLabel.addEventListener('input', autoSaveSettings);
    elements.systemPrompt.addEventListener('input', autoSaveSettings);
    // (prefill is a model param now — edited in the per-model detail view.)

    // API-key visibility toggle + clear now live in the provider key popover
    // (showProviderKeyPopover), wired per-instance when the popover opens.

    // Size / position preset buttons in Settings (the popover wires its own).
    document.querySelectorAll('.size-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => setAvatarSize(btn.dataset.size));
    });
    document.querySelectorAll('.position-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => setAvatarPosition(btn.dataset.position));
    });

    // Custom size slider — continuous scale beyond the presets.
    if (elements.avatarSizeSlider) {
        elements.avatarSizeSlider.addEventListener('input', async () => {
            state.settings.avatarSize = String(elements.avatarSizeSlider.value);
            syncAvatarSizeControls();
            await updateFloatingAvatar();
        });
        elements.avatarSizeSlider.addEventListener('change', () => autoSaveSettings());
    }

    // Drag the floating avatar to position it freely.
    setupAvatarDrag();

    // Show avatar checkbox - auto-save
    elements.showAvatar.addEventListener('change', () => {
        setShowAvatar(elements.showAvatar.checked);
    });

    // Avatar button in the top bar → options popover (WR-10)
    elements.avatarToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showAvatarMenu(elements.avatarToggleBtn);
    });
    
    // Avatar file upload
    elements.avatarUploadBtn.addEventListener('click', () => {
        elements.avatarFileInput.click();
    });
    
    elements.avatarFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            handleAvatarUpload(file);
        }
    });
    
    elements.avatarClearBtn.addEventListener('click', () => {
        clearAvatarImage();
    });
    
    // Expression modal
    elements.addExpressionBtn.addEventListener('click', () => openExpressionModal());
    elements.closeExpressionModal.addEventListener('click', closeExpressionModal);
    elements.saveExpressionBtn.addEventListener('click', saveExpression);
    elements.deleteExpressionBtn.addEventListener('click', deleteExpression);
    
    // Expression file upload
    elements.expressionUploadBtn.addEventListener('click', () => {
        elements.expressionFileInput.click();
    });
    
    elements.expressionFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            handleExpressionImageUpload(file);
        }
    });
    
    elements.expressionClearBtn.addEventListener('click', () => {
        clearExpressionImage();
    });
    
    // Close modal on overlay click
    elements.expressionModal.addEventListener('click', (e) => {
        if (e.target === elements.expressionModal) {
            closeExpressionModal();
        }
    });

    // Add-model modal ("+ Add model" in the Models view header, or a catalog
    // group's "+ Add", are the entries; the provider is picked inside).
    elements.closeModelModal.addEventListener('click', closeModelModal);
    elements.fetchModelsBtn.addEventListener('click', handleFetchModels);
    elements.addModelBtn.addEventListener('click', handleAddModelManually);
    elements.modalKeyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showProviderKeyPopover(elements.modalKeyBtn, modelModalProvider);
    });

    // Close model modal on overlay click
    elements.modelModal.addEventListener('click', (e) => {
        if (e.target === elements.modelModal) {
            closeModelModal();
        }
    });

    // Message action buttons (event delegation)
    elements.messagesContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.message-action-btn');
        if (!btn) return;
        const messageDiv = btn.closest('.message');
        if (!messageDiv) return;
        const action = btn.dataset.action;
        const msgIndex = parseInt(messageDiv.dataset.msgIndex, 10);
        if (isNaN(msgIndex)) return;
        handleMessageAction(messageDiv, action, msgIndex);
    });

    // Message input
    elements.messageInput.addEventListener('input', () => {
        updateSendButtonState();
        autoResizeTextarea(elements.messageInput);
    });

    elements.messageInput.addEventListener('keydown', (e) => {
        // Shift+Enter sends; plain Enter inserts a newline. This guards against
        // accidentally firing off a long, multi-paragraph message mid-thought.
        if (e.key === 'Enter' && e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Send button
    elements.sendButton.addEventListener('click', sendMessage);

    // Stop generation button
    elements.stopButton.addEventListener('click', stopGeneration);

    // File attachments
    elements.attachButton.addEventListener('click', () => {
        elements.fileAttachInput.click();
    });

    elements.fileAttachInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFileAttachment(e.target.files);
        }
        e.target.value = ''; // Reset so same file can be re-selected
    });

    // Drag and drop on chat area
    let dragCounter = 0;
    elements.chatArea.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter++;
        elements.dragOverlay.classList.add('visible');
    });

    elements.chatArea.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            elements.dragOverlay.classList.remove('visible');
        }
    });

    elements.chatArea.addEventListener('dragover', (e) => {
        e.preventDefault();
    });

    elements.chatArea.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCounter = 0;
        elements.dragOverlay.classList.remove('visible');
        if (e.dataTransfer.files.length > 0) {
            handleFileAttachment(e.dataTransfer.files);
        }
    });
    
    // Assistant name preview (avatar card + persona-editor page title)
    elements.assistantName.addEventListener('input', () => {
        const name = elements.assistantName.value || 'Assistant';
        elements.avatarPreviewName.textContent = name;
        const editTitle = document.getElementById('personaEditTitle');
        if (editTitle) editTitle.textContent = name;
    });

    // Tagline / role live-update the card preview + their counters. The values
    // themselves are persisted by autoSaveSettings (wired above with the rest
    // of the persona fields).
    elements.personaTagline.addEventListener('input', () => {
        elements.avatarPreviewTagline.textContent = elements.personaTagline.value.trim();
        syncPersonaFieldCounters();
    });
    elements.personaRoleLabel.addEventListener('input', syncPersonaFieldCounters);
}

// ===== File Upload Handlers =====

/**
 * Upload an avatar image to the server. Server stores under
 * data/avatars/{personaId}_avatar.{ext} and updates persona.avatarFilename.
 */
async function handleAvatarUpload(file) {
    if (!file.type.startsWith('image/')) {
        showToast('Please select an image file', { type: 'warning' });
        return;
    }
    // Backend enforces 5MB — match client-side for fast feedback.
    const maxSize = 5 * 1024 * 1024;
    if (file.size > maxSize) {
        showToast('Image is too large. Please select an image under 5MB.', { type: 'warning' });
        return;
    }

    const persona = getActivePersona();
    if (!persona) {
        showToast('No active persona', { type: 'warning' });
        return;
    }

    try {
        await API.avatars.upload(persona.id, file);
        // Server returns { avatarUrl } but not the filename — use a truthy
        // sentinel and bump updatedAt so the cache-busted <img src> reloads.
        persona.avatarFilename = '1';
        persona.updatedAt = Date.now();

        updateAvatarPreview();
        await updateFloatingAvatar();
        // Expression slots without art of their own render the default avatar
        // plus a mood badge, so they're stale the moment the avatar changes.
        await renderExpressionList();
        showNotification('Avatar uploaded!', 'success');
    } catch (error) {
        console.error('Failed to upload avatar:', error);
        displayError(error, { action: 'upload image' });
    }
}

/**
 * Remove the avatar image from the server.
 */
async function clearAvatarImage() {
    const persona = getActivePersona();
    if (!persona) return;

    try {
        if (persona.avatarFilename) {
            await API.avatars.delete(persona.id);
        }
        persona.avatarFilename = '';
        persona.updatedAt = Date.now();
    } catch (err) {
        console.error('Failed to delete avatar:', err);
        displayError(err, { action: 'remove avatar' });
        return;
    }

    updateAvatarPreview();
    await updateFloatingAvatar();
    // Slots falling back to the avatar revert to a bare emoji — repaint them.
    await renderExpressionList();
}

/**
 * Handle expression image upload - stores blob temporarily until expression is saved
 */
async function handleExpressionImageUpload(file) {
    // Validate file type
    if (!file.type.startsWith('image/')) {
        showToast('Please select an image file', { type: 'warning' });
        return;
    }

    // Validate file size (max 2MB for expressions with IndexedDB)
    const maxSize = 2 * 1024 * 1024;
    if (file.size > maxSize) {
        showToast('Image is too large. Please select an image under 2MB.', { type: 'warning' });
        return;
    }

    try {
        // Revoke old preview URL if exists
        if (state.tempExpressionPreviewUrl) {
            URL.revokeObjectURL(state.tempExpressionPreviewUrl);
        }

        const blob = await ImageStore.fileToBlob(file);
        state.tempExpressionBlob = blob;
        state.tempExpressionPreviewUrl = URL.createObjectURL(blob);

        // Update preview in modal
        elements.expressionImagePreview.innerHTML = `<img src="${state.tempExpressionPreviewUrl}" alt="Expression preview">`;

    } catch (error) {
        console.error('Failed to upload expression image:', error);
        displayError(error, { action: 'upload image' });
    }
}

/**
 * Clear the expression image in the modal
 */
function clearExpressionImage() {
    // Revoke preview URL if exists
    if (state.tempExpressionPreviewUrl) {
        URL.revokeObjectURL(state.tempExpressionPreviewUrl);
    }
    state.tempExpressionBlob = null;
    state.tempExpressionPreviewUrl = '';
    // Mark that user explicitly cleared the image (use special marker)
    state.tempExpressionCleared = true;
    elements.expressionImagePreview.innerHTML = '<span class="preview-placeholder">No image</span>';
}

// ===== Sidebar Functions =====
function createSidebarOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    overlay.id = 'sidebarOverlay';
    document.body.appendChild(overlay);
    
    overlay.addEventListener('click', closeSidebar);
}

function openSidebar() {
    elements.sidebar.classList.add('open');
    const overlay = document.getElementById('sidebarOverlay');
    if (overlay) overlay.classList.add('visible');
}

function closeSidebar() {
    elements.sidebar.classList.remove('open');
    const overlay = document.getElementById('sidebarOverlay');
    if (overlay) overlay.classList.remove('visible');
}

// Drag the handle on the sidebar's right edge to resize it (desktop only).
// Width is clamped, persisted per-device, and reset on double-click. Persists
// once at gesture end (not on every move) to avoid storage thrash.
function setupSidebarResize() {
    const handle = document.getElementById('sidebarResizeHandle');
    if (!handle) return;

    const MIN_W = 240;
    const maxW = () => Math.min(640, Math.round(window.innerWidth * 0.5));
    const clamp = (w) => Math.max(MIN_W, Math.min(maxW(), Math.round(w)));

    let dragging = false;
    let startX = 0;
    let startW = 0;
    let currentW = UiPrefs.get('sidebarWidth') || 320;

    const applyLive = (w) => {
        currentW = clamp(w);
        document.documentElement.style.setProperty('--sidebar-width', `${currentW}px`);
    };

    handle.addEventListener('pointerdown', (e) => {
        dragging = true;
        startX = e.clientX;
        // Measure the rendered width (honors the min(var, 85vw) cap).
        startW = elements.sidebar.getBoundingClientRect().width;
        handle.classList.add('dragging');
        try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        e.preventDefault();
    });

    handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        applyLive(startW + (e.clientX - startX)); // drag right widens
    });

    const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove('dragging');
        try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        UiPrefs.set('sidebarWidth', currentW); // persist once, at gesture end
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);

    handle.addEventListener('dblclick', () => {
        applyLive(UiPrefs.defaults.sidebarWidth);
        UiPrefs.set('sidebarWidth', currentW);
    });
}

// ===== Utility Functions =====
function autoResizeTextarea(textarea) {
    // Grow to fit content; CSS max-height caps it (then the textarea scrolls).
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
}

// Wire the themed bottom drag-bars that replace the native textarea grip.
// Each `.textarea-resize-handle` resizes the textarea immediately before it.
// Idempotent (skips already-wired handles): called once at init for the static
// forms, and again whenever a view renders a fresh handle (container pages).
// Dragged heights persist in UiPrefs (keyed by textarea id) so re-rendered
// textareas — e.g. container-page Instructions — keep their size, matching the
// static settings-modal ones.
function setupTextareaResizers() {
    const MIN_H = 80;
    const MAX_H = 600;
    const savedHeights = UiPrefs.get('textareaHeights') || {};
    document.querySelectorAll('.textarea-resize-handle').forEach(handle => {
        const ta = handle.previousElementSibling;
        if (!ta || ta.tagName !== 'TEXTAREA') return;
        if (handle.dataset.resizerWired) return;
        handle.dataset.resizerWired = 'true';

        if (ta.id && savedHeights[ta.id]) {
            ta.style.height = `${Math.max(MIN_H, Math.min(MAX_H, savedHeights[ta.id]))}px`;
        }

        let dragging = false;
        let startY = 0;
        let startH = 0;

        handle.addEventListener('pointerdown', (e) => {
            dragging = true;
            startY = e.clientY;
            startH = ta.getBoundingClientRect().height;
            handle.classList.add('dragging');
            try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
            e.preventDefault();
        });

        handle.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const h = Math.max(MIN_H, Math.min(MAX_H, startH + (e.clientY - startY)));
            ta.style.height = `${h}px`;
        });

        const end = (e) => {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('dragging');
            try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
            if (ta.id) {
                const heights = { ...(UiPrefs.get('textareaHeights') || {}) };
                heights[ta.id] = Math.round(ta.getBoundingClientRect().height);
                UiPrefs.set('textareaHeights', heights);
            }
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    });
}

async function clearConversation() {
    const ok = await confirmDialog({
        title: 'Clear this conversation?',
        body: "Every message in this chat will be removed and the chat reset to a new one. This can't be undone.",
        confirmLabel: 'Clear',
        danger: true,
    });
    if (!ok) return;

    // Clear the active conversation's messages
    const activeConvo = getActiveConversation();
    if (activeConvo) {
        activeConvo.messages = [];
        activeConvo.title = 'New Chat';
        activeConvo.updatedAt = Date.now();
        saveConversations();
    }

    state.estimatedTokens = 0;
    state.currentExpression = 'neutral';
    renderConversation();
    updateStatusBar();
    await updateFloatingAvatar();
    closeSidebar();
}

// ===== Auth Gate (P0-14) =====
// Decides whether to show the login screen or the main app on page load.
// init() (P0-15) loads all data from the server before rendering — see init.

const OAUTH_ERROR_MESSAGES = {
    oauth_denied: 'Sign-in was cancelled. Please try again to continue.',
    invalid_state: 'Sign-in security check failed. Please try again.',
    no_code: 'Sign-in did not complete. Please try again.',
    oauth_failed: 'Sign-in failed. Please try again in a moment.',
    session_expired: 'Your session expired. Please sign in again.',
    init_failed: 'Could not load the app. Your browser data may be unavailable — try a different browser or clear this site\'s data.',
};

function showLoginScreen(errorMessage) {
    const loginScreen = document.getElementById('loginScreen');
    const appContainer = document.getElementById('appContainer');
    const errorEl = document.getElementById('loginError');

    if (errorEl) {
        if (errorMessage) {
            errorEl.textContent = errorMessage;
            errorEl.hidden = false;
        } else {
            errorEl.textContent = '';
            errorEl.hidden = true;
        }
    }

    if (appContainer) appContainer.hidden = true;
    if (loginScreen) loginScreen.hidden = false;
}

function showApp() {
    const loginScreen = document.getElementById('loginScreen');
    const appContainer = document.getElementById('appContainer');
    if (loginScreen) loginScreen.hidden = true;
    if (appContainer) appContainer.hidden = false;
    updateAccountInfo();
}

function updateAccountInfo() {
    const el = document.getElementById('accountInfo');
    if (!el) return;
    if (state.user) {
        const label = state.user.displayName || state.user.email || 'Signed in';
        el.textContent = state.user.email
            ? `${label} (${state.user.email})`
            : label;
    } else {
        el.textContent = 'Signed in';
    }
}

function handleLoginClick() {
    const btn = document.getElementById('googleSignInBtn');
    if (btn) btn.disabled = true;
    window.location.href = API.auth.getGoogleLoginUrl();
}

/**
 * DEV-ONLY: sign in as a local stub user via the dev-login bypass, then reload
 * so bootstrap picks up the new session. Only reachable when the server has
 * ALLOW_DEV_LOGIN enabled (the button is hidden otherwise).
 */
async function handleDevLoginClick() {
    const btn = document.getElementById('devLoginBtn');
    if (btn) btn.disabled = true;
    try {
        await API.auth.devLogin();
    } catch (err) {
        console.error('Dev login failed:', err);
        if (btn) btn.disabled = false;
        showLoginScreen('Dev login failed. Is ALLOW_DEV_LOGIN=true set on the server?');
        return;
    }
    // Full navigation so bootstrap re-runs against the new session cookie.
    window.location.href = '/?auth=success';
}

async function handleLogoutClick() {
    const btn = document.getElementById('logoutBtn');
    if (btn) btn.disabled = true;
    try {
        await API.auth.logout();
    } catch (err) {
        // Even if the server call fails, complete the logout client-side
        // by reloading. The cookie is httpOnly, so we can't clear it from
        // JS — but the reload at least resets all in-memory state.
        console.warn('Logout request failed:', err);
    }
    // Hard reload to fully tear down session-owned client state:
    // - Aborts any in-flight chat stream (fetch is cancelled on navigation)
    // - Drops in-memory state.personas / state.conversations / etc.
    // - Closes the ImageStore IndexedDB connection (and its blob URLs)
    // The server-side cookie has been cleared (or was already invalid),
    // so the reload lands on the login screen.
    window.location.href = '/';
}

/**
 * Parse and clear OAuth-related query params from the URL.
 * Returns an error message to display, if any.
 */
function consumeAuthCallbackParams() {
    const params = new URLSearchParams(window.location.search);
    const error = params.get('error');
    const authStatus = params.get('auth');

    if (!error && !authStatus) return null;

    // Strip auth-related params from the URL so refreshes don't re-process them.
    params.delete('auth');
    params.delete('error');
    const remaining = params.toString();
    const cleanUrl = window.location.pathname
        + (remaining ? `?${remaining}` : '')
        + window.location.hash;
    window.history.replaceState({}, document.title, cleanUrl);

    if (error) {
        return OAUTH_ERROR_MESSAGES[error] || 'Sign-in failed. Please try again.';
    }
    return null;
}

/**
 * Bootstrap entry point. Runs before init().
 * Decides between login screen and main app based on session state.
 */
async function bootstrap() {
    // Apply device-local appearance prefs (theme/accent/chat width/sidebar) as
    // early as possible so the login screen and app render in the chosen theme
    // without a flash of the default.
    UiPrefs.apply();

    // Wire static event listeners that exist regardless of auth state.
    const loginBtn = document.getElementById('googleSignInBtn');
    if (loginBtn) loginBtn.addEventListener('click', handleLoginClick);

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', handleLogoutClick);

    // Reveal the dev-login button only when the server reports the bypass is
    // enabled (development + ALLOW_DEV_LOGIN). Non-fatal: a failed probe just
    // leaves the button hidden, so normal Google sign-in is unaffected.
    try {
        const authConfig = await API.auth.config();
        if (authConfig && authConfig.devLogin) {
            const devBtn = document.getElementById('devLoginBtn');
            if (devBtn) {
                devBtn.hidden = false;
                devBtn.addEventListener('click', handleDevLoginClick);
            }
        }
    } catch (err) {
        console.warn('Auth config probe failed:', err);
    }

    // If any future API call returns 401 (e.g., JWT expired), kick back to login.
    // We navigate via window.location to fully reset client state — an in-place
    // transition would leave streams, intervals, and IndexedDB state running.
    API.setOn401Handler(() => {
        // Skip if there's no active session — this would otherwise loop while
        // we're already on the login screen (e.g., a stray pre-auth request).
        if (!state.user) return;
        state.user = null;
        window.location.href = '/?error=session_expired';
    });

    // Handle redirect from the OAuth callback. If there was an error, show it.
    const callbackError = consumeAuthCallbackParams();

    // Check session via the non-throwing status endpoint.
    let authenticated = false;
    try {
        const status = await API.auth.status();
        if (status && status.authenticated) {
            state.user = status.user;
            authenticated = true;
        }
    } catch (err) {
        // status() should not normally throw, but if it does (network blip),
        // fall through to the login screen.
        console.warn('Auth status check failed:', err);
    }

    if (authenticated) {
        showApp();
        try {
            await init();
        } catch (err) {
            // Common causes: IndexedDB blocked in private browsing, a failing
            // server fetch in one of the parallel /api/* calls during init.
            // Hide the now-broken app shell and surface a diagnostic prompt on
            // the login screen.
            // Clear the auth cookie so the user isn't stuck in a loop: with the
            // cookie intact, refreshing or signing in again auto-resumes the
            // same broken session because Google OAuth re-grants the existing
            // consent silently. Clearing forces an explicit re-auth and makes
            // a persistent browser-data issue visible rather than cyclic.
            console.error('App initialization failed:', err);
            state.user = null;
            try {
                await API.auth.logout();
            } catch (logoutErr) {
                console.warn('Failed to clear session after init failure:', logoutErr);
            }
            showLoginScreen(OAUTH_ERROR_MESSAGES.init_failed);
        }
    } else {
        showLoginScreen(callbackError);
    }
}

// ===== Start the App =====
document.addEventListener('DOMContentLoaded', bootstrap);
