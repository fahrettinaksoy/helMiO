<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useServersStore } from '@/stores/servers';
import { useRealtimeStore } from '@/stores/realtime';
import { useUiStore } from '@/stores/ui';
import { methodLabel } from '@/utils/format';

const { t } = useI18n();

const serversStore = useServersStore();
const realtime = useRealtimeStore();
const ui = useUiStore();
const route = useRoute();

const collapsed = ref(localStorage.getItem('helmio-serverlist-collapsed') === '1');
function toggle() {
  collapsed.value = !collapsed.value;
  localStorage.setItem('helmio-serverlist-collapsed', collapsed.value ? '1' : '0');
}

// Keep live status dots fresh by subscribing to every server while mounted.
let subscribed = [];
function sync() {
  const ids = serversStore.servers.map((s) => s.id);
  subscribed.forEach((id) => { if (!ids.includes(id)) realtime.unsubscribe(id); });
  ids.forEach((id) => { if (!subscribed.includes(id)) realtime.subscribe(id); });
  subscribed = ids;
}

onMounted(async () => {
  if (!serversStore.servers.length) await serversStore.fetchAll();
  sync();
});
onBeforeUnmount(() => subscribed.forEach((id) => realtime.unsubscribe(id)));
watch(() => serversStore.servers.map((s) => s.id).join(','), sync);

const activeId = computed(() => route.params.id);

function statusColor(id) {
  if (realtime.errors[id]) return 'error';
  if (realtime.snapshots[id]) return 'success';
  return 'grey';
}
function summary(id) {
  return realtime.snapshots[id]?.summary || null;
}
</script>

<template>
  <v-navigation-drawer
    :rail="collapsed"
    rail-width="64"
    width="280"
    color="surface"
    elevation="5"
    class="server-list-panel border-0"
  >
    <!-- Header -->
    <div v-if="!collapsed" class="d-flex align-center px-4 py-3">
      <span class="text-overline text-medium-emphasis">{{ t('serverList.title') }}</span>
      <v-chip size="x-small" variant="tonal" class="ms-2">{{ serversStore.servers.length }}</v-chip>
      <v-spacer />
      <v-tooltip :text="t('serverList.collapse')" location="bottom">
        <template #activator="{ props: tip }">
          <v-btn v-bind="tip" icon="mdi-chevron-left" size="x-small" variant="text" @click="toggle" />
        </template>
      </v-tooltip>
    </div>
    <div v-else class="d-flex justify-center py-3">
      <v-tooltip :text="t('serverList.expand')" location="end">
        <template #activator="{ props: tip }">
          <v-btn v-bind="tip" icon="mdi-chevron-right" size="small" variant="text" @click="toggle" />
        </template>
      </v-tooltip>
    </div>
    <v-divider class="mx-3" />

    <!-- Empty -->
    <div v-if="!serversStore.servers.length && !collapsed" class="pa-4 text-center text-medium-emphasis">
      <v-icon icon="mdi-server-off" size="32" class="mb-2" />
      <div class="text-body-2">{{ t('serverList.noServers') }}</div>
    </div>

    <!-- Collapsed: status dots only -->
    <div v-else-if="collapsed" class="collapsed-list">
      <v-tooltip v-for="s in serversStore.servers" :key="s.id" location="end">
        <template #activator="{ props: tip }">
          <router-link v-bind="tip" :to="`/servers/${s.id}`" class="dot-item" :class="{ active: s.id === activeId }">
            <span class="status-dot lg" :class="`bg-${statusColor(s.id)}`" />
            <v-icon v-if="summary(s.id) && summary(s.id).fatal" icon="mdi-alert-circle" color="error" size="11" class="dot-badge" />
          </router-link>
        </template>
        <div class="text-body-2 font-weight-medium">{{ s.name }}</div>
        <div class="text-caption">
          {{ methodLabel(s.method) }}<template v-if="summary(s.id)"> · {{ summary(s.id).running }}/{{ summary(s.id).total }}</template>
        </div>
      </v-tooltip>
    </div>

    <!-- Expanded: full list -->
    <v-list v-else nav density="comfortable" class="px-2 py-2">
      <v-list-item
        v-for="s in serversStore.servers"
        :key="s.id"
        :to="`/servers/${s.id}`"
        :active="s.id === activeId"
        rounded="lg"
        class="mb-1 server-item"
        color="primary"
      >
        <template #prepend>
          <span class="status-dot" :class="`bg-${statusColor(s.id)}`" />
        </template>

        <v-list-item-title class="text-body-2 font-weight-medium">{{ s.name }}</v-list-item-title>
        <v-list-item-subtitle class="text-caption">{{ methodLabel(s.method) }}</v-list-item-subtitle>

        <template #append>
          <div v-if="summary(s.id)" class="text-caption text-medium-emphasis text-no-wrap">
            <span class="text-success font-weight-bold">{{ summary(s.id).running }}</span>/{{ summary(s.id).total }}
            <v-icon v-if="summary(s.id).fatal" icon="mdi-alert-circle" color="error" size="13" class="ms-1" />
          </div>
          <v-icon v-else-if="realtime.errors[s.id]" icon="mdi-alert-circle-outline" color="error" size="16" />
          <v-progress-circular v-else indeterminate size="13" width="2" class="text-medium-emphasis" />
        </template>
      </v-list-item>
    </v-list>

    <!-- Footer: add server -->
    <template #append>
    <v-divider class="mx-3" />
      <div class="pa-2">
        <v-btn
          v-if="!collapsed"
          block
          color="primary"
          variant="tonal"
          prepend-icon="mdi-plus"
          @click="ui.openAddServer()"
        >
          {{ t('serverList.add') }}
        </v-btn>
        <div v-else class="d-flex justify-center">
          <v-tooltip :text="t('serverList.addTooltip')" location="end">
            <template #activator="{ props: tip }">
              <v-btn v-bind="tip" icon="mdi-plus" variant="tonal" color="primary" @click="ui.openAddServer()" />
            </template>
          </v-tooltip>
        </div>
      </div>
    </template>
  </v-navigation-drawer>
</template>

<style scoped>
.status-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  display: inline-block;
  margin-right: 4px;
  flex: 0 0 auto;
}
.status-dot.lg {
  width: 12px;
  height: 12px;
  margin-right: 0;
}
.server-item :deep(.v-list-item__prepend) {
  width: 18px;
  min-width: 18px;
}

/* Collapsed rail: centered status dots */
.collapsed-list {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 8px 0;
}
.dot-item {
  position: relative;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  transition: background 0.12s ease;
}
.dot-item:hover {
  background: rgba(var(--v-theme-on-surface), 0.06);
}
.dot-item.active {
  background: rgba(var(--v-theme-primary), 0.16);
}
.dot-badge {
  position: absolute;
  top: 6px;
  right: 6px;
}
</style>
