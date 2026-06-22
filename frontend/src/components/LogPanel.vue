<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import SidePanel from '@/components/SidePanel.vue';
import socket from '@/api/socket';
import { processesApi, serversApi } from '@/api/client';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  serverId: { type: String, default: '' },
  process: { type: Object, default: null }, // { fullName, name } — process mode
  daemon: { type: Boolean, default: false }, // daemon (main supervisord log) mode
});
const emit = defineEmits(['update:modelValue', 'action']);
const { t } = useI18n();

const channel = ref('stdout');
const content = ref('');
const follow = ref(true);
const errorMsg = ref(null);
const box = ref(null);

// Scroll-back history state
const WINDOW = 32768;
const oldestOffset = ref(null); // byte offset of the earliest displayed content
const canScrollBack = ref(false);
const loadingOlder = ref(false);

function scrollToEnd() {
  nextTick(() => {
    if (follow.value && box.value) box.value.scrollTop = box.value.scrollHeight;
  });
}

function onChunk({ data, append, startOffset }) {
  if (append) {
    content.value += data;
  } else {
    content.value = data || '';
    // First chunk of an incremental stream carries the byte anchor for paging back.
    if (typeof startOffset === 'number') {
      oldestOffset.value = startOffset;
      canScrollBack.value = startOffset > 0;
    } else {
      oldestOffset.value = null;
      canScrollBack.value = false; // e.g. docker (snapshot tail, no offsets)
    }
  }
  scrollToEnd();
}

async function loadOlder() {
  if (!canScrollBack.value || oldestOffset.value == null || props.daemon || !props.process) return;
  loadingOlder.value = true;
  const start = Math.max(0, oldestOffset.value - WINDOW);
  const length = oldestOffset.value - start;
  try {
    const res = await processesApi.readLog(props.serverId, props.process.fullName, { channel: channel.value, offset: start, length });
    const before = box.value ? box.value.scrollHeight : 0;
    content.value = (res.data || '') + content.value;
    oldestOffset.value = start;
    canScrollBack.value = start > 0;
    // Keep the viewport anchored on the same line after prepending.
    nextTick(() => {
      if (box.value) box.value.scrollTop += box.value.scrollHeight - before;
    });
  } catch (e) {
    errorMsg.value = e.response?.data?.error || e.message;
  } finally {
    loadingOlder.value = false;
  }
}
function onErr({ error }) {
  errorMsg.value = error;
}

function start() {
  if (!props.serverId) return;
  if (!props.daemon && !props.process) return;
  content.value = '';
  errorMsg.value = null;
  oldestOffset.value = null;
  canScrollBack.value = false;
  if (props.daemon) {
    socket.emit('log:start', { serverId: props.serverId, daemon: true });
  } else {
    socket.emit('log:start', { serverId: props.serverId, fullName: props.process.fullName, channel: channel.value });
  }
}
function stop() {
  socket.emit('log:stop');
}

watch(() => props.modelValue, (open) => (open ? start() : stop()));
watch(channel, () => { if (props.modelValue) { stop(); start(); } });
watch(() => props.process?.fullName, () => { if (props.modelValue) { stop(); start(); } });

onMounted(() => {
  socket.on('log:chunk', onChunk);
  socket.on('log:error', onErr);
});
onBeforeUnmount(() => {
  socket.off('log:chunk', onChunk);
  socket.off('log:error', onErr);
  stop();
});

async function clear() {
  try {
    if (props.daemon) await serversApi.daemonClearLog(props.serverId);
    else await processesApi.clearLog(props.serverId, props.process.fullName);
    content.value = '';
    emit('action', { ok: true, message: t('log.cleared') });
    stop();
    start();
  } catch (e) {
    emit('action', { ok: false, message: e.response?.data?.error || e.message });
  }
}

function close() {
  emit('update:modelValue', false);
}

// In-view search/filter: show only lines containing the term (case-insensitive).
const search = ref('');
const displayContent = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return content.value;
  return content.value
    .split('\n')
    .filter((line) => line.toLowerCase().includes(q))
    .join('\n');
});
const matchCount = computed(() => {
  if (!search.value.trim()) return 0;
  return displayContent.value ? displayContent.value.split('\n').filter(Boolean).length : 0;
});

const downloading = ref(false);

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Download the FULL log: process mode pulls the whole file server-side; daemon
// mode (no per-process endpoint) saves the currently loaded buffer.
async function download() {
  if (props.daemon || !props.process) {
    saveBlob(new Blob([content.value || ''], { type: 'text/plain' }), 'supervisord.log');
    return;
  }
  downloading.value = true;
  try {
    const blob = await processesApi.downloadLog(props.serverId, props.process.fullName, channel.value);
    const name = props.process.fullName.replace(/[^A-Za-z0-9_.-]/g, '_');
    saveBlob(blob, `${name}.${channel.value}.log`);
  } catch (e) {
    errorMsg.value = e.response?.data?.error || e.message;
  } finally {
    downloading.value = false;
  }
}
</script>

<template>
  <SidePanel
    :model-value="modelValue"
    :title="daemon ? t('log.daemonTitle') : t('log.title', { name: process?.name || '' })"
    icon="mdi-text-box-outline"
    :width="760"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="pa-4">
      <div class="d-flex align-center ga-3 mb-3 flex-wrap">
        <v-btn-toggle v-if="!daemon" v-model="channel" mandatory variant="outlined" density="comfortable">
          <v-btn value="stdout" size="small">stdout</v-btn>
          <v-btn value="stderr" size="small">stderr</v-btn>
        </v-btn-toggle>
        <v-switch v-model="follow" :label="t('log.follow')" color="primary" density="compact" hide-details inset />
        <v-spacer />
        <v-btn size="small" variant="text" prepend-icon="mdi-download" :loading="downloading" @click="download">{{ t('log.download') }}</v-btn>
        <v-btn size="small" variant="tonal" color="error" prepend-icon="mdi-broom" @click="clear">{{ t('log.clear') }}</v-btn>
      </div>

      <v-text-field
        v-model="search"
        :placeholder="t('log.search')"
        prepend-inner-icon="mdi-magnify"
        variant="solo-filled"
        density="compact"
        flat
        hide-details
        clearable
        rounded="lg"
        class="mb-3"
      >
        <template v-if="search.trim()" #append-inner>
          <span class="text-caption text-medium-emphasis">{{ t('log.matches', { n: matchCount }) }}</span>
        </template>
      </v-text-field>

      <v-alert v-if="errorMsg" type="error" variant="tonal" density="compact" class="mb-3" :text="errorMsg" />

      <div v-if="!daemon && canScrollBack" class="text-center mb-2">
        <v-btn size="small" variant="tonal" :loading="loadingOlder" prepend-icon="mdi-arrow-up" @click="loadOlder">
          {{ t('log.loadOlder') }}
        </v-btn>
      </div>

      <v-theme-provider theme="dark">
        <pre ref="box" class="log-console">{{ displayContent || t('log.empty') }}</pre>
      </v-theme-provider>
    </div>

    <template #footer>
      <v-spacer />
      <v-btn variant="text" @click="close">{{ t('common.close') }}</v-btn>
    </template>
  </SidePanel>
</template>

<style scoped>
.log-console {
  background: rgb(var(--v-theme-background));
  color: rgb(var(--v-theme-on-background));
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 12px 14px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.8rem;
  line-height: 1.55;
  height: calc(100vh - 230px);
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}
</style>
