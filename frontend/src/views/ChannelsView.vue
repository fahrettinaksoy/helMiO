<script setup>
import { ref, onMounted, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { channelsApi } from '@/api/client';
import { useServersStore } from '@/stores/servers';
import PageShell from '@/components/PageShell.vue';

const { t } = useI18n();
const serversStore = useServersStore();

const channels = ref([]);
const loading = ref(false);
const error = ref('');
const meta = ref({ types: ['webhook', 'slack', 'discord', 'telegram', 'email'], alertTypes: ['fatal', 'flapping'] });
const snackbar = ref({ show: false, color: 'success', text: '' });
const testing = ref({});

const dialog = ref(false);
const editing = ref(null);
const saving = ref(false);
const formError = ref('');
const form = ref(blankForm());
const confirmDelete = ref(null);

const TYPE_META = {
  webhook: { icon: 'mdi-webhook', color: 'primary' },
  slack: { icon: 'mdi-slack', color: '#4A154B' },
  discord: { icon: 'mdi-discord', color: '#5865F2' },
  telegram: { icon: 'mdi-send-circle', color: '#229ED9' },
  email: { icon: 'mdi-email', color: 'info' },
};
const typeIcon = (ty) => TYPE_META[ty]?.icon || 'mdi-bell';

function blankForm() {
  return {
    type: 'slack',
    name: '',
    enabled: true,
    config: { url: '', webhookUrl: '', botToken: '', chatId: '', smtpHost: '', smtpPort: 587, secure: false, user: '', pass: '', from: '', to: '' },
    filters: { serverIds: [], alertTypes: [] },
  };
}

const serverOptions = computed(() => serversStore.servers.map((s) => ({ value: s.id, title: s.name })));

function notify(text, color = 'success') { snackbar.value = { show: true, color, text }; }

async function load() {
  loading.value = true;
  error.value = '';
  try {
    channels.value = await channelsApi.list();
  } catch (e) {
    error.value = e.response?.data?.error || e.message;
  } finally {
    loading.value = false;
  }
}
onMounted(async () => {
  if (!serversStore.servers.length) serversStore.fetchAll();
  try { meta.value = await channelsApi.meta(); } catch { /* keep defaults */ }
  load();
});

function openCreate() {
  editing.value = null;
  form.value = blankForm();
  formError.value = '';
  dialog.value = true;
}
function openEdit(ch) {
  editing.value = ch;
  form.value = {
    type: ch.type,
    name: ch.name,
    enabled: ch.enabled,
    config: { ...blankForm().config, ...ch.config },
    filters: { serverIds: [...(ch.filters?.serverIds || [])], alertTypes: [...(ch.filters?.alertTypes || [])] },
  };
  formError.value = '';
  dialog.value = true;
}

// Only send the config fields relevant to the chosen type.
function configForType(ty, cfg) {
  switch (ty) {
    case 'webhook': return { url: cfg.url };
    case 'slack': return { webhookUrl: cfg.webhookUrl };
    case 'discord': return { webhookUrl: cfg.webhookUrl };
    case 'telegram': return { botToken: cfg.botToken, chatId: cfg.chatId };
    case 'email': return { smtpHost: cfg.smtpHost, smtpPort: cfg.smtpPort, secure: cfg.secure, user: cfg.user, pass: cfg.pass, from: cfg.from, to: cfg.to };
    default: return {};
  }
}

async function save() {
  saving.value = true;
  formError.value = '';
  const payload = {
    type: form.value.type,
    name: form.value.name,
    enabled: form.value.enabled,
    config: configForType(form.value.type, form.value.config),
    filters: form.value.filters,
  };
  try {
    if (editing.value) {
      await channelsApi.update(editing.value.id, payload);
      notify(t('channels.updated', { name: form.value.name }));
    } else {
      await channelsApi.create(payload);
      notify(t('channels.created', { name: form.value.name }));
    }
    dialog.value = false;
    await load();
  } catch (e) {
    const d = e.response?.data;
    formError.value = d?.details ? Object.values(d.details.fieldErrors || {}).flat().join(' · ') || d.error : (d?.error || e.message);
  } finally {
    saving.value = false;
  }
}

async function test(ch) {
  testing.value = { ...testing.value, [ch.id]: true };
  try {
    await channelsApi.test(ch.id);
    notify(t('channels.testSent', { name: ch.name }));
    await load();
  } catch (e) {
    notify(e.response?.data?.error || e.message, 'error');
  } finally {
    testing.value = { ...testing.value, [ch.id]: false };
  }
}

async function toggleEnabled(ch) {
  try {
    await channelsApi.update(ch.id, { type: ch.type, name: ch.name, enabled: !ch.enabled, config: ch.config, filters: ch.filters });
    await load();
  } catch (e) {
    notify(e.response?.data?.error || e.message, 'error');
  }
}

async function doDelete() {
  const ch = confirmDelete.value;
  confirmDelete.value = null;
  try {
    await channelsApi.remove(ch.id);
    notify(t('channels.deleted', { name: ch.name }), 'info');
    await load();
  } catch (e) {
    notify(e.response?.data?.error || e.message, 'error');
  }
}

function targetSummary(ch) {
  const c = ch.config || {};
  if (ch.type === 'telegram') return `chat ${c.chatId}`;
  if (ch.type === 'email') return c.to;
  return c.webhookUrl || c.url || '••••••';
}
function filterSummary(ch) {
  const f = ch.filters || {};
  const srv = f.serverIds?.length ? t('channels.nServers', { n: f.serverIds.length }) : t('channels.allServers');
  const al = f.alertTypes?.length ? f.alertTypes.map((a) => t(`alert.type_${a}`)).join(', ') : t('channels.allAlerts');
  return `${srv} · ${al}`;
}
</script>

<template>
  <PageShell :title="t('channels.title')" :subtitle="t('channels.subtitle')" icon="mdi-bell-ring">
    <template #hero-actions>
      <v-btn color="white" variant="tonal" prepend-icon="mdi-plus" @click="openCreate">{{ t('channels.add') }}</v-btn>
    </template>

    <v-alert v-if="error" type="error" variant="tonal" class="mb-4" :text="error" />

    <v-empty-state
      v-if="!loading && !channels.length"
      icon="mdi-bell-off-outline"
      :title="t('channels.empty')"
      :text="t('channels.emptySub')"
    >
      <template #actions><v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ t('channels.add') }}</v-btn></template>
    </v-empty-state>

    <v-row v-else>
      <v-col v-for="ch in channels" :key="ch.id" cols="12" md="6" lg="4">
        <v-card variant="flat" class="panel-card h-100 d-flex flex-column">
          <v-card-item>
            <template #prepend>
              <v-avatar :color="TYPE_META[ch.type]?.color || 'primary'" variant="tonal" rounded><v-icon :icon="typeIcon(ch.type)" /></v-avatar>
            </template>
            <v-card-title class="d-flex align-center">
              {{ ch.name }}
              <v-chip v-if="!ch.enabled" size="x-small" variant="tonal" color="grey" label class="ms-2">{{ t('channels.disabled') }}</v-chip>
            </v-card-title>
            <v-card-subtitle><v-chip size="x-small" variant="tonal" label>{{ ch.type }}</v-chip></v-card-subtitle>
            <template #append>
              <v-switch :model-value="ch.enabled" color="success" density="compact" hide-details inset @update:model-value="toggleEnabled(ch)" />
            </template>
          </v-card-item>
          <v-card-text class="text-body-2 text-medium-emphasis flex-grow-1">
            <div class="d-flex align-center ga-1 mb-1"><v-icon icon="mdi-target" size="14" /><span class="text-truncate mono">{{ targetSummary(ch) }}</span></div>
            <div class="d-flex align-center ga-1"><v-icon icon="mdi-filter-variant" size="14" /><span>{{ filterSummary(ch) }}</span></div>
            <div v-if="ch.lastError" class="text-error text-caption mt-2"><v-icon icon="mdi-alert" size="13" /> {{ ch.lastError }}</div>
            <div v-else-if="ch.lastSentAt" class="text-success text-caption mt-2"><v-icon icon="mdi-check" size="13" /> {{ t('channels.lastSent', { time: new Date(ch.lastSentAt).toLocaleString() }) }}</div>
          </v-card-text>
          <v-divider />
          <v-card-actions>
            <v-btn size="small" variant="text" prepend-icon="mdi-send-check" :loading="testing[ch.id]" @click="test(ch)">{{ t('channels.test') }}</v-btn>
            <v-spacer />
            <v-btn size="small" icon="mdi-pencil" variant="text" @click="openEdit(ch)" />
            <v-btn size="small" icon="mdi-delete" variant="text" color="error" @click="confirmDelete = ch" />
          </v-card-actions>
        </v-card>
      </v-col>
    </v-row>

    <!-- Create / edit dialog -->
    <v-dialog v-model="dialog" max-width="560" scrollable>
      <v-card rounded="lg">
        <v-card-title>{{ editing ? t('channels.editTitle') : t('channels.add') }}</v-card-title>
        <v-card-text>
          <v-alert v-if="formError" type="error" variant="tonal" density="compact" class="mb-3" :text="formError" />

          <v-select v-model="form.type" :items="meta.types" :label="t('channels.type')" variant="outlined" density="comfortable" :disabled="!!editing" class="mb-2">
            <template #selection="{ item }"><v-icon :icon="typeIcon(item.value)" size="18" class="me-2" />{{ item.value }}</template>
            <template #item="{ item, props: p }"><v-list-item v-bind="p" :prepend-icon="typeIcon(item.value)" :title="item.value" /></template>
          </v-select>
          <v-text-field v-model="form.name" :label="t('channels.name')" variant="outlined" density="comfortable" class="mb-2" />

          <!-- Type-specific config -->
          <template v-if="form.type === 'webhook'">
            <v-text-field v-model="form.config.url" label="Webhook URL" placeholder="https://…" variant="outlined" density="comfortable" class="mb-2" />
          </template>
          <template v-else-if="form.type === 'slack' || form.type === 'discord'">
            <v-text-field v-model="form.config.webhookUrl" :label="`${form.type} Webhook URL`" placeholder="https://…" variant="outlined" density="comfortable" class="mb-2" />
          </template>
          <template v-else-if="form.type === 'telegram'">
            <v-text-field v-model="form.config.botToken" label="Bot Token" variant="outlined" density="comfortable" class="mb-2" />
            <v-text-field v-model="form.config.chatId" label="Chat ID" variant="outlined" density="comfortable" class="mb-2" />
          </template>
          <template v-else-if="form.type === 'email'">
            <div class="d-flex ga-2">
              <v-text-field v-model="form.config.smtpHost" label="SMTP Host" variant="outlined" density="comfortable" class="mb-2 flex-grow-1" />
              <v-text-field v-model.number="form.config.smtpPort" label="Port" type="number" variant="outlined" density="comfortable" class="mb-2" style="max-width: 110px" />
            </div>
            <v-switch v-model="form.config.secure" :label="t('channels.smtpSecure')" color="primary" density="compact" hide-details inset class="mb-2" />
            <div class="d-flex ga-2">
              <v-text-field v-model="form.config.user" label="SMTP User" variant="outlined" density="comfortable" class="mb-2 flex-grow-1" autocomplete="off" />
              <v-text-field v-model="form.config.pass" label="SMTP Pass" type="password" variant="outlined" density="comfortable" class="mb-2 flex-grow-1" autocomplete="new-password" />
            </div>
            <v-text-field v-model="form.config.from" :label="t('channels.from')" placeholder="helmio@example.com" variant="outlined" density="comfortable" class="mb-2" />
            <v-text-field v-model="form.config.to" :label="t('channels.to')" placeholder="ops@example.com" variant="outlined" density="comfortable" class="mb-2" />
          </template>

          <v-divider class="my-3" />
          <div class="text-caption text-medium-emphasis mb-2">{{ t('channels.filters') }}</div>
          <v-select
            v-model="form.filters.serverIds"
            :items="serverOptions"
            :label="t('channels.serversFilter')"
            :placeholder="t('channels.allServers')"
            variant="outlined" density="comfortable" multiple chips closable-chips class="mb-2"
            :hint="t('channels.serversFilterHint')" persistent-hint
          />
          <v-select
            v-model="form.filters.alertTypes"
            :items="meta.alertTypes.map((a) => ({ value: a, title: t(`alert.type_${a}`) }))"
            :label="t('channels.alertsFilter')"
            :placeholder="t('channels.allAlerts')"
            variant="outlined" density="comfortable" multiple chips class="mb-2"
            :hint="t('channels.alertsFilterHint')" persistent-hint
          />
          <v-switch v-model="form.enabled" :label="t('channels.enabledLabel')" color="success" density="compact" hide-details inset />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="dialog = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="primary" variant="flat" :loading="saving" @click="save">{{ t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog :model-value="!!confirmDelete" max-width="420" @update:model-value="confirmDelete = null">
      <v-card rounded="lg">
        <v-card-title>{{ t('channels.deleteTitle') }}</v-card-title>
        <v-card-text>{{ t('channels.deleteConfirm', { name: confirmDelete?.name }) }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmDelete = null">{{ t('common.cancel') }}</v-btn>
          <v-btn color="error" variant="flat" @click="doDelete">{{ t('common.delete') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="snackbar.show" :color="snackbar.color" location="bottom right" :timeout="4000">{{ snackbar.text }}</v-snackbar>
  </PageShell>
</template>

<style scoped>
.panel-card { border: 1px solid rgba(var(--v-theme-on-surface), 0.08); }
.mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.8rem; }
</style>
