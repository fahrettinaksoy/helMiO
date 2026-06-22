<script setup>
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import SidePanel from '@/components/SidePanel.vue';
import { serversApi } from '@/api/client';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  serverId: { type: String, default: '' },
  processes: { type: Array, default: () => [] }, // [{ fullName }]
});
const emit = defineEmits(['update:modelValue', 'action']);
const { t } = useI18n();

const loading = ref(false);
const checks = ref([]);
const running = ref({});
const dialog = ref(false);
const editing = ref(null);
const saving = ref(false);
const formError = ref('');
const form = ref(blank());
const confirmDelete = ref(null);

function blank() {
  return {
    target: '',
    type: 'http',
    action: 'restart',
    enabled: true,
    intervalSec: 30,
    failureThreshold: 3,
    config: {
      url: '',
      expectStatus: 200,
      host: '127.0.0.1',
      port: 8080,
      command: '',
      expectExit: 0,
      timeoutMs: 5000,
    },
  };
}

const processOptions = computed(() => props.processes.map((p) => p.fullName));

const statusMeta = (c) => {
  if (c.lastStatus === 'ok')
    return { color: 'success', icon: 'mdi-heart-pulse', text: t('health.ok') };
  if (c.lastStatus === 'fail')
    return { color: 'error', icon: 'mdi-heart-broken', text: t('health.failing') };
  return { color: 'grey', icon: 'mdi-heart-outline', text: t('health.unknown') };
};

async function load() {
  loading.value = true;
  try {
    checks.value = await serversApi.healthChecks(props.serverId);
  } catch (e) {
    emit('action', { ok: false, message: e.response?.data?.error || e.message });
  } finally {
    loading.value = false;
  }
}
watch(
  () => props.modelValue,
  (open) => {
    if (open) load();
  },
);

function openCreate() {
  editing.value = null;
  form.value = blank();
  if (processOptions.value.length) form.value.target = processOptions.value[0];
  formError.value = '';
  dialog.value = true;
}
function openEdit(c) {
  editing.value = c;
  form.value = {
    target: c.target,
    type: c.type,
    action: c.action,
    enabled: c.enabled,
    intervalSec: c.intervalSec,
    failureThreshold: c.failureThreshold,
    config: { ...blank().config, ...c.config },
  };
  formError.value = '';
  dialog.value = true;
}

function payload() {
  const c = form.value.config;
  let cfg;
  if (form.value.type === 'http')
    cfg = { url: c.url, expectStatus: c.expectStatus, timeoutMs: c.timeoutMs };
  else if (form.value.type === 'tcp') cfg = { host: c.host, port: c.port, timeoutMs: c.timeoutMs };
  else cfg = { command: c.command, expectExit: c.expectExit, timeoutMs: c.timeoutMs };
  return {
    target: form.value.target,
    type: form.value.type,
    action: form.value.action,
    enabled: form.value.enabled,
    intervalSec: form.value.intervalSec,
    failureThreshold: form.value.failureThreshold,
    config: cfg,
  };
}

async function save() {
  saving.value = true;
  formError.value = '';
  try {
    if (editing.value)
      await serversApi.healthCheckUpdate(props.serverId, editing.value.id, payload());
    else await serversApi.healthCheckCreate(props.serverId, payload());
    emit('action', { ok: true, message: t('health.saved') });
    dialog.value = false;
    await load();
  } catch (e) {
    const d = e.response?.data;
    formError.value = d?.details
      ? Object.values(d.details.fieldErrors || {})
          .flat()
          .join(' · ') || d.error
      : d?.error || e.message;
  } finally {
    saving.value = false;
  }
}

async function runNow(c) {
  running.value = { ...running.value, [c.id]: true };
  try {
    const r = await serversApi.healthCheckRun(props.serverId, c.id);
    emit('action', {
      ok: r.ok,
      message: r.ok
        ? t('health.probeOk', { ms: r.durationMs })
        : t('health.probeFail', { error: r.error }),
    });
  } catch (e) {
    emit('action', { ok: false, message: e.response?.data?.error || e.message });
  } finally {
    running.value = { ...running.value, [c.id]: false };
  }
}

async function toggleEnabled(c) {
  try {
    await serversApi.healthCheckUpdate(props.serverId, c.id, {
      ...c,
      config: c.config,
      enabled: !c.enabled,
    });
    await load();
  } catch (e) {
    emit('action', { ok: false, message: e.response?.data?.error || e.message });
  }
}

async function doDelete() {
  const c = confirmDelete.value;
  confirmDelete.value = null;
  try {
    await serversApi.healthCheckRemove(props.serverId, c.id);
    emit('action', { ok: true, message: t('health.deleted') });
    await load();
  } catch (e) {
    emit('action', { ok: false, message: e.response?.data?.error || e.message });
  }
}

const targetSummary = (c) => {
  if (c.type === 'http') return c.config.url;
  if (c.type === 'tcp') return `${c.config.host}:${c.config.port}`;
  return c.config.command;
};
</script>

<template>
  <SidePanel
    :model-value="modelValue"
    :title="t('health.title')"
    icon="mdi-heart-pulse"
    :width="600"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="pa-4">
      <div class="d-flex align-center mb-3">
        <p class="text-body-2 text-medium-emphasis mb-0">{{ t('health.intro') }}</p>
        <v-spacer />
        <v-btn size="small" variant="text" icon="mdi-refresh" :loading="loading" @click="load" />
      </div>
      <v-btn color="primary" prepend-icon="mdi-plus" class="mb-4" @click="openCreate">{{
        t('health.add')
      }}</v-btn>

      <div v-if="loading && !checks.length" class="py-8 text-center">
        <v-progress-circular indeterminate color="primary" />
      </div>
      <div v-else-if="!checks.length" class="py-8 text-center text-medium-emphasis text-caption">
        {{ t('health.empty') }}
      </div>

      <v-card v-for="c in checks" :key="c.id" rounded="lg" class="mb-2">
        <div class="d-flex align-center pa-3">
          <v-icon :icon="statusMeta(c).icon" :color="statusMeta(c).color" class="me-3" />
          <div class="flex-grow-1 min-w-0">
            <div class="d-flex align-center ga-2">
              <span class="font-weight-medium text-truncate">{{ c.target }}</span>
              <v-chip size="x-small" variant="tonal" label>{{ c.type }}</v-chip>
              <v-chip
                size="x-small"
                variant="tonal"
                :color="c.action === 'restart' ? 'warning' : 'info'"
                label
                >{{ t(`health.action_${c.action}`) }}</v-chip
              >
            </div>
            <div class="text-caption text-medium-emphasis mono text-truncate">
              {{ targetSummary(c) }}
            </div>
            <div class="text-caption d-flex align-center ga-2 mt-1">
              <span :class="`text-${statusMeta(c).color}`">{{ statusMeta(c).text }}</span>
              <span class="text-medium-emphasis"
                >· {{ t('health.everyN', { n: c.intervalSec }) }} ·
                {{ t('health.threshold', { n: c.failureThreshold }) }}</span
              >
              <span v-if="c.consecutiveFailures > 0" class="text-error"
                >· {{ t('health.failCount', { n: c.consecutiveFailures }) }}</span
              >
            </div>
            <div
              v-if="c.lastError && c.lastStatus === 'fail'"
              class="text-caption text-error text-truncate"
            >
              {{ c.lastError }}
            </div>
          </div>
          <v-switch
            :model-value="c.enabled"
            color="success"
            density="compact"
            hide-details
            inset
            class="me-1"
            @update:model-value="toggleEnabled(c)"
          />
          <v-btn
            size="small"
            icon="mdi-play-circle-outline"
            variant="text"
            :loading="running[c.id]"
            :title="t('health.runNow')"
            @click="runNow(c)"
          />
          <v-btn size="small" icon="mdi-pencil" variant="text" @click="openEdit(c)" />
          <v-btn
            size="small"
            icon="mdi-delete"
            variant="text"
            color="error"
            @click="confirmDelete = c"
          />
        </div>
      </v-card>
    </div>

    <!-- Create / edit -->
    <v-dialog v-model="dialog" max-width="500" scrollable>
      <v-card rounded="lg">
        <v-card-title>{{ editing ? t('health.editTitle') : t('health.add') }}</v-card-title>
        <v-card-text>
          <v-alert
            v-if="formError"
            type="error"
            variant="tonal"
            density="compact"
            class="mb-3"
            :text="formError"
          />
          <v-combobox
            v-model="form.target"
            :items="processOptions"
            :label="t('health.target')"
            variant="outlined"
            density="comfortable"
            class="mb-2"
            :hint="t('health.targetHint')"
            persistent-hint
          />
          <v-btn-toggle
            v-model="form.type"
            mandatory
            density="comfortable"
            variant="outlined"
            divided
            class="mb-3"
          >
            <v-btn value="http" size="small">HTTP</v-btn>
            <v-btn value="tcp" size="small">TCP</v-btn>
            <v-btn value="script" size="small">Script</v-btn>
          </v-btn-toggle>

          <template v-if="form.type === 'http'">
            <v-text-field
              v-model="form.config.url"
              label="URL"
              placeholder="http://127.0.0.1:8080/health"
              variant="outlined"
              density="comfortable"
              class="mb-2"
            />
            <v-text-field
              v-model.number="form.config.expectStatus"
              :label="t('health.expectStatus')"
              type="number"
              variant="outlined"
              density="comfortable"
              class="mb-2"
            />
          </template>
          <template v-else-if="form.type === 'tcp'">
            <div class="d-flex ga-2">
              <v-text-field
                v-model="form.config.host"
                label="Host"
                variant="outlined"
                density="comfortable"
                class="mb-2 flex-grow-1"
              />
              <v-text-field
                v-model.number="form.config.port"
                label="Port"
                type="number"
                variant="outlined"
                density="comfortable"
                class="mb-2"
                style="max-width: 120px"
              />
            </div>
          </template>
          <template v-else>
            <v-text-field
              v-model="form.config.command"
              :label="t('health.command')"
              placeholder="curl -fsS http://localhost:8080/health"
              variant="outlined"
              density="comfortable"
              class="mb-2"
              autocomplete="off"
            />
            <v-text-field
              v-model.number="form.config.expectExit"
              :label="t('health.expectExit')"
              type="number"
              variant="outlined"
              density="comfortable"
              class="mb-2"
              :hint="t('health.scriptHint')"
              persistent-hint
            />
          </template>

          <div class="d-flex ga-2">
            <v-text-field
              v-model.number="form.intervalSec"
              :label="t('health.interval')"
              type="number"
              suffix="s"
              variant="outlined"
              density="comfortable"
              class="mb-2"
            />
            <v-text-field
              v-model.number="form.failureThreshold"
              :label="t('health.failureThreshold')"
              type="number"
              variant="outlined"
              density="comfortable"
              class="mb-2"
            />
            <v-text-field
              v-model.number="form.config.timeoutMs"
              :label="t('health.timeout')"
              type="number"
              suffix="ms"
              variant="outlined"
              density="comfortable"
              class="mb-2"
            />
          </div>

          <v-select
            v-model="form.action"
            :items="[{ value: 'restart' }, { value: 'alert' }]"
            :label="t('health.onFailure')"
            variant="outlined"
            density="comfortable"
            class="mb-2"
          >
            <template #selection="{ item }">{{ t(`health.action_${item.value}`) }}</template>
            <template #item="{ item, props: p }"
              ><v-list-item
                v-bind="p"
                :title="t(`health.action_${item.value}`)"
                :subtitle="t(`health.action_${item.value}_desc`)"
            /></template>
          </v-select>
          <v-switch
            v-model="form.enabled"
            :label="t('health.enabledLabel')"
            color="success"
            density="compact"
            hide-details
            inset
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="dialog = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="primary" variant="flat" :loading="saving" @click="save">{{
            t('common.save')
          }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog
      :model-value="!!confirmDelete"
      max-width="420"
      @update:model-value="confirmDelete = null"
    >
      <v-card rounded="lg">
        <v-card-title>{{ t('health.deleteTitle') }}</v-card-title>
        <v-card-text>{{ t('health.deleteConfirm', { name: confirmDelete?.target }) }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmDelete = null">{{ t('common.cancel') }}</v-btn>
          <v-btn color="error" variant="flat" @click="doDelete">{{ t('common.delete') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </SidePanel>
</template>

<style scoped>
/* Vuetify has no monospace utility, nor a flex min-width:0 truncation guard. */
.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
}
.min-w-0 {
  min-width: 0;
}
</style>
