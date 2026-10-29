import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useState } from 'react';
import type { AuditEntry } from '@/api/types';
import { Button, DataTable, EmptyState, Select, TextField } from '@/components';
import { periodToUtc } from '@/features/reports/period';
import { useVenues } from '@/features/supervisor/selection';
import { fetchAuditLog, staffKeys } from '@/features/supervisor/staffApi';
import { QueryError } from '@/features/supervisor/ui';
import { ui } from '@/i18n/ar';
import { s13, staff } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { formatDateTime } from '@/lib/format';
import { useCursorPages } from './useCursorPages';

interface AuditFilters {
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  venue_id: string;
  from: string;
  to: string;
}

const EMPTY: AuditFilters = {
  actor_id: '',
  action: '',
  entity_type: '',
  entity_id: '',
  venue_id: '',
  from: '',
  to: '',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The query of `GET /v1/admin/audit-log` from the form (empty fields dropped, Riyadh days → UTC). */
export function auditQuery(f: AuditFilters): Record<string, string | undefined> {
  const period = f.from && f.to ? periodToUtc(f.from, f.to) : null;
  const v = (s: string) => s.trim() || undefined;
  return {
    actor_id: v(f.actor_id),
    action: v(f.action),
    entity_type: v(f.entity_type),
    entity_id: UUID.test(f.entity_id.trim()) ? f.entity_id.trim() : undefined,
    venue_id: v(f.venue_id),
    from: period?.from,
    to: period?.to,
  };
}

/**
 * «سجل التدقيق» (02 S-13, PNT-092): search by actor, action, entity, venue and period; read only, with the
 * before/after of each entry. Admin and owner (`audit.read`); reading it is itself audited server-side (09 §3).
 */
export function AuditLogSection() {
  const venues = useVenues();
  const [draft, setDraft] = useState<AuditFilters>(EMPTY);
  const [applied, setApplied] = useState<Record<string, string | undefined>>(auditQuery(EMPTY));
  const pages = useCursorPages(applied);
  const list = useQuery({
    queryKey: staffKeys.auditLog(applied, pages.cursor),
    queryFn: ({ signal }) => fetchAuditLog(applied, pages.cursor, signal),
  });
  const set = (k: keyof AuditFilters) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));
  return (
    <div className="st-section">
      <form
        className="st-form"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(auditQuery(draft));
        }}
      >
        <div className="st-grid2">
          <TextField
            id="audit-actor"
            label={s13.audit.actor}
            dir="ltr"
            value={draft.actor_id}
            onChange={set('actor_id')}
          />
          <TextField
            id="audit-action"
            label={s13.audit.action}
            dir="ltr"
            value={draft.action}
            onChange={set('action')}
          />
          <TextField
            id="audit-entity"
            label={s13.audit.entity}
            dir="ltr"
            value={draft.entity_type}
            onChange={set('entity_type')}
          />
          <TextField
            id="audit-entity-id"
            label={s13.audit.entityId}
            dir="ltr"
            value={draft.entity_id}
            onChange={set('entity_id')}
          />
          <Select
            id="audit-venue"
            label={staff.venue}
            placeholder={staff.none}
            value={draft.venue_id}
            options={(venues.data?.items ?? []).map((v) => [v.id, v.name_ar] as const)}
            onChange={set('venue_id')}
          />
          <TextField
            id="audit-from"
            type="date"
            label={staff.from}
            dir="ltr"
            value={draft.from}
            onChange={set('from')}
          />
          <TextField
            id="audit-to"
            type="date"
            label={staff.to}
            dir="ltr"
            value={draft.to}
            onChange={set('to')}
          />
        </div>
        <Button type="submit" variant="secondary" iconStart={Search} fullWidth>
          {s13.audit.search}
        </Button>
      </form>
      {list.isError && !list.data ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} />
      ) : null}
      {list.data && !list.data.items.length ? (
        <EmptyState title={s13.audit.empty} />
      ) : (
        <DataTable
          layout="auto"
          loading={list.isPending}
          rows={list.data?.items ?? []}
          rowKey={(r) => String(r.id)}
          hasPrev={pages.hasPrev}
          hasNext={!!list.data?.nextCursor}
          onPrev={pages.prev}
          onNext={() => pages.next(list.data?.nextCursor ?? null)}
          columns={[
            { key: 'time', label: staff.time, render: (r) => formatDateTime(r.occurred_at) },
            {
              key: 'actor',
              label: s13.audit.actor,
              render: (r) => (
                <bdi dir="ltr">{r.actor_id ? `${r.actor_type}:${r.actor_id}` : r.actor_type}</bdi>
              ),
            },
            { key: 'action', label: s13.audit.action, render: (r) => <bdi dir="ltr">{r.action}</bdi> },
            {
              key: 'entity',
              label: s13.audit.entity,
              render: (r) => (
                <bdi dir="ltr">{[r.entity_type, r.entity_id].filter(Boolean).join(':') || staff.none}</bdi>
              ),
            },
            { key: 'reason', label: staff.reason, render: (r) => r.reason ?? staff.none },
            {
              key: 'diff',
              label: `${s13.audit.before} / ${s13.audit.after}`,
              render: (r) => <Diff entry={r} />,
            },
          ]}
        />
      )}
    </div>
  );
}

function Diff({ entry }: { entry: AuditEntry }) {
  if (!entry.before && !entry.after && !entry.request_id) return <>{staff.none}</>;
  return (
    <details className="st-details">
      <summary>{`${s13.audit.before} / ${s13.audit.after}`}</summary>
      {entry.before ? (
        <>
          <span className="st-muted">{s13.audit.before}</span>
          <pre className="st-json">{JSON.stringify(entry.before, null, 2)}</pre>
        </>
      ) : null}
      {entry.after ? (
        <>
          <span className="st-muted">{s13.audit.after}</span>
          <pre className="st-json">{JSON.stringify(entry.after, null, 2)}</pre>
        </>
      ) : null}
      {entry.request_id ? (
        <span className="st-muted">{fmt(ui.requestId, { id: entry.request_id })}</span>
      ) : null}
    </details>
  );
}
