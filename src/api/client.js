// Backend istemcisi — eski axios/REST katmanının yerini alan Tauri IPC katmanı.
//
// Her API nesnesi ve metodu, eski imzasını birebir korur; içlerinde `ipc(cmd)`
// Rust komutlarını çağırır. Komut isimleri sonraki fazlarda Rust tarafında
// uygulanacak (Faz 2-6). Uygulanmayan komutlar reddeder → ekranlar boş/uyarı
// gösterir, uygulama çökmez.
//
// AUTH KALDIRILDI (tek-kullanıcı masaüstü): authApi/usersApi/apiTokensApi ağa
// gitmez; yerel tek-yönetici stub'ıdır. Bu görünümler Faz 8'de UI'dan tümüyle
// kaldırılacak.

import { ipc } from './ipc'

// Tek kullanıcı = tüm yetkiler. RBAC izin listesi (eski backend ile aynı adlar)
// böylece `auth.can(...)` her yerde true döner.
const ALL_PERMISSIONS = [
  'server:read',
  'process:control',
  'daemon:reload',
  'daemon:restart',
  'server:manage',
  'config:write',
  'user:manage',
  'audit:read',
  'notify:manage'
]

export const LOCAL_USER = {
  id: 'local',
  username: 'local',
  displayName: 'Yerel Kullanıcı',
  role: 'admin',
  permissions: ALL_PERMISSIONS
}

// --- Auth: yerel stub (ağ yok) ---------------------------------------------
export const authApi = {
  status: () => Promise.resolve({ needsSetup: false }),
  setup: () => Promise.resolve({ token: 'local', user: LOCAL_USER }),
  login: () => Promise.resolve({ token: 'local', user: LOCAL_USER }),
  me: () => Promise.resolve({ user: LOCAL_USER }),
  logout: () => Promise.resolve({ ok: true }),
  changePassword: () => Promise.resolve({ ok: true })
}

// Kullanıcı/token yönetimi tek-kullanıcıda anlamsız — stub (Faz 8'de kalkar).
export const usersApi = {
  list: () => Promise.resolve([LOCAL_USER]),
  create: () => Promise.reject(new Error('Tek kullanıcılı sürümde kullanıcı yönetimi yok')),
  update: () => Promise.reject(new Error('Tek kullanıcılı sürümde kullanıcı yönetimi yok')),
  remove: () => Promise.reject(new Error('Tek kullanıcılı sürümde kullanıcı yönetimi yok'))
}

export const apiTokensApi = {
  list: () => Promise.resolve([]),
  create: () => Promise.reject(new Error('Tek kullanıcılı sürümde API token yok')),
  remove: () => Promise.reject(new Error('Tek kullanıcılı sürümde API token yok'))
}

// --- Denetim günlüğü --------------------------------------------------------
export const auditApi = {
  query: (params = {}) => ipc('audit_query', { params })
}

// --- Filo işlemleri ---------------------------------------------------------
export const fleetApi = {
  run: (data) => ipc('fleet_run', { data })
}

// --- Genel bakış ------------------------------------------------------------
export const overviewApi = {
  get: (range = 60) => ipc('overview_get', { range })
}

// --- Bildirim kanalları -----------------------------------------------------
export const channelsApi = {
  meta: () => ipc('channels_meta'),
  list: () => ipc('channels_list'),
  create: (data) => ipc('channels_create', { data }),
  update: (id, data) => ipc('channels_update', { id, data }),
  remove: (id) => ipc('channels_remove', { id }),
  test: (id) => ipc('channels_test', { id })
}

// --- Sunucular --------------------------------------------------------------
export const serversApi = {
  methods: () => ipc('servers_methods'),
  list: () => ipc('servers_list'),
  get: (id) => ipc('servers_get', { id }),
  create: (data) => ipc('servers_create', { data }),
  update: (id, data) => ipc('servers_update', { id, data }),
  remove: (id) => ipc('servers_remove', { id }),
  test: (id) => ipc('servers_test', { id }),
  testConnection: (data) => ipc('servers_test_connection', { data }),
  snapshot: (id) => ipc('servers_snapshot', { id }),
  diagnose: (id) => ipc('servers_diagnose', { id }),
  daemon: (id) => ipc('servers_daemon', { id }),
  daemonReload: (id) => ipc('servers_daemon_reload', { id }),
  daemonRestart: (id) => ipc('servers_daemon_restart', { id }),
  daemonShutdown: (id) => ipc('servers_daemon_shutdown', { id }),
  daemonClearLog: (id) => ipc('servers_daemon_clear_log', { id }),
  host: (id) => ipc('servers_host', { id }),
  configList: (id) => ipc('servers_config_list', { id }),
  configFile: (id, path) => ipc('servers_config_file', { id, path }),
  configSave: (id, path, content) => ipc('servers_config_save', { id, path, content }),
  configAddProgram: (id, data) => ipc('servers_config_add_program', { id, data }),
  configProgramPreview: (id, data) => ipc('servers_config_program_preview', { id, data }),
  configProgramParse: (id, path) => ipc('servers_config_program_parse', { id, path }),
  metrics: (id, range = 60) => ipc('servers_metrics', { id, range }),
  // Sağlık kontrolleri (sunucuya bağlı)
  healthChecks: (id) => ipc('servers_healthchecks', { id }),
  healthCheckMeta: (id) => ipc('servers_healthcheck_meta', { id }),
  healthCheckCreate: (id, data) => ipc('servers_healthcheck_create', { id, data }),
  healthCheckUpdate: (id, hid, data) => ipc('servers_healthcheck_update', { id, hid, data }),
  healthCheckRemove: (id, hid) => ipc('servers_healthcheck_remove', { id, hid }),
  healthCheckRun: (id, hid) => ipc('servers_healthcheck_run', { id, hid })
}

// --- Süreçler ---------------------------------------------------------------
export const processesApi = {
  start: (sid, fullName) => ipc('process_start', { sid, fullName }),
  stop: (sid, fullName) => ipc('process_stop', { sid, fullName }),
  restart: (sid, fullName) => ipc('process_restart', { sid, fullName }),
  clearLog: (sid, fullName) => ipc('process_clear_log', { sid, fullName }),
  signal: (sid, fullName, signal) => ipc('process_signal', { sid, fullName, signal }),
  sendStdin: (sid, fullName, chars) => ipc('process_send_stdin', { sid, fullName, chars }),
  readLog: (sid, fullName, { channel = 'stdout', offset = 0, length = 32768 } = {}) =>
    ipc('process_read_log', { sid, fullName, channel, offset, length }),
  // Eskiden Blob dönerdi; Rust komutu metin döndürür, arayüz için Blob'a sarılır.
  downloadLog: (sid, fullName, channel = 'stdout') =>
    ipc('process_download_log', { sid, fullName, channel }).then(
      (text) => new Blob([text ?? ''], { type: 'text/plain' })
    )
}

// --- Gruplar ----------------------------------------------------------------
export const groupsApi = {
  start: (sid, group) => ipc('group_start', { sid, group }),
  stop: (sid, group) => ipc('group_stop', { sid, group }),
  restart: (sid, group) => ipc('group_restart', { sid, group }),
  signal: (sid, group, signal) => ipc('group_signal', { sid, group, signal })
}

// --- Toplu işlemler ---------------------------------------------------------
export const bulkApi = {
  startAll: (sid) => ipc('bulk_start_all', { sid }),
  stopAll: (sid) => ipc('bulk_stop_all', { sid }),
  restartAll: (sid) => ipc('bulk_restart_all', { sid }),
  signalAll: (sid, signal) => ipc('bulk_signal_all', { sid, signal }),
  clearAllLogs: (sid) => ipc('bulk_clear_all_logs', { sid })
}

export default { ipc }
