import antfu from '@antfu/eslint-config'
import prettier from 'eslint-config-prettier'

// Kod stili kuralları @antfu'dan; BİÇİMLENDİRME Prettier'e devredildi
// (`stylistic: false`). weltoly ile aynı araç zinciri: ESLint = kod
// kalitesi/kurallar, Prettier = biçim. `eslint-config-prettier` en sonda
// çakışan tüm biçim kurallarını kapatır.
//
// Helmio frontend'i düz JS (TS değil) — `typescript: false`. Vue açık.
export default antfu({
  vue: true,
  typescript: false,

  // Biçimlendirmeyi Prettier yapar; antfu'nun stylistic kurallarını kapat.
  stylistic: false,

  // Biçimlendiriciler kapalı: markdown/yaml/toml (docs, Cargo.toml, workflow'lar)
  // bu kuralların KAPSAMI DIŞINDA.
  markdown: false,
  yaml: false,
  toml: false,
  jsonc: false,

  ignores: [
    'dist',
    'src-tauri/target',
    'src-tauri/gen',
    'legacy', // eski Node backend/agent — port bitene kadar referans, lint dışı
    'eventlistener', // Python
    '**/*.d.ts'
  ]
}).append(prettier)
