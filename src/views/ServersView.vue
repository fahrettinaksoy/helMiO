<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { overviewApi } from '@/api/client'
import DataPanel from '@/components/DataPanel.vue'
import PageShell from '@/components/PageShell.vue'
import ServerCard from '@/components/ServerCard.vue'
import SupervisorInstallPanel from '@/components/SupervisorInstallPanel.vue'
import { useRealtimeStore } from '@/stores/realtime'
import { useServersStore } from '@/stores/servers'
import { useUiStore } from '@/stores/ui'
import { methodLabel } from '@/utils/format'

const { t } = useI18n()
const store = useServersStore()
const realtime = useRealtimeStore()
const ui = useUiStore()
const installPanel = ref(false)
const installTarget = ref(null)
const testing = ref({})
const snackbar = ref({ show: false, color: 'success', text: '' })
const confirmDelete = ref(null)
const q = ref('')

const view = ref(localStorage.getItem('helmio-servers-view') || 'cards')
function setView(v) {
  view.value = v
  localStorage.setItem('helmio-servers-view', v)
}

const METHOD_ICON = {
  tcp: 'mdi-lan',
  local: 'mdi-power-socket',
  ssh: 'mdi-console-network',
  docker: 'mdi-docker',
  agent: 'mdi-robot'
}
const methodIcon = (m) => METHOD_ICON[m] || 'mdi-server'

function connTarget(s) {
  switch (s.method) {
    case 'tcp':
      return `${s.host}:${s.port}`
    case 'local':
      return s.socketPath
    case 'ssh':
      return `${s.sshUser}@${s.sshHost}:${s.sshPort}`
    case 'docker':
      return s.container
    case 'agent':
      return s.agentUrl
    default:
      return ''
  }
}

const methodFilter = ref(null)
const statusFilter = ref(null)
const methodOptions = computed(() => {
  const present = [...new Set(store.servers.map((s) => s.method))]
  return [
    { value: null, title: t('common.allMethods') },
    ...present.map((m) => ({ value: m, title: methodLabel(m) }))
  ]
})
const statusOptions = computed(() => [
  { value: null, title: t('common.allStatuses') },
  { value: 'online', title: t('servers.statusOnline') },
  { value: 'error', title: t('servers.statusError') },
  { value: 'connecting', title: t('servers.statusConnecting') }
])
// Live status bucket for a server: error > online (has snapshot) > connecting.
function serverStatus(s) {
  if (realtime.errors[s.id]) return 'error'
  if (realtime.snapshots[s.id]) return 'online'
  return 'connecting'
}

const filteredServers = computed(() => {
  const term = q.value.trim().toLowerCase()
  return store.servers.filter((s) => {
    if (methodFilter.value && s.method !== methodFilter.value) return false
    if (statusFilter.value && serverStatus(s) !== statusFilter.value) return false
    if (
      term &&
      !(s.name.toLowerCase().includes(term) || methodLabel(s.method).toLowerCase().includes(term))
    )
      return false
    return true
  })
})

// --- Live status for the card view (realtime snapshots + host metrics) ---
let subscribed = []
function syncSubscriptions() {
  const ids = store.servers.map((s) => s.id)
  subscribed.forEach((id) => {
    if (!ids.includes(id)) realtime.unsubscribe(id)
  })
  ids.forEach((id) => {
    if (!subscribed.includes(id)) realtime.subscribe(id)
  })
  subscribed = ids
}
const hostById = ref({})
async function loadHosts() {
  try {
    const ov = await overviewApi.get(60)
    hostById.value = Object.fromEntries((ov.metrics.hosts || []).map((h) => [h.serverId, h]))
  } catch {
    /* host metrics optional */
  }
}

function segmentsOf({ running = 0, other = 0, stopped = 0, fatal = 0 }) {
  return [
    { key: 'running', color: 'success', value: running },
    { key: 'other', color: 'warning', value: other },
    { key: 'stopped', color: 'grey', value: stopped },
    { key: 'fatal', color: 'error', value: fatal }
  ].filter((x) => x.value > 0)
}
function vmFor(s) {
  const snap = realtime.snapshots[s.id]
  const error = realtime.errors[s.id]
  const sum = snap?.summary
  return {
    id: s.id,
    name: s.name,
    method: s.method,
    connTarget: connTarget(s),
    error,
    summary: sum,
    statusColor: error ? 'error' : sum ? (sum.fatal ? 'warning' : 'success') : 'grey',
    segments: sum ? segmentsOf(sum) : [],
    lastUpdate: realtime.lastUpdate[s.id],
    host: hostById.value[s.id]
  }
}

const headers = computed(() => [
  { title: t('servers.colName'), key: 'name', sortable: true },
  { title: t('servers.colMethod'), key: 'method', width: 130, sortable: true },
  { title: t('servers.colConnection'), key: 'connection', sortable: false },
  { title: t('servers.colStatus'), key: 'status', width: 220, sortable: false },
  { title: t('servers.colHost'), key: 'host', width: 180, sortable: false },
  { title: t('servers.colActions'), key: 'actions', width: 230, align: 'end', sortable: false }
])

onMounted(async () => {
  if (!store.servers.length) await store.fetchAll()
  syncSubscriptions()
  loadHosts()
})
onBeforeUnmount(() => {
  subscribed.forEach((id) => realtime.unsubscribe(id))
})
watch(
  () => store.servers.map((s) => s.id).join(','),
  () => {
    syncSubscriptions()
    loadHosts()
  }
)

function add() {
  ui.openAddServer()
}
function edit(server) {
  ui.openEditServer(server)
}
function openInstall(server) {
  installTarget.value = server
  installPanel.value = true
}

async function test(server) {
  testing.value = { ...testing.value, [server.id]: true }
  try {
    const res = await store.test(server.id)
    snackbar.value = {
      show: true,
      color: res.ok ? 'success' : 'error',
      text: res.ok
        ? t('servers.testOk', { name: server.name, version: res.version })
        : `${server.name}: ${res.error}`
    }
  } catch (e) {
    snackbar.value = { show: true, color: 'error', text: e.response?.data?.error || e.message }
  } finally {
    testing.value = { ...testing.value, [server.id]: false }
  }
}

async function doDelete() {
  const server = confirmDelete.value
  confirmDelete.value = null
  await store.remove(server.id)
  snackbar.value = { show: true, color: 'info', text: t('servers.deleted', { name: server.name }) }
}
</script>

<template>
  <PageShell :title="t('servers.title')" :subtitle="t('servers.subtitle')" icon="mdi-server">
    <template #hero-actions>
      <v-btn color="white" variant="tonal" prepend-icon="mdi-plus" @click="add">{{
        t('servers.addServer')
      }}</v-btn>
    </template>

    <v-alert v-if="store.error" type="error" variant="tonal" class="mb-4" :text="store.error" />

    <DataPanel>
      <template #filters>
        <v-text-field
          v-model="q"
          :placeholder="t('servers.search')"
          prepend-inner-icon="mdi-magnify"
          variant="solo-filled"
          density="compact"
          flat
          hide-details
          clearable
          rounded="lg"
          class="srv-search"
        />
        <v-select
          v-model="methodFilter"
          :items="methodOptions"
          variant="solo-filled"
          density="compact"
          flat
          hide-details
          rounded="lg"
          class="flt-select"
        />
        <v-select
          v-model="statusFilter"
          :items="statusOptions"
          variant="solo-filled"
          density="compact"
          flat
          hide-details
          rounded="lg"
          class="flt-select"
        />
        <v-btn-toggle
          :model-value="view"
          mandatory
          density="comfortable"
          variant="outlined"
          divided
          class="view-toggle"
          @update:model-value="setView"
        >
          <v-tooltip :text="t('servers.cardView')" location="bottom">
            <template #activator="{ props: tip }"
              ><v-btn v-bind="tip" value="cards" icon="mdi-view-grid-outline"
            /></template>
          </v-tooltip>
          <v-tooltip :text="t('servers.tableView')" location="bottom">
            <template #activator="{ props: tip }"
              ><v-btn v-bind="tip" value="table" icon="mdi-table"
            /></template>
          </v-tooltip>
        </v-btn-toggle>
      </template>

      <template #default="{ height }">
        <!-- Loading skeletons -->
        <template v-if="store.loading && !store.servers.length">
          <div class="pa-3">
            <div v-if="view === 'cards'" class="srv-card-grid">
              <v-skeleton-loader v-for="n in 3" :key="n" type="article, actions" />
            </div>
            <v-skeleton-loader v-else type="table-row@5" />
          </div>
        </template>

        <!-- Empty: no match -->
        <v-empty-state
          v-else-if="store.servers.length && !filteredServers.length"
          icon="mdi-magnify-close"
          :title="t('servers.noMatch')"
          :text="t('servers.noMatchSub', { q })"
        />

        <!-- Empty: no servers -->
        <v-empty-state
          v-else-if="!store.servers.length"
          icon="mdi-server-off"
          :title="t('servers.noServers')"
          :text="t('servers.noServersSub')"
        >
          <template #actions>
            <v-btn color="primary" prepend-icon="mdi-plus" @click="add">{{
              t('servers.addServer')
            }}</v-btn>
          </template>
        </v-empty-state>

        <!-- Card view -->
        <div
          v-else-if="view === 'cards'"
          class="overflow-y-auto px-3 pb-3"
          :style="{ height: `${height}px` }"
        >
          <div class="srv-card-grid">
            <ServerCard
              v-for="s in filteredServers"
              :key="s.id"
              :vm="vmFor(s)"
              :testing="!!testing[s.id]"
              @diagnose="openInstall(s)"
              @test="test(s)"
              @edit="edit(s)"
              @remove="confirmDelete = s"
            />
          </div>
        </div>

        <!-- Table view -->
        <v-data-table
          v-else
          :headers="headers"
          :items="filteredServers"
          item-value="id"
          density="comfortable"
          hover
          fixed-header
          :height="height"
          hide-default-footer
          :items-per-page="-1"
          class="bg-transparent srv-table"
        >
          <template #[`item.name`]="{ item }">
            <router-link
              :to="`/servers/${item.id}`"
              class="d-flex align-center ga-2 text-decoration-none srv-name"
            >
              <v-badge
                dot
                :color="vmFor(item).statusColor"
                location="bottom end"
                offset-x="3"
                offset-y="3"
                bordered
              >
                <v-avatar color="primary" variant="tonal" rounded size="32"
                  ><v-icon :icon="methodIcon(item.method)" size="18"
                /></v-avatar>
              </v-badge>
              <span class="font-weight-medium">{{ item.name }}</span>
            </router-link>
          </template>
          <template #[`item.method`]="{ item }">
            <v-chip size="x-small" variant="tonal" label>{{ methodLabel(item.method) }}</v-chip>
          </template>
          <template #[`item.connection`]="{ item }">
            <span class="mono text-medium-emphasis">{{ connTarget(item) }}</span>
          </template>
          <template #[`item.status`]="{ item }">
            <div
              v-if="vmFor(item).error"
              class="d-flex align-center ga-1 text-error text-caption text-truncate"
              style="max-width: 200px"
            >
              <v-icon icon="mdi-alert-circle" size="14" /> {{ vmFor(item).error }}
            </div>
            <div v-else-if="vmFor(item).summary">
              <div
                class="d-flex rounded overflow-hidden srv-seg-bar mb-1"
                style="height: 6px; gap: 2px; max-width: 200px"
              >
                <div
                  v-for="seg in vmFor(item).segments"
                  :key="seg.key"
                  :style="{
                    width: `${(seg.value / vmFor(item).summary.total) * 100}%`,
                    background: `rgb(var(--v-theme-${seg.color}))`
                  }"
                />
              </div>
              <div class="d-flex align-center ga-3 text-caption">
                <span
                  ><b class="text-success">{{ vmFor(item).summary.running }}</b>
                  {{ t('dashboard.running') }}</span
                >
                <span
                  ><b>{{ vmFor(item).summary.total }}</b> {{ t('dashboard.total') }}</span
                >
                <span v-if="vmFor(item).summary.fatal"
                  ><b class="text-error">{{ vmFor(item).summary.fatal }}</b>
                  {{ t('dashboard.fatal') }}</span
                >
              </div>
            </div>
            <span v-else class="d-flex align-center text-caption text-medium-emphasis">
              <v-progress-circular indeterminate size="12" width="2" class="me-1" />
              {{ t('dashboard.connecting') }}
            </span>
          </template>
          <template #[`item.host`]="{ item }">
            <div
              v-if="vmFor(item).host"
              class="d-flex align-center ga-3 text-caption text-medium-emphasis"
            >
              <span v-if="vmFor(item).host.load != null" :title="t('dashboard.load')"
                ><v-icon icon="mdi-speedometer" size="13" /> {{ vmFor(item).host.load }}</span
              >
              <span v-if="vmFor(item).host.memPct != null"
                ><v-icon icon="mdi-memory" size="13" /> %{{ vmFor(item).host.memPct }}</span
              >
              <span
                v-if="vmFor(item).host.diskPct != null"
                :class="vmFor(item).host.diskPct >= 85 ? 'text-warning' : ''"
                ><v-icon icon="mdi-harddisk" size="13" /> %{{ vmFor(item).host.diskPct }}</span
              >
            </div>
            <span v-else class="text-caption text-disabled">—</span>
          </template>
          <template #[`item.actions`]="{ item }">
            <div class="d-flex justify-end ga-1">
              <v-tooltip :text="t('servers.processes')" location="top">
                <template #activator="{ props: tip }"
                  ><v-btn
                    v-bind="tip"
                    size="small"
                    icon="mdi-view-list"
                    variant="text"
                    :to="`/servers/${item.id}`"
                /></template>
              </v-tooltip>
              <v-tooltip :text="t('servers.diagnose')" location="top">
                <template #activator="{ props: tip }"
                  ><v-btn
                    v-bind="tip"
                    size="small"
                    icon="mdi-medical-bag"
                    variant="text"
                    @click="openInstall(item)"
                /></template>
              </v-tooltip>
              <v-tooltip :text="t('common.test')" location="top">
                <template #activator="{ props: tip }"
                  ><v-btn
                    v-bind="tip"
                    size="small"
                    icon="mdi-connection"
                    variant="text"
                    :loading="testing[item.id]"
                    @click="test(item)"
                /></template>
              </v-tooltip>
              <v-tooltip :text="t('common.edit')" location="top">
                <template #activator="{ props: tip }"
                  ><v-btn
                    v-bind="tip"
                    size="small"
                    icon="mdi-pencil"
                    variant="text"
                    @click="edit(item)"
                /></template>
              </v-tooltip>
              <v-tooltip :text="t('common.delete')" location="top">
                <template #activator="{ props: tip }"
                  ><v-btn
                    v-bind="tip"
                    size="small"
                    icon="mdi-delete"
                    variant="text"
                    color="error"
                    @click="confirmDelete = item"
                /></template>
              </v-tooltip>
            </div>
          </template>
        </v-data-table>
      </template>
    </DataPanel>

    <SupervisorInstallPanel v-model="installPanel" :server="installTarget" />

    <v-dialog
      :model-value="!!confirmDelete"
      max-width="420"
      @update:model-value="confirmDelete = null"
    >
      <v-card>
        <v-card-title>{{ t('servers.deleteTitle') }}</v-card-title>
        <v-card-text>{{ t('servers.deleteConfirm', { name: confirmDelete?.name }) }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmDelete = null">{{ t('common.cancel') }}</v-btn>
          <v-btn color="error" variant="flat" @click="doDelete">{{ t('common.delete') }}</v-btn>
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
/* Structural glue with no Vuetify utility equivalent. */
.srv-search {
  width: 300px;
  max-width: 42vw;
} /* fixed search-field width */
.flt-select {
  width: 168px;
} /* filter dropdown width */
.view-toggle .v-btn {
  min-width: 52px;
} /* even toggle button width */
.srv-card-grid {
  /* responsive auto-fill grid (v-row can't auto-fill) */
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}
.srv-table :deep(thead th) {
  background: rgb(var(--v-theme-surface)) !important;
} /* sticky-header bg */
.srv-seg-bar {
  background: rgba(var(--v-theme-on-surface), 0.06);
} /* health-bar track behind segments */
.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.82rem;
}
.srv-name {
  color: inherit;
} /* link inherits text color, primary on hover */
.srv-name:hover .font-weight-medium {
  color: rgb(var(--v-theme-primary));
}
</style>
