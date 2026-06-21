<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { useServersStore } from '@/stores/servers';
import { useRealtimeStore } from '@/stores/realtime';
import { useUiStore } from '@/stores/ui';
import { useI18n } from 'vue-i18n';
import SupervisorInstallPanel from '@/components/SupervisorInstallPanel.vue';
import ServerCard from '@/components/ServerCard.vue';
import PageShell from '@/components/PageShell.vue';
import { methodLabel } from '@/utils/format';
import { overviewApi } from '@/api/client';

const { t } = useI18n();
const store = useServersStore();
const realtime = useRealtimeStore();
const ui = useUiStore();
const installPanel = ref(false);
const installTarget = ref(null);
const testing = ref({});
const snackbar = ref({ show: false, color: 'success', text: '' });
const confirmDelete = ref(null);
const q = ref('');

const view = ref(localStorage.getItem('helmio-servers-view') || 'cards');
function setView(v) {
  view.value = v;
  localStorage.setItem('helmio-servers-view', v);
}

const METHOD_ICON = {
  tcp: 'mdi-lan',
  local: 'mdi-power-socket',
  ssh: 'mdi-console-network',
  docker: 'mdi-docker',
  agent: 'mdi-robot',
};
const methodIcon = (m) => METHOD_ICON[m] || 'mdi-server';

function connTarget(s) {
  switch (s.method) {
    case 'tcp': return `${s.host}:${s.port}`;
    case 'local': return s.socketPath;
    case 'ssh': return `${s.sshUser}@${s.sshHost}:${s.sshPort}`;
    case 'docker': return s.container;
    case 'agent': return s.agentUrl;
    default: return '';
  }
}

const filteredServers = computed(() => {
  const term = q.value.trim().toLowerCase();
  if (!term) return store.servers;
  return store.servers.filter(
    (s) => s.name.toLowerCase().includes(term) || methodLabel(s.method).toLowerCase().includes(term)
  );
});

// --- Live status for the card view (realtime snapshots + host metrics) ---
let subscribed = [];
function syncSubscriptions() {
  const ids = store.servers.map((s) => s.id);
  subscribed.forEach((id) => { if (!ids.includes(id)) realtime.unsubscribe(id); });
  ids.forEach((id) => { if (!subscribed.includes(id)) realtime.subscribe(id); });
  subscribed = ids;
}
const hostById = ref({});
async function loadHosts() {
  try {
    const ov = await overviewApi.get(60);
    hostById.value = Object.fromEntries((ov.metrics.hosts || []).map((h) => [h.serverId, h]));
  } catch { /* host metrics optional */ }
}

function segmentsOf({ running = 0, other = 0, stopped = 0, fatal = 0 }) {
  return [
    { key: 'running', color: 'success', value: running },
    { key: 'other', color: 'warning', value: other },
    { key: 'stopped', color: 'grey', value: stopped },
    { key: 'fatal', color: 'error', value: fatal },
  ].filter((x) => x.value > 0);
}
function vmFor(s) {
  const snap = realtime.snapshots[s.id];
  const error = realtime.errors[s.id];
  const sum = snap?.summary;
  return {
    id: s.id, name: s.name, method: s.method, connTarget: connTarget(s), error, summary: sum,
    statusColor: error ? 'error' : sum ? (sum.fatal ? 'warning' : 'success') : 'grey',
    segments: sum ? segmentsOf(sum) : [],
    lastUpdate: realtime.lastUpdate[s.id],
    host: hostById.value[s.id],
  };
}

const headers = computed(() => [
  { title: t('servers.colName'), key: 'name', sortable: true },
  { title: t('servers.colMethod'), key: 'method', width: 150, sortable: true },
  { title: t('servers.colConnection'), key: 'connection', sortable: false },
  { title: t('servers.colActions'), key: 'actions', width: 260, align: 'end', sortable: false },
]);

// Fit the list to the viewport; the list scrolls inside, the page doesn't.
const listWrap = ref(null);
const listHeight = ref(420);
function recalcHeight() {
  if (!listWrap.value) return;
  const top = listWrap.value.getBoundingClientRect().top;
  const h = Math.max(240, Math.floor(window.innerHeight - top - 12));
  listHeight.value = h;
  nextTick(() => {
    const overflow = document.documentElement.scrollHeight - window.innerHeight;
    if (overflow > 0) listHeight.value = Math.max(240, h - overflow);
  });
}
onMounted(async () => {
  if (!store.servers.length) await store.fetchAll();
  syncSubscriptions();
  loadHosts();
  recalcHeight();
  window.addEventListener('resize', recalcHeight);
});
onBeforeUnmount(() => {
  subscribed.forEach((id) => realtime.unsubscribe(id));
  window.removeEventListener('resize', recalcHeight);
});
watch([view, () => store.servers.length, q], () => nextTick(recalcHeight));
watch(() => store.servers.map((s) => s.id).join(','), () => { syncSubscriptions(); loadHosts(); });

function add() {
  ui.openAddServer();
}
function edit(server) {
  ui.openEditServer(server);
}
function openInstall(server) {
  installTarget.value = server;
  installPanel.value = true;
}

async function test(server) {
  testing.value = { ...testing.value, [server.id]: true };
  try {
    const res = await store.test(server.id);
    snackbar.value = {
      show: true,
      color: res.ok ? 'success' : 'error',
      text: res.ok ? t('servers.testOk', { name: server.name, version: res.version }) : `${server.name}: ${res.error}`,
    };
  } catch (e) {
    snackbar.value = { show: true, color: 'error', text: e.response?.data?.error || e.message };
  } finally {
    testing.value = { ...testing.value, [server.id]: false };
  }
}

async function doDelete() {
  const server = confirmDelete.value;
  confirmDelete.value = null;
  await store.remove(server.id);
  snackbar.value = { show: true, color: 'info', text: t('servers.deleted', { name: server.name }) };
}
</script>

<template>
  <PageShell :title="t('servers.title')" :subtitle="t('servers.subtitle')" icon="mdi-server">
    <template #hero-actions>
      <v-btn color="white" variant="tonal" prepend-icon="mdi-plus" @click="add">{{ t('servers.addServer') }}</v-btn>
    </template>

    <template #toolbar-actions>
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
        class="srv-search me-2"
      />
      <v-btn-toggle :model-value="view" mandatory density="comfortable" variant="outlined" divided class="view-toggle" @update:model-value="setView">
        <v-tooltip :text="t('servers.cardView')" location="bottom">
          <template #activator="{ props: tip }"><v-btn v-bind="tip" value="cards" icon="mdi-view-grid-outline" /></template>
        </v-tooltip>
        <v-tooltip :text="t('servers.tableView')" location="bottom">
          <template #activator="{ props: tip }"><v-btn v-bind="tip" value="table" icon="mdi-table" /></template>
        </v-tooltip>
      </v-btn-toggle>
    </template>

    <v-alert v-if="store.error" type="error" variant="tonal" class="mb-4" :text="store.error" />

    <div ref="listWrap">
    <!-- Loading skeletons -->
    <template v-if="store.loading && !store.servers.length">
      <v-row v-if="view === 'cards'">
        <v-col v-for="n in 3" :key="n" cols="12" md="6" lg="4">
          <v-skeleton-loader type="article, actions" class="server-card" />
        </v-col>
      </v-row>
      <v-skeleton-loader v-else type="table-row@5" class="server-card" />
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
        <v-btn color="primary" prepend-icon="mdi-plus" @click="add">{{ t('servers.addServer') }}</v-btn>
      </template>
    </v-empty-state>

    <!-- Card view -->
    <div v-else-if="view === 'cards'" class="srv-scroll" :style="{ height: listHeight + 'px' }">
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
    <v-card v-else variant="flat" class="server-card">
      <v-data-table
        :headers="headers"
        :items="filteredServers"
        item-value="id"
        density="comfortable"
        hover
        fixed-header
        :height="listHeight"
        hide-default-footer
        :items-per-page="-1"
        class="bg-transparent srv-table"
      >
        <template #[`item.name`]="{ item }">
          <router-link :to="`/servers/${item.id}`" class="d-flex align-center ga-2 text-decoration-none srv-name">
            <v-avatar color="primary" variant="tonal" rounded size="32"><v-icon :icon="methodIcon(item.method)" size="18" /></v-avatar>
            <span class="font-weight-medium">{{ item.name }}</span>
          </router-link>
        </template>
        <template #[`item.method`]="{ item }">
          <v-chip size="x-small" variant="tonal" label>{{ methodLabel(item.method) }}</v-chip>
        </template>
        <template #[`item.connection`]="{ item }">
          <span class="mono text-medium-emphasis">{{ connTarget(item) }}</span>
        </template>
        <template #[`item.actions`]="{ item }">
          <div class="d-flex justify-end ga-1">
            <v-tooltip :text="t('servers.processes')" location="top">
              <template #activator="{ props: tip }"><v-btn v-bind="tip" size="small" icon="mdi-view-list" variant="text" :to="`/servers/${item.id}`" /></template>
            </v-tooltip>
            <v-tooltip :text="t('servers.diagnose')" location="top">
              <template #activator="{ props: tip }"><v-btn v-bind="tip" size="small" icon="mdi-medical-bag" variant="text" @click="openInstall(item)" /></template>
            </v-tooltip>
            <v-tooltip :text="t('common.test')" location="top">
              <template #activator="{ props: tip }"><v-btn v-bind="tip" size="small" icon="mdi-connection" variant="text" :loading="testing[item.id]" @click="test(item)" /></template>
            </v-tooltip>
            <v-tooltip :text="t('common.edit')" location="top">
              <template #activator="{ props: tip }"><v-btn v-bind="tip" size="small" icon="mdi-pencil" variant="text" @click="edit(item)" /></template>
            </v-tooltip>
            <v-tooltip :text="t('common.delete')" location="top">
              <template #activator="{ props: tip }"><v-btn v-bind="tip" size="small" icon="mdi-delete" variant="text" color="error" @click="confirmDelete = item" /></template>
            </v-tooltip>
          </div>
        </template>
      </v-data-table>
    </v-card>
    </div>

    <SupervisorInstallPanel v-model="installPanel" :server="installTarget" />

    <v-dialog :model-value="!!confirmDelete" max-width="420" @update:model-value="confirmDelete = null">
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

    <v-snackbar v-model="snackbar.show" :color="snackbar.color" location="bottom right" :timeout="4000">
      {{ snackbar.text }}
    </v-snackbar>
  </PageShell>
</template>

<style scoped>
.server-card {
  border: 0px;
}
.srv-search {
  width: 340px;
  max-width: 42vw;
}
.view-toggle .v-btn {
  min-width: 52px;
}
/* Card view: scrolls inside, page stays put */
.srv-scroll {
  overflow-y: auto;
  padding-right: 4px;
}
.srv-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}
.srv-table :deep(thead th) {
  background: rgb(var(--v-theme-surface)) !important;
}
.conn {
  min-width: 0;
}
.mono {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.82rem;
}
.srv-name {
  color: inherit;
}
.srv-name:hover .font-weight-medium {
  color: rgb(var(--v-theme-primary));
}
</style>
