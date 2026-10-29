import { io, type Socket } from 'socket.io-client';
import type { Transport } from './engine';

/**
 * The one Socket.IO client of the app (07 §4.1): same origin by default (`VITE_API_BASE_URL` empty, DEC-29),
 * path `VITE_WS_PATH` (`/ws`), the session cookie sent with the handshake (`withCredentials`), WebSocket
 * first with the long-polling fallback when the server allows it (`WS_TRANSPORTS`), automatic reconnection
 * with a randomised backoff (1 s doubling to 15 s). The client never asks for rooms: the server decides.
 */
export function createSocketTransport(): Transport {
  const base = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');
  const path = import.meta.env.VITE_WS_PATH || '/ws';
  const options = {
    path,
    autoConnect: false,
    withCredentials: true,
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 15_000,
    randomizationFactor: 0.5,
    timeout: 10_000,
  };
  const socket: Socket = base ? io(base, options) : io(options);
  let manual = false;

  return {
    connect() {
      manual = false;
      if (!socket.connected && !socket.active) socket.connect();
    },
    disconnect() {
      manual = true;
      socket.disconnect();
    },
    get connected() {
      return socket.connected;
    },
    onStatus(listener) {
      const onConnect = () => listener('connected');
      const onDisconnect = () => {
        if (!manual) listener('disconnected');
      };
      const onError = (error: Error & { data?: { code?: unknown } }) => {
        const code = typeof error?.data?.code === 'string' ? error.data.code : undefined;
        listener('error', code);
      };
      socket.on('connect', onConnect);
      socket.on('disconnect', onDisconnect);
      socket.on('connect_error', onError);
      return () => {
        socket.off('connect', onConnect);
        socket.off('disconnect', onDisconnect);
        socket.off('connect_error', onError);
      };
    },
    onFrame(listener) {
      const any = (event: string, frame: unknown) => listener(event, frame);
      socket.onAny(any);
      return () => socket.offAny(any);
    },
    ack(event, payload, timeoutMs) {
      return socket.timeout(timeoutMs).emitWithAck(event, payload);
    },
  };
}
