<script setup>
import { computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServersStore } from '@/stores/servers';
import { useRealtimeStore } from '@/stores/realtime';
import { methodLabel } from '@/utils/format';
import PageShell from '@/components/PageShell.vue';

const { t } = useI18n();

const serversStore = useServersStore();
const realtime = useRealtimeStore();

let subscribed = [];
function syncSubscriptions() {
  const ids = serversStore.servers.map((s) => s.id);
  subscribed.forEach((id) => { if (!ids.includes(id)) realtime.unsubscribe(id); });
  ids.forEach((id) => { if (!subscribed.includes(id)) realtime.subscribe(id); });
  subscribed = ids;
}

onMounted(async () => {
  if (!serversStore.servers.length) await serversStore.fetchAll();
  syncSubscriptions();
});
onBeforeUnmount(() => subscribed.forEach((id) => realtime.unsubscribe(id)));
watch(() => serversStore.servers.map((s) => s.id).join(','), syncSubscriptions);

const totals = computed(() => {
  let total = 0, running = 0, fatal = 0, online = 0;
  for (const s of serversStore.servers) {
    const snap = realtime.snapshots[s.id];
    if (snap) {
      online += 1;
      total += snap.summary.total;
      running += snap.summary.running;
      fatal += snap.summary.fatal;
    }
  }
  return { servers: serversStore.servers.length, online, total, running, fatal };
});

function serverStat(id) {
  return realtime.snapshots[id]?.summary;
}
function serverError(id) {
  return realtime.errors[id];
}
</script>

<template>
  <PageShell :title="t('dashboard.title')" :subtitle="t('dashboard.subtitle')" icon="mdi-view-dashboard-outline">
    <template #hero-actions>
      <v-chip color="white" variant="tonal" size="small" class="me-1">
        {{ t('dashboard.onlineChip', { online: totals.online, total: totals.servers }) }}
      </v-chip>
      <v-btn icon="mdi-refresh" variant="text" @click="serversStore.fetchAll()" />
    </template>

    <template #toolbar-actions>
      <v-chip size="small" variant="tonal" prepend-icon="mdi-cog">{{ t('dashboard.processChip', { running: totals.running, total: totals.total }) }}</v-chip>
    </template>

    <!-- Totals -->
    <v-row class="mb-2">
      <v-col cols="6" md="3">
        <v-card variant="flat" class="stat pa-4">
          <div class="text-caption text-medium-emphasis">{{ t('nav.servers') }}</div>
          <div class="text-h4 font-weight-bold">{{ totals.online }}/{{ totals.servers }}</div>
          <div class="text-caption text-medium-emphasis">{{ t('dashboard.online') }}</div>
        </v-card>
      </v-col>
      <v-col cols="6" md="3">
        <v-card variant="flat" class="stat pa-4">
          <div class="text-caption text-medium-emphasis">{{ t('dashboard.totalProcesses') }}</div>
          <div class="text-h4 font-weight-bold">{{ totals.total }}</div>
        </v-card>
      </v-col>
      <v-col cols="6" md="3">
        <v-card variant="flat" class="stat pa-4">
          <div class="text-caption text-success">{{ t('common.running') }}</div>
          <div class="text-h4 font-weight-bold text-success">{{ totals.running }}</div>
        </v-card>
      </v-col>
      <v-col cols="6" md="3">
        <v-card variant="flat" class="stat pa-4">
          <div class="text-caption text-error">{{ t('common.fatal') }}</div>
          <div class="text-h4 font-weight-bold" :class="totals.fatal ? 'text-error' : ''">{{ totals.fatal }}</div>
        </v-card>
      </v-col>
    </v-row>

    <v-card v-if="!serversStore.servers.length && !serversStore.loading" variant="flat" class="stat pa-12 text-center">
      <v-icon icon="mdi-server-off" size="48" class="text-medium-emphasis mb-3" />
      <div class="text-h6">{{ t('dashboard.noServers') }}</div>
      <div class="text-medium-emphasis mb-4">{{ t('dashboard.noServersSub') }}</div>
      <v-btn color="primary" prepend-icon="mdi-plus" to="/servers">{{ t('dashboard.addServer') }}</v-btn>
    </v-card>

    <v-row v-else>
      <v-col v-for="s in serversStore.servers" :key="s.id" cols="12" md="6" lg="4">
        <v-card variant="flat" :to="`/servers/${s.id}`" class="h-100 stat">
          <v-card-item>
            <template #prepend>
              <v-avatar :color="serverError(s.id) ? 'error' : serverStat(s.id) ? 'success' : 'grey'" size="36">
                <v-icon icon="mdi-server" />
              </v-avatar>
            </template>
            <v-card-title>{{ s.name }}</v-card-title>
            <v-card-subtitle>{{ methodLabel(s.method) }}</v-card-subtitle>
          </v-card-item>
          <v-card-text>
            <div v-if="serverError(s.id)" class="text-error text-body-2">
              <v-icon icon="mdi-alert-circle" size="16" /> {{ serverError(s.id) }}
            </div>
            <div v-else-if="serverStat(s.id)" class="d-flex ga-4">
              <div><span class="text-h6 font-weight-bold">{{ serverStat(s.id).running }}</span> <span class="text-caption text-medium-emphasis">{{ t('dashboard.running') }}</span></div>
              <div><span class="text-h6 font-weight-bold">{{ serverStat(s.id).total }}</span> <span class="text-caption text-medium-emphasis">{{ t('dashboard.total') }}</span></div>
              <div v-if="serverStat(s.id).fatal"><span class="text-h6 font-weight-bold text-error">{{ serverStat(s.id).fatal }}</span> <span class="text-caption text-medium-emphasis">{{ t('dashboard.fatal') }}</span></div>
            </div>
            <div v-else class="text-medium-emphasis text-body-2">
              <v-progress-circular indeterminate size="16" width="2" class="me-2" /> {{ t('dashboard.connecting') }}
            </div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </PageShell>
</template>

<style scoped>
.stat {
  border: 1px solid rgba(var(--v-theme-on-surface), 0.08);
}
</style>
