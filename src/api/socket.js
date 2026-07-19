// Socket.IO yerine Tauri-event köprüsü.
//
// Eski kod `socket.on/off/emit/connect/disconnect/connected` API'sini kullanıyor
// (realtime store, LogPanel, SupervisorInstallPanel, FleetView). Bu shim aynı
// yüzeyi korur ama altında Tauri olaylarını kullanır:
//   - GELEN olaylar  : Rust `app.emit('rt:<olay>', payload)` → burada dinlenir
//   - GİDEN emit'ler  : `invoke('rt_<olay>', payload)` Rust komutuna gider
//
// Faz 1'de Rust realtime komut/olayları henüz yok; emit'ler sessizce yutulur ve
// hiç gelen olay tetiklenmez. Faz 5 yalnız Rust tarafını doldurur — bu dosya
// değişmez.

import { ipc, isTauri, onTauriEvent } from './ipc'

// Rust'ın yayınlayabileceği gelen olay adları (socket.io olay adlarıyla birebir).
const INBOUND = [
  'snapshot',
  'error',
  'event',
  'alert',
  'fleet',
  'log:chunk',
  'log:error',
  'install:log',
  'install:result'
]

class TauriSocketBridge {
  constructor() {
    this.handlers = new Map() // olayAdı -> Set(cb)
    this.connected = false
    this.auth = { token: '' }
    this._unlisteners = []
    this._listening = false
  }

  _startListening() {
    if (this._listening || !isTauri) return
    this._listening = true
    for (const name of INBOUND) {
      onTauriEvent(`rt:${name}`, (payload) => this._dispatch(name, payload))
        .then((un) => this._unlisteners.push(un))
        .catch(() => {})
    }
  }

  _dispatch(name, payload) {
    const set = this.handlers.get(name)
    if (set) for (const cb of [...set]) cb(payload)
  }

  on(name, cb) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set())
    this.handlers.get(name).add(cb)
    return this
  }

  off(name, cb) {
    const set = this.handlers.get(name)
    if (set) {
      if (cb) set.delete(cb)
      else set.clear()
    }
    return this
  }

  once(name, cb) {
    const wrapper = (payload) => {
      this.off(name, wrapper)
      cb(payload)
    }
    return this.on(name, wrapper)
  }

  // Giden abonelik/komut. Faz 5'e kadar ilgili Rust komutu olmayabilir → sessiz.
  emit(name, payload) {
    const cmd = `rt_${name.replace(/[:-]/g, '_')}`
    ipc(cmd, payload || {}).catch(() => {})
    return this
  }

  connect() {
    this._startListening()
    // Tauri IPC her zaman ayakta — "bağlı" say. Realtime store 'connect' ile
    // mevcut abonelikleri yeniden başlatır.
    this.connected = true
    this._dispatch('connect')
    return this
  }

  disconnect() {
    this.connected = false
    this._dispatch('disconnect')
    return this
  }
}

const socket = new TauriSocketBridge()
export default socket
