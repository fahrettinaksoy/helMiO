//! Zaman serisi metrikleri (trend grafikleri + host gauge'ları). Her snapshot'tan
//! örnek alınır (10s throttle poller'da), sunucu başına 2000 kayıt tutulur.

use serde_json::{json, Map, Value};
use sqlx::{Pool, Row, Sqlite};

use crate::error::{AppError, AppResult};

const MAX_PER_SERVER: i64 = 2000;

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// Snapshot (+ opsiyonel host metrik) örneğini kaydeder.
pub async fn record(
    pool: &Pool<Sqlite>,
    server_id: &str,
    snapshot: &Value,
    host: Option<&Value>,
    now_ms: i64,
) -> AppResult<()> {
    let summary = snapshot.get("summary");
    let si = |k: &str| {
        summary
            .and_then(|s| s.get(k))
            .and_then(Value::as_i64)
            .unwrap_or(0)
    };

    let mut cpu: Option<f64> = None;
    let mut mem: Option<f64> = None;
    if let Some(procs) = snapshot.get("processes").and_then(Value::as_array) {
        for p in procs {
            if let Some(c) = p.get("cpu").and_then(Value::as_f64) {
                cpu = Some(cpu.unwrap_or(0.0) + c);
            }
            if let Some(m) = p.get("memMb").and_then(Value::as_f64) {
                mem = Some(mem.unwrap_or(0.0) + m);
            }
        }
    }
    let cpu = cpu.map(round1);
    let mem = mem.map(round1);

    let load = host
        .and_then(|h| h.get("load"))
        .and_then(|l| l.get("one"))
        .and_then(Value::as_f64);
    let mem_pct = host.and_then(|h| h.get("mem")).and_then(|m| {
        let used = m.get("usedMb").and_then(Value::as_f64)?;
        let total = m.get("totalMb").and_then(Value::as_f64)?;
        if total > 0.0 {
            Some((used / total * 1000.0).round() / 10.0)
        } else {
            None
        }
    });
    let disk_pct = host
        .and_then(|h| h.get("disk"))
        .and_then(|d| d.get("usePct"))
        .and_then(Value::as_f64);

    sqlx::query(
        "INSERT INTO metrics
         (server_id, at, total, running, stopped, fatal, other, cpu, mem, load, mem_pct, disk_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(server_id)
    .bind(now_ms)
    .bind(si("total"))
    .bind(si("running"))
    .bind(si("stopped"))
    .bind(si("fatal"))
    .bind(si("other"))
    .bind(cpu)
    .bind(mem)
    .bind(load)
    .bind(mem_pct)
    .bind(disk_pct)
    .execute(pool)
    .await
    .map_err(|e| AppError::new(format!("Metrik yazılamadı: {e}")))?;

    // Halka tamponu: sunucu başına son MAX_PER_SERVER kaydı tut.
    let _ = sqlx::query(
        "DELETE FROM metrics WHERE server_id = ? AND rowid NOT IN
         (SELECT rowid FROM metrics WHERE server_id = ? ORDER BY at DESC LIMIT ?)",
    )
    .bind(server_id)
    .bind(server_id)
    .bind(MAX_PER_SERVER)
    .execute(pool)
    .await;
    Ok(())
}

fn row_to_sample(row: &sqlx::sqlite::SqliteRow) -> Value {
    let f = |k: &str| -> Value {
        row.try_get::<Option<f64>, _>(k)
            .ok()
            .flatten()
            .map_or(Value::Null, |v| json!(v))
    };
    json!({
        "at": row.get::<i64, _>("at"),
        "total": row.get::<i64, _>("total"),
        "running": row.get::<i64, _>("running"),
        "stopped": row.get::<i64, _>("stopped"),
        "fatal": row.get::<i64, _>("fatal"),
        "other": row.get::<i64, _>("other"),
        "cpu": f("cpu"),
        "mem": f("mem"),
        "load": f("load"),
        "memPct": f("mem_pct"),
        "diskPct": f("disk_pct"),
    })
}

/// Son `since_ms` içindeki örnekler (eskiden yeniye).
pub async fn query(
    pool: &Pool<Sqlite>,
    server_id: &str,
    since_ms: i64,
    now_ms: i64,
) -> AppResult<Vec<Value>> {
    let cutoff = now_ms - since_ms;
    let rows = sqlx::query("SELECT * FROM metrics WHERE server_id = ? AND at >= ? ORDER BY at ASC")
        .bind(server_id)
        .bind(cutoff)
        .fetch_all(pool)
        .await
        .map_err(|e| AppError::new(format!("Metrik okunamadı: {e}")))?;
    Ok(rows.iter().map(row_to_sample).collect())
}

/// Filo aggregate: dakikalık bucket'larda toplam seri + sunucu başına son örnek.
pub async fn fleet(pool: &Pool<Sqlite>, since_ms: i64, now_ms: i64) -> AppResult<Value> {
    const BUCKET_MS: i64 = 60000;
    let cutoff = now_ms - since_ms;
    let rows = sqlx::query("SELECT * FROM metrics WHERE at >= ? ORDER BY server_id, at ASC")
        .bind(cutoff)
        .fetch_all(pool)
        .await
        .map_err(|e| AppError::new(format!("Filo metrikleri okunamadı: {e}")))?;

    // bucket -> serverId -> sample; hosts: serverId -> son sample.
    use std::collections::BTreeMap;
    use std::collections::HashMap;
    let mut by_bucket: BTreeMap<i64, HashMap<String, Value>> = BTreeMap::new();
    let mut hosts: HashMap<String, Value> = HashMap::new();
    for row in &rows {
        let sid: String = row.get("server_id");
        let sample = row_to_sample(row);
        let at = sample.get("at").and_then(Value::as_i64).unwrap_or(0);
        hosts.insert(sid.clone(), sample.clone()); // at ASC → son = en yeni
        let bucket = (at / BUCKET_MS) * BUCKET_MS;
        by_bucket.entry(bucket).or_default().insert(sid, sample);
    }

    let series: Vec<Value> = by_bucket
        .into_iter()
        .map(|(at, m)| {
            let (mut cpu, mut mem, mut running, mut total) = (0.0f64, 0.0f64, 0i64, 0i64);
            let (mut cpu_has, mut mem_has) = (false, false);
            for p in m.values() {
                if let Some(c) = p.get("cpu").and_then(Value::as_f64) {
                    cpu += c;
                    cpu_has = true;
                }
                if let Some(mm) = p.get("mem").and_then(Value::as_f64) {
                    mem += mm;
                    mem_has = true;
                }
                running += p.get("running").and_then(Value::as_i64).unwrap_or(0);
                total += p.get("total").and_then(Value::as_i64).unwrap_or(0);
            }
            json!({
                "at": at,
                "cpu": if cpu_has { json!(round1(cpu)) } else { Value::Null },
                "mem": if mem_has { json!(round1(mem)) } else { Value::Null },
                "running": running,
                "total": total,
            })
        })
        .collect();

    let hosts_v: Map<String, Value> = hosts.into_iter().collect();
    Ok(json!({ "series": series, "hosts": hosts_v }))
}
