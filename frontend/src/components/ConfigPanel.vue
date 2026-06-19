<script setup>
import { ref, reactive, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import SidePanel from '@/components/SidePanel.vue';
import ProgramBuilder from '@/components/ProgramBuilder.vue';
import { serversApi } from '@/api/client';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  serverId: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue', 'action', 'changed']);
const { t } = useI18n();

const loading = ref(false);
const supported = ref(true);
const files = ref([]);
const confDir = ref(null);
const selected = ref(null);
const contents = reactive({}); // path -> content
const saving = ref(false);

const builderOpen = ref(false);
const builderEditPath = ref(null);

function openCreate() {
  builderEditPath.value = null;
  builderOpen.value = true;
}
function openEditAsProgram() {
  if (!selected.value) return;
  builderEditPath.value = selected.value;
  builderOpen.value = true;
}
async function onProgramSaved() {
  builderEditPath.value = null;
  emit('action', { ok: true, message: t('config.saved') });
  emit('changed');
  // refresh the edited file content
  if (selected.value) { delete contents[selected.value]; await ensureContent(selected.value); }
}

async function loadList() {
  loading.value = true;
  for (const k of Object.keys(contents)) delete contents[k];
  try {
    const res = await serversApi.configList(props.serverId);
    supported.value = res.supported !== false;
    files.value = res.files || [];
    confDir.value = res.confDir;
    selected.value = files.value[0] || null;
    if (selected.value) ensureContent(selected.value);
  } catch (e) {
    emit('action', { ok: false, message: e.response?.data?.error || e.message });
  } finally {
    loading.value = false;
  }
}

async function ensureContent(path) {
  if (path in contents) return;
  contents[path] = '';
  try {
    const res = await serversApi.configFile(props.serverId, path);
    contents[path] = res.content;
  } catch (e) {
    emit('action', { ok: false, message: e.response?.data?.error || e.message });
  }
}

watch(selected, (p) => { if (p) ensureContent(p); });

async function save(applyReload) {
  if (!selected.value) return;
  saving.value = true;
  try {
    await serversApi.configSave(props.serverId, selected.value, contents[selected.value]);
    if (applyReload) await serversApi.daemonReload(props.serverId);
    emit('action', { ok: true, message: t('config.saved') });
    emit('changed');
  } catch (e) {
    emit('action', { ok: false, message: e.response?.data?.error || e.message });
  } finally {
    saving.value = false;
  }
}

async function onProgramCreated(name) {
  emit('action', { ok: true, message: t('config.created', { name }) });
  emit('changed');
  await loadList();
}

function fileName(p) {
  return p.split('/').pop();
}

watch(() => props.modelValue, (open) => { if (open) loadList(); });
</script>

<template>
  <SidePanel
    :model-value="modelValue"
    :title="t('config.open')"
    icon="mdi-file-cog-outline"
    :width="960"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="pa-4">
      <v-alert v-if="!supported" type="warning" variant="tonal" :text="t('config.unsupported')" />

      <template v-else>
        <div class="mb-3 d-flex ga-2">
          <v-btn size="small" variant="tonal" color="primary" prepend-icon="mdi-plus" @click="openCreate">
            {{ t('config.addProgram') }}
          </v-btn>
          <v-btn v-if="selected" size="small" variant="text" prepend-icon="mdi-form-select" @click="openEditAsProgram">
            {{ t('config.editAsProgram') }}
          </v-btn>
        </div>

        <ProgramBuilder v-model="builderOpen" :server-id="serverId" :conf-dir="confDir" :edit-path="builderEditPath" @created="onProgramCreated" @saved="onProgramSaved" @action="emit('action', $event)" />

        <div v-if="loading" class="py-8 text-center"><v-progress-circular indeterminate color="primary" /></div>
        <v-alert v-else-if="!files.length" type="info" variant="tonal" :text="t('config.empty')" />

        <div v-else class="d-flex flex-row ga-3">
          <v-tabs v-model="selected" direction="vertical" color="primary" class="cfg-tabs">
            <v-tab v-for="f in files" :key="f" :value="f" class="cfg-tab">
              <v-icon icon="mdi-file-document-outline" size="18" class="me-2" />
              <div class="text-left min-w-0">
                <div class="cfg-tab-name">{{ fileName(f) }}</div>
                <div class="cfg-tab-path">{{ f }}</div>
              </div>
            </v-tab>
          </v-tabs>

          <v-tabs-window v-model="selected" class="flex-grow-1">
            <v-tabs-window-item v-for="f in files" :key="f" :value="f">
              <textarea v-model="contents[f]" class="cfg-textarea" spellcheck="false" />
            </v-tabs-window-item>
          </v-tabs-window>
        </div>
      </template>
    </div>

    <template #footer>
      <v-btn variant="text" @click="emit('update:modelValue', false)">{{ t('common.close') }}</v-btn>
      <v-spacer />
      <template v-if="supported && files.length">
        <v-btn variant="text" :loading="saving" @click="save(false)">{{ t('config.save') }}</v-btn>
        <v-btn color="primary" variant="flat" :loading="saving" prepend-icon="mdi-reload" @click="save(true)">{{ t('config.reloadAfter') }}</v-btn>
      </template>
    </template>
  </SidePanel>
</template>

<style scoped>
.cfg-tabs {
  flex: 0 0 240px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.08);
  border-radius: 8px;
  max-height: calc(100vh - 230px);
}
.cfg-tab {
  justify-content: flex-start;
  text-transform: none;
  letter-spacing: normal;
  min-height: 52px;
}
.cfg-tab-name {
  font-size: 0.85rem;
  font-weight: 600;
}
.cfg-tab-path {
  font-size: 0.68rem;
  opacity: 0.6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 170px;
}
.cfg-textarea {
  width: 100%;
  height: calc(100vh - 230px);
  background: #0b0e13;
  color: #d7dce3;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 12px 14px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.82rem;
  line-height: 1.5;
  resize: none;
  outline: none;
}
.min-w-0 { min-width: 0; }
</style>
