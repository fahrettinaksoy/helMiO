# Helmio test ortamı

Supervisor **kurulu olmayan** temiz container'lar. Helmio'nun Docker connector akışını
(tespit → kurulum → yapılandırma → yönetim) gerçek bir hedefe karşı denemek için.

> ⚠️ Bu container'lar `stackvo-*` servislerinden bağımsızdır ve onlara dokunmaz.

## Başlat / durdur

```bash
docker compose -f test/docker-compose.yml up -d     # başlat
docker compose -f test/docker-compose.yml down      # durdur + sil
```

İki container gelir:

| Container            | Dağıtım            | Paket yöneticisi | Test eder        |
| -------------------- | ------------------ | ---------------- | ---------------- |
| `helmio-test-debian` | Debian 13 (trixie) | apt-get          | apt kurulum yolu |
| `helmio-test-alpine` | Alpine 3.20        | apk              | apk kurulum yolu |

İkisinde de supervisord **yok** ve init sistemi yok — bu yüzden Helmio kurulumdan sonra
`supervisord`'u doğrudan başlatır, böylece XML-RPC erişimi de doğrulanabilir.

## Panelde kullanım

1. `npm run dev` ile Helmio'yu çalıştırın.
2. **Sunucular → Sunucu Ekle**:
   - Yöntem: **Docker (exec)**
   - Container adı: `helmio-test-debian`
   - Bağlantı: **Yerel socket** (`/var/run/docker.sock`)
   - **Bağlantıyı test et** → "Bağlantı başarılı. Supervisor kurulu değil…" → **Ekle**
3. Sunucu kartında **🩺 Tanıla / Kur** → "Supervisor kurulu değil" → **Kur ve yapılandır**.
4. Kurulum bitince **İşlemler** sayfasında supervisord durumu görünür.

## Hızlı betikli test (UI'sız)

```bash
node test/run.mjs helmio-test-debian
```

Bu betik tespit (detect) çalıştırır, kurulumu canlı logla yapar ve sonucu doğrular.

## Demo programlar (yönetilecek bir şey görmek için)

Supervisor kurulduktan sonra zengin bir demo seti yükleyin:

```bash
test/seed-demo.sh                    # helmio-test-debian
test/seed-demo.sh helmio-test-alpine # başka container
```

Yüklenen set, panelde tüm durumları/özellikleri göstermek için çeşitli:

| Program                                | Tür                     | Durum                  |
| -------------------------------------- | ----------------------- | ---------------------- |
| `demo-worker`                          | grup ×3                 | RUNNING                |
| `demo-api`                             | grup ×2                 | RUNNING                |
| `demo-db`, `demo-cache`, `demo-ticker` | tekil                   | RUNNING                |
| `demo-batch`                           | tekil (autostart=false) | STOPPED                |
| `demo-flaky`                           | tekil (sürekli çöker)   | BACKOFF → **flapping** |

Böylece durum filtreleri, restart sayacı, **flapping** rozeti, grup işlemleri ve
CPU/bellek kolonları gerçek veriyle görünür.

> Not: Kurulum ve bu programlar **çalışan container'ın içine** yazılır; `down` ile
> container silinince kaybolur (kalıcı değil — bu bir test ortamıdır).
