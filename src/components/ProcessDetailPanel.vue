<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { processesApi } from '@/api/client'
import SidePanel from '@/components/SidePanel.vue'
import { formatUptime } from '@/utils/format'
import StatusChip from './StatusChip.vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  serverId: { type: String, default: '' },
  process: { type: Object, default: null }
})
const emit = defineEmits(['update:modelValue', 'action'])
const { t, locale } = useI18n()

const SIGNALS = ['HUP', 'INT', 'QUIT', 'USR1', 'USR2', 'TERM', 'KILL']
const signal = ref('HUP')
const sending = ref(false)
const stdin = ref('')
const sendingStdin = ref(false)

function fmtTime(sec) {
  if (!sec) return '—'
  return new Date(sec * 1000).toLocaleString(locale.value === 'tr' ? 'tr-TR' : 'en-US')
}

const rows = computed(() => {
  const p = props.process
  if (!p) return []
  return [
    { label: t('detail.group'), value: p.group },
    { label: t('detail.pid'), value: p.pid || '—' },
    { label: t('detail.uptime'), value: formatUptime(p.uptime) },
    { label: t('detail.started'), value: fmtTime(p.start) },
    { label: t('detail.stopped'), value: fmtTime(p.stop) },
    { label: t('detail.exitStatus'), value: p.exitstatus ?? '—' },
    { label: t('detail.spawnError'), value: p.spawnerr || '—' },
    { label: t('detail.stdoutLog'), value: p.stdout_logfile || '—', mono: true },
    { label: t('detail.stderrLog'), value: p.stderr_logfile || '—', mono: true }
  ]
})

async function send() {
  sending.value = true
  try {
    await processesApi.signal(props.serverId, props.process.fullName, signal.value)
    emit('action', {
      ok: true,
      message: t('detail.signalSent', { sig: signal.value, name: props.process.fullName })
    })
  } catch (e) {
    emit('action', { ok: false, message: e.response?.data?.error || e.message })
  } finally {
    sending.value = false
  }
}

async function sendStdin() {
  sendingStdin.value = true
  try {
    await processesApi.sendStdin(props.serverId, props.process.fullName, `${stdin.value}\n`)
    emit('action', { ok: true, message: t('detail.stdinSent', { name: props.process.fullName }) })
    stdin.value = ''
  } catch (e) {
    emit('action', { ok: false, message: e.response?.data?.error || e.message })
  } finally {
    sendingStdin.value = false
  }
}

function close() {
  emit('update:modelValue', false)
}
</script>

<template>
  <SidePanel
    :model-value="modelValue"
    :title="t('detail.title', { name: process?.name || '' })"
    icon="mdi-information-outline"
    :width="560"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="process" class="pa-4">
      <div class="mb-4"><StatusChip :statename="process.statename" /></div>

      <v-list density="compact" class="bg-transparent pa-0">
        <v-list-item v-for="r in rows" :key="r.label" class="px-0">
          <v-row no-gutters>
            <v-col cols="5" class="text-body-2 text-medium-emphasis">{{ r.label }}</v-col>
            <v-col class="text-body-2" :class="{ mono: r.mono }" style="word-break: break-all">{{
              r.value
            }}</v-col>
          </v-row>
        </v-list-item>
      </v-list>

      <v-divider class="my-5" />

      <div class="text-subtitle-2 font-weight-bold mb-2">{{ t('detail.sendSignal') }}</div>
      <div class="d-flex ga-2 align-center">
        <v-select
          v-model="signal"
          :items="SIGNALS"
          density="comfortable"
          variant="outlined"
          hide-details
          style="max-width: 200px"
        />
        <v-btn
          color="primary"
          variant="flat"
          :loading="sending"
          prepend-icon="mdi-flash"
          @click="send"
        >
          {{ t('detail.send') }}
        </v-btn>
      </div>

      <div class="text-subtitle-2 font-weight-bold mt-5 mb-2">{{ t('detail.stdin') }}</div>
      <div class="d-flex ga-2 align-center">
        <v-text-field
          v-model="stdin"
          :placeholder="t('detail.stdinPlaceholder')"
          density="comfortable"
          variant="outlined"
          hide-details
          autocomplete="off"
          class="flex-grow-1"
          @keyup.enter="sendStdin"
        />
        <v-btn
          color="primary"
          variant="tonal"
          :loading="sendingStdin"
          :disabled="!stdin"
          prepend-icon="mdi-keyboard-outline"
          @click="sendStdin"
        >
          {{ t('detail.send') }}
        </v-btn>
      </div>
    </div>

    <template #footer>
      <v-spacer />
      <v-btn variant="text" @click="close">{{ t('common.close') }}</v-btn>
    </template>
  </SidePanel>
</template>

<style scoped>
/* Monospace run for log paths — Vuetify has no monospace utility. */
.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.78rem;
}
</style>
