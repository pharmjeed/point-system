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
import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { ApiError, displayMessage, isApiError } from '@/api/errors';
import { createTicket, setBreak } from '@/api/field';
import { queryKeys } from '@/api/queryClient';
import type { DriverHome, TaskCard as TaskCardData } from '@/api/types';
import { hasOpenDuty, paths } from '@/app/paths';
import { Banner, Button, EmptyState, Icon, ListItem, Sheet, Skeleton, TaskCard } from '@/components';
import { LoadError } from '@/features/common/QueryView';
import { useCommand } from '@/hooks/useCommand';
import { d03, d04, nav, ui } from '@/i18n/ar';
import { formatSinceMinutes } from '@/lib/format';
import { useCommandGate } from '@/realtime/hooks';
import { useSyncStore } from '@/realtime/syncStore';
import { useAudioStore } from '@/stores/audio';
import { useFieldStore } from '@/stores/field';
import { useUiStore } from '@/stores/ui';
import {
  driverPaths,
  intakeBlockedReason,
  intakeEvents,
  plateValue,
  taskCardView,
  vehicleSummary,
  type TaskStage,
} from './fieldModel';
import { useAudioCheck } from './deviceSetup';
import { useDriverMe } from './DriverLayout';
import { LiveOfferCard } from './LiveOffer';
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

/** The task screens are one separate chunk; fetch it while the driver looks at D-04 (weak networks). */
const preloadTaskScreens = () => import('./tasks');

/**
 * D-04 — الرئيسية (PNT-035, PNT-067, PNT-068): the live snapshot of the driver frame (`GET /v1/me/home` kept
 * current by the realtime events), «استلام مركبة» (event chooser when several events are open, DEC-37), the
 * current and the reserved next task, and the single oldest actionable request as the live D-09 card. While
 * the data is stale or offline the cards stay on screen dimmed and every command waits (02 §1.6, D-15 أ);
 * the D-15 banners are the frame's.
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

/**
 * 01 FR-DUTY-02: a duty started without a heard sound test keeps a warning on D-04 — the device's result is
 * not `heard` (`checks.audio_tested`) and this page's test did not say «نعم، سمعتها» — while the sound runs (a
 * stopped AudioContext is D-15 د's banner, on every screen). «تفعيل واختبار الصوت» is D-03's test.
 */
function AudioWarning({ home }: { home: DriverHome }) {
  const me = useDriverMe();
  const status = useAudioStore((s) => s.status);
  const { audio, test, dialog } = useAudioCheck(me);
  const show = status === 'running' && audio !== 'ok' && home.checks.audio_tested !== true;
  return (
    <>
      {show ? (
        <Banner
          kind="audio"
          rounded
          message={audio === 'notHeard' ? d03.notHeardHint : d04.audioUntested}
          actionLabel={d03.testAudio}
          onAction={test}
        />
      ) : null}
      {dialog}
    </>
  );
}

function Home({ home, refetch }: { home: DriverHome; refetch: () => Promise<unknown> }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pushToast = useUiStore((s) => s.pushToast);
  const lastEventId = useFieldStore((s) => s.lastEventId);
  const setLastEventId = useFieldStore((s) => s.setLastEventId);
  const [eventsOpen, setEventsOpen] = useState(false);
  // the promotion of the reserved next task («بدأت مهمتك التالية») is the frame's dialog: it is announced on
  // whatever driver screen is open (./promotion.ts)

  const create = useCommand((body: { event_id: string }, key: string) => createTicket(body, key));
  const endBreak = useCommand((_: { active: false }, key: string) => setBreak(false, key));
  const gate = useCommandGate();
  const stale = useSyncStore((st) => st.stale);

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
    const events = intakeEvents(home);
    if (events.length > 1) {
      create.reset();
      setEventsOpen(true);
      return;
    }
    const only = events[0];
    if (only) return startIntake(only.id);
  };

  const state = home.driver_state;
  const blocked = intakeBlockedReason(state);
  const noEvent = state === 'available' && intakeEvents(home).length === 0;
  const offer = home.offer ?? null;
  const events = [...intakeEvents(home)].sort(
    (a, b) => Number(b.id === lastEventId) - Number(a.id === lastEventId),
  );

  return (
    <>
      <AudioWarning home={home} />
      {state === 'on_break' ? (
        <Banner
          kind="break"
          rounded
          message={d04.onBreak}
          actionLabel={d04.endBreak}
          loading={endBreak.pending}
          onAction={
            gate.ready
              ? () => {
                  endBreak.run({ active: false }).then(
                    () => sync(),
                    (error: unknown) => pushToast({ message: displayMessage(error), tone: 'error' }),
                  );
                }
              : undefined
          }
        />
      ) : null}

      <div className="pt-live" data-stale={stale || gate.unconfirmed}>
        <div className="flex flex-col gap-2">
          <Button
            size="lg"
            id="intake-start"
            iconStart={Plus}
            disabled={!gate.ready || state !== 'available' || noEvent}
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

        <div className="pt-live__cards">
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
                car={home.next_task.ticket.vehicle}
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
              <LiveOfferCard key={offer.offer_id} offer={offer} />
            ) : (
              <EmptyState icon={BellRing} title={d04.emptyTitle} body={d04.emptyBody} />
            )}
          </section>
        </div>
      </div>

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
      car={card.ticket.vehicle}
      stage={view.line}
      stageIcon={STAGE_ICON[view.stage]}
      actionLabel={view.action}
      onAction={() => onOpen(view.to)}
    />
  );
}
