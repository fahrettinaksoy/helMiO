import { EventEmitter } from 'node:events';

/**
 * Process-wide event bus that decouples the ingest endpoint (HTTP) from the
 * realtime layer (Socket.IO). The ingest route emits; realtime.js subscribes.
 *
 * Channels:
 *   'event' -> { serverId, event }   a normalized supervisor event arrived
 *   'alert' -> { serverId, alert }   a derived alert (fatal / flapping / ...)
 */
export const eventBus = new EventEmitter();
// Many sockets/servers may listen; lift the default 10-listener warning cap.
eventBus.setMaxListeners(0);
