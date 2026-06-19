/** Wrap async route handlers so rejected promises hit the error middleware. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const SECRET_FIELDS = ['password', 'privateKey', 'sshPassword', 'agentToken', 'ingestToken'];

/** Mask secret fields before sending a server definition to the client. */
export function publicServer(server) {
  const out = { ...server };
  for (const f of SECRET_FIELDS) {
    if (out[f]) out[f] = '••••••';
  }
  return out;
}
