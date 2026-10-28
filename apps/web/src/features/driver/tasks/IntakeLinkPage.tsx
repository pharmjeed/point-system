import { useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import type { TicketDetail } from '@/api/types';
import { paths } from '@/app/paths';
import { Button, Checkbox, Header } from '@/components';
import { LoadError } from '@/features/common/QueryView';
import { d07, waLinkStatus } from '@/i18n/ar';

import { fmtNode, Ltr, withTicket } from '@/i18n/fmtNode';
import { driverPaths } from '../fieldModel';
import { useCachedHome } from '../useDriverHome';
import { TaskSkeleton, useTicket } from './common';

/**
 * D-07 mode C — تذكرة ورقية: hand the customer the stub and hang the other part on the key; the checkbox is
 * a local reminder only and «متابعة إلى الصف» is never blocked (02 D-07). The WhatsApp modes (send status,
 * QR panel) come with PNT-043/PNT-044; a WhatsApp ticket shows its link status only.
 */
export function IntakeLinkPage() {
  const { ticketId = '' } = useParams();
  const ticket = useTicket(ticketId);
  if (ticket.data) {
    if (ticket.data.status === 'received')
      return <Navigate to={driverPaths.intakeKeyPhotos(ticketId)} replace />;
    return <LinkStep ticket={ticket.data} />;
  }
  if (ticket.error)
    return <LoadError error={ticket.error} onRetry={() => void ticket.refetch()} backTo={paths.driverHome} />;
  return <TaskSkeleton />;
}

function LinkStep({ ticket }: { ticket: TicketDetail }) {
  const navigate = useNavigate();
  const home = useCachedHome();
  const [stubGiven, setStubGiven] = useState(false);
  const parkTask =
    ticket.open_task && (ticket.open_task.type === 'park' || ticket.open_task.type === 'repark')
      ? ticket.open_task.id
      : home?.current_task?.ticket.id === ticket.id
        ? home.current_task.task.id
        : null;
  const toParking = () => navigate(parkTask ? driverPaths.park(parkTask) : paths.driverHome);
  const paper = ticket.channel === 'paper';

  return (
    <section className="flex flex-col gap-4">
      <Header
        title={
          paper
            ? withTicket(d07.paperTitle, ticket.display_number)
            : withTicket(`${waLinkStatus[ticket.wa_link_status]} · #{n}`, ticket.display_number)
        }
      />
      {paper ? (
        <>
          <p className="m-0 text-lg">
            {fmtNode(d07.paperText, { serial: <Ltr>{ticket.paper_serial ?? ''}</Ltr> })}
          </p>
          <Checkbox
            id="stub-given"
            label={d07.stubGiven}
            checked={stubGiven}
            onChange={(e) => setStubGiven(e.target.checked)}
          />
        </>
      ) : null}
      <Button size="lg" id="to-parking" onClick={toParking}>
        {d07.toParking}
      </Button>
    </section>
  );
}
