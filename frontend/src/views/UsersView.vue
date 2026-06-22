<script setup>
import { ref, onMounted, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { usersApi } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import PageShell from '@/components/PageShell.vue';
import DataPanel from '@/components/DataPanel.vue';
import SidePanel from '@/components/SidePanel.vue';

const { t } = useI18n();
const auth = useAuthStore();

const users = ref([]);
const loading = ref(false);
const error = ref('');
const snackbar = ref({ show: false, color: 'success', text: '' });

const dialog = ref(false);
const editing = ref(null); // null = create
const form = ref({ username: '', displayName: '', role: 'viewer', password: '', disabled: false });
const saving = ref(false);
const formError = ref('');
const confirmDelete = ref(null);

const ROLES = ['admin', 'operator', 'viewer'];
const roleColor = (r) => ({ admin: 'error', operator: 'warning', viewer: 'info' }[r] || 'default');

// ---- filters ----
const search = ref('');
const roleFilter = ref(null);
const statusFilter = ref(null);
const roleOptions = computed(() => [{ value: null, title: t('common.allRoles') }, ...ROLES.map((r) => ({ value: r, title: t(`roles.${r}`) }))]);
const statusOptions = computed(() => [
  { value: null, title: t('common.allStatuses') },
  { value: 'active', title: t('common.active') },
  { value: 'disabled', title: t('common.disabled') },
]);
const filteredUsers = computed(() => {
  const term = search.value.trim().toLowerCase();
  return users.value.filter((u) => {
    if (roleFilter.value && u.role !== roleFilter.value) return false;
    if (statusFilter.value === 'active' && u.disabled) return false;
    if (statusFilter.value === 'disabled' && !u.disabled) return false;
    if (term && !`${u.displayName || ''} ${u.username}`.toLowerCase().includes(term)) return false;
    return true;
  });
});

const headers = computed(() => [
  { title: t('users.colUser'), key: 'username' },
  { title: t('users.colRole'), key: 'role', width: 140 },
  { title: t('users.colStatus'), key: 'disabled', width: 120 },
  { title: t('users.colLastLogin'), key: 'lastLoginAt', width: 200 },
  { title: '', key: 'actions', width: 120, align: 'end', sortable: false },
]);

function notify(text, color = 'success') {
  snackbar.value = { show: true, color, text };
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    users.value = await usersApi.list();
  } catch (e) {
    error.value = e.response?.data?.error || e.message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function openCreate() {
  editing.value = null;
  form.value = { username: '', displayName: '', role: 'viewer', password: '', disabled: false };
  formError.value = '';
  dialog.value = true;
}
function openEdit(u) {
  editing.value = u;
  form.value = { username: u.username, displayName: u.displayName, role: u.role, password: '', disabled: !!u.disabled };
  formError.value = '';
  dialog.value = true;
}

async function save() {
  saving.value = true;
  formError.value = '';
  try {
    if (editing.value) {
      const patch = { displayName: form.value.displayName, role: form.value.role, disabled: form.value.disabled };
      if (form.value.password) patch.password = form.value.password;
      await usersApi.update(editing.value.id, patch);
      notify(t('users.updated', { name: form.value.username }));
    } else {
      await usersApi.create({
        username: form.value.username,
        displayName: form.value.displayName,
        role: form.value.role,
        password: form.value.password,
      });
      notify(t('users.created', { name: form.value.username }));
    }
    dialog.value = false;
    await load();
  } catch (e) {
    formError.value = e.response?.data?.error || e.message;
  } finally {
    saving.value = false;
  }
}

async function doDelete() {
  const u = confirmDelete.value;
  confirmDelete.value = null;
  try {
    await usersApi.remove(u.id);
    notify(t('users.deleted', { name: u.username }), 'info');
    await load();
  } catch (e) {
    notify(e.response?.data?.error || e.message, 'error');
  }
}

const isSelf = (u) => u.id === auth.user?.id;
</script>

<template>
  <PageShell :title="t('users.title')" :subtitle="t('users.subtitle')" icon="mdi-account-group">
    <template #hero-actions>
      <v-btn color="white" variant="tonal" prepend-icon="mdi-account-plus" @click="openCreate">{{ t('users.addUser') }}</v-btn>
    </template>

    <v-alert v-if="error" type="error" variant="tonal" class="mb-4" :text="error" />

    <DataPanel>
      <template #filters>
        <v-text-field
          v-model="search"
          :placeholder="t('common.search')"
          prepend-inner-icon="mdi-magnify"
          variant="solo-filled" density="compact" flat hide-details clearable rounded="lg"
          class="flt-search"
        />
        <v-select
          v-model="roleFilter" :items="roleOptions"
          variant="solo-filled" density="compact" flat hide-details rounded="lg"
          class="flt-select"
        />
        <v-select
          v-model="statusFilter" :items="statusOptions"
          variant="solo-filled" density="compact" flat hide-details rounded="lg"
          class="flt-select"
        />
      </template>
      <template #default="{ height }">
      <v-data-table
        :headers="headers"
        :items="filteredUsers"
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
        <template #[`item.username`]="{ item }">
          <div class="d-flex align-center ga-2">
            <v-avatar :color="roleColor(item.role)" variant="tonal" size="32">
              <span class="text-caption font-weight-bold">{{ (item.displayName || item.username).slice(0, 2).toUpperCase() }}</span>
            </v-avatar>
            <div>
              <div class="font-weight-medium">{{ item.displayName || item.username }}
                <v-chip v-if="isSelf(item)" size="x-small" variant="tonal" color="primary" label class="ms-1">{{ t('users.you') }}</v-chip>
              </div>
              <div class="text-caption text-medium-emphasis">@{{ item.username }}</div>
            </div>
          </div>
        </template>
        <template #[`item.role`]="{ item }">
          <v-chip :color="roleColor(item.role)" size="small" variant="tonal" label>{{ t(`roles.${item.role}`) }}</v-chip>
        </template>
        <template #[`item.disabled`]="{ item }">
          <v-chip :color="item.disabled ? 'error' : 'success'" size="small" variant="tonal" label>
            {{ item.disabled ? t('users.disabled') : t('users.active') }}
          </v-chip>
        </template>
        <template #[`item.lastLoginAt`]="{ item }">
          <span class="text-medium-emphasis text-caption">{{ item.lastLoginAt ? new Date(item.lastLoginAt).toLocaleString() : '—' }}</span>
        </template>
        <template #[`item.actions`]="{ item }">
          <div class="d-flex justify-end ga-1">
            <v-tooltip :text="t('common.edit')" location="top">
              <template #activator="{ props: tip }"><v-btn v-bind="tip" size="small" icon="mdi-pencil" variant="text" @click="openEdit(item)" /></template>
            </v-tooltip>
            <v-tooltip :text="t('common.delete')" location="top">
              <template #activator="{ props: tip }">
                <v-btn v-bind="tip" size="small" icon="mdi-delete" variant="text" color="error" :disabled="isSelf(item)" @click="confirmDelete = item" />
              </template>
            </v-tooltip>
          </div>
        </template>
        <template #no-data>
          <div class="py-8 text-center text-medium-emphasis">{{ t('common.noMatch') }}</div>
        </template>
      </v-data-table>
      </template>
    </DataPanel>

    <!-- Create / edit form (slide-over) -->
    <SidePanel
      v-model="dialog"
      :title="editing ? t('users.editTitle') : t('users.addUser')"
      :icon="editing ? 'mdi-account-edit' : 'mdi-account-plus'"
      :width="480"
    >
      <div class="pa-4">
        <v-alert v-if="formError" type="error" variant="tonal" density="compact" class="mb-3" :text="formError" />
        <v-text-field
          v-model="form.username"
          :label="t('auth.username')"
          variant="outlined"
          density="comfortable"
          :disabled="!!editing"
          class="mb-2"
        />
        <v-text-field v-model="form.displayName" :label="t('auth.displayName')" variant="outlined" density="comfortable" class="mb-2" />
        <v-select v-model="form.role" :items="ROLES" :label="t('users.colRole')" variant="outlined" density="comfortable" class="mb-2">
          <template #selection="{ item }">{{ t(`roles.${item.value}`) }}</template>
          <template #item="{ item, props: p }">
            <v-list-item v-bind="p" :title="t(`roles.${item.value}`)" :subtitle="t(`roles.${item.value}_desc`)" />
          </template>
        </v-select>
        <v-text-field
          v-model="form.password"
          :label="editing ? t('users.newPasswordOptional') : t('auth.password')"
          type="password"
          variant="outlined"
          density="comfortable"
          autocomplete="new-password"
          class="mb-2"
        />
        <v-switch v-if="editing" v-model="form.disabled" :label="t('users.disableAccount')" color="error" density="compact" hide-details inset />
      </div>
      <template #footer="{ close }">
        <v-spacer />
        <v-btn variant="text" @click="close">{{ t('common.cancel') }}</v-btn>
        <v-btn color="primary" variant="flat" :loading="saving" @click="save">{{ t('common.save') }}</v-btn>
      </template>
    </SidePanel>

    <v-dialog :model-value="!!confirmDelete" max-width="420" @update:model-value="confirmDelete = null">
      <v-card rounded="lg">
        <v-card-title>{{ t('users.deleteTitle') }}</v-card-title>
        <v-card-text>{{ t('users.deleteConfirm', { name: confirmDelete?.username }) }}</v-card-text>
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
.flt-search { width: 260px; max-width: 42vw; }
.flt-select { width: 168px; }
</style>
