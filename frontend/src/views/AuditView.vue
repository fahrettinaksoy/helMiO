<script setup>
import { ref, onMounted, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { auditApi } from '@/api/client';
import { useServersStore } from '@/stores/servers';
import PageShell from '@/components/PageShell.vue';

const { t } = useI18n();
const serversStore = useServersStore();

const data = ref({ items: [], total: 0, limit: 100, offset: 0 });
const loading = ref(false);
const error = ref('');
const filter = ref({ status: null, action: '' });

const statusOptions = [
  { value: null, title: t('audit.allStatuses') },
  { value: 'ok', title: t('audit.ok') },
  { value: 'error', title: t('audit.error') },
];

const headers = computed(() => [
  { title: t('audit.colTime'), key: 'at', width: 180 },
  { title: t('audit.colActor'), key: 'actorName', width: 150 },
  { title: t('audit.colAction'), key: 'action', width: 170 },
  { title: t('audit.colTarget'), key: 'target' },
  { title: t('audit.colServer'), key: 'serverId', width: 160 },
  { title: t('audit.colStatus'), key: 'status', width: 100 },
  { title: 'IP', key: 'ip', width: 130 },
]);

function serverName(id) {
  if (!id) return '—';
  return serversStore.byId?.(id)?.name || id;
}

// Group action verbs by their prefix for colour/icon cues.
function actionColor(a) {
  if (a.startsWith('auth')) return 'primary';
  if (a.startsWith('user')) return 'secondary';
  if (a.includes('delete') || a.includes('shutdown') || a === 'access.denied') return 'error';
  if (a.startsWith('daemon') || a.includes('restart')) return 'warning';
  return 'info';
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const params = { limit: 200 };
    if (filter.value.status) params.status = filter.value.status;
    if (filter.value.action.trim()) params.action = filter.value.action.trim();
    data.value = await auditApi.query(params);
  } catch (e) {
    error.value = e.response?.data?.error || e.message;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  if (!serversStore.servers.length) serversStore.fetchAll();
  load();
});
</script>

<template>
  <PageShell :title="t('audit.title')" :subtitle="t('audit.subtitle')" icon="mdi-clipboard-text-clock">
    <template #hero-actions>
      <v-btn color="white" variant="tonal" prepend-icon="mdi-refresh" @click="load">{{ t('audit.refresh') }}</v-btn>
    </template>

    <template #toolbar-actions>
      <v-text-field
        v-model="filter.action"
        :placeholder="t('audit.filterAction')"
        prepend-inner-icon="mdi-filter-variant"
        variant="solo-filled"
        density="compact"
        flat
        hide-details
        clearable
        rounded="lg"
        class="me-2 audit-filter"
        @keyup.enter="load"
      />
      <v-select
        v-model="filter.status"
        :items="statusOptions"
        variant="solo-filled"
        density="compact"
        flat
        hide-details
        rounded="lg"
        class="audit-status me-2"
        @update:model-value="load"
      />
    </template>

    <v-alert v-if="error" type="error" variant="tonal" class="mb-4" :text="error" />

    <v-card variant="flat" class="panel-card">
      <v-data-table
        :headers="headers"
        :items="data.items"
        :loading="loading"
        item-value="id"
        density="compact"
        hover
        hide-default-footer
        :items-per-page="-1"
        class="bg-transparent mono-table"
      >
        <template #[`item.at`]="{ item }">
          <span class="text-caption">{{ new Date(item.at).toLocaleString() }}</span>
        </template>
        <template #[`item.actorName`]="{ item }">
          <span class="font-weight-medium">{{ item.actorName }}</span>
          <span v-if="item.role" class="text-caption text-medium-emphasis"> · {{ t(`roles.${item.role}`) }}</span>
        </template>
        <template #[`item.action`]="{ item }">
          <v-chip :color="actionColor(item.action)" size="x-small" variant="tonal" label>{{ item.action }}</v-chip>
        </template>
        <template #[`item.target`]="{ item }">
          <span class="text-truncate d-inline-block" style="max-width: 280px">{{ item.target || '—' }}</span>
          <div v-if="item.detail" class="text-caption text-medium-emphasis text-truncate" style="max-width: 280px">{{ item.detail }}</div>
        </template>
        <template #[`item.serverId`]="{ item }">
          <span class="text-caption">{{ serverName(item.serverId) }}</span>
        </template>
        <template #[`item.status`]="{ item }">
          <v-icon :icon="item.status === 'ok' ? 'mdi-check-circle' : 'mdi-alert-circle'" :color="item.status === 'ok' ? 'success' : 'error'" size="18" />
        </template>
        <template #[`item.ip`]="{ item }">
          <span class="text-caption text-medium-emphasis">{{ item.ip || '—' }}</span>
        </template>
        <template #no-data>
          <div class="py-8 text-center text-medium-emphasis">{{ t('audit.empty') }}</div>
        </template>
      </v-data-table>
      <div class="px-4 py-2 text-caption text-medium-emphasis d-flex align-center">
        <v-icon icon="mdi-information-outline" size="14" class="me-1" />
        {{ t('audit.showing', { shown: data.items.length, total: data.total }) }}
      </div>
    </v-card>
  </PageShell>
</template>

<style scoped>
.panel-card {
  border: 1px solid rgba(var(--v-theme-on-surface), 0.08);
}
.audit-filter { width: 240px; max-width: 40vw; }
.audit-status { width: 160px; }
.mono-table :deep(td) { font-size: 0.82rem; }
</style>
