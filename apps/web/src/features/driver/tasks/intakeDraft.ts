import { useEffect } from 'react';
import { useDriverMe } from '../DriverLayout';
import { forgetIntake } from '../intakePersistence';
import { useTicket } from './common';
import { useIntakeHydration } from './uploads';

/**
 * D-05 / D-06 data: the ticket (`GET /v1/tickets/{ticketId}`) and the local draft of this user and ticket,
 * brought back from IndexedDB before the form shows (PNT-071). A ticket that left `received` (submitted,
 * discarded or voided elsewhere) takes its draft with it (03 §4.3).
 */
export function useIntakeTicket(ticketId: string) {
  const me = useDriverMe();
  const ticket = useTicket(ticketId);
  const hydrated = useIntakeHydration(me.user.id, ticketId);
  const left = !!ticket.data && ticket.data.status !== 'received';
  useEffect(() => {
    if (left) void forgetIntake(ticketId);
  }, [left, ticketId]);
  return { ticket, hydrated };
}
