<script setup>
import { ref, onMounted, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { channelsApi } from '@/api/client';
import { useServersStore } from '@/stores/servers';
import PageShell from '@/components/PageShell.vue';
import DataPanel from '@/components/DataPanel.vue';
import SidePanel from '@/components/SidePanel.vue';

const { t } = useI18n();
const serversStore = useServersStore();

const channels = ref([]);
const q = ref('');
const loading = ref(false);
const error = ref('');

const headers = computed(() => [
  { title: t('channels.colName'), key: 'name', sortable: true },
  { title: t('channels.colType'), key: 'type', width: 130, sortable: true },
  { title: t('channels.colTarget'), key: 'target', sortable: false },
  { title: t('channels.colFilters'), key: 'filters', sortable: false },
  { title: t('channels.colStatus'), key: 'status', width: 150, sortable: false },
  { title: t('channels.enabledLabel'), key: 'enabled', width: 90, align: 'center', sortable: true },
  { title: t('channels.test'), key: 'a_test', width: 80, align: 'center', sortable: false },
  { title: t('common.edit'), key: 'a_edit', width: 80, align: 'center', sortable: false },
  { title: t('common.delete'), key: 'a_delete', width: 80, align: 'center', sortable: false },
]);

const typeFilter = ref(null);
const statusFilter = ref(null);
const typeOptions = computed(() => [
  { value: null, title: t('common.allTypes') },
  ...meta.value.types.map((ty) => ({ value: ty, title: ty })),
]);
const statusOptions = computed(() => [
  { value: null, title: t('common.allStatuses') },
  { value: 'enabled', title: t('channels.enabledLabel') },
  { value: 'disabled', title: t('channels.disabled') },
  { value: 'error', title: t('channels.statusError') },
]);
const filteredChannels = computed(() => {
  const term = q.value?.trim().toLowerCase();
  return channels.value.filter((c) => {
    if (typeFilter.value && c.type !== typeFilter.value) return false;
    if (statusFilter.value === 'enabled' && !c.enabled) return false;
    if (statusFilter.value === 'disabled' && c.enabled) return false;
    if (statusFilter.value === 'error' && !c.lastError) return false;
    if (
      term &&
      !(
        c.name.toLowerCase().includes(term) ||
        c.type.toLowerCase().includes(term) ||
        targetSummary(c).toLowerCase().includes(term)
      )
    )
      return false;
    return true;
  });
});
const meta = ref({
  types: ['webhook', 'slack', 'discord', 'telegram', 'email'],
  alertTypes: ['fatal', 'flapping'],
});
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
    config: {
      url: '',
      webhookUrl: '',
      botToken: '',
      chatId: '',
      smtpHost: '',
      smtpPort: 587,
      secure: false,
      user: '',
      pass: '',
      from: '',
      to: '',
    },
    filters: { serverIds: [], alertTypes: [] },
  };
}

const serverOptions = computed(() =>
  serversStore.servers.map((s) => ({ value: s.id, title: s.name })),
);

function notify(text, color = 'success') {
  snackbar.value = { show: true, color, text };
}

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
  try {
    meta.value = await channelsApi.meta();
  } catch {
    /* keep defaults */
  }
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
    filters: {
      serverIds: [...(ch.filters?.serverIds || [])],
      alertTypes: [...(ch.filters?.alertTypes || [])],
    },
  };
  formError.value = '';
  dialog.value = true;
}

// Only send the config fields relevant to the chosen type.
function configForType(ty, cfg) {
  switch (ty) {
    case 'webhook':
      return { url: cfg.url };
    case 'slack':
      return { webhookUrl: cfg.webhookUrl };
    case 'discord':
      return { webhookUrl: cfg.webhookUrl };
    case 'telegram':
      return { botToken: cfg.botToken, chatId: cfg.chatId };
    case 'email':
      return {
        smtpHost: cfg.smtpHost,
        smtpPort: cfg.smtpPort,
        secure: cfg.secure,
        user: cfg.user,
        pass: cfg.pass,
        from: cfg.from,
        to: cfg.to,
      };
    default:
      return {};
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
    formError.value = d?.details
      ? Object.values(d.details.fieldErrors || {})
          .flat()
          .join(' · ') || d.error
      : d?.error || e.message;
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
    await channelsApi.update(ch.id, {
      type: ch.type,
      name: ch.name,
      enabled: !ch.enabled,
      config: ch.config,
      filters: ch.filters,
    });
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
  const srv = f.serverIds?.length
    ? t('channels.nServers', { n: f.serverIds.length })
    : t('channels.allServers');
  const al = f.alertTypes?.length
    ? f.alertTypes.map((a) => t(`alert.type_${a}`)).join(', ')
    : t('channels.allAlerts');
  return `${srv} · ${al}`;
}
</script>

<template>
  <PageShell :title="t('channels.title')" :subtitle="t('channels.subtitle')" icon="mdi-bell-ring">
    <template #hero-actions>
      <v-btn color="white" variant="tonal" prepend-icon="mdi-plus" @click="openCreate">{{
        t('channels.add')
      }}</v-btn>
    </template>

    <v-alert v-if="error" type="error" variant="tonal" class="mb-4" :text="error" />

    <DataPanel>
      <template #filters>
        <v-text-field
          v-model="q"
          :placeholder="t('channels.search')"
          prepend-inner-icon="mdi-magnify"
          variant="solo-filled"
          density="compact"
          flat
          hide-details
          clearable
          rounded="lg"
          class="ch-search"
        />
        <v-select
          v-model="typeFilter"
          :items="typeOptions"
          variant="solo-filled"
          density="compact"
          flat
          hide-details
          rounded="lg"
          class="flt-select"
        />
        <v-select
          v-model="statusFilter"
          :items="statusOptions"
          variant="solo-filled"
          density="compact"
          flat
          hide-details
          rounded="lg"
          class="flt-select"
        />
      </template>

      <template #default="{ height }">
        <!-- Empty: no channels at all -->
        <v-empty-state
          v-if="!loading && !channels.length"
          icon="mdi-bell-off-outline"
          :title="t('channels.empty')"
          :text="t('channels.emptySub')"
        >
          <template #actions
            ><v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{
              t('channels.add')
            }}</v-btn></template
          >
        </v-empty-state>

        <!-- Empty: no search match -->
        <v-empty-state
          v-else-if="channels.length && !filteredChannels.length"
          icon="mdi-magnify-close"
          :title="t('channels.noMatch')"
          :text="t('channels.noMatchSub', { q })"
        />

        <!-- Table -->
        <v-data-table
          v-else
          :headers="headers"
          :items="filteredChannels"
          item-value="id"
          density="comfortable"
          hover
          fixed-header
          :height="height"
          hide-default-footer
          :items-per-page="-1"
          :loading="loading"
          class="bg-transparent ch-table border-0"
        >
          <template #[`item.name`]="{ item }">
            <div class="d-flex align-center ga-2">
              <v-avatar
                :color="TYPE_META[item.type]?.color || 'primary'"
                variant="tonal"
                rounded
                size="32"
                ><v-icon :icon="typeIcon(item.type)" size="18"
              /></v-avatar>
              <span class="font-weight-medium">{{ item.name }}</span>
              <v-chip v-if="!item.enabled" size="x-small" variant="tonal" color="grey" label>{{
                t('channels.disabled')
              }}</v-chip>
            </div>
          </template>
          <template #[`item.type`]="{ item }">
            <v-chip size="x-small" variant="tonal" label>{{ item.type }}</v-chip>
          </template>
          <template #[`item.target`]="{ item }">
            <code class="text-medium-emphasis text-truncate d-inline-block ch-target">{{
              targetSummary(item)
            }}</code>
          </template>
          <template #[`item.filters`]="{ item }">
            <span class="text-medium-emphasis">{{ filterSummary(item) }}</span>
          </template>
          <template #[`item.status`]="{ item }">
            <v-tooltip v-if="item.lastError" :text="item.lastError" location="top">
              <template #activator="{ props: tip }"
                ><v-chip v-bind="tip" size="small" variant="tonal" color="error" label
                  ><v-icon start icon="mdi-alert" size="14" />{{
                    t('channels.statusError')
                  }}</v-chip
                ></template
              >
            </v-tooltip>
            <v-tooltip
              v-else-if="item.lastSentAt"
              :text="t('channels.lastSent', { time: new Date(item.lastSentAt).toLocaleString() })"
              location="top"
            >
              <template #activator="{ props: tip }"
                ><v-chip v-bind="tip" size="small" variant="tonal" color="success" label
                  ><v-icon start icon="mdi-check" size="14" />{{ t('channels.statusOk') }}</v-chip
                ></template
              >
            </v-tooltip>
            <span v-else class="text-caption text-medium-emphasis">{{
              t('channels.statusIdle')
            }}</span>
          </template>
          <template #[`item.enabled`]="{ item }">
            <div class="d-flex justify-center">
              <v-switch
                :model-value="item.enabled"
                color="success"
                density="compact"
                hide-details
                inset
                @update:model-value="toggleEnabled(item)"
              />
            </div>
          </template>
          <template #[`item.a_test`]="{ item }">
            <v-tooltip :text="t('channels.test')" location="top">
              <template #activator="{ props: tip }"
                ><v-btn
                  v-bind="tip"
                  size="small"
                  icon="mdi-send-check"
                  variant="text"
                  :loading="testing[item.id]"
                  @click="test(item)"
              /></template>
            </v-tooltip>
          </template>
          <template #[`item.a_edit`]="{ item }">
            <v-tooltip :text="t('common.edit')" location="top">
              <template #activator="{ props: tip }"
                ><v-btn
                  v-bind="tip"
                  size="small"
                  icon="mdi-pencil"
                  variant="text"
                  @click="openEdit(item)"
              /></template>
            </v-tooltip>
          </template>
          <template #[`item.a_delete`]="{ item }">
            <v-tooltip :text="t('common.delete')" location="top">
              <template #activator="{ props: tip }"
                ><v-btn
                  v-bind="tip"
                  size="small"
                  icon="mdi-delete"
                  variant="text"
                  color="error"
                  @click="confirmDelete = item"
              /></template>
            </v-tooltip>
          </template>
        </v-data-table>
      </template>
    </DataPanel>

    <!-- Create / edit form (slide-over) -->
    <SidePanel
      v-model="dialog"
      :title="editing ? t('channels.editTitle') : t('channels.add')"
      :icon="editing ? 'mdi-bell-cog' : 'mdi-bell-plus'"
      :width="560"
    >
      <div class="pa-4">
        <v-alert
          v-if="formError"
          type="error"
          variant="tonal"
          density="compact"
          class="mb-3"
          :text="formError"
        />

        <v-select
          v-model="form.type"
          :items="meta.types"
          :label="t('channels.type')"
          variant="outlined"
          density="comfortable"
          :disabled="!!editing"
          class="mb-2"
        >
          <template #selection="{ item }"
            ><v-icon :icon="typeIcon(item.value)" size="18" class="me-2" />{{
              item.value
            }}</template
          >
          <template #item="{ item, props: p }"
            ><v-list-item v-bind="p" :prepend-icon="typeIcon(item.value)" :title="item.value"
          /></template>
        </v-select>
        <v-text-field
          v-model="form.name"
          :label="t('channels.name')"
          variant="outlined"
          density="comfortable"
          class="mb-2"
        />

        <!-- Type-specific config -->
        <template v-if="form.type === 'webhook'">
          <v-text-field
            v-model="form.config.url"
            label="Webhook URL"
            placeholder="https://…"
            variant="outlined"
            density="comfortable"
            class="mb-2"
          />
        </template>
        <template v-else-if="form.type === 'slack' || form.type === 'discord'">
          <v-text-field
            v-model="form.config.webhookUrl"
            :label="`${form.type} Webhook URL`"
            placeholder="https://…"
            variant="outlined"
            density="comfortable"
            class="mb-2"
          />
        </template>
        <template v-else-if="form.type === 'telegram'">
          <v-text-field
            v-model="form.config.botToken"
            label="Bot Token"
            variant="outlined"
            density="comfortable"
            class="mb-2"
          />
          <v-text-field
            v-model="form.config.chatId"
            label="Chat ID"
            variant="outlined"
            density="comfortable"
            class="mb-2"
          />
        </template>
        <template v-else-if="form.type === 'email'">
          <div class="d-flex ga-2">
            <v-text-field
              v-model="form.config.smtpHost"
              label="SMTP Host"
              variant="outlined"
              density="comfortable"
              class="mb-2 flex-grow-1"
            />
            <v-text-field
              v-model.number="form.config.smtpPort"
              label="Port"
              type="number"
              variant="outlined"
              density="comfortable"
              class="mb-2"
              style="max-width: 110px"
            />
          </div>
          <v-switch
            v-model="form.config.secure"
            :label="t('channels.smtpSecure')"
            color="primary"
            density="compact"
            hide-details
            inset
            class="mb-2"
          />
          <div class="d-flex ga-2">
            <v-text-field
              v-model="form.config.user"
              label="SMTP User"
              variant="outlined"
              density="comfortable"
              class="mb-2 flex-grow-1"
              autocomplete="off"
            />
            <v-text-field
              v-model="form.config.pass"
              label="SMTP Pass"
              type="password"
              variant="outlined"
              density="comfortable"
              class="mb-2 flex-grow-1"
              autocomplete="new-password"
            />
          </div>
          <v-text-field
            v-model="form.config.from"
            :label="t('channels.from')"
            placeholder="helmio@example.com"
            variant="outlined"
            density="comfortable"
            class="mb-2"
          />
          <v-text-field
            v-model="form.config.to"
            :label="t('channels.to')"
            placeholder="ops@example.com"
            variant="outlined"
            density="comfortable"
            class="mb-2"
          />
        </template>

        <v-divider class="my-3" />
        <div class="text-caption text-medium-emphasis mb-2">{{ t('channels.filters') }}</div>
        <v-select
          v-model="form.filters.serverIds"
          :items="serverOptions"
          :label="t('channels.serversFilter')"
          :placeholder="t('channels.allServers')"
          variant="outlined"
          density="comfortable"
          multiple
          chips
          closable-chips
          class="mb-2"
          :hint="t('channels.serversFilterHint')"
          persistent-hint
        />
        <v-select
          v-model="form.filters.alertTypes"
          :items="meta.alertTypes.map((a) => ({ value: a, title: t(`alert.type_${a}`) }))"
          :label="t('channels.alertsFilter')"
          :placeholder="t('channels.allAlerts')"
          variant="outlined"
          density="comfortable"
          multiple
          chips
          class="mb-2"
          :hint="t('channels.alertsFilterHint')"
          persistent-hint
        />
        <v-switch
          v-model="form.enabled"
          :label="t('channels.enabledLabel')"
          color="success"
          density="compact"
          hide-details
          inset
        />
      </div>
      <template #footer="{ close }">
        <v-spacer />
        <v-btn variant="text" @click="close">{{ t('common.cancel') }}</v-btn>
        <v-btn color="primary" variant="flat" :loading="saving" @click="save">{{
          t('common.save')
        }}</v-btn>
      </template>
    </SidePanel>

    <v-dialog
      :model-value="!!confirmDelete"
      max-width="420"
      @update:model-value="confirmDelete = null"
    >
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

    <v-snackbar
      v-model="snackbar.show"
      :color="snackbar.color"
      location="bottom right"
      :timeout="4000"
      >{{ snackbar.text }}</v-snackbar
    >
  </PageShell>
</template>

<style scoped>
code {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.78rem;
}
.ch-search {
  width: 280px;
  max-width: 42vw;
}
.flt-select {
  width: 168px;
}
/* Sticky header needs the surface colour to mask rows scrolling under it. */
.ch-table :deep(thead th) {
  background: rgb(var(--v-theme-surface)) !important;
}
.ch-target {
  max-width: 320px;
  vertical-align: middle;
}
</style>
