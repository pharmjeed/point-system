import { useInfiniteQuery } from '@tanstack/react-query';
import { MessageSquareWarning, Search } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import {
  complaintKeys,
  complaintsApi,
  type ComplaintFilters,
  type ComplaintStatus,
  type PlatformComplaint,
} from '@/api/platformComplaints';
import { Button, Card, EmptyState, Select, TextField } from '@/components';
import { StateChip } from '@/features/common/StateChip';
import { QueryError, ReasonDialog } from '@/features/supervisor/ui';
import { useStaffCommand } from '@/features/supervisor/useStaffCommand';
import { useOnline } from '@/hooks/useOnline';
import { errorMessagesAr } from '@/i18n/errors';
import { p13 } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { formatDateTime } from '@/lib/format';
import { usePlatformAccount } from './PlatformLayout';
import { platformCan } from './platformModel';

const TONE: Record<ComplaintStatus, 'warning' | 'info' | 'success' | 'neutral'> = {
  open: 'warning',
  in_progress: 'info',
  resolved: 'success',
  closed: 'neutral',
};

/**
 * P-13 «الشكاوى» (V2-037; docs/v2/02 P-13; DEC-603, DEC-604): `platform.complaint_manage` (every platform role). The
 * customers' complaints from the app with their reference numbers — by status, or one reference — the customer
 * masked; a status move needs a note the customer reads on C-21, and is audited.
 */
export function PlatformComplaintsPage() {
  const me = usePlatformAccount();
  const allowed = platformCan(me, 'platform.complaint_manage');
  const [status, setStatus] = useState<'' | ComplaintStatus>('');
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const filters: ComplaintFilters = useMemo(
    () => ({ ...(status ? { status } : {}), ...(q ? { q } : {}) }),
    [status, q],
  );
  const list = useInfiniteQuery({
    queryKey: complaintKeys.list(filters),
    queryFn: ({ pageParam, signal }) => complaintsApi.list(filters, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: allowed,
  });
  if (!allowed) return <EmptyState icon={MessageSquareWarning} title={errorMessagesAr.PERMISSION_DENIED} />;
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setQ(input.trim());
  };
  return (
    <div className="st-page" data-testid="platform-complaints">
      <h1 className="pt-page-title">{p13.title}</h1>
      <p className="m-0 text-text-muted">{p13.intro}</p>
      <Card>
        <form className="st-form" noValidate role="search" onSubmit={submit}>
          <TextField
            id="p13-q"
            label={p13.search}
            dir="ltr"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <Select
            id="p13-status"
            label={p13.status}
            value={status}
            options={[
              ['', p13.all],
              ...(Object.keys(p13.statusLabel) as ComplaintStatus[]).map(
                (s) => [s, p13.statusLabel[s]] as const,
              ),
            ]}
            onChange={(e) => setStatus(e.target.value as '' | ComplaintStatus)}
          />
          <div className="st-row-actions">
            <Button type="submit" compact iconStart={Search}>
              {p13.searchAction}
            </Button>
          </div>
        </form>
      </Card>
      {list.isError && !list.data ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data && !rows.length ? (
        <EmptyState icon={MessageSquareWarning} title={p13.empty} />
      ) : (
        rows.map((c) => <ComplaintCard key={c.complaint_id} c={c} filters={filters} />)
      )}
      {list.hasNextPage ? (
        <Button
          variant="secondary"
          loading={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {p13.searchAction}
        </Button>
      ) : null}
    </div>
  );
}

function ComplaintCard({ c, filters }: { c: PlatformComplaint; filters: ComplaintFilters }) {
  const online = useOnline();
  const [next, setNext] = useState<ComplaintStatus | null>(null);
  const move = useStaffCommand(
    (input: { status: ComplaintStatus; note: string }, key: string) =>
      complaintsApi.setStatus(c.complaint_id, input, key),
    {
      successMessage: p13.done,
      invalidate: [complaintKeys.list(filters), ['platform', 'complaints']],
      onSuccess: () => setNext(null),
    },
  );
  return (
    <Card>
      <div className="st-head" data-testid={`p13-${c.reference}`}>
        <div className="st-head__title">
          <h2 className="m-0 font-bold">
            <bdi dir="ltr" className="pt-num">
              {c.reference}
            </bdi>{' '}
            · {p13.categoryLabel[c.category]}
          </h2>
          <StateChip label={p13.statusLabel[c.status]} tone={TONE[c.status]} icon={MessageSquareWarning} />
        </div>
        <div className="st-head__actions">
          {c.allowed_next.map((s) => (
            <Button key={s} variant="secondary" compact disabled={!online} onClick={() => setNext(s)}>
              {p13.statusLabel[s]}
            </Button>
          ))}
        </div>
      </div>
      <p className="m-0 text-sm text-text-muted">
        <bdi dir="ltr" className="pt-num">
          {c.phone_masked ?? '—'}
        </bdi>
        {c.venue_name_ar ? ` · ${c.venue_name_ar}` : ''}
        {c.operator_name_ar ? ` · ${c.operator_name_ar}` : ''} · {formatDateTime(c.created_at)}
      </p>
      <p className="m-0">{c.body}</p>
      {c.resolution_note ? <p className="m-0 text-sm">{c.resolution_note}</p> : null}
      <ReasonDialog
        id={`p13-move-${c.complaint_id}`}
        open={!!next}
        onOpenChange={(o) => {
          if (!o) setNext(null);
        }}
        title={fmt(p13.moveTitle, { reference: c.reference, status: next ? p13.statusLabel[next] : '' })}
        body={p13.moveBody}
        confirmLabel={p13.move}
        pending={move.pending}
        reasonError={move.fields.note ?? null}
        error={move.message}
        onConfirm={(note) => (next ? move.run({ status: next, note }) : undefined)}
      />
    </Card>
  );
}
