import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { authApi } from '@/api/client';
import socket from '@/api/socket';

const TOKEN_KEY = 'helmio-token';

/**
 * Panel authentication state. Holds the JWT (persisted to localStorage) and the
 * current user with its effective permission list. The axios + socket clients
 * read the token from here via setToken().
 */
export const useAuthStore = defineStore('auth', () => {
  const token = ref(localStorage.getItem(TOKEN_KEY) || '');
  const user = ref(null);
  const needsSetup = ref(false);
  const ready = ref(false); // initial /me probe finished

  const isAuthenticated = computed(() => !!token.value && !!user.value);
  const role = computed(() => user.value?.role || null);
  const isAdmin = computed(() => role.value === 'admin');

  /** Permission check used to gate UI affordances. */
  function can(permission) {
    return !!user.value?.permissions?.includes(permission);
  }

  function applyToken(value) {
    token.value = value || '';
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
    // Re-handshake the socket so it carries the new (or absent) token.
    socket.auth = { token: value || '' };
    if (socket.connected) socket.disconnect();
    if (value) socket.connect();
  }

  async function checkStatus() {
    const { needsSetup: ns } = await authApi.status();
    needsSetup.value = ns;
    return ns;
  }

  /** Restore a session on app load: validate the stored token via /me. */
  async function init() {
    try {
      await checkStatus();
      if (token.value) {
        socket.auth = { token: token.value };
        const { user: me } = await authApi.me();
        user.value = me;
        if (!socket.connected) socket.connect();
      }
    } catch {
      applyToken('');
      user.value = null;
    } finally {
      ready.value = true;
    }
  }

  async function login(username, password) {
    const { token: tok, user: me } = await authApi.login(username, password);
    user.value = me;
    applyToken(tok);
    needsSetup.value = false;
  }

  async function setup(payload) {
    const { token: tok, user: me } = await authApi.setup(payload);
    user.value = me;
    applyToken(tok);
    needsSetup.value = false;
  }

  async function logout() {
    try {
      await authApi.logout();
    } catch {
      /* token may already be invalid */
    }
    user.value = null;
    applyToken('');
  }

  /** Force a logout locally (e.g. on a 401 from the API interceptor). */
  function clearSession() {
    user.value = null;
    applyToken('');
  }

  return {
    token,
    user,
    needsSetup,
    ready,
    isAuthenticated,
    role,
    isAdmin,
    can,
    init,
    checkStatus,
    login,
    setup,
    logout,
    clearSession,
  };
});
