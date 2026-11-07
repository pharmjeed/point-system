import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { PlatformMe } from '@/api/platform';
import {
  fetchPlatformVenue,
  fetchPlatformVenues,
  reviewVenue,
  setVenuePricing,
  venueProfileKeys,
  type PlatformVenueProfile,
  type ReviewAction,
  type VenuePublicStatus,
} from '@/api/venueProfile';
import { paths } from '@/app/paths';
import {
  Banner,
  Button,
  Card,
  Dialog,
  EmptyState,
  FieldError,
  Header,
  ListItem,
  SegmentedControl,
  TextField,
  Toggle,
} from '@/components';
import {
  OPENING_DAYS,
  canPrice,
  formatSar,
  mapLink,
  parseSar,
  reviewActionsFor,
  subscriptionsAllowed,
} from '@/features/venues/profileModel';
import { PageSkeleton, ReadError } from '@/features/supervisor/ui';
import { useStaffCommand } from '@/features/supervisor/useStaffCommand';
import { useOnline } from '@/hooks/useOnline';
import { p04, venueProfile as copy } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { formatDateTime } from '@/lib/format';
import { usePlatformAccount } from './PlatformLayout';
import '@/features/supervisor/staff.css';

type Filter = 'all' | 'submitted' | 'approved' | 'draft' | 'hidden';
const FILTERS: Filter[] = ['submitted', 'approved', 'draft', 'hidden', 'all'];

/** P-04 «المواقع» (V2-004, inside PlatformLayout): the listing requests of every operator, the submitted ones first. */
export function PlatformVenuesPage() {
  return <VenueList me={usePlatformAccount()} />;
}

function VenueList({ me }: { me: PlatformMe }) {
  const [filter, setFilter] = useState<Filter>('submitted');
  const filters = { status: filter === 'all' ? undefined : (filter as VenuePublicStatus) };
  const q = useInfiniteQuery({
    queryKey: venueProfileKeys.platformList(filters),
    queryFn: ({ pageParam, signal }) => fetchPlatformVenues(filters, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: me.permissions.includes('platform.venue_review'),
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section className="st-page" aria-labelledby="p04-title">
      <h1 className="pt-page-title" id="p04-title">
        {p04.title}
      </h1>
      <SegmentedControl
        label={p04.title}
        options={FILTERS.map((f) => ({ value: f, label: p04.filters[f] }))}
        value={filter}
        onChange={setFilter}
      />
      {q.isPending ? (
        <PageSkeleton />
      ) : q.error ? (
        <ReadError error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={MapPin} title={p04.empty} />
      ) : (
        <ul className="pt-list">
          {items.map((v) => (
            <li key={v.venue_id}>
              <ListItem
                icon={MapPin}
                title={`${v.venue.name_ar} · ${v.org.name_ar}`}
                meta={[
                  copy.status[v.status],
                  copy.category[v.category],
                  v.city,
                  fmt(p04.photoCount, { n: v.photo_count }),
                  fmt(p04.updated, { time: formatDateTime(v.updated_at) }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
                to={`${paths.platformVenues}/${v.venue_id}`}
              />
            </li>
          ))}
        </ul>
      )}
      {q.hasNextPage ? (
        <Button variant="secondary" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {p04.loadMore}
        </Button>
      ) : null}
    </section>
  );
}

/** P-04 detail: the profile as the customer will see it, the operator, and the review and pricing actions. */
export function PlatformVenuePage() {
  return <VenueDetail me={usePlatformAccount()} />;
}

function VenueDetail({ me }: { me: PlatformMe }) {
  const { venueId = '' } = useParams();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: venueProfileKeys.platformOne(venueId),
    queryFn: ({ signal }) => fetchPlatformVenue(venueId, signal),
  });
  const back = () => navigate(paths.platformVenues);
  return (
    <section className="st-page">
      <Header title={q.data?.venue.name_ar ?? p04.title} onBack={back} />
      {q.isPending ? (
        <PageSkeleton />
      ) : !q.data ? (
        <ReadError error={q.error} onRetry={() => void q.refetch()} backTo={paths.platformVenues} />
      ) : (
        <>
          <ProfileFacts profile={q.data} />
          <ReviewActions me={me} profile={q.data} />
          {canPrice(me.permissions) ? <PricingForm profile={q.data} /> : null}
        </>
      )}
    </section>
  );
}

function ProfileFacts({ profile: p }: { profile: PlatformVenueProfile }) {
  const hours = p.opening_hours;
  return (
    <Card>
      <dl className="st-facts">
        <Fact
          label={p04.operator}
          value={`${p.org.name_ar} · ${p04.operatorStatus[p.org.operator_status]}`}
        />
        <Fact label={copy.fields.venue} value={`${p.venue.name_ar} (${p.venue.code})`} />
        <Fact label={copy.fields.category} value={p.category ? copy.category[p.category] : '—'} />
        <Fact label={copy.fields.address} value={p.address ?? '—'} />
        <Fact label={copy.fields.city} value={p.city ?? '—'} />
        <div className="st-fact">
          <dt>{copy.fields.lat}</dt>
          <dd>
            {p.lat !== null && p.lng !== null ? (
              <a
                href={mapLink(p.lat, p.lng)}
                target="_blank"
                rel="noreferrer noopener"
                dir="ltr"
                className="inline-flex min-h-11 items-center"
              >
                {p.lat}, {p.lng} · {p04.openMap}
              </a>
            ) : (
              p04.noCoordinates
            )}
          </dd>
        </div>
        <div className="st-fact">
          <dt>{copy.fields.hours}</dt>
          <dd>
            {hours.always_open ? (
              copy.fields.alwaysOpen
            ) : OPENING_DAYS.some((d) => hours.days[d]?.length) ? (
              <ul className="m-0 ps-4">
                {OPENING_DAYS.filter((d) => hours.days[d]?.length).map((d) => (
                  <li key={d}>
                    {copy.days[d]}:{' '}
                    <span dir="ltr">{hours.days[d]!.map((i) => `${i.open}–${i.close}`).join(' · ')}</span>
                  </li>
                ))}
              </ul>
            ) : (
              p04.noHours
            )}
          </dd>
        </div>
        <Fact
          label={copy.fields.subscriptions}
          value={p.subscriptions_enabled ? copy.enabled : copy.disabled}
        />
        <Fact
          label={copy.fields.payPerVisit}
          value={
            p.pay_per_visit_halalas
              ? fmt(copy.sar, { amount: formatSar(p.pay_per_visit_halalas) })
              : copy.noPrice
          }
        />
      </dl>
      <p className="m-0 font-bold">{copy.status[p.status ?? 'none']}</p>
      {p.review_note ? <Banner kind="warning" rounded message={p.review_note.reason} /> : null}
      <h2 className="m-0 font-bold">{copy.fields.photos}</h2>
      {p.photos.length ? (
        <div className="st-photos">
          {p.photos.map((ph) => (
            <figure key={ph.id} className="st-photo">
              <img src={ph.url} alt="" />
            </figure>
          ))}
        </div>
      ) : (
        <p className="st-muted m-0">{p04.noPhotos}</p>
      )}
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="st-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

const ACTION_LABEL: Record<ReviewAction, string> = {
  approve: p04.actions.approve,
  'send-back': p04.actions.sendBack,
  hide: p04.actions.hide,
  unhide: p04.actions.unhide,
};
const CONFIRM_TITLE: Record<ReviewAction, string> = {
  approve: p04.confirm.approve,
  'send-back': p04.confirm.sendBack,
  hide: p04.confirm.hide,
  unhide: p04.confirm.unhide,
};

function ReviewActions({ me, profile }: { me: PlatformMe; profile: PlatformVenueProfile }) {
  const online = useOnline();
  const qc = useQueryClient();
  const [open, setOpen] = useState<ReviewAction | null>(null);
  const [reason, setReason] = useState('');
  const actions = profile.status ? reviewActionsFor(profile.status, me.permissions) : [];
  const cmd = useStaffCommand(
    (a: ReviewAction, key: string) =>
      reviewVenue(
        profile.venue_id,
        a,
        a === 'approve'
          ? { expected_version: profile.version }
          : { expected_version: profile.version, reason },
        key,
      ),
    {
      invalidate: [venueProfileKeys.platformOne(profile.venue_id), ['platform', 'venues']],
      onSuccess: (saved) => {
        qc.setQueryData(venueProfileKeys.platformOne(profile.venue_id), saved);
        setOpen(null);
        setReason('');
      },
    },
  );
  if (!actions.length) return null;
  return (
    <div className="st-inline-list">
      {actions.map((a) => (
        <Button
          key={a}
          variant={a === 'approve' || a === 'unhide' ? 'primary' : a === 'hide' ? 'danger' : 'secondary'}
          disabled={!online}
          onClick={() => {
            cmd.reset();
            setReason('');
            setOpen(a);
          }}
        >
          {ACTION_LABEL[a]}
        </Button>
      ))}
      <Dialog
        open={open !== null}
        onOpenChange={(o) => !o && setOpen(null)}
        onCancel={() => setOpen(null)}
        title={open ? CONFIRM_TITLE[open] : ''}
        body={open === 'approve' ? p04.confirm.approveBody : p04.confirm.reasonHint}
        reasonRequired={open !== null && open !== 'approve'}
        reason={reason}
        onReasonChange={setReason}
        destructive={open === 'hide'}
        confirmLabel={open ? ACTION_LABEL[open] : undefined}
        loading={cmd.pending}
        error={cmd.fields.reason ?? cmd.message}
        onConfirm={() => (open ? cmd.run(open) : undefined)}
      />
    </div>
  );
}

function PricingForm({ profile }: { profile: PlatformVenueProfile }) {
  const online = useOnline();
  const qc = useQueryClient();
  const [subs, setSubs] = useState(profile.subscriptions_enabled);
  const [price, setPrice] = useState(
    profile.pay_per_visit_halalas ? formatSar(profile.pay_per_visit_halalas) : '',
  );
  const parsed = parseSar(price);
  const allowed = subscriptionsAllowed(profile.category);
  const save = useStaffCommand(
    (_: null, key: string) =>
      setVenuePricing(
        profile.venue_id,
        {
          expected_version: profile.version,
          subscriptions_enabled: subs,
          pay_per_visit_halalas: parsed === 'invalid' ? null : parsed,
        },
        key,
      ),
    {
      successMessage: p04.done.pricing,
      invalidate: [venueProfileKeys.platformOne(profile.venue_id)],
      onSuccess: (saved) => {
        qc.setQueryData(venueProfileKeys.platformOne(profile.venue_id), saved);
      },
    },
  );
  return (
    <form
      className="st-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (parsed !== 'invalid') void save.run(null);
      }}
    >
      <h2 className="m-0 font-bold">{copy.fields.pricing}</h2>
      <Toggle
        id="p04-subscriptions"
        label={copy.fields.subscriptions}
        hint={allowed ? undefined : p04.pricingHallHint}
        checked={subs}
        disabled={!allowed && !subs}
        onChange={setSubs}
      />
      <TextField
        id="p04-price"
        label={copy.fields.payPerVisit}
        hint={copy.noPrice}
        inputMode="decimal"
        dir="ltr"
        value={price}
        error={parsed === 'invalid' ? copy.issues.number : save.fields.pay_per_visit_halalas}
        onChange={(e) => setPrice(e.target.value)}
      />
      {save.message ? <FieldError role="alert">{save.message}</FieldError> : null}
      <Button type="submit" loading={save.pending} disabled={!online || parsed === 'invalid'}>
        {p04.actions.savePricing}
      </Button>
    </form>
  );
}
