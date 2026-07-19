# Helmio

> **Helmio — Süreçlerinin kontrolünü ele al.**
> Bir veya onlarca Linux sunucudaki **Supervisor (supervisord)** süreçlerini izleyip yöneten çok-platform **masaüstü uygulaması**.

[English](README.md) · **Türkçe**

[![CI](https://github.com/fahrettinaksoy/helmio/actions/workflows/ci.yml/badge.svg)](https://github.com/fahrettinaksoy/helmio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB.svg)](https://tauri.app)
[![Rust](https://img.shields.io/badge/rust-1.96-orange.svg)](src-tauri/rust-toolchain.toml)

Helmio, sunucularındaki her `supervisord` sürecini ve süreç grubunu **tek bir masaüstü penceresinden** izlemeni ve yönetmeni sağlar — durum takibi, başlat/durdur/yeniden başlat, canlı log akışı, yapılandırma düzenleme, sağlık kontrolleri, alarm ve filo geneli toplu orkestrasyon.

**Yerel-önce bir masaüstü uygulamasıdır** (Tauri v2): arayüz, bağlantı mantığı ve tüm veri senin makinende durur. Kurulacak bir sunucu, açılacak bir hesap yok — `supervisord` örneklerine dışa doğru bağlanan tek-kullanıcılı bir araç.

---

## Öne çıkanlar

- **5 bağlantı yöntemi** — doğrudan TCP XML-RPC, yerel Unix socket, SSH tüneli, Docker (`docker exec`) veya Helmio Agent. Sunucu ekle, kanalı test et, hazır.
- **Canlı süreç görünümü** — sunucu başına birkaç saniyede bir anlık görüntü: durum, PID, çalışma süresi, CPU/RAM, yeniden başlama sayısı, flapping tespiti.
- **Tam kontrol** — süreç, grup veya tüm-sunucu düzeyinde başlat/durdur/yeniden başlat/sinyal; stdin gönder; logları temizle.
- **Canlı + indirilebilir loglar** — süreç ve daemon loglarını gerçek zamanlı kuyrukla; geçmişe kaydır; tüm logu indir.
- **Yapılandırma düzenleme** — `supervisord` config dosyalarına göz at ve düzenle, form tabanlı yapıcıyla yeni `[program:…]` blokları ekle.
- **Sağlık kontrolleri** — HTTP / TCP / script prob'ları, N ardışık başarısızlıktan sonra otomatik yeniden başlatma.
- **Alarm** — FATAL / flapping / sağlık kontrolü alarmlarını Slack, Discord, Telegram, genel webhook veya e-postaya ilet.
- **Filo orkestrasyonu** — bir eylemi çok sunucuda paralel veya rolling (sıralı) yeniden başlatma olarak çalıştır.
- **Tek-tık kurulum** — shell bağlantısı (SSH / Docker / yerel) üzerinden Supervisor'ı tespit et ve en iyi pratiklerle kur.
- **Host metrikleri & trendler** — yük, bellek, disk göstergeleri ve zaman serisi grafikleri.
- **Türkçe + İngilizce** arayüz, açık/koyu tema, denetim günlüğü.

---

## Mimari

- **Frontend** (`src/`) — Tauri WebView'de çalışan Vue 3 + Vuetify + Pinia + vue-router + vue-i18n. Backend ile YALNIZ Tauri IPC üzerinden konuşur (`src/api/*`).
- **Backend** (`src-tauri/`) — Rust. Connector'lar, supervisord servis katmanı, gerçek zamanlı poller'lar, sağlık kontrolü zamanlayıcısı, notifier ve installer. Yerel veri (sunucular, kanallar, sağlık kontrolleri, metrikler, denetim) **SQLite**'ta (`tauri-plugin-sql`) tutulur; bağlantı secret'ları diskte **AES-256-GCM** ile şifrelenir.
- **Agent** (`agent/`) — hedef sunucuya, `supervisord`'un yanına konuşlandırdığın opsiyonel minik bir Rust binary'si; Helmio'nun çağırdığı token korumalı bir HTTP/JSON API sunar (TCP/SSH ile doğrudan ulaşamadığın hostlar için).

Vue arayüzü hiçbir ağ backend'iyle konuşmaz — Tauri IPC üzerinden Rust komutlarını çağırır; Rust tarafı da `supervisord` sunucularına XML-RPC, SSH, `docker exec` veya agent ile ulaşır.

---

## Bağlantı yöntemleri

| Yöntem                     | supervisord'a nasıl ulaşır                          | Ne zaman                                    |
| -------------------------- | --------------------------------------------------- | ------------------------------------------- |
| **TCP XML-RPC** (önerilen) | `[inet_http_server]`'a doğrudan XML-RPC             | Daemon ulaşabildiğin bir TCP portu açıyorsa |
| **Yerel Unix socket**      | `[unix_http_server]` socket'i üzerinden XML-RPC     | Helmio aynı makinede çalışıyorsa            |
| **SSH tüneli**             | SSH üzerinden tünellenmiş XML-RPC (socket veya TCP) | SSH erişimin var, açık port yok             |
| **Docker (exec)**          | `docker exec supervisorctl …`                       | supervisord bir container içinde            |
| **Helmio Agent**           | Agent'a HTTP/JSON, o da yerelden proxy'ler          | NAT/firewall — başka türlü ulaşılamıyor     |

Bağlantı secret'ları (parolalar, özel anahtarlar, agent token'ları) diske dokunmadan önce şifrelenir.

---

## Hızlı başlangıç (geliştirme)

Gereksinimler: **Node ≥ 20**, **Rust 1.96** (bkz. [`src-tauri/rust-toolchain.toml`](src-tauri/rust-toolchain.toml)) ve işletim sistemin için [Tauri sistem bağımlılıkları](https://tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri:dev      # masaüstü uygulamasını hot reload ile açar
```

Diğer script'ler:

```bash
npm run dev            # yalnız Vite dev sunucusu (masaüstü kabuğu yok)
npm run build          # frontend'i derle
npm run tauri:build    # masaüstü kurulum paketlerini derle
npm run lint           # ESLint
npm run format         # Prettier
```

---

## Helmio Agent

Doğrudan ulaşamadığın hostlar için agent'ı `supervisord`'un yanına konuşlandır:

```bash
cd agent
cargo build --release
AGENT_TOKEN=<güçlü-bir-secret> \
SUPERVISOR_SOCKET=/var/run/supervisor.sock \
./target/release/helmio-agent
```

Sonra Helmio'da **Agent** yöntemiyle, agent'ın URL'i ve aynı token ile bir sunucu ekle. Yapılandırma (hepsi env değişkeni): `AGENT_PORT` (8787), `AGENT_HOST`, `AGENT_TOKEN` (zorunlu) ve supervisord hedefi — `SUPERVISOR_SOCKET` **veya** `SUPERVISOR_HOST`/`SUPERVISOR_PORT`, artı opsiyonel `SUPERVISOR_PATH` / `SUPERVISOR_USER` / `SUPERVISOR_PASS`.

---

## Hedef sunucu gereksinimleri

- **Supervisor** kurulu ve çalışır durumda (veya bir shell connector üzerinden Helmio'nun tek-tık kurulumunu kullan).
- **TCP** yöntemi için `supervisord.conf` bir `[inet_http_server]` açmalı (Helmio'nun kurulumcusu bunu varsayılan olarak parola korumalı `127.0.0.1:9001` ile ayarlar).
- **SSH / yerel / docker** yöntemleri için bir `[unix_http_server]` socket'i yeterlidir.

---

## Veri & güvenlik

- Tüm veri yereldir (app veri dizinindeki SQLite). Telemetri yok, uzak sunucu yok.
- Secret'lar diskte şifrelidir (AES-256-GCM); anahtar app config dizininde (`.secret-key`, mod `0600`) veya `HELMIO_SECRET_KEY` ortam değişkeninde durur.
- Loglar (JS + Rust) app log dizinindeki tek bir dönen dosyaya yazılır.

---

## Katkı & dokümanlar

Bkz. [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [SECURITY.md](SECURITY.md).

## Lisans

[MIT](LICENSE)
