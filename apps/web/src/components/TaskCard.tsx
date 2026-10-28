import { Bookmark, MapPin, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { TicketStatus } from '@/api/types';
import { components } from '@/i18n/ar';
import { cx } from '@/lib/cx';
import { Button, type ButtonVariant } from './Button';
import { Card } from './Card';
import { Icon } from './Icon';
import { PlateBadge, type PlateValue } from './PlateBadge';
import { StatusChip } from './StatusChip';
import { TicketNumber } from './TicketNumber';

export interface TaskCardProps {
  ticketNumber: number;
  status?: TicketStatus;
  /** Heading before the number; defaults to «المهمة الحالية» / «المهمة التالية» (D-04 table). */
  heading?: string;
  vehicle: string;
  plate?: PlateValue;
  stage?: string;
  stageIcon?: LucideIcon;
  /** The reserved next task: dimmed, «تالية» badge, no buttons until promoted (03 §3.4). */
  next?: boolean;
  actionLabel?: string;
  actionVariant?: ButtonVariant;
  onAction?: () => Promise<unknown> | void;
  loading?: boolean;
  disabled?: boolean;
  error?: string;
  children?: ReactNode;
}

/** Current / next task in D-04: number, vehicle, status, current stage and the next-stage button only. */
export function TaskCard({
  ticketNumber,
  status,
  heading,
  vehicle,
  plate,
  stage,
  stageIcon = MapPin,
  next,
  actionLabel,
  actionVariant = 'primary',
  onAction,
  loading,
  disabled,
  error,
  children,
}: TaskCardProps) {
  return (
    <Card className={cx('pt-task', next && 'pt-task--next')}>
      <div className="pt-task__head">
        <span className="pt-task__label">
          {heading ?? (next ? components.task.next : components.task.current)}{' '}
          <TicketNumber n={ticketNumber} />
        </span>
        {next ? (
          <span className="pt-chip pt-chip--next">
            <Icon icon={Bookmark} size={16} />
            <span>{components.task.nextBadge}</span>
          </span>
        ) : status ? (
          <StatusChip status={status} />
        ) : null}
      </div>
      <div className="pt-task__vehicle">
        <span>{vehicle}</span>
        {plate ? <PlateBadge {...plate} /> : null}
      </div>
      {stage ? (
        <p className="pt-task__stage">
          <Icon icon={stageIcon} size={20} />
          <span>{stage}</span>
        </p>
      ) : null}
      {children}
      {!next && actionLabel ? (
        <Button
          variant={actionVariant}
          size="lg"
          loading={loading}
          disabled={disabled}
          error={error}
          onClick={onAction}
        >
          {actionLabel}
        </Button>
      ) : null}
    </Card>
  );
}
