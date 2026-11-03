import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { listDrivers } from '@/api/drivers';
import { queryKeys } from '@/api/queryClient';
import type { Alert, Me } from '@/api/types';
import { AlertItem, EmptyState, Icon, TextArea } from '@/components';
import { alertSeverity, alertStatus, alertType, buttons } from '@/i18n/ar';
import { s04 } from '@/i18n/ar.staff';
import { formatTime } from '@/lib/format';
import { applyAlertReply } from './cache';
import { alertContext } from './opsModel';
import { can } from './permissions';
import { commands, staffKeys } from './staffApi';
import { staffPaths } from './staffPaths';
import { ReasonDialog, REASON_MIN } from './ui';
import { useStaffCommand } from './useStaffCommand';
import { useStaffCommandsReady } from './commandReady';

/**
 * Alerts with «إقرار» / «حل» (S-04, and the S-02 alerts tab). Acknowledge sends no note; resolve asks for a
 * resolution note (PNT-075 «ملاحظة الحل محفوظة»; see DEC-PROPOSED in the notes). Both stop the escalation
 * sound through the shared cache (cache.ts). Without `alert.manage` (09 §3), and for a resolved alert, the
 * row is read-only: `AlertItem` always draws its buttons, so the same row is drawn without them.
 */
export function AlertList({
  me,
  alerts,
  emptyTitle = s04.empty,
  renderExtra,
}: {
  me: Me;
  alerts: readonly Alert[];
  emptyTitle?: string;
  renderExtra?: (alert: Alert) => ReactNode;
}) {
  const [resolving, setResolving] = useState<Alert | null>(null);
  const drivers = useDriverIds(me, alerts);
  if (!alerts.length) return <EmptyState title={emptyTitle} />;
  return (
    <>
      <ul className="st-stack" aria-live="polite">
        {alerts.map((alert) => (
          <li key={alert.id} data-alert-id={alert.id}>
            <AlertRow
              me={me}
              alert={alert}
              aboutDriver={!!alert.user_id && !!drivers?.has(alert.user_id)}
              onResolve={() => setResolving(alert)}
            />
            {renderExtra?.(alert)}
          </li>
        ))}
      </ul>
      {resolving ? <ResolveDialog alert={resolving} onClose={() => setResolving(null)} /> : null}
    </>
  );
}

/**
 * The drivers of the caller's venues (`GET /v1/drivers` lists the `driver` role only), read when an alert has a
 * user and no ticket. S-06 opens a driver alone, while the same alerts are raised for a supervisor who drives
 * (canon §10 D*: `driver_connection_lost_with_custody`, `push_failed_repeatedly`), so only a known driver gets
 * the S-06 link; until the list is read, none does.
 */
function useDriverIds(me: Me, alerts: readonly Alert[]): Set<string> | null {
  const wanted = can(me, 'driver.read') && alerts.some((a) => !a.ticket_id && !!a.user_id);
  const list = useQuery({
    queryKey: queryKeys.driverList(null),
    queryFn: ({ signal }) => listDrivers({}, signal),
    enabled: wanted,
  });
  return useMemo(() => (list.data ? new Set(list.data.map((d) => d.user.id)) : null), [list.data]);
}

function AlertRow({
  me,
  alert,
  aboutDriver,
  onResolve,
}: {
  me: Me;
  alert: Alert;
  /** `user_id` is a driver of the caller's venues (S-06 opens drivers only) */
  aboutDriver: boolean;
  onResolve: () => void;
}) {
  const qc = useQueryClient();
  const online = useStaffCommandsReady(); // online, confirmed and synced (A-SHELL-2)
  const ack = useStaffCommand(
    (_: Record<string, never>, key: string) => commands.acknowledgeAlert(alert.id, { note: null }, key),
    {
      successMessage: null,
      onSuccess: (updated) => applyAlertReply(qc, updated),
      invalidate: [staffKeys.alerts(), staffKeys.boards()],
    },
  );
  const manage = can(me, 'alert.manage') && alert.status !== 'resolved';
  const title = alertType[alert.type] ?? alert.type;
  const meta = alertContext(alert) ?? alertStatus[alert.status];
  const time = formatTime(alert.raised_at);
  return (
    <div className="st-section">
      {manage ? (
        <AlertItem
          severity={alert.severity}
          title={title}
          type={meta}
          time={time}
          acknowledged={alert.status !== 'open'}
          loading={ack.pending ? 'ack' : undefined}
          error={ack.message ?? undefined}
          disabled={!online}
          onAck={() => ack.run({})}
          onResolve={onResolve}
        />
      ) : (
        <ReadOnlyAlert alert={alert} title={title} context={alertContext(alert)} time={time} />
      )}
      {/* 02 S-04 «رابط التذكرة أو السائق»: the ticket, else the driver the alert is about (S-06) */}
      {alert.ticket_id ? (
        <div className="st-row-actions">
          <Link className="pt-link" to={staffPaths.ticket(alert.ticket_id)}>
            {buttons.open}
          </Link>
        </div>
      ) : alert.user_id && aboutDriver && can(me, 'driver.read') ? (
        <div className="st-row-actions">
          <Link className="pt-link" to={staffPaths.driver(alert.user_id)}>
            {buttons.open}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

const SEVERITY_ICON = { critical: TriangleAlert, warning: CircleAlert, info: Info } as const;

/** `AlertItem`'s look without its actions (resolved, or no `alert.manage`). */
function ReadOnlyAlert({
  alert,
  title,
  context,
  time,
}: {
  alert: Alert;
  title: string;
  context: string | null;
  time: string;
}) {
  return (
    <div className={`pt-alert pt-alert--${alert.severity} is-acked`}>
      <span className="pt-alert__sev">
        <Icon icon={SEVERITY_ICON[alert.severity]} size={16} />
        <span>{alertSeverity[alert.severity]}</span>
      </span>
      <div className="pt-alert__body">
        <span className="pt-alert__title">{title}</span>
        <span className="pt-alert__meta">
          {context ? `${context} · ` : ''}
          <bdi dir="ltr">{time}</bdi> · {alertStatus[alert.status]}
        </span>
        {alert.resolution_note ? <span className="pt-alert__meta">{alert.resolution_note}</span> : null}
      </div>
    </div>
  );
}

function ResolveDialog({ alert, onClose }: { alert: Alert; onClose: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const resolve = useStaffCommand(
    (body: { note: string }, key: string) => commands.resolveAlert(alert.id, body, key),
    {
      onSuccess: (updated) => {
        applyAlertReply(qc, updated);
        onClose();
      },
      onPermissionDenied: onClose,
      invalidate: [staffKeys.alerts(), staffKeys.boards()],
    },
  );
  const trimmed = note.trim();
  return (
    <ReasonDialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={s04.resolveTitle}
      body={alertType[alert.type] ?? alert.type}
      withReason={false}
      canConfirm={trimmed.length >= REASON_MIN}
      pending={resolve.pending}
      error={resolve.message}
      confirmLabel={buttons.confirm}
      onConfirm={() => resolve.run({ note: trimmed })}
      id={`resolve-${alert.id}`}
    >
      <TextArea
        id={`resolve-${alert.id}-note`}
        label={s04.resolveNote}
        value={note}
        rows={2}
        maxLength={300}
        hint={trimmed.length < REASON_MIN ? s04.resolveNoteRequired : undefined}
        onChange={(e) => setNote(e.target.value)}
      />
    </ReasonDialog>
  );
}
