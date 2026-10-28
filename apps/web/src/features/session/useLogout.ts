import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { logout } from '@/api/auth';
import { ApiError, displayMessage } from '@/api/errors';
import { paths } from '@/app/paths';
import { useSubmitGuard } from '@/hooks/useCommand';
import { useSessionStore } from '@/stores/session';
import { useUiStore } from '@/stores/ui';

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
      try {
        await logout();
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 401)) {
          pushToast({ message: displayMessage(error), tone: 'error' });
          return;
        }
      }
      qc.clear();
      reset();
      navigate(area === 'staff' ? paths.staffLogin : paths.login, { replace: true });
    });
  return { run, pending };
}
