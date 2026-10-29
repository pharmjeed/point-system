import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/api/queryClient';
import type { DriverHome, TaskCard } from '@/api/types';
import { homeRegistry, resetHomeRegistry } from '@/features/driver/useDriverHome';
import { playSound } from '@/lib/audio';
import { driverEvents, startRealtime } from '@/realtime/driverRuntime';
import { RESYNC_RETRY_MS } from '@/realtime/engine';
import { commandGate } from '@/realtime/hooks';
import { useOfferLive } from '@/realtime/offerStore';
import type { ServerEvent } from '@/realtime/protocol';
import { resetSync, useSyncStore } from '@/realtime/syncStore';
import { useFieldStore } from '@/stores/field';
import { useUiStore } from '@/stores/ui';
import { applyOffer } from '@/realtime/driverHome';
import { FakeEnv, FakeTransport } from './engineFakes';
import { home, IDS, offerCard, taskCard } from './fixtures';

vi.mock('@/lib/audio', async (original) => ({
  ...(await original<typeof import('@/lib/audio')>()),
  playSound: vi.fn(async () => true),
  stopSound: vi.fn(),
}));

const options = (qc: QueryClient) => ({ area: 'driver' as const, userId: IDS.me, qc, hasDuty: () => true });

function reply(status: number, body: unknown) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const errorBody = (code: string, retryable: boolean) => ({
  error: { code, message: code, message_ar: `نص ${code}`, retryable, details: {} },
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSync();
  resetHomeRegistry();
  useFieldStore.getState().reset();
  useOfferLive.getState().reset();
  vi.mocked(playSound).mockClear();
});

describe('the driver resync counts only the server state as a sync (PNT-065 AC2)', () => {
  let qc: QueryClient;
  let stop: () => void;
  beforeEach(() => {
    qc = new QueryClient();
  });
  afterEach(() => stop?.());

  const start = () => {
    const env = new FakeEnv();
    const handle = startRealtime(options(qc), { transport: new FakeTransport(), env });
    stop = handle.stop;
    return env;
  };

  it.each([
    ['SERVICE_UNAVAILABLE', 503, errorBody('SERVICE_UNAVAILABLE', true)],
    ['DEPENDENCY_TIMEOUT', 504, errorBody('DEPENDENCY_TIMEOUT', true)],
    ['INTERNAL_ERROR', 500, errorBody('INTERNAL_ERROR', false)],
    ['a proxy 502 without an envelope', 502, undefined],
    ['RATE_LIMITED', 429, errorBody('RATE_LIMITED', false)],
  ])('%s keeps the data stale, the commands closed, and tries again', async (_name, status, body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(status, body)),
    );
    const env = start();
    await vi.waitFor(() => expect(env.pending()).toContain(RESYNC_RETRY_MS));
    const s = useSyncStore.getState();
    expect(s).toMatchObject({ stale: true, lastSyncAt: null });
    expect(commandGate('online', s.stale).ready).toBe(false);
    expect(s.serviceDown).toBe(status === 503); // 02 D-15 ح
  });

  it('a definitive 4xx (no assignment) is the server state: the sync is complete', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(403, errorBody('ASSIGNMENT_REQUIRED', false))),
    );
    start();
    await vi.waitFor(() => expect(useSyncStore.getState().stale).toBe(false));
  });

  it('the retry after a 503 that succeeds clears stale and the D-15 ح screen', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply(503, errorBody('SERVICE_UNAVAILABLE', true)))
      .mockResolvedValue(reply(200, { data: home(), meta: { server_time: '2026-10-29T18:00:05.000Z' } }));
    vi.stubGlobal('fetch', fetch);
    const env = start();
    await vi.waitFor(() => expect(env.pending()).toContain(RESYNC_RETRY_MS));
    expect(useSyncStore.getState().serviceDown).toBe(true);
    env.run(RESYNC_RETRY_MS);
    await vi.waitFor(() => expect(useSyncStore.getState().stale).toBe(false));
    // «آخر مزامنة» is the snapshot's own server_time
    expect(useSyncStore.getState()).toMatchObject({
      serviceDown: false,
      lastSyncAt: '2026-10-29T18:00:00.000Z',
    });
    expect(qc.getQueryData<DriverHome>(queryKeys.home)?.server_time).toBe('2026-10-29T18:00:00.000Z');
  });

  it('a snapshot still travelling at sign-out writes neither the cache nor the sync state', async () => {
    let answer: (r: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            answer = resolve;
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      ),
    );
    start();
    stop(); // useLogout / RootLayout: stopRealtime()
    resetSync();
    qc.clear();
    answer(reply(200, { data: home(), meta: { server_time: '2026-10-29T18:00:05.000Z' } }));
    await new Promise((r) => setTimeout(r, 10));
    expect(qc.getQueryData(queryKeys.home)).toBeUndefined();
    expect(useSyncStore.getState()).toMatchObject({ stale: true, lastSyncAt: null });
  });
});

// ---------------------------------------------------------------- events → notices and sounds (14 §3, §5.1)

function event<T extends ServerEvent['type']>(
  type: T,
  payload: Record<string, unknown>,
  aggregate: ServerEvent['aggregate'] = null,
): ServerEvent {
  return {
    id: globalThis.crypto.randomUUID(),
    type,
    occurred_at: '2026-10-29T18:00:01.000Z',
    venue_id: IDS.venue,
    dispatch_pool_id: null,
    event_id: null,
    aggregate,
    payload,
  } as unknown as ServerEvent;
}

const card = (taskId: string, status: TaskCard['task']['status'], version: number, patch: object = {}) => ({
  ...taskCard(taskId, status, version),
  ...patch,
});

describe('driver events (14 §3.1–§3.2, §5.1; 02 D-04, D-09, D-10)', () => {
  let qc: QueryClient;
  let onEvent: (e: ServerEvent) => void;
  beforeEach(() => {
    qc = new QueryClient();
    onEvent = driverEvents(options(qc));
  });

  it('a cancel of the current retrieval: «أُلغي طلب الإحضار — تذكرة n» without a sound', () => {
    qc.setQueryData(queryKeys.home, home({ current_task: taskCard(IDS.taskA, 'in_progress', 3) }));
    onEvent(
      event(
        'task.updated',
        { cause: 'task.canceled', ...card(IDS.taskA, 'canceled', 4) },
        {
          type: 'task',
          id: IDS.taskA,
          version: 4,
        },
      ),
    );
    expect(qc.getQueryData<DriverHome>(queryKeys.home)?.current_task).toBeNull();
    expect(useFieldStore.getState().notices).toMatchObject([
      { kind: 'canceled', taskId: IDS.taskA, ticketNumber: 125 },
    ]);
    expect(playSound).not.toHaveBeenCalled();
  });

  it('a cancel of the reserved next task (Task view) is a cancel too, not a withdrawal', () => {
    qc.setQueryData(
      queryKeys.home,
      home({
        current_task: taskCard(IDS.taskA, 'in_progress', 3),
        next_task: taskCard(IDS.taskB, 'assigned_waiting', 2, IDS.ticketB, 131),
      }),
    );
    onEvent(
      event('task.updated', {
        cause: 'task.canceled',
        id: IDS.taskB,
        ticket_id: IDS.ticketB,
        type: 'retrieve',
        status: 'canceled',
        version: 3,
        assignee: null,
      }),
    );
    expect(useFieldStore.getState().notices).toMatchObject([{ kind: 'canceled', ticketNumber: 131 }]);
    expect(playSound).not.toHaveBeenCalled();
  });

  it('a withdrawal: the red notice and `reminder` (14 §3.2 task.withdrawn)', () => {
    qc.setQueryData(queryKeys.home, home({ current_task: taskCard(IDS.taskA, 'accepted', 3) }));
    onEvent(
      event('task.updated', {
        cause: 'task.withdrawn',
        id: IDS.taskA,
        ticket_id: IDS.ticketA,
        type: 'retrieve',
        status: 'queued',
        version: 4,
        assignee: null,
      }),
    );
    expect(useFieldStore.getState().notices).toMatchObject([{ kind: 'withdrawn', ticketNumber: 125 }]);
    expect(playSound).toHaveBeenCalledWith('reminder', { key: `task:${IDS.taskA}` });
  });

  it('the promotion of the reserved next task is announced on any screen (next_due via the dialog)', () => {
    qc.setQueryData(
      queryKeys.home,
      home({
        current_task: taskCard(IDS.taskA, 'in_progress', 3),
        next_task: taskCard(IDS.taskB, 'assigned_waiting', 2, IDS.ticketB, 131),
      }),
    );
    // the current retrieval canceled before it started → the next task is promoted (10 §6.3)
    onEvent(event('task.updated', { cause: 'task.canceled', ...card(IDS.taskA, 'canceled', 4) }));
    onEvent(
      event('task.updated', {
        cause: 'task.promoted',
        ...taskCard(IDS.taskB, 'accepted', 3, IDS.ticketB, 131),
      }),
    );
    const { promotion, announced } = useFieldStore.getState();
    expect(promotion).toMatchObject({ card: { task: { id: IDS.taskB } }, title: 'بدأت مهمتك التالية: #{n}' });
    expect(announced).toContain(IDS.taskB);
    expect(qc.getQueryData<DriverHome>(queryKeys.home)?.current_task?.task.id).toBe(IDS.taskB);
  });

  it('while D-08 / D-11 complete the current task, the promotion is theirs to announce', () => {
    qc.setQueryData(
      queryKeys.home,
      home({
        current_task: taskCard(IDS.taskA, 'in_progress', 3),
        next_task: taskCard(IDS.taskB, 'assigned_waiting', 2),
      }),
    );
    useFieldStore.getState().setCompleting(Date.now() + 30_000);
    onEvent(event('task.updated', { cause: 'task.promoted', ...taskCard(IDS.taskB, 'accepted', 3) }));
    expect(useFieldStore.getState().promotion).toBeNull();
  });

  it('the repark after a supervisor cancel (DEC-30): the D-08 notice and next_due', () => {
    qc.setQueryData(queryKeys.home, home({ current_task: taskCard(IDS.taskA, 'in_progress', 5) }));
    onEvent(event('task.updated', { cause: 'task.canceled', ...card(IDS.taskA, 'canceled', 6) }));
    const repark = taskCard(IDS.taskC, 'in_progress', 1);
    repark.task.type = 'repark';
    onEvent(event('task.updated', { cause: 'ticket.reparking', ...repark }));
    expect(useFieldStore.getState().notices.map((n) => n.kind)).toEqual(['canceled', 'repark']);
    expect(playSound).toHaveBeenCalledWith('next_due', { key: `task:${IDS.taskC}` });
    expect(qc.getQueryData<DriverHome>(queryKeys.home)?.current_task?.task.type).toBe('repark');
  });

  it('an early request during parking: 02 D-08 notice and `reminder` for the parking driver only', () => {
    const park = taskCard(IDS.taskA, 'in_progress', 2);
    park.task.type = 'park';
    park.ticket.status = 'parking';
    qc.setQueryData(queryKeys.home, home({ current_task: park }));
    const summary = {
      id: IDS.ticketA,
      display_number: 125,
      status: 'parking',
      version: 4,
      plate: { country: 'SA', display: '1234' },
      vehicle: {},
    };
    onEvent(event('ticket.updated', { cause: 'ticket.retrieval_requested_early', ...summary }));
    expect(useFieldStore.getState().notices).toMatchObject([{ kind: 'early', taskId: IDS.taskA }]);
    expect(playSound).toHaveBeenCalledWith('reminder', { key: `task:${IDS.taskA}` });
    // another ticket's early request is not this driver's
    vi.mocked(playSound).mockClear();
    onEvent(
      event('ticket.updated', {
        cause: 'ticket.retrieval_requested_early',
        ...summary,
        id: IDS.ticketB,
        version: 9,
      }),
    );
    expect(playSound).not.toHaveBeenCalled();
  });

  it('«قبل الطلب سائق آخر» only when the card is on screen (02 D-09)', () => {
    const offer = offerCard(IDS.offerA, IDS.taskA, '2026-10-29T17:58:00.000Z', { mode: 'broadcast' });
    const claimed = () =>
      event('task.claimed', {
        cause: 'task.claimed',
        task_id: IDS.taskA,
        offer_ids: [IDS.offerA],
        result: 'accepted',
        claimed_by: { id: IDS.other },
      });
    qc.setQueryData(queryKeys.home, applyOffer(home(), offer, homeRegistry, Date.now()));
    onEvent(claimed()); // D-12 open: the banner only, the card never rendered
    expect(useUiStore.getState().toasts).toEqual([]);
    resetHomeRegistry();
    qc.setQueryData(queryKeys.home, applyOffer(home(), offer, homeRegistry, Date.now()));
    useOfferLive.getState().setOnScreen(IDS.offerA); // D-04, or the Sheet open
    onEvent(claimed());
    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual(['قبل الطلب سائق آخر']);
  });
});
