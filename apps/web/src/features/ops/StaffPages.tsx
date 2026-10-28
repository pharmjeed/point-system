import { Activity, ArrowRight, Building2, ChartColumn, ShieldCheck, ShieldX, Users } from 'lucide-react';
import { useNavigate } from 'react-router';
import { canAdmin, paths } from '@/app/paths';
import { EmptyState } from '@/components';
import { PlaceholderPage } from '@/features/common/PlaceholderPage';
import { buttons, nav, ui } from '@/i18n/ar';
import { useStaffMe } from './StaffLayout';

/** S-02 shell; the live operations board is PNT-074. */
export function OpsPage() {
  return <PlaceholderPage title={nav.ops} icon={Activity} />;
}

/** S-05 shell (PNT-023 / PNT-076). */
export function DriversPage() {
  return <PlaceholderPage title={nav.drivers} icon={Users} />;
}

/** S-08 shell (PNT-023). */
export function VenuesPage() {
  return <PlaceholderPage title={nav.venues} icon={Building2} />;
}

/** S-11 shell (PNT-086…). */
export function ReportsPage() {
  return <PlaceholderPage title={nav.reports} icon={ChartColumn} />;
}

/** S-13 shell, only for whoever holds an admin permission (02 §2.2); others see the forbidden state. */
export function AdminPage() {
  const me = useStaffMe();
  const navigate = useNavigate();
  if (!canAdmin(me)) {
    return (
      <EmptyState
        icon={ShieldX}
        title={ui.forbiddenPage}
        actionLabel={buttons.back}
        actionIcon={ArrowRight}
        onAction={() => navigate(paths.ops)}
      />
    );
  }
  return <PlaceholderPage title={nav.admin} icon={ShieldCheck} />;
}
