import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import vuetify from 'vite-plugin-vuetify'
import { defineConfig } from 'vitest/config'

// Ağırlıklı olarak saf mantık testleri (format/transform yardımcıları). Vue
// bileşeni mount eden testler için plugin yığını vite.config ile aynı tutulur.
export default defineConfig({
  plugins: [
    vue(),
    vuetify({ autoImport: true, styles: { configFile: 'src/styles/vuetify-settings.scss' } })
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      // Kapsam yalnız saf mantık (.js) üzerinden. .vue bileşenleri birim testinin
      // hedefi değil; dahil etmek yüzdeyi anlamsızca düşürür.
      include: ['src/**/*.js'],
      exclude: [
        'src/**/*.test.js',
        'src/main.js', // uygulama bootstrap — smoke/E2E kapsamı
        'src/i18n/**', // saf veri sözlükleri
        'src/plugins/**' // vuetify/i18n kurulum kabloları
      ]
    },
    server: {
      deps: {
        // Vuetify inline edilmezse bileşen import'ları Node ESM yükleyicisine düşer
        // ve `.css` uzantısında patlar. Inline ederek Vite dönüşümünden geçir.
        inline: ['vuetify']
      }
    }
  }
})
