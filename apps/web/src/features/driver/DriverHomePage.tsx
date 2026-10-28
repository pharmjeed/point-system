import { useQueryClient } from '@tanstack/react-query';
import {
  BellRing,
  CalendarDays,
  CircleCheck,
  ClipboardList,
  Clock,
  Hand,
  KeyRound,
  MapPin,
  Navigation,
  Plus,
  RotateCcw,
  SquareParking,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { ApiError, displayMessage, isApiError } from '@/api/errors';
import { acceptOffer, createTicket, setBreak } from '@/api/field';
import { queryKeys } from '@/api/queryClient';
import type { DriverHome, OfferCard as OfferCardData, TaskCard as TaskCardData } from '@/api/types';
import { hasOpenDuty, paths } from '@/app/paths';
import {
  Banner,
  Button,
  EmptyState,
  Icon,
  ListItem,
  OfferCard,
  Sheet,
  Skeleton,
  TaskCard,
} from '@/components';
import { LoadError } from '@/features/common/QueryView';
import { useCommand } from '@/hooks/useCommand';
import { useOnline } from '@/hooks/useOnline';
import { d04, d09, nav, ui } from '@/i18n/ar';
import { withTicket } from '@/i18n/fmtNode';
import { formatSinceMinutes } from '@/lib/format';
import { useFieldStore } from '@/stores/field';
import { useUiStore } from '@/stores/ui';
import {
  driverPaths,
  fieldSettings,
  intakeBlockedReason,
  offerAction,
  plateValue,
  promotedTask,
  taskCardView,
  vehicleSummary,
  type TaskStage,
} from './fieldModel';
import { useDriverMe } from './DriverLayout';
import { PromotionDialog } from './PromotionDialog';
import { useDriverHome } from './useDriverHome';

const STAGE_ICON: Record<TaskStage, LucideIcon> = {
  intake: ClipboardList,
  park: SquareParking,
  repark: RotateCcw,
  key: KeyRound,
  start: MapPin,
  retrieving: Navigation,
  ready: Hand,
};

/** Offer errors after which the card is gone (02 D-09): a toast with the server text, then a sync. */
const OFFER_GONE = [
  'TASK_ALREADY_CLAIMED',
  'OFFER_EXPIRED',
  'OFFER_REVOKED',
  'NOT_OFFER_RECIPIENT',
  'OFFER_NOT_FOUND',
];

/** The task screens are one separate chunk; fetch it while the driver looks at D-04 (weak networks). */
const preloadTaskScreens = () => import('./tasks');

/**
 * D-04 — الرئيسية (simplified for the first vertical path, PNT-035): `GET /v1/me/home` polled every 5 s,
 * «استلام مركبة» (event chooser when several events are open, DEC-37), the current and the reserved next
 * task, and the single oldest actionable offer. Live offers, sounds and the system banners are PNT-067/068.
 */
export function DriverHomePage() {
  const me = useDriverMe();
  const qc = useQueryClient();
  const home = useDriverHome();
  useEffect(() => {
    void preloadTaskScreens();
  }, []);
  // the duty ended elsewhere (shift closed, supervisor): re-read the session, whose duty drives the redirect
  const dutyGone = !!home.data && !home.data.duty_session && hasOpenDuty(me);
  useEffect(() => {
    if (dutyGone) void qc.invalidateQueries({ queryKey: queryKeys.me, exact: true });
  }, [dutyGone, qc]);

  // same source as D-03 (`GET /v1/me`), so the two screens never bounce on a stale snapshot
  if (!hasOpenDuty(me)) return <Navigate to={paths.driverStart} replace />;
  return (
    <section className="flex flex-col gap-4" aria-labelledby="page-title">
      <h1 className="pt-sr" id="page-title">
        {nav.home}
      </h1>
      {home.data ? (
        <Home home={home.data} refetch={() => home.refetch()} />
      ) : home.error ? (
        home.error instanceof ApiError && home.error.is('ASSIGNMENT_REQUIRED') ? (
          <EmptyState icon={MapPin} title={ui.assignmentRequired} />
        ) : (
          <LoadError error={home.error} onRetry={() => void home.refetch()} />
        )
      ) : (
        <>
          <Skeleton withAction />
          <Skeleton />
          <Skeleton />
        </>
      )}
    </section>
  );
}

function Home({ home, refetch }: { home: DriverHome; refetch: () => Promise<unknown> }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const online = useOnline();
  const pushToast = useUiStore((s) => s.pushToast);
  const lastEventId = useFieldStore((s) => s.lastEventId);
  const setLastEventId = useFieldStore((s) => s.setLastEventId);
  const announced = useFieldStore((s) => s.announced);
  const markAnnounced = useFieldStore((s) => s.markAnnounced);
  const promotion = useFieldStore((s) => s.promotion);
  const setPromotion = useFieldStore((s) => s.setPromotion);
  const [eventsOpen, setEventsOpen] = useState(false);
  const previous = useRef<DriverHome | undefined>(undefined);

  // 02 D-04: the reserved next task became the current one → «بدأت مهمتك التالية». D-08 and D-11 hand
  // over the promotion their command returned through the field store.
  useEffect(() => {
    const card = promotedTask(previous.current, home);
    previous.current = home;
    if (card && !announced.includes(card.task.id)) {
      markAnnounced(card.task.id);
      setPromotion({ card, title: d04.promoted });
    }
  }, [home, announced, markAnnounced, setPromotion]);

  const create = useCommand((body: { event_id: string }, key: string) => createTicket(body, key));
  const endBreak = useCommand((_: { active: false }, key: string) => setBreak(false, key));
  const accept = useCommand((offerId: string, key: string) => acceptOffer(offerId, key));
  const [acceptError, setAcceptError] = useState<{ offerId: string; message: string } | null>(null);

  const sync = () => qc.invalidateQueries({ queryKey: queryKeys.me });

  const startIntake = async (eventId: string) => {
    setLastEventId(eventId);
    setEventsOpen(false); // the pending state and any error show on «استلام مركبة» itself
    try {
      const result = await create.run({ event_id: eventId });
      qc.setQueryData(queryKeys.ticket(result.ticket.id), result.ticket);
      void sync();
      navigate(driverPaths.intakeVehicle(result.ticket.id));
    } catch (error) {
      if (isApiError(error, 'DUTY_REQUIRED', 'SHIFT_NOT_OPEN')) {
        void sync();
        navigate(paths.driverStart);
        return;
      }
      if (isApiError(error, 'DRIVER_NOT_AVAILABLE', 'MOVEMENT_IN_PROGRESS', 'VALIDATION_FAILED'))
        void refetch();
    }
  };

  const onIntake = () => {
    const events = home.open_events;
    if (events.length > 1) {
      create.reset();
      setEventsOpen(true);
      return;
    }
    const only = events[0];
    if (only) return startIntake(only.id);
  };

  const onAccept = async (offer: OfferCardData) => {
    setAcceptError(null);
    try {
      const result = await accept.run(offer.offer_id);
      const n = offer.ticket.display_number;
      if (result.result === 'accepted') {
        pushToast({ message: withTicket(d09.accepted, n), tone: 'success' });
        void sync();
        navigate(driverPaths.task(result.task.id));
      } else {
        pushToast({ message: withTicket(d09.reserved, n), tone: 'success' });
        void sync();
      }
    } catch (error) {
      const message = displayMessage(error);
      if (isApiError(error, ...OFFER_GONE)) pushToast({ message, tone: 'error' });
      else setAcceptError({ offerId: offer.offer_id, message });
      if (error instanceof ApiError) void refetch();
    }
  };

  const state = home.driver_state;
  const blocked = intakeBlockedReason(state);
  const noEvent = state === 'available' && home.open_events.length === 0;
  const settings = fieldSettings(home);
  const offer = home.offer ?? null;
  const events = [...home.open_events].sort(
    (a, b) => Number(b.id === lastEventId) - Number(a.id === lastEventId),
  );

  return (
    <>
      {state === 'on_break' ? (
        <Banner
          kind="break"
          rounded
          message={d04.onBreak}
          actionLabel={d04.endBreak}
          loading={endBreak.pending}
          onAction={() => {
            endBreak.run({ active: false }).then(
              () => sync(),
              (error: unknown) => pushToast({ message: displayMessage(error), tone: 'error' }),
            );
          }}
        />
      ) : null}

      <div className="flex flex-col gap-2">
        <Button
          size="lg"
          id="intake-start"
          iconStart={Plus}
          disabled={!online || state !== 'available' || noEvent}
          loading={create.pending}
          error={create.error ? displayMessage(create.error) : undefined}
          onClick={onIntake}
        >
          {d04.intake}
        </Button>
        {blocked || noEvent ? (
          <p className="m-0 text-sm text-text-muted" id="intake-hint">
            {blocked ?? d04.noOpenEvent}
          </p>
        ) : null}
      </div>

      {home.current_task ? (
        <section className="flex flex-col gap-2" aria-labelledby="current-task">
          <h2 className="pt-section-title" id="current-task">
            {d04.currentTask}
          </h2>
          <CurrentTask card={home.current_task} onOpen={(to) => navigate(to)} />
        </section>
      ) : null}

      {home.next_task ? (
        <section className="flex flex-col gap-2" aria-labelledby="next-task">
          <h2 className="pt-section-title" id="next-task">
            {d04.nextTask}
          </h2>
          <TaskCard
            next
            badge={d04.reserved}
            heading={`${d04.task.key.heading} ·`}
            ticketNumber={home.next_task.ticket.display_number}
            vehicle={vehicleSummary(home.next_task.ticket.vehicle)}
            plate={plateValue(home.next_task.ticket.plate)}
            stage={
              home.next_task.requested_at
                ? formatSinceMinutes(Date.now() - Date.parse(home.next_task.requested_at))
                : undefined
            }
            stageIcon={Clock}
          >
            <p className="m-0 text-sm">{d04.nextLine}</p>
          </TaskCard>
        </section>
      ) : null}

      <section className="flex flex-col gap-2" aria-labelledby="offer-section">
        <h2 className="pt-section-title" id="offer-section">
          {d04.offerSection}
        </h2>
        {offer ? (
          <OfferCard
            key={offer.offer_id}
            offerId={offer.offer_id}
            mode={offer.mode}
            ticketNumber={offer.ticket.display_number}
            vehicleSummary={vehicleSummary(offer.ticket.vehicle)}
            plate={plateValue(offer.ticket.plate)}
            venue={offer.ticket.event_name_ar}
            requestedAt={offer.requested_at}
            expiresAt={offer.mode === 'single' ? (offer.expires_at ?? undefined) : undefined}
            totalSeconds={settings.offerTtlS}
            canAcceptAs={offerAction(offer)}
            offline={!online}
            loading={accept.pending}
            error={acceptError?.offerId === offer.offer_id ? acceptError.message : undefined}
            onAccept={() => onAccept(offer)}
          />
        ) : (
          <EmptyState icon={BellRing} title={d04.emptyTitle} body={d04.emptyBody} />
        )}
      </section>

      <Sheet open={eventsOpen} onOpenChange={setEventsOpen} title={d04.chooseEvent}>
        <ul className="pt-list">
          {events.map((event) => (
            <li key={event.id}>
              <ListItem
                icon={CalendarDays}
                title={event.name_ar}
                trailing={event.id === lastEventId ? <Icon icon={CircleCheck} size={20} /> : undefined}
                onClick={() => void startIntake(event.id)}
              />
            </li>
          ))}
        </ul>
      </Sheet>

      <PromotionDialog
        task={promotion?.card ?? null}
        title={promotion?.title}
        onClose={() => setPromotion(null)}
      />
    </>
  );
}

function CurrentTask({ card, onOpen }: { card: TaskCardData; onOpen: (to: string) => void }) {
  const view = taskCardView(card);
  return (
    <TaskCard
      heading={`${view.heading} ·`}
      ticketNumber={card.ticket.display_number}
      status={card.ticket.status}
      vehicle={vehicleSummary(card.ticket.vehicle)}
      plate={plateValue(card.ticket.plate)}
      stage={view.line}
      stageIcon={STAGE_ICON[view.stage]}
      actionLabel={view.action}
      onAction={() => onOpen(view.to)}
    />
  );
}
