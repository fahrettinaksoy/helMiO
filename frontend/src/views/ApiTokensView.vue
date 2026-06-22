<script setup>
import { ref, onMounted, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { apiTokensApi } from '@/api/client';
import PageShell from '@/components/PageShell.vue';
import DataPanel from '@/components/DataPanel.vue';
import SidePanel from '@/components/SidePanel.vue';

const { t } = useI18n();

const tokens = ref([]);
const loading = ref(false);
const error = ref('');
const snackbar = ref({ show: false, color: 'success', text: '' });

const dialog = ref(false);
const form = ref({ name: '', role: 'viewer' });
const saving = ref(false);
const formError = ref('');
const created = ref(null); // { token, record } — shown once
const confirmDelete = ref(null);

const ROLES = ['admin', 'operator', 'viewer'];
const roleColor = (r) => ({ admin: 'error', operator: 'warning', viewer: 'info' })[r] || 'default';

// ---- filters ----
const search = ref('');
const roleFilter = ref(null);
const usageFilter = ref(null);
const roleOptions = computed(() => [
  { value: null, title: t('common.allRoles') },
  ...ROLES.map((r) => ({ value: r, title: t(`roles.${r}`) })),
]);
const usageOptions = computed(() => [
  { value: null, title: t('common.all') },
  { value: 'used', title: t('tokens.used') },
  { value: 'never', title: t('tokens.neverUsed') },
]);
const filteredTokens = computed(() => {
  const term = search.value.trim().toLowerCase();
  return tokens.value.filter((tk) => {
    if (roleFilter.value && tk.role !== roleFilter.value) return false;
    if (usageFilter.value === 'used' && !tk.lastUsedAt) return false;
    if (usageFilter.value === 'never' && tk.lastUsedAt) return false;
    if (term && !`${tk.name} ${tk.prefix || ''}`.toLowerCase().includes(term)) return false;
    return true;
  });
});

const headers = computed(() => [
  { title: t('tokens.colName'), key: 'name' },
  { title: t('tokens.colRole'), key: 'role', width: 130 },
  { title: t('tokens.colPrefix'), key: 'prefix', width: 160 },
  { title: t('tokens.colLastUsed'), key: 'lastUsedAt', width: 190 },
  { title: '', key: 'actions', width: 70, align: 'end', sortable: false },
]);

function notify(text, color = 'success') {
  snackbar.value = { show: true, color, text };
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    tokens.value = await apiTokensApi.list();
  } catch (e) {
    error.value = e.response?.data?.error || e.message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function openCreate() {
  form.value = { name: '', role: 'viewer' };
  formError.value = '';
  created.value = null;
  dialog.value = true;
}

async function save() {
  saving.value = true;
  formError.value = '';
  try {
    const res = await apiTokensApi.create(form.value);
    created.value = res; // reveal once
    await load();
  } catch (e) {
    formError.value = e.response?.data?.error || e.message;
  } finally {
    saving.value = false;
  }
}

async function copyToken() {
  try {
    await navigator.clipboard.writeText(created.value.token);
    notify(t('tokens.copied'));
  } catch {
    /* clipboard unavailable */
  }
}

async function doDelete() {
  const tk = confirmDelete.value;
  confirmDelete.value = null;
  try {
    await apiTokensApi.remove(tk.id);
    notify(t('tokens.deleted', { name: tk.name }), 'info');
    await load();
  } catch (e) {
    notify(e.response?.data?.error || e.message, 'error');
  }
}
</script>

<template>
  <PageShell :title="t('tokens.title')" :subtitle="t('tokens.subtitle')" icon="mdi-key-variant">
    <template #hero-actions>
      <v-btn color="white" variant="tonal" prepend-icon="mdi-key-plus" @click="openCreate">{{
        t('tokens.add')
      }}</v-btn>
    </template>

    <v-alert v-if="error" type="error" variant="tonal" class="mb-4" :text="error" />

    <v-alert
      type="info"
      variant="tonal"
      density="comfortable"
      class="mb-4"
      icon="mdi-information-outline"
    >
      {{ t('tokens.usageHint') }}
      <code class="d-block mt-2">Authorization: Bearer hmo_…&#10;X-Helmio-Api-Key: hmo_…</code>
    </v-alert>

    <DataPanel>
      <template #filters>
        <v-text-field
          v-model="search"
          :placeholder="t('common.search')"
          prepend-inner-icon="mdi-magnify"
          variant="solo-filled"
          density="compact"
          flat
          hide-details
          clearable
          rounded="lg"
          class="flt-search"
        />
        <v-select
          v-model="roleFilter"
          :items="roleOptions"
          variant="solo-filled"
          density="compact"
          flat
          hide-details
          rounded="lg"
          class="flt-select"
        />
        <v-select
          v-model="usageFilter"
          :items="usageOptions"
          variant="solo-filled"
          density="compact"
          flat
          hide-details
          rounded="lg"
          class="flt-select"
        />
      </template>
      <template #default="{ height }">
        <v-data-table
          :headers="headers"
          :items="filteredTokens"
          :loading="loading"
          item-value="id"
          density="comfortable"
          hover
          fixed-header
          :height="height"
          hide-default-footer
          :items-per-page="-1"
          class="bg-transparent"
        >
          <template #[`item.name`]="{ item }">
            <div class="d-flex align-center ga-2">
              <v-icon icon="mdi-key-variant" size="18" /><span class="font-weight-medium">{{
                item.name
              }}</span>
            </div>
          </template>
          <template #[`item.role`]="{ item }">
            <v-chip :color="roleColor(item.role)" size="small" variant="tonal" label>{{
              t(`roles.${item.role}`)
            }}</v-chip>
          </template>
          <template #[`item.prefix`]="{ item }">
            <code>{{ item.prefix }}…</code>
          </template>
          <template #[`item.lastUsedAt`]="{ item }">
            <span class="text-caption text-medium-emphasis">{{
              item.lastUsedAt ? new Date(item.lastUsedAt).toLocaleString() : t('tokens.never')
            }}</span>
          </template>
          <template #[`item.actions`]="{ item }">
            <v-btn
              size="small"
              icon="mdi-delete"
              variant="text"
              color="error"
              @click="confirmDelete = item"
            />
          </template>
          <template #no-data>
            <div class="py-8 text-center text-medium-emphasis">
              {{ tokens.length ? t('common.noMatch') : t('tokens.empty') }}
            </div>
          </template>
        </v-data-table>
      </template>
    </DataPanel>

    <!-- Create / reveal form (slide-over) -->
    <SidePanel
      v-model="dialog"
      :title="created ? t('tokens.createdTitle') : t('tokens.add')"
      :icon="created ? 'mdi-key-star' : 'mdi-key-plus'"
      :width="520"
    >
      <div class="pa-4">
        <template v-if="!created">
          <v-alert
            v-if="formError"
            type="error"
            variant="tonal"
            density="compact"
            class="mb-3"
            :text="formError"
          />
          <v-text-field
            v-model="form.name"
            :label="t('tokens.name')"
            variant="outlined"
            density="comfortable"
            class="mb-2"
            autocomplete="off"
          />
          <v-select
            v-model="form.role"
            :items="ROLES"
            :label="t('tokens.role')"
            variant="outlined"
            density="comfortable"
          >
            <template #selection="{ item }">{{ t(`roles.${item.value}`) }}</template>
            <template #item="{ item, props: p }"
              ><v-list-item
                v-bind="p"
                :title="t(`roles.${item.value}`)"
                :subtitle="t(`roles.${item.value}_desc`)"
            /></template>
          </v-select>
        </template>
        <template v-else>
          <v-alert
            type="warning"
            variant="tonal"
            density="compact"
            class="mb-3"
            :text="t('tokens.revealWarning')"
          />
          <div class="d-flex align-center ga-2">
            <code class="token-reveal flex-grow-1">{{ created.token }}</code>
            <v-btn icon="mdi-content-copy" variant="tonal" @click="copyToken" />
          </div>
        </template>
      </div>
      <template #footer="{ close }">
        <v-spacer />
        <template v-if="!created">
          <v-btn variant="text" @click="close">{{ t('common.cancel') }}</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :loading="saving"
            :disabled="!form.name.trim()"
            @click="save"
            >{{ t('tokens.generate') }}</v-btn
          >
        </template>
        <v-btn v-else color="primary" variant="flat" @click="close">{{ t('tokens.done') }}</v-btn>
      </template>
    </SidePanel>

    <v-dialog
      :model-value="!!confirmDelete"
      max-width="420"
      @update:model-value="confirmDelete = null"
    >
      <v-card rounded="lg">
        <v-card-title>{{ t('tokens.deleteTitle') }}</v-card-title>
        <v-card-text>{{ t('tokens.deleteConfirm', { name: confirmDelete?.name }) }}</v-card-text>
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
  font-size: 0.82rem;
}
.token-reveal {
  background: rgba(var(--v-theme-on-surface), 0.06);
  padding: 8px 10px;
  border-radius: 6px;
  word-break: break-all;
}
.flt-search {
  width: 260px;
  max-width: 42vw;
}
.flt-select {
  width: 168px;
}
</style>
