<script setup>
/**
 * Rich server card: live status dot, health distribution bar, process counts
 * and host gauges (load/mem/disk) — plus management actions. Live data is
 * passed in via the `vm` view-model so the card stays presentational.
 */
import { useI18n } from 'vue-i18n'
import { formatRelative, methodLabel } from '@/utils/format'

defineProps({
  vm: { type: Object, required: true }, // { id,name,method,connTarget,error,summary,statusColor,segments,lastUpdate,host }
  testing: { type: Boolean, default: false }
})
const emit = defineEmits(['test', 'edit', 'remove', 'diagnose'])
const { t } = useI18n()

const METHOD_ICON = {
  tcp: 'mdi-lan',
  local: 'mdi-power-socket',
  ssh: 'mdi-console-network',
  docker: 'mdi-docker',
  agent: 'mdi-robot'
}
const methodIcon = (m) => METHOD_ICON[m] || 'mdi-server'
</script>

<template>
  <v-card rounded="lg" hover class="h-100 d-flex flex-column">
    <!-- header -->
    <div class="d-flex align-center pa-3 pb-2">
      <v-icon icon="mdi-circle" size="9" :color="vm.statusColor" class="me-2 flex-0-0" />
      <div class="min-w-0 flex-grow-1">
        <router-link
          :to="`/servers/${vm.id}`"
          class="srv-name text-body-2 font-weight-bold text-truncate d-block"
          >{{ vm.name }}</router-link
        >
        <div class="text-caption text-medium-emphasis text-truncate">
          <v-icon :icon="methodIcon(vm.method)" size="12" /> {{ methodLabel(vm.method) }}
        </div>
      </div>
      <span v-if="vm.lastUpdate" class="text-caption text-medium-emphasis">{{
        formatRelative(vm.lastUpdate)
      }}</span>
    </div>

    <!-- body -->
    <div class="px-3 flex-grow-1">
      <div class="mono text-caption text-medium-emphasis text-truncate mb-2">
        {{ vm.connTarget }}
      </div>

      <template v-if="vm.error">
        <div class="text-error text-caption text-truncate">
          <v-icon icon="mdi-alert-circle" size="14" /> {{ vm.error }}
        </div>
      </template>
      <template v-else-if="vm.summary">
        <div class="d-flex rounded overflow-hidden mb-2 seg-bar" style="height: 6px; gap: 2px">
          <div
            v-for="seg in vm.segments"
            :key="seg.key"
            class="seg"
            :style="{
              width: `${(seg.value / vm.summary.total) * 100}%`,
              background: `rgb(var(--v-theme-${seg.color}))`
            }"
          />
          <div
            v-if="!vm.segments.length"
            class="w-100"
            :style="{ background: 'rgba(var(--v-theme-on-surface), 0.08)' }"
          />
        </div>
        <div class="d-flex align-center ga-3 text-caption">
          <span
            ><b class="text-success">{{ vm.summary.running }}</b> {{ t('dashboard.running') }}</span
          >
          <span
            ><b>{{ vm.summary.total }}</b> {{ t('dashboard.total') }}</span
          >
          <span v-if="vm.summary.fatal"
            ><b class="text-error">{{ vm.summary.fatal }}</b> {{ t('dashboard.fatal') }}</span
          >
        </div>
        <template v-if="vm.host">
          <v-divider class="border-dashed mt-2" />
          <div class="d-flex align-center ga-3 text-caption text-medium-emphasis pt-1">
            <span v-if="vm.host.load != null" :title="t('dashboard.load')"
              ><v-icon icon="mdi-speedometer" size="13" /> {{ vm.host.load }}</span
            >
            <span v-if="vm.host.memPct != null"
              ><v-icon icon="mdi-memory" size="13" /> %{{ vm.host.memPct }}</span
            >
            <span
              v-if="vm.host.diskPct != null"
              :class="vm.host.diskPct >= 85 ? 'text-warning' : ''"
              ><v-icon icon="mdi-harddisk" size="13" /> %{{ vm.host.diskPct }}</span
            >
          </div>
        </template>
      </template>
      <template v-else>
        <div class="text-medium-emphasis text-caption">
          <v-progress-circular indeterminate size="13" width="2" class="me-1" />
          {{ t('dashboard.connecting') }}
        </div>
      </template>
    </div>

    <!-- actions -->
    <v-divider class="mt-3" />
    <v-card-actions class="px-2">
      <v-btn size="small" variant="text" prepend-icon="mdi-view-list" :to="`/servers/${vm.id}`">{{
        t('servers.processes')
      }}</v-btn>
      <v-spacer />
      <v-tooltip :text="t('servers.diagnose')" location="top">
        <template #activator="{ props: tip }"
          ><v-btn
            v-bind="tip"
            size="small"
            icon="mdi-medical-bag"
            variant="text"
            @click="emit('diagnose')"
        /></template>
      </v-tooltip>
      <v-tooltip :text="t('common.test')" location="top">
        <template #activator="{ props: tip }"
          ><v-btn
            v-bind="tip"
            size="small"
            icon="mdi-connection"
            variant="text"
            :loading="testing"
            @click="emit('test')"
        /></template>
      </v-tooltip>
      <v-tooltip :text="t('common.edit')" location="top">
        <template #activator="{ props: tip }"
          ><v-btn v-bind="tip" size="small" icon="mdi-pencil" variant="text" @click="emit('edit')"
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
            @click="emit('remove')"
        /></template>
      </v-tooltip>
    </v-card-actions>
  </v-card>
</template>

<style scoped>
/* on-surface anchor that turns primary on hover (no Vuetify utility) */
.srv-name {
  color: rgb(var(--v-theme-on-surface));
  text-decoration: none;
}
.srv-name:hover {
  color: rgb(var(--v-theme-primary));
}
/* monospace run + animated health-bar segments + flex truncation guard */
.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
}
.seg-bar {
  background: rgba(var(--v-theme-on-surface), 0.06);
}
.seg {
  transition: width 0.4s ease;
}
.min-w-0 {
  min-width: 0;
}
</style>
