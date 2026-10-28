import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, SquareParking } from 'lucide-react';
import { useState } from 'react';
import { displayMessage, isApiError } from '@/api/errors';
import { queryKeys } from '@/api/queryClient';
import {
  createKeyBoard,
  createSlots,
  createSpots,
  createZone,
  listKeyBoards,
  listSpots,
  listZones,
  patchSlot,
  patchSpot,
  patchZone,
} from '@/api/setup';
import type { BulkLabels, KeyBoardWithSlots, ParkingSpot, ParkingZone, SetupStatus } from '@/api/types';
import { Button, Card, EmptyState, FieldError } from '@/components';
import { QueryView } from '@/features/common/QueryView';
import { SetupStatusChip } from '@/features/common/StateChip';
import { useCommand } from '@/hooks/useCommand';
import { s09, setupStatus, ui } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { cx } from '@/lib/cx';
import { useUiStore } from '@/stores/ui';
import { NameSheet, RangeSheet, ToggleItemDialog } from './SetupSheets';

interface GridItem {
  id: string;
  label: string;
  status: SetupStatus;
  occupied?: boolean;
}

/**
 * Spots or slots of one zone/board. With `venue.manage` each item is a button that disables/enables it;
 * otherwise a read-only grid (02 §2.2: S-09 view only for supervisors).
 */
function ItemGrid({
  items,
  manage,
  label,
  onToggle,
}: {
  items: GridItem[];
  manage: boolean;
  label: string;
  onToggle: (item: GridItem) => void;
}) {
  const sorted = [...items].sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }));
  return (
    <ul className="pt-spots__grid m-0 list-none p-0" aria-label={label}>
      {sorted.map((item) => {
        const inactive = item.status === 'inactive';
        const content = (
          <>
            <bdi dir="ltr">{item.label}</bdi>
            {inactive ? <span className="pt-sr"> {setupStatus.inactive}</span> : null}
          </>
        );
        return (
          <li key={item.id} className="flex">
            {manage ? (
              <button
                type="button"
                className={cx('pt-spot w-full', inactive && 'is-inactive')}
                onClick={() => onToggle(item)}
              >
                {content}
              </button>
            ) : (
              <div className={cx('pt-spot w-full', inactive && 'is-inactive')}>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Disable/enable flow shared by spots and slots; an occupied item stays active (02 S-09 text). */
function useToggle(
  patch: (id: string, body: { status: SetupStatus }, key: string) => Promise<unknown>,
  occupiedCode: 'PARKING_SPOT_OCCUPIED' | 'KEY_SLOT_OCCUPIED',
  refresh: () => Promise<unknown>,
) {
  const pushToast = useUiStore((s) => s.pushToast);
  const [target, setTarget] = useState<GridItem | null>(null);
  const [error, setError] = useState<string | undefined>();
  const cmd = useCommand((input: { id: string; status: SetupStatus }, key: string) =>
    patch(input.id, { status: input.status }, key),
  );
  const confirm = async () => {
    if (!target) return;
    setError(undefined);
    try {
      await cmd.run({ id: target.id, status: target.status === 'active' ? 'inactive' : 'active' });
      pushToast({ message: ui.saved, tone: 'success' });
      setTarget(null);
    } catch (e) {
      setError(isApiError(e, occupiedCode) ? s09.occupied : displayMessage(e));
    } finally {
      void refresh();
    }
  };
  const dialog = target ? (
    <ToggleItemDialog
      id="toggle-item"
      label={target.label}
      active={target.status === 'active'}
      open
      onOpenChange={(o) => {
        if (!o) {
          setTarget(null);
          setError(undefined);
        }
      }}
      pending={cmd.pending}
      error={error}
      onConfirm={confirm}
    />
  ) : null;
  return { open: (item: GridItem) => setTarget(item), dialog };
}

// ---------------------------------------------------------------- «المناطق والمواقف»

export function ParkingSection({ venueId, manage }: { venueId: string; manage: boolean }) {
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);
  const zones = useQuery({
    queryKey: queryKeys.zones(venueId),
    queryFn: ({ signal }) => listZones(venueId, signal),
  });
  const spots = useQuery({
    queryKey: queryKeys.spots(venueId),
    queryFn: ({ signal }) => listSpots(venueId, signal),
  });
  const [creating, setCreating] = useState(false);
  const addZone = useCommand((body: { name: string; sort_order: number }, key: string) =>
    createZone(venueId, body, key),
  );
  const refreshSpots = () => qc.invalidateQueries({ queryKey: queryKeys.spots(venueId) });
  const toggle = useToggle(patchSpot, 'PARKING_SPOT_OCCUPIED', refreshSpots);

  return (
    <div className="flex flex-col gap-3">
      {manage ? (
        <Button compact variant="secondary" iconStart={Plus} onClick={() => setCreating(true)}>
          {s09.newZone}
        </Button>
      ) : null}
      <QueryView query={zones}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState icon={SquareParking} title={s09.emptyZones} />
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label={s09.sections.parking}>
              {[...list]
                .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name))
                .map((zone) => (
                  <li key={zone.id}>
                    <ZoneCard
                      venueId={venueId}
                      zone={zone}
                      spots={(spots.data ?? []).filter((s) => s.zone_id === zone.id)}
                      manage={manage}
                      onToggle={toggle.open}
                    />
                  </li>
                ))}
            </ul>
          )
        }
      </QueryView>
      {manage ? (
        <NameSheet
          id="zone-form"
          open={creating}
          onOpenChange={setCreating}
          title={s09.newZone}
          label={s09.zoneName}
          pending={addZone.pending}
          onSubmit={async (name) => {
            try {
              await addZone.run({ name, sort_order: (zones.data?.length ?? 0) + 1 });
              pushToast({ message: ui.saved, tone: 'success' });
            } finally {
              void qc.invalidateQueries({ queryKey: queryKeys.zones(venueId) });
            }
          }}
        />
      ) : null}
      {toggle.dialog}
    </div>
  );
}

function ZoneCard({
  venueId,
  zone,
  spots,
  manage,
  onToggle,
}: {
  venueId: string;
  zone: ParkingZone;
  spots: ParkingSpot[];
  manage: boolean;
  onToggle: (item: GridItem) => void;
}) {
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);
  const [adding, setAdding] = useState(false);
  const add = useCommand((body: NonNullable<BulkLabels['range']>, key: string) =>
    createSpots(venueId, { zone_id: zone.id, range: body }, key),
  );
  const status = useCommand((next: SetupStatus, key: string) => patchZone(zone.id, { status: next }, key));
  const onStatus = async () => {
    try {
      await status.run(zone.status === 'active' ? 'inactive' : 'active');
      pushToast({ message: ui.saved, tone: 'success' });
    } catch {
      // shown under the card
    } finally {
      void qc.invalidateQueries({ queryKey: queryKeys.zones(venueId) });
    }
  };
  return (
    <Card as="article" className="pt-record" aria-label={zone.name} data-zone-id={zone.id}>
      <div className="pt-record__head">
        <h3 className="pt-record__title">{zone.name}</h3>
        <SetupStatusChip status={zone.status} />
      </div>
      <p className="pt-record__meta">{fmt(s09.spotsCount, { n: spots.length })}</p>
      {spots.length ? <ItemGrid items={spots} manage={manage} label={zone.name} onToggle={onToggle} /> : null}
      {manage ? (
        <div className="pt-record__actions">
          <Button compact iconStart={Plus} onClick={() => setAdding(true)}>
            {s09.addSpots}
          </Button>
          <Button compact variant="ghost" loading={status.pending} onClick={onStatus}>
            {zone.status === 'active' ? s09.disable : s09.enable}
          </Button>
        </div>
      ) : null}
      {status.error ? <FieldError role="alert">{displayMessage(status.error)}</FieldError> : null}
      {manage ? (
        <RangeSheet
          id={`spots-${zone.id}`}
          open={adding}
          onOpenChange={setAdding}
          title={s09.addSpots}
          pattern={s09.spotsPattern}
          defaultPrefix={`${zone.name}-`}
          pending={add.pending}
          onSubmit={async (range) => {
            try {
              await add.run(range);
              pushToast({ message: ui.saved, tone: 'success' });
            } finally {
              void qc.invalidateQueries({ queryKey: queryKeys.spots(venueId) });
            }
          }}
        />
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------- «لوحات المفاتيح»

export function KeysSection({ venueId, manage }: { venueId: string; manage: boolean }) {
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);
  const boards = useQuery({
    queryKey: queryKeys.keyBoards(venueId),
    queryFn: ({ signal }) => listKeyBoards(venueId, signal),
  });
  const [creating, setCreating] = useState(false);
  const addBoard = useCommand((body: { name: string }, key: string) => createKeyBoard(venueId, body, key));
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.keyBoards(venueId) });
  const toggle = useToggle(patchSlot, 'KEY_SLOT_OCCUPIED', refresh);
  return (
    <div className="flex flex-col gap-3">
      {manage ? (
        <Button compact variant="secondary" iconStart={Plus} onClick={() => setCreating(true)}>
          {s09.newBoard}
        </Button>
      ) : null}
      <QueryView query={boards}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState icon={KeyRound} title={s09.emptyBoards} />
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label={s09.sections.keys}>
              {list.map((entry) => (
                <li key={entry.board.id}>
                  <BoardCard entry={entry} manage={manage} onToggle={toggle.open} venueId={venueId} />
                </li>
              ))}
            </ul>
          )
        }
      </QueryView>
      {manage ? (
        <NameSheet
          id="board-form"
          open={creating}
          onOpenChange={setCreating}
          title={s09.newBoard}
          label={s09.boardName}
          pending={addBoard.pending}
          onSubmit={async (name) => {
            try {
              await addBoard.run({ name });
              pushToast({ message: ui.saved, tone: 'success' });
            } finally {
              void refresh();
            }
          }}
        />
      ) : null}
      {toggle.dialog}
    </div>
  );
}

function BoardCard({
  entry,
  manage,
  onToggle,
  venueId,
}: {
  entry: KeyBoardWithSlots;
  manage: boolean;
  onToggle: (item: GridItem) => void;
  venueId: string;
}) {
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);
  const [adding, setAdding] = useState(false);
  const add = useCommand((body: NonNullable<BulkLabels['range']>, key: string) =>
    createSlots(entry.board.id, { range: body }, key),
  );
  return (
    <Card as="article" className="pt-record" aria-label={entry.board.name} data-board-id={entry.board.id}>
      <div className="pt-record__head">
        <h3 className="pt-record__title">{entry.board.name}</h3>
        <SetupStatusChip status={entry.board.status} />
      </div>
      <p className="pt-record__meta">{fmt(s09.slotsCount, { n: entry.slots.length })}</p>
      {entry.slots.length ? (
        <ItemGrid items={entry.slots} manage={manage} label={entry.board.name} onToggle={onToggle} />
      ) : null}
      {manage ? (
        <>
          <div className="pt-record__actions">
            <Button compact iconStart={Plus} onClick={() => setAdding(true)}>
              {s09.addSlots}
            </Button>
          </div>
          <RangeSheet
            id={`slots-${entry.board.id}`}
            open={adding}
            onOpenChange={setAdding}
            title={s09.addSlots}
            pattern={s09.slotsPattern}
            defaultPrefix=""
            pending={add.pending}
            onSubmit={async (range) => {
              try {
                await add.run(range);
                pushToast({ message: ui.saved, tone: 'success' });
              } finally {
                void qc.invalidateQueries({ queryKey: queryKeys.keyBoards(venueId) });
              }
            }}
          />
        </>
      ) : null}
    </Card>
  );
}
