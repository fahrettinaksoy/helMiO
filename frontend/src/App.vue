<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useTheme } from 'vuetify';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useRealtimeStore } from '@/stores/realtime';
import { useServersStore } from '@/stores/servers';
import { useUiStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { authApi } from '@/api/client';
import { setLocale, SUPPORTED } from '@/i18n';
import ServerListPanel from '@/components/ServerListPanel.vue';
import ServerFormDrawer from '@/components/ServerFormDrawer.vue';

const realtime = useRealtimeStore();
const serversStore = useServersStore();
const ui = useUiStore();
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const theme = useTheme();
const { t, locale } = useI18n();
const drawer = ref(true);
const rail = ref(true); // menu panel collapses to an icon-only rail

// Login (and any future blank-layout route) renders without the app chrome.
const isBlankLayout = computed(() => route.meta.layout === 'blank' || !auth.isAuthenticated);

const roleColor = (r) => ({ admin: 'error', operator: 'warning', viewer: 'info' }[r] || 'primary');
const userInitials = computed(() => {
  const n = auth.user?.displayName || auth.user?.username || '?';
  return n.slice(0, 2).toUpperCase();
});

async function doLogout() {
  await auth.logout();
  router.replace({ name: 'login' });
}

// Change-password dialog
const pwDialog = ref(false);
const pwForm = ref({ current: '', next: '', confirm: '' });
const pwBusy = ref(false);
const pwError = ref('');
function openChangePassword() {
  pwForm.value = { current: '', next: '', confirm: '' };
  pwError.value = '';
  pwDialog.value = true;
}
async function submitChangePassword() {
  pwError.value = '';
  if (pwForm.value.next !== pwForm.value.confirm) { pwError.value = t('auth.passwordMismatch'); return; }
  pwBusy.value = true;
  try {
    await authApi.changePassword(pwForm.value.current, pwForm.value.next);
    pwDialog.value = false;
    alertSnack.value = { show: true, color: 'success', text: t('auth.passwordChanged') };
  } catch (e) {
    pwError.value = e.response?.data?.error || e.message;
  } finally {
    pwBusy.value = false;
  }
}

const isDark = computed(() => theme.global.name.value === 'dark');
function toggleTheme() {
  const next = isDark.value ? 'light' : 'dark';
  theme.global.name.value = next;
  localStorage.setItem('helmio-theme', next);
}

const LANGS = [
  { code: 'tr', label: 'Türkçe' },
  { code: 'en', label: 'English' },
];
const currentLang = computed(() => LANGS.find((l) => l.code === locale.value) || LANGS[1]);
function changeLang(code) {
  if (SUPPORTED.includes(code)) setLocale(code);
}

const nav = computed(() => {
  const items = [
    { title: t('nav.dashboard'), icon: 'mdi-view-dashboard-outline', to: '/dashboard' },
    { title: t('nav.servers'), icon: 'mdi-server', to: '/servers' },
  ];
  if (auth.can('process:control')) {
    items.push({ title: t('nav.fleet'), icon: 'mdi-server-network', to: '/fleet' });
  }
  if (auth.isAdmin) {
    items.push({ title: t('nav.channels'), icon: 'mdi-bell-ring', to: '/admin/channels' });
    items.push({ title: t('nav.tokens'), icon: 'mdi-key-variant', to: '/admin/tokens' });
    items.push({ title: t('nav.users'), icon: 'mdi-account-group', to: '/admin/users' });
    items.push({ title: t('nav.audit'), icon: 'mdi-clipboard-text-clock', to: '/admin/audit' });
  }
  return items;
});

// External links
const REPO_URL = 'https://github.com/fahrettinaksoy/helMiO';
const DOCS_URL = `${REPO_URL}#readme`;
const COFFEE_URL = 'https://www.buymeacoffee.com/fahrettinaksoy';
const enc = encodeURIComponent;
const SHARE_TEXT = 'HelMiO — Supervisor Management';
const socials = [
  { name: 'X / Twitter', icon: 'mdi-twitter', url: `https://twitter.com/intent/tweet?text=${enc(SHARE_TEXT)}&url=${enc(REPO_URL)}` },
  { name: 'LinkedIn', icon: 'mdi-linkedin', url: `https://www.linkedin.com/sharing/share-offsite/?url=${enc(REPO_URL)}` },
  { name: 'Reddit', icon: 'mdi-reddit', url: `https://www.reddit.com/submit?url=${enc(REPO_URL)}&title=${enc(SHARE_TEXT)}` },
  { name: 'Facebook', icon: 'mdi-facebook', url: `https://www.facebook.com/sharer/sharer.php?u=${enc(REPO_URL)}` },
  { name: 'WhatsApp', icon: 'mdi-whatsapp', url: `https://wa.me/?text=${enc(`${SHARE_TEXT} ${REPO_URL}`)}` },
  { name: 'Telegram', icon: 'mdi-send', url: `https://t.me/share/url?url=${enc(REPO_URL)}&text=${enc(SHARE_TEXT)}` },
];
async function copyRepo() {
  try {
    await navigator.clipboard.writeText(REPO_URL);
    alertSnack.value = { show: true, color: 'success', text: t('app.linkCopied') };
  } catch { /* clipboard unavailable */ }
}

onMounted(() => { if (auth.isAuthenticated) serversStore.fetchAll(); });
// Load the server list once a session becomes available (e.g. right after login).
watch(() => auth.isAuthenticated, (ok) => { if (ok) serversStore.fetchAll(); });

// Global FATAL / flapping notifications (from realtime store)
const alertSnack = ref({ show: false, text: '', color: 'error' });
watch(() => realtime.alerts.length, () => {
  const a = realtime.alerts[realtime.alerts.length - 1];
  if (!a) return;
  const server = serversStore.byId(a.serverId)?.name || a.serverId;
  alertSnack.value = {
    show: true,
    color: a.type === 'fatal' ? 'error' : 'warning',
    text: t(`alert.${a.type}`, { name: a.fullName, server }),
  };
});
</script>

<template>
  <v-app>
    <!-- Blank layout: login / setup. No chrome. -->
    <v-main v-if="isBlankLayout">
      <router-view />
    </v-main>

    <template v-else>
    <!-- Top bar: logo on the left, then the panel title -->
    <v-app-bar flat elevation="3" color="surface" density="comfortable">
      <v-app-bar-nav-icon @click="rail = !rail" />

      <router-link to="/dashboard" class="brand d-flex align-center text-decoration-none">
        <span class="text-h6 font-weight-bold brand-name">HelMiO</span>
      </router-link>

      <v-divider vertical class="mx-3 my-3" />
      <span class="text-body-2 text-medium-emphasis d-none d-sm-flex">{{ t('app.subtitle') }}</span>

      <v-spacer />

      <!-- External links -->
      <v-tooltip :text="t('app.github')" location="bottom">
        <template #activator="{ props: tip }">
          <v-btn v-bind="tip" icon="mdi-github" variant="text" :href="REPO_URL" target="_blank" rel="noopener" />
        </template>
      </v-tooltip>
      <v-tooltip :text="t('app.docs')" location="bottom">
        <template #activator="{ props: tip }">
          <v-btn v-bind="tip" icon="mdi-book-open-blank-variant-outline" variant="text" :href="DOCS_URL" target="_blank" rel="noopener" />
        </template>
      </v-tooltip>
      <v-menu location="bottom end">
        <template #activator="{ props: menu }">
          <v-tooltip :text="t('app.share')" location="bottom">
            <template #activator="{ props: tip }">
              <v-btn v-bind="{ ...menu, ...tip }" icon="mdi-share-variant" variant="text" />
            </template>
          </v-tooltip>
        </template>
        <v-list density="compact" nav min-width="200">
          <v-list-item
            v-for="s in socials"
            :key="s.name"
            :href="s.url"
            target="_blank"
            rel="noopener"
            :prepend-icon="s.icon"
            :title="s.name"
          />
          <v-divider class="my-1" />
          <v-list-item prepend-icon="mdi-link-variant" :title="t('app.copyLink')" @click="copyRepo" />
        </v-list>
      </v-menu>
      <v-tooltip :text="t('app.coffee')" location="bottom">
        <template #activator="{ props: tip }">
          <v-btn v-bind="tip" icon="mdi-coffee-outline" variant="text" :href="COFFEE_URL" target="_blank" rel="noopener" />
        </template>
      </v-tooltip>

      <v-divider vertical class="mx-1 my-3" />

      <!-- Language dropdown -->
      <v-menu class=" border-0">
        <template #activator="{ props: menu }">
          <v-btn v-bind="menu" variant="text" class="ms-1 text-none" prepend-icon="mdi-translate">
            {{ currentLang.code.toUpperCase() }}
          </v-btn>
        </template>
        <v-list density="compact" nav>
          <v-list-item
            v-for="l in LANGS"
            :key="l.code"
            :active="l.code === locale"
            @click="changeLang(l.code)"
          >
            <v-list-item-title>{{ l.label }}</v-list-item-title>
            <template #append>
              <v-icon v-if="l.code === locale" icon="mdi-check" size="16" color="primary" />
            </template>
          </v-list-item>
        </v-list>
      </v-menu>

      <v-tooltip :text="isDark ? t('app.toLight') : t('app.toDark')" location="bottom">
        <template #activator="{ props: tip }">
          <v-btn
            v-bind="tip"
            :icon="isDark ? 'mdi-weather-sunny' : 'mdi-weather-night'"
            variant="text"
            @click="toggleTheme"
          />
        </template>
      </v-tooltip>

      <v-divider vertical class="mx-1 my-3" />

      <!-- User menu -->
      <v-menu location="bottom end" min-width="220">
        <template #activator="{ props: menu }">
          <v-btn v-bind="menu" variant="text" class="text-none ms-1 px-2">
            <v-avatar :color="roleColor(auth.role)" variant="tonal" size="32" class="me-2">
              <span class="text-caption font-weight-bold">{{ userInitials }}</span>
            </v-avatar>
            <span class="d-none d-sm-inline">{{ auth.user?.displayName || auth.user?.username }}</span>
            <v-icon icon="mdi-chevron-down" size="18" class="ms-1" />
          </v-btn>
        </template>
        <v-list density="compact" nav>
          <v-list-item>
            <v-list-item-title class="font-weight-medium">{{ auth.user?.displayName || auth.user?.username }}</v-list-item-title>
            <v-list-item-subtitle>
              <v-chip :color="roleColor(auth.role)" size="x-small" variant="tonal" label>{{ t(`roles.${auth.role}`) }}</v-chip>
            </v-list-item-subtitle>
          </v-list-item>
          <v-divider class="my-1" />
          <v-list-item prepend-icon="mdi-lock-reset" :title="t('auth.changePassword')" @click="openChangePassword" />
          <v-list-item prepend-icon="mdi-logout" :title="t('auth.logout')" @click="doLogout" />
        </v-list>
      </v-menu>
    </v-app-bar>

    <!-- Left panel: icon-only rail (expands via the app-bar toggle) -->
    <v-navigation-drawer v-model="drawer" :rail="rail" rail-width="64" color="surface" class="icon-rail" width="180">
      <v-list nav density="comfortable" class="px-2 py-4">
        <div v-if="!rail" class="text-overline text-medium-emphasis px-3 mb-1">{{ t('app.menu') }}</div>
        <v-tooltip
          v-for="item in nav"
          :key="item.to"
          :text="item.title"
          location="end"
          :disabled="!rail"
        >
          <template #activator="{ props: tip }">
            <v-list-item
              v-bind="tip"
              :to="item.to"
              :prepend-icon="item.icon"
              :title="item.title"
              rounded="lg"
              class="mb-1"
              color="primary"
            />
          </template>
        </v-tooltip>
      </v-list>

      <template #append>
        <!-- Collapsed: just a status dot. Expanded: full status card. -->
        <div v-if="rail" class="pa-2 pb-3 d-flex justify-center">
          <v-tooltip :text="realtime.connected ? t('app.liveActive') : t('app.noConnection')" location="end">
            <template #activator="{ props: tip }">
              <v-icon
                v-bind="tip"
                :icon="realtime.connected ? 'mdi-lan-connect' : 'mdi-lan-disconnect'"
                :color="realtime.connected ? 'success' : 'error'"
                size="20"
              />
            </template>
          </v-tooltip>
        </div>
        <div v-else class="pa-3">
          <v-sheet
            rounded="lg"
            class="status-card d-flex align-center ga-3 pa-3"
            :class="realtime.connected ? 'is-on' : 'is-off'"
          >
            <v-avatar
              :color="realtime.connected ? 'success' : 'error'"
              variant="tonal"
              rounded="lg"
              size="34"
            >
              <v-icon :icon="realtime.connected ? 'mdi-lan-connect' : 'mdi-lan-disconnect'" size="18" />
              <span v-if="realtime.connected" class="status-ping" />
            </v-avatar>
            <div class="min-w-0">
              <div class="text-caption font-weight-bold text-on-surface text-truncate">
                {{ realtime.connected ? t('app.liveConnection') : t('app.noConnection') }}
              </div>
              <div class="text-caption text-medium-emphasis text-truncate">
                {{ realtime.connected ? t('app.liveConnectionSub') : t('app.reconnecting') }}
              </div>
            </div>
          </v-sheet>
        </div>
      </template>
    </v-navigation-drawer>

    <!-- Second panel: live server list, to the right of the menu -->
    <ServerListPanel />

    <v-main class="d-flex flex-column">
      <div class="page-pad">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </div>
    </v-main>

    <!-- Global add/edit server form — openable from anywhere -->
    <ServerFormDrawer v-model="ui.serverFormOpen" :server="ui.serverFormTarget" @saved="serversStore.fetchAll()" />

    <!-- Change password -->
    <v-dialog v-model="pwDialog" max-width="420">
      <v-card rounded="lg">
        <v-card-title>{{ t('auth.changePassword') }}</v-card-title>
        <v-card-text>
          <v-alert v-if="pwError" type="error" variant="tonal" density="compact" class="mb-3" :text="pwError" />
          <v-text-field v-model="pwForm.current" :label="t('auth.currentPassword')" type="password" variant="outlined" density="comfortable" autocomplete="current-password" class="mb-2" />
          <v-text-field v-model="pwForm.next" :label="t('auth.newPassword')" type="password" variant="outlined" density="comfortable" autocomplete="new-password" class="mb-2" />
          <v-text-field v-model="pwForm.confirm" :label="t('auth.passwordConfirm')" type="password" variant="outlined" density="comfortable" autocomplete="new-password" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="pwDialog = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="primary" variant="flat" :loading="pwBusy" @click="submitChangePassword">{{ t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="alertSnack.show" :color="alertSnack.color" location="top right" :timeout="6000">
      <v-icon icon="mdi-alert" class="me-2" />{{ alertSnack.text }}
    </v-snackbar>
    </template>
  </v-app>
</template>

<style scoped>
.brand-name {
  color: rgb(var(--v-theme-on-surface));
  letter-spacing: 0.3px;
}
.brand {
  transition: opacity 0.15s ease;
}
.brand:hover {
  opacity: 0.85;
}
.min-w-0 {
  min-width: 0;
}

/* Icon rail: replace the full-height right border with an inset vertical line
   (top/bottom gaps) so it matches the left/right-inset horizontal dividers in
   the panels. Vuetify's border spans the full height, so we draw our own. */
.icon-rail :deep(.v-navigation-drawer__content),
.icon-rail { border-inline-end: none !important; }
.icon-rail::after {
  content: "";
  position: absolute;
  top: 12px;
  bottom: 12px;
  inset-inline-end: 0;
  width: 1px;
  background: rgba(var(--v-theme-on-surface), 0.12);
  pointer-events: none;
  z-index: 1;
}

/* Hero fills flush to the edges; spacing lives inside the hero panel */
.page-pad {
  padding: 0;
  /* Fill v-main so pages can opt into a viewport-height layout (PageShell `fill`).
     Block-height pages still grow naturally and scroll the document. */
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.page-pad > * {
  flex: 0 0 auto;
}
.page-pad > .shell-fill {
  flex: 1 1 auto;
  min-height: 0;
}

/* Live-connection status card — neutral tinted surface with a colored left
   accent. Vuetify has no utility for the soft on-surface tint + accent border. */
.status-card {
  background: rgba(var(--v-theme-on-surface), 0.04);
  border: 1px solid rgba(var(--v-theme-on-surface), 0.08);
  border-left: 3px solid rgb(var(--v-theme-success));
  transition: border-color 0.25s ease, background 0.25s ease;
}
.status-card.is-off {
  border-left-color: rgb(var(--v-theme-error));
}

/* A single live ping ring on the badge when connected (no Vuetify equivalent) */
.status-ping {
  position: absolute;
  inset: 0;
  border-radius: 10px;
  box-shadow: 0 0 0 0 rgba(var(--v-theme-success), 0.5);
  animation: pulse 2.2s ease-out infinite;
}

@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(var(--v-theme-success), 0.45); }
  70% { box-shadow: 0 0 0 10px rgba(var(--v-theme-success), 0); }
  100% { box-shadow: 0 0 0 0 rgba(var(--v-theme-success), 0); }
}
</style>

<style>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* Readable tooltips in both themes (dark bubble + white text) */
.v-tooltip > .v-overlay__content {
  background: rgba(28, 32, 40, 0.95) !important;
  color: #fff !important;
}
</style>
