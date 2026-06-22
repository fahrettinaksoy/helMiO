import axios from 'axios';

const TOKEN_KEY = 'helmio-token';

// Same-origin in dev thanks to the Vite proxy; override with VITE_API_BASE.
const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '/api',
  timeout: 15000,
});

// Attach the bearer token (read from localStorage so this file has no store dep).
api.interceptors.request.use((cfg) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

// On 401 (expired/invalid session) signal the app to drop the session. The
// /auth status+login+setup calls are exempt — a 401 there is an expected reply.
api.interceptors.response.use(
  (r) => r,
  (err) => {
    const url = err.config?.url || '';
    const isAuthProbe = /\/auth\/(status|login|setup)$/.test(url);
    if (err.response?.status === 401 && !isAuthProbe) {
      window.dispatchEvent(new CustomEvent('helmio:unauthorized'));
    }
    return Promise.reject(err);
  },
);

export const authApi = {
  status: () => api.get('/auth/status').then((r) => r.data),
  setup: (data) => api.post('/auth/setup', data).then((r) => r.data),
  login: (username, password) =>
    api.post('/auth/login', { username, password }).then((r) => r.data),
  me: () => api.get('/auth/me').then((r) => r.data),
  logout: () => api.post('/auth/logout').then((r) => r.data),
  changePassword: (currentPassword, newPassword) =>
    api.post('/auth/change-password', { currentPassword, newPassword }).then((r) => r.data),
};

export const usersApi = {
  list: () => api.get('/users').then((r) => r.data),
  create: (data) => api.post('/users', data).then((r) => r.data),
  update: (id, data) => api.put(`/users/${id}`, data).then((r) => r.data),
  remove: (id) => api.delete(`/users/${id}`).then((r) => r.data),
};

export const auditApi = {
  query: (params = {}) => api.get('/audit', { params }).then((r) => r.data),
};

export const apiTokensApi = {
  list: () => api.get('/apitokens').then((r) => r.data),
  create: (data) => api.post('/apitokens', data).then((r) => r.data),
  remove: (id) => api.delete(`/apitokens/${id}`).then((r) => r.data),
};

export const fleetApi = {
  run: (data) => api.post('/fleet/run', data).then((r) => r.data),
};

export const overviewApi = {
  get: (range = 60) => api.get('/overview', { params: { range } }).then((r) => r.data),
};

export const channelsApi = {
  meta: () => api.get('/channels/meta').then((r) => r.data),
  list: () => api.get('/channels').then((r) => r.data),
  create: (data) => api.post('/channels', data).then((r) => r.data),
  update: (id, data) => api.put(`/channels/${id}`, data).then((r) => r.data),
  remove: (id) => api.delete(`/channels/${id}`).then((r) => r.data),
  test: (id) => api.post(`/channels/${id}/test`).then((r) => r.data),
};

export const serversApi = {
  methods: () => api.get('/servers/methods').then((r) => r.data),
  list: () => api.get('/servers').then((r) => r.data),
  get: (id) => api.get(`/servers/${id}`).then((r) => r.data),
  create: (data) => api.post('/servers', data).then((r) => r.data),
  update: (id, data) => api.put(`/servers/${id}`, data).then((r) => r.data),
  remove: (id) => api.delete(`/servers/${id}`).then((r) => r.data),
  test: (id) => api.post(`/servers/${id}/test`).then((r) => r.data),
  testConnection: (data) => api.post('/servers/test', data).then((r) => r.data),
  snapshot: (id) => api.get(`/servers/${id}/snapshot`).then((r) => r.data),
  diagnose: (id) => api.get(`/servers/${id}/diagnose`).then((r) => r.data),
  daemon: (id) => api.get(`/servers/${id}/daemon`).then((r) => r.data),
  daemonReload: (id) => api.post(`/servers/${id}/daemon/reload`).then((r) => r.data),
  daemonRestart: (id) => api.post(`/servers/${id}/daemon/restart`).then((r) => r.data),
  daemonShutdown: (id) => api.post(`/servers/${id}/daemon/shutdown`).then((r) => r.data),
  daemonClearLog: (id) => api.post(`/servers/${id}/daemon/log/clear`).then((r) => r.data),
  host: (id) => api.get(`/servers/${id}/host`).then((r) => r.data),
  configList: (id) => api.get(`/servers/${id}/config`).then((r) => r.data),
  configFile: (id, path) =>
    api.get(`/servers/${id}/config/file`, { params: { path } }).then((r) => r.data),
  configSave: (id, path, content) =>
    api.put(`/servers/${id}/config/file`, { path, content }).then((r) => r.data),
  configAddProgram: (id, data) =>
    api.post(`/servers/${id}/config/program`, data).then((r) => r.data),
  configProgramPreview: (id, data) =>
    api.post(`/servers/${id}/config/program/preview`, data).then((r) => r.data),
  configProgramParse: (id, path) =>
    api.get(`/servers/${id}/config/program/parse`, { params: { path } }).then((r) => r.data),
  // Event listener (push-based events)
  eventListener: (id) => api.get(`/servers/${id}/eventlistener`).then((r) => r.data),
  eventListenerInstall: (id) =>
    api.post(`/servers/${id}/eventlistener/install`).then((r) => r.data),
  eventListenerUninstall: (id) =>
    api.post(`/servers/${id}/eventlistener/uninstall`).then((r) => r.data),
  eventListenerRotateToken: (id) =>
    api.post(`/servers/${id}/eventlistener/rotate-token`).then((r) => r.data),
  events: (id, limit = 200) =>
    api.get(`/servers/${id}/events`, { params: { limit } }).then((r) => r.data),
  metrics: (id, range = 60) =>
    api.get(`/servers/${id}/metrics`, { params: { range } }).then((r) => r.data),
  // Health checks (scoped to a server)
  healthChecks: (id) => api.get(`/servers/${id}/healthchecks`).then((r) => r.data),
  healthCheckMeta: (id) => api.get(`/servers/${id}/healthchecks/meta`).then((r) => r.data),
  healthCheckCreate: (id, data) =>
    api.post(`/servers/${id}/healthchecks`, data).then((r) => r.data),
  healthCheckUpdate: (id, hid, data) =>
    api.put(`/servers/${id}/healthchecks/${hid}`, data).then((r) => r.data),
  healthCheckRemove: (id, hid) =>
    api.delete(`/servers/${id}/healthchecks/${hid}`).then((r) => r.data),
  healthCheckRun: (id, hid) =>
    api.post(`/servers/${id}/healthchecks/${hid}/run`).then((r) => r.data),
};

export const processesApi = {
  start: (sid, fullName) =>
    api.post(`/servers/${sid}/processes/${encodeURIComponent(fullName)}/start`).then((r) => r.data),
  stop: (sid, fullName) =>
    api.post(`/servers/${sid}/processes/${encodeURIComponent(fullName)}/stop`).then((r) => r.data),
  restart: (sid, fullName) =>
    api
      .post(`/servers/${sid}/processes/${encodeURIComponent(fullName)}/restart`)
      .then((r) => r.data),
  clearLog: (sid, fullName) =>
    api
      .post(`/servers/${sid}/processes/${encodeURIComponent(fullName)}/log/clear`)
      .then((r) => r.data),
  signal: (sid, fullName, signal) =>
    api
      .post(`/servers/${sid}/processes/${encodeURIComponent(fullName)}/signal`, { signal })
      .then((r) => r.data),
  sendStdin: (sid, fullName, chars) =>
    api
      .post(`/servers/${sid}/processes/${encodeURIComponent(fullName)}/stdin`, { chars })
      .then((r) => r.data),
  readLog: (sid, fullName, { channel = 'stdout', offset = 0, length = 32768 } = {}) =>
    api
      .get(`/servers/${sid}/processes/${encodeURIComponent(fullName)}/log/read`, {
        params: { channel, offset, length },
      })
      .then((r) => r.data),
  downloadLog: (sid, fullName, channel = 'stdout') =>
    api
      .get(`/servers/${sid}/processes/${encodeURIComponent(fullName)}/log/download`, {
        params: { channel },
        responseType: 'blob',
      })
      .then((r) => r.data),
};

export const groupsApi = {
  start: (sid, group) =>
    api.post(`/servers/${sid}/groups/${encodeURIComponent(group)}/start`).then((r) => r.data),
  stop: (sid, group) =>
    api.post(`/servers/${sid}/groups/${encodeURIComponent(group)}/stop`).then((r) => r.data),
  restart: (sid, group) =>
    api.post(`/servers/${sid}/groups/${encodeURIComponent(group)}/restart`).then((r) => r.data),
  signal: (sid, group, signal) =>
    api
      .post(`/servers/${sid}/groups/${encodeURIComponent(group)}/signal`, { signal })
      .then((r) => r.data),
};

export const bulkApi = {
  startAll: (sid) => api.post(`/servers/${sid}/bulk/start-all`).then((r) => r.data),
  stopAll: (sid) => api.post(`/servers/${sid}/bulk/stop-all`).then((r) => r.data),
  restartAll: (sid) => api.post(`/servers/${sid}/bulk/restart-all`).then((r) => r.data),
  signalAll: (sid, signal) =>
    api.post(`/servers/${sid}/bulk/signal-all`, { signal }).then((r) => r.data),
  clearAllLogs: (sid) => api.post(`/servers/${sid}/bulk/clear-all-logs`).then((r) => r.data),
};

export default api;
