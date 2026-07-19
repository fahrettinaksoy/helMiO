// Tauri IPC köprüsü — eski axios/HTTP katmanının yerini alır.
//
// `ipc(cmd, args)` bir Tauri komutunu çağırır. Rust komutları hata olarak
// `{ error: string }` döndürür; bunu message'ı o metin olan bir Error'a
// çeviririz — böylece mevcut çağıranlar `e.message` ile okuyabilir (eski
// `e.response?.data?.error` dalı artık tetiklenmez ama zararsızdır).

import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen as tauriListen } from '@tauri-apps/api/event'

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export async function ipc(cmd, args) {
  try {
    return await tauriInvoke(cmd, args || {})
  } catch (e) {
    const msg = typeof e === 'string' ? e : e?.error || e?.message || 'Bilinmeyen hata'
    const err = new Error(msg)
    err.data = e
    throw err
  }
}

// Rust'ın `app.emit(name, payload)` ile yayınladığı olayları dinler.
// Bir "unlisten" fonksiyonuna çözümlenen promise döner.
export function onTauriEvent(name, handler) {
  return tauriListen(name, (event) => handler(event.payload))
}
