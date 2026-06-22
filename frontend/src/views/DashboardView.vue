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

const refreshing = ref(false);
async function refresh() {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    await serversStore.fetchAll();
    syncSubscriptions();
    await Promise.all([loadOverview(), loadAdmin()]);
  } finally {
    refreshing.value = false;
  }
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
  <PageShell :title="t('dashboard.title')" :subtitle="t('dashboard.subtitle')" icon="mdi-view-dashboard-outline">
    <template #hero-actions>
      <v-chip color="white" variant="tonal" size="small" class="me-1">{{ t('dashboard.onlineChip', { online: agg.online, total: agg.servers }) }}</v-chip>
      <v-btn icon="mdi-refresh" variant="text" :loading="refreshing" @click="refresh" />
    </template>

    <!-- Empty state -->
    <v-card v-if="!serversStore.servers.length && !serversStore.loading" rounded="lg" class="pa-12 text-center">
      <v-icon icon="mdi-server-off" size="48" class="text-medium-emphasis mb-3" />
      <div class="text-h6">{{ t('dashboard.noServers') }}</div>
      <div class="text-medium-emphasis mb-4">{{ t('dashboard.noServersSub') }}</div>
      <v-btn color="primary" prepend-icon="mdi-plus" to="/servers">{{ t('dashboard.addServer') }}</v-btn>
    </v-card>

    <div v-else ref="wrap" class="overflow-x-hidden overflow-y-auto pe-1" :style="{ height: height + 'px' }">
      <!-- Row 1: compact KPIs + fleet health (merged) -->
      <v-row>
        <v-col cols="12" md="4">
          <v-row dense>
            <v-col v-for="k in kpis" :key="k.key" cols="6">
              <v-card rounded="lg" hover flat class="kpi h-100" :class="{ 'kpi--alert': k.alert }">
                <span class="kpi__accent" :style="{ background: `rgb(var(--v-theme-${k.color}))` }" />
                <div class="d-flex align-center ga-3 pa-4">
                  <v-avatar :color="k.color" variant="tonal" rounded="lg" size="42">
                    <v-icon :icon="k.icon" size="21" />
                  </v-avatar>
                  <div class="min-w-0">
                    <div class="kpi__value" :class="{ 'text-error': k.alert }">{{ k.value }}</div>
                    <div class="kpi__label text-truncate">{{ k.label }}</div>
                  </div>
                </div>
              </v-card>
            </v-col>
          </v-row>
        </v-col>
        <v-col cols="12" md="8">
          <v-card rounded="lg" hover flat class="health h-100 pa-4 d-flex flex-column">
            <div class="d-flex align-center mb-3">
              <v-avatar color="success" variant="tonal" rounded="lg" size="30" class="me-2">
                <v-icon icon="mdi-heart-pulse" size="17" />
              </v-avatar>
              <span class="text-subtitle-1 font-weight-medium">{{ t('dashboard.fleetHealth') }}</span>
              <v-spacer />
              <div class="d-flex align-baseline ga-1">
                <span class="health__pct" :class="healthPct >= 90 ? 'text-success' : healthPct >= 50 ? 'text-warning' : 'text-error'">{{ healthPct }}%</span>
                <span class="text-caption text-medium-emphasis">{{ t('dashboard.healthy') }}</span>
              </div>
            </div>
            <div class="health__bar">
              <div v-for="seg in fleetSegments" :key="seg.key" :style="{ width: `${(seg.value / agg.total) * 100}%`, background: `rgb(var(--v-theme-${seg.color}))` }" />
            </div>
            <div class="d-flex flex-wrap ga-2 mt-3">
              <div v-for="seg in fleetSegments" :key="seg.key" class="legend-pill">
                <v-icon icon="mdi-circle" size="9" :color="seg.color" />
                <span class="text-caption">{{ seg.key }}</span>
                <span class="text-caption font-weight-bold">{{ seg.value }}</span>
              </div>
            </div>
          </v-card>
        </v-col>
      </v-row>

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
      <div class="text-overline text-medium-emphasis mt-4 mb-1">{{ t('dashboard.insights') }}</div>
      <v-row>
        <!-- Problem processes -->
        <v-col cols="12" sm="6" lg="3">
          <v-card rounded="lg" hover class="panel-card pa-4 h-100 d-flex flex-column">
            <div class="d-flex align-center ga-2 mb-2">
              <v-avatar color="error" variant="tonal" rounded="lg" size="30"><v-icon icon="mdi-alert-circle" size="17" /></v-avatar>
              <span class="text-subtitle-2 font-weight-medium">{{ t('dashboard.problemProcesses') }}</span>
              <v-chip v-if="problemProcesses.length" size="x-small" color="error" variant="tonal" class="ms-auto">{{ problemProcesses.length }}</v-chip>
            </div>
            <div v-if="!problemProcesses.length" class="d-flex align-center ga-2 flex-grow-1 text-body-2 text-medium-emphasis">
              <v-icon icon="mdi-check-circle-outline" color="success" size="20" /> {{ t('dashboard.noProblems') }}
            </div>
            <v-list v-else density="compact" nav class="pa-0 bg-transparent overflow-y-auto" style="max-height: 200px">
              <v-list-item v-for="p in problemProcesses" :key="p.serverId + p.fullName" :to="`/servers/${p.serverId}`" class="px-1">
                <template #prepend>
                  <v-chip :color="stStyle(p.statename).color" size="x-small" variant="flat" label class="me-2">{{ p.statename }}</v-chip>
                </template>
                <v-list-item-title class="text-body-2">{{ p.fullName }}</v-list-item-title>
                <v-list-item-subtitle class="text-caption">{{ p.serverName }}<template v-if="p.spawnerr"> · {{ p.spawnerr }}</template></v-list-item-subtitle>
              </v-list-item>
            </v-list>
          </v-card>
        </v-col>

        <!-- Process state distribution (donut) -->
        <v-col cols="12" sm="6" lg="3">
          <v-card rounded="lg" hover class="panel-card pa-4 h-100 d-flex flex-column">
            <div class="d-flex align-center ga-2 mb-2">
              <v-avatar color="info" variant="tonal" rounded="lg" size="30"><v-icon icon="mdi-chart-donut" size="17" /></v-avatar>
              <span class="text-subtitle-2 font-weight-medium">{{ t('dashboard.stateDistribution') }}</span>
            </div>
            <div class="d-flex flex-column align-center justify-center flex-grow-1 ga-2">
              <DonutChart :segments="fleetSegments" :label="t('common.total')" :size="104" />
              <div class="d-flex flex-wrap justify-center ga-2">
                <div v-for="seg in fleetSegments" :key="seg.key" class="legend-pill">
                  <v-icon icon="mdi-circle" size="10" :color="seg.color" />
                  <span class="text-caption">{{ seg.key }}</span>
                  <span class="text-caption font-weight-bold">{{ seg.value }}</span>
                </div>
              </div>
            </div>
          </v-card>
        </v-col>

        <!-- Top consumers (only with data) -->
        <v-col v-if="topConsumers.length" cols="12" sm="6" lg="3">
          <v-card rounded="lg" hover class="panel-card pa-4 h-100 d-flex flex-column">
            <div class="d-flex align-center ga-2 mb-2">
              <v-avatar color="warning" variant="tonal" rounded="lg" size="30"><v-icon icon="mdi-fire" size="17" /></v-avatar>
              <span class="text-subtitle-2 font-weight-medium">{{ t('dashboard.topConsumers') }}</span>
            </div>
            <v-list density="compact" class="pa-0 bg-transparent overflow-y-auto" style="max-height: 200px">
              <v-list-item v-for="p in topConsumers" :key="p.serverId + p.fullName" class="px-1">
                <v-list-item-title class="text-body-2">{{ p.fullName }}</v-list-item-title>
                <v-list-item-subtitle class="text-caption">{{ p.serverName }}</v-list-item-subtitle>
                <template #append>
                  <div class="text-right">
                    <div class="text-body-2 font-weight-bold">{{ p.cpu }}%</div>
                    <div class="text-caption text-medium-emphasis">{{ p.memMb }} MB</div>
                  </div>
                </template>
              </v-list-item>
            </v-list>
          </v-card>
        </v-col>

        <!-- Unstable (only with data) -->
        <v-col v-if="unstable.length" cols="12" sm="6" lg="3">
          <v-card rounded="lg" hover class="panel-card pa-4 h-100 d-flex flex-column">
            <div class="d-flex align-center ga-2 mb-2">
              <v-avatar color="warning" variant="tonal" rounded="lg" size="30"><v-icon icon="mdi-sync-alert" size="17" /></v-avatar>
              <span class="text-subtitle-2 font-weight-medium">{{ t('dashboard.unstable') }}</span>
              <v-chip size="x-small" color="warning" variant="tonal" class="ms-auto">{{ unstable.length }}</v-chip>
            </div>
            <v-list density="compact" nav class="pa-0 bg-transparent overflow-y-auto" style="max-height: 200px">
              <v-list-item v-for="p in unstable" :key="p.serverId + p.fullName" :to="`/servers/${p.serverId}`" class="px-1">
                <template v-if="p.flapping" #prepend>
                  <v-icon icon="mdi-flash" size="16" color="warning" class="me-2" />
                </template>
                <v-list-item-title class="text-body-2">{{ p.fullName }}</v-list-item-title>
                <v-list-item-subtitle class="text-caption">{{ p.serverName }}</v-list-item-subtitle>
                <template #append>
                  <span class="text-body-2 font-weight-bold">{{ t('dashboard.restarts', { n: p.restarts || 0 }) }}</span>
                </template>
              </v-list-item>
            </v-list>
          </v-card>
        </v-col>

        <!-- Fleet resources (only with trend data) -->
        <v-col v-if="hasTrend" cols="12" lg="6">
          <v-card rounded="lg" hover class="panel-card pa-4 h-100 d-flex flex-column">
            <div class="d-flex align-center ga-2 mb-2">
              <v-avatar color="primary" variant="tonal" rounded="lg" size="30"><v-icon icon="mdi-chart-line" size="17" /></v-avatar>
              <span class="text-subtitle-2 font-weight-medium">{{ t('dashboard.fleetResources') }}</span>
            </div>
            <div class="text-caption text-medium-emphasis">{{ t('dashboard.cpuUsage') }}</div>
            <TrendChart :series="cpuSeries" :height="60" unit="%" />
            <div class="text-caption text-medium-emphasis mt-1">{{ t('dashboard.memory') }}</div>
            <TrendChart :series="memSeries" :height="60" unit=" MB" />
          </v-card>
        </v-col>

        <!-- Connection methods -->
        <v-col cols="12" sm="6" lg="3">
          <v-card rounded="lg" hover class="panel-card pa-4 h-100 d-flex flex-column">
            <div class="d-flex align-center ga-2 mb-2">
              <v-avatar color="secondary" variant="tonal" rounded="lg" size="30"><v-icon icon="mdi-lan-connect" size="17" /></v-avatar>
              <span class="text-subtitle-2 font-weight-medium">{{ t('dashboard.connectionMethods') }}</span>
            </div>
            <div class="d-flex flex-column align-center justify-center flex-grow-1 ga-2">
              <DonutChart :segments="methodSegments" :label="t('nav.servers')" :size="104" />
              <div class="d-flex flex-wrap justify-center ga-2">
                <div v-for="seg in methodSegments" :key="seg.key" class="legend-pill">
                  <v-icon icon="mdi-circle" size="10" :color="seg.color" />
                  <span class="text-caption">{{ seg.key }}</span>
                  <span class="text-caption font-weight-bold">{{ seg.value }}</span>
                </div>
              </div>
            </div>
          </v-card>
        </v-col>

        <!-- Activity over the last 24h -->
        <v-col cols="12" sm="6" lg="3">
          <v-card rounded="lg" hover class="panel-card pa-4 h-100 d-flex flex-column">
            <div class="d-flex align-center ga-2 mb-2">
              <v-avatar color="primary" variant="tonal" rounded="lg" size="30"><v-icon icon="mdi-chart-bar" size="17" /></v-avatar>
              <span class="text-subtitle-2 font-weight-medium">{{ t('dashboard.activity24h') }}</span>
            </div>
            <div v-if="!activity.total" class="d-flex align-center ga-2 flex-grow-1 text-body-2 text-medium-emphasis"><v-icon icon="mdi-sleep" size="20" /> {{ t('dashboard.noActivity') }}</div>
            <template v-else>
              <div class="d-flex align-end flex-grow-1 ga-1" style="min-height: 72px; padding-top: 8px">
                <div v-for="(b, i) in activity.buckets" :key="i" class="d-flex align-end flex-grow-1" style="min-height: 64px" :title="t('dashboard.activityBarTip', { hour: hourLabel(b.hour), n: b.count })">
                  <div class="rounded-t" :style="{ width: '100%', minHeight: '2px', height: `${b.count ? Math.max((b.count / activity.max) * 100, 8) : 0}%`, background: b.count ? 'rgb(var(--v-theme-primary))' : 'rgba(var(--v-theme-on-surface), 0.1)' }" />
                </div>
              </div>
              <div class="text-caption text-medium-emphasis mt-1">{{ t('dashboard.activityTotal', { n: activity.total }) }}</div>
            </template>
          </v-card>
        </v-col>

        <!-- Health checks (only with data) -->
        <v-col v-if="overview?.health.total" cols="12" sm="6" lg="3">
          <v-card rounded="lg" hover class="panel-card pa-4 h-100 d-flex flex-column">
            <div class="d-flex align-center ga-2 mb-2">
              <v-avatar color="success" variant="tonal" rounded="lg" size="30"><v-icon icon="mdi-heart-pulse" size="17" /></v-avatar>
              <span class="text-subtitle-2 font-weight-medium">{{ t('dashboard.healthChecks') }}</span>
            </div>
            <div class="d-flex flex-column align-center justify-center flex-grow-1">
              <div class="text-h5 font-weight-bold" :class="overview.health.failing ? 'text-warning' : 'text-success'">{{ overview.health.passing }}<span class="text-body-1 text-disabled">/{{ overview.health.total }}</span></div>
              <div class="text-caption text-medium-emphasis">{{ overview.health.failing ? t('dashboard.failing', { n: overview.health.failing }) : t('dashboard.passing') }}</div>
            </div>
          </v-card>
        </v-col>

        <!-- Recent activity (only with alerts) -->
        <v-col v-if="recentAlerts.length" cols="12" lg="6">
          <v-card rounded="lg" hover class="panel-card pa-4 h-100 d-flex flex-column">
            <div class="d-flex align-center ga-2 mb-2">
              <v-avatar color="info" variant="tonal" rounded="lg" size="30"><v-icon icon="mdi-bell-outline" size="17" /></v-avatar>
              <span class="text-subtitle-2 font-weight-medium">{{ t('dashboard.recentActivity') }}</span>
            </div>
            <v-list density="compact" class="pa-0 bg-transparent overflow-y-auto" style="max-height: 200px">
              <v-list-item v-for="a in recentAlerts" :key="a.id" class="px-1">
                <template #prepend>
                  <v-icon :icon="a.meta.icon" :color="a.meta.color" size="16" class="me-2" />
                </template>
                <v-list-item-title class="text-body-2">{{ alertText(a) }}</v-list-item-title>
                <template #append>
                  <span class="text-caption text-medium-emphasis">{{ formatRelative(a.at) }}</span>
                </template>
              </v-list-item>
            </v-list>
          </v-card>
        </v-col>
      </v-row>

      <!-- Administration (admin only) -->
      <template v-if="auth.isAdmin">
        <div class="text-overline text-medium-emphasis mt-4 mb-1">{{ t('dashboard.administration') }}</div>
        <v-row>
          <!-- Channels -->
          <v-col v-if="channelStatus.total" cols="12" sm="6" md="2">
            <v-card rounded="lg" hover to="/admin/channels" class="stat-card panel-card pa-4 h-100 d-flex flex-column">
              <span class="stat-accent" style="background: rgb(var(--v-theme-info))" />
              <div class="d-flex align-center ga-2 mb-2">
                <v-avatar color="info" variant="tonal" rounded="lg" size="30"><v-icon icon="mdi-bell-ring" size="17" /></v-avatar>
                <span class="text-subtitle-2 font-weight-medium">{{ t('dashboard.channels') }}</span>
                <v-icon icon="mdi-arrow-top-right" size="15" class="ms-auto text-disabled stat-arrow" />
              </div>
              <div class="stat-num">{{ channelStatus.enabled }}<span class="text-body-1 text-disabled">/{{ channelStatus.total }}</span></div>
              <div class="text-caption text-medium-emphasis">{{ t('dashboard.activeChannels') }}</div>
              <div v-if="channelStatus.errors" class="d-flex align-center ga-1 mt-2 text-caption text-error"><v-icon icon="mdi-alert" size="13" /> {{ t('dashboard.deliveryError', { n: channelStatus.errors }) }}</div>
            </v-card>
          </v-col>

          <!-- Actions today -->
          <v-col cols="12" sm="6" md="2">
            <v-card rounded="lg" hover to="/admin/audit" class="stat-card panel-card pa-4 h-100 d-flex flex-column">
              <span class="stat-accent" style="background: rgb(var(--v-theme-primary))" />
              <div class="d-flex align-center ga-2 mb-2">
                <v-avatar color="primary" variant="tonal" rounded="lg" size="30"><v-icon icon="mdi-pulse" size="17" /></v-avatar>
                <span class="text-subtitle-2 font-weight-medium">{{ t('dashboard.actionsToday') }}</span>
                <v-icon icon="mdi-arrow-top-right" size="15" class="ms-auto text-disabled stat-arrow" />
              </div>
              <div class="stat-num">{{ actionsToday.total }}</div>
              <div class="d-flex flex-wrap ga-1 mt-2">
                <v-chip size="x-small" variant="tonal" label><b class="me-1">{{ actionsToday.control }}</b>{{ t('common.running') }}</v-chip>
                <v-chip size="x-small" variant="tonal" label><b class="me-1">{{ actionsToday.config }}</b>config</v-chip>
                <v-chip size="x-small" variant="tonal" label><b class="me-1">{{ actionsToday.admin }}</b>admin</v-chip>
              </div>
            </v-card>
          </v-col>

          <!-- Supervisor versions -->
          <v-col v-if="versionList.length" cols="12" sm="6" md="2">
            <v-card rounded="lg" hover class="stat-card panel-card pa-4 h-100 d-flex flex-column">
              <span class="stat-accent" style="background: rgb(var(--v-theme-secondary))" />
              <div class="d-flex align-center ga-2 mb-2">
                <v-avatar color="secondary" variant="tonal" rounded="lg" size="30"><v-icon icon="mdi-tag-outline" size="17" /></v-avatar>
                <span class="text-subtitle-2 font-weight-medium">{{ t('dashboard.supervisorVersions') }}</span>
              </div>
              <div class="d-flex flex-column ga-1">
                <div v-for="[ver, n] in versionList" :key="ver" class="d-flex align-center justify-space-between">
                  <code>{{ ver }}</code>
                  <v-chip size="x-small" variant="tonal" label>{{ n }}</v-chip>
                </div>
              </div>
            </v-card>
          </v-col>

          <!-- Users -->
          <v-col cols="12" sm="6" md="2">
            <v-card rounded="lg" hover to="/admin/users" class="stat-card panel-card pa-4 h-100 d-flex flex-column">
              <span class="stat-accent" style="background: rgb(var(--v-theme-success))" />
              <div class="d-flex align-center ga-2 mb-2">
                <v-avatar color="success" variant="tonal" rounded="lg" size="30"><v-icon icon="mdi-account-group" size="17" /></v-avatar>
                <span class="text-subtitle-2 font-weight-medium">{{ t('dashboard.users') }}</span>
                <v-icon icon="mdi-arrow-top-right" size="15" class="ms-auto text-disabled stat-arrow" />
              </div>
              <div class="stat-num">{{ users.length }}</div>
              <div class="d-flex flex-wrap ga-1 mt-2">
                <v-chip size="x-small" variant="tonal" label><b class="me-1">{{ roleCounts.admin }}</b>{{ t('roles.admin') }}</v-chip>
                <v-chip size="x-small" variant="tonal" label><b class="me-1">{{ roleCounts.operator }}</b>{{ t('roles.operator') }}</v-chip>
                <v-chip size="x-small" variant="tonal" label><b class="me-1">{{ roleCounts.viewer }}</b>{{ t('roles.viewer') }}</v-chip>
              </div>
            </v-card>
          </v-col>

          <!-- API tokens -->
          <v-col v-if="tokenStats.total" cols="12" sm="6" md="2">
            <v-card rounded="lg" hover to="/admin/tokens" class="stat-card panel-card pa-4 h-100 d-flex flex-column">
              <span class="stat-accent" style="background: rgb(var(--v-theme-warning))" />
              <div class="d-flex align-center ga-2 mb-2">
                <v-avatar color="warning" variant="tonal" rounded="lg" size="30"><v-icon icon="mdi-key-variant" size="17" /></v-avatar>
                <span class="text-subtitle-2 font-weight-medium">{{ t('dashboard.apiTokens') }}</span>
                <v-icon icon="mdi-arrow-top-right" size="15" class="ms-auto text-disabled stat-arrow" />
              </div>
              <div class="stat-num">{{ tokenStats.total }}</div>
              <div class="text-caption text-medium-emphasis">{{ t('dashboard.unusedTokens', { n: tokenStats.unused }) }}</div>
            </v-card>
          </v-col>

          <!-- Security -->
          <v-col cols="12" sm="6" md="2">
            <v-card rounded="lg" hover class="stat-card panel-card pa-4 h-100 d-flex flex-column">
              <span class="stat-accent" style="background: rgb(var(--v-theme-success))" />
              <div class="d-flex align-center ga-2 mb-2">
                <v-avatar color="success" variant="tonal" rounded="lg" size="30"><v-icon icon="mdi-shield-check" size="17" /></v-avatar>
                <span class="text-subtitle-2 font-weight-medium">{{ t('dashboard.security') }}</span>
              </div>
              <div class="d-flex flex-column ga-1">
                <div class="d-flex align-center ga-2 text-body-2"><v-icon icon="mdi-check-circle" color="success" size="15" /> {{ t('dashboard.secretsEncrypted') }}</div>
                <div class="d-flex align-center ga-2 text-body-2"><v-icon icon="mdi-check-circle" color="success" size="15" /> {{ t('dashboard.rateLimit') }}</div>
                <div class="d-flex align-center ga-2 text-body-2"><v-icon icon="mdi-check-circle" color="success" size="15" /> {{ t('dashboard.rbac') }}</div>
              </div>
            </v-card>
          </v-col>
        </v-row>
      </template>
    </div>
  </PageShell>
</template>

<style scoped>
/* The two helpers Vuetify has no utility for: a flex min-width:0 truncation
   guard and a monospace run for version strings. Everything else is handled
   by Vuetify components, variants and utility classes. */
.min-w-0 { min-width: 0; }
code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.78rem; }

/* ── KPI stat cards ─────────────────────────────────────────────── */
.kpi {
  position: relative;
  overflow: hidden;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.08);
  transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
}
.kpi:hover { transform: translateY(-2px); }
/* Slim colour rail down the left edge keys each metric to its status colour. */
.kpi__accent {
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  opacity: 0.9;
}
.kpi__value {
  font-size: 1.7rem;
  line-height: 1.05;
  font-weight: 700;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
}
.kpi__label {
  margin-top: 2px;
  font-size: 0.75rem;
  color: rgba(var(--v-theme-on-surface), 0.6);
}
/* Issues card draws attention when there is something wrong. */
.kpi--alert {
  border-color: rgba(var(--v-theme-error), 0.4);
  background: rgba(var(--v-theme-error), 0.06);
}

/* ── Shared card framing (insights + administration) ────────────── */
/* Subtle border + hover lift gives every card the same defined, layered
   surface as the KPI/health cards above — keyed off the .panel-card hook. */
.panel-card {
  border: 1px solid rgba(var(--v-theme-on-surface), 0.08);
  transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
}
.panel-card:hover {
  transform: translateY(-2px);
  border-color: rgba(var(--v-theme-on-surface), 0.16);
}

/* Administration "stat tiles": colour rail + tighter numerals, plus a nudging
   arrow on the navigable ones so they read as links. */
.stat-card { position: relative; overflow: hidden; }
.stat-accent {
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  opacity: 0.9;
}
.stat-num {
  font-size: 1.55rem;
  line-height: 1.1;
  font-weight: 700;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
}
.stat-arrow { transition: transform 0.18s ease, color 0.18s ease; }
.stat-card:hover .stat-arrow {
  transform: translate(2px, -2px);
  color: rgb(var(--v-theme-primary)) !important;
}

/* ── Fleet health card ──────────────────────────────────────────── */
.health { border: 1px solid rgba(var(--v-theme-on-surface), 0.08); }
.health__pct {
  font-size: 1.7rem;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
}
.health__bar {
  display: flex;
  gap: 2px;
  height: 12px;
  border-radius: 999px;
  overflow: hidden;
  background: rgba(var(--v-theme-on-surface), 0.06);
}
.health__bar > div { transition: width 0.4s ease; }

/* Shared legend chip used by the health bar + the donut cards. */
.legend-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(var(--v-theme-on-surface), 0.05);
}
</style>
