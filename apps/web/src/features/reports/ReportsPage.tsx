import { useQuery } from '@tanstack/react-query';
import { ChartColumn, Download, FileDown, MessageCircle, Users, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type { EventStatus, Export, ExportKind, Me } from '@/api/types';
import {
  Banner,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  KpiStrip,
  Select,
  TextField,
} from '@/components';
import type { KpiTileProps } from '@/components/Kpi';
import { useStaffMe } from '@/features/ops/StaffLayout';
import { can } from '@/features/supervisor/permissions';
import { useVenueEvents, useVenues } from '@/features/supervisor/selection';
import {
  commands,
  fetchDriversReport,
  fetchEventSummary,
  fetchExport,
  fetchMessagesReport,
  fetchPaymentsReport,
  staffKeys,
  type PeriodFilters,
} from '@/features/supervisor/staffApi';
import { ForbiddenPage, PageSkeleton, QueryError, Section } from '@/features/supervisor/ui';
import { useStaffCommand } from '@/features/supervisor/useStaffCommand';
import { buttons, eventStatus, paymentMethod, waMessageStatus } from '@/i18n/ar';
import { exportKind, s11, staff } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { formatClock, formatHalalas, formatNumber } from '@/lib/format';
import { serverNow } from '@/lib/serverClock';
import { lastWeek, periodToUtc } from './period';
import '@/features/supervisor/staff.css';

const REPORT_EVENT_STATUSES: readonly EventStatus[] = ['open', 'closing', 'closed'];

/**
 * S-11 — التقارير والتصدير (02 §4 S-11, PNT-088/089): filters (venue, event or period in Riyadh days) and four
 * cards — event summary, driver performance, payments, messages — then «تصدير CSV» (`POST /v1/exports`, audited)
 * followed by `GET /v1/exports/{exportId}` until the temporary download link is ready. Canceled cycles are shown
 * apart and never in the delivery averages (02 note).
 */
export function ReportsPage() {
  const me = useStaffMe();
  if (!can(me, 'report.read')) return <ForbiddenPage title={s11.title} />;
  return <Reports me={me} />;
}

function Reports({ me }: { me: Me }) {
  const [params] = useSearchParams();
  const venues = useVenues(can(me, 'venue.read'));
  const venueList = venues.data?.items ?? [];
  const [venueId, setVenueId] = useState<string>('');
  const effectiveVenue = venueId || venueList[0]?.id || '';
  const events = useVenueEvents(effectiveVenue || null, REPORT_EVENT_STATUSES);
  const [eventId, setEventId] = useState<string>(params.get('event') ?? '');
  const initial = lastWeek(serverNow());
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [exporting, setExporting] = useState(false);
  const period = periodToUtc(from, to);
  const filters: PeriodFilters = {
    venue_id: effectiveVenue || undefined,
    event_id: eventId || undefined,
    from: period?.from,
    to: period?.to,
  };

  return (
    <div className="st-page">
      <div className="st-head">
        <h1 className="pt-page-title">{s11.title}</h1>
        {can(me, 'export.create') ? (
          <div className="st-head__actions">
            <Button variant="secondary" compact iconStart={FileDown} onClick={() => setExporting(true)}>
              {s11.export}
            </Button>
          </div>
        ) : null}
      </div>
      <Card as="section" aria-label={s11.period}>
        <div className="st-grid2">
          <Select
            id="reports-venue"
            label={staff.venue}
            value={effectiveVenue}
            options={venueList.map((v) => [v.id, v.name_ar] as const)}
            onChange={(e) => {
              setVenueId(e.target.value);
              setEventId('');
            }}
            disabled={venueList.length < 2}
          />
          <Select
            id="reports-event"
            label={staff.event}
            value={eventId}
            placeholder={staff.none}
            options={(events.data?.items ?? []).map(
              (e) => [e.id, `${e.name_ar} · ${e.event_date} · ${eventStatus[e.status]}`] as const,
            )}
            onChange={(e) => setEventId(e.target.value)}
          />
          <TextField
            id="reports-from"
            type="date"
            label={staff.from}
            dir="ltr"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <TextField
            id="reports-to"
            type="date"
            label={staff.to}
            dir="ltr"
            value={to}
            error={!period ? s11.periodInvalid : undefined}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
      </Card>
      {venues.isError && !venues.data ? (
        <QueryError error={venues.error} onRetry={() => void venues.refetch()} />
      ) : null}
      <EventSummaryCard eventId={eventId || null} />
      <DriversCard filters={filters} enabled={!!period} />
      <PaymentsCard filters={filters} enabled={!!period || !!eventId} />
      <MessagesCard filters={filters} enabled={!!period} />
      {exporting ? <ExportDialog me={me} filters={filters} onClose={() => setExporting(false)} /> : null}
    </div>
  );
}

const secs = (v?: number | null) => (v == null ? staff.none : formatClock(v));
const n = (v?: number | null) => (v == null ? staff.none : formatNumber(v));

function EventSummaryCard({ eventId }: { eventId: string | null }) {
  const summary = useQuery({
    queryKey: staffKeys.report('event-summary', { eventId: eventId ?? undefined }),
    queryFn: ({ signal }) => fetchEventSummary(eventId as string, signal),
    enabled: !!eventId,
  });
  return (
    <Section title={s11.cards.eventSummary}>
      {!eventId ? (
        <EmptyState icon={ChartColumn} title={s11.chooseEvent} />
      ) : summary.isPending ? (
        <PageSkeleton rows={1} />
      ) : !summary.data ? (
        <QueryError error={summary.error} onRetry={() => void summary.refetch()} />
      ) : (
        (() => {
          const r = summary.data;
          const t = r.timings_seconds;
          const items: KpiTileProps[] = [
            { label: s11.summary.vehicles, value: n(r.counts.tickets_total) },
            { label: s11.summary.delivered, value: n(r.counts.delivered) },
            { label: s11.summary.canceled, value: n(r.counts.canceled_requests) },
            { label: s11.summary.reparks, value: n(r.counts.reparks) },
            {
              label: s11.summary.accept,
              value: secs(t.accept?.p50),
              meta: fmt(s11.summary.p90, { v: secs(t.accept?.p90) }),
            },
            {
              label: s11.summary.start,
              value: secs(t.start?.p50),
              meta: fmt(s11.summary.p90, { v: secs(t.start?.p90) }),
            },
            {
              label: s11.summary.requestToReady,
              value: secs(t.request_to_ready?.p50),
              meta: fmt(s11.summary.p90, { v: secs(t.request_to_ready?.p90) }),
            },
            {
              label: s11.summary.readyToDelivered,
              value: secs(t.ready_to_delivered?.p50),
              meta: fmt(s11.summary.p90, { v: secs(t.ready_to_delivered?.p90) }),
            },
            { label: s11.summary.openAtClose, value: n(r.counts.open) },
          ];
          return (
            <>
              <KpiStrip items={items} />
              <p className="st-muted m-0">{s11.canceledNote}</p>
            </>
          );
        })()
      )}
    </Section>
  );
}

function DriversCard({ filters, enabled }: { filters: PeriodFilters; enabled: boolean }) {
  const report = useQuery({
    queryKey: staffKeys.report('drivers', { ...filters, event_id: undefined }),
    queryFn: ({ signal }) => fetchDriversReport(filters, signal),
    enabled: enabled && !!filters.venue_id,
  });
  return (
    <Section title={s11.cards.drivers}>
      {report.isError && !report.data ? (
        <QueryError error={report.error} onRetry={() => void report.refetch()} />
      ) : (
        <DataTable
          layout="auto"
          loading={report.isPending && enabled}
          rows={report.data?.items ?? []}
          rowKey={(r) => r.driver.id}
          columns={[
            { key: 'driver', label: staff.driver, render: (r) => r.driver.full_name },
            { key: 'parked', label: s11.driversCols.intakes, render: (r) => n(r.parked) },
            { key: 'retrieved', label: s11.driversCols.retrievals, render: (r) => n(r.retrieved) },
            { key: 'delivered', label: s11.driversCols.delivered, render: (r) => n(r.delivered) },
            { key: 'accept', label: s11.driversCols.accept, render: (r) => secs(r.accept_p50_s) },
            { key: 'expired', label: s11.driversCols.expired, render: (r) => n(r.offers_expired) },
          ]}
        />
      )}
      {report.data && !report.data.items.length ? <EmptyState icon={Users} title={staff.noResults} /> : null}
    </Section>
  );
}

function PaymentsCard({ filters, enabled }: { filters: PeriodFilters; enabled: boolean }) {
  const report = useQuery({
    queryKey: staffKeys.report('payments', { ...filters }),
    queryFn: ({ signal }) => fetchPaymentsReport(filters, signal),
    enabled: enabled && !!filters.venue_id,
  });
  const t = report.data?.totals;
  return (
    <Section title={s11.cards.payments}>
      {report.isError && !report.data ? (
        <QueryError error={report.error} onRetry={() => void report.refetch()} />
      ) : report.isPending && enabled ? (
        <PageSkeleton rows={1} />
      ) : t ? (
        <KpiStrip
          items={[
            { label: paymentMethod.cash, value: formatHalalas(t.cash_halalas ?? 0), icon: Wallet },
            { label: paymentMethod.pos, value: formatHalalas(t.pos_halalas ?? 0), icon: Wallet },
            { label: s11.paymentsCols.reversed, value: n(t.reversed) },
            { label: s11.paymentsCols.waived, value: n(t.waived) },
            { label: s11.paymentsCols.outstanding, value: n(t.outstanding) },
          ]}
        />
      ) : null}
    </Section>
  );
}

function MessagesCard({ filters, enabled }: { filters: PeriodFilters; enabled: boolean }) {
  const report = useQuery({
    queryKey: staffKeys.report('messages', { ...filters, event_id: undefined }),
    queryFn: ({ signal }) => fetchMessagesReport(filters, signal),
    enabled: enabled && !!filters.venue_id,
  });
  const totals = report.data?.totals;
  const reasons = new Map<string, number>();
  for (const m of report.data?.failures ?? []) {
    const k = m.error_title ?? m.error_code ?? waMessageStatus.failed;
    reasons.set(k, (reasons.get(k) ?? 0) + 1);
  }
  return (
    <Section title={s11.cards.messages}>
      {report.isError && !report.data ? (
        <QueryError error={report.error} onRetry={() => void report.refetch()} />
      ) : report.isPending && enabled ? (
        <PageSkeleton rows={1} />
      ) : totals ? (
        <>
          <KpiStrip
            items={[
              { label: s11.messagesCols.sent, value: n(totals.sent), icon: MessageCircle },
              { label: s11.messagesCols.delivered, value: n(totals.delivered) },
              { label: s11.messagesCols.read, value: n(totals.read) },
              {
                label: waMessageStatus.failed,
                value: n(totals.failed),
                tone: totals.failed ? 'danger' : undefined,
              },
            ]}
          />
          {reasons.size ? (
            <div className="st-section">
              <h3 className="pt-section-title">{s11.messagesCols.failed}</h3>
              <ul className="pt-list">
                {[...reasons.entries()].map(([reason, count]) => (
                  <li key={reason} className="pt-listitem">
                    <span className="pt-listitem__body">
                      <span className="pt-listitem__title">{reason}</span>
                    </span>
                    <span className="pt-listitem__trail st-num">{count}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

/** «تصدير CSV» → «يُسجّل التصدير في سجل التدقيق.» → `POST /v1/exports` → poll until ready (02 S-11). */
function ExportDialog({ me, filters, onClose }: { me: Me; filters: PeriodFilters; onClose: () => void }) {
  const kinds = (Object.keys(exportKind) as ExportKind[]).filter(
    (k) => k !== 'audit' || can(me, 'audit.read'),
  );
  const [kind, setKind] = useState<ExportKind>(filters.event_id ? 'event_summary' : 'tickets');
  const [job, setJob] = useState<Export | null>(null);
  const create = useStaffCommand(
    (body: Parameters<typeof commands.createExport>[0], key: string) => commands.createExport(body, key),
    { successMessage: null, onSuccess: (e) => setJob(e), onPermissionDenied: onClose },
  );
  const poll = useQuery({
    queryKey: staffKeys.exportJob(job?.id ?? '-'),
    queryFn: ({ signal }) => fetchExport(job?.id as string, signal),
    enabled: !!job,
    refetchInterval: (q) => {
      const s = q.state.data?.status ?? job?.status;
      return s === 'pending' || s === 'running' ? 2000 : false;
    },
  });
  const current = poll.data ?? job;
  const body = {
    kind,
    filters: Object.fromEntries(
      Object.entries({
        venue_id: filters.venue_id,
        event_id:
          kind === 'event_summary' || kind === 'tickets' || kind === 'payments'
            ? filters.event_id
            : undefined,
        from: filters.event_id ? undefined : filters.from,
        to: filters.event_id ? undefined : filters.to,
      }).filter(([, v]) => !!v),
    ),
  };
  return (
    <Dialog
      id="export"
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      onCancel={onClose}
      title={s11.export}
      body={s11.exportBody}
      confirmLabel={current ? buttons.close : buttons.confirm}
      cancelLabel={buttons.cancel}
      hideCancel={!!current}
      loading={create.pending}
      disabled={!kind}
      error={create.message ?? undefined}
      onConfirm={() => (current ? onClose() : create.run(body))}
    >
      {!current ? (
        <Select
          id="export-kind"
          label={s11.exportKind}
          value={kind}
          options={kinds.map((k) => [k, exportKind[k]] as const)}
          onChange={(e) => setKind(e.target.value as ExportKind)}
        />
      ) : (
        <div className="st-section" aria-live="polite">
          <Banner
            kind={current.status === 'failed' || current.status === 'expired' ? 'error' : 'info'}
            rounded
            message={s11.exportStatus[current.status]}
            detail={current.error ?? undefined}
          />
          {current.status === 'ready' && current.download_url ? (
            <a
              className="pt-btn pt-btn--secondary pt-btn--md pt-btn--full"
              href={current.download_url}
              download
              rel="noreferrer"
            >
              <Download size={20} aria-hidden="true" />
              <span>{s11.download}</span>
            </a>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
