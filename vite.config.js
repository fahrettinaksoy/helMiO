import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import vuetify from 'vite-plugin-vuetify'

// Tauri, TAURI_DEV_HOST ile mobil/uzak cihazda geliştirmeye izin verir.
const host = process.env.TAURI_DEV_HOST

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    vue(),
    // Vuetify: bileşen otomatik import + SASS değişken override'larını
    // (src/styles/vuetify-settings.scss) derle. Mevcut bileşenler bu moda göre yazılı.
    vuetify({ autoImport: true, styles: { configFile: 'src/styles/vuetify-settings.scss' } })
  ],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },

  /**
   * Tauri hedefi SABİT bir WebView'dir — tarayıcı pazarı değil.
   *   - macOS/iOS : WKWebView   (tauri.conf minimumSystemVersion 10.15 → Safari 13)
   *   - Windows   : WebView2    (Chromium; Tauri asgarisi Chrome 105)
   *   - Linux     : WebKitGTK
   * Tauri'nin resmî şablonuyla aynı değerler; bir boyut değil UYUMLULUK ayarı.
   */
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_ENV_DEBUG
  },

  // Tauri CLI ile geliştirme (yalnız `tauri dev`/`tauri build` sırasında geçerli).
  // Backend artık Rust/Tauri IPC — eski Vite proxy (/api, /socket.io → :3001) KALDIRILDI.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      ignored: ['**/src-tauri/**']
    }
  }
}))
