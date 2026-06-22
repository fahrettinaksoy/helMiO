import { defineStore } from 'pinia';
import { ref, reactive } from 'vue';
import socket from '@/api/socket';

/**
 * Holds the latest realtime snapshot per server id, fed by Socket.IO. Views
 * call subscribe(serverId) on mount and unsubscribe on unmount.
 *
 * Two update paths feed this store:
 *   - "snapshot"  periodic full poll (works always)
 *   - "event"     push from the supervisord eventlistener (instant, when installed)
 * Alerts come from both the client-side snapshot diff AND server-side event
 * detection; pushAlert() de-dupes so the same alert is not shown twice.
 */
export const useRealtimeStore = defineStore('realtime', () => {
  const connected = ref(socket.connected);
  const snapshots = reactive({}); // serverId -> snapshot
  const errors = reactive({}); // serverId -> error message
  const lastUpdate = reactive({}); // serverId -> timestamp
  const subscriptions = reactive({}); // serverId -> ref count
  const alerts = ref([]); // { id, serverId, fullName, type, at } — newest last
  const events = reactive({}); // serverId -> event[] (newest first, capped)
  const prevStates = {}; // serverId -> { fullName: { statecode, flapping } }
  const recentAlertKeys = new Map(); // dedup: `${serverId}:${fullName}:${type}` -> at
  let alertSeq = 0;

  function pushAlert({ serverId, fullName, type, at }) {
    const key = `${serverId}:${fullName}:${type}`;
    const last = recentAlertKeys.get(key);
    if (last && at - last < 5000) return; // same alert within 5s → ignore
    recentAlertKeys.set(key, at);
    alerts.value.push({ id: ++alertSeq, serverId, fullName, type, at });
    if (alerts.value.length > 50) alerts.value = alerts.value.slice(-50);
  }

  function detectAlerts(serverId, snapshot, at) {
    const prev = prevStates[serverId] || {};
    const next = {};
    for (const p of snapshot.processes || []) {
      next[p.fullName] = { statecode: p.statecode, flapping: !!p.flapping };
      const pr = prev[p.fullName];
      if (!pr) continue; // skip first observation to avoid load-time flood
      if (p.statecode === 200 && pr.statecode !== 200) {
        pushAlert({ serverId, fullName: p.fullName, type: 'fatal', at });
      }
      if (p.flapping && !pr.flapping) {
        pushAlert({ serverId, fullName: p.fullName, type: 'flapping', at });
      }
    }
    prevStates[serverId] = next;
  }

  socket.on('connect', () => {
    connected.value = true;
    // Re-subscribe to everything after a reconnect.
    for (const serverId of Object.keys(subscriptions)) {
      if (subscriptions[serverId] > 0) socket.emit('subscribe', { serverId });
    }
  });
  socket.on('disconnect', () => {
    connected.value = false;
  });

  socket.on('snapshot', ({ serverId, snapshot, at }) => {
    detectAlerts(serverId, snapshot, at);
    snapshots[serverId] = snapshot;
    errors[serverId] = null;
    lastUpdate[serverId] = at;
  });

  socket.on('error', ({ serverId, error, at }) => {
    errors[serverId] = error;
    lastUpdate[serverId] = at;
  });

  // Push event from the eventlistener: prepend to the per-server feed.
  socket.on('event', ({ serverId, event }) => {
    if (!events[serverId]) events[serverId] = [];
    events[serverId].unshift(event);
    if (events[serverId].length > 200) events[serverId].length = 200;
  });

  // Server-derived alert (instant, from a state-change event).
  socket.on('alert', ({ serverId, type, fullName, at }) => {
    pushAlert({ serverId, fullName, type, at: at || Date.now() });
  });

  function subscribe(serverId) {
    subscriptions[serverId] = (subscriptions[serverId] || 0) + 1;
    if (subscriptions[serverId] === 1) socket.emit('subscribe', { serverId });
  }

  function unsubscribe(serverId) {
    if (!subscriptions[serverId]) return;
    subscriptions[serverId] -= 1;
    if (subscriptions[serverId] <= 0) {
      delete subscriptions[serverId];
      socket.emit('unsubscribe', { serverId });
    }
  }

  return { connected, snapshots, errors, lastUpdate, alerts, events, subscribe, unsubscribe };
});
