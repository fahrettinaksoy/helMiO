import 'vuetify/styles';
import '@mdi/font/css/materialdesignicons.css';
import { createVuetify } from 'vuetify';
import { aliases, mdi } from 'vuetify/iconsets/mdi';
import { createVueI18nAdapter } from 'vuetify/locale/adapters/vue-i18n';
import { useI18n } from 'vue-i18n';
import i18n from '@/i18n';

// ── THEME ───────────────────────────────────────────────────────────
// https://vuetifyjs.com/en/features/theme/
// Two themes keyed by Vuetify's conventional names ('dark' / 'light') so
// blueprints and component internals that assume those names line up.
const dark = {
  dark: true,
  colors: {
    background: '#0e1116',
    surface: '#161a22',
    'surface-bright': '#1c2129',
    primary: '#4f8cff',
    secondary: '#8aa0b8',
    accent: '#aa6eff',
    error: '#ef4f5a',
    warning: '#f0a830',
    info: '#54a0ff',
    success: '#4ad9a4',
  },
};

const light = {
  dark: false,
  colors: {
    background: '#f4f6fb',
    surface: '#ffffff',
    'surface-bright': '#ffffff',
    primary: '#2563eb',
    secondary: '#475569',
    accent: '#7c3aed',
    error: '#dc2626',
    warning: '#d97706',
    info: '#2563eb',
    success: '#059669',
  },
};

/**
 * Initial theme:
 *   1. saved choice in localStorage ('helmio-theme')   — incl. legacy names
 *   2. browser preference (prefers-color-scheme)
 *   3. fall back to dark
 */
function detectTheme() {
  try {
    const saved = localStorage.getItem('helmio-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    // migrate the pre-rename values written by older builds
    if (saved === 'helmioLight') return 'light';
    if (saved === 'helmioDark') return 'dark';
  } catch {
    /* ignore */
  }
  if (
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: light)').matches
  ) {
    return 'light';
  }
  return 'dark';
}

export default createVuetify({
  // ── ICONS ─────────────────────────────────────────────────────────
  // https://vuetifyjs.com/en/features/icon-fonts/
  // Explicit mdi font set + aliases (powers component default icons like
  // the data-table sort arrow, clearable "x", etc.).
  icons: {
    defaultSet: 'mdi',
    aliases,
    sets: { mdi },
  },

  // ── DISPLAY & PLATFORM ────────────────────────────────────────────
  // https://vuetifyjs.com/en/features/display-and-platform/
  // Treat md and below as "mobile" so the navigation drawer is temporary
  // on tablets/phones. Thresholds are Vuetify defaults, left implicit.
  display: {
    mobileBreakpoint: 'md',
  },

  // ── LOCALE ────────────────────────────────────────────────────────
  // https://vuetifyjs.com/en/features/internationalization/
  // Route Vuetify's own component strings ($vuetify.* keys) through the
  // app's vue-i18n instance, so switching language localizes built-in
  // component text (data-table footer, pagination, "no data", …) too.
  locale: {
    adapter: createVueI18nAdapter({ i18n, useI18n }),
  },

  theme: {
    defaultTheme: detectTheme(),
    themes: { dark, light },
  },

  // ── GLOBAL CONFIGURATION (defaults) ───────────────────────────────
  // https://vuetifyjs.com/en/features/global-configuration/
  // Project-wide default props so components don't repeat the same
  // variant/density everywhere. Explicit props on a component always win.
  defaults: {
    // Filled `surface` panels (not transparent/outlined). Against the page's
    // darker `background` tone (set on PageShell) they read as raised cards —
    // the Material tonal-surface hierarchy. `hover` adds depth on interaction.
    VCard: { rounded: 'lg', variant: 'flat' },
    VBtn: { rounded: 'md' },
    VTextField: { variant: 'outlined', density: 'comfortable', hideDetails: 'auto' },
    VSelect: { variant: 'outlined', density: 'comfortable', hideDetails: 'auto' },
    VAutocomplete: { variant: 'outlined', density: 'comfortable', hideDetails: 'auto' },
    VCombobox: { variant: 'outlined', density: 'comfortable', hideDetails: 'auto' },
    VTextarea: { variant: 'outlined', density: 'comfortable' },
    VList: { density: 'compact' },
    VDataTable: { density: 'comfortable', hover: true, fixedHeader: true },
    VAlert: { variant: 'tonal', density: 'comfortable' },
    VTooltip: { location: 'bottom' },
  },
});
