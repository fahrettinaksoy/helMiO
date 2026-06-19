import i18n from '@/i18n';

const t = (key, params) => i18n.global.t(key, params);

// Map Supervisor state names to Vuetify colors + icons for chips.
export const STATE_STYLE = {
  RUNNING: { color: 'success', icon: 'mdi-play-circle' },
  STARTING: { color: 'info', icon: 'mdi-progress-clock' },
  STOPPING: { color: 'warning', icon: 'mdi-progress-clock' },
  STOPPED: { color: 'grey', icon: 'mdi-stop-circle' },
  EXITED: { color: 'grey', icon: 'mdi-exit-to-app' },
  BACKOFF: { color: 'warning', icon: 'mdi-alert-circle' },
  FATAL: { color: 'error', icon: 'mdi-close-circle' },
  UNKNOWN: { color: 'grey-darken-1', icon: 'mdi-help-circle' },
};

export function stateStyle(statename) {
  return STATE_STYLE[statename] || STATE_STYLE.UNKNOWN;
}

/** Seconds -> compact uptime, localized unit suffixes. */
export function formatUptime(seconds) {
  if (!seconds || seconds <= 0) return '—';
  const u = (k) => t(`format.uptime.${k}`);
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d) parts.push(`${d}${u('d')}`);
  if (h) parts.push(`${h}${u('h')}`);
  if (m) parts.push(`${m}${u('m')}`);
  if (!d && !h) parts.push(`${s}${u('s')}`);
  return parts.join(' ');
}

export function formatRelative(ts) {
  if (!ts) return '—';
  const diff = Math.round((Date.now() - ts) / 1000);
  if (diff < 5) return t('format.justNow');
  if (diff < 60) return t('format.secondsAgo', { n: diff });
  if (diff < 3600) return t('format.minutesAgo', { n: Math.floor(diff / 60) });
  const locale = i18n.global.locale.value === 'tr' ? 'tr-TR' : 'en-US';
  return new Date(ts).toLocaleTimeString(locale);
}

/** Epoch seconds -> localized short date-time, or em dash. */
export function formatDateTime(sec) {
  if (!sec) return '—';
  const locale = i18n.global.locale.value === 'tr' ? 'tr-TR' : 'en-US';
  return new Date(sec * 1000).toLocaleString(locale, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** Localized label for a connection method id. */
export function methodLabel(method) {
  const key = `methods.${method}`;
  const label = t(key);
  return label === key ? method : label;
}
