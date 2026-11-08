import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  BellRing,
  CircleAlert,
  CircleCheck,
  CircleX,
  CreditCard,
  Hourglass,
  RotateCcw,
  Scale,
  Undo2,
} from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  consoleApi,
  consoleKeys,
  type AlertFilters,
  type OnlinePaymentStatus,
  type PlatformAlert,
  type PlatformPaymentDetail,
  type ReconciliationStatus,
} from '@/api/platformConsole';
import {
  paths,
  platformAlertsPath,
  platformCustomerPath,
  platformPaymentPath,
  platformReconciliationPath,
} from '@/app/paths';
import { Button, Card, DataTable, EmptyState, SegmentedControl, Select, TextField } from '@/components';
import { StateChip } from '@/features/common/StateChip';
import { QueryError, ReasonDialog, Section } from '@/features/supervisor/ui';
import { useStaffCommand } from '@/features/supervisor/useStaffCommand';
import { useOnline } from '@/hooks/useOnline';
import { errorMessagesAr } from '@/i18n/errors';
import { onlinePaymentStatus, p06, p08, paymentPurpose, refundStatus } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { formatDateTime, formatHalalas } from '@/lib/format';
import { Amount } from './PlatformCustomersPage';
import { usePlatformAccount } from './PlatformLayout';
import {
  BLANK_PAYMENT_FILTERS,
  PAYMENT_TONE,
  canRefund,
  paymentFilters,
  paymentTimeline,
  refundAmount,
  type PaymentFilterForm,
} from './consoleModel';
import { platformCan, type ChipTone } from './platformModel';

const PAYMENT_ICON: Record<OnlinePaymentStatus, typeof CircleCheck> = {
  initiated: Hourglass,
  authorized: Hourglass,
  paid: CircleCheck,
  failed: CircleX,
  partially_refunded: Undo2,
  refunded: RotateCcw,
};

function PaymentStatusChip({ status }: { status: OnlinePaymentStatus }) {
  return (
    <StateChip
      label={onlinePaymentStatus[status] ?? status}
      tone={PAYMENT_TONE[status]}
      icon={PAYMENT_ICON[status]}
    />
  );
}

const RUN_TONE: Record<ReconciliationStatus, ChipTone> = {
  running: 'info',
  matched: 'success',
  mismatched: 'danger',
  failed: 'warning',
};
const SEVERITY_TONE = { info: 'info', warning: 'warning', critical: 'danger' } as const;

type Tab = 'payments' | 'reconciliation' | 'alerts';
const TAB_PATH: Record<Tab, string> = {
  payments: paths.platformPayments,
  reconciliation: platformReconciliationPath(),
  alerts: platformAlertsPath,
};

/** The P-08 frame: the title, the three sections (transactions, daily reconciliation, alerts) and the permission. */
function P08Frame({ tab, children }: { tab: Tab; children: ReactNode }) {
  const me = usePlatformAccount();
  const navigate = useNavigate();
  if (!platformCan(me, 'platform.payment_read'))
    return <EmptyState icon={CreditCard} title={errorMessagesAr.PERMISSION_DENIED} />;
  return (
    <div className="st-page" data-testid={`platform-${tab}`}>
      <h1 className="pt-page-title">{p08.title}</h1>
      <SegmentedControl
        label={p08.title}
        options={(['payments', 'reconciliation', 'alerts'] as const).map((t) => ({
          value: t,
          label: p08.tabs[t],
        }))}
        value={tab}
        onChange={(t) => navigate(TAB_PATH[t])}
      />
      {children}
    </div>
  );
}

const STATUS_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['', p08.all],
  ...(Object.keys(onlinePaymentStatus) as OnlinePaymentStatus[]).map(
    (s) => [s, onlinePaymentStatus[s]] as const,
  ),
];

/** P-08 «المعاملات»: every in-app payment, newest first, with filters (Riyadh days) and cursor paging. */
export function PlatformPaymentsPage() {
  return (
    <P08Frame tab="payments">
      <PaymentsList />
    </P08Frame>
  );
}

function PaymentsList() {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const accountId = search.get('account_id') ?? undefined;
  const [form, setForm] = useState<PaymentFilterForm>(BLANK_PAYMENT_FILTERS);
  const [applied, setApplied] = useState<PaymentFilterForm>(BLANK_PAYMENT_FILTERS);
  const [issue, setIssue] = useState<string | null>(null);
  const parsed = paymentFilters(applied, accountId ? { account_id: accountId } : {});
  const filters = parsed.ok ? parsed.filters : {};
  const list = useInfiniteQuery({
    queryKey: consoleKeys.payments(filters),
    queryFn: ({ pageParam, signal }) => consoleApi.payments(filters, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const apply = (e: FormEvent) => {
    e.preventDefault();
    const v = paymentFilters(form);
    if (!v.ok) return setIssue(v.issue === 'range' ? p08.rangeInvalid : p08.dateInvalid);
    setIssue(null);
    setApplied(form);
  };
  const set = (k: keyof PaymentFilterForm) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <>
      <Card>
        <form className="st-form" noValidate onSubmit={apply} aria-label={p08.filters}>
          <div className="st-grid2">
            <Select
              id="p08-status"
              label={p08.status}
              value={form.status}
              options={STATUS_OPTIONS}
              onChange={set('status')}
            />
            <Select
              id="p08-purpose"
              label={p08.purpose}
              value={form.purpose}
              options={[
                ['', p08.all],
                ['visit', paymentPurpose.visit],
                ['subscription', paymentPurpose.subscription],
              ]}
              onChange={set('purpose')}
            />
            <TextField
              id="p08-from"
              type="date"
              dir="ltr"
              label={p08.from}
              value={form.from}
              onChange={set('from')}
            />
            <TextField
              id="p08-to"
              type="date"
              dir="ltr"
              label={p08.to}
              value={form.to}
              error={issue ?? undefined}
              onChange={set('to')}
            />
          </div>
          <div className="st-row-actions">
            <Button type="submit" compact>
              {p08.apply}
            </Button>
            <Button
              variant="secondary"
              compact
              onClick={() => {
                setForm(BLANK_PAYMENT_FILTERS);
                setApplied(BLANK_PAYMENT_FILTERS);
                setIssue(null);
                if (accountId) navigate(paths.platformPayments);
              }}
            >
              {p08.reset}
            </Button>
          </div>
        </form>
      </Card>
      {list.isError && !list.data ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data && !rows.length ? (
        <EmptyState icon={CreditCard} title={p08.empty} />
      ) : (
        <DataTable
          layout="auto"
          loading={list.isPending}
          rows={rows}
          rowKey={(p) => p.id}
          hasNext={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onNext={() => void list.fetchNextPage()}
          columns={[
            {
              key: 'amount',
              label: p08.amount,
              render: (p) => <Amount halalas={p.amount_halalas} vat={p.vat_halalas} />,
            },
            { key: 'status', label: p08.status, render: (p) => <PaymentStatusChip status={p.status} /> },
            {
              key: 'where',
              label: p08.venue,
              render: (p) => (
                <span>
                  {p.venue?.name_ar ?? '—'}
                  <span className="block text-sm text-text-muted">
                    {[p.org?.name_ar, paymentPurpose[p.purpose]].filter(Boolean).join(' · ')}
                  </span>
                </span>
              ),
            },
            {
              key: 'customer',
              label: p08.customer,
              render: (p) => (
                <bdi dir="ltr" className="pt-num">
                  {p.account.phone_masked ?? '—'}
                </bdi>
              ),
            },
            {
              key: 'card',
              label: p08.card,
              render: (p) => (
                <bdi dir="ltr" className="pt-num">
                  {p.card_last4 ? `${p.card_brand ?? ''} •••• ${p.card_last4}` : '—'}
                </bdi>
              ),
            },
            { key: 'created', label: p08.created, render: (p) => formatDateTime(p.created_at) },
            {
              key: 'open',
              label: p08.open,
              render: (p) => (
                <Button variant="secondary" compact onClick={() => navigate(platformPaymentPath(p.id))}>
                  {p08.open}
                </Button>
              ),
            },
          ]}
        />
      )}
    </>
  );
}

/** P-08 — one payment: amounts, times, the merged timeline, refunds (issue with a reason), its alerts. */
export function PlatformPaymentPage() {
  const me = usePlatformAccount();
  const { paymentId = '' } = useParams();
  const navigate = useNavigate();
  const readable = platformCan(me, 'platform.payment_read');
  const detail = useQuery({
    queryKey: consoleKeys.payment(paymentId),
    queryFn: ({ signal }) => consoleApi.payment(paymentId, signal),
    enabled: readable,
  });
  if (!readable) return <EmptyState icon={CreditCard} title={errorMessagesAr.PERMISSION_DENIED} />;
  const back = (
    <Button variant="ghost" compact iconStart={ArrowRight} onClick={() => navigate(paths.platformPayments)}>
      {p08.back}
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
  return <PaymentView payment={detail.data} back={back} />;
}

function PaymentView({ payment: p, back }: { payment: PlatformPaymentDetail; back: ReactNode }) {
  const me = usePlatformAccount();
  const online = useOnline();
  const navigate = useNavigate();
  const [refunding, setRefunding] = useState(false);
  const [amount, setAmount] = useState('');
  const parsed = refundAmount(amount, p.refundable_halalas);
  const refund = useStaffCommand(
    (input: { reason: string; halalas: number | undefined }, key: string) =>
      consoleApi.refund(
        p.id,
        input.halalas === undefined
          ? { reason: input.reason }
          : { amount_halalas: input.halalas, reason: input.reason },
        key,
      ),
    {
      successMessage: p08.refundDone,
      invalidate: [consoleKeys.payment(p.id), ['platform', 'payments']],
      onSuccess: () => {
        setRefunding(false);
        setAmount('');
      },
    },
  );
  const timeline = paymentTimeline(p);
  const times = (['created_at', 'authorized_at', 'paid_at', 'failed_at', 'refunded_at'] as const).filter(
    (k) => p[k],
  );
  return (
    <div className="st-page" data-testid="platform-payment">
      {back}
      <div className="st-head">
        <div className="st-head__title">
          <h1 className="pt-page-title">
            <bdi dir="ltr" className="pt-num">
              {formatHalalas(p.amount_halalas)}
            </bdi>
          </h1>
          <PaymentStatusChip status={p.status} />
        </div>
        {canRefund(me, p) ? (
          <div className="st-head__actions">
            <Button
              compact
              variant="danger"
              iconStart={Undo2}
              disabled={!online}
              onClick={() => {
                refund.reset();
                setAmount('');
                setRefunding(true);
              }}
            >
              {p08.refund}
            </Button>
          </div>
        ) : null}
      </div>

      <Card>
        <dl className="pt-kv">
          <dt>{p08.amount}</dt>
          <dd>
            <Amount halalas={p.amount_halalas} vat={p.vat_halalas} />
          </dd>
          <dt>{p08.refunded}</dt>
          <dd>
            <bdi dir="ltr" className="pt-num">
              {formatHalalas(p.refunded_halalas)}
            </bdi>
          </dd>
          <dt>{p08.refundable}</dt>
          <dd>
            <bdi dir="ltr" className="pt-num font-bold">
              {formatHalalas(p.refundable_halalas)}
            </bdi>
            {p.refund_pending_halalas ? (
              <span className="block text-sm text-text-muted">
                {fmt(p08.pending, { amount: formatHalalas(p.refund_pending_halalas) })}
              </span>
            ) : null}
          </dd>
          <dt>{p08.purpose}</dt>
          <dd>{paymentPurpose[p.purpose]}</dd>
          <dt>{p08.venue}</dt>
          <dd>{[p.venue?.name_ar, p.org?.name_ar].filter(Boolean).join(' · ') || '—'}</dd>
          <dt>{p08.customer}</dt>
          <dd>
            <bdi dir="ltr" className="pt-num">
              {p.account.phone_masked ?? '—'}
            </bdi>
            {platformCan(me, 'platform.customer_read') ? (
              <Button variant="ghost" compact onClick={() => navigate(platformCustomerPath(p.account.id))}>
                {p06.open}
              </Button>
            ) : null}
          </dd>
          <dt>{p08.card}</dt>
          <dd>
            <bdi dir="ltr" className="pt-num">
              {p.card_last4 ? `${p.card_brand ?? ''} •••• ${p.card_last4}` : '—'}
            </bdi>
          </dd>
          <dt>{p08.gatewayId}</dt>
          <dd>
            <bdi dir="ltr" className="pt-num">
              {p.gateway_payment_id ?? '—'}
            </bdi>
          </dd>
          {p.failure_code ? (
            <>
              <dt>{p08.failure}</dt>
              <dd>
                <bdi dir="ltr" className="pt-num">
                  {p.failure_code}
                </bdi>
              </dd>
            </>
          ) : null}
          {times.map((k) => (
            <TimeFact key={k} label={p08.time[k]} at={p[k]!} />
          ))}
        </dl>
      </Card>

      <Section title={p08.refunds}>
        {p.refunds.length ? (
          <ul className="st-stack">
            {p.refunds.map((r) => (
              <li key={r.id}>
                <span>
                  <span className="font-bold">
                    {fmt(p08.refundLine, {
                      amount: formatHalalas(r.amount_halalas),
                      status: refundStatus[r.status],
                      actor: r.issued_by.full_name ?? '—',
                    })}
                  </span>
                  <span className="block text-sm text-text-muted">{r.reason}</span>
                </span>
                <span className="text-sm">{formatDateTime(r.completed_at ?? r.created_at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={p08.noRefunds} />
        )}
      </Section>

      <Section title={p08.timeline}>
        {timeline.length ? (
          <ol className="st-stack">
            {timeline.map((e, i) => (
              <li key={`${e.kind}-${e.at}-${i}`}>
                <span>
                  <span className="font-bold">
                    {e.kind === 'status'
                      ? ((p08.historyAction as Record<string, string>)[e.action] ?? e.action)
                      : e.kind === 'webhook'
                        ? fmt(p08.webhook, { type: e.type })
                        : fmt(p08.refundLine, {
                            amount: formatHalalas(e.refund.amount_halalas),
                            status: refundStatus[e.refund.status],
                            actor: e.refund.issued_by.full_name ?? '—',
                          })}
                  </span>
                  {e.kind === 'webhook' ? (
                    <span className="block text-sm text-text-muted">
                      {[
                        (p08.outcome as Record<string, string>)[e.outcome ?? 'pending'] ?? e.outcome,
                        e.claimed.status || e.claimed.amount_halalas !== null
                          ? fmt(p08.webhookClaim, {
                              status: e.claimed.status ?? '—',
                              amount:
                                e.claimed.amount_halalas !== null
                                  ? formatHalalas(e.claimed.amount_halalas)
                                  : '—',
                            })
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  ) : null}
                </span>
                <span className="text-sm">{formatDateTime(e.at)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <EmptyState title={p08.noTimeline} />
        )}
      </Section>

      {p.alerts.length ? (
        <Section title={p08.alerts}>
          <AlertsList alerts={p.alerts} />
        </Section>
      ) : null}

      <ReasonDialog
        id="payment-refund"
        open={refunding}
        onOpenChange={setRefunding}
        title={p08.refundTitle}
        body={fmt(p08.refundBody, { amount: formatHalalas(p.refundable_halalas) })}
        confirmLabel={p08.refund}
        destructive
        canConfirm={parsed.ok}
        pending={refund.pending}
        error={refund.fields.amount_halalas ?? refund.message}
        reasonError={refund.fields.reason ?? null}
        onConfirm={(reason) => (parsed.ok ? refund.run({ reason, halalas: parsed.halalas }) : undefined)}
      >
        <TextField
          id="payment-refund-amount"
          label={p08.refundAmount}
          inputMode="decimal"
          dir="ltr"
          value={amount}
          error={parsed.ok ? undefined : p08.refundAmountInvalid}
          onChange={(e) => setAmount(e.target.value)}
        />
      </ReasonDialog>
    </div>
  );
}

function TimeFact({ label, at }: { label: string; at: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{formatDateTime(at)}</dd>
    </>
  );
}

/** P-08 «المطابقة اليومية»: the daily runs, the latest first. */
export function PlatformReconciliationPage() {
  return (
    <P08Frame tab="reconciliation">
      <RunsList />
    </P08Frame>
  );
}

function RunsList() {
  const navigate = useNavigate();
  const list = useInfiniteQuery({
    queryKey: consoleKeys.runs({}),
    queryFn: ({ pageParam, signal }) => consoleApi.runs({}, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  if (list.isError && !list.data)
    return <QueryError error={list.error} onRetry={() => void list.refetch()} />;
  if (list.data && !rows.length) return <EmptyState icon={Scale} title={p08.runs.empty} />;
  return (
    <DataTable
      layout="auto"
      loading={list.isPending}
      rows={rows}
      rowKey={(r) => r.id}
      hasNext={list.hasNextPage}
      loadingMore={list.isFetchingNextPage}
      onNext={() => void list.fetchNextPage()}
      columns={[
        {
          key: 'day',
          label: p08.runs.day,
          render: (r) => (
            <bdi dir="ltr" className="pt-num font-bold">
              {r.run_date}
            </bdi>
          ),
        },
        {
          key: 'state',
          label: p08.runs.state,
          render: (r) => (
            <StateChip
              label={p08.runs.status[r.status]}
              tone={RUN_TONE[r.status]}
              icon={r.status === 'matched' ? CircleCheck : CircleAlert}
            />
          ),
        },
        {
          key: 'counts',
          label: p08.runs.counts,
          render: (r) => (
            <bdi dir="ltr" className="pt-num">
              {r.gateway_count ?? '—'} / {r.local_count ?? '—'}
            </bdi>
          ),
        },
        {
          key: 'mismatches',
          label: p08.runs.mismatches,
          render: (r) => (
            <bdi dir="ltr" className="pt-num">
              {r.mismatch_count ?? '—'}
            </bdi>
          ),
        },
        {
          key: 'net',
          label: p08.runs.net,
          render: (r) =>
            r.gateway_paid_halalas !== null && r.local_paid_halalas !== null ? (
              <bdi dir="ltr" className="pt-num">
                {formatHalalas(r.gateway_paid_halalas)} / {formatHalalas(r.local_paid_halalas)}
              </bdi>
            ) : (
              (r.failure_reason ?? '—')
            ),
        },
        { key: 'started', label: p08.runs.started, render: (r) => formatDateTime(r.started_at) },
        {
          key: 'open',
          label: p08.runs.open,
          render: (r) => (
            <Button variant="secondary" compact onClick={() => navigate(platformReconciliationPath(r.id))}>
              {p08.runs.open}
            </Button>
          ),
        },
      ]}
    />
  );
}

/** P-08 — one reconciliation run and its mismatches, each linking to its payment when POINT has one. */
export function PlatformReconciliationRunPage() {
  return (
    <P08Frame tab="reconciliation">
      <RunDetail />
    </P08Frame>
  );
}

function RunDetail() {
  const { runId = '' } = useParams();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: consoleKeys.run(runId),
    queryFn: ({ signal }) => consoleApi.run(runId, signal),
  });
  const back = (
    <Button
      variant="ghost"
      compact
      iconStart={ArrowRight}
      onClick={() => navigate(platformReconciliationPath())}
    >
      {p08.tabs.reconciliation}
    </Button>
  );
  if (q.isError && !q.data)
    return (
      <>
        {back}
        <QueryError error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  if (!q.data) return back;
  const r = q.data;
  return (
    <>
      {back}
      <Section
        title={
          <span className="st-row-actions">
            <bdi>{fmt(p08.runs.title, { day: r.run_date })}</bdi>
            <StateChip label={p08.runs.status[r.status]} tone={RUN_TONE[r.status]} icon={CircleAlert} />
          </span>
        }
      >
        <dl className="pt-kv">
          <dt>{p08.runs.counts}</dt>
          <dd>
            <bdi dir="ltr" className="pt-num">
              {r.gateway_count ?? '—'} / {r.local_count ?? '—'}
            </bdi>
          </dd>
          <dt>{p08.runs.net}</dt>
          <dd>
            <bdi dir="ltr" className="pt-num">
              {r.gateway_paid_halalas !== null ? formatHalalas(r.gateway_paid_halalas) : '—'} /{' '}
              {r.local_paid_halalas !== null ? formatHalalas(r.local_paid_halalas) : '—'}
            </bdi>
          </dd>
          <dt>{p08.runs.started}</dt>
          <dd>{formatDateTime(r.started_at)}</dd>
          {r.failure_reason ? (
            <>
              <dt>{p08.runs.failure}</dt>
              <dd>
                <bdi dir="ltr">{r.failure_reason}</bdi>
              </dd>
            </>
          ) : null}
        </dl>
      </Section>
      <Section title={p08.runs.mismatches}>
        {r.mismatches.length ? (
          <ul className="st-stack">
            {r.mismatches.map((m, i) => (
              <li key={`${m.online_payment_id ?? m.gateway_payment_id ?? ''}-${i}`}>
                <span>
                  <span className="font-bold">{m.kind ? p08.runs.kind[m.kind] : '—'}</span>
                  <span className="block text-sm text-text-muted">
                    {[
                      m.point_status || m.point_amount_halalas !== null
                        ? `${p08.runs.point}: ${[m.point_status, m.point_amount_halalas !== null ? formatHalalas(m.point_amount_halalas) : null].filter(Boolean).join(' · ')}`
                        : null,
                      m.gateway_status || m.gateway_amount_halalas !== null
                        ? `${p08.runs.gateway}: ${[m.gateway_status, m.gateway_amount_halalas !== null ? formatHalalas(m.gateway_amount_halalas) : null].filter(Boolean).join(' · ')}`
                        : null,
                      m.synced ? p08.runs.synced : null,
                    ]
                      .filter(Boolean)
                      .join(' — ')}
                  </span>
                  {m.gateway_payment_id ? (
                    <bdi dir="ltr" className="pt-num block text-sm">
                      {m.gateway_payment_id}
                    </bdi>
                  ) : null}
                </span>
                {m.online_payment_id ? (
                  <Button
                    variant="secondary"
                    compact
                    onClick={() => navigate(platformPaymentPath(m.online_payment_id!))}
                  >
                    {p08.open}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={p08.runs.noMismatches} />
        )}
      </Section>
    </>
  );
}

/** P-08 «التنبيهات»: the platform's finance alerts (open by default) and their resolution with a note. */
export function PlatformAlertsPage() {
  return (
    <P08Frame tab="alerts">
      <AlertsTab />
    </P08Frame>
  );
}

function AlertsTab() {
  const [status, setStatus] = useState<AlertFilters['status']>('open');
  const filters: AlertFilters = { status };
  const list = useInfiniteQuery({
    queryKey: consoleKeys.alerts(filters),
    queryFn: ({ pageParam, signal }) => consoleApi.alerts(filters, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <SegmentedControl
        label={p08.tabs.alerts}
        options={(['open', 'resolved', 'all'] as const).map((s) => ({
          value: s,
          label: p08.alertsTab.filters[s],
        }))}
        value={status}
        onChange={setStatus}
      />
      {list.isError && !list.data ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data && !rows.length ? (
        <EmptyState icon={BellRing} title={p08.alertsTab.empty} />
      ) : (
        <AlertsList alerts={rows} />
      )}
      {list.hasNextPage ? (
        <Button
          variant="secondary"
          loading={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {p08.loadMore}
        </Button>
      ) : null}
    </>
  );
}

function AlertsList({ alerts }: { alerts: PlatformAlert[] }) {
  const navigate = useNavigate();
  const location = useLocation();
  const online = useOnline();
  const [resolving, setResolving] = useState<PlatformAlert | null>(null);
  const resolve = useStaffCommand(
    (input: { id: string; note: string }, key: string) => consoleApi.resolveAlert(input.id, input.note, key),
    {
      successMessage: p08.alertsTab.resolveDone,
      invalidate: [
        ['platform', 'alerts'],
        ['platform', 'payment'],
      ],
      onSuccess: () => setResolving(null),
    },
  );
  const onPayment =
    location.pathname.startsWith(`${paths.platformPayments}/`) && !location.pathname.includes('/alerts');
  return (
    <>
      <ul className="st-stack" data-testid="platform-alerts-list">
        {alerts.map((a) => (
          <li key={a.id}>
            <span>
              <span className="st-row-actions">
                <StateChip
                  label={p08.alertsTab.severity[a.severity]}
                  tone={SEVERITY_TONE[a.severity]}
                  icon={a.status === 'resolved' ? CircleCheck : CircleAlert}
                />
                <span className="font-bold">{p08.alertsTab.type[a.type] ?? a.type}</span>
              </span>
              <span className="block text-sm text-text-muted">
                {[
                  fmt(p08.alertsTab.raised, { time: formatDateTime(a.raised_at) }),
                  a.occurrences > 1 ? fmt(p08.alertsTab.occurrences, { n: a.occurrences }) : null,
                  a.resolved_at
                    ? fmt(p08.alertsTab.resolved, {
                        time: formatDateTime(a.resolved_at),
                        actor: a.resolved_by?.full_name ?? '—',
                      })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {a.resolution_note ? <span className="block text-sm">{a.resolution_note}</span> : null}
            </span>
            <span className="st-row-actions">
              {a.online_payment_id && !onPayment ? (
                <Button
                  variant="secondary"
                  compact
                  onClick={() => navigate(platformPaymentPath(a.online_payment_id!))}
                >
                  {p08.alertsTab.payment}
                </Button>
              ) : null}
              {a.status !== 'resolved' ? (
                <Button
                  compact
                  disabled={!online}
                  onClick={() => {
                    resolve.reset();
                    setResolving(a);
                  }}
                >
                  {p08.alertsTab.resolve}
                </Button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <ReasonDialog
        id="alert-resolve"
        open={resolving !== null}
        onOpenChange={(o) => (o ? undefined : setResolving(null))}
        title={p08.alertsTab.resolveTitle}
        body={p08.alertsTab.resolveBody}
        confirmLabel={p08.alertsTab.resolve}
        pending={resolve.pending}
        error={resolve.message}
        reasonError={resolve.fields.note ?? null}
        onConfirm={(note) => (resolving ? resolve.run({ id: resolving.id, note }) : undefined)}
      />
    </>
  );
}
