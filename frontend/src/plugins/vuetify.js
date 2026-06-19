import 'vuetify/styles';
import '@mdi/font/css/materialdesignicons.css';
import { createVuetify } from 'vuetify';

const helmioDark = {
  dark: true,
  colors: {
    background: '#0e1116',
    surface: '#171b22',
    'surface-variant': '#232a34',
    primary: '#4f7cff',
    secondary: '#7c5cff',
    success: '#2ecc71',
    warning: '#f5a623',
    error: '#ff5252',
    info: '#3aa0ff',
  },
};

const helmioLight = {
  dark: false,
  colors: {
    background: '#f4f6fb',
    surface: '#ffffff',
    'surface-variant': '#eceff5',
    primary: '#3a5fe0',
    secondary: '#6a4ce0',
    success: '#1ea85a',
    warning: '#d98a0b',
    error: '#e03b3b',
    info: '#2b86e0',
  },
};

/**
 * Initial theme:
 *   1. saved choice in localStorage ('helmio-theme')
 *   2. browser preference (prefers-color-scheme)
 *   3. fall back to dark
 */
function detectTheme() {
  try {
    const saved = localStorage.getItem('helmio-theme');
    if (saved === 'helmioLight' || saved === 'helmioDark') return saved;
  } catch { /* ignore */ }
  if (typeof window !== 'undefined' && window.matchMedia
    && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'helmioLight';
  }
  return 'helmioDark';
}

export default createVuetify({
  theme: {
    defaultTheme: detectTheme(),
    themes: { helmioDark, helmioLight },
  },
  defaults: {
    VCard: { rounded: 'lg' },
    VBtn: { rounded: 'md' },
  },
});
