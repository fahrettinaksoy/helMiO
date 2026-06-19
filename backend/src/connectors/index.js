import { TcpXmlRpcConnector } from './TcpXmlRpcConnector.js';
import { LocalConnector } from './LocalConnector.js';
import { SshUnixSocketConnector } from './SshUnixSocketConnector.js';
import { DockerConnector } from './DockerConnector.js';
import { AgentConnector } from './AgentConnector.js';

/** Connection methods exposed to the UI. `recommended` drives ordering/badges. */
export const CONNECTION_METHODS = [
  {
    id: 'tcp',
    label: 'TCP XML-RPC (inet_http_server)',
    recommended: true,
    available: true,
    description: "supervisord'un TCP portuna doğrudan XML-RPC. En verimli, en az kurulum. Uzak/WSL/Docker (port publish) için ideal.",
    fields: ['host', 'port', 'secure', 'username', 'password', 'path'],
  },
  {
    id: 'local',
    label: 'Yerel Unix Socket',
    recommended: false,
    available: true,
    description: 'Aynı makinedeki supervisord socket\'ine port açmadan bağlanır. Yerel dev (macOS/Linux) veya socket mount edilmiş Docker için.',
    fields: ['socketPath', 'username', 'password', 'path'],
  },
  {
    id: 'ssh',
    label: 'SSH tüneli',
    recommended: false,
    available: true,
    description: 'supervisord unix socket / localhost TCP erişimi SSH üzerinden. Port açmaya gerek yok, SSH erişimi yeterli.',
    fields: ['sshHost', 'sshPort', 'sshUser', 'sshPassword', 'privateKey', 'target', 'socketPath', 'targetHost', 'targetPort', 'username', 'password', 'path'],
  },
  {
    id: 'docker',
    label: 'Docker (exec)',
    recommended: false,
    available: true,
    description: 'Container içindeki supervisord\'a port açmadan, docker exec ile erişir. Helmio\'nun Docker daemon\'a erişimi gerekir.',
    fields: ['container', 'connection', 'dockerSocket', 'dockerHost', 'dockerPort', 'confPath'],
  },
  {
    id: 'agent',
    label: 'Helmio Agent',
    recommended: false,
    available: true,
    description: 'Hedef sunucuya kurulan ajan, supervisord\'a yerelden bağlanır. NAT/firewall arkası için ideal.',
    fields: ['agentUrl', 'agentToken'],
  },
];

const REGISTRY = {
  tcp: TcpXmlRpcConnector,
  local: LocalConnector,
  ssh: SshUnixSocketConnector,
  docker: DockerConnector,
  agent: AgentConnector,
};

/** Build a fresh connector without touching the cache (used for ad-hoc tests). */
export function createConnector(server) {
  const Ctor = REGISTRY[server.method];
  if (!Ctor) throw new Error(`Bilinmeyen bağlantı yöntemi: ${server.method}`);
  return new Ctor(server);
}

/** Cache connector instances per server id so XML-RPC clients are reused. */
const cache = new Map();

export function getConnector(server) {
  const cached = cache.get(server.id);
  // Rebuild if the definition changed (updatedAt differs).
  if (cached && cached.updatedAt === server.updatedAt) return cached.connector;

  const connector = createConnector(server);
  cache.set(server.id, { connector, updatedAt: server.updatedAt });
  return connector;
}

export async function dropConnector(serverId) {
  const cached = cache.get(serverId);
  if (cached) {
    await cached.connector.close().catch(() => {});
    cache.delete(serverId);
  }
}
