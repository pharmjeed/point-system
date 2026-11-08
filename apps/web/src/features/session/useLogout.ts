import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { logout } from '@/api/auth';
import { ApiError, displayMessage } from '@/api/errors';
import { queryKeys } from '@/api/queryClient';
import type { Me } from '@/api/types';
import { paths } from '@/app/paths';
import { forgetUserDrafts } from '@/features/driver/intakePersistence';
import { clearFieldData } from '@/features/driver/intakeStore';
import { resetHomeRegistry } from '@/features/driver/useDriverHome';
import { useSubmitGuard } from '@/hooks/useCommand';
import { closeShownNotifications } from '@/pwa/register';
import { stopRealtime } from '@/realtime/manager';
import { useSessionStore } from '@/stores/session';
import { useUiStore } from '@/stores/ui';
import { flushTelemetry, stopTelemetry } from '@/lib/telemetry';

/**
 * POST /v1/auth/logout, then clear every in-memory cache and go to D-01 / S-01 (02 D-14). A 401 means the
 * session is already gone, which is fine. On a network failure the user stays (the server session is
 * still valid) and sees the error.
 */
export function useLogout(area: 'driver' | 'staff') {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const reset = useSessionStore((s) => s.reset);
  const pushToast = useUiStore((s) => s.pushToast);
  const { guard, pending } = useSubmitGuard();
  const run = () =>
    guard(async () => {
      // the session's measurements leave while it is still valid (bounded: never holds the sign-out up)
      await Promise.race([flushTelemetry(), new Promise((r) => setTimeout(r, 1500))]);
      try {
        await logout();
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 401)) {
          pushToast({ message: displayMessage(error), tone: 'error' });
          return;
        }
      }
      stopRealtime();
      stopTelemetry();
      resetHomeRegistry();
      // sign-out takes the local intake drafts of this user with it (03 §4.3, 05 §14; PNT-071)
      await forgetUserDrafts(qc.getQueryData<Me>(queryKeys.me)?.user.id);
      qc.clear();
      reset();
      clearFieldData();
      void closeShownNotifications(); // no request of this session stays in the notification centre
      navigate(area === 'staff' ? paths.staffLogin : paths.login, { replace: true });
    });
  return { run, pending };
}
