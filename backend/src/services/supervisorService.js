import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getConnector } from '../connectors/index.js';
import { serverStore } from '../store/serverStore.js';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Canonical listener script shipped with the repo (backend/src/services -> repo/eventlistener).
const LISTENER_SRC = path.resolve(__dirname, '..', '..', '..', 'eventlistener', 'helmio_eventlistener.py');

/**
 * High-level Supervisor operations on top of a connector. All methods take the
 * stored server definition and return plain JSON-friendly data for the API /
 * socket layers.
 *
 * Supervisor process state codes (numeric `state` field):
 *   0 STOPPED, 10 STARTING, 20 RUNNING, 30 BACKOFF,
 *   40 STOPPING, 100 EXITED, 200 FATAL, 1000 UNKNOWN
 */
export const STATE_NAMES = {
  0: 'STOPPED',
  10: 'STARTING',
  20: 'RUNNING',
  30: 'BACKOFF',
  40: 'STOPPING',
  100: 'EXITED',
  200: 'FATAL',
  1000: 'UNKNOWN',
};

function normalizeProcess(p) {
  // supervisord names: "group:name". A program without an explicit group has
  // group === name.
  return {
    name: p.name,
    group: p.group,
    fullName: p.group && p.group !== p.name ? `${p.group}:${p.name}` : p.name,
    statecode: p.state,
    statename: p.statename || STATE_NAMES[p.state] || 'UNKNOWN',
    description: p.description,
    pid: p.pid,
    start: p.start,
    stop: p.stop,
    now: p.now,
    uptime: p.start && p.now && p.state === 20 ? p.now - p.start : 0,
    exitstatus: p.exitstatus,
    spawnerr: p.spawnerr,
    logfile: p.logfile,
    stdout_logfile: p.stdout_logfile,
    stderr_logfile: p.stderr_logfile,
  };
}

/** Group flat process list by supervisord group for the UI tree/table. */
function groupBy(processes) {
  const groups = new Map();
  for (const p of processes) {
    if (!groups.has(p.group)) groups.set(p.group, []);
    groups.get(p.group).push(p);
  }
  return [...groups.entries()].map(([name, procs]) => {
    const running = procs.filter((p) => p.statecode === 20).length;
    return {
      group: name,
      total: procs.length,
      running,
      processes: procs,
    };
  });
}

// Per-server config cache (getAllConfigInfo rarely changes). 30s TTL.
const configCache = new Map(); // serverId -> { at, byName }

async function getConfigMap(server, connector) {
  const cached = configCache.get(server.id);
  if (cached && Date.now() - cached.at < 30000) return cached.byName;
  let list = [];
  try {
    list = await connector.call('supervisor.getAllConfigInfo');
  } catch {
    list = []; // not supported (e.g. docker) — cache empty to avoid retry spam
  }
  const byName = {};
  for (const c of list || []) {
    const full = c.group && c.group !== c.name ? `${c.group}:${c.name}` : c.name;
    byName[full] = {
      command: c.command,
      autostart: c.autostart,
      autorestart: c.autorestart,
      priority: c.process_prio ?? c.priority,
      startsecs: c.startsecs,
      startretries: c.startretries,
    };
  }
  configCache.set(server.id, { at: Date.now(), byName });
  return byName;
}

// Single-quote a value for safe shell use.
function shArg(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Restrict config file access to supervisor config locations.
function isAllowedConfigPath(p) {
  if (typeof p !== 'string' || p.includes('..')) return false;
  if (!(p.endsWith('.conf') || p.endsWith('.ini'))) return false;
  const prefixes = ['/etc/supervisor/', '/etc/supervisord.d/', '/etc/supervisor.d/', '/usr/local/etc/'];
  const exact = ['/etc/supervisord.conf'];
  return exact.includes(p) || prefixes.some((pre) => p.startsWith(pre));
}

// Per-process restart history (pid changes over time) for restart count + flapping.
const procHistory = new Map(); // "serverId:fullName" -> { lastPid, restarts, events: number[] }

function trackRestarts(serverId, processes) {
  const now = Date.now();
  for (const p of processes) {
    const key = `${serverId}:${p.fullName}`;
    let h = procHistory.get(key);
    if (!h) {
      h = { lastPid: p.pid, restarts: 0, events: [] };
      procHistory.set(key, h);
    } else if (p.pid && p.pid !== h.lastPid) {
      // pid changed to a new value → a (re)start occurred
      h.restarts += 1;
      h.events.push(now);
      h.events = h.events.filter((t) => now - t < 300000); // keep 5 min
    }
    h.lastPid = p.pid;
    p.restarts = h.restarts;
    // flapping: 3+ restarts within the last 60s
    p.flapping = h.events.filter((t) => now - t < 60000).length >= 3;
  }
}

export const supervisorService = {
  async ping(server) {
    return getConnector(server).ping();
  },

  /** Full snapshot used by the realtime poller and the process table. */
  async snapshot(server) {
    const connector = getConnector(server);
    // One round-trip for state + process list (system.multicall where supported).
    const [stateR, infoR] = await connector.multicall([
      { methodName: 'supervisor.getState' },
      { methodName: 'supervisor.getAllProcessInfo' },
    ]);
    if (stateR.error) throw new Error(stateR.error);
    if (infoR.error) throw new Error(infoR.error);
    const state = stateR.value;
    const info = infoR.value;
    let processes = (info || []).map(normalizeProcess);

    // Attach CPU% / memory for connectors with shell access (local/ssh/docker).
    if (connector.supportsExec && connector.supportsExec()) {
      const pids = processes.filter((p) => p.pid > 0).map((p) => p.pid);
      if (pids.length) {
        try {
          const { stdout } = await connector.exec(
            `ps -o pid=,%cpu=,rss= -p ${pids.join(',')} 2>/dev/null || true`
          );
          const byPid = {};
          for (const line of stdout.trim().split('\n')) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 3) {
              const pid = Number(parts[0]);
              byPid[pid] = { cpu: Number(parts[1]), memMb: Math.round((Number(parts[2]) / 1024) * 10) / 10 };
            }
          }
          processes = processes.map((p) => (byPid[p.pid] ? { ...p, ...byPid[p.pid] } : p));
        } catch { /* ps unavailable in this environment */ }
      }
    }

    // Attach config (command, autostart, priority…) when the daemon exposes it.
    const cfg = await getConfigMap(server, connector);
    if (Object.keys(cfg).length) {
      processes = processes.map((p) => (cfg[p.fullName] ? { ...p, config: cfg[p.fullName] } : p));
    }

    // Restart count + flapping (compares pid against previous polls)
    trackRestarts(server.id, processes);

    return {
      state, // { statecode, statename }
      processes,
      groups: groupBy(processes),
      summary: {
        total: processes.length,
        running: processes.filter((p) => p.statecode === 20).length,
        stopped: processes.filter((p) => p.statecode === 0).length,
        fatal: processes.filter((p) => p.statecode === 200).length,
        other: processes.filter((p) => ![0, 20, 200].includes(p.statecode)).length,
      },
    };
  },

  async getProcessInfo(server, fullName) {
    const p = await getConnector(server).call('supervisor.getProcessInfo', [fullName]);
    return normalizeProcess(p);
  },

  async start(server, fullName, wait = true) {
    return getConnector(server).call('supervisor.startProcess', [fullName, wait]);
  },

  async stop(server, fullName, wait = true) {
    return getConnector(server).call('supervisor.stopProcess', [fullName, wait]);
  },

  /** Supervisor has no atomic restart — stop (ignoring "not running") then start. */
  async restart(server, fullName, wait = true) {
    const connector = getConnector(server);
    try {
      await connector.call('supervisor.stopProcess', [fullName, wait]);
    } catch (err) {
      // NOT_RUNNING (faultCode 70) is fine when restarting a stopped process.
      if (!/not running|NOT_RUNNING/i.test(err.message)) throw err;
    }
    return connector.call('supervisor.startProcess', [fullName, wait]);
  },

  async startGroup(server, groupName, wait = true) {
    return getConnector(server).call('supervisor.startProcessGroup', [groupName, wait]);
  },

  async stopGroup(server, groupName, wait = true) {
    return getConnector(server).call('supervisor.stopProcessGroup', [groupName, wait]);
  },

  async restartGroup(server, groupName, wait = true) {
    const connector = getConnector(server);
    await connector.call('supervisor.stopProcessGroup', [groupName, wait]).catch(() => {});
    return connector.call('supervisor.startProcessGroup', [groupName, wait]);
  },

  async startAll(server, wait = true) {
    return getConnector(server).call('supervisor.startAllProcesses', [wait]);
  },

  async stopAll(server, wait = true) {
    return getConnector(server).call('supervisor.stopAllProcesses', [wait]);
  },

  async restartAll(server, wait = true) {
    const connector = getConnector(server);
    await connector.call('supervisor.stopAllProcesses', [wait]).catch(() => {});
    return connector.call('supervisor.startAllProcesses', [wait]);
  },

  /**
   * Tail a process log. Returns { data, offset, overflow }.
   * Pass the returned offset on the next call to fetch only new bytes (append).
   */
  async tailLog(server, fullName, channel = 'stdout', offset = 0, length = 16384) {
    const method = channel === 'stderr'
      ? 'supervisor.tailProcessStderrLog'
      : 'supervisor.tailProcessStdoutLog';
    const res = await getConnector(server).call(method, [fullName, offset, length]);
    // XML-RPC returns [bytes, offset, overflow]
    const [data, newOffset, overflow] = Array.isArray(res) ? res : [res, offset, false];
    return { data: data || '', offset: newOffset ?? offset, overflow: !!overflow };
  },

  async clearLogs(server, fullName) {
    return getConnector(server).call('supervisor.clearProcessLogs', [fullName]);
  },

  /** Send a signal (e.g. HUP, USR1, TERM) to a process. */
  async signal(server, fullName, sig) {
    return getConnector(server).call('supervisor.signalProcess', [fullName, sig]);
  },

  /** Send a signal to every process in a group. */
  async signalGroup(server, groupName, sig) {
    return getConnector(server).call('supervisor.signalProcessGroup', [groupName, sig]);
  },

  /** Send a signal to all processes. */
  async signalAll(server, sig) {
    return getConnector(server).call('supervisor.signalAllProcesses', [sig]);
  },

  /** Clear stdout/stderr logs for every process. */
  async clearAllLogs(server) {
    return getConnector(server).call('supervisor.clearAllProcessLogs');
  },

  /** Write to a process's stdin (XML-RPC connectors). */
  async sendStdin(server, fullName, chars) {
    return getConnector(server).call('supervisor.sendProcessStdin', [fullName, chars]);
  },

  // --- Daemon-level ---

  async daemonInfo(server) {
    const c = getConnector(server);
    // One round-trip for version + pid + identification + RPC API version.
    const [version, pid, identification, apiVersion] = await c.multicall([
      { methodName: 'supervisor.getSupervisorVersion' },
      { methodName: 'supervisor.getPID' },
      { methodName: 'supervisor.getIdentification' },
      { methodName: 'supervisor.getAPIVersion' },
    ]);
    return {
      version: version.value ?? null,
      pid: pid.value ?? null,
      identification: identification.value ?? null,
      apiVersion: apiVersion.value ?? null,
    };
  },

  /** Apply config changes (like `supervisorctl update`): reread + add/remove groups. */
  async reloadConfig(server) {
    const c = getConnector(server);
    const result = await c.call('supervisor.reloadConfig');
    const [added = [], changed = [], removed = []] = (result && result[0]) || [];
    // Remove (removed + changed) groups, then add (changed + added) groups.
    // Batched into two round-trips while preserving the remove-before-add order.
    const toRemove = [...removed, ...changed];
    const toAdd = [...changed, ...added];
    if (toRemove.length) {
      await c.multicall(toRemove.map((g) => ({ methodName: 'supervisor.removeProcessGroup', params: [g] })));
    }
    if (toAdd.length) {
      await c.multicall(toAdd.map((g) => ({ methodName: 'supervisor.addProcessGroup', params: [g] })));
    }
    return { added, changed, removed };
  },

  async restartDaemon(server) {
    return getConnector(server).call('supervisor.restart');
  },

  async shutdownDaemon(server) {
    return getConnector(server).call('supervisor.shutdown');
  },

  /** Tail the main supervisord log (snapshot of the last ~16 KB). */
  async tailDaemonLog(server) {
    const data = await getConnector(server).call('supervisor.readLog', [0, 0]);
    const text = typeof data === 'string' ? data : '';
    return text.length > 16384 ? text.slice(-16384) : text;
  },

  async clearDaemonLog(server) {
    return getConnector(server).call('supervisor.clearLog');
  },

  // --- Config files (shell connectors) ---

  /** List supervisord config files + the conf.d dir to drop new ones into. */
  async listConfigFiles(server) {
    const c = getConnector(server);
    if (!(c.supportsExec && c.supportsExec())) return { supported: false, files: [], confDir: null };
    const script = `
for d in /etc/supervisor/conf.d /etc/supervisord.d /etc/supervisor.d; do
  [ -d "$d" ] && ls -1 "$d"/*.conf "$d"/*.ini 2>/dev/null
done
for f in /etc/supervisor/supervisord.conf /etc/supervisord.conf /usr/local/etc/supervisord.conf; do
  [ -f "$f" ] && echo "$f"
done
echo "CONFDIR=$(for d in /etc/supervisor/conf.d /etc/supervisord.d /etc/supervisor.d; do [ -d "$d" ] && echo "$d" && break; done)"
`;
    const { stdout } = await c.exec(script);
    const files = [];
    let confDir = null;
    for (const line of stdout.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      if (l.startsWith('CONFDIR=')) confDir = l.slice(8) || null;
      else files.push(l);
    }
    return { supported: true, files: [...new Set(files)], confDir };
  },

  async readConfigFile(server, path) {
    if (!isAllowedConfigPath(path)) throw new Error('İzin verilmeyen dosya yolu.');
    const c = getConnector(server);
    const { stdout, code } = await c.exec(`cat ${shArg(path)} 2>/dev/null`);
    if (code !== 0) throw new Error('Dosya okunamadı.');
    return stdout;
  },

  async writeConfigFile(server, path, content) {
    if (!isAllowedConfigPath(path)) throw new Error('İzin verilmeyen dosya yolu.');
    const c = getConnector(server);
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    const { code, stderr } = await c.exec(`printf %s ${shArg(b64)} | base64 -d > ${shArg(path)}`);
    if (code !== 0) throw new Error(stderr || 'Dosya yazılamadı (yetki gerekebilir).');
    return true;
  },

  /**
   * Build a full `[program:name]` config block from a structured definition.
   * Only fields that are set are emitted, so the file stays clean. Exposed so
   * the UI can preview the exact block before it is written.
   */
  buildProgramBlock(def = {}) {
    const { name, command } = def;
    if (!name || !command) throw new Error('Program adı ve komut gerekli.');
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error('Geçersiz program adı.');

    const lines = [`[program:${name}]`, `command=${command}`];
    const add = (key, val) => {
      if (val === undefined || val === null || val === '') return;
      lines.push(`${key}=${val}`);
    };
    const bool = (v) => (v ? 'true' : 'false');

    add('directory', def.directory);
    add('user', def.user);
    const numprocs = Number(def.numprocs) || 1;
    if (numprocs > 1) {
      add('numprocs', numprocs);
      // A distinct process_name is required when numprocs > 1.
      add('process_name', def.process_name || '%(program_name)s_%(process_num)02d');
    } else if (def.process_name) {
      add('process_name', def.process_name);
    }
    add('priority', def.priority);
    add('umask', def.umask);

    if (def.autostart !== undefined) add('autostart', bool(def.autostart));
    // autorestart may be true/false/unexpected
    if (def.autorestart !== undefined && def.autorestart !== '') {
      add('autorestart', typeof def.autorestart === 'boolean' ? bool(def.autorestart) : def.autorestart);
    }
    add('startsecs', def.startsecs);
    add('startretries', def.startretries);
    add('exitcodes', def.exitcodes);

    add('stopsignal', def.stopsignal);
    add('stopwaitsecs', def.stopwaitsecs);
    if (def.stopasgroup !== undefined) add('stopasgroup', bool(def.stopasgroup));
    if (def.killasgroup !== undefined) add('killasgroup', bool(def.killasgroup));

    if (def.redirect_stderr !== undefined) add('redirect_stderr', bool(def.redirect_stderr));
    add('stdout_logfile', def.stdout_logfile || `/var/log/${name}.log`);
    add('stdout_logfile_maxbytes', def.stdout_logfile_maxbytes);
    add('stdout_logfile_backups', def.stdout_logfile_backups);
    if (!def.redirect_stderr) {
      add('stderr_logfile', def.stderr_logfile || `/var/log/${name}.err`);
      add('stderr_logfile_maxbytes', def.stderr_logfile_maxbytes);
      add('stderr_logfile_backups', def.stderr_logfile_backups);
    }

    // environment: accept an array of {key,value} or a raw KEY="v",KEY2="v2" string
    if (Array.isArray(def.environment) && def.environment.length) {
      const env = def.environment
        .filter((e) => e && e.key)
        .map((e) => `${e.key}="${String(e.value ?? '').replace(/"/g, '\\"')}"`)
        .join(',');
      add('environment', env);
    } else if (typeof def.environment === 'string') {
      add('environment', def.environment);
    }

    return lines.join('\n') + '\n';
  },

  /**
   * Parse the first `[program:name]` section of a .conf into the structured def
   * used by the program builder, so an existing program can be edited as a form.
   * Returns null when no program section is found.
   */
  parseProgramBlock(content) {
    if (typeof content !== 'string') return null;
    const lines = content.split('\n');
    let name = null;
    const kv = {};
    let inSection = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith(';') || line.startsWith('#')) continue;
      const header = /^\[program:([^\]]+)\]$/.exec(line);
      if (header) {
        if (inSection) break; // only the first program section
        name = header[1];
        inSection = true;
        continue;
      }
      if (line.startsWith('[')) { if (inSection) break; else continue; }
      if (!inSection) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      kv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    if (!name) return null;

    const num = (v) => (v != null && v !== '' ? Number(v) : undefined);
    const boolish = (v) => (v == null ? undefined : v === 'true');
    // environment="A="x"",B="y"" -> [{key,value}]
    const env = [];
    if (kv.environment) {
      for (const part of kv.environment.match(/[^,]+="(?:[^"\\]|\\.)*"|[^,]+=[^,]*/g) || []) {
        const i = part.indexOf('=');
        if (i > 0) env.push({ key: part.slice(0, i).trim(), value: part.slice(i + 1).trim().replace(/^"|"$/g, '') });
      }
    }

    return {
      name,
      command: kv.command || '',
      directory: kv.directory || '',
      user: kv.user || '',
      numprocs: num(kv.numprocs) || 1,
      process_name: kv.process_name || '',
      priority: num(kv.priority),
      umask: kv.umask,
      autostart: boolish(kv.autostart) ?? true,
      autorestart: kv.autorestart ?? 'unexpected',
      startsecs: num(kv.startsecs),
      startretries: num(kv.startretries),
      exitcodes: kv.exitcodes,
      stopsignal: kv.stopsignal || 'TERM',
      stopwaitsecs: num(kv.stopwaitsecs),
      redirect_stderr: boolish(kv.redirect_stderr) ?? false,
      stdout_logfile: kv.stdout_logfile || '',
      stderr_logfile: kv.stderr_logfile || '',
      environment: env,
    };
  },

  /** Create a new [program] config from a full definition and apply it. */
  async addProgram(server, def = {}) {
    const block = this.buildProgramBlock(def);
    const { confDir: detected } = await this.listConfigFiles(server);
    const dir = def.confDir || detected || '/etc/supervisor/conf.d';
    const path = `${dir}/${def.name}.conf`;
    await this.writeConfigFile(server, path, block);
    await this.reloadConfig(server);
    return { path };
  },

  /** Read a range of a process log (offset-based; for scroll-back history). */
  async readProcessLog(server, fullName, channel = 'stdout', offset = 0, length = 32768) {
    const method = channel === 'stderr'
      ? 'supervisor.readProcessStderrLog'
      : 'supervisor.readProcessStdoutLog';
    const data = await getConnector(server).call(method, [fullName, offset, length]);
    return { data: typeof data === 'string' ? data : '', offset, length };
  },

  /**
   * Assemble a process log from the start for download, in chunks, up to
   * `maxBytes` (newest bytes are truncated from the front if the log is larger).
   * Offset-capable connectors only; others return the last tail snapshot.
   */
  async downloadProcessLog(server, fullName, channel = 'stdout', maxBytes = 20 * 1024 * 1024) {
    if (!this.supportsLogOffset(server)) {
      const tail = await this.tailLog(server, fullName, channel, 0);
      return { data: tail.data || '', truncated: !!tail.overflow };
    }
    const CHUNK = 65536;
    let offset = 0;
    let out = '';
    let truncated = false;
    // Read forward until a short/empty chunk signals EOF or the cap is hit.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { data } = await this.readProcessLog(server, fullName, channel, offset, CHUNK);
      if (!data) break;
      out += data;
      offset += Buffer.byteLength(data, 'utf8');
      if (Buffer.byteLength(data, 'utf8') < CHUNK) break; // reached the end
      if (out.length > maxBytes) { truncated = true; out = out.slice(-maxBytes); break; }
    }
    return { data: out, truncated };
  },

  /** Host resource metrics (load / memory / disk). Shell connectors only. */
  async hostMetrics(server) {
    const c = getConnector(server);
    if (!(c.supportsExec && c.supportsExec())) return null;
    const script = `
echo "LOAD=$(cat /proc/loadavg 2>/dev/null | awk '{print $1","$2","$3}')"
echo "MEM=$(free -m 2>/dev/null | awk '/^Mem:/{print $2","$3}')"
echo "DISK=$(df -P / 2>/dev/null | awk 'NR==2{print $2","$3","$5}')"
echo "CORES=$(nproc 2>/dev/null || echo 1)"
echo "UP=$(awk '{print int($1)}' /proc/uptime 2>/dev/null)"
`;
    let out = '';
    try { ({ stdout: out } = await c.exec(script)); } catch { return null; }
    const kv = {};
    for (const line of out.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    const load = (kv.LOAD || '').split(',').map(Number);
    const mem = (kv.MEM || '').split(',').map(Number);
    const disk = (kv.DISK || '').split(',');
    return {
      load: load.length === 3 && !load.some(Number.isNaN) ? { one: load[0], five: load[1], fifteen: load[2] } : null,
      cores: Number(kv.CORES) || null,
      mem: mem.length === 2 && !mem.some(Number.isNaN) ? { totalMb: mem[0], usedMb: mem[1] } : null,
      disk: disk.length === 3 ? { totalKb: Number(disk[0]), usedKb: Number(disk[1]), usePct: parseInt(disk[2], 10) } : null,
      uptimeSec: Number(kv.UP) || null,
    };
  },

  // --- Event listener (push-based events) ---

  /** Get the per-server ingest token, generating + persisting one if absent. */
  async ensureIngestToken(server) {
    if (server.ingestToken) return server.ingestToken;
    const token = crypto.randomBytes(24).toString('base64url');
    await serverStore.update(server.id, { ingestToken: token });
    server.ingestToken = token;
    return token;
  },

  /** Rotate (regenerate) the ingest token. The listener config must be reinstalled. */
  async rotateIngestToken(server) {
    const token = crypto.randomBytes(24).toString('base64url');
    await serverStore.update(server.id, { ingestToken: token });
    server.ingestToken = token;
    return token;
  },

  /**
   * Build the eventlistener artefacts for a server: the ingest URL, the
   * `[eventlistener:helmio]` config block and the path the listener script will
   * live at. Used both for the one-click install and the manual snippet shown
   * for shell-less connectors.
   */
  async eventListenerPlan(server) {
    const token = await this.ensureIngestToken(server);
    const ingestUrl = `${config.publicUrl}/api/ingest`;
    // Resolve install locations from the detected conf dir (shell connectors).
    let confDir = '/etc/supervisor/conf.d';
    let scriptDir = '/etc/supervisor';
    const c = getConnector(server);
    if (c.supportsExec && c.supportsExec()) {
      const detected = await this.listConfigFiles(server).catch(() => null);
      if (detected?.confDir) {
        confDir = detected.confDir;
        scriptDir = confDir.endsWith('conf.d') || confDir.endsWith('.d')
          ? path.posix.dirname(confDir)
          : confDir;
      }
    }
    const scriptPath = `${scriptDir}/helmio_eventlistener.py`;
    const confPath = `${confDir}/helmio_eventlistener.conf`;
    const block = `[eventlistener:helmio]
command=python3 ${scriptPath}
events=PROCESS_STATE,PROCESS_GROUP,SUPERVISOR_STATE_CHANGE,TICK_60
autostart=true
autorestart=true
environment=HELMIO_INGEST_URL="${ingestUrl}",HELMIO_SERVER_ID="${server.id}",HELMIO_TOKEN="${token}"
stderr_logfile=/var/log/helmio_eventlistener.err
`;
    return { ingestUrl, token, scriptPath, confPath, confDir, scriptDir, configBlock: block };
  },

  /** Is the Helmio eventlistener present and running on this supervisord? */
  async eventListenerStatus(server) {
    try {
      const info = await getConnector(server).call('supervisor.getAllProcessInfo');
      const proc = (info || []).find((p) => p.group === 'helmio' || p.name === 'helmio');
      const c = getConnector(server);
      return {
        installed: !!proc,
        running: proc?.state === 20,
        statename: proc?.statename || null,
        canAutoInstall: !!(c.supportsExec && c.supportsExec()),
      };
    } catch {
      const c = getConnector(server);
      return { installed: false, running: false, statename: null, canAutoInstall: !!(c.supportsExec && c.supportsExec()) };
    }
  },

  /**
   * One-click install (shell connectors): push the listener script + config to
   * the target and apply it. Returns the paths written.
   */
  async installEventListener(server) {
    const c = getConnector(server);
    if (!(c.supportsExec && c.supportsExec())) {
      throw new Error('Bu bağlantı türünde otomatik kurulum desteklenmiyor; manuel snippet kullanın.');
    }
    const plan = await this.eventListenerPlan(server);
    const script = await fs.readFile(LISTENER_SRC, 'utf8');

    // Write the script.
    const b64 = Buffer.from(script, 'utf8').toString('base64');
    let r = await c.exec(`printf %s ${shArg(b64)} | base64 -d > ${shArg(plan.scriptPath)} && chmod +x ${shArg(plan.scriptPath)}`);
    if (r.code !== 0) throw new Error(r.stderr || 'Listener betiği yazılamadı (yetki gerekebilir).');

    // Write the config.
    const cfgB64 = Buffer.from(plan.configBlock, 'utf8').toString('base64');
    r = await c.exec(`printf %s ${shArg(cfgB64)} | base64 -d > ${shArg(plan.confPath)}`);
    if (r.code !== 0) throw new Error(r.stderr || 'Listener config yazılamadı (yetki gerekebilir).');

    // Apply: reread + add the new eventlistener group.
    await this.reloadConfig(server);
    return { scriptPath: plan.scriptPath, confPath: plan.confPath };
  },

  /** Remove the eventlistener (stop group, delete config + script, reload). */
  async uninstallEventListener(server) {
    const c = getConnector(server);
    await c.call('supervisor.stopProcessGroup', ['helmio']).catch(() => {});
    await c.call('supervisor.removeProcessGroup', ['helmio']).catch(() => {});
    if (c.supportsExec && c.supportsExec()) {
      const plan = await this.eventListenerPlan(server);
      await c.exec(`rm -f ${shArg(plan.confPath)} ${shArg(plan.scriptPath)}`).catch(() => {});
      await this.reloadConfig(server).catch(() => {});
    }
    return { ok: true };
  },

  /** True when offset-based incremental tailing is supported (real XML-RPC). */
  supportsLogOffset(server) {
    return server.method !== 'docker';
  },
};
