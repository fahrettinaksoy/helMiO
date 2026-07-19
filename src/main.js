import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import i18n from './i18n'
import vuetify from './plugins/vuetify'
import router from './router'

// TEK KULLANICI masaüstü sürümü: ağ tabanlı auth kaldırıldığı için eski
// `helmio:unauthorized` (401 → login) dinleyicisi de kaldırıldı.
createApp(App).use(createPinia()).use(router).use(vuetify).use(i18n).mount('#app')
