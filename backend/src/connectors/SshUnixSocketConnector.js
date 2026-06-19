import { Client as SshClient } from 'ssh2';
import xmlrpc from 'xmlrpc';
import { BaseConnector } from './BaseConnector.js';

/**
 * Reaches a remote supervisord over SSH. Keeps one persistent SSH connection
 * per server and, for every XML-RPC call, opens a fresh forwarded channel to
 * either:
 *   - the supervisord unix socket  (target = 'socket', server.socketPath), or
 *   - a host:port the daemon listens on (target = 'tcp', usually 127.0.0.1:9001).
 *
 * The forwarded channel is handed to the xmlrpc client as the HTTP transport via
 * `agent: false` + `createConnection`, so Node still does the HTTP parsing.
 *
 * Server definition fields:
 *   sshHost, sshPort, sshUser, sshPassword | privateKey   (SSH auth)
 *   target ('socket' | 'tcp')
 *   socketPath                                             (target=socket)
 *   targetHost, targetPort                                (target=tcp)
 *   username, password, path                              (optional supervisor HTTP auth)
 */
export class SshUnixSocketConnector extends BaseConnector {
  constructor(server) {
    super(server);
    this.conn = null;
    this.connecting = null; // in-flight connect promise

    const {
      path = '/RPC2',
      username,
      password,
      targetHost = '127.0.0.1',
      targetPort = 9001,
    } = server;

    const options = {
      host: targetHost, // only used for the HTTP Host header
      port: Number(targetPort),
      path,
      agent: false,
      createConnection: (_opts, cb) => this.#openChannel(cb),
    };
    if (username) options.basic_auth = { user: username, pass: password ?? '' };

    this.client = xmlrpc.createClient(options);
  }

  #connect() {
    if (this.conn) return Promise.resolve(this.conn);
    if (this.connecting) return this.connecting;

    const { sshHost, sshPort = 22, sshUser, sshPassword, privateKey } = this.server;
    this.connecting = new Promise((resolve, reject) => {
      const conn = new SshClient();
      conn
        .on('ready', () => {
          this.conn = conn;
          this.connecting = null;
          resolve(conn);
        })
        .on('error', (err) => {
          this.conn = null;
          this.connecting = null;
          reject(new Error(`SSH bağlantı hatası: ${err.message}`));
        })
        .on('close', () => {
          this.conn = null;
        });

      const auth = { host: sshHost, port: Number(sshPort), username: sshUser, readyTimeout: 15000 };
      if (privateKey) auth.privateKey = privateKey;
      if (sshPassword) auth.password = sshPassword;

      try {
        conn.connect(auth);
      } catch (err) {
        this.connecting = null;
        reject(new Error(`SSH bağlantı hatası: ${err.message}`));
      }
    });
    return this.connecting;
  }

  #openChannel(cb) {
    this.#connect()
      .then((conn) => {
        const { target = 'socket', socketPath = '/var/run/supervisor.sock', targetHost = '127.0.0.1', targetPort = 9001 } = this.server;
        if (target === 'tcp') {
          conn.forwardOut('127.0.0.1', 0, targetHost, Number(targetPort), (err, stream) => {
            if (err) return cb(new Error(`SSH TCP forward hatası: ${err.message}`));
            cb(null, stream);
          });
        } else {
          conn.forwardOutStreamLocal(socketPath, (err, stream) => {
            if (err) return cb(new Error(`SSH socket forward hatası (${socketPath}): ${err.message}`));
            cb(null, stream);
          });
        }
      })
      .catch((err) => cb(err));
  }

  call(method, params = []) {
    return new Promise((resolve, reject) => {
      this.client.methodCall(method, params, (err, value) => {
        if (err) {
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

  async exec(command, { input, onData } = {}) {
    const conn = await this.#connect();
    return new Promise((resolve, reject) => {
      conn.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        stream.on('data', (d) => { stdout += d; onData?.(d.toString(), 'stdout'); });
        stream.stderr.on('data', (d) => { stderr += d; onData?.(d.toString(), 'stderr'); });
        stream.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
        if (input != null) {
          stream.write(input);
          stream.end();
        }
      });
    });
  }

  async close() {
    if (this.conn) {
      this.conn.end();
      this.conn = null;
    }
  }
}
