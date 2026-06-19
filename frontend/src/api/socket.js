import { io } from 'socket.io-client';

// Connects to the same origin (Vite proxies /socket.io to the backend in dev).
// autoConnect is OFF: the auth store connects once a valid token is present and
// reconnects with the new token after login/logout.
const socket = io(import.meta.env.VITE_SOCKET_URL || '/', {
  autoConnect: false,
  transports: ['websocket', 'polling'],
  auth: { token: localStorage.getItem('helmio-token') || '' },
});

export default socket;
