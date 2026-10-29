import { api } from '@/api/client';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/queryClient';
import type { DriverHome, OfferCard, Task, TaskCard, TicketDetail, TicketSummary } from '@/api/types';
import { homeRegistry, loadHomeSnapshot, updateHome } from '@/features/driver/useDriverHome';
import { d09, live } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { audioRunning, playSound, stopSound } from '@/lib/audio';
import { recordServerTime } from '@/lib/serverClock';
import { useUiStore } from '@/stores/ui';
import {
  applyDriverState,
  applyOffer,
  applyOfferClosed,
  applyTaskCard,
  applyTaskGone,
  applyTicketSummary,
  isTaskCard,
} from './driverHome';
import { RealtimeEngine, type EngineHooks } from './engine';
import type { AcquireOptions, RealtimeHandle } from './manager';
import { useOfferLive } from './offerStore';
import type { HeartbeatAck, ServerEvent } from './protocol';
import { setChannelHealth } from './syncStore';
import { createSocketTransport } from './transport';

/**
 * The driver's realtime client (07 §4.3 «سلوك العميل», 02 D-04/D-09; PNT-065/066/067): events are applied to
 * the `GET /v1/me/home` cache entry with the version rules of ./driverHome.ts; the resync reads the snapshot
 * again (and `me`, and the open ticket screens). Sounds: the arrival of the head card is announced by the
 * screen that shows it (OfferAlerts); here `task.claimed` / `offer.closed` stop the card's sound at once.
 */
export const APP_VERSION = import.meta.env.VITE_APP_VERSION || '0.0.0';
/** A refused handshake is tried again after this delay (when the session is still valid). */
export const AUTH_RETRY_MS = 15_000;

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

function stopOfferSounds(offerIds: readonly string[], head: OfferCard | null | undefined, taskId: string) {
  for (const id of offerIds) stopSound(`offer:${id}`);
  if (head && (head.task_id === taskId || offerIds.includes(head.offer_id)))
    stopSound(`offer:${head.offer_id}`);
}

export function driverEvents(options: AcquireOptions) {
  const { qc, userId } = options;
  const home = () => qc.getQueryData<DriverHome>(queryKeys.home);
  const refreshHome = () => void qc.invalidateQueries({ queryKey: queryKeys.home, exact: true });
  const toast = (message: string, tone: 'info' | 'error' = 'info') =>
    useUiStore.getState().pushToast({ message, tone });

  return (event: ServerEvent): void => {
    const now = Date.now();
    switch (event.type) {
      case 'task.offered':
      case 'task.broadcast': {
        const { cause: _cause, ...card } = event.payload;
        recordServerTime(card.server_time, now); // the countdown runs on server time (02 §1.7)
        useOfferLive.getState().noteArrival(card.offer_id, event.occurred_at);
        if (card.reminder_at && Date.parse(card.reminder_at) <= Date.parse(card.server_time))
          useOfferLive.getState().markReminded(card.offer_id);
        if (!updateHome(qc, (h) => applyOffer(h, card as OfferCard, homeRegistry, now))) refreshHome();
        return;
      }
      case 'task.claimed': {
        const p = event.payload;
        if (p.claimed_by?.id === userId) return; // this driver's own acceptance: its task.updated came first
        const before = home()?.offer;
        const shown = !!before && (before.task_id === p.task_id || p.offer_ids.includes(before.offer_id));
        stopOfferSounds(p.offer_ids, before, p.task_id); // 02 §1.7: the card's sound stops at once
        updateHome(qc, (h) => applyOfferClosed(h, p.offer_ids, p.task_id, homeRegistry));
        if (shown && visible()) toast(d09.claimedByOther); // 02 D-09: only if the card was on screen
        refreshHome();
        return;
      }
      case 'offer.closed': {
        const p = event.payload;
        stopOfferSounds([p.offer_id], home()?.offer, p.task_id);
        updateHome(qc, (h) => applyOfferClosed(h, [p.offer_id], null, homeRegistry));
        refreshHome();
        return;
      }
      case 'offer.reminder': {
        useOfferLive.getState().markReminded(event.payload.offer_id);
        return;
      }
      case 'task.updated': {
        const p = event.payload;
        if (isTaskCard(p)) {
          const { cause, ...card } = p as TaskCard & { cause?: string };
          const before = home();
          const known =
            before?.current_task?.task.id === card.task.id || before?.next_task?.task.id === card.task.id;
          const result = { applied: false };
          updateHome(qc, (h) => {
            const r = applyTaskCard(h, card, homeRegistry, now);
            result.applied = r.applied;
            return r.home;
          });
          // a direct assignment (reassignment to this driver, a repark by the supervisor): next_due (14 §7);
          // the promotion of the reserved next task is announced by D-04 with its dialog (02 D-04)
          if (
            result.applied &&
            !known &&
            (card.task.status === 'accepted' || card.task.status === 'in_progress') &&
            cause !== 'task.claimed'
          )
            void playSound('next_due', { key: `task:${card.task.id}` });
        } else {
          const task = p as Task;
          const before = home();
          const card =
            before?.current_task?.task.id === task.id
              ? before.current_task
              : before?.next_task?.task.id === task.id
                ? before.next_task
                : null;
          updateHome(qc, (h) => applyTaskGone(h, task.id, task.version, homeRegistry, now).home);
          if (card && (task.status === 'canceled' || task.assignee?.id !== userId)) {
            // 14 §5.1: «سحب المشرف المهمة — تذكرة N. لا تُحضر السيارة.» with `reminder`
            toast(fmt(live.withdrawn, { n: card.ticket.display_number }), 'error');
            void playSound('reminder', { key: `task:${task.id}` });
          }
        }
        refreshHome();
        return;
      }
      case 'ticket.updated': {
        const { cause: _c, ...summary } = event.payload;
        updateHome(qc, (h) => applyTicketSummary(h, summary as TicketSummary, homeRegistry, now));
        const detail = qc.getQueryData<TicketDetail>(queryKeys.ticket(summary.id));
        if (detail && detail.version < summary.version)
          void qc.invalidateQueries({ queryKey: queryKeys.ticket(summary.id) });
        qc.setQueriesData<VehiclePages>({ queryKey: queryKeys.vehicles }, (data) =>
          patchVehicles(data, summary as TicketSummary),
        );
        return;
      }
      case 'driver.state_changed': {
        if (event.payload.driver.id !== userId) return;
        updateHome(qc, (h) => applyDriverState(h, event.payload.driver_state, homeRegistry, now));
        // the duty ended elsewhere (supervisor, shift closed): `me` decides between D-03 and D-04
        if (event.payload.driver_state === 'off_duty')
          void qc.invalidateQueries({ queryKey: queryKeys.me, exact: true });
        return;
      }
      case 'channel.status':
        setChannelHealth(event.payload.whatsapp, event.payload.changed_at);
        return;
      case 'sync.required':
        // the engine runs the full resync; settings or session details changed: `me` too
        if (event.payload.scope === 'me') void qc.invalidateQueries({ queryKey: queryKeys.me, exact: true });
        return;
      case 'session.revoked':
        // never trusted alone: `GET /v1/me` answers AUTH_SESSION_REVOKED with the reason (RootLayout → D-15 ج)
        void qc.invalidateQueries({ queryKey: queryKeys.me, exact: true });
        return;
      default:
        return;
    }
  };
}

/** D-12 cache shape: React Query infinite pages of `GET /v1/tickets`. */
interface VehiclePages {
  pages: Array<{ items: TicketSummary[]; nextCursor: string | null }>;
  pageParams: unknown[];
}

/** `ticket.updated` refreshes a row of the D-12 list in place (newer versions only). */
export function patchVehicles(
  data: VehiclePages | undefined,
  summary: TicketSummary,
): VehiclePages | undefined {
  if (!data) return data;
  let changed = false;
  const pages = data.pages.map((page) => ({
    ...page,
    items: page.items.map((item) => {
      if (item.id !== summary.id || item.version >= summary.version) return item;
      changed = true;
      return { ...item, ...summary };
    }),
  }));
  return changed ? { ...data, pages } : data;
}

export function startRealtime(options: AcquireOptions): RealtimeHandle {
  const { qc } = options;
  const transport = createSocketTransport();
  const onEvent = driverEvents(options);
  const hooks: EngineHooks = {
    async resync() {
      try {
        const snapshot = await loadHomeSnapshot(qc);
        qc.setQueryData(queryKeys.home, snapshot);
        void qc.invalidateQueries({ queryKey: queryKeys.me, exact: true });
        void qc.invalidateQueries({ queryKey: ['tickets'] });
        void qc.invalidateQueries({ queryKey: queryKeys.vehicles }); // D-12 lists (no event for others' tickets)
        return { ok: true, serverTime: snapshot.server_time };
      } catch (error) {
        // a definitive answer (no assignment, no session…) is the server's state: nothing to wait for
        return { ok: error instanceof ApiError };
      }
    },
    onEvent,
    heartbeatBody: () => ({ visible: visible(), audio_unlocked: audioRunning(), app_version: APP_VERSION }),
    httpHeartbeat: async (body) => {
      if (!options.hasDuty()) return null;
      return (await api.post<HeartbeatAck>('/v1/me/heartbeat', { body })).data;
    },
    // the handshake was refused: `GET /v1/me` tells whether the session ended (RootLayout → D-15 ج); if it did
    // not, the socket tries again later (Socket.IO does not retry a refused handshake by itself)
    onAuthError: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.me, exact: true });
      setTimeout(() => {
        if (!engine.isStopped) transport.connect();
      }, AUTH_RETRY_MS);
    },
  };
  const engine = new RealtimeEngine(transport, hooks);
  engine.start();
  return { engine, stop: () => engine.stop() };
}
