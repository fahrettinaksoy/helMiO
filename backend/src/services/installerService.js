import crypto from 'node:crypto';
import { getConnector, createConnector } from '../connectors/index.js';
import { supervisorService } from './supervisorService.js';

/**
 * Detects whether Supervisor is installed/running on a server and, where a shell
 * is available (local / ssh / docker), installs it at a best-practices level.
 *
 * Detection strategy:
 *   - First try the XML-RPC API. If it answers, Supervisor is installed AND
 *     running — done.
 *   - If not, and the connector has shell access, gather facts (OS, package
 *     manager, binaries, conf path, init system, privileges) to decide what to do.
 *   - For shell-less connectors (tcp / agent) we can only report reachability and
 *     fall back to manual guidance.
 */

// One round-trip fact-gathering script. Output is simple KEY=VALUE lines.
const FACTS_SCRIPT = `
echo "WHOAMI=$(whoami 2>/dev/null)"
echo "UNAME=$(uname -s 2>/dev/null)"
echo "SUPERVISORD=$(command -v supervisord 2>/dev/null)"
echo "SUPERVISORCTL=$(command -v supervisorctl 2>/dev/null)"
echo "VERSION=$(supervisord -v 2>/dev/null)"
echo "SUDO=$(command -v sudo 2>/dev/null)"
echo "RUNNING=$(pgrep -x supervisord >/dev/null 2>&1 && echo yes || echo no)"
for pm in apt-get apk dnf yum brew pip3 pip; do command -v $pm >/dev/null 2>&1 && echo "PM=$pm"; done
for c in /etc/supervisor/supervisord.conf /etc/supervisord.conf /usr/local/etc/supervisord.conf /opt/homebrew/etc/supervisord.conf; do [ -f "$c" ] && echo "CONF=$c"; done
if command -v systemctl >/dev/null 2>&1; then echo "INIT=systemd"; elif command -v rc-service >/dev/null 2>&1; then echo "INIT=openrc"; else echo "INIT=none"; fi
if [ -f /etc/os-release ]; then . /etc/os-release; echo "OS_ID=$ID"; echo "OS_NAME=$PRETTY_NAME"; fi
`;

const PM_PRIORITY = ['apt-get', 'dnf', 'yum', 'apk', 'pip3', 'pip'];
// Package managers we have an install recipe for (brew is detected but not auto-installable).
const INSTALLABLE = new Set(PM_PRIORITY);

function parseFacts(stdout) {
  const kv = {};
  const pms = [];
  let conf = null;
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key === 'PM') pms.push(val);
    else if (key === 'CONF' && !conf) conf = val;
    else kv[key] = val;
  }
  // Pick the highest-priority package manager we can actually install with.
  const pm = PM_PRIORITY.find((p) => pms.includes(p) && INSTALLABLE.has(p)) || null;
  const isMac = kv.UNAME === 'Darwin';
  return {
    whoami: kv.WHOAMI || '',
    installed: !!kv.SUPERVISORD,
    supervisorctl: !!kv.SUPERVISORCTL,
    version: (kv.VERSION || '').trim() || null,
    running: kv.RUNNING === 'yes',
    hasSudo: !!kv.SUDO,
    packageManager: isMac && !pm ? 'brew' : pm,
    availablePackageManagers: pms,
    confPath: conf,
    init: kv.INIT || 'none',
    os: kv.OS_NAME || (isMac ? 'macOS' : kv.UNAME || 'unknown'),
    osId: kv.OS_ID || (isMac ? 'macos' : ''),
  };
}

async function gatherFacts(connector) {
  const { stdout } = await connector.exec(FACTS_SCRIPT);
  return parseFacts(stdout);
}

// --- shell quoting + privilege wrapper -------------------------------------

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Wrap a command so it runs with privileges.
 *   - root or docker (exec as root): run as-is.
 *   - sudo password given: `sudo -S` with the password fed on stdin (never in argv).
 *   - otherwise: `sudo -n` (passwordless); fails clearly if sudo needs a password.
 */
function privilegeWrap(cmd, { isRoot, isDocker, sudoPassword }) {
  if (isRoot || isDocker) return { command: cmd };
  if (sudoPassword) return { command: `sudo -S -p '' sh -c ${q(cmd)}`, input: `${sudoPassword}\n` };
  return { command: `sudo -n sh -c ${q(cmd)}` };
}

// --- install recipes --------------------------------------------------------

function installCommand(pm) {
  switch (pm) {
    case 'apt-get':
      return 'export DEBIAN_FRONTEND=noninteractive; apt-get update && apt-get install -y supervisor';
    case 'apk':
      return 'apk add --no-cache supervisor';
    case 'dnf':
      return 'dnf install -y supervisor || { dnf install -y epel-release && dnf install -y supervisor; }';
    case 'yum':
      return 'yum install -y supervisor || { yum install -y epel-release && yum install -y supervisor; }';
    case 'pip3':
      return 'pip3 install supervisor';
    case 'pip':
      return 'pip install supervisor';
    default:
      return null;
  }
}

function defaultConfPath(pm) {
  if (pm === 'apt-get') return '/etc/supervisor/supervisord.conf';
  return '/etc/supervisord.conf';
}

/**
 * Best-practices config script: ensures conf.d include dir, a unix socket and a
 * password-protected inet server bound to localhost. Each section is appended
 * only if missing, so an existing config is never corrupted. The inet password
 * is passed in (returned to the caller so it can be surfaced once).
 */
function configureScript({ confPath, isPip, inetUser, inetPassword }) {
  const block = `
[unix_http_server]
file=/var/run/supervisor.sock
chmod=0700

[inet_http_server]
port=127.0.0.1:9001
username=${inetUser}
password=${inetPassword}

[supervisorctl]
serverurl=unix:///var/run/supervisor.sock

[include]
files = /etc/supervisor/conf.d/*.conf /etc/supervisor.d/*.ini
`;
  const b64 = Buffer.from(block, 'utf8').toString('base64');
  // For pip installs there's no base config — generate one first.
  const ensureConf = isPip
    ? `[ -f ${confPath} ] || { command -v echo_supervisord_conf >/dev/null 2>&1 && echo_supervisord_conf > ${confPath} || : ; }; touch ${confPath}`
    : `touch ${confPath}`;
  return [
    'mkdir -p /etc/supervisor/conf.d',
    ensureConf,
    // append each section only if its header is absent
    `grep -q '^\\[unix_http_server\\]' ${confPath} || printf '\\n%s\\n' "$(echo ${b64} | base64 -d | sed -n '/\\[unix_http_server\\]/,/^$/p')" >> ${confPath}`,
    `grep -q '^\\[inet_http_server\\]' ${confPath} || printf '\\n%s\\n' "$(echo ${b64} | base64 -d | sed -n '/\\[inet_http_server\\]/,/^$/p')" >> ${confPath}`,
    `grep -q '^\\[supervisorctl\\]' ${confPath} || printf '\\n%s\\n' "$(echo ${b64} | base64 -d | sed -n '/\\[supervisorctl\\]/,/^$/p')" >> ${confPath}`,
    `grep -q '^\\[include\\]' ${confPath} || printf '\\n%s\\n' "$(echo ${b64} | base64 -d | sed -n '/\\[include\\]/,/^$/p')" >> ${confPath}`,
  ].join(' && ');
}

function serviceScript({ init, confPath }) {
  if (init === 'systemd') {
    return (
      'systemctl enable supervisor 2>/dev/null || systemctl enable supervisord 2>/dev/null; ' +
      'systemctl restart supervisor 2>/dev/null || systemctl restart supervisord 2>/dev/null || true'
    );
  }
  if (init === 'openrc') {
    return 'rc-update add supervisord default 2>/dev/null; rc-service supervisord restart 2>/dev/null || rc-service supervisord start';
  }
  // No init system (many containers / pip): (re)start supervisord directly if not running.
  return `pgrep -x supervisord >/dev/null 2>&1 || supervisord -c ${confPath}`;
}

export const installerService = {
  /**
   * Test whether Helmio can establish its connection CHANNEL to a server,
   * without requiring Supervisor to be installed (so you can add a server first,
   * then install Supervisor on it). Uses a fresh connector (no cache) so it's
   * safe for ad-hoc, not-yet-saved definitions.
   *
   * - agent: the agent HTTP endpoint must respond (/health).
   * - shell methods (local/ssh/docker): a trivial command must run.
   * - tcp: the XML-RPC endpoint must answer.
   *
   * Returns { ok, channel, supervisor: { reachable, version }|null, error? }.
   */
  async testConnection(server) {
    const connector = createConnector(server);
    try {
      if (server.method === 'agent') {
        const base = String(server.agentUrl || '').replace(/\/+$/, '');
        if (!base) return { ok: false, error: 'Agent URL gerekli.' };
        let res;
        try {
          res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(10000) });
        } catch (e) {
          return { ok: false, error: `Agent'a ulaşılamadı: ${e.message}` };
        }
        let body = null;
        try {
          body = await res.json();
        } catch {
          /* non-json */
        }
        return {
          ok: true,
          channel: 'agent',
          supervisor: { reachable: !!body?.ok, version: body?.version || null },
        };
      }

      if (connector.supportsExec && connector.supportsExec()) {
        const { stdout, code } = await connector.exec('echo helmio-ok');
        if (code !== 0 || !stdout.includes('helmio-ok')) {
          return { ok: false, error: 'Bağlantı kuruldu ama komut çalıştırılamadı.' };
        }
        let supervisor = { reachable: false, version: null };
        try {
          const v = await connector.call('supervisor.getSupervisorVersion');
          supervisor = { reachable: true, version: v };
        } catch {
          /* supervisor not running/installed — channel still ok */
        }
        return { ok: true, channel: 'shell', supervisor };
      }

      // tcp: XML-RPC must answer
      const version = await connector.call('supervisor.getSupervisorVersion');
      return { ok: true, channel: 'rpc', supervisor: { reachable: true, version } };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      if (connector.close) await connector.close().catch(() => {});
    }
  },

  async detect(server) {
    const connector = getConnector(server);

    // 1. XML-RPC reachability — definitive "installed + running" signal.
    let rpc = { ok: false, error: null, version: null };
    try {
      const ping = await supervisorService.ping(server);
      rpc = { ok: true, version: ping.version, error: null };
    } catch (err) {
      rpc = { ok: false, version: null, error: err.message };
    }

    const shell = typeof connector.supportsExec === 'function' && connector.supportsExec();

    if (!shell) {
      return {
        method: server.method,
        shell: false,
        reachable: rpc.ok,
        installed: rpc.ok ? true : 'unknown',
        running: rpc.ok,
        version: rpc.version,
        canInstall: false,
        rpcError: rpc.ok ? null : rpc.error,
      };
    }

    let facts;
    try {
      facts = await gatherFacts(connector);
    } catch (err) {
      return {
        method: server.method,
        shell: true,
        reachable: rpc.ok,
        installed: rpc.ok ? true : 'unknown',
        running: rpc.ok,
        version: rpc.version,
        canInstall: false,
        error: `Tespit komutları çalıştırılamadı: ${err.message}`,
      };
    }

    return {
      method: server.method,
      shell: true,
      reachable: rpc.ok,
      installed: facts.installed,
      running: facts.running || rpc.ok,
      version: facts.version || rpc.version,
      os: facts.os,
      packageManager: facts.packageManager,
      availablePackageManagers: facts.availablePackageManagers,
      confPath: facts.confPath,
      init: facts.init,
      whoami: facts.whoami,
      hasSudo: facts.hasSudo,
      canInstall: !facts.installed && !!installCommand(facts.packageManager),
      // installed but RPC unreachable → likely just missing http config
      canConfigure: facts.installed && !rpc.ok,
      rpcError: rpc.ok ? null : rpc.error,
    };
  },

  /**
   * Install (and optionally configure) Supervisor. `onLog(line)` streams progress.
   * Returns { ok, inet?: {host,port,username,password}, facts }.
   */
  async install(server, { sudoPassword = '', configureHttp = true } = {}, onLog = () => {}) {
    const connector = getConnector(server);
    if (!(connector.supportsExec && connector.supportsExec())) {
      throw new Error('Bu bağlantı türünde kurulum yapılamaz (shell erişimi yok).');
    }

    const facts = await gatherFacts(connector);
    const isDocker = server.method === 'docker';
    const isRoot = facts.whoami === 'root';
    const priv = { isRoot, isDocker, sudoPassword };

    const runRaw = async (cmd, label) => {
      onLog(`\n$ ${label || cmd}`);
      const { command, input } = privilegeWrap(cmd, priv);
      const { stdout, stderr, code } = await connector.exec(command, {
        input,
        onData: (chunk) => onLog(chunk.replace(/\n$/, '')),
      });
      if (code !== 0) {
        const tail = (stderr || stdout || '').trim().split('\n').slice(-3).join(' ');
        throw new Error(`Komut başarısız (çıkış ${code}): ${tail}`);
      }
      return stdout;
    };

    // 1. install package
    const pm = facts.packageManager;
    const installCmd = installCommand(pm);
    if (facts.installed) {
      onLog('Supervisor zaten kurulu — yapılandırma adımına geçiliyor.');
    } else if (!installCmd) {
      throw new Error(
        `Desteklenen paket yöneticisi bulunamadı (tespit: ${facts.availablePackageManagers.join(', ') || 'yok'}).`,
      );
    } else {
      onLog(`Paket yöneticisi: ${pm}. Supervisor kuruluyor...`);
      await runRaw(installCmd, `${pm} ile supervisor kurulumu`);
    }

    // 2. configure best-practices http interfaces
    const isPip = pm === 'pip' || pm === 'pip3';
    const confPath = facts.confPath || defaultConfPath(pm);
    let inet = null;
    if (configureHttp) {
      const inetUser = 'helmio';
      const inetPassword = crypto.randomBytes(12).toString('hex');
      inet = { host: '127.0.0.1', port: 9001, username: inetUser, password: inetPassword };
      onLog('\nEn iyi pratiklerle yapılandırılıyor (unix socket + 127.0.0.1:9001 inet, auth)...');
      await runRaw(
        configureScript({ confPath, isPip, inetUser, inetPassword }),
        `yapılandırma yazılıyor (${confPath})`,
      );
    }

    // 3. (re)start service
    onLog('\nServis başlatılıyor...');
    await runRaw(serviceScript({ init: facts.init, confPath }), 'servis başlatma');

    onLog('\n✓ Kurulum tamamlandı.');
    if (isDocker) {
      onLog(
        "⚠ Not: Container içine kurulum kalıcı değildir — container yeniden oluşturulursa kaybolur. Kalıcılık için supervisor'ı imaja ekleyin.",
      );
    }
    return { ok: true, inet, facts: { ...facts, installed: true, confPath } };
  },
};
