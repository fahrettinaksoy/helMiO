import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { LOCAL_USER } from '@/api/client'
import socket from '@/api/socket'

/**
 * Kimlik durumu — TEK KULLANICI masaüstü sürümü.
 *
 * Ağ tabanlı auth (JWT/login/RBAC) kaldırıldı. Uygulama tek yerel yönetici
 * olarak çalışır; tüm yetkiler açık. Bu store, uygulama genelinde kullanılan
 * eski arayüzü (isAuthenticated, can, init, login, ...) korur ki bileşenler
 * değişmeden çalışsın. Faz 8'de login/kullanıcı görünümleri UI'dan kaldırılınca
 * bu store daha da sadeleşebilir.
 */
export const useAuthStore = defineStore('auth', () => {
  const user = ref(LOCAL_USER)
  const needsSetup = ref(false)
  const ready = ref(false)

  const isAuthenticated = computed(() => true)
  const role = computed(() => user.value?.role || 'admin')
  const isAdmin = computed(() => true)

  // Tek kullanıcı tüm izinlere sahiptir.
  function can() {
    return true
  }

  async function init() {
    // Realtime köprüsünü (Tauri olay dinleyicileri) başlat.
    try {
      socket.connect()
    } catch {
      /* köprü yoksa yut */
    }
    ready.value = true
  }

  async function checkStatus() {
    needsSetup.value = false
    return false
  }

  // login/setup/logout artık işlevsiz — arayüz uyumu için korunur.
  async function login() {
    user.value = LOCAL_USER
  }
  async function setup() {
    user.value = LOCAL_USER
  }
  async function logout() {
    /* tek kullanıcıda çıkış yok */
  }
  function clearSession() {
    /* no-op */
  }

  return {
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
    clearSession
  }
})
