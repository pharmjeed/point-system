import { useEffect } from 'react';
import { useDriverMe } from '../DriverLayout';
import { forgetIntake } from '../intakePersistence';
import { useTicket } from './common';
import { useIntakeHydration } from './uploads';

/**
 * D-05 / D-06 data: the ticket (`GET /v1/tickets/{ticketId}`) and the local draft of this user and ticket,
 * brought back from IndexedDB before the form shows (PNT-071). A ticket that left `received` (submitted,
 * discarded or voided elsewhere) takes its draft with it (03 §4.3) — and its pending photos too unless it is
 * `parking`, where they still upload (09 §6.2).
 */
export function useIntakeTicket(ticketId: string) {
  const me = useDriverMe();
  const ticket = useTicket(ticketId);
  const hydrated = useIntakeHydration(me.user.id, ticketId);
  const status = ticket.data?.status;
  const left = !!status && status !== 'received';
  useEffect(() => {
    if (left) void forgetIntake(ticketId, { keepPendingPhotos: status === 'parking' });
  }, [left, status, ticketId]);
  return { ticket, hydrated };
}
