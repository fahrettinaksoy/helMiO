# helMiO

> Helmio - Take control of your processes.

Çoklu sunucu **Supervisor** (supervisord) yönetim paneli. Node.js backend + Vue 3 / Vuetify frontend.

Bir veya birden fazla Linux sunucusundaki tüm supervisord ana ve alt işlemlerini (process / process group) tek panelden izleyin ve yönetin: durum takibi, start / stop / restart, gerçek zamanlı güncelleme.

## Mimari

```
frontend/  Vue 3 + Vuetify 3 + Pinia + Vue Router + Socket.IO client (Vite)
backend/   Express + Socket.IO + XML-RPC proxy (supervisord'a bağlanır)
```

Backend her sunucuya bir **connector** ile bağlanır. Sunucu eklenirken bağlantı yöntemi seçilir:

| Yöntem | Açıklama | Durum |
| --- | --- | --- |
| **TCP XML-RPC** (`inet_http_server`) | supervisord'un TCP portuna (ör. `:9001`) doğrudan XML-RPC. **En verimli / önerilen.** | ✅ Tam destek |
| Yerel Unix Socket | Helmio ile aynı makinedeki supervisord socket'ine port açmadan bağlanır. | ✅ Tam destek |
| SSH tüneli | supervisord unix socket'i veya localhost TCP portu SSH üzerinden forward edilir. Port açmadan, sadece SSH erişimiyle. | ✅ Tam destek |
| Docker (exec) | Container içindeki supervisord'a `docker exec supervisorctl` ile erişir; container'a hiçbir şey kurulmaz, port açılmaz. | ✅ Tam destek |
| Helmio Agent | Hedef sunucuya kurulan ajan ([agent/](agent/)), supervisord'a yerelden bağlanır; panel token'lı HTTP ile erişir. NAT/firewall arkası için ideal. | ✅ Tam destek |

> **Not:** TCP XML-RPC en düşük gecikmeli ve en az kurulum gerektiren yöntemdir. Hedef sunucuda `supervisord.conf` içinde `[inet_http_server]` bölümünün açık olması yeterlidir.

### Ortam bazlı bağlantı rehberi

| Ortam | Önerilen yöntem | Notlar |
| --- | --- | --- |
| **macOS / Linux (yerel dev)** | Yerel Unix Socket | Homebrew socket'i genelde `/opt/homebrew/var/run/supervisor.sock`. Port açmaya gerek yok. Uzaktaysa SSH/TCP. |
| **Windows + WSL2** | TCP XML-RPC | WSL içinde `inet_http_server` `0.0.0.0:9001`'e bağlayın; WSL2 *localhostForwarding* ile host'tan `localhost:9001`. Alternatif: WSL'de `sshd` + SSH. |
| **Docker container** | Docker (exec) veya TCP | Port açmak istemiyorsanız Docker (exec) — Helmio'nun `/var/run/docker.sock`'a erişimi gerekir. Ya da `-p 9001:9001` publish edip TCP. |
| **Uzak Linux sunucu** | SSH tüneli veya TCP | SSH hiç port açmadan çalışır; TCP için `inet_http_server` `0.0.0.0:9001`. NAT arkası için Agent. |

> Docker (exec) yöntemi, Helmio bir container içinde çalışıyorsa host'un Docker socket'ini mount etmenizi gerektirir: `-v /var/run/docker.sock:/var/run/docker.sock`. Agent yöntemi için bkz. [agent/README.md](agent/README.md).

## Kurulum

```bash
npm install            # tüm workspace bağımlılıkları
npm run dev            # backend (:3001) + frontend (:5173) birlikte
```

- Backend API: http://localhost:3001
- Frontend: http://localhost:5173

## Hedef sunucu ön koşulu (TCP XML-RPC)

`/etc/supervisor/supervisord.conf` içine:

```ini
[inet_http_server]
port=*:9001
username=admin
password=secret
```

Sonra `supervisorctl reread && supervisorctl update` (veya servis restart).

## Yol haritası

- [x] Çoklu sunucu kaydı + connector mimarisi (TCP XML-RPC, SSH tüneli, Helmio Agent)
- [x] Process / group durum tablosu (realtime)
- [x] start / stop / restart, group işlemleri
- [x] Log yönetimi — stdout/stderr realtime stream + geriye-scroll (offset tabanlı geçmiş okuma)
- [x] Config yönetimi — .conf editörü + tam alanlı program oluşturucu (şablonlar + canlı önizleme), reread/update
- [x] Alerting & bildirim kanalları — Slack / Discord / Telegram / webhook / e-posta (FATAL & flapping)
- [x] İzleme — süreç/CPU/bellek zaman serisi + trend grafikleri (canlı, bağımlılıksız SVG)
- [x] Performans — `system.multicall` ile XML-RPC çağrı batch'leme (snapshot/daemon/ping tek round-trip)
- [x] Auth (JWT / RBAC) + denetim günlüğü (audit log) — admin / operator / viewer rolleri
- [x] Event Listener (push-based olaylar) — supervisord eventlistener'ı ([eventlistener/](eventlistener/)) üzerinden anlık durum değişimi, canlı olay akışı, FATAL/flapping alert'leri
- [x] Health check + otomatik restart — süreç başına HTTP/TCP probe, eşik aşımında restart veya uyarı (alert kanallarına bağlı)
- [x] Toplu/grup sinyal + tüm logları temizle (signalProcessGroup / signalAllProcesses / clearAllProcessLogs)
- [x] Çapraz-sunucu filo orkestrasyonu — paralel / sıralı (rolling) toplu işlem, per-sunucu sonuç
- [x] Helmio REST API + API token (CI/CD) — rol bazlı, `Authorization: Bearer hmo_…` veya `X-Helmio-Api-Key`
- [x] Log indirme (sunucu-taraflı tam log) + log içinde arama/filtre
- [x] Güvenlik & sağlamlaştırma — secret'lar at-rest şifreli (AES-256-GCM), login rate-limit, script tabanlı health check, program düzenleme, metrik kalıcılığı + host trendleri, filo canlı akışı, smoke test paketi (`npm test`)
