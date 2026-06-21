<script setup>
import { computed, onMounted, onBeforeUnmount, watch, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServersStore } from '@/stores/servers';
import { useRealtimeStore } from '@/stores/realtime';
import { useAuthStore } from '@/stores/auth';
import { methodLabel, formatRelative, stateStyle } from '@/utils/format';
import { overviewApi, serversApi, channelsApi, auditApi, usersApi, apiTokensApi } from '@/api/client';
import PageShell from '@/components/PageShell.vue';
import TrendChart from '@/components/TrendChart.vue';
import DonutChart from '@/components/DonutChart.vue';
import { useFitHeight } from '@/composables/useFitHeight';

const { t } = useI18n();
const serversStore = useServersStore();
const realtime = useRealtimeStore();
const auth = useAuthStore();

// Fit the dashboard body to the viewport so the page itself never scrolls.
const wrap = ref(null);
const { height } = useFitHeight(wrap, { bottom: 12 });

// ---- realtime subscriptions for every server ----
let subscribed = [];
function syncSubscriptions() {
  const ids = serversStore.servers.map((s) => s.id);
  subscribed.forEach((id) => { if (!ids.includes(id)) realtime.unsubscribe(id); });
  ids.forEach((id) => { if (!subscribed.includes(id)) realtime.subscribe(id); });
  subscribed = ids;
}

// ---- overview (metrics + health) + admin/version data ----
const overview = ref(null);
const versions = ref({}); // version -> count
const channels = ref([]);
const auditItems = ref([]);
const users = ref([]);
const tokens = ref([]);
let timer = null;

async function loadOverview() {
  try { overview.value = await overviewApi.get(60); } catch { /* keep prior */ }
}
async function loadVersions() {
  const entries = await Promise.all(serversStore.servers.map(async (s) => {
    try { return (await serversApi.daemon(s.id)).version; } catch { return null; }
  }));
  const counts = {};
  for (const v of entries) { if (v) counts[v] = (counts[v] || 0) + 1; }
  versions.value = counts;
}
async function loadAdmin() {
  if (!auth.isAdmin) return;
  loadVersions();
  try { channels.value = await channelsApi.list(); } catch { /* ignore */ }
  try { auditItems.value = (await auditApi.query({ limit: 200 })).items || []; } catch { /* ignore */ }
  try { users.value = await usersApi.list(); } catch { /* ignore */ }
  try { tokens.value = await apiTokensApi.list(); } catch { /* ignore */ }
}

async function refresh() {
  await serversStore.fetchAll();
  syncSubscriptions();
  loadOverview();
  loadAdmin();
}

onMounted(async () => {
  if (!serversStore.servers.length) await serversStore.fetchAll();
  syncSubscriptions();
  loadOverview();
  loadAdmin();
  timer = setInterval(loadOverview, 30000);
});
onBeforeUnmount(() => {
  subscribed.forEach((id) => realtime.unsubscribe(id));
  if (timer) clearInterval(timer);
});
watch(() => serversStore.servers.map((s) => s.id).join(','), syncSubscriptions);

// ---- aggregate figures ----
const agg = computed(() => {
  let total = 0, running = 0, stopped = 0, fatal = 0, other = 0, online = 0;
  for (const s of serversStore.servers) {
    const snap = realtime.snapshots[s.id];
    if (!snap) continue;
    online += 1;
    total += snap.summary.total; running += snap.summary.running;
    stopped += snap.summary.stopped; fatal += snap.summary.fatal; other += snap.summary.other;
  }
  return { servers: serversStore.servers.length, online, total, running, stopped, fatal, other };
});
const healthPct = computed(() => (agg.value.total ? Math.round((agg.value.running / agg.value.total) * 100) : 0));

function segmentsOf({ running = 0, other = 0, stopped = 0, fatal = 0 }) {
  return [
    { key: t('common.running'), color: 'success', value: running },
    { key: t('common.other'), color: 'warning', value: other },
    { key: t('common.stopped'), color: 'grey', value: stopped },
    { key: t('common.fatal'), color: 'error', value: fatal },
  ].filter((x) => x.value > 0);
}
const fleetSegments = computed(() => segmentsOf(agg.value));

const kpis = computed(() => [
  { key: 'servers', icon: 'mdi-server', color: 'primary', value: `${agg.value.online}/${agg.value.servers}`, label: t('dashboard.serversOnline') },
  { key: 'total', icon: 'mdi-format-list-bulleted', color: 'info', value: agg.value.total, label: t('dashboard.totalProcesses') },
  { key: 'running', icon: 'mdi-play-circle', color: 'success', value: agg.value.running, label: t('common.running') },
  { key: 'issues', icon: 'mdi-alert-circle', color: 'error', value: agg.value.fatal, label: t('dashboard.issues'), alert: agg.value.fatal > 0 },
]);

// ---- all processes flattened (for problem / consumers / unstable) ----
const allProcesses = computed(() => {
  const out = [];
  for (const s of serversStore.servers) {
    const snap = realtime.snapshots[s.id];
    if (!snap) continue;
    for (const p of snap.processes || []) out.push({ ...p, serverId: s.id, serverName: s.name });
  }
  return out;
});

const SEVERITY = { FATAL: 3, BACKOFF: 2, UNKNOWN: 1 };
const problemProcesses = computed(() =>
  allProcesses.value
    .filter((p) => SEVERITY[p.statename])
    .sort((a, b) => (SEVERITY[b.statename] || 0) - (SEVERITY[a.statename] || 0))
    .slice(0, 8)
);
const topConsumers = computed(() =>
  allProcesses.value
    .filter((p) => typeof p.cpu === 'number')
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, 6)
);
const unstable = computed(() =>
  allProcesses.value
    .filter((p) => p.flapping || (p.restarts || 0) > 0)
    .sort((a, b) => (b.restarts || 0) - (a.restarts || 0))
    .slice(0, 6)
);

// ---- distributions ----
const METHOD_COLOR = { tcp: 'primary', local: 'secondary', ssh: 'info', docker: 'warning', agent: 'success' };
const methodSegments = computed(() => {
  const counts = {};
  for (const s of serversStore.servers) counts[s.method] = (counts[s.method] || 0) + 1;
  return Object.entries(counts).map(([m, v]) => ({ key: methodLabel(m), color: METHOD_COLOR[m] || 'grey', value: v }));
});

// ---- activity over the last 24h (hourly buckets) ----
// Admins see audit actions + live alerts merged; other roles fall back to alerts.
const activity = computed(() => {
  const HOUR = 3600000;
  const now = Date.now();
  const currentHour = new Date(now).getHours();
  // bucket i = (23 - i) hours ago; label is its clock hour-of-day
  const buckets = Array.from({ length: 24 }, (_, i) => ({
    hour: ((currentHour - (23 - i)) % 24 + 24) % 24,
    count: 0,
  }));
  const stamps = realtime.alerts.map((a) => a.at);
  if (auth.isAdmin) for (const a of auditItems.value) stamps.push(Date.parse(a.at));
  for (const at of stamps) {
    const hoursAgo = Math.floor((now - at) / HOUR);
    if (hoursAgo >= 0 && hoursAgo < 24) buckets[23 - hoursAgo].count += 1;
  }
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  return { buckets, total, max: Math.max(1, ...buckets.map((b) => b.count)) };
});
const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;

// ---- metrics trend + hosts ----
const cpuSeries = computed(() => [{ name: 'CPU', color: '#f5a623', points: (overview.value?.metrics.series || []).map((s) => ({ at: s.at, v: s.cpu })) }]);
const memSeries = computed(() => [{ name: t('dashboard.memory'), color: '#7c5cff', points: (overview.value?.metrics.series || []).map((s) => ({ at: s.at, v: s.mem })) }]);
const hasTrend = computed(() => (overview.value?.metrics.series || []).some((s) => s.cpu != null || s.mem != null));
const diskWarnings = computed(() => (overview.value?.metrics.hosts || []).filter((h) => h.diskPct != null && h.diskPct >= 85).sort((a, b) => b.diskPct - a.diskPct));

// ---- recent activity (alerts) ----
const ALERT_META = {
  fatal: { color: 'error', icon: 'mdi-close-circle' },
  flapping: { color: 'warning', icon: 'mdi-restart-alert' },
  healthcheck: { color: 'warning', icon: 'mdi-heart-broken' },
};
const recentAlerts = computed(() =>
  realtime.alerts.slice().reverse().slice(0, 10).map((a) => ({
    ...a, server: serversStore.byId(a.serverId)?.name || a.serverId, meta: ALERT_META[a.type] || { color: 'grey', icon: 'mdi-bell' },
  }))
);
function alertText(a) { return t(`alert.${a.type}`, { name: a.fullName, server: a.server }); }

// ---- admin computeds ----
const channelStatus = computed(() => ({
  total: channels.value.length,
  enabled: channels.value.filter((c) => c.enabled).length,
  errors: channels.value.filter((c) => c.lastError).length,
}));
const actionsToday = computed(() => {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const today = auditItems.value.filter((a) => new Date(a.at) >= start);
  const cat = (action) => (/(start|stop|restart|signal)/.test(action) ? 'control' : /config|program/.test(action) ? 'config' : /login|user|token|channel|healthcheck|eventlistener/.test(action) ? 'admin' : 'other');
  const counts = { control: 0, config: 0, admin: 0 };
  for (const a of today) { const c = cat(a.action); if (counts[c] != null) counts[c] += 1; }
  return { total: today.length, ...counts };
});
const roleCounts = computed(() => {
  const c = { admin: 0, operator: 0, viewer: 0 };
  for (const u of users.value) if (c[u.role] != null) c[u.role] += 1;
  return c;
});
const versionList = computed(() => Object.entries(versions.value).sort((a, b) => b[1] - a[1]));
const tokenStats = computed(() => ({
  total: tokens.value.length,
  unused: tokens.value.filter((tk) => !tk.lastUsedAt).length,
}));

const stStyle = (n) => stateStyle(n);
</script>

<template>
  <PageShell :title="t('dashboard.title')" icon="mdi-view-dashboard-outline">
    <template #hero-actions>
      <v-chip color="white" variant="tonal" size="small" class="me-1">{{ t('dashboard.onlineChip', { online: agg.online, total: agg.servers }) }}</v-chip>
      <v-btn icon="mdi-refresh" variant="text" @click="refresh" />
    </template>

    <!-- Empty state -->
    <v-card v-if="!serversStore.servers.length && !serversStore.loading" variant="flat" class="surface-card pa-12 text-center">
      <v-icon icon="mdi-server-off" size="48" class="text-medium-emphasis mb-3" />
      <div class="text-h6">{{ t('dashboard.noServers') }}</div>
      <div class="text-medium-emphasis mb-4">{{ t('dashboard.noServersSub') }}</div>
      <v-btn color="primary" prepend-icon="mdi-plus" to="/servers">{{ t('dashboard.addServer') }}</v-btn>
    </v-card>

    <div v-else ref="wrap" class="dash-fit" :style="{ height: height + 'px' }">
      <!-- Row 1: compact KPIs + fleet health (merged) -->
      <div class="top-row">
        <div class="kpi-grid">
          <div v-for="k in kpis" :key="k.key" class="surface-card kpi" :class="{ 'kpi-alert': k.alert }">
            <div class="kpi-icon" :style="{ '--c': `var(--v-theme-${k.color})` }"><v-icon :icon="k.icon" size="18" /></div>
            <div class="min-w-0"><div class="kpi-value">{{ k.value }}</div><div class="kpi-label text-truncate">{{ k.label }}</div></div>
          </div>
        </div>
        <v-card variant="flat" class="surface-card pa-4 fleet-card">
          <div class="d-flex align-center mb-2">
            <v-icon icon="mdi-heart-pulse" size="18" class="me-2 text-medium-emphasis" />
            <span class="text-subtitle-2 font-weight-medium">{{ t('dashboard.fleetHealth') }}</span>
            <v-spacer />
            <span class="text-h6 font-weight-bold" :class="healthPct >= 90 ? 'text-success' : healthPct >= 50 ? 'text-warning' : 'text-error'">{{ healthPct }}%</span>
            <span class="text-caption text-medium-emphasis ms-1">{{ t('dashboard.healthy') }}</span>
          </div>
          <div class="seg-bar">
            <div v-for="seg in fleetSegments" :key="seg.key" class="seg" :style="{ width: `${(seg.value / agg.total) * 100}%`, background: `rgb(var(--v-theme-${seg.color}))` }" />
            <div v-if="!fleetSegments.length" class="seg seg-empty" />
          </div>
          <div class="d-flex flex-wrap ga-4 mt-2">
            <div v-for="seg in fleetSegments" :key="seg.key" class="legend">
              <span class="legend-dot" :style="{ background: `rgb(var(--v-theme-${seg.color}))` }" />
              <span class="text-caption">{{ seg.key }}</span><span class="text-caption font-weight-bold ms-1">{{ seg.value }}</span>
            </div>
          </div>
        </v-card>
      </div>

      <!-- Alerts (only when present) -->
      <v-alert v-if="overview?.health.failingList.length" type="error" variant="tonal" density="compact" class="mt-3" icon="mdi-heart-broken">
        <span class="font-weight-medium">{{ t('dashboard.failingChecks') }}:</span>
        <span v-for="f in overview.health.failingList" :key="f.serverName + f.target" class="ms-2">{{ f.serverName }}/<b>{{ f.target }}</b><span v-if="f.error" class="text-medium-emphasis"> ({{ f.error }})</span></span>
      </v-alert>
      <v-alert v-if="diskWarnings.length" type="warning" variant="tonal" density="compact" class="mt-3" icon="mdi-harddisk">
        <span class="font-weight-medium">{{ t('dashboard.diskWarnings') }}:</span>
        <span v-for="d in diskWarnings" :key="d.serverId" class="ms-2">{{ d.name }} <b>%{{ d.diskPct }}</b></span>
      </v-alert>

      <!-- Insight grid: only data-bearing cards are rendered -->
      <div class="text-overline text-medium-emphasis mt-3 mb-1">{{ t('dashboard.insights') }}</div>
      <div class="insight-grid">
        <!-- Problem processes -->
        <v-card variant="flat" class="surface-card insight-card">
          <div class="ac-head">
            <span class="ac-icon" :style="{ '--c': 'var(--v-theme-error)' }"><v-icon icon="mdi-alert-circle" size="17" /></span>
            <span class="ac-title">{{ t('dashboard.problemProcesses') }}</span>
            <span v-if="problemProcesses.length" class="ac-count ac-count--error">{{ problemProcesses.length }}</span>
          </div>
          <div v-if="!problemProcesses.length" class="empty-mini flex-grow-1"><v-icon icon="mdi-check-circle-outline" color="success" size="20" /> {{ t('dashboard.noProblems') }}</div>
          <div v-else class="card-scroll">
            <router-link v-for="p in problemProcesses" :key="p.serverId + p.fullName" :to="`/servers/${p.serverId}`" class="row-item">
              <v-chip :color="stStyle(p.statename).color" size="x-small" variant="flat" label class="me-2">{{ p.statename }}</v-chip>
              <div class="min-w-0 flex-grow-1"><div class="ri-title text-truncate">{{ p.fullName }}</div><div class="ri-sub text-truncate">{{ p.serverName }}<template v-if="p.spawnerr"> · {{ p.spawnerr }}</template></div></div>
            </router-link>
          </div>
        </v-card>

        <!-- Process state distribution (donut) -->
        <v-card variant="flat" class="surface-card insight-card">
          <div class="ac-head">
            <span class="ac-icon" :style="{ '--c': 'var(--v-theme-info)' }"><v-icon icon="mdi-chart-donut" size="17" /></span>
            <span class="ac-title">{{ t('dashboard.stateDistribution') }}</span>
          </div>
          <div class="ins-center">
            <DonutChart :segments="fleetSegments" :label="t('common.total')" :size="104" />
            <div class="ins-legend">
              <div v-for="seg in fleetSegments" :key="seg.key" class="legend"><span class="legend-dot" :style="{ background: `rgb(var(--v-theme-${seg.color}))` }" /><span class="text-caption">{{ seg.key }}</span><span class="legend-val">{{ seg.value }}</span></div>
            </div>
          </div>
        </v-card>

        <!-- Top consumers (only with data) -->
        <v-card v-if="topConsumers.length" variant="flat" class="surface-card insight-card">
          <div class="ac-head">
            <span class="ac-icon" :style="{ '--c': 'var(--v-theme-warning)' }"><v-icon icon="mdi-fire" size="17" /></span>
            <span class="ac-title">{{ t('dashboard.topConsumers') }}</span>
          </div>
          <div class="card-scroll">
            <div v-for="p in topConsumers" :key="p.serverId + p.fullName" class="row-item">
              <div class="min-w-0 flex-grow-1"><div class="ri-title text-truncate">{{ p.fullName }}</div><div class="ri-sub text-truncate">{{ p.serverName }}</div></div>
              <div class="text-right"><div class="ri-metric">{{ p.cpu }}%</div><div class="ri-sub">{{ p.memMb }} MB</div></div>
            </div>
          </div>
        </v-card>

        <!-- Unstable (only with data) -->
        <v-card v-if="unstable.length" variant="flat" class="surface-card insight-card">
          <div class="ac-head">
            <span class="ac-icon" :style="{ '--c': 'var(--v-theme-warning)' }"><v-icon icon="mdi-sync-alert" size="17" /></span>
            <span class="ac-title">{{ t('dashboard.unstable') }}</span>
            <span class="ac-count ac-count--warning">{{ unstable.length }}</span>
          </div>
          <div class="card-scroll">
            <router-link v-for="p in unstable" :key="p.serverId + p.fullName" :to="`/servers/${p.serverId}`" class="row-item">
              <v-icon v-if="p.flapping" icon="mdi-flash" size="16" color="warning" class="me-2" />
              <div class="min-w-0 flex-grow-1"><div class="ri-title text-truncate">{{ p.fullName }}</div><div class="ri-sub text-truncate">{{ p.serverName }}</div></div>
              <span class="ri-metric">{{ t('dashboard.restarts', { n: p.restarts || 0 }) }}</span>
            </router-link>
          </div>
        </v-card>

        <!-- Fleet resources (only with trend data) -->
        <v-card v-if="hasTrend" variant="flat" class="surface-card insight-card span-2">
          <div class="ac-head">
            <span class="ac-icon" :style="{ '--c': 'var(--v-theme-primary)' }"><v-icon icon="mdi-chart-line" size="17" /></span>
            <span class="ac-title">{{ t('dashboard.fleetResources') }}</span>
          </div>
          <div class="text-caption text-medium-emphasis">{{ t('dashboard.cpuUsage') }}</div>
          <TrendChart :series="cpuSeries" :height="60" unit="%" />
          <div class="text-caption text-medium-emphasis mt-1">{{ t('dashboard.memory') }}</div>
          <TrendChart :series="memSeries" :height="60" unit=" MB" />
        </v-card>

        <!-- Connection methods -->
        <v-card variant="flat" class="surface-card insight-card">
          <div class="ac-head">
            <span class="ac-icon" :style="{ '--c': 'var(--v-theme-secondary)' }"><v-icon icon="mdi-lan-connect" size="17" /></span>
            <span class="ac-title">{{ t('dashboard.connectionMethods') }}</span>
          </div>
          <div class="ins-center">
            <DonutChart :segments="methodSegments" :label="t('nav.servers')" :size="104" />
            <div class="ins-legend">
              <div v-for="seg in methodSegments" :key="seg.key" class="legend"><span class="legend-dot" :style="{ background: `rgb(var(--v-theme-${seg.color}))` }" /><span class="text-caption">{{ seg.key }}</span><span class="legend-val">{{ seg.value }}</span></div>
            </div>
          </div>
        </v-card>

        <!-- Activity over the last 24h -->
        <v-card variant="flat" class="surface-card insight-card">
          <div class="ac-head">
            <span class="ac-icon" :style="{ '--c': 'var(--v-theme-primary)' }"><v-icon icon="mdi-chart-bar" size="17" /></span>
            <span class="ac-title">{{ t('dashboard.activity24h') }}</span>
          </div>
          <div v-if="!activity.total" class="empty-mini flex-grow-1"><v-icon icon="mdi-sleep" size="20" /> {{ t('dashboard.noActivity') }}</div>
          <template v-else>
            <div class="act-bars flex-grow-1">
              <div v-for="(b, i) in activity.buckets" :key="i" class="act-bar-wrap" :title="t('dashboard.activityBarTip', { hour: hourLabel(b.hour), n: b.count })">
                <div class="act-bar" :class="{ 'act-bar-empty': !b.count }" :style="{ height: `${b.count ? Math.max((b.count / activity.max) * 100, 8) : 0}%` }" />
              </div>
            </div>
            <div class="text-caption text-medium-emphasis mt-1">{{ t('dashboard.activityTotal', { n: activity.total }) }}</div>
          </template>
        </v-card>

        <!-- Health checks (only with data) -->
        <v-card v-if="overview?.health.total" variant="flat" class="surface-card insight-card">
          <div class="ac-head">
            <span class="ac-icon" :style="{ '--c': 'var(--v-theme-success)' }"><v-icon icon="mdi-heart-pulse" size="17" /></span>
            <span class="ac-title">{{ t('dashboard.healthChecks') }}</span>
          </div>
          <div class="ins-center">
            <div class="ac-metric" :class="overview.health.failing ? 'text-warning' : 'text-success'">{{ overview.health.passing }}<span class="ac-metric-sub">/{{ overview.health.total }}</span></div>
            <div class="ac-caption">{{ overview.health.failing ? t('dashboard.failing', { n: overview.health.failing }) : t('dashboard.passing') }}</div>
          </div>
        </v-card>

        <!-- Recent activity (only with alerts) -->
        <v-card v-if="recentAlerts.length" variant="flat" class="surface-card insight-card span-2">
          <div class="ac-head">
            <span class="ac-icon" :style="{ '--c': 'var(--v-theme-info)' }"><v-icon icon="mdi-bell-outline" size="17" /></span>
            <span class="ac-title">{{ t('dashboard.recentActivity') }}</span>
          </div>
          <div class="card-scroll">
            <div v-for="a in recentAlerts" :key="a.id" class="row-item">
              <v-icon :icon="a.meta.icon" :color="a.meta.color" size="16" class="me-2" />
              <div class="min-w-0 flex-grow-1"><div class="ri-title text-truncate">{{ alertText(a) }}</div></div>
              <span class="ri-sub">{{ formatRelative(a.at) }}</span>
            </div>
          </div>
        </v-card>
      </div>

      <!-- Administration (admin only) -->
      <template v-if="auth.isAdmin">
        <div class="text-overline text-medium-emphasis mt-3 mb-1">{{ t('dashboard.administration') }}</div>
        <div class="admin-grid">
          <!-- Channels -->
          <v-card v-if="channelStatus.total" variant="flat" class="surface-card admin-card" to="/admin/channels">
            <div class="ac-head">
              <span class="ac-icon" :style="{ '--c': 'var(--v-theme-info)' }"><v-icon icon="mdi-bell-ring" size="17" /></span>
              <span class="ac-title">{{ t('dashboard.channels') }}</span>
              <v-icon class="ac-arrow" icon="mdi-arrow-top-right" size="15" />
            </div>
            <div class="ac-metric">{{ channelStatus.enabled }}<span class="ac-metric-sub">/{{ channelStatus.total }}</span></div>
            <div class="ac-caption">{{ t('dashboard.activeChannels') }}</div>
            <div v-if="channelStatus.errors" class="ac-flag"><v-icon icon="mdi-alert" size="13" /> {{ t('dashboard.deliveryError', { n: channelStatus.errors }) }}</div>
          </v-card>

          <!-- Actions today -->
          <v-card variant="flat" class="surface-card admin-card" to="/admin/audit">
            <div class="ac-head">
              <span class="ac-icon" :style="{ '--c': 'var(--v-theme-primary)' }"><v-icon icon="mdi-pulse" size="17" /></span>
              <span class="ac-title">{{ t('dashboard.actionsToday') }}</span>
              <v-icon class="ac-arrow" icon="mdi-arrow-top-right" size="15" />
            </div>
            <div class="ac-metric">{{ actionsToday.total }}</div>
            <div class="ac-stats">
              <span class="ac-stat"><b>{{ actionsToday.control }}</b>{{ t('common.running') }}</span>
              <span class="ac-stat"><b>{{ actionsToday.config }}</b>config</span>
              <span class="ac-stat"><b>{{ actionsToday.admin }}</b>admin</span>
            </div>
          </v-card>

          <!-- Supervisor versions -->
          <v-card v-if="versionList.length" variant="flat" class="surface-card admin-card">
            <div class="ac-head">
              <span class="ac-icon" :style="{ '--c': 'var(--v-theme-secondary)' }"><v-icon icon="mdi-tag-outline" size="17" /></span>
              <span class="ac-title">{{ t('dashboard.supervisorVersions') }}</span>
            </div>
            <div class="ac-list">
              <div v-for="[ver, n] in versionList" :key="ver" class="ac-list-row">
                <span class="mono">{{ ver }}</span>
                <span class="ac-pill">{{ n }}</span>
              </div>
            </div>
          </v-card>

          <!-- Users -->
          <v-card variant="flat" class="surface-card admin-card" to="/admin/users">
            <div class="ac-head">
              <span class="ac-icon" :style="{ '--c': 'var(--v-theme-success)' }"><v-icon icon="mdi-account-group" size="17" /></span>
              <span class="ac-title">{{ t('dashboard.users') }}</span>
              <v-icon class="ac-arrow" icon="mdi-arrow-top-right" size="15" />
            </div>
            <div class="ac-metric">{{ users.length }}</div>
            <div class="ac-stats">
              <span class="ac-stat"><b>{{ roleCounts.admin }}</b>{{ t('roles.admin') }}</span>
              <span class="ac-stat"><b>{{ roleCounts.operator }}</b>{{ t('roles.operator') }}</span>
              <span class="ac-stat"><b>{{ roleCounts.viewer }}</b>{{ t('roles.viewer') }}</span>
            </div>
          </v-card>

          <!-- API tokens -->
          <v-card v-if="tokenStats.total" variant="flat" class="surface-card admin-card" to="/admin/tokens">
            <div class="ac-head">
              <span class="ac-icon" :style="{ '--c': 'var(--v-theme-warning)' }"><v-icon icon="mdi-key-variant" size="17" /></span>
              <span class="ac-title">{{ t('dashboard.apiTokens') }}</span>
              <v-icon class="ac-arrow" icon="mdi-arrow-top-right" size="15" />
            </div>
            <div class="ac-metric">{{ tokenStats.total }}</div>
            <div class="ac-caption">{{ t('dashboard.unusedTokens', { n: tokenStats.unused }) }}</div>
          </v-card>

          <!-- Security -->
          <v-card variant="flat" class="surface-card admin-card">
            <div class="ac-head">
              <span class="ac-icon" :style="{ '--c': 'var(--v-theme-success)' }"><v-icon icon="mdi-shield-check" size="17" /></span>
              <span class="ac-title">{{ t('dashboard.security') }}</span>
            </div>
            <div class="ac-checks">
              <div class="ac-check"><v-icon icon="mdi-check-circle" color="success" size="15" /> {{ t('dashboard.secretsEncrypted') }}</div>
              <div class="ac-check"><v-icon icon="mdi-check-circle" color="success" size="15" /> {{ t('dashboard.rateLimit') }}</div>
              <div class="ac-check"><v-icon icon="mdi-check-circle" color="success" size="15" /> {{ t('dashboard.rbac') }}</div>
            </div>
          </v-card>
        </div>
      </template>
    </div>
  </PageShell>
</template>

<style scoped>
.surface-card { border: 1px solid rgba(var(--v-theme-on-surface), 0.08); border-radius: 12px; transition: border-color .2s, transform .2s, box-shadow .2s, background-color .2s; }
.surface-card:hover { transform: translateY(-2px); border-color: rgba(var(--v-theme-on-surface), .16); box-shadow: 0 6px 20px rgba(0, 0, 0, .18); background-color: rgba(var(--v-theme-on-surface), .04); }

/* Dashboard body fits the viewport; if content exceeds it, the scroll stays
   inside this container so the page itself never scrolls. */
.dash-fit { overflow-y: auto; padding-right: 4px; }
.top-row { display: flex; gap: 16px; flex-wrap: wrap; }
.kpi-grid { flex: 1 1 320px; display: grid; grid-template-columns: repeat(2, minmax(140px, 1fr)); gap: 12px; }
.fleet-card { flex: 2 1 420px; }
.kpi { display: flex; align-items: center; gap: 12px; padding: 12px 14px; }
.kpi-alert { border-color: rgba(var(--v-theme-error), 0.5); }
.kpi-icon { flex: 0 0 auto; width: 34px; height: 34px; border-radius: 10px; display: flex; align-items: center; justify-content: center; color: rgb(var(--c)); background: rgba(var(--c), 0.13); }
.kpi-value { font-size: 1.35rem; font-weight: 700; line-height: 1.1; }
.kpi-label { font-size: .72rem; color: rgba(var(--v-theme-on-surface), .6); margin-top: 1px; }

.seg-bar { display: flex; height: 10px; border-radius: 6px; overflow: hidden; background: rgba(var(--v-theme-on-surface), .06); gap: 2px; }
.seg-bar-sm { height: 6px; border-radius: 4px; }
.seg { height: 100%; transition: width .4s ease; }
.seg-empty { width: 100%; background: rgba(var(--v-theme-on-surface), .08); }
.legend { display: flex; align-items: center; gap: 5px; }
.legend-dot { width: 9px; height: 9px; border-radius: 50%; }

/* Insight + admin grids: 3 columns on desktop, responsive below. Natural heights. */
.insight-grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 16px; align-items: stretch; }
.insight-grid > * { grid-column: span 3; }
.insight-grid .span-2 { grid-column: span 6; }

/* Insight cards share the admin-card header language for a consistent look. */
.insight-card { padding: 14px 16px; display: flex; flex-direction: column; }
.ins-center { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; }
.ins-legend { display: flex; flex-wrap: wrap; gap: 8px 12px; justify-content: center; }
.legend-val { font-size: .72rem; font-weight: 700; color: rgba(var(--v-theme-on-surface), .9); }
.ac-count { margin-left: auto; min-width: 22px; height: 20px; padding: 0 7px; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; font-size: .72rem; font-weight: 700; }
.ac-count--error { color: rgb(var(--v-theme-error)); background: rgba(var(--v-theme-error), .14); }
.ac-count--warning { color: rgb(var(--v-theme-warning)); background: rgba(var(--v-theme-warning), .14); }
.act-bars { display: flex; align-items: flex-end; gap: 3px; min-height: 72px; padding-top: 8px; }
.act-bar-wrap { flex: 1 1 0; display: flex; align-items: flex-end; min-height: 64px; }
.act-bar { width: 100%; min-height: 2px; border-radius: 3px 3px 0 0; background: rgb(var(--v-theme-primary)); transition: height .35s ease; }
.act-bar-empty { background: rgba(var(--v-theme-on-surface), .1); }
@media (max-width: 960px) { .insight-grid > * { grid-column: span 6; } .insight-grid .span-2 { grid-column: span 12; } }
@media (max-width: 600px) { .insight-grid > *, .insight-grid .span-2 { grid-column: span 12; } }
.card-scroll { max-height: 200px; overflow-y: auto; }

.empty-mini { display: flex; align-items: center; gap: 8px; padding: 8px 4px; font-size: .8rem; color: rgba(var(--v-theme-on-surface), .55); }
.row-item { display: flex; align-items: center; gap: 2px; padding: 5px 2px; border-top: 1px solid rgba(var(--v-theme-on-surface), .06); text-decoration: none; color: inherit; }
.row-item:first-of-type { border-top: none; }
.row-item:hover .ri-title { color: rgb(var(--v-theme-primary)); }
.ri-title { font-size: .8rem; font-weight: 500; }
.ri-sub { font-size: .68rem; color: rgba(var(--v-theme-on-surface), .55); white-space: nowrap; }
.ri-metric { font-size: .8rem; font-weight: 700; }

.admin-grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 14px; align-items: stretch; }
.admin-grid > * { grid-column: span 3; }
@media (max-width: 960px) { .admin-grid > * { grid-column: span 6; } }
@media (max-width: 600px) { .admin-grid > * { grid-column: span 12; } }

/* Professional admin cards */
.admin-card { padding: 18px 18px; display: flex; flex-direction: column; }
a.admin-card { text-decoration: none; color: inherit; cursor: pointer; }
a.admin-card:hover .ac-arrow { opacity: .9; transform: translate(2px, -2px); }
.ac-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.ac-icon { flex: 0 0 auto; width: 30px; height: 30px; border-radius: 9px; display: flex; align-items: center; justify-content: center; color: rgb(var(--c)); background: rgba(var(--c), .14); }
.ac-title { font-size: .82rem; font-weight: 600; color: rgba(var(--v-theme-on-surface), .85); }
.ac-arrow { margin-left: auto; opacity: 0; color: rgba(var(--v-theme-on-surface), .5); transition: opacity .2s, transform .2s; }
.ac-metric { font-size: 1.7rem; font-weight: 700; line-height: 1.1; }
.ac-metric-sub { font-size: 1rem; font-weight: 500; color: rgba(var(--v-theme-on-surface), .45); }
.ac-caption { font-size: .72rem; color: rgba(var(--v-theme-on-surface), .55); margin-top: 2px; }
.ac-flag { font-size: .72rem; color: rgb(var(--v-theme-error)); margin-top: 6px; display: flex; align-items: center; gap: 4px; }
.ac-stats { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.ac-stat { display: inline-flex; align-items: baseline; gap: 4px; padding: 3px 8px; border-radius: 7px; font-size: .68rem; color: rgba(var(--v-theme-on-surface), .6); background: rgba(var(--v-theme-on-surface), .05); }
.ac-stat b { font-size: .8rem; font-weight: 700; color: rgba(var(--v-theme-on-surface), .9); }
.ac-list { display: flex; flex-direction: column; gap: 4px; }
.ac-list-row { display: flex; align-items: center; justify-content: space-between; }
.ac-pill { min-width: 22px; text-align: center; padding: 1px 7px; border-radius: 7px; font-size: .72rem; font-weight: 700; background: rgba(var(--v-theme-on-surface), .07); }
.ac-checks { display: flex; flex-direction: column; gap: 6px; margin-top: 2px; }
.ac-check { font-size: .76rem; display: flex; align-items: center; gap: 7px; color: rgba(var(--v-theme-on-surface), .8); }
.mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: .78rem; }
.min-w-0 { min-width: 0; }
</style>
