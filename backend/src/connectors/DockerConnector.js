import Docker from 'dockerode';
import { BaseConnector } from './BaseConnector.js';

/**
 * Reaches supervisord INSIDE a Docker container without publishing any port and
 * without installing anything in the container: it runs `supervisorctl` via the
 * Docker Engine API (`docker exec`) and maps the text output back to the same
 * shapes the XML-RPC connectors return, so the rest of Helmio is unchanged.
 *
 * Requires the Helmio backend to reach the Docker daemon — locally that means
 * access to /var/run/docker.sock (bind-mount it if Helmio is itself in a
 * container), or a TCP Docker endpoint for a remote host.
 *
 * Server definition fields:
 *   container               container name or id
 *   connection ('socket'|'tcp')
 *   dockerSocket            (connection=socket, default /var/run/docker.sock)
 *   dockerHost, dockerPort  (connection=tcp)
 *   confPath                optional supervisord.conf path inside container
 */
const NAME_TO_CODE = {
  STOPPED: 0,
  STARTING: 10,
  RUNNING: 20,
  BACKOFF: 30,
  STOPPING: 40,
  EXITED: 100,
  FATAL: 200,
  UNKNOWN: 1000,
};

function parsePid(rest) {
  const m = rest.match(/pid\s+(\d+)/);
  return m ? Number(m[1]) : 0;
}

function parseUptimeSeconds(rest) {
  // "uptime 1:23:45" or "uptime 2 days, 3:04:05"
  const m = rest.match(/uptime\s+(?:(\d+)\s+days?,\s+)?(\d+):(\d+):(\d+)/);
  if (!m) return 0;
  const days = Number(m[1] || 0);
  return days * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

function parseStatusLine(line) {
  const m = line.match(/^(\S+)\s+([A-Z]+)\s*(.*)$/);
  if (!m) return null;
  const [, full, statename, rest] = m;
  const [group, name] = full.includes(':') ? full.split(':') : [full, full];
  const state = NAME_TO_CODE[statename] ?? 1000;
  const now = Math.floor(Date.now() / 1000);
  const uptime = parseUptimeSeconds(rest);
  return {
    name,
    group,
    state,
    statename,
    pid: parsePid(rest),
    description: rest,
    start: state === 20 ? now - uptime : 0,
    stop: 0,
    now,
    exitstatus: 0,
    spawnerr: '',
    logfile: '',
    stdout_logfile: '',
    stderr_logfile: '',
  };
}

function looksLikeDaemonDown(stderr) {
  return /refused|no such file|SHUTDOWN_STATE|FileNotFoundError|connection/i.test(stderr);
}

export class DockerConnector extends BaseConnector {
  constructor(server) {
    super(server);
    const opts =
      server.connection === 'tcp'
        ? { host: server.dockerHost || '127.0.0.1', port: Number(server.dockerPort) || 2375 }
        : { socketPath: server.dockerSocket || '/var/run/docker.sock' };
    this.docker = new Docker(opts);
    this.confArgs = server.confPath ? ['-c', server.confPath] : [];
  }

  /** Run `supervisorctl <args>` inside the container, capturing stdout/stderr. */
  async #ctl(args) {
    const container = this.docker.getContainer(this.server.container);
    let exec;
    try {
      exec = await container.exec({
        Cmd: ['supervisorctl', ...this.confArgs, ...args],
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
      });
    } catch (err) {
      if (err.statusCode === 404) throw new Error(`Container bulunamadı: ${this.server.container}`);
      if (err.code === 'ENOENT' || err.code === 'EACCES') {
        throw new Error(
          `Docker daemon'a erişilemiyor (${this.server.dockerSocket || this.server.dockerHost}). Helmio docker socket'ine erişebiliyor mu?`,
        );
      }
      throw new Error(`Docker hatası: ${err.message}`);
    }

    const stream = await exec.start({});
    let out = '';
    let err = '';
    this.docker.modem.demuxStream(
      stream,
      {
        write: (c) => {
          out += c.toString();
        },
      },
      {
        write: (c) => {
          err += c.toString();
        },
      },
    );
    await new Promise((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    const info = await exec.inspect();
    return { out: out.trim(), err: err.trim(), code: info.ExitCode };
  }

  supportsExec() {
    return true;
  }

  /** Run an arbitrary shell command inside the container as root. */
  async exec(command, { input, onData } = {}) {
    const container = this.docker.getContainer(this.server.container);
    const exec = await container.exec({
      Cmd: ['sh', '-c', command],
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: input != null,
      User: 'root',
      Tty: false,
    });
    const stream = await exec.start({ hijack: input != null, stdin: input != null });
    let stdout = '';
    let stderr = '';
    this.docker.modem.demuxStream(
      stream,
      {
        write: (c) => {
          stdout += c.toString();
          onData?.(c.toString(), 'stdout');
        },
      },
      {
        write: (c) => {
          stderr += c.toString();
          onData?.(c.toString(), 'stderr');
        },
      },
    );
    if (input != null) {
      stream.write(input);
      stream.end();
    }
    await new Promise((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    const info = await exec.inspect();
    return { stdout: stdout.trim(), stderr: stderr.trim(), code: info.ExitCode ?? 0 };
  }

  async call(method, params = []) {
    switch (method) {
      case 'supervisor.getSupervisorVersion': {
        const { out, err, code } = await this.#ctl(['version']);
        if (code !== 0 || looksLikeDaemonDown(err)) {
          throw new Error(err || "supervisord'a ulaşılamadı.");
        }
        return out;
      }

      case 'supervisor.getIdentification':
        return this.server.container;

      case 'supervisor.getState': {
        // `status` exits non-zero if any process isn't running, so rely on stderr.
        const { err } = await this.#ctl(['status']);
        if (looksLikeDaemonDown(err)) throw new Error(err || 'supervisord kapalı.');
        return { statecode: 1, statename: 'RUNNING' };
      }

      case 'supervisor.getAllProcessInfo': {
        const { out, err } = await this.#ctl(['status']);
        if (looksLikeDaemonDown(err)) throw new Error(err || "supervisord'a ulaşılamadı.");
        return out.split('\n').map(parseStatusLine).filter(Boolean);
      }

      case 'supervisor.getProcessInfo': {
        const { out, err } = await this.#ctl(['status', params[0]]);
        if (looksLikeDaemonDown(err)) throw new Error(err);
        const parsed = parseStatusLine(out.split('\n')[0] || '');
        if (!parsed) throw new Error(`İşlem bulunamadı: ${params[0]}`);
        return parsed;
      }

      case 'supervisor.startProcess':
        await this.#ctl(['start', params[0]]);
        return true;
      case 'supervisor.stopProcess':
        await this.#ctl(['stop', params[0]]);
        return true;
      case 'supervisor.startProcessGroup':
        await this.#ctl(['start', `${params[0]}:*`]);
        return true;
      case 'supervisor.stopProcessGroup':
        await this.#ctl(['stop', `${params[0]}:*`]);
        return true;
      case 'supervisor.startAllProcesses':
        await this.#ctl(['start', 'all']);
        return true;
      case 'supervisor.stopAllProcesses':
        await this.#ctl(['stop', 'all']);
        return true;

      // Logs: supervisorctl tail returns a snapshot (no offset tracking).
      case 'supervisor.tailProcessStdoutLog':
      case 'supervisor.tailProcessStderrLog': {
        const channel = method.endsWith('StderrLog') ? 'stderr' : 'stdout';
        const name = params[0];
        const bytes = params[2] || 16384;
        const { out } = await this.#ctl(['tail', `-${bytes}`, name, channel]);
        return [out, 0, false];
      }
      case 'supervisor.clearProcessLogs':
        await this.#ctl(['clear', params[0]]);
        return true;

      case 'supervisor.signalProcess':
        // supervisorctl signal <SIG> <name>
        await this.#ctl(['signal', String(params[1]), params[0]]);
        return true;

      // Daemon-level
      case 'supervisor.getPID': {
        const { out } = await this.#ctl(['pid']);
        return Number(out) || 0;
      }
      case 'supervisor.reloadConfig': {
        await this.#ctl(['reread']);
        await this.#ctl(['update']);
        return [[[], [], []]]; // update already applied the changes
      }
      case 'supervisor.addProcessGroup':
      case 'supervisor.removeProcessGroup':
        return true; // handled by reread+update above
      case 'supervisor.restart':
        await this.#ctl(['reload']);
        return true;
      case 'supervisor.shutdown':
        await this.#ctl(['shutdown']);
        return true;
      case 'supervisor.readLog': {
        const bytes = params[1] || 16384;
        const { out } = await this.#ctl(['maintail', `-${bytes}`]);
        return out;
      }
      case 'supervisor.clearLog':
        return true; // supervisorctl has no clear-main-log

      default:
        throw new Error(`Docker connector bu methodu desteklemiyor: ${method}`);
    }
  }
}
