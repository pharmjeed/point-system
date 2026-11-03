import { isDefinitiveError } from '@/api/errors';
import { queryKeys } from '@/api/queryClient';
import type { Alert, Task } from '@/api/types';
import { applyAlertReply } from '@/features/supervisor/cache';
import { staffKeys } from '@/features/supervisor/staffApi';
import { serverNow } from '@/lib/serverClock';
import { RealtimeEngine, type EngineEnv, type EngineHooks, type Transport } from './engine';
import type { AcquireOptions, RealtimeHandle } from './manager';
import type { ServerEvent } from './protocol';
import { setChannelHealth } from './syncStore';
import { createSocketTransport } from './transport';

/**
 * The staff screens' realtime client (S-02 … S-13; PNT-065): every server event invalidates the React Query
 * keys of docs/progress/notes/web-supervisor.md («Query keys»), so the open screens re-read what changed; the
 * resync re-reads everything under `['staff']` (the operations board first, 02 §1.7). The supervisor's alert
 * sound follows the alert lists (OpsArea): an `alert.updated` is applied to the cached lists at once so an
 * acknowledged escalation stops without waiting for the refetch.
 */
const APP_VERSION = import.meta.env.VITE_APP_VERSION || '0.0.0';

export function staffEvents(options: AcquireOptions) {
  const { qc } = options;
  const invalidate = (...keys: ReadonlyArray<readonly unknown[]>) => {
    for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
  };
  return (event: ServerEvent): void => {
    switch (event.type) {
      case 'ticket.updated': {
        const t = event.payload;
        invalidate(staffKeys.ticket(t.id), staffKeys.boards(), staffKeys.event(t.event_id), [
          'staff',
          'ticket-search',
        ]);
        return;
      }
      case 'task.offered':
      case 'task.broadcast':
      case 'task.claimed':
      case 'offer.closed':
        invalidate(staffKeys.boards());
        return;
      case 'task.updated': {
        const p = event.payload as Partial<Task> & { ticket?: { id?: string } };
        const ticketId = p.ticket_id ?? p.ticket?.id;
        invalidate(staffKeys.boards(), ...(ticketId ? [staffKeys.ticket(ticketId)] : []));
        return;
      }
      case 'driver.state_changed':
        // S-05 / S-06 read `queryKeys.drivers` (02 S-05 «التحديث الحي عبر driver.state_changed»)
        invalidate(
          staffKeys.boards(),
          ['staff', 'drivers'],
          staffKeys.driver(event.payload.driver.id),
          queryKeys.drivers,
        );
        return;
      case 'alert.raised':
        invalidate(staffKeys.alerts(), staffKeys.boards());
        return;
      case 'alert.updated': {
        const { cause: _cause, ...alert } = event.payload;
        applyAlertReply(qc, alert as Alert);
        invalidate(staffKeys.alerts(), staffKeys.boards());
        return;
      }
      case 'incident.updated': {
        const incident = event.payload;
        invalidate(
          staffKeys.incidents(),
          staffKeys.incident(incident.id),
          ...(incident.ticket_id ? [staffKeys.timeline(incident.ticket_id)] : []),
        );
        return;
      }
      case 'channel.status':
        setChannelHealth(event.payload.whatsapp, event.payload.changed_at);
        invalidate(staffKeys.boards(), staffKeys.waChannel());
        return;
      case 'sync.required':
        if (event.payload.scope === 'me') invalidate(queryKeys.me);
        return;
      case 'session.revoked':
        // `GET /v1/me` answers AUTH_SESSION_REVOKED: RootLayout returns to S-01 with the reason line
        void qc.invalidateQueries({ queryKey: queryKeys.me, exact: true });
        return;
      default:
        return;
    }
  };
}

/** The staff engine hooks (exported for the runtime unit tests). */
export function staffHooks(options: AcquireOptions): EngineHooks {
  const { qc } = options;
  return {
    async resync(_reason, signal) {
      try {
        await qc.invalidateQueries({ queryKey: staffKeys.all }, { throwOnError: true });
        if (signal.aborted) return { ok: false };
        void qc.invalidateQueries({ queryKey: queryKeys.me, exact: true });
        void qc.invalidateQueries({ queryKey: queryKeys.drivers }); // S-05 / S-06 (not under ['staff'])
        return { ok: true, serverTime: new Date(serverNow()).toISOString() };
      } catch (error) {
        // a board that could not be read (5xx, 429, no reply) is not a sync: «قديم» stays and it is tried again
        return { ok: isDefinitiveError(error) };
      }
    },
    onEvent: staffEvents(options),
    heartbeatBody: () => ({
      visible: typeof document === 'undefined' || document.visibilityState === 'visible',
      audio_unlocked: false,
      app_version: APP_VERSION,
    }),
    // closed or refused: `GET /v1/me` decides (S-01 when the session ended); otherwise the engine reconnects
    checkSession: () => void qc.invalidateQueries({ queryKey: queryKeys.me, exact: true }),
  };
}

export function startRealtime(
  options: AcquireOptions,
  deps: { transport?: Transport; env?: EngineEnv } = {},
): RealtimeHandle {
  const engine = new RealtimeEngine(deps.transport ?? createSocketTransport(), staffHooks(options), deps.env);
  engine.start();
  return { engine, stop: () => engine.stop() };
}
