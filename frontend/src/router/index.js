import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const routes = [
  { path: '/', redirect: '/dashboard' },
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { title: 'Giriş', public: true, layout: 'blank' },
  },
  {
    path: '/dashboard',
    name: 'dashboard',
    component: () => import('@/views/DashboardView.vue'),
    meta: { title: 'Dashboard' },
  },
  {
    path: '/servers',
    name: 'servers',
    component: () => import('@/views/ServersView.vue'),
    meta: { title: 'Sunucular' },
  },
  {
    path: '/servers/:id',
    name: 'server-detail',
    component: () => import('@/views/ServerDetailView.vue'),
    meta: { title: 'Sunucu Detayı' },
    props: true,
  },
  {
    path: '/admin/users',
    name: 'users',
    component: () => import('@/views/UsersView.vue'),
    meta: { title: 'Kullanıcılar', requiresAdmin: true },
  },
  {
    path: '/admin/audit',
    name: 'audit',
    component: () => import('@/views/AuditView.vue'),
    meta: { title: 'Denetim Günlüğü', requiresAdmin: true },
  },
  {
    path: '/admin/channels',
    name: 'channels',
    component: () => import('@/views/ChannelsView.vue'),
    meta: { title: 'Bildirim Kanalları', requiresAdmin: true },
  },
  {
    path: '/admin/tokens',
    name: 'tokens',
    component: () => import('@/views/ApiTokensView.vue'),
    meta: { title: 'API Tokenları', requiresAdmin: true },
  },
  {
    path: '/fleet',
    name: 'fleet',
    component: () => import('@/views/FleetView.vue'),
    meta: { title: 'Filo İşlemleri', permission: 'process:control' },
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

// Global auth guard. Waits for the initial session probe, then enforces login
// and admin-only routes.
router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.ready) await auth.init();

  if (to.meta.public) {
    // Already signed in? Skip the login page.
    if (to.name === 'login' && auth.isAuthenticated) return { path: '/dashboard' };
    return true;
  }

  if (!auth.isAuthenticated) {
    return { name: 'login', query: to.fullPath !== '/dashboard' ? { redirect: to.fullPath } : {} };
  }

  if (to.meta.requiresAdmin && !auth.isAdmin) {
    return { path: '/dashboard' };
  }

  if (to.meta.permission && !auth.can(to.meta.permission)) {
    return { path: '/dashboard' };
  }

  return true;
});

router.afterEach((to) => {
  document.title = to.meta.title ? `Helmio — ${to.meta.title}` : 'Helmio';
});

export default router;
