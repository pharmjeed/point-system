import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { CircleCheck, CirclePause, Plus, Search, Tags } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import {
  subscriptionKeys,
  subscriptionsApi,
  type PlanPolicies,
  type PlanVenue,
  type PlatformPlan,
  type VenueClosure,
} from '@/api/platformSubscriptions';
import { setVenuePricing } from '@/api/venueProfile';
import { Button, Card, DataTable, EmptyState, Select, TextField } from '@/components';
import { StateChip } from '@/features/common/StateChip';
import { QueryError, ReasonDialog } from '@/features/supervisor/ui';
import { useStaffCommand } from '@/features/supervisor/useStaffCommand';
import { formatSar, parseSar } from '@/features/venues/profileModel';
import { useOnline } from '@/hooks/useOnline';
import { errorMessagesAr } from '@/i18n/errors';
import { p05 } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { formatHalalas } from '@/lib/format';
import { usePlatformAccount } from './PlatformLayout';
import { platformCan } from './platformModel';

const price = (h: number | null) => (h === null ? '—' : formatHalalas(h));

/** The plan form's state: SAR texts as typed, validated into halalas (≥ 1.00, one cycle at least). */
interface PlanDraft {
  name: string;
  vehicles: string;
  monthly: string;
  yearly: string;
  // V2-036 (DEC-590): the policies, the V4 behaviour by default
  term: 'calendar' | 'service_days';
  serviceDays: string;
  weekdays: 'sun_thu' | 'all';
  renewal: 'auto' | 'manual';
  daily: string;
  refund: 'prorated_on_termination' | 'non_refundable';
  closure: 'freeze' | 'continue';
  freezeDays: string;
  eligibility: 'none' | 'student_id_review';
  capacity: string;
  audience: string;
  vehicleChange: 'once_per_period' | 'any_time';
}
const EMPTY: PlanDraft = {
  name: '',
  vehicles: '1',
  monthly: '',
  yearly: '',
  term: 'calendar',
  serviceDays: '22',
  weekdays: 'sun_thu',
  renewal: 'auto',
  daily: '',
  refund: 'prorated_on_termination',
  closure: 'freeze',
  freezeDays: '0',
  eligibility: 'none',
  capacity: '',
  audience: '',
  vehicleChange: 'once_per_period',
};

/** A counted-day term (the student plan of the subscriptions annex): its defaults when chosen. */
const COUNTED: Partial<PlanDraft> = {
  term: 'service_days',
  serviceDays: '22',
  weekdays: 'sun_thu',
  renewal: 'manual',
  daily: '1',
  refund: 'non_refundable',
  closure: 'continue',
  freezeDays: '5',
  eligibility: 'student_id_review',
  vehicleChange: 'any_time',
  yearly: '',
};

const int = (v: string, min: number, max: number) => {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= min && n <= max ? n : ('invalid' as const);
};

/** The policies the form sends (DEC-590): a calendar plan sends only what differs from V4. */
export function planPolicies(d: PlanDraft): Partial<PlanPolicies> {
  const counted = d.term === 'service_days';
  const freeze = counted ? int(d.freezeDays, 0, 30) : 0;
  const daily = int(d.daily, 1, 10);
  const capacity = int(d.capacity, 1, 100_000);
  return {
    term_kind: d.term,
    ...(counted
      ? {
          service_days: int(d.serviceDays, 1, 60) as number,
          service_weekdays: d.weekdays === 'all' ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4],
          renewal_mode: 'manual' as const,
        }
      : { renewal_mode: d.renewal }),
    daily_visit_limit: typeof daily === 'number' ? daily : null,
    refund_policy: d.refund,
    closure_policy: d.closure,
    freeze_max_times: typeof freeze === 'number' && freeze > 0 ? 1 : 0,
    ...(typeof freeze === 'number' && freeze > 0 ? { freeze_max_days: freeze } : {}),
    eligibility: d.eligibility,
    capacity: typeof capacity === 'number' ? capacity : null,
    ...(d.audience.trim().length >= 2 ? { audience_ar: d.audience.trim() } : {}),
    vehicle_change: d.vehicleChange,
  };
}

/** The policy cells' issues (whole numbers within the server's bounds). */
export function policyIssues(d: PlanDraft): {
  serviceDays?: string;
  daily?: string;
  freeze?: string;
  capacity?: string;
} {
  const out: { serviceDays?: string; daily?: string; freeze?: string; capacity?: string } = {};
  if (d.term === 'service_days') {
    const sd = int(d.serviceDays, 1, 60);
    if (sd === null || sd === 'invalid') out.serviceDays = p05.annex.number;
    if (int(d.freezeDays, 0, 30) === 'invalid') out.freeze = p05.annex.number;
  }
  if (int(d.daily, 1, 10) === 'invalid') out.daily = p05.annex.number;
  if (int(d.capacity, 1, 100_000) === 'invalid') out.capacity = p05.annex.number;
  return out;
}

/** One line of a plan's policies on P-05 (only what differs from V4). */
export function policySummary(p: PlatformPlan): string {
  const a = p05.annex;
  const parts: string[] = [];
  if (p.term_kind === 'service_days' && p.service_days)
    parts.push(fmt(a.summaryCounted, { days: p.service_days }));
  if (p.renewal_mode === 'manual') parts.push(a.summaryManual);
  if (p.refund_policy === 'non_refundable') parts.push(a.summaryNoRefund);
  if (p.daily_visit_limit) parts.push(fmt(a.summaryDaily, { n: p.daily_visit_limit }));
  if (p.freeze_max_times > 0 && p.freeze_max_days)
    parts.push(fmt(a.summaryFreeze, { days: p.freeze_max_days }));
  if (p.eligibility !== 'none') parts.push(a.summaryEligibility);
  if (p.closure_policy === 'continue') parts.push(a.summaryContinue);
  if (p.capacity != null) parts.push(fmt(a.seats, { taken: p.seats_taken, capacity: p.capacity }));
  return parts.join(' · ') || '—';
}

export function planDraftIssues(d: PlanDraft): { monthly?: string; yearly?: string; price?: string } {
  const m = parseSar(d.monthly);
  const y = parseSar(d.yearly);
  const out: { monthly?: string; yearly?: string; price?: string } = {};
  if (m === 'invalid' || (typeof m === 'number' && m < 100)) out.monthly = p05.form.number;
  if (y === 'invalid' || (typeof y === 'number' && y < 100)) out.yearly = p05.form.number;
  if (m === null && y === null) out.price = p05.form.noPrice;
  return out;
}

/**
 * P-05 «باقات الاشتراك» (V2-030, docs/v2/02 §2; DEC-531): `platform.plan_manage` (owner and finance). Each venue with a
 * public profile: its subscription switch (P-04's pricing command, a hall never sells), its plans with their monthly
 * and yearly prices (VAT included) and live subscribers, a new plan, a price change (a new plan replacing the old one
 * with a reason) and a plan taken off sale.
 */
export function PlatformPlansPage() {
  const me = usePlatformAccount();
  const allowed = platformCan(me, 'platform.plan_manage');
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const list = useInfiniteQuery({
    queryKey: subscriptionKeys.plans(q),
    queryFn: ({ pageParam, signal }) => subscriptionsApi.plans(q, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: allowed,
  });
  if (!allowed) return <EmptyState icon={Tags} title={errorMessagesAr.PERMISSION_DENIED} />;
  const venues = list.data?.pages.flatMap((p) => p.items) ?? [];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setQ(input.trim());
  };
  return (
    <div className="st-page" data-testid="platform-plans">
      <h1 className="pt-page-title">{p05.title}</h1>
      <p className="m-0 text-text-muted">{p05.intro}</p>
      <Card>
        <form className="st-form" noValidate role="search" onSubmit={submit}>
          <TextField
            id="p05-search"
            label={p05.search}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <div className="st-row-actions">
            <Button type="submit" compact iconStart={Search}>
              {p05.searchAction}
            </Button>
          </div>
        </form>
      </Card>
      {list.isError && !list.data ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data && !venues.length ? (
        <EmptyState icon={Tags} title={p05.empty} />
      ) : (
        venues.map((v) => <VenuePlans key={v.venue_id} venue={v} q={q} />)
      )}
      {list.hasNextPage ? (
        <Button
          variant="secondary"
          loading={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {p05.searchAction}
        </Button>
      ) : null}
    </div>
  );
}

function VenuePlans({ venue: v, q }: { venue: PlanVenue; q: string }) {
  const online = useOnline();
  const [form, setForm] = useState<{ replaces: PlatformPlan | null } | null>(null);
  const [retiring, setRetiring] = useState<PlatformPlan | null>(null);
  const invalidate = [subscriptionKeys.plans(q), ['platform', 'plans']];
  const toggle = useStaffCommand(
    (enabled: boolean, key: string) =>
      setVenuePricing(
        v.venue_id,
        {
          expected_version: v.profile_version,
          subscriptions_enabled: enabled,
          pay_per_visit_halalas: v.pay_per_visit_halalas,
        },
        key,
      ),
    { successMessage: p05.done.pricing, invalidate },
  );
  const retire = useStaffCommand(
    (input: { planId: string; reason: string }, key: string) =>
      subscriptionsApi.retirePlan(input.planId, input.reason, key),
    { successMessage: p05.done.retired, invalidate, onSuccess: () => setRetiring(null) },
  );
  return (
    <Card>
      <div className="st-head" data-testid={`p05-venue-${v.venue_id}`}>
        <div className="st-head__title">
          <h2 className="m-0 font-bold">{v.name_ar}</h2>
          <StateChip
            label={v.subscriptions_enabled ? p05.selling : p05.notSelling}
            tone={v.subscriptions_enabled ? 'success' : 'neutral'}
            icon={v.subscriptions_enabled ? CircleCheck : CirclePause}
          />
        </div>
        <div className="st-head__actions">
          {v.subscriptions_allowed ? (
            <Button
              variant="secondary"
              compact
              loading={toggle.pending}
              disabled={!online}
              onClick={() => void toggle.run(!v.subscriptions_enabled)}
            >
              {v.subscriptions_enabled ? p05.disable : p05.enable}
            </Button>
          ) : null}
          {v.subscriptions_enabled ? (
            <Button compact iconStart={Plus} disabled={!online} onClick={() => setForm({ replaces: null })}>
              {p05.newPlan}
            </Button>
          ) : null}
        </div>
      </div>
      <p className="m-0 text-sm text-text-muted">{fmt(p05.operator, { name: v.operator_name_ar })}</p>
      {!v.subscriptions_allowed ? <p className="m-0 text-sm text-text-muted">{p05.hall}</p> : null}
      {toggle.message ? <p className="m-0 text-danger">{toggle.message}</p> : null}
      {v.plans.length ? (
        <DataTable
          layout="auto"
          rows={v.plans}
          rowKey={(p) => p.plan_id}
          columns={[
            { key: 'name', label: p05.plan, render: (p) => <span className="font-bold">{p.name_ar}</span> },
            {
              key: 'vehicles',
              label: p05.vehicles,
              render: (p) => fmt(p05.vehiclesCount, { n: p.vehicles_included }),
            },
            {
              key: 'monthly',
              label: p05.monthly,
              render: (p) => (
                <bdi dir="ltr" className="pt-num">
                  {price(p.monthly_price_halalas)}
                </bdi>
              ),
            },
            {
              key: 'yearly',
              label: p05.yearly,
              render: (p) => (
                <bdi dir="ltr" className="pt-num">
                  {price(p.yearly_price_halalas)}
                </bdi>
              ),
            },
            {
              key: 'policies',
              label: p05.annex.policies,
              render: (p) => <span className="text-sm">{policySummary(p)}</span>,
            },
            {
              key: 'status',
              label: p05.status,
              render: (p) => (
                <StateChip
                  label={p05.statusLabel[p.status]}
                  tone={p.status === 'active' ? 'success' : 'neutral'}
                  icon={p.status === 'active' ? CircleCheck : CirclePause}
                />
              ),
            },
            {
              key: 'subs',
              label: p05.subscribers,
              render: (p) => (
                <bdi dir="ltr" className="pt-num">
                  {p.live_subscriptions}
                </bdi>
              ),
            },
            {
              key: 'actions',
              label: '',
              render: (p) =>
                p.status === 'active' ? (
                  <div className="st-row-actions">
                    <Button
                      variant="secondary"
                      compact
                      disabled={!online}
                      onClick={() => setForm({ replaces: p })}
                    >
                      {p05.changePrice}
                    </Button>
                    <Button variant="secondary" compact disabled={!online} onClick={() => setRetiring(p)}>
                      {p05.retire}
                    </Button>
                  </div>
                ) : null,
            },
          ]}
        />
      ) : (
        <p className="m-0 text-text-muted">{p05.noPlans}</p>
      )}
      {v.subscriptions_enabled ? <VenueClosures venue={v} /> : null}
      {v.plans.some((p) => p.status === 'active' && p.eligibility === 'student_id_review') ? (
        <EligibleList venue={v} />
      ) : null}
      {form ? (
        <PlanFormDialog
          venue={v}
          replaces={form.replaces}
          invalidate={invalidate}
          onClose={() => setForm(null)}
        />
      ) : null}
      <ReasonDialog
        id="p05-retire"
        open={!!retiring}
        onOpenChange={(o) => {
          if (!o) setRetiring(null);
        }}
        title={fmt(p05.retireTitle, { plan: retiring?.name_ar ?? '' })}
        body={p05.retireBody}
        confirmLabel={p05.retire}
        destructive
        pending={retire.pending}
        reasonError={retire.fields.reason ?? null}
        error={retire.message}
        onConfirm={(reason) => (retiring ? retire.run({ planId: retiring.plan_id, reason }) : undefined)}
      />
    </Card>
  );
}

function PlanFormDialog({
  venue,
  replaces,
  invalidate,
  onClose,
}: {
  venue: PlanVenue;
  replaces: PlatformPlan | null;
  invalidate: readonly (readonly unknown[])[];
  onClose: () => void;
}) {
  const [d, setD] = useState<PlanDraft>(
    replaces
      ? {
          name: replaces.name_ar,
          vehicles: String(replaces.vehicles_included),
          monthly: replaces.monthly_price_halalas ? formatSar(replaces.monthly_price_halalas) : '',
          yearly: replaces.yearly_price_halalas ? formatSar(replaces.yearly_price_halalas) : '',
          term: replaces.term_kind ?? EMPTY.term,
          serviceDays: String(replaces.service_days ?? 22),
          weekdays: (replaces.service_weekdays?.length ?? 5) === 7 ? 'all' : 'sun_thu',
          renewal: replaces.renewal_mode ?? EMPTY.renewal,
          daily: replaces.daily_visit_limit ? String(replaces.daily_visit_limit) : '',
          refund: replaces.refund_policy ?? EMPTY.refund,
          closure: replaces.closure_policy ?? EMPTY.closure,
          freezeDays: String(replaces.freeze_max_days ?? 0),
          eligibility: replaces.eligibility ?? EMPTY.eligibility,
          capacity: replaces.capacity ? String(replaces.capacity) : '',
          audience: replaces.audience_ar ?? '',
          vehicleChange: replaces.vehicle_change ?? EMPTY.vehicleChange,
        }
      : EMPTY,
  );
  const issues = planDraftIssues(d);
  const pIssues = policyIssues(d);
  const save = useStaffCommand(
    (reason: string, key: string) => {
      const m = parseSar(d.monthly);
      const y = parseSar(d.yearly);
      return subscriptionsApi.createPlan(
        {
          venue_id: venue.venue_id,
          name_ar: d.name.trim(),
          vehicles_included: Number(d.vehicles),
          monthly_price_halalas: typeof m === 'number' ? m : null,
          yearly_price_halalas: typeof y === 'number' ? y : null,
          ...(replaces ? { replaces_plan_id: replaces.plan_id, reason } : {}),
          policies: planPolicies(d),
        },
        key,
      );
    },
    { successMessage: p05.done.created, invalidate: [...invalidate], onSuccess: onClose },
  );
  const valid =
    d.name.trim().length >= 2 &&
    !issues.monthly &&
    !issues.yearly &&
    !issues.price &&
    !Object.keys(pIssues).length &&
    (d.term === 'calendar' || !d.yearly.trim());
  const counted = d.term === 'service_days';
  return (
    <ReasonDialog
      id="p05-plan"
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={
        replaces
          ? fmt(p05.form.changeTitle, { plan: replaces.name_ar })
          : fmt(p05.form.title, { venue: venue.name_ar })
      }
      body={replaces ? p05.form.changeNote : undefined}
      confirmLabel={p05.form.save}
      withReason={!!replaces}
      canConfirm={valid}
      pending={save.pending}
      reasonError={save.fields.reason ?? null}
      error={save.message}
      onConfirm={(reason) => save.run(reason)}
    >
      <div className="st-form">
        <TextField
          id="p05-name"
          label={p05.form.name}
          value={d.name}
          error={save.fields.name_ar}
          onChange={(e) => setD({ ...d, name: e.target.value })}
        />
        <Select
          id="p05-vehicles"
          label={p05.form.vehicles}
          value={d.vehicles}
          options={['1', '2', '3', '4', '5'].map((n) => [n, n] as const)}
          onChange={(e) => setD({ ...d, vehicles: e.target.value })}
        />
        <TextField
          id="p05-monthly"
          label={p05.form.monthly}
          hint={p05.form.priceHint}
          inputMode="decimal"
          dir="ltr"
          value={d.monthly}
          error={issues.monthly ?? issues.price}
          onChange={(e) => setD({ ...d, monthly: e.target.value })}
        />
        <TextField
          id="p05-yearly"
          label={p05.form.yearly}
          hint={p05.form.priceHint}
          inputMode="decimal"
          dir="ltr"
          value={d.yearly}
          error={issues.yearly}
          disabled={counted}
          onChange={(e) => setD({ ...d, yearly: e.target.value })}
        />
        <Select
          id="p05-term"
          label={p05.annex.kind}
          value={d.term}
          options={[
            ['calendar', p05.annex.kindCalendar],
            ['service_days', p05.annex.kindCounted],
          ]}
          onChange={(e) =>
            setD(
              e.target.value === 'service_days'
                ? { ...d, ...COUNTED }
                : {
                    ...d,
                    ...EMPTY,
                    name: d.name,
                    monthly: d.monthly,
                    yearly: d.yearly,
                    vehicles: d.vehicles,
                  },
            )
          }
        />
        {counted ? (
          <>
            <TextField
              id="p05-service-days"
              label={p05.annex.serviceDays}
              inputMode="numeric"
              dir="ltr"
              value={d.serviceDays}
              error={pIssues.serviceDays}
              onChange={(e) => setD({ ...d, serviceDays: e.target.value })}
            />
            <Select
              id="p05-weekdays"
              label={p05.annex.weekdays}
              value={d.weekdays}
              options={[
                ['sun_thu', p05.annex.weekdaysSunThu],
                ['all', p05.annex.weekdaysAll],
              ]}
              onChange={(e) => setD({ ...d, weekdays: e.target.value as PlanDraft['weekdays'] })}
            />
            <TextField
              id="p05-freeze"
              label={p05.annex.freezeDays}
              inputMode="numeric"
              dir="ltr"
              value={d.freezeDays}
              error={pIssues.freeze}
              onChange={(e) => setD({ ...d, freezeDays: e.target.value })}
            />
          </>
        ) : (
          <Select
            id="p05-renewal"
            label={p05.annex.renewal}
            value={d.renewal}
            options={[
              ['auto', p05.annex.renewalAuto],
              ['manual', p05.annex.renewalManual],
            ]}
            onChange={(e) => setD({ ...d, renewal: e.target.value as PlanDraft['renewal'] })}
          />
        )}
        <TextField
          id="p05-daily"
          label={p05.annex.dailyLimit}
          inputMode="numeric"
          dir="ltr"
          value={d.daily}
          error={pIssues.daily}
          onChange={(e) => setD({ ...d, daily: e.target.value })}
        />
        <Select
          id="p05-refund"
          label={p05.annex.refund}
          value={d.refund}
          options={[
            ['prorated_on_termination', p05.annex.refundProrated],
            ['non_refundable', p05.annex.refundNone],
          ]}
          onChange={(e) => setD({ ...d, refund: e.target.value as PlanDraft['refund'] })}
        />
        <Select
          id="p05-closure"
          label={p05.annex.closure}
          value={d.closure}
          options={[
            ['freeze', p05.annex.closureFreeze],
            ['continue', p05.annex.closureContinue],
          ]}
          onChange={(e) => setD({ ...d, closure: e.target.value as PlanDraft['closure'] })}
        />
        <Select
          id="p05-eligibility"
          label={p05.annex.eligibility}
          value={d.eligibility}
          options={[
            ['none', p05.annex.eligibilityNone],
            ['student_id_review', p05.annex.eligibilityStudent],
          ]}
          onChange={(e) => setD({ ...d, eligibility: e.target.value as PlanDraft['eligibility'] })}
        />
        <Select
          id="p05-vehicle-change"
          label={p05.annex.vehicleChange}
          value={d.vehicleChange}
          options={[
            ['once_per_period', p05.annex.vehicleOnce],
            ['any_time', p05.annex.vehicleAnyTime],
          ]}
          onChange={(e) => setD({ ...d, vehicleChange: e.target.value as PlanDraft['vehicleChange'] })}
        />
        <TextField
          id="p05-capacity"
          label={p05.annex.capacity}
          inputMode="numeric"
          dir="ltr"
          value={d.capacity}
          error={pIssues.capacity}
          onChange={(e) => setD({ ...d, capacity: e.target.value })}
        />
        <TextField
          id="p05-audience"
          label={p05.annex.audience}
          value={d.audience}
          onChange={(e) => setD({ ...d, audience: e.target.value })}
        />
      </div>
    </ReasonDialog>
  );
}

/** V2-036 (DEC-599): the venue's announced holidays and closures — listed, added, withdrawn with a reason. */
function VenueClosures({ venue }: { venue: PlanVenue }) {
  const online = useOnline();
  const [adding, setAdding] = useState(false);
  const [canceling, setCanceling] = useState<VenueClosure | null>(null);
  const [d, setD] = useState({ kind: 'holiday' as 'holiday' | 'closure', starts: '', ends: '', reason: '' });
  const key = subscriptionKeys.closures(venue.venue_id);
  const list = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => subscriptionsApi.closures(venue.venue_id, signal),
  });
  const create = useStaffCommand(
    (_: string, k: string) =>
      subscriptionsApi.createClosure(
        {
          venue_id: venue.venue_id,
          kind: d.kind,
          starts_on: d.starts.trim(),
          ends_on: d.ends.trim(),
          reason_ar: d.reason.trim(),
        },
        k,
      ),
    { successMessage: p05.annex.done.closure, invalidate: [key], onSuccess: () => setAdding(false) },
  );
  const cancel = useStaffCommand(
    (input: { id: string; reason: string }, k: string) =>
      subscriptionsApi.cancelClosure(input.id, input.reason, k),
    {
      successMessage: p05.annex.done.closureCanceled,
      invalidate: [key],
      onSuccess: () => setCanceling(null),
    },
  );
  const items = (list.data ?? []).filter((c) => !c.canceled_at);
  const date = /^\d{4}-\d{2}-\d{2}$/;
  return (
    <div className="st-form" data-testid={`p05-closures-${venue.venue_id}`}>
      <div className="st-head">
        <h3 className="m-0 font-bold">{p05.annex.closures}</h3>
        <Button
          variant="secondary"
          compact
          iconStart={Plus}
          disabled={!online}
          onClick={() => setAdding(true)}
        >
          {p05.annex.addClosure}
        </Button>
      </div>
      <p className="m-0 text-sm text-text-muted">{p05.annex.closuresHint}</p>
      {items.length ? (
        <ul className="st-list m-0 p-0">
          {items.map((c) => (
            <li key={c.closure_id} className="list-none">
              <span className="font-bold">{c.reason_ar}</span>{' '}
              <bdi dir="ltr" className="pt-num">
                {fmt(p05.annex.closureRange, { start: c.starts_on, end: c.ends_on })}
              </bdi>{' '}
              <Button variant="secondary" compact disabled={!online} onClick={() => setCanceling(c)}>
                {p05.annex.cancelClosure}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-sm text-text-muted">{p05.annex.noClosures}</p>
      )}
      <ReasonDialog
        id="p05-closure"
        open={adding}
        onOpenChange={(o) => setAdding(o)}
        title={p05.annex.addClosure}
        confirmLabel={p05.annex.addClosure}
        withReason={false}
        canConfirm={date.test(d.starts.trim()) && date.test(d.ends.trim()) && d.reason.trim().length >= 3}
        pending={create.pending}
        error={create.message}
        onConfirm={(r) => create.run(r)}
      >
        <div className="st-form">
          <Select
            id="p05-closure-kind"
            label={p05.annex.closureKind}
            value={d.kind}
            options={[
              ['holiday', p05.annex.kindHoliday],
              ['closure', p05.annex.kindClosure],
            ]}
            onChange={(e) => setD({ ...d, kind: e.target.value as 'holiday' | 'closure' })}
          />
          <TextField
            id="p05-closure-start"
            label={p05.annex.startsOn}
            dir="ltr"
            value={d.starts}
            onChange={(e) => setD({ ...d, starts: e.target.value })}
          />
          <TextField
            id="p05-closure-end"
            label={p05.annex.endsOn}
            dir="ltr"
            value={d.ends}
            onChange={(e) => setD({ ...d, ends: e.target.value })}
          />
          <TextField
            id="p05-closure-reason"
            label={p05.annex.reasonAr}
            value={d.reason}
            onChange={(e) => setD({ ...d, reason: e.target.value })}
          />
        </div>
      </ReasonDialog>
      <ReasonDialog
        id="p05-closure-cancel"
        open={!!canceling}
        onOpenChange={(o) => {
          if (!o) setCanceling(null);
        }}
        title={fmt(p05.annex.cancelClosureTitle, { reason: canceling?.reason_ar ?? '' })}
        confirmLabel={p05.annex.cancelClosure}
        destructive
        pending={cancel.pending}
        reasonError={cancel.fields.reason ?? null}
        error={cancel.message}
        onConfirm={(reason) => (canceling ? cancel.run({ id: canceling.closure_id, reason }) : undefined)}
      />
    </div>
  );
}

/** V2-036 (DEC-597): the venue's eligible student numbers — counts only; a pasted list added or removed. */
function EligibleList({ venue }: { venue: PlanVenue }) {
  const online = useOnline();
  const [text, setText] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const key = subscriptionKeys.eligible(venue.venue_id);
  const summary = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => subscriptionsApi.eligibleSummary(venue.venue_id, signal),
  });
  const numbers = text
    .split(/[\s,;]+/)
    .map((n) => n.trim().toUpperCase())
    .filter((n) => /^[A-Z0-9-]{3,32}$/.test(n));
  const run = useStaffCommand(
    (mode: 'add' | 'remove', k: string) =>
      subscriptionsApi.importEligible(venue.venue_id, { mode, student_numbers: numbers }, k),
    {
      successMessage: p05.annex.done.eligibleShort,
      invalidate: [key, ['platform', 'subscriptions']],
      onSuccess: (r) => {
        setText('');
        setResult(fmt(p05.annex.done.eligible, { changed: r.changed, approved: r.approved }));
      },
    },
  );
  return (
    <div className="st-form" data-testid={`p05-eligible-${venue.venue_id}`}>
      <h3 className="m-0 font-bold">{p05.annex.eligibleList}</h3>
      {summary.data ? (
        <p className="m-0 text-sm">
          {fmt(p05.annex.eligibleMeta, {
            listed: summary.data.listed,
            pending: summary.data.pending_applications,
          })}
        </p>
      ) : null}
      <p className="m-0 text-sm text-text-muted">{p05.annex.eligibleHint}</p>
      <label className="st-form" htmlFor={`p05-eligible-text-${venue.venue_id}`}>
        <span className="font-bold">{p05.annex.eligibleNumbers}</span>
        <textarea
          id={`p05-eligible-text-${venue.venue_id}`}
          dir="ltr"
          rows={4}
          className="st-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {run.message ? <p className="m-0 text-danger">{run.message}</p> : null}
      {result ? <p className="m-0 text-sm">{result}</p> : null}
      <div className="st-row-actions">
        <Button
          compact
          disabled={!online || !numbers.length}
          loading={run.pending}
          onClick={() => void run.run('add')}
        >
          {p05.annex.eligibleAdd}
        </Button>
        <Button
          variant="secondary"
          compact
          disabled={!online || !numbers.length}
          onClick={() => void run.run('remove')}
        >
          {p05.annex.eligibleRemove}
        </Button>
      </div>
    </div>
  );
}
