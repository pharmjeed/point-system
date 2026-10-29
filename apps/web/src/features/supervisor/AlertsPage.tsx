import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { Alert, AlertSeverity, AlertStatus, AlertType } from '@/api/types';
import { paths } from '@/app/paths';
import { FilterChips, Header, Select } from '@/components';
import { useStaffMe } from '@/features/ops/StaffLayout';
import { alertSeverity, alertType } from '@/i18n/ar';
import { s04, staff } from '@/i18n/ar.staff';
import { AlertList } from './AlertList';
import { AlertSoundBanner } from './OpsArea';
import { liveAlerts } from './opsModel';
import { can } from './permissions';
import { fetchAlerts, LIVE_REFETCH_MS, staffKeys } from './staffApi';
import { ForbiddenPage, PageSkeleton, ReadError } from './ui';
import './staff.css';

const STATUSES: AlertStatus[] = ['open', 'acknowledged', 'resolved'];
const SEVERITIES: AlertSeverity[] = ['critical', 'warning', 'info'];

/**
 * S-04 — مركز التنبيهات (02 §4 S-04): FilterChips for status («مفتوحة» · «مستلمة» · «محلولة»), severity and
 * type; each alert with its type, time, ticket link and «إقرار» / «حل». `GET /v1/alerts` (newest first, 07 §1.7)
 * over the whole scope; refreshed every 15 s until the realtime client invalidates `staffKeys.alerts()`.
 */
export function AlertsPage() {
  const me = useStaffMe();
  const navigate = useNavigate();
  const [statuses, setStatuses] = useState<AlertStatus[]>(['open', 'acknowledged']);
  const [severities, setSeverities] = useState<AlertSeverity[]>([]);
  const [type, setType] = useState<AlertType | ''>('');
  const filters = {
    status: statuses.length ? statuses : STATUSES,
    type: type || undefined,
    severity: severities.length === 1 ? severities[0] : undefined,
  };
  const alerts = useQuery({
    queryKey: staffKeys.alerts(filters),
    queryFn: ({ signal }) => fetchAlerts(filters, signal),
    enabled: can(me, 'alert.read'),
    refetchInterval: LIVE_REFETCH_MS,
  });

  if (!can(me, 'alert.read')) return <ForbiddenPage title={s04.title} />;

  const items = liveAlertsWithResolved(alerts.data?.items ?? [], severities);
  return (
    <div className="st-page">
      <Header title={s04.title} onBack={() => navigate(paths.ops)} />
      <AlertSoundBanner />
      <div className="st-section">
        <FilterChips
          label={staff.status}
          options={STATUSES.map((s) => ({ value: s, label: s04.statusFilter[s] }))}
          value={statuses}
          onChange={(v) => setStatuses(v as AlertStatus[])}
        />
        <FilterChips
          label={staff.severity}
          options={SEVERITIES.map((s) => ({ value: s, label: alertSeverity[s] }))}
          value={severities}
          onChange={(v) => setSeverities(v as AlertSeverity[])}
        />
        <Select
          id="alerts-type"
          label={staff.type}
          value={type}
          placeholder={staff.allTypes}
          options={(Object.keys(alertType) as AlertType[]).map((t) => [t, alertType[t]] as const)}
          onChange={(e) => setType(e.target.value as AlertType | '')}
        />
      </div>
      {alerts.isPending ? (
        <PageSkeleton />
      ) : alerts.isError && !alerts.data ? (
        <ReadError error={alerts.error} onRetry={() => void alerts.refetch()} />
      ) : (
        <AlertList me={me} alerts={items} />
      )}
    </div>
  );
}

/** Severity filter on the client when several are chosen (the API takes one); resolved ones stay listed. */
function liveAlertsWithResolved(items: Alert[], severities: AlertSeverity[]): Alert[] {
  const filtered = severities.length ? items.filter((a) => severities.includes(a.severity)) : items;
  return [...liveAlerts(filtered), ...filtered.filter((a) => a.status === 'resolved')];
}
