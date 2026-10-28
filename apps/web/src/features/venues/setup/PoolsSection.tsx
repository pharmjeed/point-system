import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers, Plus } from 'lucide-react';
import { useState } from 'react';
import { displayMessage } from '@/api/errors';
import { queryKeys } from '@/api/queryClient';
import { createPool, listPools, patchPool } from '@/api/setup';
import type { DispatchPool, SetupStatus } from '@/api/types';
import { Banner, Button, Card, EmptyState, FieldError } from '@/components';
import { QueryView } from '@/features/common/QueryView';
import { SetupStatusChip, StateChip } from '@/features/common/StateChip';
import { useCommand } from '@/hooks/useCommand';
import { s09, ui } from '@/i18n/ar';
import { useUiStore } from '@/stores/ui';
import { NameSheet } from './SetupSheets';

/** «مجموعات التوزيع»: the default pool and any extra one (02 S-09); `venue.manage` creates and toggles. */
export function PoolsSection({ venueId, manage }: { venueId: string; manage: boolean }) {
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);
  const pools = useQuery({
    queryKey: queryKeys.pools(venueId),
    queryFn: ({ signal }) => listPools(venueId, signal),
  });
  const [creating, setCreating] = useState(false);
  const add = useCommand((body: { name: string }, key: string) => createPool(venueId, body, key));
  return (
    <div className="flex flex-col gap-3">
      <Banner kind="info" rounded message={s09.poolsHint} />
      {manage ? (
        <Button compact variant="secondary" iconStart={Plus} onClick={() => setCreating(true)}>
          {s09.newPool}
        </Button>
      ) : null}
      <QueryView query={pools}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState icon={Layers} title={s09.sections.pools} />
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label={s09.sections.pools}>
              {[...list]
                .sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.name.localeCompare(b.name))
                .map((pool) => (
                  <li key={pool.id}>
                    <PoolCard pool={pool} manage={manage} venueId={venueId} />
                  </li>
                ))}
            </ul>
          )
        }
      </QueryView>
      {manage ? (
        <NameSheet
          id="pool-form"
          open={creating}
          onOpenChange={setCreating}
          title={s09.newPool}
          label={s09.poolName}
          pending={add.pending}
          onSubmit={async (name) => {
            try {
              await add.run({ name });
              pushToast({ message: ui.saved, tone: 'success' });
            } finally {
              void qc.invalidateQueries({ queryKey: queryKeys.pools(venueId) });
            }
          }}
        />
      ) : null}
    </div>
  );
}

function PoolCard({ pool, manage, venueId }: { pool: DispatchPool; manage: boolean; venueId: string }) {
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);
  const toggle = useCommand((next: SetupStatus, key: string) => patchPool(pool.id, { status: next }, key));
  const onToggle = async () => {
    try {
      await toggle.run(pool.status === 'active' ? 'inactive' : 'active');
      pushToast({ message: ui.saved, tone: 'success' });
    } catch {
      // shown under the card
    } finally {
      void qc.invalidateQueries({ queryKey: queryKeys.pools(venueId) });
    }
  };
  return (
    <Card as="article" className="pt-record" aria-label={pool.name}>
      <div className="pt-record__head">
        <h3 className="pt-record__title">{pool.name}</h3>
        <div className="flex flex-wrap items-center gap-2">
          {pool.is_default ? <StateChip label={s09.defaultPool} tone="info" icon={Layers} /> : null}
          <SetupStatusChip status={pool.status} />
        </div>
      </div>
      {manage && !pool.is_default ? (
        <div className="pt-record__actions">
          <Button compact variant="ghost" loading={toggle.pending} onClick={onToggle}>
            {pool.status === 'active' ? s09.disable : s09.enable}
          </Button>
        </div>
      ) : null}
      {toggle.error ? <FieldError role="alert">{displayMessage(toggle.error)}</FieldError> : null}
    </Card>
  );
}
