<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { serversApi } from '@/api/client'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  serverId: { type: String, default: '' },
  confDir: { type: String, default: null },
  editPath: { type: String, default: null } // set → edit an existing .conf file
})
const emit = defineEmits(['update:modelValue', 'created', 'saved', 'action'])

const isEdit = computed(() => !!props.editPath)
const { t } = useI18n()

function blank() {
  return {
    name: '',
    command: '',
    directory: '',
    user: '',
    numprocs: 1,
    priority: 999,
    autostart: true,
    autorestart: 'unexpected',
    startsecs: 1,
    startretries: 3,
    stopsignal: 'TERM',
    stopwaitsecs: 10,
    redirect_stderr: false,
    stdout_logfile: '',
    stderr_logfile: '',
    environment: []
  }
}
const form = reactive(blank())
const preview = ref('')
const saving = ref(false)
const error = ref('')

const AUTORESTART = ['true', 'false', 'unexpected']
const SIGNALS = ['TERM', 'INT', 'HUP', 'QUIT', 'KILL', 'USR1', 'USR2']

// Templates pre-fill sensible field sets for common workloads.
const TEMPLATES = [
  { id: 'generic', icon: 'mdi-application-cog', apply: () => ({}) },
  {
    id: 'python',
    icon: 'mdi-language-python',
    apply: () => ({
      command: 'python3 /srv/app/main.py',
      directory: '/srv/app',
      autorestart: 'true',
      startsecs: 5
    })
  },
  {
    id: 'node',
    icon: 'mdi-nodejs',
    apply: () => ({
      command: 'node /srv/app/index.js',
      directory: '/srv/app',
      autorestart: 'true',
      startsecs: 3,
      environment: [{ key: 'NODE_ENV', value: 'production' }]
    })
  },
  {
    id: 'gunicorn',
    icon: 'mdi-language-python',
    apply: () => ({
      command: 'gunicorn -w 4 -b 127.0.0.1:8000 app:app',
      directory: '/srv/app',
      autorestart: 'true',
      stopsignal: 'TERM',
      startsecs: 5
    })
  },
  {
    id: 'worker',
    icon: 'mdi-cog-sync',
    apply: () => ({
      command: 'php artisan queue:work --sleep=3 --tries=3',
      directory: '/srv/app',
      numprocs: 4,
      autorestart: 'true',
      stopsignal: 'TERM',
      stopwaitsecs: 3600
    })
  }
]

function applyTemplate(tpl) {
  Object.assign(form, blank(), tpl.apply())
}

function addEnv() {
  form.environment.push({ key: '', value: '' })
}
function removeEnv(i) {
  form.environment.splice(i, 1)
}

// Build the definition payload sent to the backend.
function payload() {
  return {
    name: form.name,
    command: form.command,
    directory: form.directory || undefined,
    user: form.user || undefined,
    numprocs: Number(form.numprocs) || 1,
    priority: Number(form.priority) || undefined,
    autostart: form.autostart,
    autorestart: form.autorestart,
    startsecs: Number(form.startsecs),
    startretries: Number(form.startretries),
    stopsignal: form.stopsignal,
    stopwaitsecs: Number(form.stopwaitsecs),
    redirect_stderr: form.redirect_stderr,
    stdout_logfile: form.stdout_logfile || undefined,
    stderr_logfile: form.stderr_logfile || undefined,
    environment: form.environment.filter((e) => e.key),
    confDir: props.confDir || undefined
  }
}

const canCreate = computed(() => form.name.trim() && form.command.trim())

let previewTimer = null
async function refreshPreview() {
  if (!canCreate.value) {
    preview.value = ''
    return
  }
  try {
    const res = await serversApi.configProgramPreview(props.serverId, payload())
    preview.value = res.block
    error.value = ''
  } catch (e) {
    error.value = e.response?.data?.error || e.message
  }
}
watch(
  form,
  () => {
    clearTimeout(previewTimer)
    previewTimer = setTimeout(refreshPreview, 350)
  },
  { deep: true }
)

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return
    Object.assign(form, blank())
    preview.value = ''
    error.value = ''
    if (props.editPath) {
      try {
        const { def } = await serversApi.configProgramParse(props.serverId, props.editPath)
        Object.assign(form, blank(), def, { environment: def.environment || [] })
      } catch (e) {
        error.value = e.response?.data?.error || e.message
      }
    }
  }
)

async function create() {
  saving.value = true
  error.value = ''
  try {
    if (isEdit.value) {
      // Rewrite the existing file with the regenerated block, then apply.
      const { block } = await serversApi.configProgramPreview(props.serverId, payload())
      await serversApi.configSave(props.serverId, props.editPath, block)
      await serversApi.daemonReload(props.serverId)
      emit('saved', form.name)
    } else {
      await serversApi.configAddProgram(props.serverId, payload())
      emit('created', form.name)
    }
    emit('update:modelValue', false)
  } catch (e) {
    error.value = e.response?.data?.error || e.message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    max-width="860"
    scrollable
    @update:model-value="emit('update:modelValue', $event)"
  >
    <v-card rounded="lg">
      <v-card-title class="d-flex align-center">
        <v-icon :icon="isEdit ? 'mdi-pencil-box' : 'mdi-plus-box'" class="me-2" />{{
          isEdit ? t('program.editTitle') : t('program.title')
        }}
      </v-card-title>
      <v-card-text>
        <v-alert
          v-if="error"
          type="error"
          variant="tonal"
          density="compact"
          class="mb-3"
          :text="error"
        />

        <!-- Templates -->
        <div class="text-caption text-medium-emphasis mb-1">{{ t('program.templates') }}</div>
        <div class="d-flex ga-2 flex-wrap mb-4">
          <v-chip
            v-for="tpl in TEMPLATES"
            :key="tpl.id"
            :prepend-icon="tpl.icon"
            variant="tonal"
            link
            @click="applyTemplate(tpl)"
          >
            {{ t(`program.tpl_${tpl.id}`) }}
          </v-chip>
        </div>

        <v-row>
          <!-- Form -->
          <v-col cols="12" md="7">
            <div class="text-overline text-medium-emphasis">{{ t('program.secBasic') }}</div>
            <div class="d-flex ga-2">
              <v-text-field
                v-model="form.name"
                :label="t('config.programName')"
                :disabled="isEdit"
                density="compact"
                variant="outlined"
                class="mb-2"
                style="max-width: 220px"
                autocomplete="off"
              />
              <v-text-field
                v-model.number="form.numprocs"
                :label="t('program.numprocs')"
                type="number"
                min="1"
                density="compact"
                variant="outlined"
                class="mb-2"
              />
            </div>
            <v-text-field
              v-model="form.command"
              :label="t('config.command')"
              density="compact"
              variant="outlined"
              class="mb-2"
              autocomplete="off"
            />
            <div class="d-flex ga-2">
              <v-text-field
                v-model="form.directory"
                :label="t('program.directory')"
                density="compact"
                variant="outlined"
                class="mb-2 flex-grow-1"
                autocomplete="off"
              />
              <v-text-field
                v-model="form.user"
                :label="t('program.user')"
                density="compact"
                variant="outlined"
                class="mb-2"
                style="max-width: 150px"
                autocomplete="off"
              />
            </div>

            <div class="text-overline text-medium-emphasis mt-2">{{ t('program.secRestart') }}</div>
            <div class="d-flex ga-2 align-center">
              <v-switch
                v-model="form.autostart"
                :label="t('program.autostart')"
                color="primary"
                density="compact"
                hide-details
                inset
                class="flex-grow-0"
              />
              <v-select
                v-model="form.autorestart"
                :items="AUTORESTART"
                :label="t('program.autorestart')"
                density="compact"
                variant="outlined"
                hide-details
                class="mb-2"
              />
            </div>
            <div class="d-flex ga-2 mt-2">
              <v-text-field
                v-model.number="form.startsecs"
                :label="t('program.startsecs')"
                type="number"
                suffix="s"
                density="compact"
                variant="outlined"
                class="mb-2"
              />
              <v-text-field
                v-model.number="form.startretries"
                :label="t('program.startretries')"
                type="number"
                density="compact"
                variant="outlined"
                class="mb-2"
              />
              <v-text-field
                v-model.number="form.priority"
                :label="t('program.priority')"
                type="number"
                density="compact"
                variant="outlined"
                class="mb-2"
              />
            </div>

            <div class="text-overline text-medium-emphasis mt-2">{{ t('program.secStop') }}</div>
            <div class="d-flex ga-2">
              <v-select
                v-model="form.stopsignal"
                :items="SIGNALS"
                :label="t('program.stopsignal')"
                density="compact"
                variant="outlined"
                class="mb-2"
              />
              <v-text-field
                v-model.number="form.stopwaitsecs"
                :label="t('program.stopwaitsecs')"
                type="number"
                suffix="s"
                density="compact"
                variant="outlined"
                class="mb-2"
              />
            </div>

            <div class="text-overline text-medium-emphasis mt-2">{{ t('program.secLogging') }}</div>
            <v-switch
              v-model="form.redirect_stderr"
              :label="t('program.redirectStderr')"
              color="primary"
              density="compact"
              hide-details
              inset
              class="mb-2"
            />
            <v-text-field
              v-model="form.stdout_logfile"
              :label="t('program.stdoutLog')"
              :placeholder="`/var/log/${form.name || 'name'}.log`"
              density="compact"
              variant="outlined"
              class="mb-2"
              autocomplete="off"
            />
            <v-text-field
              v-if="!form.redirect_stderr"
              v-model="form.stderr_logfile"
              :label="t('program.stderrLog')"
              :placeholder="`/var/log/${form.name || 'name'}.err`"
              density="compact"
              variant="outlined"
              class="mb-2"
              autocomplete="off"
            />

            <div class="text-overline text-medium-emphasis mt-2 d-flex align-center">
              {{ t('program.secEnv') }}
              <v-btn size="x-small" variant="text" icon="mdi-plus" @click="addEnv" />
            </div>
            <div v-for="(e, i) in form.environment" :key="i" class="d-flex ga-2 align-center">
              <v-text-field
                v-model="e.key"
                label="KEY"
                density="compact"
                variant="outlined"
                hide-details
                class="mb-2"
                autocomplete="off"
              />
              <v-text-field
                v-model="e.value"
                label="value"
                density="compact"
                variant="outlined"
                hide-details
                class="mb-2"
                autocomplete="off"
              />
              <v-btn size="x-small" variant="text" icon="mdi-close" @click="removeEnv(i)" />
            </div>
          </v-col>

          <!-- Live preview -->
          <v-col cols="12" md="5">
            <div class="text-overline text-medium-emphasis">{{ t('program.preview') }}</div>
            <v-theme-provider theme="dark" class="prog-preview-sticky">
              <pre class="prog-preview">{{ preview || t('program.previewEmpty') }}</pre>
            </v-theme-provider>
          </v-col>
        </v-row>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">{{
          t('common.cancel')
        }}</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          :loading="saving"
          :disabled="!canCreate"
          prepend-icon="mdi-content-save-plus"
          @click="create"
        >
          {{ isEdit ? t('program.saveApply') : t('program.createApply') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.prog-preview-sticky {
  display: block;
  position: sticky;
  top: 0;
}
.prog-preview {
  background: rgb(var(--v-theme-background));
  color: rgb(var(--v-theme-on-background));
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 12px 14px;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.78rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  min-height: 200px;
  margin: 0;
}
</style>
