import { useInfiniteQuery } from '@tanstack/react-query';
import { CircleCheck, CirclePause, Plus, Search, Tags } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import {
  subscriptionKeys,
  subscriptionsApi,
  type PlanVenue,
  type PlatformPlan,
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
}
const EMPTY: PlanDraft = { name: '', vehicles: '1', monthly: '', yearly: '' };

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
        }
      : EMPTY,
  );
  const issues = planDraftIssues(d);
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
        },
        key,
      );
    },
    { successMessage: p05.done.created, invalidate: [...invalidate], onSuccess: onClose },
  );
  const valid = d.name.trim().length >= 2 && !issues.monthly && !issues.yearly && !issues.price;
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
          onChange={(e) => setD({ ...d, yearly: e.target.value })}
        />
      </div>
    </ReasonDialog>
  );
}
