import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Images, MessageCircle, Phone, XCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { getTicket } from '@/api/field';
import { queryKeys } from '@/api/queryClient';
import type { TicketDetail } from '@/api/types';
import { paths } from '@/app/paths';
import {
  Button,
  Card,
  Header,
  MaskedPhone,
  PlateBadge,
  Skeleton,
  StatusChip,
  TicketNumber,
} from '@/components';
import { LoadError } from '@/features/common/QueryView';
import { d13, paymentStatus, waLinkStatus } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { formatTime } from '@/lib/format';
import { useCommandGate } from '@/realtime/hooks';
import { useDriverMe } from '../DriverLayout';
import { driverPaths, plateValue, vehicleSummary } from '../fieldModel';
import { CancelRetrievalDialog, ChangePhoneSheet, OnBehalfSheet, PhotosSheet, ReportSheet } from './actions';
import { restrictedRows, vehicleActions } from './model';
import { CarGlyph } from '@/components/CarGlyph';

/** «الجوال: 05•••••123» with the number isolated LTR (02 §7.3). */
function fill(template: string, key: string, node: ReactNode): ReactNode {
  const [before = '', after = ''] = template.split(`{${key}}`);
  return (
    <>
      {before}
      {node}
      {after}
    </>
  );
}

type Open = 'onBehalf' | 'cancel' | 'phone' | 'report' | 'photos' | null;

/**
 * D-13 — تفاصيل المركبة (PNT-069): one ticket as the server projects it for this driver (`GET
 * /v1/tickets/{ticketId}`: `minimal` = status, plate, vehicle, event, channel, link status and payment status;
 * `full` for the assignee of an open task and the creator during intake adds the masked phone, the spot, the
 * key slot and the photos — 07 §1.10, 09 §5.1). The actions of 02 D-13: the request on behalf of the
 * customer (parked), the cancel before the assignment, the phone change, «إعادة الربط بواتساب» (→ D-07) and the
 * incident report.
 */
export function VehiclePage() {
  const me = useDriverMe();
  const { ticketId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const gate = useCommandGate();
  const [open, setOpen] = useState<Open>(null);
  const query = useQuery({
    queryKey: queryKeys.ticket(ticketId),
    queryFn: ({ signal }) => getTicket(ticketId, signal),
    enabled: !!ticketId,
    staleTime: 2000,
  });
  // «الرجوع إلى المصدر»: D-12, or the list when the page was opened directly (a notification)
  const back = () => (location.key !== 'default' ? navigate(-1) : navigate(paths.driverVehicles));

  if (query.isPending)
    return (
      <section className="flex flex-col gap-4">
        <Skeleton variant="line" width="40%" />
        <Skeleton />
        <Skeleton withAction />
      </section>
    );
  if (!query.data)
    return (
      <LoadError error={query.error} onRetry={() => void query.refetch()} backTo={paths.driverVehicles} />
    );

  const ticket = query.data;
  const actions = vehicleActions(me, ticket);
  const rows = restrictedRows(ticket);
  const plate = plateValue(ticket.plate);
  const vehicle = vehicleSummary(ticket.vehicle_detail ?? ticket.vehicle);
  const toggle = (which: Open) => (o: boolean) => setOpen(o ? which : null);
  const refresh = (updated?: TicketDetail) => {
    if (updated) qc.setQueryData(queryKeys.ticket(ticket.id), updated);
    else void qc.invalidateQueries({ queryKey: queryKeys.ticket(ticket.id) });
    void qc.invalidateQueries({ queryKey: queryKeys.vehicles });
    void qc.invalidateQueries({ queryKey: queryKeys.home });
  };

  return (
    <section className="flex flex-col gap-4">
      <Header title={<TicketNumber n={ticket.display_number} />} onBack={back} />
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <CarGlyph {...ticket.vehicle} width={88} />
          {plate ? (
            <PlateBadge {...plate} size="lg" />
          ) : (
            <bdi dir="ltr" className="font-mono">
              {ticket.plate.display}
            </bdi>
          )}
          {vehicle ? <span className="font-semibold">{vehicle}</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status={ticket.status} />
          {ticket.event_name_ar ? (
            <span className="text-sm text-text-muted">{ticket.event_name_ar}</span>
          ) : null}
        </div>
      </Card>

      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {ticket.created_by ? (
          <li data-row="created-by">
            {fmt(d13.createdBy, {
              name: ticket.created_by.full_name,
              time: ticket.created_at ? formatTime(ticket.created_at) : '—',
            })}
          </li>
        ) : null}
        <li data-row="channel">
          {ticket.channel === 'whatsapp'
            ? fmt(d13.channel, {
                channel: d13.channelName.whatsapp,
                status: waLinkStatus[ticket.wa_link_status],
              })
            : fmt(d13.channelOnly, { channel: d13.channelName.paper })}
        </li>
        {rows.phone ? (
          <li data-row="phone">{fill(d13.phone, 'phone', <MaskedPhone phone={rows.phone} />)}</li>
        ) : null}
        {ticket.payment_status !== 'not_required' ? (
          <li data-row="payment">{fmt(d13.payment, { status: paymentStatus[ticket.payment_status] })}</li>
        ) : null}
        {rows.spot ? (
          <li data-row="spot">
            {fill(
              d13.spot,
              'label',
              <bdi dir="ltr" className="font-mono">
                {rows.spot}
              </bdi>,
            )}
          </li>
        ) : null}
        {rows.keySlot ? (
          <li data-row="key-slot">
            {fill(
              d13.keySlot,
              'label',
              <bdi dir="ltr" className="font-mono">
                {rows.keySlot}
              </bdi>,
            )}
          </li>
        ) : null}
      </ul>
      {rows.photos.length > 0 ? (
        <Button variant="secondary" iconStart={Images} onClick={() => setOpen('photos')}>
          {d13.photos}
        </Button>
      ) : null}

      {actions.onBehalf ? (
        <Button size="lg" fullWidth disabled={!gate.ready} onClick={() => setOpen('onBehalf')}>
          {d13.onBehalf}
        </Button>
      ) : null}
      {actions.cancel ? (
        <Button
          variant="secondary"
          fullWidth
          iconStart={XCircle}
          disabled={!gate.ready}
          onClick={() => setOpen('cancel')}
        >
          {d13.cancel}
        </Button>
      ) : null}
      <div className="flex flex-col gap-2">
        {actions.changePhone ? (
          <Button
            variant="ghost"
            fullWidth
            iconStart={Phone}
            disabled={!gate.ready}
            onClick={() => setOpen('phone')}
          >
            {d13.changePhone}
          </Button>
        ) : null}
        {actions.relink ? (
          <Button
            variant="ghost"
            fullWidth
            iconStart={MessageCircle}
            onClick={() => navigate(driverPaths.intakeLink(ticket.id))}
          >
            {d13.relink}
          </Button>
        ) : null}
        {actions.report ? (
          <Button
            variant="ghost"
            fullWidth
            iconStart={CircleAlert}
            disabled={!gate.ready}
            onClick={() => setOpen('report')}
          >
            {d13.report}
          </Button>
        ) : null}
      </div>

      {actions.onBehalf ? (
        <OnBehalfSheet
          key={`onbehalf-${ticket.version}`}
          ticket={ticket}
          open={open === 'onBehalf'}
          onOpenChange={toggle('onBehalf')}
          onDone={refresh}
        />
      ) : null}
      {actions.cancel ? (
        <CancelRetrievalDialog
          ticket={ticket}
          cycleId={actions.cancel.cycleId}
          open={open === 'cancel'}
          onOpenChange={toggle('cancel')}
          onDone={refresh}
        />
      ) : null}
      {actions.changePhone ? (
        <ChangePhoneSheet
          ticket={ticket}
          open={open === 'phone'}
          onOpenChange={toggle('phone')}
          onDone={refresh}
        />
      ) : null}
      {actions.report ? (
        <ReportSheet ticket={ticket} open={open === 'report'} onOpenChange={toggle('report')} />
      ) : null}
      {rows.photos.length > 0 ? (
        <PhotosSheet media={rows.photos} open={open === 'photos'} onOpenChange={toggle('photos')} />
      ) : null}
    </section>
  );
}
