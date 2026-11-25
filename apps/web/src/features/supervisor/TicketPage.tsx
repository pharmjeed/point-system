import { useQuery } from '@tanstack/react-query';
import { useBrand } from '@/hooks/useMe';
import { Camera, FileExclamationPoint, Ellipsis } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import type { HolderRef, Me, Media, Payment, TicketDetail, TicketTimeline } from '@/api/types';
import { paths } from '@/app/paths';
import {
  Button,
  Card,
  EmptyState,
  EntitlementChip,
  Header,
  ListItem,
  PlateBadge,
  Sheet,
  StatusChip,
  Timeline,
} from '@/components';
import { dueOf, entitlementBadgeOf } from '@/features/common/entitlement';
import { useStaffMe } from '@/features/ops/StaffLayout';
import {
  components,
  custodyHolder,
  incidentSeverity,
  incidentStatus,
  incidentType,
  inspectionStatus,
  mediaKind,
  paymentMethod,
  paymentStatus,
  waLinkStatus,
} from '@/i18n/ar';
import { paymentRecordStatus, s03, staff } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { formatHalalas, formatTime } from '@/lib/format';
import { plateText, plateValue, vehicleSummary } from './opsModel';
import { can, isReversible, ticketActions, type TicketAction } from './permissions';
import { RevealPhone } from './RevealPhone';
import { fetchMediaUrl, fetchTicket, fetchTimeline, LIVE_REFETCH_MS, staffKeys } from './staffApi';
import { staffPaths } from './staffPaths';
import { TicketActionDialog } from './TicketActions';
import { buildTimeline, layoutLabels } from './timelineModel';
import { Fact, PageSkeleton, ReadError, Tabs } from './ui';
import './staff.css';
import { useOnline } from '@/hooks/useOnline';
import { CarGlyph } from '@/components/CarGlyph';

type TicketTab = 'timeline' | 'custody' | 'messages' | 'photos' | 'payments' | 'incidents';

const ACTION_ORDER: TicketAction[] = [
  'reassign',
  'releaseCustody',
  'cancelRetrieval',
  'repark',
  'handoverException',
  'resendCode',
  'recordPayment',
  'waiver',
  'reverse',
  'custodyTransfer',
  'changePhone',
  'relinkWhatsApp',
  'onBehalf',
  'inspectionException',
  'voidTicket',
  'manualReconcile',
  'openIncident',
];

/**
 * S-03 — تفاصيل التذكرة وسجلها (02 §4 S-03, PNT-076…079). The ticket header and rows, the tabs (timeline,
 * custody, messages with the customer-brand preview, photos by signed URL, payments, incidents) and the action
 * panel built from `/v1/me.permissions` and the ticket state (permissions.ts `ticketActions`). The handover
 * code never appears: previews are redacted by the server and masked again (timelineModel `maskCodes`).
 * `?action=reassign|cancelRetrieval|…` opens an action directly (quick actions of S-02).
 */
export function TicketPage() {
  const me = useStaffMe();
  const { ticketId = '' } = useParams();
  const navigate = useNavigate();
  const ticket = useQuery({
    queryKey: staffKeys.ticket(ticketId),
    queryFn: ({ signal }) => fetchTicket(ticketId, signal),
    refetchInterval: LIVE_REFETCH_MS,
  });
  const timeline = useQuery({
    queryKey: staffKeys.timeline(ticketId),
    queryFn: ({ signal }) => fetchTimeline(ticketId, signal),
    enabled: can(me, 'ticket.read_full') && ticket.data?.projection === 'full',
    refetchInterval: LIVE_REFETCH_MS,
  });
  const back = () => (window.history.length > 1 ? navigate(-1) : navigate(paths.ops));

  if (ticket.isPending)
    return (
      <div className="st-page">
        <Header title={s03.screen} onBack={back} />
        <PageSkeleton />
      </div>
    );
  if (!ticket.data)
    return (
      <div className="st-page">
        <Header title={s03.screen} onBack={back} />
        <ReadError error={ticket.error} onRetry={() => void ticket.refetch()} />
      </div>
    );
  return <TicketView me={me} ticket={ticket.data} timeline={timeline.data ?? null} onBack={back} />;
}

function TicketView({
  me,
  ticket,
  timeline,
  onBack,
}: {
  me: Me;
  ticket: TicketDetail;
  timeline: TicketTimeline | null;
  onBack: () => void;
}) {
  const online = useOnline(); // offline only: a resync does not hold staff commands (DEC-380)
  const brand = useBrand(); // V2-033: «مشترك {brand}»
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<TicketTab>('timeline');
  const [menuOpen, setMenuOpen] = useState(false);
  const available = ticketActions(me, ticket);
  const entitlement = entitlementBadgeOf(ticket.entitlement, dueOf(ticket), brand.staffNameAr);
  const actions = ACTION_ORDER.filter((a) => available.includes(a));
  const requested = params.get('action') as TicketAction | null;
  const [active, setActive] = useState<TicketAction | null>(null);

  // quick actions from S-02 (`?action=`): opened once if the action is offered for this ticket
  useEffect(() => {
    if (!requested) return;
    if (actions.includes(requested) && requested !== 'revealPhone') setActive(requested);
    const next = new URLSearchParams(params);
    next.delete('action');
    setParams(next, { replace: true });
  }, [requested]);

  const labels = useMemo(() => layoutLabels(ticket), [ticket]);
  const lines = useMemo(
    () => (timeline ? buildTimeline(timeline, ticket, labels) : []),
    [timeline, ticket, labels],
  );
  const plate = plateValue(ticket.plate);
  const full = ticket.projection === 'full';

  return (
    <div className="st-page">
      <Header
        title={fmt(s03.title, { n: ticket.display_number })}
        onBack={onBack}
        actions={
          actions.length ? (
            <Button variant="secondary" compact iconStart={Ellipsis} onClick={() => setMenuOpen(true)}>
              {s03.actions}
            </Button>
          ) : undefined
        }
      />
      <Card as="section" aria-label={s03.screen}>
        <div className="st-inline-list">
          <CarGlyph {...(ticket.vehicle_detail ?? ticket.vehicle)} />
          {plate ? <PlateBadge {...plate} /> : <span>{plateText(ticket.plate)}</span>}
          <StatusChip status={ticket.status} />
          <span className="st-muted">{vehicleSummary(ticket.vehicle_detail ?? ticket.vehicle)}</span>
        </div>
        <dl className="st-facts">
          <div className="st-facts__row">
            <span>{[ticket.event_name_ar, ticket.venue_name_ar].filter(Boolean).join(' · ')}</span>
          </div>
          {full ? (
            <>
              <div className="st-facts__row">
                {ticket.created_by ? (
                  <span>
                    {fmt(s03.createdBy, {
                      name: ticket.created_by.full_name,
                      time: ticket.created_at ? formatTime(ticket.created_at) : '',
                    })}
                  </span>
                ) : null}
                {ticket.parked_by ? (
                  <span>
                    {fmt(s03.parkedBy, {
                      name: ticket.parked_by.full_name,
                      time: ticket.parked_at ? formatTime(ticket.parked_at) : '',
                    })}
                  </span>
                ) : null}
              </div>
              <div className="st-facts__row">
                <span>{fmt(s03.retrievedBy, { name: ticket.retrieved_by?.full_name ?? staff.none })}</span>
                <span>{fmt(s03.deliveredBy, { name: ticket.delivered_by?.full_name ?? staff.none })}</span>
              </div>
              <div className="st-facts__row">
                <Fact label={s03.phone}>
                  <RevealPhone ticket={ticket} allowed={available.includes('revealPhone') && online} />
                </Fact>
              </div>
            </>
          ) : null}
          <div className="st-facts__row">
            <Fact label={s03.channel}>
              {s03.channelName[ticket.channel]}
              {ticket.channel === 'app' ? null : <> «{waLinkStatus[ticket.wa_link_status]}»</>}
            </Fact>
            {/* O-02 (V2-014, DEC-502): «مشمول» / «يدفع X» */}
            {entitlement ? (
              <Fact label={s03.entitlement}>
                <EntitlementChip badge={entitlement} size="sm" />
              </Fact>
            ) : null}
            {ticket.inspection_status ? (
              <Fact label={s03.inspection}>«{inspectionStatus[ticket.inspection_status]}»</Fact>
            ) : null}
          </div>
          <div className="st-facts__row">
            <Fact label={s03.payment}>
              «{paymentStatus[ticket.payment_status]}»
              {ticket.payment_status !== 'not_required' && ticket.fee_halalas ? (
                <>
                  {' '}
                  <bdi dir="ltr">{formatHalalas(ticket.fee_halalas)}</bdi>
                </>
              ) : null}
            </Fact>
          </div>
          {full ? (
            <div className="st-facts__row">
              <Fact label={s03.spot}>
                {ticket.current_spot
                  ? [ticket.current_spot.zone_name, ticket.current_spot.label].filter(Boolean).join(' · ')
                  : (ticket.current_spot_note ?? holderLabel(ticket.vehicle_holder))}
              </Fact>
              <Fact label={s03.key}>
                {ticket.current_key_slot
                  ? fmt(custodyHolder.key_slot, { label: ticket.current_key_slot.label })
                  : holderLabel(ticket.key_holder)}
              </Fact>
            </div>
          ) : null}
        </dl>
      </Card>

      {full && timeline ? (
        <>
          <Tabs
            idPrefix="ticket"
            label={s03.tabsLabel}
            value={tab}
            onChange={setTab}
            items={[
              { id: 'timeline', label: s03.tabs.timeline },
              { id: 'custody', label: s03.tabs.custody, count: timeline.custody.length },
              { id: 'messages', label: s03.tabs.messages, count: timeline.messages.length },
              { id: 'photos', label: s03.tabs.photos, count: (ticket.media ?? []).filter(isShown).length },
              { id: 'payments', label: s03.tabs.payments, count: timeline.payments.length },
              { id: 'incidents', label: s03.tabs.incidents, count: timeline.incidents.length },
            ]}
          />
          <section
            role="tabpanel"
            id={`ticket-panel-${tab}`}
            aria-labelledby={`ticket-tab-${tab}`}
            className="st-section"
          >
            {tab === 'timeline' ? <Timeline events={lines} /> : null}
            {tab === 'custody' ? (
              lines.some((l) => l.kind === 'custody') ? (
                <Timeline events={lines.filter((l) => l.kind === 'custody')} />
              ) : (
                <EmptyState title={s03.emptyCustody} />
              )
            ) : null}
            {tab === 'messages' ? (
              lines.some((l) => l.kind === 'whatsapp') ? (
                <Timeline events={lines.filter((l) => l.kind === 'whatsapp')} />
              ) : (
                <EmptyState title={s03.emptyMessages} />
              )
            ) : null}
            {tab === 'photos' ? (
              <Photos media={ticket.media ?? []} allowed={can(me, 'ticket.read_photos')} />
            ) : null}
            {tab === 'payments' ? (
              <Payments
                payments={timeline.payments}
                waiverReason={
                  ticket.payment_status === 'waived' ? (ticket.payment_waiver_reason ?? staff.none) : null
                }
                canReverse={available.includes('reverse')}
                onReverse={() => setActive('reverse')}
              />
            ) : null}
            {tab === 'incidents' ? (
              <Incidents
                timeline={timeline}
                canCreate={available.includes('openIncident')}
                onCreate={() => setActive('openIncident')}
              />
            ) : null}
          </section>
        </>
      ) : null}

      <Sheet open={menuOpen} onOpenChange={setMenuOpen} title={s03.actions}>
        {actions.length ? (
          <ul className="pt-list">
            {actions.map((a) => (
              <li key={a}>
                <ListItem
                  title={s03.action[a]}
                  disabled={!online}
                  onClick={() => {
                    setMenuOpen(false);
                    setActive(a);
                  }}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="st-muted">{s03.noActions}</p>
        )}
      </Sheet>
      {active ? (
        <TicketActionDialog
          action={active}
          me={me}
          ticket={ticket}
          timeline={timeline}
          onClose={() => setActive(null)}
        />
      ) : null}
    </div>
  );
}

function holderLabel(h?: HolderRef | null): string {
  if (!h) return staff.none;
  if (h.type === 'driver' || h.type === 'supervisor')
    return h.label
      ? fmt(staff.withHolder, { name: h.label })
      : custodyHolder[h.type].replace(/\s*\{name\}/, '');
  if (h.type === 'spot' || h.type === 'key_slot')
    return h.label
      ? fmt(custodyHolder[h.type], { label: h.label })
      : custodyHolder[h.type].replace(/\s*\{label\}/, '');
  return custodyHolder[h.type] ?? custodyHolder.unknown;
}

const isShown = (m: Media) => m.upload_status === 'uploaded';

function Photos({ media, allowed }: { media: Media[]; allowed: boolean }) {
  const shown = media.filter(isShown);
  if (!allowed || !shown.length) return <EmptyState icon={Camera} title={s03.emptyPhotos} />;
  return (
    <div className="st-photos">
      {shown.map((m) => (
        <Photo key={m.id} media={m} />
      ))}
    </div>
  );
}

/** One photo through a short signed URL (09 §6: ≤300 s, never stored). Kept in memory for 4 minutes. */
function Photo({ media }: { media: Media }) {
  const url = useQuery({
    queryKey: staffKeys.mediaUrl(media.id),
    queryFn: ({ signal }) => fetchMediaUrl(media.id, signal),
    staleTime: 4 * 60_000,
    gcTime: 4 * 60_000,
  });
  const label = fmt(components.photo.photoOf, { angle: mediaKind[media.kind] ?? media.kind });
  return (
    <figure className="st-photo">
      {url.data ? (
        <img src={url.data.url} alt={label} referrerPolicy="no-referrer" loading="lazy" />
      ) : (
        <span className="pt-skel" style={{ aspectRatio: '4 / 3', display: 'block' }} aria-hidden="true" />
      )}
      <figcaption className="st-muted">{mediaKind[media.kind] ?? media.kind}</figcaption>
    </figure>
  );
}

function Payments({
  payments,
  waiverReason,
  canReverse,
  onReverse,
}: {
  payments: Payment[];
  /** The waiver's reason when the fee was waived (02 S-03 «السجلات والعكس والإعفاء», 13 §6; audit A-S03-1). */
  waiverReason: string | null;
  canReverse: boolean;
  onReverse: () => void;
}) {
  if (!payments.length && waiverReason === null) return <EmptyState title={s03.emptyPayments} />;
  return (
    <ul className="pt-list">
      {waiverReason !== null ? (
        <li>
          <ListItem title={s03.action.waiver} meta={fmt(s03.waiverReason, { reason: waiverReason })} />
        </li>
      ) : null}
      {payments.map((p) => (
        <li key={p.id}>
          <ListItem
            title={
              <span className="st-inline-list">
                <span>{paymentMethod[p.method]}</span>
                <bdi dir="ltr">{formatHalalas(p.amount_halalas)}</bdi>
                <span className="st-muted">{paymentRecordStatus[p.status]}</span>
              </span>
            }
            meta={[
              p.collected_by.full_name,
              formatTime(p.collected_at),
              p.pos_reference ?? null,
              p.status === 'reversed' ? p.reversal_reason : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            trailing={
              canReverse && isReversible(p) ? (
                <Button variant="ghost" compact onClick={onReverse}>
                  {s03.action.reverse}
                </Button>
              ) : undefined
            }
          />
        </li>
      ))}
    </ul>
  );
}

function Incidents({
  timeline,
  canCreate,
  onCreate,
}: {
  timeline: TicketTimeline;
  canCreate: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="st-section">
      {canCreate ? (
        <div className="st-row-actions">
          <Button variant="secondary" compact iconStart={FileExclamationPoint} onClick={onCreate}>
            {s03.action.openIncident}
          </Button>
        </div>
      ) : null}
      {timeline.incidents.length ? (
        <ul className="pt-list">
          {timeline.incidents.map((i) => (
            <li key={i.id}>
              <ListItem
                icon={FileExclamationPoint}
                title={incidentType[i.type] ?? i.type}
                meta={`${incidentStatus[i.status]} · ${incidentSeverity[i.severity]} · ${formatTime(i.created_at)}`}
                to={staffPaths.incident(i.id)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={FileExclamationPoint} title={s03.emptyIncidents} />
      )}
    </div>
  );
}
