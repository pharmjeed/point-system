import { useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import type { ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { ApiError } from '@/api/errors';
import {
  PLATFORM_SIGNED_OUT_CODES,
  platformLogout,
  platformPendingStep,
  type PlatformMe,
} from '@/api/platform';
import { queryKeys } from '@/api/queryClient';
import { paths } from '@/app/paths';
import { AppShell, Button, EmptyState, TopBar } from '@/components';
import { BootSkeleton } from '@/features/system/SystemPages';
import { useSubmitGuard } from '@/hooks/useCommand';
import { useThemeArea } from '@/hooks/useThemeArea';
import { buttons } from '@/i18n/ar';
import { p01 } from '@/i18n/ar.staff';
import { usePlatformMe } from './usePlatformMe';

/**
 * The platform console's frame (V2-002, V2-004): the staff theme, the console title and the logout button. Without a
 * platform session (or with a restricted one) it sends to /platform/login; the pages render inside with the account.
 */
export function PlatformShell({ children }: { children: (me: PlatformMe) => ReactNode }) {
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
      {children(me.data)}
    </AppShell>
  );
}
