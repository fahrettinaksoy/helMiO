<script setup>
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import SidePanel from '@/components/SidePanel.vue';
import StatusChip from './StatusChip.vue';
import { formatUptime } from '@/utils/format';
import { processesApi } from '@/api/client';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  serverId: { type: String, default: '' },
  process: { type: Object, default: null },
});
const emit = defineEmits(['update:modelValue', 'action']);
const { t, locale } = useI18n();

const SIGNALS = ['HUP', 'INT', 'QUIT', 'USR1', 'USR2', 'TERM', 'KILL'];
const signal = ref('HUP');
const sending = ref(false);
const stdin = ref('');
const sendingStdin = ref(false);

function fmtTime(sec) {
  if (!sec) return '—';
  return new Date(sec * 1000).toLocaleString(locale.value === 'tr' ? 'tr-TR' : 'en-US');
}

const rows = computed(() => {
  const p = props.process;
  if (!p) return [];
  return [
    { label: t('detail.group'), value: p.group },
    { label: t('detail.pid'), value: p.pid || '—' },
    { label: t('detail.uptime'), value: formatUptime(p.uptime) },
    { label: t('detail.started'), value: fmtTime(p.start) },
    { label: t('detail.stopped'), value: fmtTime(p.stop) },
    { label: t('detail.exitStatus'), value: p.exitstatus ?? '—' },
    { label: t('detail.spawnError'), value: p.spawnerr || '—' },
    { label: t('detail.stdoutLog'), value: p.stdout_logfile || '—', mono: true },
    { label: t('detail.stderrLog'), value: p.stderr_logfile || '—', mono: true },
  ];
});

async function send() {
  sending.value = true;
  try {
    await processesApi.signal(props.serverId, props.process.fullName, signal.value);
    emit('action', { ok: true, message: t('detail.signalSent', { sig: signal.value, name: props.process.fullName }) });
  } catch (e) {
    emit('action', { ok: false, message: e.response?.data?.error || e.message });
  } finally {
    sending.value = false;
  }
}

async function sendStdin() {
  sendingStdin.value = true;
  try {
    await processesApi.sendStdin(props.serverId, props.process.fullName, stdin.value + '\n');
    emit('action', { ok: true, message: t('detail.stdinSent', { name: props.process.fullName }) });
    stdin.value = '';
  } catch (e) {
    emit('action', { ok: false, message: e.response?.data?.error || e.message });
  } finally {
    sendingStdin.value = false;
  }
}

function close() {
  emit('update:modelValue', false);
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

      <table class="detail-table">
        <tbody>
          <tr v-for="r in rows" :key="r.label">
            <td class="label">{{ r.label }}</td>
            <td :class="{ mono: r.mono }">{{ r.value }}</td>
          </tr>
        </tbody>
      </table>

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
        <v-btn color="primary" variant="flat" :loading="sending" prepend-icon="mdi-flash" @click="send">
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
        <v-btn color="primary" variant="tonal" :loading="sendingStdin" :disabled="!stdin" prepend-icon="mdi-keyboard-outline" @click="sendStdin">
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
.detail-table {
  width: 100%;
  border-collapse: collapse;
}
.detail-table td {
  padding: 8px 4px;
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.06);
  font-size: 0.85rem;
  vertical-align: top;
}
.detail-table .label {
  color: rgba(var(--v-theme-on-surface), 0.6);
  width: 38%;
  white-space: nowrap;
}
.detail-table .mono {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.78rem;
  word-break: break-all;
}
</style>
