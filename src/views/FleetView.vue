<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { fleetApi } from '@/api/client'
import socket from '@/api/socket'
import PageShell from '@/components/PageShell.vue'
import { useServersStore } from '@/stores/servers'
import { methodLabel } from '@/utils/format'

const { t } = useI18n()
const serversStore = useServersStore()

const selected = ref([])
const action = ref('restartAll')
const group = ref('')
const strategy = ref('parallel')
const delaySec = ref(5)
const running = ref(false)
const results = ref([])
const error = ref('')

const ACTIONS = [
  { value: 'startAll', icon: 'mdi-play', group: false },
  { value: 'stopAll', icon: 'mdi-stop', group: false },
  { value: 'restartAll', icon: 'mdi-restart', group: false },
  { value: 'startGroup', icon: 'mdi-play-box', group: true },
  { value: 'stopGroup', icon: 'mdi-stop', group: true },
  { value: 'restartGroup', icon: 'mdi-restart', group: true }
]
const needsGroup = computed(() => ACTIONS.find((a) => a.value === action.value)?.group)
const canRun = computed(
  () => selected.value.length > 0 && (!needsGroup.value || group.value.trim()) && !running.value
)

const serverItems = computed(() =>
  serversStore.servers.map((s) => ({ value: s.id, title: s.name, method: s.method }))
)

// Live progress: backend pushes a 'fleet' event per server as it completes.
let currentRunId = null
function onFleet(payload) {
  if (!currentRunId || payload.runId !== currentRunId) return
  if (payload.event === 'progress') {
    const i = results.value.findIndex((r) => r.serverId === payload.result.serverId)
    if (i === -1) results.value.push(payload.result)
    else results.value[i] = payload.result
  }
}
onMounted(() => {
  if (!serversStore.servers.length) serversStore.fetchAll()
  socket.on('fleet', onFleet)
})
onBeforeUnmount(() => socket.off('fleet', onFleet))

function toggleAll() {
  selected.value =
    selected.value.length === serverItems.value.length ? [] : serverItems.value.map((s) => s.value)
}

async function run() {
  running.value = true
  error.value = ''
  results.value = []
  currentRunId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now())
  try {
    const res = await fleetApi.run({
      action: action.value,
      serverIds: selected.value,
      group: needsGroup.value ? group.value.trim() : undefined,
      strategy: strategy.value,
      delayMs:
        strategy.value === 'sequential' ? Math.max(0, Number(delaySec.value) || 0) * 1000 : 0,
      runId: currentRunId
    })
    results.value = res.results // final authoritative aggregate
  } catch (e) {
    error.value = e.response?.data?.error || e.message
  } finally {
    running.value = false
    currentRunId = null
  }
}

const okCount = computed(() => results.value.filter((r) => r.ok).length)
</script>

<template>
  <PageShell :title="t('fleet.title')" icon="mdi-server-network" fill>
    <template #hero-subtitle>{{ t('fleet.subtitle') }}</template>
    <div class="fleet-wrap">
      <v-row class="h-100">
        <!-- Config -->
        <v-col cols="12" md="5" class="fleet-col">
          <v-card rounded="lg" class="fleet-card d-flex flex-column">
            <div class="fleet-card-body pa-4">
              <div class="text-overline text-medium-emphasis mb-1">{{ t('fleet.servers') }}</div>
              <div class="d-flex align-center mb-2">
                <v-btn size="small" variant="text" @click="toggleAll">
                  {{
                    selected.length === serverItems.length
                      ? t('fleet.clearAll')
                      : t('fleet.selectAll')
                  }}
                </v-btn>
                <v-spacer />
                <span class="text-caption text-medium-emphasis">{{
                  t('fleet.nSelected', { n: selected.length })
                }}</span>
              </div>
              <v-sheet
                rounded
                class="server-pick mb-4 overflow-y-auto px-3 py-2"
                style="max-height: 280px"
              >
                <v-checkbox
                  v-for="s in serverItems"
                  :key="s.value"
                  v-model="selected"
                  :value="s.value"
                  density="compact"
                  hide-details
                  color="primary"
                >
                  <template #label>
                    <span class="font-weight-medium">{{ s.title }}</span>
                    <v-chip size="x-small" variant="tonal" label class="ms-2">{{
                      methodLabel(s.method)
                    }}</v-chip>
                  </template>
                </v-checkbox>
                <div v-if="!serverItems.length" class="pa-3 text-caption text-medium-emphasis">
                  {{ t('fleet.noServers') }}
                </div>
              </v-sheet>

              <div class="text-overline text-medium-emphasis mb-1">{{ t('fleet.action') }}</div>
              <v-select
                v-model="action"
                :items="ACTIONS"
                density="comfortable"
                variant="outlined"
                class="mb-2"
              >
                <template #selection="{ item }"
                  ><v-icon :icon="item.raw.icon" size="18" class="me-2" />{{
                    t(`fleet.act_${item.value}`)
                  }}</template
                >
                <template #item="{ item, props: p }"
                  ><v-list-item
                    v-bind="p"
                    :prepend-icon="item.raw.icon"
                    :title="t(`fleet.act_${item.value}`)"
                /></template>
              </v-select>
              <v-text-field
                v-if="needsGroup"
                v-model="group"
                :label="t('fleet.groupName')"
                density="comfortable"
                variant="outlined"
                class="mb-2"
                autocomplete="off"
              />

              <div class="text-overline text-medium-emphasis mb-1">{{ t('fleet.strategy') }}</div>
              <v-btn-toggle
                v-model="strategy"
                mandatory
                density="comfortable"
                variant="outlined"
                divided
                class="mb-2"
              >
                <v-btn value="parallel" size="small" prepend-icon="mdi-lightning-bolt">{{
                  t('fleet.parallel')
                }}</v-btn>
                <v-btn value="sequential" size="small" prepend-icon="mdi-format-list-numbered">{{
                  t('fleet.sequential')
                }}</v-btn>
              </v-btn-toggle>
              <v-text-field
                v-if="strategy === 'sequential'"
                v-model.number="delaySec"
                :label="t('fleet.delay')"
                type="number"
                min="0"
                suffix="s"
                density="comfortable"
                variant="outlined"
                :hint="t('fleet.delayHint')"
                persistent-hint
                class="mb-2"
              />
            </div>

            <v-spacer />
            <v-divider />
            <div class="fleet-card-footer pa-4">
              <v-btn
                color="primary"
                size="large"
                block
                :loading="running"
                :disabled="!canRun"
                prepend-icon="mdi-rocket-launch"
                @click="run"
              >
                {{ t('fleet.run') }}
              </v-btn>
            </div>
          </v-card>
        </v-col>

        <!-- Results -->
        <v-col cols="12" md="7" class="fleet-col">
          <v-card rounded="lg" class="pa-4 fleet-card">
            <div class="d-flex align-center mb-3">
              <span class="text-overline text-medium-emphasis">{{ t('fleet.results') }}</span>
              <v-spacer />
              <v-chip
                v-if="results.length"
                :color="okCount === results.length ? 'success' : 'warning'"
                size="small"
                variant="tonal"
                label
              >
                {{ okCount }}/{{ results.length }}
              </v-chip>
            </div>

            <v-alert
              v-if="error"
              type="error"
              variant="tonal"
              density="compact"
              class="mb-3"
              :text="error"
            />

            <div v-if="running && !results.length" class="py-10 text-center">
              <v-progress-circular indeterminate color="primary" />
              <div class="text-caption text-medium-emphasis mt-2">{{ t('fleet.running') }}</div>
            </div>
            <div
              v-else-if="!results.length"
              class="py-10 text-center text-medium-emphasis text-caption"
            >
              {{ t('fleet.idle') }}
            </div>

            <v-list v-else density="compact" class="bg-transparent">
              <v-list-item v-for="r in results" :key="r.serverId" class="px-2">
                <template #prepend>
                  <v-icon
                    :icon="r.ok ? 'mdi-check-circle' : 'mdi-alert-circle'"
                    :color="r.ok ? 'success' : 'error'"
                  />
                </template>
                <v-list-item-title class="font-weight-medium">{{ r.name }}</v-list-item-title>
                <v-list-item-subtitle v-if="r.error" class="text-error">{{
                  r.error
                }}</v-list-item-subtitle>
                <template #append>
                  <span class="text-caption text-medium-emphasis">{{ r.durationMs }}ms</span>
                </template>
              </v-list-item>
            </v-list>
          </v-card>
        </v-col>
      </v-row>
    </div>
  </PageShell>
</template>

<style scoped>
.server-pick {
  background: rgba(var(--v-theme-on-surface), 0.04);
} /* subtle inset fill, no utility match */
/* Fill the shell (PageShell `fill`): both columns stretch to the viewport and
   each card scrolls internally. */
.fleet-wrap {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
.fleet-col {
  height: 100%;
}
.fleet-card {
  height: 100%;
  overflow-y: auto;
}
/* Config card: body scrolls, footer (Run button) stays pinned at the bottom. */
.fleet-card.d-flex {
  overflow: hidden;
}
.fleet-card-body {
  flex: 1 1 auto;
  overflow-y: auto;
  min-height: 0;
}
.fleet-card-footer {
  flex: 0 0 auto;
}
@media (max-width: 959px) {
  /* On mobile the columns stack, so let the wrapper scroll instead. */
  .fleet-wrap {
    overflow: visible;
  }
  .fleet-col {
    height: auto;
  }
  .fleet-card {
    height: auto;
    min-height: 320px;
  }
  .fleet-card.d-flex {
    overflow: visible;
  }
  .fleet-card-body {
    overflow-y: visible;
  }
}
</style>
