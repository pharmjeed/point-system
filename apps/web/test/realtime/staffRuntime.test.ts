import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/queryClient';
import type { Alert, OperationsBoard } from '@/api/types';
import { staffKeys, type Page } from '@/features/supervisor/staffApi';
import type { ServerEvent } from '@/realtime/protocol';
import { staffEvents, staffHooks } from '@/realtime/staffRuntime';
import { resetSync, useSyncStore } from '@/realtime/syncStore';
import { IDS } from './fixtures';

/**
 * The staff screens' realtime wiring (PNT-065; docs/progress/notes/web-supervisor.md «Query keys»): every canon
 * event invalidates the React Query keys of that table, `alert.updated` is applied to the cached lists first,
 * and the resync counts only the server's state as a sync.
 */
const options = (qc: QueryClient) => ({ area: 'staff' as const, userId: IDS.me, qc, hasDuty: () => false });

function event(type: ServerEvent['type'], payload: Record<string, unknown>): ServerEvent {
  return {
    id: globalThis.crypto.randomUUID(),
    type,
    occurred_at: '2026-10-29T18:00:01.000Z',
    venue_id: IDS.venue,
    dispatch_pool_id: null,
    event_id: IDS.event,
    aggregate: null,
    payload,
  } as unknown as ServerEvent;
}

/** The query keys an event invalidated. */
function invalidated(run: (onEvent: (e: ServerEvent) => void, qc: QueryClient) => void): unknown[][] {
  const qc = new QueryClient();
  const spy = vi.spyOn(qc, 'invalidateQueries');
  run(staffEvents(options(qc)), qc);
  return spy.mock.calls.map(([filters]) => [...((filters?.queryKey as unknown[]) ?? [])]);
}

const ALERT: Alert = {
  id: '44444444-4444-4444-8444-444444444444',
  venue_id: IDS.venue,
  type: 'request_unaccepted',
  severity: 'critical',
  status: 'open',
  raised_at: '2026-10-29T17:59:00.000Z',
} as Alert;

afterEach(() => {
  resetSync();
  vi.unstubAllGlobals();
});

describe('staff events → React Query keys (web-supervisor.md)', () => {
  it('ticket.updated: the ticket (and its timeline), the boards, the event, the searches', () => {
    expect(
      invalidated((on) => on(event('ticket.updated', { id: IDS.ticketA, event_id: IDS.event, version: 4 }))),
    ).toEqual([
      [...staffKeys.ticket(IDS.ticketA)],
      [...staffKeys.boards()],
      [...staffKeys.event(IDS.event)],
      ['staff', 'ticket-search'],
    ]);
  });

  it.each(['task.offered', 'task.broadcast', 'task.claimed', 'offer.closed'] as const)(
    '%s: the boards',
    (type) => {
      expect(invalidated((on) => on(event(type, { task_id: IDS.taskA, offer_id: IDS.offerA })))).toEqual([
        [...staffKeys.boards()],
      ]);
    },
  );

  it('task.updated (Task view): the boards and the ticket', () => {
    expect(
      invalidated((on) =>
        on(event('task.updated', { id: IDS.taskA, ticket_id: IDS.ticketA, status: 'queued' })),
      ),
    ).toEqual([[...staffKeys.boards()], [...staffKeys.ticket(IDS.ticketA)]]);
  });

  it('driver.state_changed: the boards, the driver lists, the driver, S-05 / S-06', () => {
    expect(
      invalidated((on) =>
        on(event('driver.state_changed', { driver: { id: IDS.other }, driver_state: 'available' })),
      ),
    ).toEqual([
      [...staffKeys.boards()],
      ['staff', 'drivers'],
      [...staffKeys.driver(IDS.other)],
      [...queryKeys.drivers],
    ]);
  });

  it('alert.raised: the alert lists and the boards', () => {
    expect(invalidated((on) => on(event('alert.raised', { ...ALERT })))).toEqual([
      [...staffKeys.alerts()],
      [...staffKeys.boards()],
    ]);
  });

  it('alert.updated is applied to the cached lists at once (the escalation stops), then re-read', () => {
    const keys = invalidated((on, qc) => {
      qc.setQueryData<Page<Alert>>(staffKeys.alerts({ status: 'open' } as never), {
        items: [ALERT],
        nextCursor: null,
      });
      qc.setQueryData<OperationsBoard>(staffKeys.board(IDS.event), { alerts: [ALERT] } as OperationsBoard);
      on(event('alert.updated', { cause: 'alert.acknowledged', ...ALERT, status: 'acknowledged' }));
      const list = qc.getQueryData<Page<Alert>>(staffKeys.alerts({ status: 'open' } as never));
      expect(list?.items[0]?.status).toBe('acknowledged');
      expect(qc.getQueryData<OperationsBoard>(staffKeys.board(IDS.event))?.alerts[0]?.status).toBe(
        'acknowledged',
      );
    });
    expect(keys).toEqual([[...staffKeys.alerts()], [...staffKeys.boards()]]);
  });

  it('incident.updated: the incident lists, the incident and the ticket timeline', () => {
    expect(
      invalidated((on) =>
        on(event('incident.updated', { id: '55555555-5555-4555-8555-555555555555', ticket_id: IDS.ticketA })),
      ),
    ).toEqual([
      [...staffKeys.incidents()],
      [...staffKeys.incident('55555555-5555-4555-8555-555555555555')],
      [...staffKeys.timeline(IDS.ticketA)],
    ]);
  });

  it('channel.status: the boards and the S-13 channel; the health strip follows', () => {
    expect(
      invalidated((on) =>
        on(event('channel.status', { whatsapp: 'down', changed_at: '2026-10-29T18:00:00.000Z' })),
      ),
    ).toEqual([[...staffKeys.boards()], [...staffKeys.waChannel()]]);
    expect(useSyncStore.getState().channel?.health).toBe('down');
  });

  it('sync.required (scope me) and session.revoked re-read the session', () => {
    expect(invalidated((on) => on(event('sync.required', { reason: 'settings', scope: 'me' })))).toEqual([
      [...queryKeys.me],
    ]);
    expect(invalidated((on) => on(event('session.revoked', { reason: 'admin' })))).toEqual([
      [...queryKeys.me],
    ]);
  });
});

describe('the staff resync (02 §1.7: the operations board first)', () => {
  const resyncWith = async (fail: unknown) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new QueryObserver(qc, {
      queryKey: staffKeys.board(IDS.event),
      queryFn: async () => {
        if (fail) throw fail;
        return { alerts: [] };
      },
    });
    const off = observer.subscribe(() => undefined); // an open S-02
    await vi.waitFor(() => expect(qc.getQueryState(staffKeys.board(IDS.event))?.status).not.toBe('pending'));
    const result = await staffHooks(options(qc)).resync('reconnect', new AbortController().signal);
    off();
    return result;
  };

  it('a board read again is a sync', async () => {
    expect((await resyncWith(null)).ok).toBe(true);
  });

  it.each([
    ['SERVICE_UNAVAILABLE', 503, true],
    ['INTERNAL_ERROR', 500, false],
    ['RATE_LIMITED', 429, false],
  ])('%s is not: «قديم» stays and the engine tries again', async (code, status, retryable) => {
    expect((await resyncWith(new ApiError({ code, status, retryable }))).ok).toBe(false);
  });

  it('a definitive refusal (permission) is the server state', async () => {
    expect(
      (await resyncWith(new ApiError({ code: 'PERMISSION_DENIED', status: 403, retryable: false }))).ok,
    ).toBe(true);
  });
});
