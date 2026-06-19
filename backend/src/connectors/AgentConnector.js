import { BaseConnector } from './BaseConnector.js';

/**
 * Talks to a Helmio Agent (see /agent) installed on the target host. The agent
 * proxies XML-RPC to the local supervisord, so here we just POST method/params
 * over HTTP(S) with a bearer token.
 *
 * Server definition fields:
 *   agentUrl   e.g. http://host:8787
 *   agentToken bearer token (must match the agent's AGENT_TOKEN)
 */
export class AgentConnector extends BaseConnector {
  constructor(server) {
    super(server);
    this.base = String(server.agentUrl || '').replace(/\/+$/, '');
    this.token = server.agentToken || '';
  }

  async call(method, params = []) {
    if (!this.base) throw new Error('Agent URL tanımlı değil.');
    let res;
    try {
      res = await fetch(`${this.base}/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ method, params }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      if (err.name === 'TimeoutError') throw new Error('Agent zaman aşımı.');
      throw new Error(`Agent'a ulaşılamadı: ${err.message}`);
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Agent geçersiz yanıt döndü (HTTP ${res.status}).`);
    }

    if (!res.ok) {
      if (res.status === 401) throw new Error('Agent: yetkisiz (token hatalı).');
      throw new Error(data?.error || `Agent hatası (HTTP ${res.status}).`);
    }
    return data.result;
  }

  // The agent proxies arbitrary methods to supervisord, which supports
  // system.multicall. If an older agent rejects it, BaseConnector.multicall
  // transparently falls back to sequential calls.
  supportsMulticall() {
    return true;
  }
}
