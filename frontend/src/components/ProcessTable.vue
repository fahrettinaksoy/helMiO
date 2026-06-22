<script setup>
import { ref, computed, nextTick, reactive, watch, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import StatusChip from './StatusChip.vue';
import LogPanel from './LogPanel.vue';
import ProcessDetailPanel from './ProcessDetailPanel.vue';
import { formatUptime, formatDateTime, stateStyle } from '@/utils/format';
import { processesApi, groupsApi } from '@/api/client';

const { t } = useI18n();

const logPanel = ref(false);
const logTarget = ref(null);
function openLog(p) {
  logTarget.value = p;
  logPanel.value = true;
}

const detailPanel = ref(false);
const detailTarget = ref(null);
function openDetail(p) {
  detailTarget.value = p;
  detailPanel.value = true;
}

const props = defineProps({
  serverId: { type: String, required: true },
  groups: { type: Array, default: () => [] }, // [{ group, total, running, processes }]
});
const emit = defineEmits(['action']);

const search = ref('');
const searchField = ref('all'); // all | name | command | status | pid
const busy = ref({}); // fullName / "g:<group>" -> bool

const searchFields = computed(() => [
  { value: 'all', title: t('processTable.filterAll') },
  { value: 'name', title: t('processTable.colProcess') },
  { value: 'command', title: t('processTable.colCommand') },
  { value: 'status', title: t('processTable.colStatus') },
  { value: 'pid', title: t('processTable.colPid') },
]);

function matchSearch(p) {
  const q = search.value.trim().toLowerCase();
  if (!q) return true;
  const checks = {
    name: () => p.fullName.toLowerCase().includes(q),
    command: () => (p.config?.command || '').toLowerCase().includes(q),
    status: () => p.statename.toLowerCase().includes(q),
    pid: () => String(p.pid || '').includes(q),
    description: () => (p.description || '').toLowerCase().includes(q),
  };
  if (searchField.value === 'all') return Object.values(checks).some((fn) => fn());
  return checks[searchField.value]();
}

// Flatten groups into a single item list; v-data-table groups them by `group`.
const allProcesses = computed(() => props.groups.flatMap((g) => g.processes));

// Status filter chips
const statusFilter = ref('all');
const matchers = {
  all: () => true,
  running: (p) => p.statecode === 20,
  stopped: (p) => p.statecode === 0,
  fatal: (p) => p.statecode === 200,
  other: (p) => ![0, 20, 200].includes(p.statecode),
};
const statusFilters = computed(() => {
  const all = allProcesses.value;
  return [
    { key: 'all', label: t('processTable.filterAll'), color: 'primary', count: all.length },
    {
      key: 'running',
      label: t('common.running'),
      color: 'success',
      count: all.filter(matchers.running).length,
    },
    {
      key: 'stopped',
      label: t('common.stopped'),
      color: 'grey',
      count: all.filter(matchers.stopped).length,
    },
    {
      key: 'fatal',
      label: t('common.fatal'),
      color: 'error',
      count: all.filter(matchers.fatal).length,
    },
    {
      key: 'other',
      label: t('common.other'),
      color: 'warning',
      count: all.filter(matchers.other).length,
    },
  ];
});
const displayedProcesses = computed(() =>
  allProcesses.value.filter((p) => matchers[statusFilter.value](p) && matchSearch(p)),
);

// CPU/RAM stats (present only on shell-capable connectors)
const hasStats = computed(() => allProcesses.value.some((p) => p.cpu !== undefined));
const cpuHistory = reactive({}); // fullName -> number[]
watch(
  () => props.groups,
  () => {
    const seen = new Set();
    for (const p of allProcesses.value) {
      seen.add(p.fullName);
      if (p.cpu === undefined) continue;
      const arr = cpuHistory[p.fullName] || (cpuHistory[p.fullName] = []);
      arr.push(p.cpu);
      if (arr.length > 24) arr.shift();
    }
    for (const k of Object.keys(cpuHistory)) if (!seen.has(k)) delete cpuHistory[k];
  },
  { immediate: true },
);

// Per-group running/total for the group-header slot.
const groupMeta = computed(() => {
  const map = {};
  for (const g of props.groups) {
    let cpu = 0;
    let mem = 0;
    let hasS = false;
    for (const p of g.processes) {
      if (p.cpu !== undefined) {
        cpu += p.cpu;
        hasS = true;
      }
      if (p.memMb !== undefined) mem += p.memMb;
    }
    map[g.group] = {
      running: g.running,
      total: g.total,
      cpu: hasS ? Math.round(cpu * 10) / 10 : undefined,
      memMb: hasS ? Math.round(mem * 10) / 10 : undefined,
    };
  }
  return map;
});

// Toggleable columns (order = display order). needsStats → only on shell connectors.
const COLUMN_DEFS = [
  { key: 'pid', titleKey: 'colPid', width: 80, sortable: true },
  { key: 'uptime', titleKey: 'colUptime', width: 110, sortable: true },
  { key: 'cpu', titleKey: 'colCpu', width: 130, sortable: true, needsStats: true },
  { key: 'memMb', titleKey: 'colMem', width: 100, sortable: true, needsStats: true },
  { key: 'start', titleKey: 'colStarted', width: 130, sortable: true },
  { key: 'exitstatus', titleKey: 'colExitCode', width: 80, sortable: true },
  { key: 'restarts', titleKey: 'colRestarts', width: 110, sortable: true },
  { key: 'priority', titleKey: 'colPriority', width: 90, sortable: false, needsConfig: true },
  { key: 'autostart', titleKey: 'colAutostart', width: 100, sortable: false, needsConfig: true },
  {
    key: 'autorestart',
    titleKey: 'colAutorestart',
    width: 110,
    sortable: false,
    needsConfig: true,
  },
  { key: 'command', titleKey: 'colCommand', sortable: false, needsConfig: true },
  { key: 'description', titleKey: 'colDescription', sortable: false },
];
const DEFAULT_VISIBLE = {
  pid: true,
  uptime: true,
  cpu: true,
  memMb: true,
  start: false,
  exitstatus: false,
  restarts: false,
  priority: false,
  autostart: false,
  autorestart: false,
  command: false,
  description: true,
};
const hasConfig = computed(() => allProcesses.value.some((p) => p.config));

function loadVisible() {
  try {
    const saved = JSON.parse(localStorage.getItem('helmio-cols') || 'null');
    if (saved) return { ...DEFAULT_VISIBLE, ...saved };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_VISIBLE };
}
const visibleCols = reactive(loadVisible());
watch(visibleCols, (v) => {
  try {
    localStorage.setItem('helmio-cols', JSON.stringify(v));
  } catch {
    /* ignore */
  }
});

// Columns available in the visibility menu (hide stats columns on non-shell connectors).
const columnOptions = computed(() =>
  COLUMN_DEFS.filter(
    (d) => (!d.needsStats || hasStats.value) && (!d.needsConfig || hasConfig.value),
  ),
);

const headers = computed(() => {
  const cols = [
    { title: t('processTable.colProcess'), key: 'name', sortable: true },
    { title: t('processTable.colStatus'), key: 'statename', width: 140, sortable: true },
  ];
  for (const def of columnOptions.value) {
    if (!visibleCols[def.key]) continue;
    cols.push({
      title: t(`processTable.${def.titleKey}`),
      key: def.key,
      width: def.width,
      sortable: def.sortable,
    });
  }
  cols.push({
    title: t('processTable.logs'),
    key: 'a_logs',
    width: 70,
    align: 'center',
    sortable: false,
  });
  cols.push({
    title: t('processTable.start'),
    key: 'a_start',
    width: 80,
    align: 'center',
    sortable: false,
  });
  cols.push({
    title: t('processTable.stop'),
    key: 'a_stop',
    width: 80,
    align: 'center',
    sortable: false,
  });
  cols.push({
    title: t('processTable.restart'),
    key: 'a_restart',
    width: 90,
    align: 'center',
    sortable: false,
  });
  return cols;
});

const groupBy = [{ key: 'group', order: 'asc' }];

async function run(key, fn, label) {
  busy.value = { ...busy.value, [key]: true };
  try {
    await fn();
    emit('action', { ok: true, message: label });
  } catch (e) {
    emit('action', { ok: false, message: e.response?.data?.error || e.message });
  } finally {
    busy.value = { ...busy.value, [key]: false };
  }
}

const startP = (p) =>
  run(
    p.fullName,
    () => processesApi.start(props.serverId, p.fullName),
    t('processTable.startedMsg', { name: p.fullName }),
  );
const stopP = (p) =>
  run(
    p.fullName,
    () => processesApi.stop(props.serverId, p.fullName),
    t('processTable.stoppedMsg', { name: p.fullName }),
  );
const restartP = (p) =>
  run(
    p.fullName,
    () => processesApi.restart(props.serverId, p.fullName),
    t('processTable.restartedMsg', { name: p.fullName }),
  );
const startG = (group) =>
  run(
    `g:${group}`,
    () => groupsApi.start(props.serverId, group),
    t('processTable.groupStartedMsg', { name: group }),
  );
const stopG = (group) =>
  run(
    `g:${group}`,
    () => groupsApi.stop(props.serverId, group),
    t('processTable.groupStoppedMsg', { name: group }),
  );
const restartG = (group) =>
  run(
    `g:${group}`,
    () => groupsApi.restart(props.serverId, group),
    t('processTable.groupRestartedMsg', { name: group }),
  );

// Multi-select bulk actions
const selected = ref([]); // fullName[]
const procByName = computed(() =>
  Object.fromEntries(allProcesses.value.map((p) => [p.fullName, p])),
);
async function bulk(action) {
  const names = [...selected.value];
  busy.value = { ...busy.value, _bulk: true };
  try {
    await Promise.all(
      names.map((n) =>
        (action === 'start' ? processesApi.start : processesApi.stop)(props.serverId, n),
      ),
    );
    emit('action', {
      ok: true,
      message: t('processTable.bulkDone', {
        n: names.length,
        action: action === 'start' ? t('processTable.start') : t('processTable.stop'),
      }),
    });
    selected.value = [];
  } catch (e) {
    emit('action', { ok: false, message: e.response?.data?.error || e.message });
  } finally {
    busy.value = { ...busy.value, _bulk: false };
  }
}

// Export
function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function exportJson() {
  download('processes.json', JSON.stringify(allProcesses.value, null, 2), 'application/json');
}
function exportCsv() {
  const cols = ['fullName', 'group', 'statename', 'pid', 'uptime', 'cpu', 'memMb', 'description'];
  const lines = [cols.join(',')];
  for (const p of allProcesses.value) lines.push(cols.map((c) => csvCell(p[c])).join(','));
  download('processes.csv', lines.join('\n'), 'text/csv');
}

// Fit the table to the viewport: measure everything above it, give the rest as
// the table's own scroll height (with a fixed header).
const tableWrap = ref(null);
const tableHeight = ref(420);
function recalcHeight() {
  if (!tableWrap.value) return;
  const top = tableWrap.value.getBoundingClientRect().top;
  const h = Math.max(240, Math.floor(window.innerHeight - top - 12));
  tableHeight.value = h;
  // Self-correct: trim by whatever the page still overflows (no page scroll).
  nextTick(() => {
    const overflow = document.documentElement.scrollHeight - window.innerHeight;
    if (overflow > 0) tableHeight.value = Math.max(240, h - overflow);
  });
}
onMounted(() => {
  recalcHeight();
  window.addEventListener('resize', recalcHeight);
});
onBeforeUnmount(() => window.removeEventListener('resize', recalcHeight));
watch([() => props.groups, hasStats, hasConfig, statusFilter, searchField], () =>
  nextTick(recalcHeight),
);

const isRunning = (p) => p.statecode === 20;
const isTransitional = (p) => [10, 40].includes(p.statecode); // STARTING / STOPPING
// "Active" = running or transitioning → Stop/Restart make sense; otherwise only Start.
const isActive = (p) => isRunning(p) || isTransitional(p);

// Groups start collapsed in Vuetify; open each one once on first render.
// Tracked so a group the user manually closes stays closed afterwards.
const autoOpened = new Set();
const groupCtx = {}; // group value -> { item, isGroupOpen, toggleGroup } (latest render)
function ensureOpen(item, isGroupOpen, toggleGroup) {
  groupCtx[item.value] = { item, isGroupOpen, toggleGroup };
  if (!isGroupOpen(item) && !autoOpened.has(item.value)) {
    autoOpened.add(item.value);
    nextTick(() => toggleGroup(item));
  }
  return '';
}

const allCollapsed = ref(false);
function toggleAllGroups() {
  const collapse = !allCollapsed.value;
  for (const c of Object.values(groupCtx)) {
    autoOpened.add(c.item.value); // prevent ensureOpen from re-opening after collapse
    const open = c.isGroupOpen(c.item);
    if (collapse && open) c.toggleGroup(c.item);
    else if (!collapse && !open) c.toggleGroup(c.item);
  }
  allCollapsed.value = collapse;
}
</script>

<template>
  <div>
    <v-card variant="flat" rounded="lg" class="overflow-hidden">
      <div class="d-flex align-center search-row">
        <v-select
          v-model="searchField"
          :items="searchFields"
          variant="solo-filled"
          density="comfortable"
          flat
          hide-details
          class="flex-0-0 search-scope"
        />
        <v-divider vertical />
        <v-text-field
          v-model="search"
          :placeholder="t('processTable.searchPlaceholder')"
          prepend-inner-icon="mdi-magnify"
          variant="solo-filled"
          density="comfortable"
          flat
          hide-details
          clearable
          class="search-field flex-grow-1"
        />
      </div>
      <v-divider />

      <!-- Status filter chips + tools / selection bar -->
      <div class="d-flex align-center ga-2 flex-wrap pa-3">
        <template v-if="selected.length">
          <v-chip color="primary" variant="flat" size="small" label>{{
            t('processTable.selected', { n: selected.length })
          }}</v-chip>
          <v-btn
            size="small"
            variant="tonal"
            color="success"
            prepend-icon="mdi-play"
            :loading="busy._bulk"
            @click="bulk('start')"
            >{{ t('processTable.startSelected') }}</v-btn
          >
          <v-btn
            size="small"
            variant="tonal"
            color="error"
            prepend-icon="mdi-stop"
            :loading="busy._bulk"
            @click="bulk('stop')"
            >{{ t('processTable.stopSelected') }}</v-btn
          >
          <v-btn size="small" variant="text" @click="selected = []">{{
            t('processTable.clearSelection')
          }}</v-btn>
        </template>
        <template v-else>
          <v-chip
            v-for="f in statusFilters"
            :key="f.key"
            :color="statusFilter === f.key ? f.color : undefined"
            :variant="statusFilter === f.key ? 'flat' : 'tonal'"
            size="small"
            label
            @click="statusFilter = f.key"
          >
            {{ f.label }}
            <span class="count-badge ms-2">{{ f.count }}</span>
          </v-chip>
        </template>

        <v-spacer />
        <v-menu :close-on-content-click="false">
          <template #activator="{ props: menu }">
            <v-tooltip :text="t('processTable.columns')" location="top">
              <template #activator="{ props: tip }">
                <v-btn
                  v-bind="{ ...menu, ...tip }"
                  icon="mdi-table-cog"
                  size="small"
                  variant="text"
                />
              </template>
            </v-tooltip>
          </template>
          <v-list density="compact">
            <v-list-item v-for="def in columnOptions" :key="def.key" class="px-2">
              <v-checkbox
                v-model="visibleCols[def.key]"
                :label="t(`processTable.${def.titleKey}`)"
                density="compact"
                color="primary"
                hide-details
              />
            </v-list-item>
          </v-list>
        </v-menu>
        <v-menu>
          <template #activator="{ props: menu }">
            <v-tooltip :text="t('processTable.export')" location="top">
              <template #activator="{ props: tip }">
                <v-btn
                  v-bind="{ ...menu, ...tip }"
                  icon="mdi-download"
                  size="small"
                  variant="text"
                />
              </template>
            </v-tooltip>
          </template>
          <v-list density="compact" nav>
            <v-list-item
              prepend-icon="mdi-file-delimited-outline"
              :title="t('processTable.exportCsv')"
              @click="exportCsv"
            />
            <v-list-item
              prepend-icon="mdi-code-json"
              :title="t('processTable.exportJson')"
              @click="exportJson"
            />
          </v-list>
        </v-menu>
        <v-tooltip
          :text="allCollapsed ? t('processTable.expandAll') : t('processTable.collapseAll')"
          location="top"
        >
          <template #activator="{ props: tip }">
            <v-btn
              v-bind="tip"
              :icon="allCollapsed ? 'mdi-unfold-more-horizontal' : 'mdi-unfold-less-horizontal'"
              size="small"
              variant="text"
              @click="toggleAllGroups"
            />
          </template>
        </v-tooltip>
      </div>
      <v-divider />

      <div ref="tableWrap">
        <v-data-table
          v-model="selected"
          :headers="headers"
          :items="displayedProcesses"
          :group-by="groupBy"
          item-value="fullName"
          show-select
          density="comfortable"
          hover
          fixed-header
          :height="tableHeight"
          hide-default-footer
          :items-per-page="-1"
          class="bg-transparent process-table"
        >
          <!-- Custom group header: name area (colspan) + action cells aligned with
           the process Start/Stop/Restart columns. -->
          <template #group-header="{ item, columns, toggleGroup, isGroupOpen }">
            <tr class="group-header-row">
              <td :colspan="columns.length - 4">
                <span v-show="false">{{ ensureOpen(item, isGroupOpen, toggleGroup) }}</span>
                <div class="d-flex align-center ga-2">
                  <v-btn
                    :icon="isGroupOpen(item) ? 'mdi-chevron-down' : 'mdi-chevron-right'"
                    size="small"
                    variant="text"
                    @click="toggleGroup(item)"
                  />
                  <v-avatar color="primary" variant="tonal" rounded="lg" size="26"
                    ><v-icon icon="mdi-folder-cog" size="16"
                  /></v-avatar>
                  <span class="text-subtitle-2 font-weight-bold">{{ item.value }}</span>

                  <div v-if="groupMeta[item.value]" class="d-flex align-center ga-2 ms-1">
                    <v-progress-linear
                      :model-value="
                        (groupMeta[item.value].running / groupMeta[item.value].total) * 100
                      "
                      color="success"
                      height="5"
                      rounded
                      style="width: 56px"
                    />
                    <span class="text-caption text-medium-emphasis mono"
                      >{{ groupMeta[item.value].running }}/{{ groupMeta[item.value].total }}</span
                    >
                  </div>

                  <span
                    v-if="groupMeta[item.value] && groupMeta[item.value].cpu !== undefined"
                    class="d-inline-flex align-center ga-1 ms-2 text-caption text-medium-emphasis mono"
                  >
                    <v-icon icon="mdi-chip" size="13" /> {{ groupMeta[item.value].cpu }}%
                    <span class="mx-1">·</span>
                    <v-icon icon="mdi-memory" size="13" /> {{ groupMeta[item.value].memMb }} MB
                  </span>
                </div>
              </td>
              <!-- logs column: no group-level logs -->
              <td class="text-center" />
              <td class="text-center">
                <v-tooltip :text="t('processTable.startGroup')" location="top">
                  <template #activator="{ props: tip }">
                    <v-btn
                      v-bind="tip"
                      icon="mdi-play"
                      size="small"
                      variant="text"
                      color="success"
                      :disabled="
                        groupMeta[item.value] &&
                        groupMeta[item.value].running >= groupMeta[item.value].total
                      "
                      :loading="busy[`g:${item.value}`]"
                      @click="startG(item.value)"
                    />
                  </template>
                </v-tooltip>
              </td>
              <td class="text-center">
                <v-tooltip :text="t('processTable.stopGroup')" location="top">
                  <template #activator="{ props: tip }">
                    <v-btn
                      v-bind="tip"
                      icon="mdi-stop"
                      size="small"
                      variant="text"
                      color="error"
                      :disabled="groupMeta[item.value] && groupMeta[item.value].running === 0"
                      :loading="busy[`g:${item.value}`]"
                      @click="stopG(item.value)"
                    />
                  </template>
                </v-tooltip>
              </td>
              <td class="text-center">
                <v-tooltip :text="t('processTable.restartGroup')" location="top">
                  <template #activator="{ props: tip }">
                    <v-btn
                      v-bind="tip"
                      icon="mdi-restart"
                      size="small"
                      variant="text"
                      color="info"
                      :disabled="groupMeta[item.value] && groupMeta[item.value].running === 0"
                      :loading="busy[`g:${item.value}`]"
                      @click="restartG(item.value)"
                    />
                  </template>
                </v-tooltip>
              </td>
            </tr>
          </template>

          <!-- Process name with status accent dot, monospace -->
          <template #[`item.name`]="{ item }">
            <div class="d-flex align-center ga-2">
              <v-icon icon="mdi-circle" size="8" :color="stateStyle(item.statename).color" />
              <button type="button" class="proc-name proc-link" @click="openDetail(item)">
                {{ item.name }}
              </button>
              <v-tooltip v-if="item.flapping" :text="t('processTable.flapping')" location="top">
                <template #activator="{ props: tip }">
                  <v-icon v-bind="tip" icon="mdi-alert-decagram" color="warning" size="16" />
                </template>
              </v-tooltip>
            </div>
          </template>

          <template #[`item.statename`]="{ item }">
            <StatusChip :statename="item.statename" size="x-small" />
          </template>

          <template #[`item.pid`]="{ item }">
            <span class="mono text-medium-emphasis">{{ item.pid || '—' }}</span>
          </template>

          <template #[`item.uptime`]="{ item }">
            <span class="mono">{{ formatUptime(item.uptime) }}</span>
          </template>

          <template #[`item.cpu`]="{ item }">
            <div v-if="item.cpu !== undefined" class="d-flex align-center ga-2">
              <v-sparkline
                v-if="cpuHistory[item.fullName] && cpuHistory[item.fullName].length > 1"
                :model-value="cpuHistory[item.fullName]"
                :line-width="3"
                :smooth="4"
                auto-draw
                :auto-draw-duration="300"
                height="22"
                width="60"
                color="primary"
                class="spark"
              />
              <span class="mono">{{ item.cpu.toFixed(1) }}%</span>
            </div>
            <span v-else class="text-medium-emphasis">—</span>
          </template>

          <template #[`item.memMb`]="{ item }">
            <span class="mono">{{ item.memMb !== undefined ? item.memMb + ' MB' : '—' }}</span>
          </template>

          <template #[`item.start`]="{ item }">
            <span class="mono">{{ formatDateTime(item.start) }}</span>
          </template>

          <template #[`item.exitstatus`]="{ item }">
            <span class="mono">{{ item.exitstatus ?? '—' }}</span>
          </template>

          <template #[`item.restarts`]="{ item }">
            <span class="mono" :class="{ 'text-warning font-weight-bold': item.flapping }">{{
              item.restarts ?? 0
            }}</span>
          </template>

          <template #[`item.priority`]="{ item }">
            <span class="mono">{{ item.config?.priority ?? '—' }}</span>
          </template>

          <template #[`item.autostart`]="{ item }">
            <v-icon
              v-if="item.config"
              :icon="item.config.autostart ? 'mdi-check-circle' : 'mdi-minus-circle-outline'"
              :color="item.config.autostart ? 'success' : 'grey'"
              size="18"
            />
            <span v-else>—</span>
          </template>

          <template #[`item.autorestart`]="{ item }">
            <template v-if="item.config">
              <v-chip
                v-if="typeof item.config.autorestart === 'string'"
                size="x-small"
                variant="tonal"
                label
                >{{ item.config.autorestart }}</v-chip
              >
              <v-icon
                v-else
                :icon="item.config.autorestart ? 'mdi-check-circle' : 'mdi-minus-circle-outline'"
                :color="item.config.autorestart ? 'success' : 'grey'"
                size="18"
              />
            </template>
            <span v-else>—</span>
          </template>

          <template #[`item.command`]="{ item }">
            <span class="mono cmd" :title="item.config?.command">{{
              item.config?.command || '—'
            }}</span>
          </template>

          <template #[`item.description`]="{ item }">
            <span class="text-caption text-medium-emphasis">{{ item.description || '—' }}</span>
          </template>

          <template #[`item.a_logs`]="{ item }">
            <v-tooltip :text="t('processTable.logs')" location="top">
              <template #activator="{ props: tip }">
                <v-btn
                  v-bind="tip"
                  icon="mdi-text-box-outline"
                  size="small"
                  variant="text"
                  @click="openLog(item)"
                />
              </template>
            </v-tooltip>
          </template>
          <template #[`item.a_start`]="{ item }">
            <v-tooltip :text="t('processTable.start')" location="top">
              <template #activator="{ props: tip }">
                <v-btn
                  v-bind="tip"
                  icon="mdi-play"
                  size="small"
                  variant="text"
                  color="success"
                  :disabled="isActive(item)"
                  :loading="busy[item.fullName]"
                  @click="startP(item)"
                />
              </template>
            </v-tooltip>
          </template>
          <template #[`item.a_stop`]="{ item }">
            <v-tooltip :text="t('processTable.stop')" location="top">
              <template #activator="{ props: tip }">
                <v-btn
                  v-bind="tip"
                  icon="mdi-stop"
                  size="small"
                  variant="text"
                  color="error"
                  :disabled="!isActive(item)"
                  :loading="busy[item.fullName]"
                  @click="stopP(item)"
                />
              </template>
            </v-tooltip>
          </template>
          <template #[`item.a_restart`]="{ item }">
            <v-tooltip :text="t('processTable.restart')" location="top">
              <template #activator="{ props: tip }">
                <v-btn
                  v-bind="tip"
                  icon="mdi-restart"
                  size="small"
                  variant="text"
                  color="info"
                  :disabled="!isActive(item)"
                  :loading="busy[item.fullName]"
                  @click="restartP(item)"
                />
              </template>
            </v-tooltip>
          </template>

          <template #no-data>
            <div class="py-6 text-center text-medium-emphasis">{{ t('processTable.empty') }}</div>
          </template>
        </v-data-table>
      </div>
    </v-card>

    <LogPanel
      v-model="logPanel"
      :server-id="serverId"
      :process="logTarget"
      @action="emit('action', $event)"
    />
    <ProcessDetailPanel
      v-model="detailPanel"
      :server-id="serverId"
      :process="detailTarget"
      @action="emit('action', $event)"
    />
  </div>
</template>

<style scoped>
/* Solo search fields: flush, tinted, square — no Vuetify variant matches. */
.search-row :deep(.v-field) {
  background: rgba(var(--v-theme-on-surface), 0.03);
  border-radius: 0;
}
.search-scope {
  max-width: 170px;
}
.count-badge {
  font-size: 0.7rem;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(var(--v-theme-on-surface), 0.14);
  font-variant-numeric: tabular-nums;
}

/* Group header row: tinted <td> band — no component equivalent. */
.group-header-row td {
  background: rgba(var(--v-theme-on-surface), 0.04);
  padding: 6px 10px !important;
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.06) !important;
}

/* Clickable monospace process name (plain <button>). */
.proc-name {
  font-weight: 600;
  font-size: 0.86rem;
}
.proc-link {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: inherit;
  text-align: left;
}
.proc-link:hover {
  color: rgb(var(--v-theme-primary));
  text-decoration: underline;
}
/* Tabular monospace runs (pid/uptime/cpu/etc.). */
.mono,
.proc-name {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
}
.mono {
  font-size: 0.84rem;
}
.cmd {
  display: inline-block;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}

/* Quiet, locale-safe column headers (no uppercase to avoid Turkish İ). */
.process-table :deep(thead th) {
  font-size: 0.72rem !important;
  letter-spacing: 0.3px;
  color: rgba(var(--v-theme-on-surface), 0.55) !important;
  font-weight: 600;
  text-transform: none;
}
</style>
