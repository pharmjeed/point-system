import { cx } from '@/lib/cx';

/** Ticket number «#125» in IBM Plex Mono, isolated LTR; `display` = 40/48 ticket-display (DEC-49a). */
export function TicketNumber({ n, size }: { n: number | string; size?: 'display' }) {
  return (
    <bdi dir="ltr" className={cx('pt-ticketno', size === 'display' && 'pt-ticketno--display')}>
      #{n}
    </bdi>
  );
}
