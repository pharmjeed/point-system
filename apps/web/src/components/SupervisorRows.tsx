import { CircleAlert, Clock, Info, KeyRound, TriangleAlert, UserCheck } from 'lucide-react';
import type { ConnectionState, DriverState, TicketStatus } from '@/api/types';
import { alertSeverity, components } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { cx } from '@/lib/cx';
import { Button } from './Button';
import { ConnectionIndicator } from './ConnectionIndicator';
import { DriverStateChip } from './DriverStateChip';
import { FieldError } from './Field';
import { Icon } from './Icon';
import { PlateBadge, type PlateValue } from './PlateBadge';
import { StatusChip } from './StatusChip';
import { TicketNumber } from './TicketNumber';

// ---------------------------------------------------------------- QueueItem

export interface Escalation {
  level: 'warning' | 'critical';
  label: string;
}

export interface QueueItemProps {
  ticketNumber: number;
  status?: TicketStatus;
  vehicle: string;
  plate?: PlateValue;
  /** Formatted waiting counter «m:ss». */
  waiting: string;
  assignee?: string | null;
  escalations?: Escalation[];
  critical?: boolean;
  /** Live update while the user interacts: mark «تغيّر» instead of jumping (03 §4.6). */
  changed?: boolean;
}

/** A queue entry for the supervisor, oldest first (03 §3.16). */
export function QueueItem({
  ticketNumber,
  status = 'requested',
  vehicle,
  plate,
  waiting,
  assignee,
  escalations = [],
  critical,
  changed,
}: QueueItemProps) {
  return (
    <div className={cx('pt-queue', changed && 'is-changed', critical && 'is-critical')}>
      <div className="pt-queue__main">
        <div className="pt-queue__row">
          <TicketNumber n={ticketNumber} />
          <StatusChip status={status} size="sm" />
        </div>
        <div className="pt-queue__vehicle">
          <span>{vehicle}</span>
          {plate ? <PlateBadge {...plate} /> : null}
        </div>
        <div className="pt-queue__meta">
          {assignee ? (
            <span>
              <Icon icon={UserCheck} size={16} /> {assignee}
            </span>
          ) : (
            <span className="pt-queue__unassigned">{components.queue.unassigned}</span>
          )}
          {escalations.map((e) => (
            <span key={e.label} className={`pt-esc pt-esc--${e.level}`}>
              <Icon icon={e.level === 'critical' ? TriangleAlert : Clock} size={16} />
              <span>{e.label}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="pt-queue__wait">
        <span className="pt-queue__waitlabel">{components.queue.waiting}</span>
        <bdi dir="ltr" className="pt-queue__timer">
          {waiting}
        </bdi>
      </div>
      {changed ? <span className="pt-queue__changed">{components.queue.changed}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------- TaskRow

export interface TaskRowProps {
  ticketNumber: number;
  status: TicketStatus;
  driver?: string | null;
  stage: string;
  elapsed: string;
}

/** Task row in the supervisor table; min width 560px inside a horizontal scroll container (03 §3.16). */
export function TaskRow({ ticketNumber, status, driver, stage, elapsed }: TaskRowProps) {
  return (
    <div className="pt-taskrow" role="row">
      <span role="cell">
        <TicketNumber n={ticketNumber} />
      </span>
      <span role="cell">
        <StatusChip status={status} size="sm" />
      </span>
      <span role="cell" className="pt-taskrow__driver">
        {driver || '—'}
      </span>
      <span role="cell" className="pt-taskrow__stage">
        {stage}
      </span>
      <bdi role="cell" dir="ltr" className="pt-num pt-taskrow__time">
        {elapsed}
      </bdi>
    </div>
  );
}

// ---------------------------------------------------------------- DriverRow

export interface DriverRowProps {
  name: string;
  state: DriverState;
  connection?: ConnectionState;
  lastSync?: string;
  current?: number | null;
  next?: number | null;
  custody?: number;
}

/** Driver: name, state, connection, current/next task, custody count (S-05…S-07). */
export function DriverRow({
  name,
  state,
  connection = 'online',
  lastSync,
  current,
  next,
  custody = 0,
}: DriverRowProps) {
  return (
    <div className="pt-driverrow-wrap">
      <div className="pt-driverrow">
        <div className="pt-driverrow__who">
          <span className="pt-driverrow__avatar" aria-hidden="true">
            {name.slice(0, 1)}
          </span>
          <div>
            <span className="pt-driverrow__name">{name}</span>
            <ConnectionIndicator state={connection} lastSync={lastSync} />
          </div>
        </div>
        <DriverStateChip state={state} />
        <div className="pt-driverrow__tasks">
          <span>
            <span className="pt-driverrow__k">{components.driverRow.current} </span>
            {current ? <TicketNumber n={current} /> : '—'}
          </span>
          <span>
            <span className="pt-driverrow__k">{components.driverRow.next} </span>
            {next ? <TicketNumber n={next} /> : '—'}
          </span>
        </div>
        <span className="pt-driverrow__custody">
          <Icon icon={KeyRound} size={16} /> {fmt(components.driverRow.custody, { n: custody })}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- AlertItem

const SEVERITY_ICON = { critical: TriangleAlert, warning: CircleAlert, info: Info } as const;

export interface AlertItemProps {
  severity?: 'critical' | 'warning' | 'info';
  title: string;
  /** Alert type label (`alertType` dictionary). */
  type: string;
  time: string;
  acknowledged?: boolean;
  loading?: 'ack' | 'resolve';
  error?: string;
  disabled?: boolean;
  onAck?: () => Promise<unknown> | void;
  onResolve?: () => Promise<unknown> | void;
}

/** Supervisor alert: severity as text + colour + icon; critical with a 2px danger border (03 §3.16). */
export function AlertItem({
  severity = 'warning',
  title,
  type,
  time,
  acknowledged,
  loading,
  error,
  disabled,
  onAck,
  onResolve,
}: AlertItemProps) {
  return (
    <div className={cx('pt-alert', `pt-alert--${severity}`, acknowledged && 'is-acked')}>
      <span className="pt-alert__sev">
        <Icon icon={SEVERITY_ICON[severity]} size={16} />
        <span>{alertSeverity[severity]}</span>
      </span>
      <div className="pt-alert__body">
        <span className="pt-alert__title">{title}</span>
        <span className="pt-alert__meta">
          {type} · <bdi dir="ltr">{time}</bdi>
          {acknowledged ? ` · ${components.alert.acked}` : ''}
        </span>
      </div>
      <div className="pt-alert__actions">
        {!acknowledged ? (
          <Button variant="secondary" compact loading={loading === 'ack'} disabled={disabled} onClick={onAck}>
            {components.alert.ack}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          compact
          loading={loading === 'resolve'}
          disabled={disabled}
          onClick={onResolve}
        >
          {components.alert.resolve}
        </Button>
      </div>
      {error ? (
        <div className="pt-alert__err">
          <FieldError>{error}</FieldError>
        </div>
      ) : null}
    </div>
  );
}
