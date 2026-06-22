/**
 * A Connector knows how to reach the Supervisor XML-RPC API of a single server
 * and exposes a uniform promise-based `call(method, params)` plus convenience
 * helpers. Concrete connectors differ only in *how* they transport the XML-RPC
 * request (direct TCP, SSH tunnel, remote agent).
 *
 * Supervisor XML-RPC reference:
 * http://supervisord.org/api.html
 */
export class BaseConnector {
  /** @param {object} server - the stored server definition */
  constructor(server) {
    this.server = server;
  }

  /**
   * Perform a raw XML-RPC call.
   * @param {string} _method e.g. "supervisor.getAllProcessInfo"
   * @param {any[]} _params
   * @returns {Promise<any>}
   */

  async call(_method, _params = []) {
    throw new Error('call() not implemented by connector');
  }

  /**
   * Whether this transport can batch calls via XML-RPC `system.multicall`.
   * Real-supervisord connectors (tcp/local/ssh/agent) override this to true;
   * supervisord supports system.multicall natively. The supervisorctl-based
   * Docker connector leaves it false and uses the sequential fallback.
   */
  supportsMulticall() {
    return false;
  }

  /**
   * Run several calls in one round-trip where possible.
   * @param {{methodName: string, params?: any[]}[]} calls
   * @returns {Promise<Array<{value?: any, error?: string}>>} one entry per call,
   *   in order. A faulted call yields `{ error }` instead of `{ value }`.
   *
   * Uses `system.multicall` when the transport supports it (1 round-trip),
   * falling back to concurrent individual calls otherwise — or if the batch
   * call itself fails (e.g. an older agent that doesn't proxy system.multicall).
   */
  async multicall(calls) {
    const list = calls.map((c) => ({ methodName: c.methodName, params: c.params || [] }));
    if (this.supportsMulticall()) {
      try {
        const res = await this.call('system.multicall', [list]);
        if (Array.isArray(res) && res.length === list.length) {
          return res.map((item) => {
            // The xmlrpc client unwraps the multicall envelope: a successful call
            // yields its value directly, while a fault arrives as a
            // { faultCode, faultString } struct.
            if (
              item &&
              typeof item === 'object' &&
              !Array.isArray(item) &&
              (item.faultString !== undefined || item.faultCode !== undefined)
            ) {
              return { error: item.faultString || `fault ${item.faultCode}` };
            }
            return { value: item };
          });
        }
      } catch {
        /* fall through to sequential */
      }
    }
    const settled = await Promise.allSettled(list.map((c) => this.call(c.methodName, c.params)));
    return settled.map((r) =>
      r.status === 'fulfilled'
        ? { value: r.value }
        : { error: r.reason?.message || String(r.reason) },
    );
  }

  /** Lightweight reachability + identity probe (batched into one round-trip). */
  async ping() {
    const [version, state, identification] = await this.multicall([
      { methodName: 'supervisor.getSupervisorVersion' },
      { methodName: 'supervisor.getState' },
      { methodName: 'supervisor.getIdentification' },
    ]);
    if (state.error) throw new Error(state.error);
    return {
      version: version.value ?? null,
      state: state.value,
      identification: identification.value ?? null,
    };
  }

  /** Whether this connector can run arbitrary shell commands (for diagnose/install). */
  supportsExec() {
    return false;
  }

  /**
   * Run a shell command on the target. Only connectors with shell access
   * (local, ssh, docker) implement this.
   * @param {string} _command
   * @param {{ input?: string, onData?: (chunk: string, stream: 'stdout'|'stderr') => void }} [_opts]
   * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
   */

  async exec(_command, _opts = {}) {
    throw new Error('Bu bağlantı türü shell komutu çalıştırmayı desteklemiyor.');
  }

  /** Free per-connection resources (tunnels, sockets). Override if needed. */
  async close() {}
}
