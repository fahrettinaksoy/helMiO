import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import vuetify from './plugins/vuetify';
import i18n from './i18n';
import { useAuthStore } from './stores/auth';

const app = createApp(App).use(createPinia()).use(router).use(vuetify).use(i18n);

// When any API call returns 401, drop the session and bounce to login.
window.addEventListener('helmio:unauthorized', () => {
  const auth = useAuthStore();
  if (!auth.isAuthenticated) return;
  auth.clearSession();
  router.replace({ name: 'login', query: { redirect: router.currentRoute.value.fullPath } });
});

app.mount('#app');
