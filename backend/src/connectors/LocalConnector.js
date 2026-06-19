import { spawn } from 'node:child_process';
import xmlrpc from 'xmlrpc';
import { BaseConnector } from './BaseConnector.js';

/**
 * Same-machine connector. Talks XML-RPC to a local supervisord over its
 * [unix_http_server] socket — no TCP port needs to be opened. Useful when Helmio
 * runs on the same host as supervisord (local macOS/Linux dev) or when the
 * supervisord socket is bind-mounted into the Helmio container.
 *
 * Node's http honors `socketPath`, so this reuses the standard xmlrpc client.
 *
 * Server definition fields:
 *   socketPath (default /var/run/supervisor.sock)
 *   username, password, path  (optional supervisor HTTP auth)
 */
export class LocalConnector extends BaseConnector {
  constructor(server) {
    super(server);
    const { socketPath = '/var/run/supervisor.sock', path = '/RPC2', username, password } = server;
    const options = { socketPath, host: 'localhost', path };
    if (username) options.basic_auth = { user: username, pass: password ?? '' };
    this.client = xmlrpc.createClient(options);
  }

  call(method, params = []) {
    return new Promise((resolve, reject) => {
      this.client.methodCall(method, params, (err, value) => {
        if (err) {
          if (err.code === 'ENOENT') {
            return reject(new Error(`Socket bulunamadı: ${this.server.socketPath} (supervisord çalışıyor mu, yol doğru mu?)`));
          }
          if (err.code === 'EACCES') {
            return reject(new Error(`Socket erişim izni yok: ${this.server.socketPath}`));
          }
          if (err.faultString) return reject(new Error(`Supervisor hatası: ${err.faultString}`));
          return reject(err instanceof Error ? err : new Error(String(err)));
        }
        resolve(value);
      });
    });
  }

  supportsMulticall() {
    return true;
  }

  supportsExec() {
    return true;
  }

  exec(command, { input, onData } = {}) {
    return new Promise((resolve, reject) => {
      const proc = spawn('sh', ['-c', command]);
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d; onData?.(d.toString(), 'stdout'); });
      proc.stderr.on('data', (d) => { stderr += d; onData?.(d.toString(), 'stderr'); });
      proc.on('error', reject);
      proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
      if (input != null) {
        proc.stdin.write(input);
        proc.stdin.end();
      }
    });
  }
}
