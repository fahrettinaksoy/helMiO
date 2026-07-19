<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { serversApi } from '@/api/client'
import SidePanel from '@/components/SidePanel.vue'
import { useServersStore } from '@/stores/servers'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  server: { type: Object, default: null } // edit mode when provided
})

const emit = defineEmits(['update:modelValue', 'saved'])

const { t } = useI18n()

const store = useServersStore()
const saving = ref(false)
const error = ref(null)
const copied = ref(null)

// Connection must be tested OK before Add is enabled.
const testState = ref('idle') // idle | testing | ok | fail
const testMsg = ref('')
let baselineSig = ''

const blank = () => ({
  method: 'tcp',
  name: '',
  host: '',
  port: 9001,
  secure: false,
  username: '',
  password: '',
  path: '/RPC2',
  sshHost: '',
  sshPort: 22,
  sshUser: '',
  sshPassword: '',
  privateKey: '',
  target: 'socket',
  socketPath: '/var/run/supervisor.sock',
  targetHost: '127.0.0.1',
  targetPort: 9001,
  // docker
  container: '',
  connection: 'socket',
  dockerSocket: '/var/run/docker.sock',
  dockerHost: '127.0.0.1',
  dockerPort: 2375,
  confPath: '',
  agentUrl: '',
  agentToken: ''
})

const form = reactive(blank())
const isEdit = computed(() => !!props.server)

// Method-specific payload (without the name) — shared by test + save + signature.
function currentPayload() {
  const payloads = {
    tcp: {
      host: form.host,
      port: form.port,
      secure: form.secure,
      username: form.username,
      password: form.password,
      path: form.path
    },
    local: {
      socketPath: form.socketPath,
      username: form.username,
      password: form.password,
      path: form.path
    },
    ssh: {
      sshHost: form.sshHost,
      sshPort: form.sshPort,
      sshUser: form.sshUser,
      sshPassword: form.sshPassword,
      privateKey: form.privateKey,
      target: form.target,
      socketPath: form.socketPath,
      targetHost: form.targetHost,
      targetPort: form.targetPort
    },
    docker: {
      container: form.container,
      connection: form.connection,
      dockerSocket: form.dockerSocket,
      dockerHost: form.dockerHost,
      dockerPort: form.dockerPort,
      confPath: form.confPath
    },
    agent: { agentUrl: form.agentUrl, agentToken: form.agentToken }
  }
  return payloads[form.method]
}

// Signature of just the connection-relevant fields; changing it invalidates the test.
const connSignature = computed(() => JSON.stringify({ m: form.method, ...currentPayload() }))

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return
    error.value = null
    copied.value = null
    testMsg.value = ''
    await store.fetchMethods()
    Object.assign(form, blank(), props.server || {})
    await nextTick()
    baselineSig = connSignature.value
    // Editing an existing server is assumed already-valid until connection fields change.
    testState.value = isEdit.value ? 'ok' : 'idle'
  }
)

// Reset the test whenever connection fields diverge from what was last loaded/tested.
watch(connSignature, (sig) => {
  if (sig !== baselineSig) {
    testState.value = 'idle'
    testMsg.value = ''
  }
})

const methods = computed(() => store.methods)
const selectedMethod = computed(() => methods.value.find((m) => m.id === form.method))

// Example program block for installing the agent under supervisord on the target.
const agentProgramSnippet = computed(
  () => `[program:helmio-agent]
command=node /opt/helmio/agent/src/index.js
directory=/opt/helmio/agent
autostart=true
autorestart=true
environment=AGENT_PORT="8787",AGENT_TOKEN="${form.agentToken || '<token>'}",SUPERVISOR_SOCKET="/var/run/supervisor.sock"`
)

const tokenGenCmd = 'openssl rand -hex 24'

function close() {
  emit('update:modelValue', false)
}

async function copy(text, key) {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = key
    setTimeout(() => {
      if (copied.value === key) copied.value = null
    }, 1500)
  } catch {
    /* clipboard unavailable */
  }
}

// Generate a random hex token in the browser (no server round-trip).
function generateToken() {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  form.agentToken = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function test() {
  testState.value = 'testing'
  testMsg.value = ''
  try {
    const data = {
      method: form.method,
      name: form.name || 'test',
      ...currentPayload(),
      ...(isEdit.value ? { id: props.server.id } : {})
    }
    const res = await serversApi.testConnection(data)
    if (res.ok) {
      testState.value = 'ok'
      baselineSig = connSignature.value
      const sup = res.supervisor
      if (sup?.reachable) {
        testMsg.value = t('form.testOkSupervisor', {
          version: sup.version || t('form.supervisorRunning')
        })
      } else if (res.channel === 'shell') {
        testMsg.value = t('form.testOkShell')
      } else if (res.channel === 'agent') {
        testMsg.value = t('form.testOkAgent')
      } else {
        testMsg.value = t('form.testOk')
      }
    } else {
      testState.value = 'fail'
      testMsg.value = res.error || t('form.testFail')
    }
  } catch (e) {
    testState.value = 'fail'
    testMsg.value = e.response?.data?.error || e.message
  }
}

async function save() {
  // Validate the connection first; only save if it passes.
  if (testState.value !== 'ok') {
    await test()
    if (testState.value !== 'ok') return // test failed — error already shown
  }
  saving.value = true
  error.value = null
  try {
    const data = { method: form.method, name: form.name, ...currentPayload() }
    if (isEdit.value) await store.update(props.server.id, data)
    else await store.create(data)
    emit('saved')
    close()
  } catch (e) {
    error.value = e.response?.data?.error || e.message
    const details = e.response?.data?.details?.fieldErrors
    if (details) {
      error.value += `: ${Object.entries(details)
        .map(([k, v]) => `${k} (${v.join(', ')})`)
        .join('; ')}`
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SidePanel
    :model-value="modelValue"
    :title="isEdit ? t('form.editTitle') : t('form.addTitle')"
    :icon="isEdit ? 'mdi-pencil' : 'mdi-server-plus'"
    :width="560"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <!-- autocomplete kapalı: gizli bir alan + tüm inputlarda autocomplete="off/new-password" -->
    <form autocomplete="off" @submit.prevent="save">
      <input type="text" autocomplete="off" style="display: none" aria-hidden="true" />

      <div class="pa-4">
        <v-alert v-if="error" type="error" variant="tonal" class="mb-4" :text="error" />

        <v-text-field
          v-model="form.name"
          :label="t('form.name')"
          prepend-inner-icon="mdi-tag"
          variant="outlined"
          density="comfortable"
          autocomplete="off"
          class="mb-2"
        />

        <v-select
          v-model="form.method"
          :items="methods"
          item-title="label"
          item-value="id"
          :label="t('form.method')"
          prepend-inner-icon="mdi-transit-connection-variant"
          variant="outlined"
          density="comfortable"
          class="mb-2"
        >
          <template #item="{ props: itemProps, item }">
            <v-list-item v-bind="itemProps" :disabled="item.raw.available === false">
              <template #subtitle>{{ item.raw.description }}</template>
              <template #append>
                <v-chip v-if="item.raw.recommended" size="x-small" color="success" variant="flat">{{
                  t('form.recommended')
                }}</v-chip>
                <v-chip v-else-if="item.raw.available === false" size="x-small" variant="tonal">{{
                  t('form.comingSoon')
                }}</v-chip>
              </template>
            </v-list-item>
          </template>
        </v-select>

        <v-alert
          v-if="selectedMethod?.recommended"
          type="success"
          variant="tonal"
          density="compact"
          class="mb-4"
          :text="t('form.recommendedHint')"
        />

        <!-- TCP fields -->
        <template v-if="form.method === 'tcp'">
          <div class="d-flex ga-3">
            <v-text-field
              v-model="form.host"
              :label="t('form.hostIp')"
              variant="outlined"
              density="comfortable"
              autocomplete="off"
              class="flex-grow-1"
            />
            <v-text-field
              v-model.number="form.port"
              :label="t('form.port')"
              type="number"
              variant="outlined"
              density="comfortable"
              autocomplete="off"
              style="max-width: 130px"
            />
          </div>
          <div class="d-flex ga-3">
            <v-text-field
              v-model="form.username"
              :label="t('form.username')"
              variant="outlined"
              density="comfortable"
              autocomplete="off"
              class="flex-grow-1"
            />
            <v-text-field
              v-model="form.password"
              :label="t('form.password')"
              type="password"
              variant="outlined"
              density="comfortable"
              autocomplete="new-password"
              class="flex-grow-1"
            />
          </div>
          <div class="d-flex ga-3 align-center">
            <v-text-field
              v-model="form.path"
              :label="t('form.rpcPath')"
              variant="outlined"
              density="comfortable"
              autocomplete="off"
              class="flex-grow-1"
            />
            <v-switch v-model="form.secure" :label="t('form.https')" color="primary" hide-details />
          </div>
        </template>

        <!-- Local unix socket fields -->
        <template v-else-if="form.method === 'local'">
          <v-text-field
            v-model="form.socketPath"
            :label="t('form.socketPath')"
            placeholder="/var/run/supervisor.sock"
            prepend-inner-icon="mdi-power-socket"
            :hint="t('form.localHint')"
            persistent-hint
            variant="outlined"
            density="comfortable"
            autocomplete="off"
            class="mb-2"
          />
          <div class="d-flex ga-3">
            <v-text-field
              v-model="form.username"
              :label="t('form.username')"
              variant="outlined"
              density="comfortable"
              autocomplete="off"
              class="flex-grow-1"
            />
            <v-text-field
              v-model="form.password"
              :label="t('form.password')"
              type="password"
              variant="outlined"
              density="comfortable"
              autocomplete="new-password"
              class="flex-grow-1"
            />
          </div>
        </template>

        <!-- SSH fields -->
        <template v-else-if="form.method === 'ssh'">
          <div class="d-flex ga-3">
            <v-text-field
              v-model="form.sshHost"
              :label="t('form.sshHost')"
              variant="outlined"
              density="comfortable"
              autocomplete="off"
              class="flex-grow-1"
            />
            <v-text-field
              v-model.number="form.sshPort"
              :label="t('form.sshPort')"
              type="number"
              variant="outlined"
              density="comfortable"
              autocomplete="off"
              style="max-width: 130px"
            />
          </div>
          <v-text-field
            v-model="form.sshUser"
            :label="t('form.sshUser')"
            variant="outlined"
            density="comfortable"
            autocomplete="off"
          />
          <v-text-field
            v-model="form.sshPassword"
            :label="t('form.sshPassword')"
            type="password"
            variant="outlined"
            density="comfortable"
            autocomplete="new-password"
          />
          <v-textarea
            v-model="form.privateKey"
            :label="t('form.privateKey')"
            variant="outlined"
            density="comfortable"
            autocomplete="off"
            rows="2"
          />

          <v-btn-toggle v-model="form.target" mandatory variant="outlined" divided class="mb-4">
            <v-btn value="socket" prepend-icon="mdi-power-socket"
              ><span>{{ t('form.unixSocket') }}</span></v-btn
            >
            <v-btn value="tcp" prepend-icon="mdi-lan-connect"
              ><span>{{ t('form.localhostTcp') }}</span></v-btn
            >
          </v-btn-toggle>

          <v-text-field
            v-if="form.target === 'socket'"
            v-model="form.socketPath"
            :label="t('form.socketPath')"
            :hint="t('form.sshSocketHint')"
            persistent-hint
            variant="outlined"
            density="comfortable"
            autocomplete="off"
          />
          <div v-else class="d-flex ga-3">
            <v-text-field
              v-model="form.targetHost"
              :label="t('form.targetHost')"
              variant="outlined"
              density="comfortable"
              autocomplete="off"
              class="flex-grow-1"
            />
            <v-text-field
              v-model.number="form.targetPort"
              :label="t('form.port')"
              type="number"
              variant="outlined"
              density="comfortable"
              autocomplete="off"
              style="max-width: 130px"
            />
          </div>
        </template>

        <!-- Docker fields -->
        <template v-else-if="form.method === 'docker'">
          <v-alert type="info" variant="tonal" density="comfortable" class="mb-4">
            <div class="text-body-2" v-html="t('form.dockerInfo')" />
          </v-alert>

          <v-text-field
            v-model="form.container"
            :label="t('form.container')"
            placeholder="my-app"
            prepend-inner-icon="mdi-docker"
            variant="outlined"
            density="comfortable"
            autocomplete="off"
            class="mb-2"
          />

          <v-btn-toggle v-model="form.connection" mandatory variant="outlined" divided class="mb-4">
            <v-btn value="socket" prepend-icon="mdi-power-socket"
              ><span>{{ t('form.localSocket') }}</span></v-btn
            >
            <v-btn value="tcp" prepend-icon="mdi-lan-connect"
              ><span>{{ t('form.tcpRemote') }}</span></v-btn
            >
          </v-btn-toggle>

          <v-text-field
            v-if="form.connection === 'socket'"
            v-model="form.dockerSocket"
            :label="t('form.dockerSocketPath')"
            :hint="t('form.dockerSocketHint')"
            persistent-hint
            variant="outlined"
            density="comfortable"
            autocomplete="off"
          />
          <div v-else class="d-flex ga-3">
            <v-text-field
              v-model="form.dockerHost"
              :label="t('form.dockerHost')"
              variant="outlined"
              density="comfortable"
              autocomplete="off"
              class="flex-grow-1"
            />
            <v-text-field
              v-model.number="form.dockerPort"
              :label="t('form.port')"
              type="number"
              variant="outlined"
              density="comfortable"
              autocomplete="off"
              style="max-width: 130px"
            />
          </div>

          <v-text-field
            v-model="form.confPath"
            :label="t('form.confPath')"
            placeholder="/etc/supervisor/supervisord.conf"
            :hint="t('form.confHint')"
            persistent-hint
            variant="outlined"
            density="comfortable"
            autocomplete="off"
            class="mt-3"
          />
        </template>

        <!-- Agent fields + setup guide -->
        <template v-else-if="form.method === 'agent'">
          <v-alert type="info" variant="tonal" density="comfortable" class="mb-4">
            <div class="text-body-2" v-html="t('form.agentInfo')" />
          </v-alert>

          <v-expansion-panels variant="accordion" class="mb-4">
            <v-expansion-panel>
              <v-expansion-panel-title>
                <v-icon icon="mdi-help-circle-outline" class="me-2" /> {{ t('form.agentHowTitle') }}
              </v-expansion-panel-title>
              <v-expansion-panel-text>
                <ol class="text-body-2 ps-4 d-flex flex-column ga-2">
                  <li v-html="t('form.agentStep1')" />
                  <li>
                    <span v-html="t('form.agentStep2')" />
                    <div class="d-flex align-center ga-1 mt-1">
                      <code class="flex-grow-1">{{ tokenGenCmd }}</code>
                      <v-btn
                        size="x-small"
                        variant="text"
                        :icon="copied === 'cmd' ? 'mdi-check' : 'mdi-content-copy'"
                        @click="copy(tokenGenCmd, 'cmd')"
                      />
                    </div>
                  </li>
                  <li>
                    <span v-html="t('form.agentStep3')" />
                    <div class="code-block mt-1">
                      <v-theme-provider theme="dark">
                        <pre>{{ agentProgramSnippet }}</pre>
                      </v-theme-provider>
                      <v-btn
                        size="x-small"
                        variant="text"
                        class="copy-abs"
                        :icon="copied === 'prog' ? 'mdi-check' : 'mdi-content-copy'"
                        @click="copy(agentProgramSnippet, 'prog')"
                      />
                    </div>
                  </li>
                  <li v-html="t('form.agentStep4')" />
                  <li v-html="t('form.agentStep5')" />
                </ol>
              </v-expansion-panel-text>
            </v-expansion-panel>
          </v-expansion-panels>

          <v-text-field
            v-model="form.agentUrl"
            :label="t('form.agentUrl')"
            placeholder="http://sunucu-ip:8787"
            prepend-inner-icon="mdi-link-variant"
            :hint="t('form.agentUrlHint')"
            persistent-hint
            variant="outlined"
            density="comfortable"
            autocomplete="off"
            class="mb-2"
          />
          <v-text-field
            v-model="form.agentToken"
            :label="t('form.agentToken')"
            type="password"
            prepend-inner-icon="mdi-key-variant"
            :hint="t('form.agentTokenHint')"
            persistent-hint
            variant="outlined"
            density="comfortable"
            autocomplete="new-password"
          >
            <template #append-inner>
              <v-tooltip :text="t('form.copy')" location="top">
                <template #activator="{ props: tip }">
                  <v-btn
                    v-bind="tip"
                    size="x-small"
                    variant="text"
                    :icon="copied === 'token' ? 'mdi-check' : 'mdi-content-copy'"
                    :disabled="!form.agentToken"
                    @click="copy(form.agentToken, 'token')"
                  />
                </template>
              </v-tooltip>
            </template>
          </v-text-field>
          <v-btn
            size="small"
            variant="tonal"
            prepend-icon="mdi-dice-5"
            class="mt-2"
            @click="generateToken"
          >
            {{ t('form.generateToken') }}
          </v-btn>
        </template>

        <!-- Connection test (required before Add) -->
        <v-divider class="my-4" />
        <div class="d-flex align-center ga-3">
          <v-btn
            variant="tonal"
            :color="testState === 'ok' ? 'success' : testState === 'fail' ? 'error' : 'primary'"
            :loading="testState === 'testing'"
            :prepend-icon="testState === 'ok' ? 'mdi-check' : 'mdi-connection'"
            @click="test"
          >
            {{ testState === 'ok' ? t('form.connectionVerified') : t('form.testConnection') }}
          </v-btn>
          <span class="text-caption text-medium-emphasis">
            {{ t('form.testHint') }}
          </span>
        </div>
        <v-alert
          v-if="testMsg"
          :type="testState === 'ok' ? 'success' : testState === 'fail' ? 'error' : 'info'"
          variant="tonal"
          density="comfortable"
          class="mt-3"
          :text="testMsg"
        />
      </div>
    </form>

    <template #footer>
      <v-spacer />
      <v-btn variant="text" @click="close">{{ t('common.cancel') }}</v-btn>
      <v-btn
        color="primary"
        variant="flat"
        :loading="saving || testState === 'testing'"
        @click="save"
      >
        {{ isEdit ? t('common.save') : t('common.add') }}
      </v-btn>
    </template>
  </SidePanel>
</template>

<style scoped>
/* Field vertical rhythm is handled globally in SidePanel (all drawer forms). */

/* Inline code run + terminal-style snippet block: no Vuetify equivalent. */
code {
  background: rgba(var(--v-theme-on-surface), 0.08);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 0.82em;
}
.code-block {
  position: relative;
}
/* Terminal-style snippet: dark with light text in both themes */
.code-block pre {
  background: rgb(var(--v-theme-background));
  color: rgb(var(--v-theme-on-background));
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 0.78em;
  overflow-x: auto;
  white-space: pre;
  margin: 0;
}
.copy-abs {
  position: absolute;
  top: 4px;
  right: 4px;
  color: #d7dce3;
}
</style>
