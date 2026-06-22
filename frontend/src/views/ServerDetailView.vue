<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useServersStore } from '@/stores/servers';
import { useRealtimeStore } from '@/stores/realtime';
import { useI18n } from 'vue-i18n';
import ProcessTable from '@/components/ProcessTable.vue';
import SupervisorInstallPanel from '@/components/SupervisorInstallPanel.vue';
import LogPanel from '@/components/LogPanel.vue';
import ConfigPanel from '@/components/ConfigPanel.vue';
import EventListenerPanel from '@/components/EventListenerPanel.vue';
import HealthChecksPanel from '@/components/HealthChecksPanel.vue';
import TrendChart from '@/components/TrendChart.vue';
import PageShell from '@/components/PageShell.vue';
import { useAuthStore } from '@/stores/auth';
import { bulkApi, serversApi } from '@/api/client';
import { formatRelative, formatUptime, stateStyle, methodLabel } from '@/utils/format';

const { t } = useI18n();

const route = useRoute();
const serversStore = useServersStore();
const realtime = useRealtimeStore();

const serverId = computed(() => route.params.id);
const server = computed(() => serversStore.byId(serverId.value));
const liveSnapshot = computed(() => realtime.snapshots[serverId.value]);
const error = computed(() => realtime.errors[serverId.value]);
const lastUpdate = computed(() => realtime.lastUpdate[serverId.value]);

// Pause: freeze the displayed snapshot (the backend poller keeps running for
// other views, but the detail page shows the captured copy until resumed).
const paused = ref(false);
const frozen = ref(null);
const snapshot = computed(() => (paused.value ? frozen.value : liveSnapshot.value));
function togglePause() {
  paused.value = !paused.value;
  frozen.value = paused.value ? liveSnapshot.value : null;
}

const bulkBusy = ref(false);
const snackbar = ref({ show: false, color: 'success', text: '' });
const installPanel = ref(false);
const daemonLogPanel = ref(false);
const configPanel = ref(false);
const eventPanel = ref(false);
const healthPanel = ref(false);
const auth = useAuthStore();

const METHOD_META = {
  tcp: { icon: 'mdi-lan', color: 'primary', label: 'TCP XML-RPC' },
  local: { icon: 'mdi-power-socket', color: 'secondary', label: 'Yerel Socket' },
  ssh: { icon: 'mdi-console-network', color: 'info', label: 'SSH Tüneli' },
  docker: { icon: 'mdi-docker', color: 'info', label: 'Docker' },
  agent: { icon: 'mdi-robot', color: 'secondary', label: 'Agent' },
};
const methodMeta = computed(
  () =>
    METHOD_META[server.value?.method] || {
      icon: 'mdi-server',
      color: 'primary',
      label: server.value?.method || '',
    },
);

const connTarget = computed(() => {
  const s = server.value;
  if (!s) return '';
  switch (s.method) {
    case 'tcp':
      return `${s.host}:${s.port}`;
    case 'local':
      return s.socketPath;
    case 'ssh':
      return `${s.sshUser}@${s.sshHost}:${s.sshPort}`;
    case 'docker':
      return s.container;
    case 'agent':
      return s.agentUrl;
    default:
      return '';
  }
});

const daemonStyle = computed(() =>
  snapshot.value?.state ? stateStyle(snapshot.value.state.statename) : null,
);

const stats = computed(() => {
  const s = snapshot.value?.summary;
  if (!s) return [];
  return [
    {
      label: t('common.total'),
      value: s.total,
      color: 'primary',
      icon: 'mdi-format-list-bulleted',
    },
    { label: t('common.running'), value: s.running, color: 'success', icon: 'mdi-play-circle' },
    { label: t('common.stopped'), value: s.stopped, color: 'grey', icon: 'mdi-stop-circle' },
    { label: t('common.fatal'), value: s.fatal, color: 'error', icon: 'mdi-close-circle' },
    { label: t('common.other'), value: s.other, color: 'warning', icon: 'mdi-progress-clock' },
  ];
});

const health = computed(() => {
  const s = snapshot.value?.summary;
  if (!s || !s.total) return null;
  const seg = [
    { key: t('common.running'), value: s.running, color: 'success' },
    { key: t('common.other'), value: s.other, color: 'warning' },
    { key: t('common.stopped'), value: s.stopped, color: 'grey' },
    { key: t('common.fatal'), value: s.fatal, color: 'error' },
  ].filter((x) => x.value > 0);
  return { total: s.total, running: s.running, pct: Math.round((s.running / s.total) * 100), seg };
});

function subscribe() {
  if (serverId.value) realtime.subscribe(serverId.value);
}
function unsubscribe() {
  if (serverId.value) realtime.unsubscribe(serverId.value);
}

// Daemon info (supervisord version / pid)
const daemon = ref(null);
async function loadDaemon() {
  try {
    daemon.value = await serversApi.daemon(serverId.value);
  } catch {
    daemon.value = null;
  }
}

// Host metrics (shell connectors only)
const host = ref(null);
async function loadHost() {
  try {
    host.value = await serversApi.host(serverId.value);
  } catch {
    host.value = null;
  }
}
let hostTimer = null;
const memPct = computed(() =>
  host.value?.mem ? Math.round((host.value.mem.usedMb / host.value.mem.totalMb) * 100) : 0,
);
const loadHigh = computed(
  () => host.value?.load && host.value?.cores && host.value.load.one > host.value.cores,
);

// Trend metrics (time series)
const showTrends = ref(localStorage.getItem('helmio-show-trends') === 'true');
const metricRange = ref(Number(localStorage.getItem('helmio-metric-range')) || 60);
const metricSamples = ref([]);
let metricsTimer = null;
const RANGES = [
  { v: 15, label: '15d' },
  { v: 60, label: '1s' },
  { v: 360, label: '6s' },
  { v: 1440, label: '24s' },
];

async function loadMetrics() {
  if (!showTrends.value) return;
  try {
    const res = await serversApi.metrics(serverId.value, metricRange.value);
    metricSamples.value = res.samples || [];
  } catch {
    metricSamples.value = [];
  }
}
function setRange(v) {
  metricRange.value = v;
  localStorage.setItem('helmio-metric-range', String(v));
  loadMetrics();
}
function toggleTrends() {
  showTrends.value = !showTrends.value;
  localStorage.setItem('helmio-show-trends', String(showTrends.value));
  if (showTrends.value) loadMetrics();
}

const procSeries = computed(() => [
  {
    name: t('common.running'),
    color: '#2ecc71',
    points: metricSamples.value.map((s) => ({ at: s.at, v: s.running })),
  },
  {
    name: t('common.total'),
    color: '#4f7cff',
    points: metricSamples.value.map((s) => ({ at: s.at, v: s.total })),
  },
  {
    name: t('common.fatal'),
    color: '#ff5252',
    points: metricSamples.value.map((s) => ({ at: s.at, v: s.fatal })),
  },
]);
const cpuSeries = computed(() => [
  {
    name: 'CPU',
    color: '#f5a623',
    points: metricSamples.value.map((s) => ({ at: s.at, v: s.cpu })),
  },
]);
const memSeries = computed(() => [
  {
    name: t('serverDetail.memory'),
    color: '#7c5cff',
    points: metricSamples.value.map((s) => ({ at: s.at, v: s.mem })),
  },
]);
const hasResourceTrend = computed(() =>
  metricSamples.value.some((s) => s.cpu != null || s.mem != null),
);
const loadSeries = computed(() => [
  {
    name: 'load',
    color: '#3aa0ff',
    points: metricSamples.value.map((s) => ({ at: s.at, v: s.load })),
  },
]);
const hostUsageSeries = computed(() => [
  {
    name: t('serverDetail.hostMem'),
    color: '#7c5cff',
    points: metricSamples.value.map((s) => ({ at: s.at, v: s.memPct })),
  },
  {
    name: t('serverDetail.hostDisk'),
    color: '#f5a623',
    points: metricSamples.value.map((s) => ({ at: s.at, v: s.diskPct })),
  },
]);
const hasHostTrend = computed(() =>
  metricSamples.value.some((s) => s.load != null || s.memPct != null || s.diskPct != null),
);

onMounted(async () => {
  if (!serversStore.servers.length) await serversStore.fetchAll();
  subscribe();
  loadDaemon();
  loadHost();
  loadMetrics();
  hostTimer = setInterval(loadHost, 15000);
  metricsTimer = setInterval(loadMetrics, 15000);
});
onBeforeUnmount(() => {
  unsubscribe();
  if (hostTimer) clearInterval(hostTimer);
  if (metricsTimer) clearInterval(metricsTimer);
});

watch(serverId, (next, prev) => {
  if (prev) realtime.unsubscribe(prev);
  if (next) realtime.subscribe(next);
  loadDaemon();
  loadHost();
  loadMetrics();
});

// Daemon actions
const confirmDialog = ref({ show: false, message: '', fn: null });
function askConfirm(message, fn) {
  confirmDialog.value = { show: true, message, fn };
}
async function runConfirm() {
  const fn = confirmDialog.value.fn;
  confirmDialog.value = { show: false, message: '', fn: null };
  if (fn) await fn();
}

async function daemonReload() {
  try {
    const r = await serversApi.daemonReload(serverId.value);
    snackbar.value = {
      show: true,
      color: 'success',
      text: t('serverDetail.reloadDone', {
        a: r.added?.length || 0,
        c: r.changed?.length || 0,
        r: r.removed?.length || 0,
      }),
    };
    loadDaemon();
  } catch (e) {
    snackbar.value = { show: true, color: 'error', text: e.response?.data?.error || e.message };
  }
}
function daemonRestart() {
  askConfirm(t('serverDetail.restartDaemonConfirm'), async () => {
    try {
      await serversApi.daemonRestart(serverId.value);
      snackbar.value = { show: true, color: 'success', text: t('serverDetail.daemonRestarted') };
    } catch (e) {
      snackbar.value = { show: true, color: 'error', text: e.response?.data?.error || e.message };
    }
  });
}
function daemonShutdown() {
  askConfirm(t('serverDetail.shutdownDaemonConfirm'), async () => {
    try {
      await serversApi.daemonShutdown(serverId.value);
      snackbar.value = { show: true, color: 'info', text: t('serverDetail.daemonShutdown') };
    } catch (e) {
      snackbar.value = { show: true, color: 'error', text: e.response?.data?.error || e.message };
    }
  });
}

async function bulk(action, label) {
  bulkBusy.value = true;
  try {
    await bulkApi[action](serverId.value);
    snackbar.value = { show: true, color: 'success', text: label };
  } catch (e) {
    snackbar.value = { show: true, color: 'error', text: e.response?.data?.error || e.message };
  } finally {
    bulkBusy.value = false;
  }
}

function onAction({ ok, message }) {
  snackbar.value = { show: true, color: ok ? 'success' : 'error', text: message };
}

// Signal-all dialog
const SIGNALS = ['HUP', 'INT', 'TERM', 'USR1', 'USR2', 'QUIT', 'KILL'];
const signalDialog = ref({ show: false, signal: 'HUP', busy: false });
function openSignalAll() {
  signalDialog.value = { show: true, signal: 'HUP', busy: false };
}
async function sendSignalAll() {
  signalDialog.value.busy = true;
  try {
    await bulkApi.signalAll(serverId.value, signalDialog.value.signal);
    snackbar.value = {
      show: true,
      color: 'success',
      text: t('serverDetail.signalSent', { sig: signalDialog.value.signal }),
    };
    signalDialog.value.show = false;
  } catch (e) {
    snackbar.value = { show: true, color: 'error', text: e.response?.data?.error || e.message };
  } finally {
    signalDialog.value.busy = false;
  }
}
</script>

<template>
  <PageShell back="/servers">
    <template #hero-title>
      <span class="text-truncate">{{ server?.name || t('serverDetail.fallbackName') }}</span>
      <v-chip size="x-small" variant="flat" color="white" label class="text-primary">{{
        methodLabel(server?.method)
      }}</v-chip>
      <v-chip v-if="daemonStyle" size="x-small" :color="daemonStyle.color" variant="flat" label>
        <v-icon start size="12" :icon="daemonStyle.icon" />
        {{ t('serverDetail.daemon', { state: snapshot.state.statename }) }}
      </v-chip>
    </template>

    <template #hero-subtitle>
      <span class="d-flex align-center ga-3 flex-wrap">
        <span v-if="connTarget" class="d-flex align-center ga-1">
          <v-icon size="13" :icon="methodMeta.icon" /> {{ connTarget }}
        </span>
        <span v-if="daemon && daemon.version" class="d-flex align-center ga-1">
          <v-icon size="13" icon="mdi-cog-outline" />
          {{ t('serverDetail.daemonVersion', { version: daemon.version, pid: daemon.pid || '—' }) }}
        </span>
        <span v-if="paused" class="d-flex align-center ga-1">
          <v-icon icon="mdi-pause-circle" size="13" /> {{ t('serverDetail.paused') }}
        </span>
        <span v-else class="d-flex align-center ga-1">
          <span class="live-dot" :class="realtime.connected ? 'on' : 'off'" />
          {{ t('serverDetail.update', { time: formatRelative(lastUpdate) }) }}
        </span>
      </span>
    </template>

    <template #hero-actions>
      <v-menu location="bottom end" :close-on-content-click="true">
        <template #activator="{ props: menu }">
          <v-btn v-bind="menu" variant="flat" color="white" append-icon="mdi-dots-vertical">
            {{ t('serverDetail.actions') }}
          </v-btn>
        </template>

        <v-list width="320" density="comfortable" lines="two">
          <v-list-subheader>{{ t('serverDetail.sectionProcesses') }}</v-list-subheader>
          <v-list-item
            prepend-icon="mdi-play"
            :title="t('serverDetail.startAll')"
            :subtitle="t('serverDetail.startAllDesc')"
            base-color="success"
            @click="bulk('startAll', t('serverDetail.startedAll'))"
          />
          <v-list-item
            prepend-icon="mdi-restart"
            :title="t('serverDetail.restartAll')"
            :subtitle="t('serverDetail.restartAllDesc')"
            base-color="info"
            @click="bulk('restartAll', t('serverDetail.restartedAll'))"
          />
          <v-list-item
            prepend-icon="mdi-stop"
            :title="t('serverDetail.stopAll')"
            :subtitle="t('serverDetail.stopAllDesc')"
            base-color="error"
            @click="bulk('stopAll', t('serverDetail.stoppedAll'))"
          />
          <v-list-item
            prepend-icon="mdi-signal-variant"
            :title="t('serverDetail.signalAll')"
            :subtitle="t('serverDetail.signalAllDesc')"
            @click="openSignalAll"
          />
          <v-list-item
            prepend-icon="mdi-broom"
            :title="t('serverDetail.clearAllLogs')"
            :subtitle="t('serverDetail.clearAllLogsDesc')"
            @click="bulk('clearAllLogs', t('serverDetail.clearedAllLogs'))"
          />

          <v-divider class="my-1" />
          <v-list-subheader>{{ t('serverDetail.host') }}</v-list-subheader>
          <v-list-item
            :prepend-icon="paused ? 'mdi-play-circle-outline' : 'mdi-pause-circle-outline'"
            :title="paused ? t('serverDetail.resume') : t('serverDetail.pause')"
            :subtitle="paused ? t('serverDetail.resumeDesc') : t('serverDetail.pauseDesc')"
            @click="togglePause"
          />
          <v-list-item
            prepend-icon="mdi-medical-bag"
            :title="t('serverDetail.diagnose')"
            :subtitle="t('serverDetail.diagnoseDesc')"
            @click="installPanel = true"
          />
          <v-list-item
            v-if="auth.can('config:write')"
            prepend-icon="mdi-lightning-bolt"
            :title="t('events.title')"
            :subtitle="t('events.menuDesc')"
            @click="eventPanel = true"
          />
          <v-list-item
            v-if="auth.can('process:control')"
            prepend-icon="mdi-heart-pulse"
            :title="t('health.title')"
            :subtitle="t('health.menuDesc')"
            @click="healthPanel = true"
          />

          <v-divider class="my-1" />
          <v-list-subheader>{{ t('serverDetail.sectionDaemon') }}</v-list-subheader>
          <v-list-item
            prepend-icon="mdi-file-cog-outline"
            :title="t('config.open')"
            :subtitle="t('serverDetail.configDesc')"
            @click="configPanel = true"
          />
          <v-list-item
            prepend-icon="mdi-text-box-outline"
            :title="t('log.viewDaemonLog')"
            :subtitle="t('serverDetail.daemonLogDesc')"
            @click="daemonLogPanel = true"
          />
          <v-list-item
            prepend-icon="mdi-reload"
            :title="t('serverDetail.reload')"
            :subtitle="t('serverDetail.reloadDesc')"
            @click="daemonReload"
          />
          <v-list-item
            prepend-icon="mdi-restart-alert"
            :title="t('serverDetail.restartDaemon')"
            :subtitle="t('serverDetail.restartDaemonDesc')"
            @click="daemonRestart"
          />
          <v-list-item
            prepend-icon="mdi-power"
            :title="t('serverDetail.shutdownDaemon')"
            :subtitle="t('serverDetail.shutdownDaemonDesc')"
            base-color="error"
            @click="daemonShutdown"
          />
        </v-list>
      </v-menu>
    </template>

    <!-- Content -->
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">
      {{ error }}
      <template #append>
        <v-btn
          size="small"
          variant="tonal"
          prepend-icon="mdi-medical-bag"
          @click="installPanel = true"
          >{{ t('serverDetail.diagnose') }}</v-btn
        >
      </template>
    </v-alert>

    <!-- Compact overview strip: status counts · health · host metrics -->
    <v-card
      v-if="stats.length"
      rounded="lg"
      class="d-flex align-center flex-wrap px-3 py-2 mb-3"
      style="row-gap: 10px; column-gap: 18px"
    >
      <div class="d-flex align-center flex-wrap" style="gap: 16px">
        <v-tooltip v-for="c in stats" :key="c.label" :text="c.label" location="bottom">
          <template #activator="{ props: tip }">
            <div v-bind="tip" class="d-inline-flex align-center ga-1" style="cursor: default">
              <v-icon :icon="c.icon" :color="c.color" size="16" />
              <span
                class="text-h6 font-weight-bold"
                style="font-variant-numeric: tabular-nums; line-height: 1"
                :class="`text-${c.color === 'grey' ? 'medium-emphasis' : c.color}`"
                >{{ c.value }}</span
              >
              <span class="text-caption text-medium-emphasis">{{ c.label }}</span>
            </div>
          </template>
        </v-tooltip>
      </div>

      <div v-if="health" class="d-inline-flex align-center ga-2 text-medium-emphasis">
        <div
          class="d-flex rounded overflow-hidden bg-surface-variant"
          style="width: 120px; height: 7px"
        >
          <div
            v-for="s in health.seg"
            :key="s.key"
            :class="`bg-${s.color}`"
            class="h-100"
            :style="{ width: (s.value / health.total) * 100 + '%' }"
            :title="`${s.key}: ${s.value}`"
          />
        </div>
        <span class="text-body-2 font-weight-bold" style="font-variant-numeric: tabular-nums"
          >%{{ health.pct }}</span
        >
      </div>

      <template v-if="host">
        <div
          class="d-inline-flex align-center ga-1 text-medium-emphasis"
          :class="{ 'text-warning': loadHigh }"
        >
          <v-icon icon="mdi-speedometer" size="15" />
          <span
            class="text-body-2 font-weight-bold"
            style="font-variant-numeric: tabular-nums"
            :title="t('serverDetail.hostLoad')"
            >{{ host.load ? `${host.load.one}·${host.load.five}·${host.load.fifteen}` : '—' }}</span
          >
        </div>
        <div class="d-inline-flex align-center ga-1 text-medium-emphasis">
          <v-icon icon="mdi-memory" size="15" />
          <span
            class="text-body-2 font-weight-bold"
            style="font-variant-numeric: tabular-nums"
            :title="t('serverDetail.hostMem')"
            >{{ host.mem ? `${host.mem.usedMb}/${host.mem.totalMb}MB` : '—' }}</span
          >
        </div>
        <div class="d-inline-flex align-center ga-1 text-medium-emphasis">
          <v-icon icon="mdi-harddisk" size="15" />
          <span
            class="text-body-2 font-weight-bold"
            style="font-variant-numeric: tabular-nums"
            :title="t('serverDetail.hostDisk')"
            >{{ host.disk ? `%${host.disk.usePct}` : '—' }}</span
          >
        </div>
        <div class="d-inline-flex align-center ga-1 text-medium-emphasis">
          <v-icon icon="mdi-clock-outline" size="15" />
          <span
            class="text-body-2 font-weight-bold"
            style="font-variant-numeric: tabular-nums"
            :title="t('serverDetail.hostUptime')"
            >{{ host.uptimeSec ? formatUptime(host.uptimeSec) : '—' }}</span
          >
        </div>
      </template>
    </v-card>

    <!-- Trend charts (time series) -->
    <v-card v-if="snapshot" rounded="lg" class="mb-4">
      <div class="d-flex align-center px-4 py-2">
        <v-icon icon="mdi-chart-line" size="18" class="me-2" />
        <span class="text-subtitle-2 font-weight-medium">{{ t('serverDetail.trends') }}</span>
        <v-spacer />
        <v-btn-toggle
          v-if="showTrends"
          :model-value="metricRange"
          mandatory
          density="compact"
          variant="outlined"
          divided
          class="me-2"
          @update:model-value="setRange"
        >
          <v-btn v-for="r in RANGES" :key="r.v" :value="r.v" size="small" class="px-2">{{
            r.label
          }}</v-btn>
        </v-btn-toggle>
        <v-btn
          :icon="showTrends ? 'mdi-chevron-up' : 'mdi-chevron-down'"
          variant="text"
          size="small"
          @click="toggleTrends"
        />
      </div>
      <v-expand-transition>
        <div v-if="showTrends" class="px-4 pb-4">
          <v-row>
            <v-col cols="12" :md="hasResourceTrend ? 4 : 12">
              <div class="text-caption text-medium-emphasis mb-1">
                {{ t('serverDetail.trendProcesses') }}
              </div>
              <TrendChart :series="procSeries" :height="130" />
            </v-col>
            <template v-if="hasResourceTrend">
              <v-col cols="12" md="4">
                <div class="text-caption text-medium-emphasis mb-1">
                  {{ t('serverDetail.trendCpu') }}
                </div>
                <TrendChart :series="cpuSeries" :height="130" unit="%" />
              </v-col>
              <v-col cols="12" md="4">
                <div class="text-caption text-medium-emphasis mb-1">
                  {{ t('serverDetail.trendMemory') }}
                </div>
                <TrendChart :series="memSeries" :height="130" unit=" MB" />
              </v-col>
            </template>
          </v-row>
          <v-row v-if="hasHostTrend" class="mt-1">
            <v-col cols="12" md="6">
              <div class="text-caption text-medium-emphasis mb-1">
                {{ t('serverDetail.trendHostLoad') }}
              </div>
              <TrendChart :series="loadSeries" :height="120" />
            </v-col>
            <v-col cols="12" md="6">
              <div class="text-caption text-medium-emphasis mb-1">
                {{ t('serverDetail.trendHostUsage') }}
              </div>
              <TrendChart :series="hostUsageSeries" :height="120" unit="%" :y-max="100" />
            </v-col>
          </v-row>
          <div
            v-if="!hasResourceTrend && !hasHostTrend"
            class="text-caption text-medium-emphasis mt-2"
          >
            <v-icon icon="mdi-information-outline" size="13" />
            {{ t('serverDetail.trendNoResource') }}
          </div>
        </div>
      </v-expand-transition>
    </v-card>

    <!-- Loading -->
    <div v-if="!snapshot && !error" class="py-12 d-flex flex-column align-center ga-3">
      <v-progress-circular indeterminate color="primary" />
      <span class="text-medium-emphasis text-body-2">{{ t('serverDetail.loading') }}</span>
    </div>

    <ProcessTable
      v-else-if="snapshot"
      :server-id="serverId"
      :groups="snapshot.groups"
      @action="onAction"
    />

    <SupervisorInstallPanel v-model="installPanel" :server="server" />
    <LogPanel v-model="daemonLogPanel" :server-id="serverId" daemon @action="onAction" />
    <ConfigPanel v-model="configPanel" :server-id="serverId" @action="onAction" />
    <EventListenerPanel v-model="eventPanel" :server-id="serverId" @action="onAction" />
    <HealthChecksPanel
      v-model="healthPanel"
      :server-id="serverId"
      :processes="snapshot?.processes || []"
      @action="onAction"
    />

    <!-- Signal all processes -->
    <v-dialog v-model="signalDialog.show" max-width="420">
      <v-card rounded="lg">
        <v-card-title>{{ t('serverDetail.signalAll') }}</v-card-title>
        <v-card-text>
          <p class="text-body-2 text-medium-emphasis mb-3">{{ t('serverDetail.signalAllHint') }}</p>
          <v-select
            v-model="signalDialog.signal"
            :items="SIGNALS"
            label="Signal"
            variant="outlined"
            density="comfortable"
            prepend-inner-icon="mdi-signal-variant"
            hide-details
          >
            <template #selection="{ item }">SIG{{ item.value }}</template>
            <template #item="{ item, props: p }"
              ><v-list-item v-bind="p" :title="`SIG${item.value}`"
            /></template>
          </v-select>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="signalDialog.show = false">{{ t('common.cancel') }}</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :loading="signalDialog.busy"
            @click="sendSignalAll"
            >{{ t('serverDetail.send') }}</v-btn
          >
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="confirmDialog.show" max-width="460">
      <v-card>
        <v-card-text class="pt-5">{{ confirmDialog.message }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmDialog.show = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="error" variant="flat" @click="runConfirm">{{
            t('serverDetail.confirm')
          }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar
      v-model="snackbar.show"
      :color="snackbar.color"
      location="bottom right"
      :timeout="4000"
    >
      {{ snackbar.text }}
    </v-snackbar>
  </PageShell>
</template>

<style scoped>
.min-w-0 {
  min-width: 0;
}

/* Live dot: pulsing realtime-connection indicator (keyframe animation). */
.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.live-dot.on {
  background: rgb(var(--v-theme-success));
  animation: pulse 2s infinite;
}
.live-dot.off {
  background: rgb(var(--v-theme-error));
}
@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(var(--v-theme-success), 0.5);
  }
  70% {
    box-shadow: 0 0 0 6px rgba(var(--v-theme-success), 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(var(--v-theme-success), 0);
  }
}
</style>
