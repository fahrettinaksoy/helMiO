import { nanoid } from 'nanoid';

/**
 * In-memory ring buffer of recent supervisor events per server, feeding the
 * live "event feed" UI. Events are ephemeral telemetry — they are NOT persisted
 * (the audit log covers durable who-did-what records). A bounded buffer keeps
 * memory flat regardless of event volume.
 */
const MAX_PER_SERVER = 500;

const buffers = new Map(); // serverId -> event[] (newest last)

// Per-process recent state-change timestamps, for server-side flapping detection.
const flapTracker = new Map(); // `${serverId}:${proc}` -> number[] (epoch ms)

/** Map a PROCESS_STATE_* eventname to a coarse status for the UI. */
function stateFromEventName(name) {
  if (!name || !name.startsWith('PROCESS_STATE_')) return null;
  return name.slice('PROCESS_STATE_'.length); // RUNNING / FATAL / STOPPED / ...
}

export const eventStore = {
  /**
   * Record a normalized event and return the stored record plus any derived
   * alert. `now` is injected so the caller controls the clock (testability).
   */
  add(serverId, event, now = Date.now()) {
    const record = {
      id: nanoid(10),
      at: now,
      eventname: event.eventname || 'UNKNOWN',
      serial: event.serial != null ? Number(event.serial) : null,
      pool: event.pool || null,
      processname: event.payload?.processname || null,
      groupname: event.payload?.groupname || null,
      fromState: event.payload?.from_state || null,
      pid: event.payload?.pid ? Number(event.payload.pid) : null,
      expected: event.payload?.expected != null ? Number(event.payload.expected) : null,
      state: stateFromEventName(event.eventname),
      data: event.payload?.data || null,
    };

    let buf = buffers.get(serverId);
    if (!buf) { buf = []; buffers.set(serverId, buf); }
    buf.push(record);
    if (buf.length > MAX_PER_SERVER) buf.splice(0, buf.length - MAX_PER_SERVER);

    return { record, alert: deriveAlert(serverId, record, now) };
  },

  /** Recent events for a server, newest first. */
  list(serverId, limit = 200) {
    const buf = buffers.get(serverId) || [];
    return buf.slice(-limit).reverse();
  },

  clear(serverId) {
    buffers.delete(serverId);
    for (const k of [...flapTracker.keys()]) {
      if (k.startsWith(`${serverId}:`)) flapTracker.delete(k);
    }
  },
};

/**
 * Derive an alert from a state-change event:
 *   - FATAL  -> process gave up starting
 *   - flapping -> 3+ state changes within 60s for the same process
 */
function deriveAlert(serverId, record, now) {
  const proc = record.processname
    ? (record.groupname && record.groupname !== record.processname
        ? `${record.groupname}:${record.processname}`
        : record.processname)
    : null;

  if (record.state === 'FATAL') {
    return { type: 'fatal', fullName: proc, at: now };
  }

  if (proc && record.eventname?.startsWith('PROCESS_STATE_')) {
    const key = `${serverId}:${proc}`;
    const arr = (flapTracker.get(key) || []).filter((t) => now - t < 60000);
    arr.push(now);
    flapTracker.set(key, arr);
    if (arr.length >= 3 && (record.state === 'BACKOFF' || record.state === 'STARTING')) {
      return { type: 'flapping', fullName: proc, at: now };
    }
  }
  return null;
}
