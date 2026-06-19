# Helmio Event Listener

`helmio_eventlistener.py`, supervisord'un **eventlistener** protokolünü konuşan, saf
Python (stdlib) bir alt süreçtir. Polling yerine **anlık push**: supervisord her
durum değişikliğinde (PROCESS_STATE, PROCESS_GROUP, SUPERVISOR_STATE, TICK_60)
olayı Helmio backend'ine HTTP ile iletir.

> supervisord'un kendisi Python olduğu için her hedef host'ta Python 3 garantilidir —
> ek bağımlılık / kurulum gerekmez.

## Kurulum

**Tek tık (önerilen):** Helmio panelinde sunucu detayında **⋮ → Event Listener → Kur**.
Shell erişimi olan bağlantılarda (local / SSH / Docker) script + config otomatik
yazılır ve `reread && update` uygulanır.

**Manuel:** Panel aynı ekranda hazır config bloğunu ve ingest token'ını gösterir.
Hedef sunucuda supervisord conf dizinine (`/etc/supervisor/conf.d/` gibi) ekleyin:

```ini
[eventlistener:helmio]
command=python3 /etc/supervisor/helmio_eventlistener.py
events=PROCESS_STATE,PROCESS_GROUP,SUPERVISOR_STATE_CHANGE,TICK_60
autostart=true
autorestart=true
environment=HELMIO_INGEST_URL="http://PANEL_HOST:3001/api/ingest",HELMIO_SERVER_ID="<id>",HELMIO_TOKEN="<token>"
stderr_logfile=/var/log/helmio_eventlistener.err
```

Sonra: `supervisorctl reread && supervisorctl update`

## Ortam değişkenleri

| Değişken | Açıklama |
| --- | --- |
| `HELMIO_INGEST_URL` | Backend ingest taban URL'i, ör. `http://panel:3001/api/ingest` |
| `HELMIO_SERVER_ID` | Sunucunun Helmio'daki kayıt id'si |
| `HELMIO_TOKEN` | Sunucuya özel ingest token'ı (makine-makine auth) |
| `HELMIO_TIMEOUT` | HTTP zaman aşımı (sn, varsayılan 5) |

## Notlar

- Listener'ın **hedeften panele** erişebilmesi gerekir (`HELMIO_INGEST_URL`). NAT/firewall
  arkasında panel'i erişilebilir kılın veya backend'i `HELMIO_PUBLIC_URL` ile ayarlayın.
- Token sızması durumunda panelden **Token yenile** deyip listener'ı yeniden kurun.
- Transport hatası listener'ı düşürmez; supervisord'a daima `OK` döner, hata stderr'e yazılır.
