import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

// TEK KULLANICI masaüstü: login/kullanıcı/token rotaları kaldırıldı.
const routes = [
  { path: '/', redirect: '/dashboard' },
  {
    path: '/dashboard',
    name: 'dashboard',
    component: () => import('@/views/DashboardView.vue'),
    meta: { title: 'Dashboard' }
  },
  {
    path: '/servers',
    name: 'servers',
    component: () => import('@/views/ServersView.vue'),
    meta: { title: 'Sunucular' }
  },
  {
    path: '/servers/:id',
    name: 'server-detail',
    component: () => import('@/views/ServerDetailView.vue'),
    meta: { title: 'Sunucu Detayı' },
    props: true
  },
  {
    path: '/admin/audit',
    name: 'audit',
    component: () => import('@/views/AuditView.vue'),
    meta: { title: 'Denetim Günlüğü' }
  },
  {
    path: '/admin/channels',
    name: 'channels',
    component: () => import('@/views/ChannelsView.vue'),
    meta: { title: 'Bildirim Kanalları' }
  },
  {
    path: '/fleet',
    name: 'fleet',
    component: () => import('@/views/FleetView.vue'),
    meta: { title: 'Filo İşlemleri' }
  },
  // Eski/bilinmeyen rotalar → dashboard (yer imleri kırılmasın).
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

// Realtime köprüsünü açılışta başlat; ağ tabanlı auth guard'ı yok.
router.beforeEach(async () => {
  const auth = useAuthStore()
  if (!auth.ready) await auth.init()
  return true
})

router.afterEach((to) => {
  document.title = to.meta.title ? `Helmio — ${to.meta.title}` : 'Helmio'
})

export default router
