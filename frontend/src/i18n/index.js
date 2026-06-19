import { createI18n } from 'vue-i18n';
import en from './locales/en.json';
import tr from './locales/tr.json';

export const SUPPORTED = ['en', 'tr'];

/**
 * Resolve the initial locale:
 *   1. saved choice in localStorage ('helmio-lang')
 *   2. browser language (navigator.language)
 *   3. fall back to English
 */
export function detectLocale() {
  try {
    const saved = localStorage.getItem('helmio-lang');
    if (SUPPORTED.includes(saved)) return saved;
  } catch { /* localStorage unavailable */ }
  const nav = (navigator.language || navigator.userLanguage || '').toLowerCase();
  if (nav.startsWith('tr')) return 'tr';
  return 'en';
}

const initialLocale = detectLocale();

const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: initialLocale,
  fallbackLocale: 'en',
  messages: { en, tr },
});

// Keep <html lang> in sync (a11y + locale-correct CSS text-transform).
function syncDocumentLang(code) {
  if (typeof document !== 'undefined') document.documentElement.lang = code;
}
syncDocumentLang(initialLocale);

export function setLocale(code) {
  if (!SUPPORTED.includes(code)) return;
  i18n.global.locale.value = code;
  syncDocumentLang(code);
  try {
    localStorage.setItem('helmio-lang', code);
  } catch { /* ignore */ }
}

export default i18n;
