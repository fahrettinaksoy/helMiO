<script setup>
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import SidePanel from '@/components/SidePanel.vue';
import { serversApi } from '@/api/client';
import { useRealtimeStore } from '@/stores/realtime';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  serverId: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue', 'action']);
const { t } = useI18n();
const realtime = useRealtimeStore();

const loading = ref(false);
const busy = ref(false);
const data = ref(null); // { status, plan }
const showToken = ref(false);
const copied = ref('');

const status = computed(() => data.value?.status);
const plan = computed(() => data.value?.plan);
const liveEvents = computed(() => realtime.events[props.serverId] || []);

const stateChip = computed(() => {
  const s = status.value;
  if (!s) return null;
  if (s.running) return { color: 'success', icon: 'mdi-check-circle', text: t('events.running') };
  if (s.installed) return { color: 'warning', icon: 'mdi-alert-circle', text: t('events.installedNotRunning') };
  return { color: 'grey', icon: 'mdi-circle-outline', text: t('events.notInstalled') };
});

async function load() {
  loading.value = true;
  try {
    data.value = await serversApi.eventListener(props.serverId);
  } catch (e) {
    emit('action', { ok: false, message: e.response?.data?.error || e.message });
  } finally {
    loading.value = false;
  }
}

watch(() => props.modelValue, (open) => { if (open) load(); });

async function install() {
  busy.value = true;
  try {
    await serversApi.eventListenerInstall(props.serverId);
    emit('action', { ok: true, message: t('events.installed') });
    await load();
  } catch (e) {
    emit('action', { ok: false, message: e.response?.data?.error || e.message });
  } finally {
    busy.value = false;
  }
}

async function uninstall() {
  busy.value = true;
  try {
    await serversApi.eventListenerUninstall(props.serverId);
    emit('action', { ok: true, message: t('events.uninstalled') });
    await load();
  } catch (e) {
    emit('action', { ok: false, message: e.response?.data?.error || e.message });
  } finally {
    busy.value = false;
  }
}

async function rotate() {
  busy.value = true;
  try {
    await serversApi.eventListenerRotateToken(props.serverId);
    emit('action', { ok: true, message: t('events.tokenRotated') });
    await load();
  } catch (e) {
    emit('action', { ok: false, message: e.response?.data?.error || e.message });
  } finally {
    busy.value = false;
  }
}

async function copy(text, which) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = which;
    setTimeout(() => { if (copied.value === which) copied.value = ''; }, 1500);
  } catch { /* clipboard unavailable */ }
}

const EVENT_COLOR = {
  RUNNING: 'success', FATAL: 'error', BACKOFF: 'warning', STARTING: 'info',
  STOPPING: 'warning', STOPPED: 'grey', EXITED: 'warning', UNKNOWN: 'grey',
};
const evColor = (e) => EVENT_COLOR[e.state] || (e.eventname?.startsWith('TICK') ? 'grey' : 'info');
const evTime = (ms) => new Date(ms).toLocaleTimeString();
</script>

<template>
  <SidePanel
    :model-value="modelValue"
    :title="t('events.title')"
    icon="mdi-lightning-bolt"
    :width="600"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="pa-4">
      <div v-if="loading" class="py-10 text-center">
        <v-progress-circular indeterminate color="primary" />
      </div>

      <template v-else-if="data">
        <!-- Status -->
        <div class="d-flex align-center mb-4">
          <v-chip v-if="stateChip" :color="stateChip.color" variant="tonal" label>
            <v-icon :icon="stateChip.icon" start /> {{ stateChip.text }}
          </v-chip>
          <v-spacer />
          <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="loading" @click="load">{{ t('events.refresh') }}</v-btn>
        </div>

        <p class="text-body-2 text-medium-emphasis mb-4">{{ t('events.intro') }}</p>

        <!-- Install actions -->
        <div class="mb-4 d-flex ga-2 flex-wrap">
          <template v-if="status?.canAutoInstall">
            <v-btn v-if="!status.installed" color="primary" :loading="busy" prepend-icon="mdi-download" @click="install">
              {{ t('events.install') }}
            </v-btn>
            <template v-else>
              <v-btn variant="tonal" :loading="busy" prepend-icon="mdi-reload" @click="install">{{ t('events.reinstall') }}</v-btn>
              <v-btn color="error" variant="tonal" :loading="busy" prepend-icon="mdi-delete" @click="uninstall">{{ t('events.uninstall') }}</v-btn>
            </template>
          </template>
          <v-alert v-else type="info" variant="tonal" density="compact" class="flex-grow-1" :text="t('events.manualOnly')" />
        </div>

        <!-- Manual config snippet -->
        <v-expansion-panels variant="accordion" class="mb-4">
          <v-expansion-panel :title="t('events.manualTitle')">
            <template #text>
              <p class="text-caption text-medium-emphasis mb-2">{{ t('events.manualHint', { confPath: plan?.confPath }) }}</p>
              <v-sheet rounded class="snippet pa-3 mb-2">
                <pre>{{ plan?.configBlock }}</pre>
              </v-sheet>
              <v-btn size="small" variant="tonal" :prepend-icon="copied === 'config' ? 'mdi-check' : 'mdi-content-copy'" @click="copy(plan?.configBlock, 'config')">
                {{ copied === 'config' ? t('events.copied') : t('events.copyConfig') }}
              </v-btn>

              <div class="text-caption text-medium-emphasis mt-4 mb-1">{{ t('events.ingestUrl') }}</div>
              <code class="mono d-block mb-3">{{ plan?.ingestUrl }}/{{ serverId }}/events</code>

              <div class="text-caption text-medium-emphasis mb-1">{{ t('events.token') }}</div>
              <div class="d-flex align-center ga-2">
                <code class="mono token-box flex-grow-1">{{ showToken ? plan?.token : '••••••••••••••••••••' }}</code>
                <v-btn size="x-small" icon variant="text" :icon="showToken ? 'mdi-eye-off' : 'mdi-eye'" @click="showToken = !showToken" />
                <v-btn size="x-small" icon variant="text" :icon="copied === 'token' ? 'mdi-check' : 'mdi-content-copy'" @click="copy(plan?.token, 'token')" />
              </div>
              <v-btn size="small" variant="text" color="warning" class="mt-2" prepend-icon="mdi-key-change" :loading="busy" @click="rotate">
                {{ t('events.rotateToken') }}
              </v-btn>
            </template>
          </v-expansion-panel>
        </v-expansion-panels>

        <!-- Live feed -->
        <div class="d-flex align-center mb-2">
          <span class="text-subtitle-2 font-weight-medium">{{ t('events.liveFeed') }}</span>
          <v-chip size="x-small" variant="tonal" class="ms-2">{{ liveEvents.length }}</v-chip>
          <v-spacer />
          <span class="status-dot" :class="realtime.connected ? 'on' : 'off'" />
        </div>
        <v-sheet rounded class="feed">
          <div v-if="!liveEvents.length" class="py-8 text-center text-medium-emphasis text-caption">
            {{ t('events.waiting') }}
          </div>
          <div v-for="e in liveEvents" :key="e.id" class="feed-row">
            <span class="feed-time">{{ evTime(e.at) }}</span>
            <v-chip :color="evColor(e)" size="x-small" variant="flat" label class="feed-ev">{{ e.eventname }}</v-chip>
            <span class="feed-proc text-truncate">
              <template v-if="e.processname">{{ e.groupname && e.groupname !== e.processname ? `${e.groupname}:${e.processname}` : e.processname }}</template>
              <template v-else>—</template>
            </span>
            <span v-if="e.fromState" class="feed-from text-medium-emphasis">{{ e.fromState }} →</span>
          </div>
        </v-sheet>
      </template>
    </div>
  </SidePanel>
</template>

<style scoped>
.snippet {
  background: rgba(var(--v-theme-on-surface), 0.05);
  overflow-x: auto;
}
.snippet pre {
  margin: 0;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.78rem;
  white-space: pre;
}
.mono {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.78rem;
}
.token-box {
  background: rgba(var(--v-theme-on-surface), 0.05);
  padding: 4px 8px;
  border-radius: 6px;
  overflow-x: auto;
  white-space: nowrap;
}
.feed {
  background: rgba(var(--v-theme-on-surface), 0.04);
  max-height: 320px;
  overflow-y: auto;
}
.feed-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.06);
  font-size: 0.8rem;
}
.feed-time {
  font-family: ui-monospace, monospace;
  font-size: 0.72rem;
  color: rgb(var(--v-theme-primary));
  flex: 0 0 auto;
}
.feed-ev { flex: 0 0 auto; }
.feed-proc { flex: 1 1 auto; min-width: 0; }
.feed-from { flex: 0 0 auto; font-size: 0.72rem; }
.status-dot {
  width: 8px; height: 8px; border-radius: 50%;
}
.status-dot.on { background: rgb(var(--v-theme-success)); }
.status-dot.off { background: rgb(var(--v-theme-error)); }
</style>
