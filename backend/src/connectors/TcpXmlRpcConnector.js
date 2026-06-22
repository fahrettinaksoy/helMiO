import xmlrpc from 'xmlrpc';
import { BaseConnector } from './BaseConnector.js';

/**
 * RECOMMENDED connector.
 *
 * Talks XML-RPC directly to supervisord's [inet_http_server] over TCP.
 * Lowest latency, no extra processes on the target host. Requires the target
 * supervisord.conf to expose:
 *
 *   [inet_http_server]
 *   port=*:9001
 *   username=admin      ; optional (recommended)
 *   password=secret
 *
 * Server definition fields used:
 *   host, port, secure (bool -> https), username, password, path (default /RPC2)
 */
export class TcpXmlRpcConnector extends BaseConnector {
  constructor(server) {
    super(server);
    const { host, port = 9001, secure = false, username, password, path = '/RPC2' } = server;

    const options = { host, port: Number(port), path };
    if (username) {
      options.basic_auth = { user: username, pass: password ?? '' };
    }

    this.client = secure ? xmlrpc.createSecureClient(options) : xmlrpc.createClient(options);
  }

  call(method, params = []) {
    return new Promise((resolve, reject) => {
      this.client.methodCall(method, params, (err, value) => {
        if (err) return reject(normalizeError(err));
        resolve(value);
      });
    });
  }

  supportsMulticall() {
    return true;
  }
}

/** Surface a useful message for the common failure modes. */
function normalizeError(err) {
  if (err?.code === 'ECONNREFUSED') {
    return new Error(
      'Bağlantı reddedildi — supervisord açık değil veya [inet_http_server] portu yanlış.',
    );
  }
  if (err?.code === 'ETIMEDOUT' || err?.code === 'EHOSTUNREACH') {
    return new Error('Sunucuya ulaşılamadı (timeout/host unreachable).');
  }
  // supervisord returns XML-RPC faults with faultCode/faultString
  if (err?.faultString) {
    return new Error(`Supervisor hatası: ${err.faultString}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
