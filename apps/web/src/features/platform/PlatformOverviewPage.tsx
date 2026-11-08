import { useQuery } from '@tanstack/react-query';
import { Building2, CarFront, MapPin, Repeat, Ticket } from 'lucide-react';
import { platformApi, platformKeys } from '@/api/platform';
import { Card, KpiStrip } from '@/components';
import { QueryError } from '@/features/supervisor/ui';
import { p01 } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { formatDate, formatHalalas, formatTime } from '@/lib/format';
import { usePlatformAccount } from './PlatformLayout';

/**
 * P-01 «النظرة العامة» (V2-003, docs/v2/02 §2): counts only across every operator — operators by status, venues,
 * drivers on an open duty, tickets since midnight in Riyadh, and (V2-035) the active subscribers with the MRR. Every
 * platform role sees it.
 */
export function PlatformOverviewPage() {
  const me = usePlatformAccount();
  const overview = useQuery({
    queryKey: platformKeys.overview,
    queryFn: ({ signal }) => platformApi.overview(signal),
    refetchInterval: 60_000,
  });
  const o = overview.data;
  return (
    <div className="st-page" data-testid="platform-overview">
      <h1 className="pt-page-title">{p01.overviewTitle}</h1>
      <Card>
        <p className="m-0 font-bold">{fmt(p01.welcome, { name: me.user.full_name })}</p>
        <p className="m-0 text-sm text-text-muted">{p01.role[me.user.role]}</p>
      </Card>
      {overview.isError && !o ? (
        <QueryError error={overview.error} onRetry={() => void overview.refetch()} />
      ) : (
        <KpiStrip
          loading={overview.isPending}
          items={[
            {
              label: p01.operators,
              icon: Building2,
              value: o?.operators.total ?? 0,
              meta: o
                ? fmt(p01.operatorsMeta, {
                    active: o.operators.by_status.active,
                    trial: o.operators.by_status.trial,
                    suspended: o.operators.by_status.suspended,
                  })
                : undefined,
              tone: o && o.operators.by_status.suspended > 0 ? 'warning' : undefined,
            },
            {
              label: p01.venues,
              icon: MapPin,
              value: o?.venues.total ?? 0,
              meta: o ? fmt(p01.venuesMeta, { n: o.venues.active }) : undefined,
            },
            { label: p01.driversOnDuty, icon: CarFront, value: o?.drivers_on_duty ?? 0 },
            {
              label: p01.ticketsToday,
              icon: Ticket,
              value: o?.tickets_today ?? 0,
              meta: o ? fmt(p01.dayMeta, { day: formatDate(`${o.day}T12:00:00Z`) }) : undefined,
            },
            // V2-035 (02 §2 P-01): the active subscribers and MRR
            {
              label: p01.subscribers,
              icon: Repeat,
              value: o?.subscriptions?.active ?? 0,
              meta: o?.subscriptions
                ? fmt(p01.mrrMeta, { amount: formatHalalas(o.subscriptions.mrr_halalas) })
                : undefined,
            },
          ]}
        />
      )}
      <p className="m-0 text-sm text-text-muted">
        {p01.countsOnly}
        {o ? ` ${fmt(p01.updatedAt, { time: formatTime(o.generated_at) })}` : ''}
      </p>
    </div>
  );
}
