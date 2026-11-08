import { api } from '@/api/client';
import { isDefinitiveError } from '@/api/errors';
import { getTicket } from '@/api/field';
import { queryKeys } from '@/api/queryClient';
import type {
  DriverHome,
  OfferCard,
  Task,
  TaskCard,
  TicketDetail,
  TicketSummary,
  WaLinkPending,
} from '@/api/types';
import { useLinkStore } from '@/features/driver/linkStore';
import { announcePromotion } from '@/features/driver/promotion';
import { homeRegistry, loadHomeSnapshot, updateHome } from '@/features/driver/useDriverHome';
import { d09 } from '@/i18n/ar';
import { audioRunning, playSound, stopSound } from '@/lib/audio';
import { recordServerTime } from '@/lib/serverClock';
import { APP_VERSION, track } from '@/lib/telemetry';
import { useFieldStore, type NoticeKind } from '@/stores/field';
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
import { RealtimeEngine, type EngineEnv, type EngineHooks, type Transport } from './engine';
import type { AcquireOptions, RealtimeHandle } from './manager';
import { useOfferLive } from './offerStore';
import type { HeartbeatAck, ServerEvent } from './protocol';
import { setChannelHealth } from './syncStore';
import { createSocketTransport } from './transport';

/**
 * The driver's realtime client (07 §4.3 «سلوك العميل», 02 D-04/D-09; PNT-065/066/067): events are applied to
 * the `GET /v1/me/home` cache entry with the version rules of ./driverHome.ts; the resync reads the snapshot
 * again (and `me`, and the open ticket screens). Sounds: the arrival of the head card is announced by the
 * frame that shows it (OfferAlerts); here `task.claimed` / `offer.closed` stop the card's sound at once, and
 * the task changes of 14 §3.1–§3.2 / §5.1 raise their notice over every driver screen: a promotion of the
 * reserved next task (`next_due` + the dialog), a direct assignment or a repark (`next_due`), a withdrawal
 * (`reminder`), a cancel (no sound), an early request during parking (`reminder`).
 */
export { APP_VERSION };

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

const MOVING = new Set(['accepted', 'in_progress']);

/** `ticket.updated` causes that change the handover code's state, not the ticket's version (14 §3.4). */
const CODE_CAUSES: ReadonlySet<string> = new Set([
  'handover.code_issued',
  'handover.code_attempt_failed',
  'handover.code_locked',
]);

function stopOfferSounds(offerIds: readonly string[], head: OfferCard | null | undefined, taskId: string) {
  for (const id of offerIds) stopSound(`offer:${id}`);
  if (head && (head.task_id === taskId || offerIds.includes(head.offer_id)))
    stopSound(`offer:${head.offer_id}`);
}

function notice(kind: NoticeKind, card: Pick<TaskCard, 'task' | 'ticket'>): void {
  useFieldStore.getState().addNotice({
    kind,
    taskId: card.task.id,
    ticketId: card.ticket.id,
    ticketNumber: card.ticket.display_number,
  });
}

/** The delivery state a `ticket.updated` may carry (drivers see W-01 and W-05 only, 09 §5.1). */
interface MessageState {
  purpose: string | null;
  status: string;
}

/**
 * The WhatsApp notices of a ticket this driver created or holds (the API sends `ticket.updated` to the creator
 * and the assignee): W-01 failed (02 D-07 «بعد المغادرة»; D-07 itself clears it while open) — gone once the link
 * is no longer `failed` —, and the customer who stopped the messages (14 §5.1). A W-01 failure counts only
 * while the link itself is `failed`: the failure of an older W-01, superseded by a resend (link_version + 1),
 * leaves the link as it is (ticket-link applyW01Outcome) and is no notice.
 */
export function waNotices(summary: TicketSummary, cause: string | undefined, message?: MessageState): void {
  const store = useFieldStore.getState();
  const base = { taskId: summary.id, ticketId: summary.id, ticketNumber: summary.display_number };
  const w01Failed =
    summary.wa_link_status === 'failed' &&
    (cause === 'ticket.wa_link_changed' || (message?.purpose === 'W-01' && message.status === 'failed'));
  if (w01Failed) store.addNotice({ kind: 'waFailed', ...base });
  else if (summary.wa_link_status !== 'failed') store.dismissNotice(`waFailed:${summary.id}`);
  if (cause === 'ticket.wa_link_changed' && summary.wa_link_status === 'opted_out')
    store.addNotice({ kind: 'optedOut', ...base });
}

export function driverEvents(options: AcquireOptions) {
  const { qc, userId } = options;
  const home = () => qc.getQueryData<DriverHome>(queryKeys.home);
  const refreshHome = () => void qc.invalidateQueries({ queryKey: queryKeys.home, exact: true });
  const toast = (message: string, tone: 'info' | 'error' = 'info') =>
    useUiStore.getState().pushToast({ message, tone });
  /** The newest ticket version seen per ticket: an older `ticket.updated` arriving late raises no notice. */
  const ticketVersions = new Map<string, number>();

  /** Parking tasks whose early-request notice was raised (once per task, whichever path saw it first). */
  const earlyNoticed = new Set<string>();
  const earlyNotice = (parking: TaskCard) => {
    if (earlyNoticed.has(parking.task.id)) return;
    earlyNoticed.add(parking.task.id);
    notice('early', parking);
    void playSound('reminder', { key: `task:${parking.task.id}` });
  };
  /** Reads the parking ticket (joining a refetch in flight) and raises the notice if a request waits. */
  const checkEarly = async (parking: TaskCard, version: number) => {
    const before = qc.getQueryData<TicketDetail>(queryKeys.ticket(parking.ticket.id));
    if (before && before.version >= version) {
      if (before.pending_retrieval_at) earlyNotice(parking);
      return;
    }
    try {
      const detail = await qc.fetchQuery({
        queryKey: queryKeys.ticket(parking.ticket.id),
        queryFn: ({ signal }) => getTicket(parking.ticket.id, signal),
        staleTime: 0,
      });
      const still = home()?.current_task?.task.id === parking.task.id;
      if (still && detail.pending_retrieval_at) earlyNotice(parking);
    } catch {
      // the ticket screen and the next snapshot still show it (02 D-08 banner)
    }
  };

  /** `task.updated` with this driver's TaskCard (07 §4.3): its slot, then what 14 §3.1–§3.2 announce. */
  const onTaskCard = (payload: TaskCard & { cause?: string }, now: number) => {
    const { cause, ...card } = payload;
    const before = home();
    const wasCurrent = before?.current_task?.task.id === card.task.id;
    const wasNext = before?.next_task?.task.id === card.task.id;
    // this driver's live task even when a newer card took its slot meanwhile (events of one commit can arrive
    // in any order: a repark card before the cancel of the retrieval it replaces)
    const seen = homeRegistry.tasks.get(card.task.id);
    const wasLive = wasCurrent || wasNext || (!!seen && !seen.gone);
    const result = { applied: false };
    updateHome(qc, (h) => {
      const r = applyTaskCard(h, card, homeRegistry, now);
      result.applied = r.applied;
      return r.home;
    });
    if (!result.applied) return;
    const status = card.task.status;
    if (status === 'canceled' && wasLive) {
      // 14 §3.1 ticket.retrieval_canceled / §3.2 task.canceled: «أُلغي طلب الإحضار — تذكرة n», no sound
      notice('canceled', card);
      return;
    }
    if (!MOVING.has(status)) return;
    if (wasNext || cause === 'task.promoted') {
      // 02 D-04: the reserved next task is the current one now → next_due + «بدأت مهمتك التالية» (the dialog
      // plays it), on whatever screen is open (10 §6.3: cancel / reassignment / transfer / reconcile of the
      // current task, or its completion)
      announcePromotion(card);
      return;
    }
    if (wasCurrent || cause === 'task.claimed') return; // a step of the current task / this driver's accept
    // a direct assignment to this driver (14 §3.2 task.reassigned) or the repark after a supervisor's cancel
    // (DEC-30, 14 §3.1 ticket.reparking): next_due, and the repark line that leads to D-08
    if (card.task.type === 'repark') notice('repark', card);
    void playSound('next_due', { key: `task:${card.task.id}` });
  };

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
        const head = !!before && (before.task_id === p.task_id || p.offer_ids.includes(before.offer_id));
        // 02 D-09 «فقط إذا كانت البطاقة ظاهرة للسائق»: the card rendered (D-04 or the open Sheet), page visible
        const shown = head && useOfferLive.getState().onScreen === before.offer_id && visible();
        stopOfferSounds(p.offer_ids, before, p.task_id); // 02 §1.7: the card's sound stops at once
        updateHome(qc, (h) => applyOfferClosed(h, p.offer_ids, p.task_id, homeRegistry));
        if (shown) toast(d09.claimedByOther);
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
        if (isTaskCard(p)) onTaskCard(p as TaskCard & { cause?: string }, now);
        else {
          const task = p as Task;
          const gone: { card: TaskCard | null } = { card: null };
          updateHome(qc, (h) => {
            const r = applyTaskGone(h, task.id, task.version, homeRegistry, now);
            gone.card = r.removed;
            return r.home;
          });
          const card = gone.card; // the task was on screen and this view is newer
          if (card) {
            if (task.status === 'canceled')
              notice('canceled', card); // 14 §3.2 task.canceled: no sound
            else if (task.assignee?.id !== userId) {
              // 14 §3.2 task.withdrawn / task.reassigned (away): the red banner and `reminder`
              notice('withdrawn', card);
              void playSound('reminder', { key: `task:${task.id}` });
            }
          }
        }
        refreshHome();
        return;
      }
      case 'ticket.updated': {
        const { cause, wa_link_pending, message, ...summary } = event.payload as typeof event.payload & {
          wa_link_pending?: WaLinkPending | null;
          message?: MessageState;
        };
        // 14 §3.1 ticket.retrieval_requested_early: the parking driver's banner and `reminder`. DEC-265 merges a
        // transaction's updates under its first ticket.* cause, so an early request after a resumed link comes
        // as `ticket.wa_link_changed`: a newer version of the parking ticket is checked on the ticket itself
        // (`pending_retrieval_at`), once per parking task (decisions:F6)
        const current = home()?.current_task;
        const parking =
          current &&
          current.ticket.id === summary.id &&
          (current.task.type === 'park' || current.task.type === 'repark')
            ? current
            : null;
        if (parking && cause === 'ticket.retrieval_requested_early') earlyNotice(parking);
        else if (parking && !earlyNoticed.has(parking.task.id)) {
          const known = Math.max(ticketVersions.get(summary.id) ?? 0, parking.ticket.version);
          if (summary.version > known) void checkEarly(parking, summary.version);
        }
        updateHome(qc, (h) => applyTicketSummary(h, summary as TicketSummary, homeRegistry, now));
        const fresh = summary.version >= (ticketVersions.get(summary.id) ?? 0);
        if (fresh) {
          ticketVersions.set(summary.id, summary.version);
          // 09 §5.1: the pending QR confirmation reaches the privileged viewer only; D-07's dialog keeps it. The
          // API leaves the field out when nothing waits, so any other link state clears the one kept
          const links = useLinkStore.getState();
          if (summary.wa_link_status !== 'pending_confirmation') {
            if (links.pending[summary.id]) links.notePending(summary.id, null);
          } else if (wa_link_pending !== undefined) links.notePending(summary.id, wa_link_pending);
          waNotices(summary as TicketSummary, cause, message);
        }
        const detail = qc.getQueryData<TicketDetail>(queryKeys.ticket(summary.id));
        // a message state (W-05 failed on D-10 / D-11) and the handover code's changes (a code issued — also
        // the supervisor's reissue, DEC-207 —, locked) do not move the ticket's version: read it again, and the
        // task card's code state with it (D-11 follows the live code, 14 §3.4)
        const codeChanged = !!cause && CODE_CAUSES.has(cause);
        if (detail && (detail.version < summary.version || message || codeChanged))
          void qc.invalidateQueries({ queryKey: queryKeys.ticket(summary.id) });
        if (codeChanged) refreshHome();
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

/** The driver's engine hooks (exported for the runtime unit tests). */
export function driverHooks(options: AcquireOptions): EngineHooks {
  const { qc } = options;
  return {
    async resync(_reason, signal) {
      try {
        const snapshot = await loadHomeSnapshot(qc, signal);
        if (signal.aborted) return { ok: false }; // signed out meanwhile: the cache stays cleared
        qc.setQueryData(queryKeys.home, snapshot);
        void qc.invalidateQueries({ queryKey: queryKeys.me, exact: true });
        void qc.invalidateQueries({ queryKey: ['tickets'] });
        void qc.invalidateQueries({ queryKey: queryKeys.vehicles }); // D-12 lists (no event for others' tickets)
        return { ok: true, serverTime: snapshot.server_time };
      } catch (error) {
        // the server's definitive answer (no assignment, no session…) is its state: nothing to wait for; a
        // failure to read it (5xx, 429, no reply) keeps the data stale and is tried again (PNT-065 AC2)
        return { ok: isDefinitiveError(error) };
      }
    },
    onEvent: driverEvents(options),
    heartbeatBody: () => ({ visible: visible(), audio_unlocked: audioRunning(), app_version: APP_VERSION }),
    httpHeartbeat: async (body) => {
      if (!options.hasDuty()) return null;
      return (await api.post<HeartbeatAck>('/v1/me/heartbeat', { body })).data;
    },
    // the server closed the socket or refused it: `GET /v1/me` tells whether the session ended (RootLayout →
    // D-15 ج, which stops the engine); if it did not, the engine connects again after its backoff
    checkSession: () => void qc.invalidateQueries({ queryKey: queryKeys.me, exact: true }),
    // 15 §9.4: the socket is down — the round on screen goes in a telemetry batch, sent at once (the reminder
    // push targets recipients whose `seen_at` is still empty)
    httpOfferSeen: (offerId, receiveLatencyMs) => {
      const offer = qc.getQueryData<DriverHome>(queryKeys.home)?.offer;
      const same = offer?.offer_id === offerId ? offer : null;
      track(
        'offer_card_seen',
        {
          offer_id: offerId,
          via: 'sync',
          mode: same?.mode,
          eligible_as: same?.eligible_as,
          receive_latency_ms: receiveLatencyMs,
        },
        { task_id: same?.task_id ?? null },
        { flush: true },
      );
    },
  };
}

export function startRealtime(
  options: AcquireOptions,
  deps: { transport?: Transport; env?: EngineEnv } = {},
): RealtimeHandle {
  const engine = new RealtimeEngine(
    deps.transport ?? createSocketTransport(),
    driverHooks(options),
    deps.env,
  );
  engine.start();
  return { engine, stop: () => engine.stop() };
}
