//! Docker connector. Container İÇİNDEKİ supervisord'a port açmadan `docker exec
//! supervisorctl` ile ulaşır ve metin çıktısını XML-RPC connector'larının
//! döndürdüğü şekillere geri eşler — böylece Helmio'nun geri kalanı değişmez.
//!
//! Eski dockerode (Docker Engine API) yerine burada sistem `docker` CLI'si
//! kullanılır; hedef daemon `DOCKER_HOST` ile seçilir (unix:// veya tcp://).
//! Alanlar: container, connection(socket|tcp), dockerSocket, dockerHost,
//! dockerPort, confPath.

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::process::Command;

use crate::error::{AppError, AppResult};
use crate::supervisor::connector::{field_int, field_opt, field_str, Connector, ExecOutput};

fn name_to_code(name: &str) -> i64 {
    match name {
        "STOPPED" => 0,
        "STARTING" => 10,
        "RUNNING" => 20,
        "BACKOFF" => 30,
        "STOPPING" => 40,
        "EXITED" => 100,
        "FATAL" => 200,
        _ => 1000,
    }
}

fn parse_pid(rest: &str) -> i64 {
    if let Some(idx) = rest.find("pid") {
        let after = rest[idx + 3..].trim_start();
        let num: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        return num.parse().unwrap_or(0);
    }
    0
}

fn parse_uptime_seconds(rest: &str) -> i64 {
    let Some(idx) = rest.find("uptime") else {
        return 0;
    };
    let after = rest[idx + 6..].trim_start();
    let mut days = 0i64;
    let hms_part = if after.contains("day") {
        let numstr: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        days = numstr.parse().unwrap_or(0);
        after
            .find(',')
            .map(|c| after[c + 1..].trim_start())
            .unwrap_or("")
    } else {
        after
    };
    let hms: String = hms_part
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == ':')
        .collect();
    let nums: Vec<i64> = hms.split(':').filter_map(|s| s.parse().ok()).collect();
    if nums.len() == 3 {
        days * 86400 + nums[0] * 3600 + nums[1] * 60 + nums[2]
    } else {
        0
    }
}

/// "web:app RUNNING pid 1234, uptime 1:23:45" → normalize edilmiş process struct.
fn parse_status_line(line: &str) -> Option<Value> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut it = trimmed.split_whitespace();
    let full = it.next()?;
    let statename = it.next()?;
    // İkinci token büyük harfli durum adı olmalı (JS regex [A-Z]+).
    if statename.is_empty() || !statename.chars().all(|c| c.is_ascii_uppercase()) {
        return None;
    }
    let rest = trimmed
        .split_once(statename)
        .map(|(_, r)| r.trim())
        .unwrap_or("");
    let (group, name) = match full.split_once(':') {
        Some((g, n)) => (g.to_string(), n.to_string()),
        None => (full.to_string(), full.to_string()),
    };
    let state = name_to_code(statename);
    let now = chrono::Utc::now().timestamp();
    let uptime = parse_uptime_seconds(rest);
    Some(json!({
        "name": name,
        "group": group,
        "state": state,
        "statename": statename,
        "pid": parse_pid(rest),
        "description": rest,
        "start": if state == 20 { now - uptime } else { 0 },
        "stop": 0,
        "now": now,
        "exitstatus": 0,
        "spawnerr": "",
        "logfile": "",
        "stdout_logfile": "",
        "stderr_logfile": "",
    }))
}

fn looks_like_daemon_down(stderr: &str) -> bool {
    let s = stderr.to_lowercase();
    [
        "refused",
        "no such file",
        "shutdown_state",
        "filenotfounderror",
        "connection",
    ]
    .iter()
    .any(|k| s.contains(k))
}

pub struct DockerConnector {
    container: String,
    conf_args: Vec<String>,
    docker_host: String,
}

impl DockerConnector {
    pub fn new(server: &Value) -> AppResult<Self> {
        let container = field_str(server, "container", "");
        if container.is_empty() {
            return Err(AppError::new("Container adı tanımlı değil."));
        }
        let docker_host = if field_str(server, "connection", "socket") == "tcp" {
            format!(
                "tcp://{}:{}",
                field_str(server, "dockerHost", "127.0.0.1"),
                field_int(server, "dockerPort", 2375)
            )
        } else {
            format!(
                "unix://{}",
                field_str(server, "dockerSocket", "/var/run/docker.sock")
            )
        };
        let conf_args = match field_opt(server, "confPath") {
            Some(p) => vec!["-c".to_string(), p],
            None => vec![],
        };
        Ok(Self {
            container,
            conf_args,
            docker_host,
        })
    }

    /// `docker exec <container> supervisorctl <conf> <args>` çalıştırır.
    async fn ctl(&self, args: &[&str]) -> AppResult<(String, String, i32)> {
        let mut cmd = Command::new("docker");
        cmd.env("DOCKER_HOST", &self.docker_host);
        cmd.arg("exec").arg(&self.container).arg("supervisorctl");
        for a in &self.conf_args {
            cmd.arg(a);
        }
        for a in args {
            cmd.arg(a);
        }
        let out = cmd.output().await.map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => {
                AppError::new("Docker CLI bulunamadı (PATH'te `docker` var mı?).")
            }
            _ => AppError::new(format!("Docker hatası: {e}")),
        })?;
        Ok((
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
            out.status.code().unwrap_or(0),
        ))
    }
}

fn p_str(params: &[Value], i: usize) -> String {
    params
        .get(i)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

#[async_trait]
impl Connector for DockerConnector {
    async fn call(&self, method: &str, params: Vec<Value>) -> AppResult<Value> {
        match method {
            "supervisor.getSupervisorVersion" => {
                let (out, err, code) = self.ctl(&["version"]).await?;
                if code != 0 || looks_like_daemon_down(&err) {
                    return Err(AppError::new(if err.is_empty() {
                        "supervisord'a ulaşılamadı.".into()
                    } else {
                        err
                    }));
                }
                Ok(Value::String(out))
            }
            "supervisor.getIdentification" => Ok(Value::String(self.container.clone())),
            "supervisor.getState" => {
                let (_, err, _) = self.ctl(&["status"]).await?;
                if looks_like_daemon_down(&err) {
                    return Err(AppError::new(if err.is_empty() {
                        "supervisord kapalı.".into()
                    } else {
                        err
                    }));
                }
                Ok(json!({ "statecode": 1, "statename": "RUNNING" }))
            }
            "supervisor.getAllProcessInfo" => {
                let (out, err, _) = self.ctl(&["status"]).await?;
                if looks_like_daemon_down(&err) {
                    return Err(AppError::new(if err.is_empty() {
                        "supervisord'a ulaşılamadı.".into()
                    } else {
                        err
                    }));
                }
                let list: Vec<Value> = out.lines().filter_map(parse_status_line).collect();
                Ok(Value::Array(list))
            }
            "supervisor.getProcessInfo" => {
                let (out, err, _) = self.ctl(&["status", &p_str(&params, 0)]).await?;
                if looks_like_daemon_down(&err) {
                    return Err(AppError::new(err));
                }
                parse_status_line(out.lines().next().unwrap_or("")).ok_or_else(|| {
                    AppError::new(format!("İşlem bulunamadı: {}", p_str(&params, 0)))
                })
            }
            "supervisor.startProcess" => {
                self.ctl(&["start", &p_str(&params, 0)]).await?;
                Ok(Value::Bool(true))
            }
            "supervisor.stopProcess" => {
                self.ctl(&["stop", &p_str(&params, 0)]).await?;
                Ok(Value::Bool(true))
            }
            "supervisor.startProcessGroup" => {
                self.ctl(&["start", &format!("{}:*", p_str(&params, 0))])
                    .await?;
                Ok(Value::Bool(true))
            }
            "supervisor.stopProcessGroup" => {
                self.ctl(&["stop", &format!("{}:*", p_str(&params, 0))])
                    .await?;
                Ok(Value::Bool(true))
            }
            "supervisor.startAllProcesses" => {
                self.ctl(&["start", "all"]).await?;
                Ok(Value::Bool(true))
            }
            "supervisor.stopAllProcesses" => {
                self.ctl(&["stop", "all"]).await?;
                Ok(Value::Bool(true))
            }
            "supervisor.tailProcessStdoutLog" | "supervisor.tailProcessStderrLog" => {
                let channel = if method.ends_with("StderrLog") {
                    "stderr"
                } else {
                    "stdout"
                };
                let name = p_str(&params, 0);
                let bytes = params.get(2).and_then(Value::as_i64).unwrap_or(16384);
                let (out, _, _) = self
                    .ctl(&["tail", &format!("-{bytes}"), &name, channel])
                    .await?;
                Ok(json!([out, 0, false]))
            }
            "supervisor.clearProcessLogs" => {
                self.ctl(&["clear", &p_str(&params, 0)]).await?;
                Ok(Value::Bool(true))
            }
            "supervisor.signalProcess" => {
                let sig = p_str(&params, 1);
                self.ctl(&["signal", &sig, &p_str(&params, 0)]).await?;
                Ok(Value::Bool(true))
            }
            "supervisor.getPID" => {
                let (out, _, _) = self.ctl(&["pid"]).await?;
                Ok(Value::from(out.trim().parse::<i64>().unwrap_or(0)))
            }
            "supervisor.reloadConfig" => {
                self.ctl(&["reread"]).await?;
                self.ctl(&["update"]).await?;
                Ok(json!([[[], [], []]]))
            }
            "supervisor.addProcessGroup" | "supervisor.removeProcessGroup" => Ok(Value::Bool(true)),
            "supervisor.restart" => {
                self.ctl(&["reload"]).await?;
                Ok(Value::Bool(true))
            }
            "supervisor.shutdown" => {
                self.ctl(&["shutdown"]).await?;
                Ok(Value::Bool(true))
            }
            "supervisor.readLog" => {
                let bytes = params.get(1).and_then(Value::as_i64).unwrap_or(16384);
                let (out, _, _) = self.ctl(&["maintail", &format!("-{bytes}")]).await?;
                Ok(Value::String(out))
            }
            "supervisor.clearLog" => Ok(Value::Bool(true)),
            other => Err(AppError::new(format!(
                "Docker connector bu methodu desteklemiyor: {other}"
            ))),
        }
    }

    fn supports_exec(&self) -> bool {
        true
    }

    async fn exec(&self, command: &str, input: Option<&str>) -> AppResult<ExecOutput> {
        use tokio::io::AsyncWriteExt;

        let mut cmd = Command::new("docker");
        cmd.env("DOCKER_HOST", &self.docker_host);
        cmd.arg("exec").arg("--user").arg("root");
        if input.is_some() {
            cmd.arg("-i");
        }
        cmd.arg(&self.container).arg("sh").arg("-c").arg(command);
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| AppError::new(format!("docker exec başlatılamadı: {e}")))?;
        if let Some(data) = input {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(data.as_bytes()).await;
                let _ = stdin.shutdown().await;
            }
        }
        let out = child
            .wait_with_output()
            .await
            .map_err(|e| AppError::new(format!("docker exec çalıştırılamadı: {e}")))?;
        Ok(ExecOutput {
            stdout: String::from_utf8_lossy(&out.stdout).trim().to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
            code: out.status.code().unwrap_or(0),
        })
    }
}
