import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  CalendarClock,
  CircleCheck,
  CirclePause,
  CircleSlash,
  Clock,
  Repeat,
  Snowflake,
  TrendingDown,
  Users,
  Wallet,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  subscriptionKeys,
  subscriptionsApi,
  type BillingCycle,
  type PlatformSubscription,
  type PlatformSubscriptionDetail,
  type SubscriptionFilters,
  type SubscriptionStatus,
} from '@/api/platformSubscriptions';
import { paths, platformSubscriptionPath } from '@/app/paths';
import { Button, Card, DataTable, EmptyState, KpiStrip, Select } from '@/components';
import { StateChip } from '@/features/common/StateChip';
import { QueryError, Section } from '@/features/supervisor/ui';
import { errorMessagesAr } from '@/i18n/errors';
import { p07 } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { formatDate, formatDateTime, formatHalalas } from '@/lib/format';
import { usePlatformAccount } from './PlatformLayout';
import { platformCan } from './platformModel';

const DAYS = 30;
const TONE: Record<SubscriptionStatus, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  pending_payment: 'info',
  active: 'success',
  past_due: 'warning',
  canceled: 'neutral',
  expired: 'danger',
  frozen: 'info',
};
const ICON = {
  pending_payment: Clock,
  active: CircleCheck,
  past_due: CirclePause,
  canceled: CircleSlash,
  expired: CircleSlash,
  frozen: Snowflake,
} as const;

/** Subscription status: text + tone + icon, never colour alone (03 §3.3). */
export function SubscriptionStatusChip({ status }: { status: SubscriptionStatus }) {
  return <StateChip label={p07.status[status]} tone={TONE[status]} icon={ICON[status]} />;
}

/** «12.50%» from basis points. */
const pct = (bp: number) => `${(bp / 100).toFixed(2)}%`;

/** The note under a subscription's state: cancel at the end, the grace, the freeze, the end. */
export function subscriptionNote(s: PlatformSubscription): string | null {
  if (s.ended_reason) return p07.endedReason[s.ended_reason] ?? s.ended_reason;
  if (s.status === 'frozen' && s.frozen_at)
    return `${fmt(p07.frozenSince, { date: formatDate(s.frozen_at) })} · ${s.frozen_reason ? p07.frozenReason[s.frozen_reason] : ''}`;
  if (s.status === 'past_due' && s.grace_ends_at)
    return fmt(p07.graceUntil, { date: formatDate(s.grace_ends_at) });
  if (s.cancel_at_period_end) return p07.cancelAtEnd;
  if (s.next_price_halalas !== null)
    return fmt(p07.nextPrice, { amount: formatHalalas(s.next_price_halalas) });
  return null;
}

type StatusFilter = '' | SubscriptionStatus;

/**
 * P-07 «الاشتراكات» (V2-035, docs/v2/02 §2; DEC-537): `platform.subscription_read` (owner and finance). The report —
 * active subscribers, MRR, the renewals due in 30 days, the churn of the last 30, the new ones, per venue — then the
 * list (status, cycle, the renewals due) with the customer masked; the table from 1024px, cards below.
 */
export function PlatformSubscriptionsPage() {
  const me = usePlatformAccount();
  const navigate = useNavigate();
  const allowed = platformCan(me, 'platform.subscription_read');
  const [status, setStatus] = useState<StatusFilter>('');
  const [cycle, setCycle] = useState<'' | BillingCycle>('');
  const [soon, setSoon] = useState(false);
  const filters: SubscriptionFilters = useMemo(
    () => ({
      ...(status ? { status } : {}),
      ...(cycle ? { billing_cycle: cycle } : {}),
      // the renewals due: the next 30 days from the moment the filter was chosen
      ...(soon ? { renews_before: new Date(Date.now() + DAYS * 86_400_000).toISOString() } : {}),
    }),
    [status, cycle, soon],
  );
  const report = useQuery({
    queryKey: subscriptionKeys.report(DAYS),
    queryFn: ({ signal }) => subscriptionsApi.report(DAYS, signal),
    enabled: allowed,
  });
  const list = useInfiniteQuery({
    queryKey: subscriptionKeys.list(filters),
    queryFn: ({ pageParam, signal }) => subscriptionsApi.list(filters, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: allowed,
  });
  if (!allowed) return <EmptyState icon={Repeat} title={errorMessagesAr.PERMISSION_DENIED} />;
  const r = report.data;
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="st-page" data-testid="platform-subscriptions">
      <h1 className="pt-page-title">{p07.title}</h1>
      {report.isError && !r ? (
        <QueryError error={report.error} onRetry={() => void report.refetch()} />
      ) : null}
      <KpiStrip
        loading={report.isPending}
        items={[
          { label: p07.active, value: r?.active_subscribers ?? 0, icon: Users },
          { label: p07.mrr, value: r ? formatHalalas(r.mrr_halalas) : '', icon: Wallet },
          {
            label: fmt(p07.renewals, { days: DAYS }),
            value: r?.renewals_due.count ?? 0,
            icon: CalendarClock,
            meta: r
              ? fmt(p07.renewalsMeta, { amount: formatHalalas(r.renewals_due.amount_halalas) })
              : undefined,
          },
          {
            label: fmt(p07.churn, { days: DAYS }),
            value: r?.churn.count ?? 0,
            icon: TrendingDown,
            meta: r ? fmt(p07.churnMeta, { rate: pct(r.churn.rate_bp) }) : undefined,
          },
          { label: fmt(p07.newSubs, { days: DAYS }), value: r?.new_subscriptions ?? 0, icon: Repeat },
        ]}
      />
      <Section title={p07.perVenue}>
        {r && !r.venues.length ? (
          <p className="m-0 text-text-muted">{p07.noVenues}</p>
        ) : (
          <DataTable
            layout="auto"
            loading={report.isPending}
            rows={r?.venues ?? []}
            rowKey={(v) => v.venue_id}
            columns={[
              {
                key: 'venue',
                label: p07.venue,
                render: (v) => <span className="font-bold">{v.venue_name_ar}</span>,
              },
              { key: 'operator', label: p07.operator, render: (v) => v.operator_name_ar },
              { key: 'active', label: p07.status.active, render: (v) => <Num n={v.active} /> },
              { key: 'frozen', label: p07.frozen, render: (v) => <Num n={v.frozen} /> },
              { key: 'past', label: p07.pastDue, render: (v) => <Num n={v.past_due} /> },
              {
                key: 'mrr',
                label: p07.mrr,
                render: (v) => (
                  <bdi dir="ltr" className="pt-num">
                    {formatHalalas(v.mrr_halalas)}
                  </bdi>
                ),
              },
            ]}
          />
        )}
      </Section>
      <Section title={p07.list}>
        <Card>
          <div className="st-form">
            <Select
              id="p07-status"
              label={p07.filters.status}
              value={status}
              options={[
                ['', p07.filters.all],
                ...(Object.keys(p07.status) as SubscriptionStatus[]).map((s) => [s, p07.status[s]] as const),
              ]}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
            />
            <Select
              id="p07-cycle"
              label={p07.filters.cycle}
              value={cycle}
              options={[
                ['', p07.filters.all],
                ['monthly', p07.cycle.monthly],
                ['yearly', p07.cycle.yearly],
              ]}
              onChange={(e) => setCycle(e.target.value as '' | BillingCycle)}
            />
            <Button variant={soon ? 'primary' : 'secondary'} compact onClick={() => setSoon(!soon)}>
              {p07.filters.renewSoon}
            </Button>
          </div>
        </Card>
        {list.isError && !list.data ? (
          <QueryError error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data && !rows.length ? (
          <EmptyState icon={Repeat} title={p07.empty} />
        ) : (
          <DataTable
            layout="auto"
            loading={list.isPending}
            rows={rows}
            rowKey={(s) => s.subscription_id}
            hasNext={list.hasNextPage}
            loadingMore={list.isFetchingNextPage}
            onNext={() => void list.fetchNextPage()}
            columns={[
              {
                key: 'customer',
                label: p07.customer,
                render: (s) => (
                  <bdi dir="ltr" className="pt-num">
                    {s.phone_masked ?? '—'}
                  </bdi>
                ),
              },
              { key: 'venue', label: p07.venue, render: (s) => s.venue_name_ar },
              {
                key: 'plan',
                label: p07.plan,
                render: (s) => `${s.plan_name_ar} · ${p07.cycle[s.billing_cycle]}`,
              },
              {
                key: 'status',
                label: p07.filters.status,
                render: (s) => (
                  <span>
                    <SubscriptionStatusChip status={s.status} />
                    {subscriptionNote(s) ? (
                      <span className="block text-sm text-text-muted">{subscriptionNote(s)}</span>
                    ) : null}
                  </span>
                ),
              },
              {
                key: 'price',
                label: p07.price,
                render: (s) => (
                  <bdi dir="ltr" className="pt-num">
                    {formatHalalas(s.price_halalas)}
                  </bdi>
                ),
              },
              {
                key: 'end',
                label: p07.periodEnd,
                render: (s) => (s.current_period_end ? formatDate(s.current_period_end) : '—'),
              },
              { key: 'visits', label: p07.visits, render: (s) => <Num n={s.visits} /> },
              {
                key: 'open',
                label: p07.open,
                render: (s) => (
                  <Button
                    variant="secondary"
                    compact
                    onClick={() => navigate(platformSubscriptionPath(s.subscription_id))}
                  >
                    {p07.open}
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Section>
    </div>
  );
}

function Num({ n }: { n: number }) {
  return (
    <bdi dir="ltr" className="pt-num">
      {n}
    </bdi>
  );
}

/** P-07 — one subscription: its periods (with the frozen days added), payments and timeline; the customer masked. */
export function PlatformSubscriptionPage() {
  const me = usePlatformAccount();
  const navigate = useNavigate();
  const { subscriptionId = '' } = useParams();
  const allowed = platformCan(me, 'platform.subscription_read');
  const one = useQuery({
    queryKey: subscriptionKeys.one(subscriptionId),
    queryFn: ({ signal }) => subscriptionsApi.one(subscriptionId, signal),
    enabled: allowed,
  });
  const back = (
    <Button
      variant="secondary"
      compact
      iconStart={ArrowRight}
      onClick={() => navigate(paths.platformSubscriptions)}
    >
      {p07.back}
    </Button>
  );
  if (!allowed) return <EmptyState icon={Repeat} title={errorMessagesAr.PERMISSION_DENIED} />;
  if (one.isError && !one.data)
    return (
      <div className="st-page">
        {back}
        <QueryError error={one.error} onRetry={() => void one.refetch()} />
      </div>
    );
  if (!one.data) return <div className="st-page">{back}</div>;
  return <SubscriptionView s={one.data} back={back} />;
}

function SubscriptionView({ s, back }: { s: PlatformSubscriptionDetail; back: ReactNode }) {
  const note = subscriptionNote(s);
  return (
    <div className="st-page" data-testid="platform-subscription">
      {back}
      <div className="st-head">
        <div className="st-head__title">
          <h1 className="pt-page-title">{s.venue_name_ar}</h1>
          <SubscriptionStatusChip status={s.status} />
        </div>
      </div>
      <Card>
        <p className="m-0 font-bold">
          {s.plan_name_ar} · {p07.cycle[s.billing_cycle]} ·{' '}
          <bdi dir="ltr" className="pt-num">
            {formatHalalas(s.price_halalas)}
          </bdi>
        </p>
        <p className="m-0 text-sm text-text-muted">
          <bdi dir="ltr" className="pt-num">
            {s.phone_masked ?? '—'}
          </bdi>{' '}
          · {s.operator_name_ar} · {fmt(p07.vehicles, { n: s.covered_vehicles })}
        </p>
        {note ? <p className="m-0 text-sm">{note}</p> : null}
      </Card>
      <Section title={p07.periods}>
        <ul className="st-list m-0 p-0">
          {s.periods.map((p) => (
            <li key={p.seq} className="list-none">
              <span className="font-bold">{fmt(p07.period, { n: p.seq })}</span>{' '}
              <bdi dir="ltr" className="pt-num">
                {formatDate(p.starts_at)} → {formatDate(p.ends_at)} · {formatHalalas(p.price_halalas)}
              </bdi>
              {p.extended_days ? (
                <span className="text-sm text-text-muted">
                  {' '}
                  · {fmt(p07.extended, { days: p.extended_days })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>
      <Section title={p07.payments}>
        <ul className="st-list m-0 p-0">
          {s.payments.map((p) => (
            <li key={p.payment_id} className="list-none">
              <bdi dir="ltr" className="pt-num">
                {formatHalalas(p.amount_halalas)}
              </bdi>{' '}
              · {p.status} · {formatDateTime(p.created_at)}
            </li>
          ))}
        </ul>
      </Section>
      <Section title={p07.timeline}>
        <ul className="st-list m-0 p-0">
          {s.timeline.map((t, i) => (
            <li key={`${t.action}-${i}`} className="list-none">
              <span className="font-bold">
                {t.to_status ? p07.status[t.to_status as SubscriptionStatus] : t.action}
              </span>{' '}
              <span className="text-sm text-text-muted">{formatDateTime(t.occurred_at)}</span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
