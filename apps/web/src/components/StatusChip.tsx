import { Info } from 'lucide-react';
import type { TicketStatus } from '@/api/types';
import { ticketStatus } from '@/i18n/ar';
import { cx } from '@/lib/cx';
import { Icon } from './Icon';
import { TICKET_STATUS_ICON, tokenKey } from './statusMaps';

export interface StatusChipProps {
  status: TicketStatus;
  size?: 'sm' | 'md';
  /** Override the dictionary text (rare: e.g. «محجوزة لك» in D-04). */
  label?: string;
}

/** Ticket status: text + colour + icon, never colour alone (03 §3.3, canon §5.1). */
export function StatusChip({ status, size = 'md', label }: StatusChipProps) {
  const text = label ?? (ticketStatus as Record<string, string>)[status] ?? status;
  const key = tokenKey(status);
  return (
    <span
      className={cx('pt-chip', size === 'sm' && 'pt-chip--sm')}
      data-status={status}
      style={{ background: `var(--pt-status-${key}-bg)`, color: `var(--pt-status-${key}-fg)` }}
    >
      <Icon icon={TICKET_STATUS_ICON[status] ?? Info} size={16} />
      <span>{text}</span>
    </span>
  );
}
