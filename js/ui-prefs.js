/**
 * Device-local preferences and appearance (R-02, moved verbatim from main.js).
 *
 * `UiPrefs` is the localStorage-backed store for settings that are per-device
 * rather than per-account (theme, sidebar/chat width, dev mode) — a phone and a
 * desktop genuinely want different answers. The theme and OKLCH palette engine
 * travel with it because they are the machinery it drives.
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

export function applyTheme(name) {
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
export function withThemeTransition(fn) {
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

export function applyChatWidth(name) {
    const px = CHAT_WIDTHS[name] || CHAT_WIDTHS.comfortable;
    document.documentElement.style.setProperty('--chat-max-width', `${px}px`);
}

// Reflect current appearance prefs into the settings-modal controls.
export function syncAppearanceControls() {
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

