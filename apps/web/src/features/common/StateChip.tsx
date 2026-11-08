import {
  CalendarClock,
  CircleCheck,
  CircleSlash,
  CircleX,
  Hourglass,
  Lock,
  type LucideIcon,
} from 'lucide-react';
import type { EventStatus, SetupStatus, ShiftStatus, UserStatus } from '@/api/types';
import { Icon } from '@/components';
import { eventStatus, setupStatus, shiftStatus, userStatus } from '@/i18n/ar';
import { cx } from '@/lib/cx';

/**
 * Status chip for setup records (events, shifts, setup items, accounts). Same anatomy as `StatusChip`
 * (text + colour + icon, never colour alone, 03 §3.3); tones are the semantic feedback roles because these
 * statuses have no dedicated tokens (docs/progress/notes/pnt-023.md).
 */
export type ChipTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface StateChipProps {
  label: string;
  tone: ChipTone;
  icon: LucideIcon;
}

export function StateChip({ label, tone, icon }: StateChipProps) {
  return (
    <span className={cx('pt-chip', 'pt-chip--sm', `pt-chip--tone-${tone}`)} data-tone={tone}>
      <Icon icon={icon} size={16} />
      <span>{label}</span>
    </span>
  );
}

const EVENT: Record<EventStatus, [ChipTone, LucideIcon]> = {
  draft: ['info', CalendarClock],
  open: ['success', CircleCheck],
  closing: ['warning', Hourglass],
  closed: ['neutral', Lock],
  canceled: ['danger', CircleX],
};

export function EventStatusChip({ status }: { status: EventStatus }) {
  const [tone, icon] = EVENT[status] ?? ['neutral', CalendarClock];
  return <StateChip label={eventStatus[status] ?? status} tone={tone} icon={icon} />;
}

const SHIFT: Record<ShiftStatus, [ChipTone, LucideIcon]> = {
  scheduled: ['info', CalendarClock],
  open: ['success', CircleCheck],
  closed: ['neutral', Lock],
};

export function ShiftStatusChip({ status }: { status: ShiftStatus }) {
  const [tone, icon] = SHIFT[status] ?? ['neutral', CalendarClock];
  return <StateChip label={shiftStatus[status] ?? status} tone={tone} icon={icon} />;
}

export function SetupStatusChip({ status }: { status: SetupStatus }) {
  return status === 'active' ? (
    <StateChip label={setupStatus.active} tone="success" icon={CircleCheck} />
  ) : (
    <StateChip label={setupStatus.inactive} tone="neutral" icon={CircleSlash} />
  );
}

export function UserStatusChip({ status }: { status: UserStatus }) {
  return status === 'active' ? (
    <StateChip label={userStatus.active} tone="success" icon={CircleCheck} />
  ) : (
    <StateChip label={userStatus.disabled} tone="danger" icon={CircleSlash} />
  );
}
