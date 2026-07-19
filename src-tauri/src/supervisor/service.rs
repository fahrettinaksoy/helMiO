//! Yüksek seviyeli supervisord işlemleri (connector üstünde). Eski
//! `supervisorService.js`'in portu — snapshot, süreç/grup/toplu kontrol, daemon.
//! Log/config/host işlemleri Faz 4B'de eklenecek.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::error::{AppError, AppResult};
use crate::supervisor::connector::{Call, Connector};
use crate::supervisor::create_connector;

/// Sayısal supervisord durum kodu → ad.
fn state_name(code: i64) -> &'static str {
    match code {
        0 => "STOPPED",
        10 => "STARTING",
        20 => "RUNNING",
        30 => "BACKOFF",
        40 => "STOPPING",
        100 => "EXITED",
        200 => "FATAL",
        _ => "UNKNOWN",
    }
}

fn gi(v: &Value, k: &str) -> i64 {
    v.get(k).and_then(Value::as_i64).unwrap_or(0)
}
fn gs(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

// --- Durum: restart/flapping geçmişi + config önbelleği ---------------------

struct ProcHist {
    last_pid: i64,
    restarts: i64,
    events: Vec<Instant>,
}

pub struct SupervisorRuntime {
    proc_history: Mutex<HashMap<String, ProcHist>>,
    #[allow(clippy::type_complexity)]
    config_cache: Mutex<HashMap<String, (Instant, Map<String, Value>)>>,
}

impl SupervisorRuntime {
    pub fn new() -> Self {
        Self {
            proc_history: Mutex::new(HashMap::new()),
            config_cache: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for SupervisorRuntime {
    fn default() -> Self {
        Self::new()
    }
}

// --- Yardımcılar ------------------------------------------------------------

fn normalize_process(p: &Value) -> Value {
    let name = gs(p, "name");
    let group = gs(p, "group");
    let state = gi(p, "state");
    let full = if !group.is_empty() && group != name {
        format!("{group}:{name}")
    } else {
        name.clone()
    };
    let statename = {
        let sn = gs(p, "statename");
        if sn.is_empty() {
            state_name(state).to_string()
        } else {
            sn
        }
    };
    let start = gi(p, "start");
    let now = gi(p, "now");
    let uptime = if start > 0 && now > 0 && state == 20 {
        now - start
    } else {
        0
    };
    json!({
        "name": name,
        "group": group,
        "fullName": full,
        "statecode": state,
        "statename": statename,
        "description": gs(p, "description"),
        "pid": gi(p, "pid"),
        "start": start,
        "stop": gi(p, "stop"),
        "now": now,
        "uptime": uptime,
        "exitstatus": gi(p, "exitstatus"),
        "spawnerr": gs(p, "spawnerr"),
        "logfile": gs(p, "logfile"),
        "stdout_logfile": gs(p, "stdout_logfile"),
        "stderr_logfile": gs(p, "stderr_logfile"),
    })
}

fn group_by(processes: &[Value]) -> Value {
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<Value>> = HashMap::new();
    for p in processes {
        let g = gs(p, "group");
        if !groups.contains_key(&g) {
            order.push(g.clone());
        }
        groups.entry(g).or_default().push(p.clone());
    }
    let list: Vec<Value> = order
        .into_iter()
        .map(|name| {
            let procs = groups.remove(&name).unwrap_or_default();
            let running = procs.iter().filter(|p| gi(p, "statecode") == 20).count();
            json!({
                "group": name,
                "total": procs.len(),
                "running": running,
                "processes": procs,
            })
        })
        .collect();
    Value::Array(list)
}

fn track_restarts(rt: &SupervisorRuntime, server_id: &str, processes: &mut [Value]) {
    let now = Instant::now();
    let mut map = rt.proc_history.lock().unwrap();
    for p in processes.iter_mut() {
        let full = gs(p, "fullName");
        let pid = gi(p, "pid");
        let key = format!("{server_id}:{full}");
        let existed = map.contains_key(&key);
        let h = map.entry(key).or_insert_with(|| ProcHist {
            last_pid: pid,
            restarts: 0,
            events: vec![],
        });
        if existed && pid > 0 && pid != h.last_pid {
            h.restarts += 1;
            h.events.push(now);
            h.events
                .retain(|t| now.duration_since(*t) < Duration::from_secs(300));
        }
        h.last_pid = pid;
        let restarts = h.restarts;
        let flapping = h
            .events
            .iter()
            .filter(|t| now.duration_since(**t) < Duration::from_secs(60))
            .count()
            >= 3;
        if let Some(obj) = p.as_object_mut() {
            obj.insert("restarts".into(), json!(restarts));
            obj.insert("flapping".into(), json!(flapping));
        }
    }
}

async fn get_config_map(
    rt: &SupervisorRuntime,
    conn: &dyn Connector,
    server_id: &str,
) -> Map<String, Value> {
    {
        let cache = rt.config_cache.lock().unwrap();
        if let Some((at, m)) = cache.get(server_id) {
            if at.elapsed() < Duration::from_secs(30) {
                return m.clone();
            }
        }
    }
    let list = conn
        .call("supervisor.getAllConfigInfo", vec![])
        .await
        .unwrap_or(Value::Array(vec![]));
    let mut by_name = Map::new();
    if let Some(arr) = list.as_array() {
        for c in arr {
            let name = gs(c, "name");
            let group = gs(c, "group");
            let full = if !group.is_empty() && group != name {
                format!("{group}:{name}")
            } else {
                name
            };
            let priority = c
                .get("process_prio")
                .and_then(Value::as_i64)
                .or_else(|| c.get("priority").and_then(Value::as_i64));
            by_name.insert(
                full,
                json!({
                    "command": gs(c, "command"),
                    "autostart": c.get("autostart").cloned().unwrap_or(Value::Null),
                    "autorestart": c.get("autorestart").cloned().unwrap_or(Value::Null),
                    "priority": priority,
                    "startsecs": c.get("startsecs").cloned().unwrap_or(Value::Null),
                    "startretries": c.get("startretries").cloned().unwrap_or(Value::Null),
                }),
            );
        }
    }
    rt.config_cache
        .lock()
        .unwrap()
        .insert(server_id.to_string(), (Instant::now(), by_name.clone()));
    by_name
}

/// ps çıktısından pid→(cpu, memMb) haritası (shell erişimli connector'lar).
async fn attach_cpu_mem(conn: &dyn Connector, processes: &mut [Value]) {
    let pids: Vec<String> = processes
        .iter()
        .filter(|p| gi(p, "pid") > 0)
        .map(|p| gi(p, "pid").to_string())
        .collect();
    if pids.is_empty() {
        return;
    }
    let cmd = format!(
        "ps -o pid=,%cpu=,rss= -p {} 2>/dev/null || true",
        pids.join(",")
    );
    let Ok(out) = conn.exec(&cmd, None).await else {
        return;
    };
    let mut by_pid: HashMap<i64, (f64, f64)> = HashMap::new();
    for line in out.stdout.trim().lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 {
            if let Ok(pid) = parts[0].parse::<i64>() {
                let cpu = parts[1].parse::<f64>().unwrap_or(0.0);
                let rss = parts[2].parse::<f64>().unwrap_or(0.0);
                let mem_mb = ((rss / 1024.0) * 10.0).round() / 10.0;
                by_pid.insert(pid, (cpu, mem_mb));
            }
        }
    }
    for p in processes.iter_mut() {
        let pid = gi(p, "pid");
        if let Some((cpu, mem)) = by_pid.get(&pid) {
            if let Some(obj) = p.as_object_mut() {
                obj.insert("cpu".into(), json!(cpu));
                obj.insert("memMb".into(), json!(mem));
            }
        }
    }
}

// --- Genel API --------------------------------------------------------------

fn require_value(r: &crate::supervisor::connector::CallResult) -> AppResult<Value> {
    if let Some(e) = &r.error {
        return Err(AppError::new(e.clone()));
    }
    Ok(r.value.clone().unwrap_or(Value::Null))
}

pub async fn snapshot(rt: &SupervisorRuntime, server: &Value) -> AppResult<Value> {
    let server_id = gs(server, "id");
    let conn = create_connector(server)?;

    let res = conn
        .multicall(vec![
            Call::new("supervisor.getState"),
            Call::new("supervisor.getAllProcessInfo"),
        ])
        .await?;
    let state = require_value(&res[0])?;
    let info = require_value(&res[1])?;

    let mut processes: Vec<Value> = info
        .as_array()
        .map(|a| a.iter().map(normalize_process).collect())
        .unwrap_or_default();

    if conn.supports_exec() {
        attach_cpu_mem(conn.as_ref(), &mut processes).await;
    }

    let cfg = get_config_map(rt, conn.as_ref(), &server_id).await;
    if !cfg.is_empty() {
        for p in processes.iter_mut() {
            let full = gs(p, "fullName");
            if let Some(c) = cfg.get(&full) {
                if let Some(obj) = p.as_object_mut() {
                    obj.insert("config".into(), c.clone());
                }
            }
        }
    }

    track_restarts(rt, &server_id, &mut processes);
    conn.close().await;

    let running = processes
        .iter()
        .filter(|p| gi(p, "statecode") == 20)
        .count();
    let stopped = processes.iter().filter(|p| gi(p, "statecode") == 0).count();
    let fatal = processes
        .iter()
        .filter(|p| gi(p, "statecode") == 200)
        .count();
    let other = processes
        .iter()
        .filter(|p| !matches!(gi(p, "statecode"), 0 | 20 | 200))
        .count();

    Ok(json!({
        "state": state,
        "processes": processes,
        "groups": group_by(&processes),
        "summary": {
            "total": processes.len(),
            "running": running,
            "stopped": stopped,
            "fatal": fatal,
            "other": other,
        },
    }))
}

// Bağlantıyı bir kez kurup tek çağrı yapan yardımcı.
async fn one(server: &Value, method: &str, params: Vec<Value>) -> AppResult<Value> {
    let conn = create_connector(server)?;
    let r = conn.call(method, params).await;
    conn.close().await;
    r
}

#[allow(dead_code)] // Faz 4B: process detay komutu
pub async fn get_process_info(server: &Value, full_name: &str) -> AppResult<Value> {
    let p = one(server, "supervisor.getProcessInfo", vec![json!(full_name)]).await?;
    Ok(normalize_process(&p))
}

pub async fn start(server: &Value, full_name: &str) -> AppResult<Value> {
    one(
        server,
        "supervisor.startProcess",
        vec![json!(full_name), json!(true)],
    )
    .await
}
pub async fn stop(server: &Value, full_name: &str) -> AppResult<Value> {
    one(
        server,
        "supervisor.stopProcess",
        vec![json!(full_name), json!(true)],
    )
    .await
}
/// Atomik restart yok — stop ("not running" yut) sonra start.
pub async fn restart(server: &Value, full_name: &str) -> AppResult<Value> {
    let conn = create_connector(server)?;
    if let Err(e) = conn
        .call(
            "supervisor.stopProcess",
            vec![json!(full_name), json!(true)],
        )
        .await
    {
        let m = e.error.to_lowercase();
        if !m.contains("not running") && !m.contains("not_running") {
            conn.close().await;
            return Err(e);
        }
    }
    let r = conn
        .call(
            "supervisor.startProcess",
            vec![json!(full_name), json!(true)],
        )
        .await;
    conn.close().await;
    r
}

pub async fn signal(server: &Value, full_name: &str, sig: &str) -> AppResult<Value> {
    one(
        server,
        "supervisor.signalProcess",
        vec![json!(full_name), json!(sig)],
    )
    .await
}
pub async fn send_stdin(server: &Value, full_name: &str, chars: &str) -> AppResult<Value> {
    one(
        server,
        "supervisor.sendProcessStdin",
        vec![json!(full_name), json!(chars)],
    )
    .await
}
pub async fn clear_logs(server: &Value, full_name: &str) -> AppResult<Value> {
    one(
        server,
        "supervisor.clearProcessLogs",
        vec![json!(full_name)],
    )
    .await
}

pub async fn start_group(server: &Value, group: &str) -> AppResult<Value> {
    one(
        server,
        "supervisor.startProcessGroup",
        vec![json!(group), json!(true)],
    )
    .await
}
pub async fn stop_group(server: &Value, group: &str) -> AppResult<Value> {
    one(
        server,
        "supervisor.stopProcessGroup",
        vec![json!(group), json!(true)],
    )
    .await
}
pub async fn restart_group(server: &Value, group: &str) -> AppResult<Value> {
    let conn = create_connector(server)?;
    let _ = conn
        .call(
            "supervisor.stopProcessGroup",
            vec![json!(group), json!(true)],
        )
        .await;
    let r = conn
        .call(
            "supervisor.startProcessGroup",
            vec![json!(group), json!(true)],
        )
        .await;
    conn.close().await;
    r
}
pub async fn signal_group(server: &Value, group: &str, sig: &str) -> AppResult<Value> {
    one(
        server,
        "supervisor.signalProcessGroup",
        vec![json!(group), json!(sig)],
    )
    .await
}

pub async fn start_all(server: &Value) -> AppResult<Value> {
    one(server, "supervisor.startAllProcesses", vec![json!(true)]).await
}
pub async fn stop_all(server: &Value) -> AppResult<Value> {
    one(server, "supervisor.stopAllProcesses", vec![json!(true)]).await
}
pub async fn restart_all(server: &Value) -> AppResult<Value> {
    let conn = create_connector(server)?;
    let _ = conn
        .call("supervisor.stopAllProcesses", vec![json!(true)])
        .await;
    let r = conn
        .call("supervisor.startAllProcesses", vec![json!(true)])
        .await;
    conn.close().await;
    r
}
pub async fn signal_all(server: &Value, sig: &str) -> AppResult<Value> {
    one(server, "supervisor.signalAllProcesses", vec![json!(sig)]).await
}
pub async fn clear_all_logs(server: &Value) -> AppResult<Value> {
    one(server, "supervisor.clearAllProcessLogs", vec![]).await
}

/// Süreç logunu offset'ten kuyruklar → { data, offset, overflow }.
#[allow(dead_code)] // Faz 4B/5: log okuma/tail komutu
pub async fn tail_log(
    server: &Value,
    full_name: &str,
    channel: &str,
    offset: i64,
    length: i64,
) -> AppResult<Value> {
    let method = if channel == "stderr" {
        "supervisor.tailProcessStderrLog"
    } else {
        "supervisor.tailProcessStdoutLog"
    };
    let res = one(
        server,
        method,
        vec![json!(full_name), json!(offset), json!(length)],
    )
    .await?;
    let (data, new_offset, overflow) = match res.as_array() {
        Some(a) if a.len() >= 3 => (
            a[0].as_str().unwrap_or("").to_string(),
            a[1].as_i64().unwrap_or(offset),
            a[2].as_bool().unwrap_or(false),
        ),
        _ => (res.as_str().unwrap_or("").to_string(), offset, false),
    };
    Ok(json!({ "data": data, "offset": new_offset, "overflow": overflow }))
}

// --- Daemon ----------------------------------------------------------------

pub async fn daemon_info(server: &Value) -> AppResult<Value> {
    let conn = create_connector(server)?;
    let res = conn
        .multicall(vec![
            Call::new("supervisor.getSupervisorVersion"),
            Call::new("supervisor.getPID"),
            Call::new("supervisor.getIdentification"),
            Call::new("supervisor.getAPIVersion"),
        ])
        .await?;
    conn.close().await;
    Ok(json!({
        "version": res.first().and_then(|r| r.value.clone()).unwrap_or(Value::Null),
        "pid": res.get(1).and_then(|r| r.value.clone()).unwrap_or(Value::Null),
        "identification": res.get(2).and_then(|r| r.value.clone()).unwrap_or(Value::Null),
        "apiVersion": res.get(3).and_then(|r| r.value.clone()).unwrap_or(Value::Null),
    }))
}

/// `supervisorctl update` benzeri: reread + grup ekle/çıkar.
pub async fn reload_config(server: &Value) -> AppResult<Value> {
    let conn = create_connector(server)?;
    let result = conn.call("supervisor.reloadConfig", vec![]).await?;
    // result = [[added, changed, removed]]
    let inner = result.get(0).cloned().unwrap_or(Value::Array(vec![]));
    let arr = inner.as_array().cloned().unwrap_or_default();
    let as_vec = |i: usize| -> Vec<Value> {
        arr.get(i)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let added = as_vec(0);
    let changed = as_vec(1);
    let removed = as_vec(2);

    let to_remove: Vec<Value> = removed.iter().chain(&changed).cloned().collect();
    let to_add: Vec<Value> = changed.iter().chain(&added).cloned().collect();
    if !to_remove.is_empty() {
        let calls = to_remove
            .iter()
            .map(|g| Call::with("supervisor.removeProcessGroup", vec![g.clone()]))
            .collect();
        let _ = conn.multicall(calls).await;
    }
    if !to_add.is_empty() {
        let calls = to_add
            .iter()
            .map(|g| Call::with("supervisor.addProcessGroup", vec![g.clone()]))
            .collect();
        let _ = conn.multicall(calls).await;
    }
    conn.close().await;
    Ok(json!({ "added": added, "changed": changed, "removed": removed }))
}

pub async fn restart_daemon(server: &Value) -> AppResult<Value> {
    one(server, "supervisor.restart", vec![]).await
}
pub async fn shutdown_daemon(server: &Value) -> AppResult<Value> {
    one(server, "supervisor.shutdown", vec![]).await
}
pub async fn clear_daemon_log(server: &Value) -> AppResult<Value> {
    one(server, "supervisor.clearLog", vec![]).await
}

// --- Loglar (offset okuma / indirme) ---------------------------------------

/// docker connector offset takibi yapmaz (supervisorctl tail anlık).
pub fn supports_log_offset(server: &Value) -> bool {
    gs(server, "method") != "docker"
}

/// Ana supervisord log'unun son ~16 KB'lık anlık görüntüsü.
pub async fn tail_daemon_log(server: &Value) -> AppResult<String> {
    let data = one(server, "supervisor.readLog", vec![json!(0), json!(0)]).await?;
    let text = data.as_str().unwrap_or("").to_string();
    if text.len() > 16384 {
        let mut start = text.len() - 16384;
        while !text.is_char_boundary(start) {
            start += 1;
        }
        Ok(text[start..].to_string())
    } else {
        Ok(text)
    }
}

/// Süreç logundan bir aralığı okur (offset tabanlı; geriye kaydırma için).
pub async fn read_process_log(
    server: &Value,
    full_name: &str,
    channel: &str,
    offset: i64,
    length: i64,
) -> AppResult<Value> {
    let method = if channel == "stderr" {
        "supervisor.readProcessStderrLog"
    } else {
        "supervisor.readProcessStdoutLog"
    };
    let data = one(
        server,
        method,
        vec![json!(full_name), json!(offset), json!(length)],
    )
    .await?;
    let text = data.as_str().unwrap_or("").to_string();
    Ok(json!({ "data": text, "startOffset": offset, "length": length }))
}

/// İndirme için log'u baştan, parçalar hâlinde toplar (maxBytes tavanı).
pub async fn download_process_log(
    server: &Value,
    full_name: &str,
    channel: &str,
) -> AppResult<Value> {
    const MAX_BYTES: usize = 20 * 1024 * 1024;
    const CHUNK: i64 = 65536;

    if !supports_log_offset(server) {
        let tail = tail_log(server, full_name, channel, 0, 16384).await?;
        return Ok(json!({
            "data": tail.get("data").cloned().unwrap_or(Value::String(String::new())),
            "truncated": tail.get("overflow").and_then(Value::as_bool).unwrap_or(false),
        }));
    }

    let mut offset = 0i64;
    let mut out = String::new();
    let mut truncated = false;
    loop {
        let r = read_process_log(server, full_name, channel, offset, CHUNK).await?;
        let data = r.get("data").and_then(Value::as_str).unwrap_or("");
        if data.is_empty() {
            break;
        }
        out.push_str(data);
        let n = data.len() as i64;
        offset += n;
        if n < CHUNK {
            break;
        }
        if out.len() > MAX_BYTES {
            truncated = true;
            let mut start = out.len() - MAX_BYTES;
            while !out.is_char_boundary(start) {
                start += 1;
            }
            out = out[start..].to_string();
            break;
        }
    }
    Ok(json!({ "data": out, "truncated": truncated }))
}

// --- Host metrikleri (shell connector'lar) ---------------------------------

const HOST_SCRIPT: &str = r#"
echo "LOAD=$(cat /proc/loadavg 2>/dev/null | awk '{print $1","$2","$3}')"
echo "MEM=$(free -m 2>/dev/null | awk '/^Mem:/{print $2","$3}')"
echo "DISK=$(df -P / 2>/dev/null | awk 'NR==2{print $2","$3","$5}')"
echo "CORES=$(nproc 2>/dev/null || echo 1)"
echo "UP=$(awk '{print int($1)}' /proc/uptime 2>/dev/null)"
"#;

pub async fn host_metrics(server: &Value) -> AppResult<Value> {
    let conn = create_connector(server)?;
    if !conn.supports_exec() {
        conn.close().await;
        return Ok(Value::Null);
    }
    let out = match conn.exec(HOST_SCRIPT, None).await {
        Ok(o) => o,
        Err(_) => {
            conn.close().await;
            return Ok(Value::Null);
        }
    };
    conn.close().await;

    let mut kv: HashMap<String, String> = HashMap::new();
    for line in out.stdout.split('\n') {
        if let Some(i) = line.find('=') {
            if i > 0 {
                kv.insert(line[..i].to_string(), line[i + 1..].trim().to_string());
            }
        }
    }
    let nums = |s: &str| -> Vec<f64> {
        s.split(',')
            .map(|x| x.trim().parse::<f64>().unwrap_or(f64::NAN))
            .collect()
    };
    let load = nums(kv.get("LOAD").map(String::as_str).unwrap_or(""));
    let mem = nums(kv.get("MEM").map(String::as_str).unwrap_or(""));
    let disk_raw = kv.get("DISK").cloned().unwrap_or_default();
    let disk_parts: Vec<&str> = disk_raw.split(',').collect();

    let load_v = if load.len() == 3 && !load.iter().any(|v| v.is_nan()) {
        json!({ "one": load[0], "five": load[1], "fifteen": load[2] })
    } else {
        Value::Null
    };
    let mem_v = if mem.len() == 2 && !mem.iter().any(|v| v.is_nan()) {
        json!({ "totalMb": mem[0], "usedMb": mem[1] })
    } else {
        Value::Null
    };
    let disk_v = if disk_parts.len() == 3 {
        json!({
            "totalKb": disk_parts[0].trim().parse::<i64>().unwrap_or(0),
            "usedKb": disk_parts[1].trim().parse::<i64>().unwrap_or(0),
            "usePct": disk_parts[2].trim().trim_end_matches('%').parse::<i64>().unwrap_or(0),
        })
    } else {
        Value::Null
    };

    Ok(json!({
        "load": load_v,
        "cores": kv.get("CORES").and_then(|s| s.parse::<i64>().ok()),
        "mem": mem_v,
        "disk": disk_v,
        "uptimeSec": kv.get("UP").and_then(|s| s.parse::<i64>().ok()),
    }))
}
