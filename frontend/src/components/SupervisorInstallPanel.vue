<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import SidePanel from '@/components/SidePanel.vue';
import { serversApi } from '@/api/client';
import socket from '@/api/socket';

const { t } = useI18n();

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  server: { type: Object, default: null },
});
const emit = defineEmits(['update:modelValue', 'changed']);

const loading = ref(false);
const diag = ref(null);
const error = ref(null);

const sudoPassword = ref('');
const configureHttp = ref(true);
const installing = ref(false);
const logs = ref('');
const result = ref(null);
const logBox = ref(null);

const serverId = computed(() => props.server?.id);
const isDocker = computed(() => props.server?.method === 'docker');

async function diagnose() {
  if (!serverId.value) return;
  loading.value = true;
  error.value = null;
  result.value = null;
  try {
    diag.value = await serversApi.diagnose(serverId.value);
  } catch (e) {
    error.value = e.response?.data?.error || e.message;
    diag.value = null;
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      logs.value = '';
      sudoPassword.value = '';
      diagnose();
    }
  }
);

// derived UI state
const status = computed(() => {
  const d = diag.value;
  if (!d) return null;
  if (d.reachable && d.running) return 'ready';
  if (!d.shell) return 'no-shell';
  if (d.installed && !d.reachable) return 'configure';
  if (!d.installed && d.canInstall) return 'install';
  if (!d.installed && !d.canInstall) return 'no-pm';
  return 'unknown';
});

function appendLog(line) {
  logs.value += (logs.value ? '\n' : '') + line;
  nextTick(() => {
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
  });
}

function onInstallLog({ serverId: sid, line }) {
  if (sid === serverId.value) appendLog(line);
}
function onInstallResult(payload) {
  if (payload.serverId && payload.serverId !== serverId.value) return;
  installing.value = false;
  result.value = payload;
  if (payload.ok) {
    appendLog('');
    emit('changed');
    setTimeout(diagnose, 1200); // refresh status after install
  }
}

onMounted(() => {
  socket.on('install:log', onInstallLog);
  socket.on('install:result', onInstallResult);
});
onBeforeUnmount(() => {
  socket.off('install:log', onInstallLog);
  socket.off('install:result', onInstallResult);
});

function startInstall() {
  installing.value = true;
  logs.value = '';
  result.value = null;
  socket.emit('install:start', {
    serverId: serverId.value,
    sudoPassword: sudoPassword.value,
    configureHttp: configureHttp.value,
  });
}

function close() {
  emit('update:modelValue', false);
}
</script>

<template>
  <SidePanel
    :model-value="modelValue"
    :title="t('install.title')"
    icon="mdi-medical-bag"
    :width="620"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="pa-4">
      <div class="text-medium-emphasis text-body-2 mb-4">{{ server?.name }}</div>

      <div v-if="loading" class="d-flex align-center ga-3 py-6 justify-center">
        <v-progress-circular indeterminate color="primary" size="22" />
        <span class="text-medium-emphasis">{{ t('install.diagnosing') }}</span>
      </div>

      <v-alert v-else-if="error" type="error" variant="tonal" :text="error" class="mb-4" />

      <template v-else-if="diag">
        <!-- status summary -->
        <v-list class="bg-transparent mb-2" density="compact">
          <v-list-item>
            <template #prepend><v-icon :icon="diag.reachable ? 'mdi-check-circle' : 'mdi-close-circle'" :color="diag.reachable ? 'success' : 'error'" /></template>
            <v-list-item-title>{{ t('install.xmlrpcAccess') }}</v-list-item-title>
            <template #append>
              <span class="text-medium-emphasis">{{ diag.reachable ? t('install.accessible') : t('install.notAccessible') }}</span>
            </template>
          </v-list-item>
          <v-list-item>
            <template #prepend>
              <v-icon
                :icon="diag.installed === true ? 'mdi-check-circle' : diag.installed === 'unknown' ? 'mdi-help-circle' : 'mdi-close-circle'"
                :color="diag.installed === true ? 'success' : diag.installed === 'unknown' ? 'grey' : 'warning'"
              />
            </template>
            <v-list-item-title>{{ t('install.installed') }}</v-list-item-title>
            <template #append>
              <span class="text-medium-emphasis">
                {{ diag.installed === true ? (diag.version || t('install.installedYes')) : diag.installed === 'unknown' ? t('common.unknown') : t('common.no') }}
              </span>
            </template>
          </v-list-item>
          <v-list-item v-if="diag.shell">
            <template #prepend><v-icon icon="mdi-console" /></template>
            <v-list-item-title>{{ t('install.system') }}</v-list-item-title>
            <template #append>
              <span class="text-medium-emphasis">{{ diag.os }}<template v-if="diag.packageManager"> · {{ diag.packageManager }}</template></span>
            </template>
          </v-list-item>
        </v-list>

        <!-- READY -->
        <v-alert v-if="status === 'ready'" type="success" variant="tonal" class="mt-2">
          {{ diag.version ? t('install.readyVersion', { version: diag.version }) : t('install.ready') }}
        </v-alert>

        <!-- NO SHELL (tcp/agent) and not reachable -->
        <template v-else-if="status === 'no-shell'">
          <v-alert type="warning" variant="tonal" class="mt-2 mb-3">
            {{ t('install.noShell', { method: diag.method }) }}
            <div v-if="diag.rpcError" class="text-caption mt-1">{{ t('install.errorLabel', { error: diag.rpcError }) }}</div>
          </v-alert>
          <v-alert type="info" variant="tonal" density="comfortable">
            <div class="text-body-2" v-html="t('install.noShellManual')" />
          </v-alert>
        </template>

        <!-- NO PACKAGE MANAGER -->
        <v-alert v-else-if="status === 'no-pm'" type="error" variant="tonal" class="mt-2">
          {{ t('install.noPm') }}
        </v-alert>

        <!-- INSTALL / CONFIGURE -->
        <template v-else-if="status === 'install' || status === 'configure'">
          <v-alert
            :type="status === 'configure' ? 'info' : 'warning'"
            variant="tonal"
            class="mt-2 mb-3"
          >
            <template v-if="status === 'configure'">{{ t('install.configureMsg') }}</template>
            <span v-else v-html="t('install.installMsg', { pm: diag.packageManager })" />
          </v-alert>

          <v-text-field
            v-if="!isDocker"
            v-model="sudoPassword"
            :label="t('install.sudoLabel')"
            type="password"
            prepend-inner-icon="mdi-lock"
            :hint="t('install.sudoHint')"
            persistent-hint
            variant="outlined"
            density="comfortable"
            autocomplete="new-password"
            class="mb-3"
            :disabled="installing"
          />

          <v-switch
            v-model="configureHttp"
            color="primary"
            :disabled="installing"
            hide-details
            class="mb-2"
          >
            <template #label>
              <span class="text-body-2">{{ t('install.configureHttp') }}</span>
            </template>
          </v-switch>

          <v-btn
            color="primary"
            variant="flat"
            :loading="installing"
            prepend-icon="mdi-download"
            @click="startInstall"
          >
            {{ status === 'configure' ? t('install.doConfigure') : t('install.doInstall') }}
          </v-btn>
        </template>

        <!-- result -->
        <v-alert v-if="result && !result.ok" type="error" variant="tonal" class="mt-3" :text="result.error" />
        <v-alert v-if="result && result.ok" type="success" variant="tonal" class="mt-3">
          {{ t('install.done') }}
          <div v-if="result.inet" class="text-caption mt-1">
            {{ t('install.inetFor') }} {{ result.inet.host }}:{{ result.inet.port }} ·
            {{ t('install.user') }} <code>{{ result.inet.username }}</code> · {{ t('install.password') }} <code>{{ result.inet.password }}</code>
            <div class="text-medium-emphasis">{{ t('install.inetNote') }}</div>
          </div>
        </v-alert>

        <!-- live log console -->
        <div v-if="logs" class="mt-4">
          <div class="text-caption text-medium-emphasis mb-1">{{ t('install.output') }}</div>
          <pre ref="logBox" class="install-log">{{ logs }}</pre>
        </div>
      </template>
    </div>

    <template #footer>
      <v-btn variant="text" prepend-icon="mdi-refresh" :disabled="loading || installing" @click="diagnose">{{ t('install.rediagnose') }}</v-btn>
      <v-spacer />
      <v-btn variant="text" @click="close">{{ t('install.close') }}</v-btn>
    </template>
  </SidePanel>
</template>

<style scoped>
code {
  background: rgba(var(--v-theme-on-surface), 0.08);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 0.82em;
}
/* Terminal-style console: stays dark with light text in both themes */
.install-log {
  background: #0b0e13;
  color: #d7dce3;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 0.78em;
  line-height: 1.5;
  max-height: 320px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}
</style>
