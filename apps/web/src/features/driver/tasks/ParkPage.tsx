import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ApiError, displayMessage } from '@/api/errors';
import { completeParking, type ParkingInput } from '@/api/field';
import { queryKeys } from '@/api/queryClient';
import { listKeyBoards, listSpots, listZones } from '@/api/setup';
import type { DriverHome, TaskCard as TaskCardData } from '@/api/types';
import { paths } from '@/app/paths';
import {
  Banner,
  Button,
  Checkbox,
  FilterChips,
  PlateBadge,
  Select,
  Skeleton,
  SpotGrid,
  TextField,
  Toggle,
} from '@/components';
import { LoadError } from '@/features/common/QueryView';
import { useCommand } from '@/hooks/useCommand';
import { useDriverMe } from '@/features/driver/DriverLayout';
import { useOnline } from '@/hooks/useOnline';
import { d04, d08 } from '@/i18n/ar';
import { withTicket } from '@/i18n/fmtNode';
import { useFieldStore } from '@/stores/field';
import { useUiStore } from '@/stores/ui';
import { fieldSettings, findTask, plateValue, vehicleSummary } from '../fieldModel';
import { useDriverHome, useRefreshHome } from '../useDriverHome';
import { TaskGone, TaskScreen, TaskSkeleton, useTicket } from './common';

/**
 * D-08 — إتمام الصف (وإعادة الصف): zone chips and the spot grid (or «بدون موقف محدد» + a description, by
 * `parking.mode`), the key board and slot grid (`keys.require_slot`), «أودعت المفتاح» as a local check,
 * then `POST /v1/tasks/{taskId}/complete-parking`. Occupied items are disabled and labelled, and the grids
 * re-read after an occupancy error (02 D-08). Layout reads use `venue.layout_read` (DEC-33).
 */
export function ParkPage() {
  const { taskId = '' } = useParams();
  const home = useDriverHome();
  if (home.data) {
    const card = findTask(home.data, taskId);
    const isPark = card && (card.task.type === 'park' || card.task.type === 'repark');
    if (!card || !isPark || card.task.status !== 'in_progress') return <TaskGone />;
    return <ParkForm home={home.data} card={card} />;
  }
  if (home.error)
    return <LoadError error={home.error} onRetry={() => void home.refetch()} backTo={paths.driverHome} />;
  return <TaskSkeleton />;
}

function ParkForm({ home, card }: { home: DriverHome; card: TaskCardData }) {
  const me = useDriverMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const online = useOnline();
  const refresh = useRefreshHome();
  const pushToast = useUiStore((s) => s.pushToast);
  const setPromotion = useFieldStore((s) => s.setPromotion);
  const settings = fieldSettings(home);
  const venueId = home.venue?.id ?? me.active_assignment?.venue_id ?? '';
  const ticket = useTicket(card.ticket.id);
  const zones = useQuery({
    queryKey: queryKeys.zones(venueId),
    queryFn: ({ signal }) => listZones(venueId, signal),
    enabled: !!venueId,
  });
  const spots = useQuery({
    queryKey: queryKeys.spots(venueId),
    queryFn: ({ signal }) => listSpots(venueId, signal),
    enabled: !!venueId && settings.parkingMode !== 'free_text',
  });
  const boards = useQuery({
    queryKey: queryKeys.keyBoards(venueId),
    queryFn: ({ signal }) => listKeyBoards(venueId, signal),
    enabled: !!venueId,
  });

  const activeZones = (zones.data ?? [])
    .filter((z) => z.status === 'active')
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const activeSpots = (spots.data ?? []).filter((s) => s.status === 'active');
  const activeBoards = (boards.data ?? []).filter((b) => b.board.status === 'active');

  const [zonePick, setZonePick] = useState<string | null>(null);
  const zoneId = zonePick ?? activeZones[0]?.id ?? null;
  const [spotId, setSpotId] = useState<string | null>(null);
  const [noSpot, setNoSpot] = useState(settings.parkingMode === 'free_text');
  const [note, setNote] = useState('');
  const [boardPick, setBoardPick] = useState<string | null>(null);
  const boardId = boardPick ?? activeBoards[0]?.board.id ?? null;
  const [slotId, setSlotId] = useState<string | null>(null);
  const [deposited, setDeposited] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [spotError, setSpotError] = useState<string | null>(null);
  const [slotError, setSlotError] = useState<string | null>(null);

  const park = useCommand((body: ParkingInput, key: string) => completeParking(card.task.id, body, key));

  const zoneSpots = activeSpots.filter((s) => s.zone_id === zoneId);
  const board = activeBoards.find((b) => b.board.id === boardId);
  const boardSlots = (board?.slots ?? []).filter((s) => s.status === 'active');
  const spot = activeSpots.find((s) => s.id === spotId);
  const slot = boardSlots.find((s) => s.id === slotId);
  const usesGrid = settings.parkingMode !== 'free_text' && !noSpot;

  const onSubmit = async () => {
    setLocalError(null);
    const hasSpot = usesGrid ? !!spot : note.trim().length > 0;
    const hasSlot = !settings.requireSlot || !!slot;
    if (!hasSpot || !hasSlot) {
      setLocalError(d08.chooseBoth);
      return;
    }
    const body: ParkingInput = {
      parking_spot_id: usesGrid ? (spot?.id ?? null) : null,
      spot_note: usesGrid ? null : note.trim(),
      key_slot_id: slot?.id ?? null,
      expected_version: card.task.version,
    };
    try {
      const result = await park.run(body);
      pushToast({ message: withTicket(d08.parked, card.ticket.display_number), tone: 'success' });
      const promoted = result.driver.promoted_next_task;
      if (promoted) setPromotion({ card: promoted, title: d04.promoted });
      void refresh();
      navigate(paths.driverHome, { replace: true });
    } catch (error) {
      if (!(error instanceof ApiError)) return;
      if (error.is('PARKING_SPOT_OCCUPIED')) {
        setSpotId(null);
        setSpotError(error.message_ar);
        void qc.invalidateQueries({ queryKey: queryKeys.spots(venueId) });
      } else if (error.is('KEY_SLOT_OCCUPIED')) {
        setSlotId(null);
        setDeposited(false);
        setSlotError(error.message_ar);
        void qc.invalidateQueries({ queryKey: queryKeys.keyBoards(venueId) });
      } else if (error.is('NOT_TASK_ASSIGNEE')) {
        pushToast({ message: error.message_ar, tone: 'error' });
        void refresh();
        navigate(paths.driverHome, { replace: true });
      } else if (error.is('VERSION_CONFLICT', 'INVALID_STATE_TRANSITION')) void refresh();
    }
  };

  const formError =
    localError ??
    (park.error &&
    !(park.error instanceof ApiError && park.error.is('PARKING_SPOT_OCCUPIED', 'KEY_SLOT_OCCUPIED'))
      ? displayMessage(park.error)
      : null);
  const title = card.task.type === 'repark' ? d08.reparkTitle : d08.title;
  const plate = plateValue(card.ticket.plate);
  const needsDeposit = !!slot;
  const layoutError = zones.error ?? spots.error ?? boards.error;

  return (
    <TaskScreen title={withTicket(`${title} · #{n}`, card.ticket.display_number)} backTo={paths.driverHome}>
      <div className="flex flex-wrap items-center gap-3">
        {plate ? <PlateBadge {...plate} /> : null}
        <span>{vehicleSummary(card.ticket.vehicle)}</span>
      </div>
      {ticket.data?.pending_retrieval_at ? <Banner kind="warning" rounded message={d08.early} /> : null}
      {layoutError ? (
        <LoadError
          error={layoutError}
          onRetry={() => {
            void zones.refetch();
            void spots.refetch();
            void boards.refetch();
          }}
        />
      ) : null}

      {settings.parkingMode !== 'free_text' ? (
        <section className="flex flex-col gap-2" aria-labelledby="spot-title">
          <h2 className="pt-section-title" id="spot-title">
            {d08.spot}
          </h2>
          {zones.isPending || spots.isPending ? (
            <Skeleton />
          ) : (
            <>
              <FilterChips
                label={d08.zone}
                value={zoneId ? [zoneId] : []}
                options={activeZones.map((z) => ({
                  value: z.id,
                  label: z.name,
                  count: activeSpots.filter((s) => s.zone_id === z.id && !s.occupied).length,
                }))}
                onChange={(values) => {
                  const next = values.find((v) => v !== zoneId) ?? zoneId;
                  setZonePick(next);
                  setSpotId(null);
                }}
                disabled={noSpot}
              />
              {usesGrid ? (
                <SpotGrid
                  label={d08.spot}
                  spots={zoneSpots.map((s) => ({ code: s.label, occupied: !!s.occupied }))}
                  selected={spot?.label}
                  error={spotError ?? undefined}
                  onSelect={(label) => {
                    setSpotError(null);
                    setSpotId(zoneSpots.find((s) => s.label === label)?.id ?? null);
                  }}
                />
              ) : null}
            </>
          )}
          {settings.parkingMode === 'mixed' ? (
            <Toggle
              id="no-spot"
              label={d08.noSpot}
              checked={noSpot}
              onChange={(on) => {
                setNoSpot(on);
                setSpotId(null);
              }}
            />
          ) : null}
        </section>
      ) : null}
      {!usesGrid ? (
        <TextField
          id="spot-note"
          label={d08.spotNote}
          placeholder={d08.spotNotePlaceholder}
          value={note}
          maxLength={120}
          onChange={(e) => setNote(e.target.value)}
        />
      ) : null}

      <section className="flex flex-col gap-2">
        {boards.isPending ? (
          <Skeleton />
        ) : (
          <>
            <Select
              id="key-board"
              label={d08.board}
              value={boardId ?? ''}
              options={activeBoards.map((b) => [b.board.id, b.board.name] as const)}
              onChange={(e) => {
                setBoardPick(e.target.value);
                setSlotId(null);
                setDeposited(false);
              }}
            />
            <h2 className="pt-section-title" id="slot-title">
              {d08.slot}
            </h2>
            <SpotGrid
              label={d08.slot}
              spots={boardSlots.map((s) => ({ code: s.label, occupied: !!s.occupied }))}
              selected={slot?.label}
              error={slotError ?? undefined}
              onSelect={(label) => {
                setSlotError(null);
                setSlotId(boardSlots.find((s) => s.label === label)?.id ?? null);
                setDeposited(false);
              }}
            />
          </>
        )}
        {needsDeposit ? (
          <Checkbox
            id="key-deposited"
            label={d08.deposited}
            checked={deposited}
            onChange={(e) => setDeposited(e.target.checked)}
          />
        ) : null}
      </section>

      {formError ? <Banner kind="error" rounded message={formError} /> : null}
      {!online ? <Banner kind="offline" rounded message={d08.needsConnection} /> : null}
      <Button
        size="lg"
        id="park-submit"
        loading={park.pending}
        disabled={!online || (needsDeposit && !deposited)}
        onClick={onSubmit}
      >
        {d08.submit}
      </Button>
    </TaskScreen>
  );
}
