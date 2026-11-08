import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ArrowRight, FileText, Scale } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  billingApi,
  billingKeys,
  type InvoiceDetail,
  type InvoiceFilters,
  type InvoiceKind,
  type SettlementDetail,
  type SettlementFilters,
  type SettlementStatus,
  type ZatcaStatus,
} from '@/api/billing';
import { paths, platformInvoicePath, platformSettlementPath } from '@/app/paths';
import { Button, Card, DataTable, EmptyState, Select, TextField } from '@/components';
import { QueryError, ReasonDialog, Section } from '@/features/supervisor/ui';
import { useStaffCommand } from '@/features/supervisor/useStaffCommand';
import { useOnline } from '@/hooks/useOnline';
import { errorMessagesAr } from '@/i18n/errors';
import { invoiceKind, p09, p10, settlementStatus, zatcaStatus } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { formatDateTime } from '@/lib/format';
import {
  adjustmentHalalas,
  isPeriod,
  previousMonth,
  statementActions,
  type StatementAction,
} from './billingModel';
import { LinesList, Money, SettlementChip, StatementBreakdown, ZatcaChip } from './billingUi';
import { usePlatformAccount } from './PlatformLayout';
import { isCalendarDate, platformCan } from './platformModel';

const statusOptions = <T extends string>(labels: Record<T, string>, all: string) =>
  [['', all] as const, ...(Object.keys(labels) as T[]).map((k) => [k, labels[k]] as const)] as ReadonlyArray<
    readonly [string, string]
  >;

function Denied({ icon }: { icon: typeof Scale }) {
  return <EmptyState icon={icon} title={errorMessagesAr.PERMISSION_DENIED} />;
}

// ------------------------------------------------------------------------------------------------ P-09 list

/**
 * P-09 «التسوية» (V2-041, docs/v2/04 §5; DEC-544): every operator's monthly statements, newest month first, with
 * filters, and «إعداد مسودات شهر» (the monthly job on demand). `platform.settlement_manage`: finance and the owner.
 */
export function PlatformSettlementsPage() {
  const me = usePlatformAccount();
  const navigate = useNavigate();
  const online = useOnline();
  const [form, setForm] = useState({ status: '', period: '' });
  const [applied, setApplied] = useState<SettlementFilters>({});
  const [issue, setIssue] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genPeriod, setGenPeriod] = useState(() => previousMonth(new Date()));
  const allowed = platformCan(me, 'platform.settlement_manage');
  const list = useInfiniteQuery({
    queryKey: billingKeys.settlements(applied),
    queryFn: ({ pageParam, signal }) => billingApi.settlements(applied, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: allowed,
  });
  const generate = useStaffCommand((period: string, key: string) => billingApi.generate({ period }, key), {
    successMessage: p09.generateDone,
    invalidate: [['platform', 'settlements']],
    onSuccess: () => setGenerating(false),
  });
  if (!allowed) return <Denied icon={Scale} />;
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const apply = (e: FormEvent) => {
    e.preventDefault();
    if (form.period && !isPeriod(form.period)) return setIssue(p09.periodInvalid);
    setIssue(null);
    setApplied({
      status: (form.status || undefined) as SettlementStatus | undefined,
      period: form.period || undefined,
    });
  };
  return (
    <div className="st-page" data-testid="platform-settlements">
      <div className="st-head">
        <h1 className="pt-page-title">{p09.title}</h1>
        <div className="st-head__actions">
          <Button compact disabled={!online} onClick={() => setGenerating(true)}>
            {p09.generate}
          </Button>
        </div>
      </div>
      <Card>
        <form className="st-form" noValidate onSubmit={apply} aria-label={p09.filters}>
          <div className="st-grid2">
            <Select
              id="p09-status"
              label={p09.status}
              value={form.status}
              options={statusOptions(settlementStatus, p09.all)}
              onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
            />
            <TextField
              id="p09-period"
              dir="ltr"
              label={p09.period}
              placeholder="2026-10"
              value={form.period}
              error={issue ?? undefined}
              onChange={(e) => setForm((f) => ({ ...f, period: e.target.value }))}
            />
          </div>
          <div className="st-row-actions">
            <Button type="submit" compact>
              {p09.apply}
            </Button>
          </div>
        </form>
      </Card>
      {list.isError && !list.data ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data && !rows.length ? (
        <EmptyState icon={Scale} title={p09.empty} />
      ) : (
        <DataTable
          layout="auto"
          loading={list.isPending}
          rows={rows}
          rowKey={(s) => s.id}
          hasNext={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onNext={() => void list.fetchNextPage()}
          columns={[
            {
              key: 'period',
              label: p09.period,
              render: (s) => (
                <bdi dir="ltr" className="pt-num font-bold">
                  {s.period}
                </bdi>
              ),
            },
            { key: 'operator', label: p09.operator, render: (s) => s.org?.name_ar ?? '—' },
            { key: 'status', label: p09.status, render: (s) => <SettlementChip status={s.status} /> },
            { key: 'net', label: p09.net, render: (s) => <Money halalas={s.net_payable_halalas} strong /> },
            {
              key: 'open',
              label: p09.open,
              render: (s) => (
                <Button variant="secondary" compact onClick={() => navigate(platformSettlementPath(s.id))}>
                  {p09.open}
                </Button>
              ),
            },
          ]}
        />
      )}
      <ReasonDialog
        id="settlement-generate"
        open={generating}
        onOpenChange={setGenerating}
        title={p09.generateTitle}
        body={p09.generateBody}
        confirmLabel={p09.generate}
        withReason={false}
        canConfirm={isPeriod(genPeriod)}
        pending={generate.pending}
        error={generate.message}
        onConfirm={() => generate.run(genPeriod)}
      >
        <TextField
          id="settlement-generate-period"
          dir="ltr"
          label={p09.period}
          value={genPeriod}
          error={isPeriod(genPeriod) ? undefined : p09.periodInvalid}
          onChange={(e) => setGenPeriod(e.target.value)}
        />
      </ReasonDialog>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ P-09 detail

/** P-09 — one statement: the breakdown, its lines (released ones apart), invoices, history and the commands. */
export function PlatformSettlementPage() {
  const me = usePlatformAccount();
  const { statementId = '' } = useParams();
  const navigate = useNavigate();
  const allowed = platformCan(me, 'platform.settlement_manage');
  const detail = useQuery({
    queryKey: billingKeys.settlement(statementId),
    queryFn: ({ signal }) => billingApi.settlement(statementId, signal),
    enabled: allowed,
  });
  if (!allowed) return <Denied icon={Scale} />;
  const back = (
    <Button
      variant="ghost"
      compact
      iconStart={ArrowRight}
      onClick={() => navigate(paths.platformSettlements)}
    >
      {p09.back}
    </Button>
  );
  if (detail.isError && !detail.data)
    return (
      <div className="st-page">
        {back}
        <QueryError error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  if (!detail.data)
    return (
      <div className="st-page" aria-busy>
        {back}
      </div>
    );
  return <SettlementView s={detail.data} back={back} />;
}

const ACTION_COPY: Record<StatementAction, { label: string; title: string; body: string; done: string }> = {
  adjust: { label: p09.adjust, title: p09.adjustTitle, body: p09.adjustBody, done: p09.adjustDone },
  issue: { label: p09.issue, title: p09.issueTitle, body: p09.issueBody, done: p09.issueDone },
  'record-payment': {
    label: p09.recordPayment,
    title: p09.recordTitle,
    body: p09.recordBody,
    done: p09.recordDone,
  },
  'resolve-dispute': {
    label: p09.resolve,
    title: p09.resolveTitle,
    body: p09.resolveBody,
    done: p09.resolveDone,
  },
  void: { label: p09.void, title: p09.voidTitle, body: p09.voidBody, done: p09.voidDone },
};

function SettlementView({ s, back }: { s: SettlementDetail; back: ReactNode }) {
  const me = usePlatformAccount();
  const online = useOnline();
  const navigate = useNavigate();
  const [action, setAction] = useState<StatementAction | null>(null);
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState('');
  const run = useStaffCommand(
    async (input: { action: StatementAction; reason: string }, key: string) => {
      const v = s.version;
      if (input.action === 'adjust')
        return billingApi.adjust(
          s.id,
          { expected_version: v, amount_halalas: adjustmentHalalas(amount) ?? 0, reason: input.reason },
          key,
        );
      if (input.action === 'issue') return billingApi.command(s.id, 'issue', { expected_version: v }, key);
      if (input.action === 'record-payment')
        return billingApi.command(
          s.id,
          'record-payment',
          { expected_version: v, reference: reference.trim(), paid_on: paidOn },
          key,
        );
      return billingApi.command(s.id, input.action, { expected_version: v, reason: input.reason }, key);
    },
    {
      successMessage: action ? ACTION_COPY[action].done : undefined,
      invalidate: [billingKeys.settlement(s.id), ['platform', 'settlements'], ['platform', 'invoices']],
      onSuccess: () => {
        setAction(null);
        setAmount('');
        setReference('');
        setPaidOn('');
      },
    },
  );
  const actions = statementActions(me, s.status);
  const active = s.lines.filter((l) => !l.released_at);
  const released = s.lines.filter((l) => l.released_at);
  const withReason = action === 'adjust' || action === 'resolve-dispute' || action === 'void';
  const canConfirm =
    action === 'adjust'
      ? adjustmentHalalas(amount) !== null
      : action === 'record-payment'
        ? reference.trim().length >= 3 && isCalendarDate(paidOn)
        : true;
  return (
    <div className="st-page" data-testid="platform-settlement">
      {back}
      <div className="st-head">
        <div className="st-head__title">
          <h1 className="pt-page-title">
            {s.org?.name_ar ?? '—'} ·{' '}
            <bdi dir="ltr" className="pt-num">
              {s.period}
            </bdi>
          </h1>
          <SettlementChip status={s.status} />
        </div>
        {actions.length ? (
          <div className="st-head__actions">
            {actions.map((a) => (
              <Button
                key={a}
                compact
                variant={a === 'void' ? 'danger' : a === 'adjust' ? 'secondary' : 'primary'}
                disabled={!online}
                onClick={() => {
                  run.reset();
                  setAction(a);
                }}
              >
                {ACTION_COPY[a].label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>

      <Card>
        <StatementBreakdown statement={s} />
      </Card>

      {s.dispute_reason || s.paid_reference || s.void_reason ? (
        <Card>
          <dl className="pt-kv">
            {s.dispute_reason ? (
              <>
                <dt>{p09.dispute}</dt>
                <dd>
                  {s.dispute_reason}
                  {s.disputed_by ? (
                    <span className="block text-sm text-text-muted">{s.disputed_by.full_name}</span>
                  ) : null}
                </dd>
              </>
            ) : null}
            {s.dispute_resolution ? (
              <>
                <dt>{p09.resolution}</dt>
                <dd>{s.dispute_resolution}</dd>
              </>
            ) : null}
            {s.paid_reference ? (
              <>
                <dt>{p09.paidRef}</dt>
                <dd>
                  <bdi dir="ltr" className="pt-num">
                    {s.paid_reference}
                  </bdi>{' '}
                  · {s.paid_on}
                </dd>
              </>
            ) : null}
            {s.void_reason ? (
              <>
                <dt>{p09.voidReason}</dt>
                <dd>{s.void_reason}</dd>
              </>
            ) : null}
          </dl>
        </Card>
      ) : null}

      {s.invoices.length ? (
        <Section title={p09.invoices}>
          <ul className="st-stack">
            {s.invoices.map((i) => (
              <li key={i.id}>
                <span>
                  <span className="font-bold">
                    {invoiceKind[i.kind]}{' '}
                    <bdi dir="ltr" className="pt-num">
                      {i.number}
                    </bdi>
                  </span>
                  <span className="block">
                    <ZatcaChip status={i.status} />
                  </span>
                </span>
                <Button variant="ghost" compact onClick={() => navigate(platformInvoicePath(i.id))}>
                  {p10.open}
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title={p09.lines}>
        {active.length ? <LinesList lines={active} /> : <EmptyState title={p09.noLines} />}
      </Section>
      {released.length ? (
        <Section title={p09.released}>
          <LinesList lines={released} />
        </Section>
      ) : null}
      {s.history?.length ? (
        <Section title={p09.history}>
          <ol className="st-stack">
            {s.history.map((h, i) => (
              <li key={`${h.action}-${i}`}>
                <span>
                  <span className="font-bold">{h.action}</span>
                  {h.reason ? <span className="block text-sm text-text-muted">{h.reason}</span> : null}
                </span>
                <span className="text-sm">{formatDateTime(h.occurred_at)}</span>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      <ReasonDialog
        id="settlement-action"
        open={action !== null}
        onOpenChange={(o) => !o && setAction(null)}
        title={action ? ACTION_COPY[action].title : ''}
        body={action ? ACTION_COPY[action].body : undefined}
        confirmLabel={action ? ACTION_COPY[action].label : undefined}
        destructive={action === 'void'}
        withReason={withReason}
        canConfirm={canConfirm}
        pending={run.pending}
        error={run.message}
        reasonError={run.fields.reason ?? null}
        onConfirm={(reason) => (action ? run.run({ action, reason }) : undefined)}
      >
        {action === 'adjust' ? (
          <TextField
            id="settlement-adjust-amount"
            label={p09.adjustAmount}
            inputMode="decimal"
            dir="ltr"
            value={amount}
            error={amount && adjustmentHalalas(amount) === null ? p09.adjustAmountInvalid : undefined}
            onChange={(e) => setAmount(e.target.value)}
          />
        ) : action === 'record-payment' ? (
          <>
            <TextField
              id="settlement-paid-reference"
              label={p09.paidRef}
              dir="ltr"
              value={reference}
              error={run.fields.reference}
              onChange={(e) => setReference(e.target.value)}
            />
            <TextField
              id="settlement-paid-on"
              type="date"
              dir="ltr"
              label={p09.paidOn}
              value={paidOn}
              onChange={(e) => setPaidOn(e.target.value)}
            />
          </>
        ) : null}
      </ReasonDialog>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ P-10

/** P-10 «الفواتير» (V2-040; DEC-548): every invoice and credit note, filters, the provider's status. */
export function PlatformInvoicesPage() {
  const me = usePlatformAccount();
  const navigate = useNavigate();
  const [form, setForm] = useState({ kind: '', status: '', number: '' });
  const [applied, setApplied] = useState<InvoiceFilters>({});
  const allowed = platformCan(me, 'platform.invoice_read');
  const list = useInfiniteQuery({
    queryKey: billingKeys.invoices(applied),
    queryFn: ({ pageParam, signal }) => billingApi.invoices(applied, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: allowed,
  });
  if (!allowed) return <Denied icon={FileText} />;
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const apply = (e: FormEvent) => {
    e.preventDefault();
    setApplied({
      kind: (form.kind || undefined) as InvoiceKind | undefined,
      status: (form.status || undefined) as ZatcaStatus | undefined,
      number: form.number.trim().toUpperCase() || undefined,
    });
  };
  return (
    <div className="st-page" data-testid="platform-invoices">
      <h1 className="pt-page-title">{p10.title}</h1>
      <Card>
        <form className="st-form" noValidate onSubmit={apply} aria-label={p10.title}>
          <div className="st-grid2">
            <Select
              id="p10-kind"
              label={p10.kind}
              value={form.kind}
              options={statusOptions(invoiceKind, p10.all)}
              onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
            />
            <Select
              id="p10-status"
              label={p10.status}
              value={form.status}
              options={statusOptions(zatcaStatus, p10.all)}
              onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
            />
            <TextField
              id="p10-number"
              dir="ltr"
              label={p10.numberSearch}
              value={form.number}
              onChange={(e) => setForm((f) => ({ ...f, number: e.target.value }))}
            />
          </div>
          <div className="st-row-actions">
            <Button type="submit" compact>
              {p10.apply}
            </Button>
          </div>
        </form>
      </Card>
      {list.isError && !list.data ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data && !rows.length ? (
        <EmptyState icon={FileText} title={p10.empty} />
      ) : (
        <DataTable
          layout="auto"
          loading={list.isPending}
          rows={rows}
          rowKey={(i) => i.id}
          hasNext={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onNext={() => void list.fetchNextPage()}
          columns={[
            {
              key: 'number',
              label: p10.kind,
              render: (i) => (
                <span>
                  <bdi dir="ltr" className="pt-num font-bold">
                    {i.number}
                  </bdi>
                  <span className="block text-sm text-text-muted">{invoiceKind[i.kind]}</span>
                </span>
              ),
            },
            { key: 'total', label: p10.total, render: (i) => <Money halalas={i.total_halalas} strong /> },
            { key: 'status', label: p10.status, render: (i) => <ZatcaChip status={i.status} /> },
            {
              key: 'buyer',
              label: p10.buyer,
              render: (i) =>
                i.org?.name_ar ?? (
                  <bdi dir="ltr" className="pt-num">
                    {i.account?.phone_masked ?? '—'}
                  </bdi>
                ),
            },
            { key: 'issued', label: p10.issued, render: (i) => formatDateTime(i.issued_at) },
            {
              key: 'open',
              label: p10.open,
              render: (i) => (
                <Button variant="secondary" compact onClick={() => navigate(platformInvoicePath(i.id))}>
                  {p10.open}
                </Button>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}

/** P-10 — one document: the seller and buyer, the lines and totals, the chain, the provider's answers, the PDF. */
export function PlatformInvoicePage() {
  const me = usePlatformAccount();
  const { invoiceId = '' } = useParams();
  const navigate = useNavigate();
  const allowed = platformCan(me, 'platform.invoice_read');
  const detail = useQuery({
    queryKey: billingKeys.invoice(invoiceId),
    queryFn: ({ signal }) => billingApi.invoice(invoiceId, signal),
    enabled: allowed,
  });
  if (!allowed) return <Denied icon={FileText} />;
  const back = (
    <Button variant="ghost" compact iconStart={ArrowRight} onClick={() => navigate(paths.platformInvoices)}>
      {p10.back}
    </Button>
  );
  if (detail.isError && !detail.data)
    return (
      <div className="st-page">
        {back}
        <QueryError error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  if (!detail.data)
    return (
      <div className="st-page" aria-busy>
        {back}
      </div>
    );
  return <InvoiceView invoice={detail.data} back={back} />;
}

export function InvoiceView({ invoice: d, back }: { invoice: InvoiceDetail; back?: ReactNode }) {
  const navigate = useNavigate();
  return (
    <div className="st-page" data-testid="invoice-detail">
      {back}
      <div className="st-head">
        <div className="st-head__title">
          <h1 className="pt-page-title">
            {invoiceKind[d.kind]}{' '}
            <bdi dir="ltr" className="pt-num">
              {d.number}
            </bdi>
          </h1>
          <ZatcaChip status={d.status} />
        </div>
        <div className="st-head__actions">
          {d.pdf_url ? (
            <a className="pt-link" href={d.pdf_url} target="_blank" rel="noreferrer noopener">
              {p10.pdf}
            </a>
          ) : (
            <span className="text-sm text-text-muted">{p10.pdfPending}</span>
          )}
        </div>
      </div>
      {d.provider === 'simulator' ? <p className="text-sm text-text-muted">{p10.simulated}</p> : null}
      <Card>
        <dl className="pt-kv">
          <dt>{p10.issued}</dt>
          <dd>{formatDateTime(d.issued_at)}</dd>
          <dt>{p10.buyer}</dt>
          <dd>{d.buyer.legal_name_ar ?? d.account?.phone_masked ?? '—'}</dd>
          <dt>{p10.subtotal}</dt>
          <dd>
            <Money halalas={d.subtotal_halalas} />
          </dd>
          <dt>{p10.vat}</dt>
          <dd>
            <Money halalas={d.vat_halalas} />
          </dd>
          <dt>{p10.total}</dt>
          <dd>
            <Money halalas={d.total_halalas} strong />
          </dd>
          {d.original ? (
            <>
              <dt>{p10.original}</dt>
              <dd>
                <bdi dir="ltr" className="pt-num">
                  {d.original.number}
                </bdi>
              </dd>
              <dt>{p10.reason}</dt>
              <dd>{d.credit_reason}</dd>
            </>
          ) : null}
          {d.provider_reference ? (
            <>
              <dt>{p10.reference}</dt>
              <dd>
                <bdi dir="ltr" className="pt-num">
                  {d.provider_reference}
                </bdi>
              </dd>
            </>
          ) : null}
          {d.provider_codes.length ? (
            <>
              <dt>{p10.codes}</dt>
              <dd>
                <bdi dir="ltr" className="pt-num">
                  {d.provider_codes.map((c) => c.code).join(', ')}
                </bdi>
              </dd>
            </>
          ) : null}
          {d.icv ? (
            <>
              <dt>{p10.series}</dt>
              <dd>{fmt(p10.chain, { icv: String(d.icv) })}</dd>
            </>
          ) : null}
        </dl>
      </Card>
      <Section title={p10.lines}>
        <ul className="st-stack">
          {d.lines.map((l, i) => (
            <li key={i}>
              <span>
                <span className="font-bold">{l.description_ar}</span>
                <span className="block text-sm text-text-muted">
                  <Money halalas={l.net_halalas} /> + <Money halalas={l.vat_halalas} />
                </span>
              </span>
              <Money halalas={l.total_halalas} strong />
            </li>
          ))}
        </ul>
      </Section>
      {d.credit_notes?.length ? (
        <Section title={p10.credits}>
          <ul className="st-stack">
            {d.credit_notes.map((c) => (
              <li key={c.id}>
                <bdi dir="ltr" className="pt-num">
                  {c.number}
                </bdi>
                <Button variant="ghost" compact onClick={() => navigate(platformInvoicePath(c.id))}>
                  {p10.open}
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {d.provider_events ? (
        <Section title={p10.events}>
          {d.provider_events.length ? (
            <ol className="st-stack">
              {d.provider_events.map((e) => (
                <li key={e.id}>
                  <span className="font-bold">
                    {e.kind} · {e.outcome}
                    {e.status ? ` · ${zatcaStatus[e.status as ZatcaStatus] ?? e.status}` : ''}
                  </span>
                  <span className="text-sm">{formatDateTime(e.occurred_at)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState title={p10.noEvents} />
          )}
        </Section>
      ) : null}
    </div>
  );
}
