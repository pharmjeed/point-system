import { useQuery } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import type { Me, OutboxEvent, OutboxStatus } from '@/api/types';
import { Button, DataTable, EmptyState, FilterChips, TextField } from '@/components';
import { can } from '@/features/supervisor/permissions';
import { commands, fetchOutbox, staffKeys } from '@/features/supervisor/staffApi';
import { QueryError } from '@/features/supervisor/ui';
import { useStaffCommand } from '@/features/supervisor/useStaffCommand';
import { useServerNow } from '@/hooks/useNow';
import { useOnline } from '@/hooks/useOnline';
import { buttons } from '@/i18n/ar';
import { outboxStatus, s13, staff } from '@/i18n/ar.staff';
import { onlyDigits } from '@/lib/digits';
import { formatClock, formatDateTime } from '@/lib/format';
import { useCursorPages } from './useCursorPages';

const STATUSES: OutboxStatus[] = ['failed', 'dead', 'pending', 'processing', 'canceled', 'done'];

/**
 * «صندوق الأحداث» (02 S-13, PNT-092): stuck and failed outbox events — type, attempts, last error, age —
 * with «إعادة المحاولة» for `failed`/`dead` (`POST /v1/admin/outbox/{outboxId}/retry`, audited; the worker re-checks
 * `aggregate_version`, so a stale effect is skipped). Admin and owner (`outbox.manage`).
 */
export function OutboxSection({ me }: { me: Me }) {
  const [statuses, setStatuses] = useState<OutboxStatus[]>(['failed', 'dead']);
  const [type, setType] = useState('');
  const [olderThan, setOlderThan] = useState('');
  const filters = {
    status: statuses.length ? statuses.join(',') : undefined,
    type: type.trim() || undefined,
    older_than_s: olderThan || undefined,
  };
  const pages = useCursorPages(filters);
  const list = useQuery({
    queryKey: staffKeys.outbox(filters, pages.cursor),
    queryFn: ({ signal }) =>
      fetchOutbox(
        {
          status: statuses.length ? statuses : undefined,
          type: filters.type,
          older_than_s: filters.older_than_s,
        },
        pages.cursor,
        signal,
      ),
  });
  const now = useServerNow(5000);
  return (
    <div className="st-section">
      <FilterChips
        label={staff.status}
        options={STATUSES.map((s) => ({ value: s, label: outboxStatus[s] }))}
        value={statuses}
        onChange={(v) => setStatuses(v as OutboxStatus[])}
      />
      <div className="st-grid2">
        <TextField
          id="outbox-type"
          label={staff.type}
          dir="ltr"
          value={type}
          onChange={(e) => setType(e.target.value)}
        />
        <TextField
          id="outbox-older"
          label={s13.outbox.olderThan}
          inputMode="numeric"
          dir="ltr"
          value={olderThan}
          onChange={(e) => setOlderThan(onlyDigits(e.target.value))}
        />
      </div>
      {list.isError && !list.data ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} />
      ) : null}
      {list.data && !list.data.items.length ? (
        <EmptyState title={s13.outbox.empty} />
      ) : (
        <DataTable
          layout="auto"
          loading={list.isPending}
          rows={list.data?.items ?? []}
          rowKey={(r) => r.id}
          hasPrev={pages.hasPrev}
          hasNext={!!list.data?.nextCursor}
          onPrev={pages.prev}
          onNext={() => pages.next(list.data?.nextCursor ?? null)}
          columns={[
            { key: 'type', label: staff.type, render: (r) => <bdi dir="ltr">{r.type}</bdi> },
            { key: 'status', label: staff.status, render: (r) => outboxStatus[r.status] ?? r.status },
            {
              key: 'attempts',
              label: s13.outbox.attempts,
              render: (r) => <bdi dir="ltr" className="st-num">{`${r.attempts}/${r.max_attempts}`}</bdi>,
            },
            {
              key: 'last_error',
              label: s13.outbox.lastError,
              render: (r) => (r.last_error ? <bdi dir="ltr">{r.last_error}</bdi> : staff.none),
            },
            {
              key: 'age',
              label: s13.outbox.age,
              render: (r) => (
                <span title={formatDateTime(r.created_at)}>
                  <bdi dir="ltr" className="st-num">
                    {formatClock(Math.max(0, (now - Date.parse(r.created_at)) / 1000))}
                  </bdi>
                </span>
              ),
            },
            {
              key: 'retry',
              label: buttons.retry,
              render: (r) =>
                can(me, 'outbox.manage') && (r.status === 'failed' || r.status === 'dead') ? (
                  <RetryButton event={r} />
                ) : null,
            },
          ]}
        />
      )}
    </div>
  );
}

function RetryButton({ event }: { event: OutboxEvent }) {
  const online = useOnline();
  const retry = useStaffCommand(
    (_: Record<string, never>, key: string) => commands.retryOutbox(event.id, key),
    {
      invalidate: [['staff', 'admin', 'outbox']],
    },
  );
  return (
    <Button
      variant="secondary"
      compact
      iconStart={RotateCcw}
      loading={retry.pending}
      disabled={!online}
      error={retry.message ?? undefined}
      onClick={() => retry.run({})}
    >
      {buttons.retry}
    </Button>
  );
}
