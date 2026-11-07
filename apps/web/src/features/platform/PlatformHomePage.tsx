import { useQueryClient } from '@tanstack/react-query';
import { LayoutDashboard, LogOut } from 'lucide-react';
import { Navigate, useNavigate } from 'react-router';
import { ApiError } from '@/api/errors';
import { PLATFORM_SIGNED_OUT_CODES, platformLogout, platformPendingStep } from '@/api/platform';
import { queryKeys } from '@/api/queryClient';
import { paths } from '@/app/paths';
import { AppShell, Button, Card, EmptyState, TopBar } from '@/components';
import { BootSkeleton } from '@/features/system/SystemPages';
import { useSubmitGuard } from '@/hooks/useCommand';
import { useThemeArea } from '@/hooks/useThemeArea';
import { buttons } from '@/i18n/ar';
import { p01 } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { usePlatformMe } from './usePlatformMe';

/**
 * `/platform` — the platform console shell (V2-002). P-01 is a placeholder with the signed-in account and the
 * logout button; the platform screens P-01 … P-12 (docs/v2/02 §2) are built by the next V2 tickets. Without a
 * platform session (or with a restricted one) it sends to /platform/login.
 */
export function PlatformHomePage() {
  useThemeArea('staff');
  const me = usePlatformMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { guard, pending } = useSubmitGuard();

  if (me.isPending) return <BootSkeleton />;
  if (me.error) {
    const code = me.error instanceof ApiError ? me.error.code : null;
    if (code && PLATFORM_SIGNED_OUT_CODES.includes(code))
      return <Navigate to={paths.platformLogin} replace />;
    return (
      <AppShell topBar={<TopBar title={p01.shellTitle} />}>
        <EmptyState title={me.error instanceof ApiError ? me.error.message_ar : p01.shellTitle}>
          <Button variant="secondary" onClick={() => void me.refetch()}>
            {buttons.retry}
          </Button>
        </EmptyState>
      </AppShell>
    );
  }
  if (platformPendingStep(me.data)) return <Navigate to={paths.platformLogin} replace />;

  const user = me.data.user;
  const logout = () =>
    guard(async () => {
      try {
        await platformLogout();
      } finally {
        qc.removeQueries({ queryKey: queryKeys.platformMe });
        navigate(paths.platformLogin, { replace: true });
      }
    });

  return (
    <AppShell
      topBar={
        <TopBar
          title={p01.shellTitle}
          actions={
            <Button variant="secondary" iconStart={LogOut} loading={pending} onClick={() => void logout()}>
              {p01.logout}
            </Button>
          }
        />
      }
    >
      <h1 className="pt-page-title">{p01.overviewTitle}</h1>
      <Card>
        <p className="m-0 font-bold">{fmt(p01.welcome, { name: user.full_name })}</p>
        <p className="m-0 text-sm text-text-muted">{p01.role[user.role]}</p>
      </Card>
      <EmptyState icon={LayoutDashboard} title={p01.placeholder} />
    </AppShell>
  );
}
