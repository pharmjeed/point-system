import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router';
import { onApiError, onApiSuccess } from '@/api/client';
import { queryKeys } from '@/api/queryClient';
import { clearFieldData } from '@/features/driver/intakeStore';
import { useOnlineListener } from '@/hooks/useOnline';
import { applyTheme } from '@/lib/theme';
import { ui } from '@/i18n/ar';
import { useSessionStore } from '@/stores/session';
import { useUiStore } from '@/stores/ui';
import { areaOf, paths } from './paths';
import { isSessionEndError, sessionEndFrom, sessionEndPath } from './sessionEnd';

const PUBLIC_PATHS: string[] = [paths.login, paths.staffLogin, paths.sessionEnded];

/**
 * App-wide effects: connectivity, last sync, theme, and the session-level error codes (08 §3 `relogin`,
 * 02 §1.6/§1.9) raised by any request outside the auth endpoints:
 * - AUTH_UNAUTHENTICATED / _EXPIRED / _REVOKED → clear caches; driver to D-15 (c) or D-01, staff to S-01;
 * - AUTH_SECRET_CHANGE_REQUIRED → D-02 (driver) or S-01 step 3; AUTH_MFA_SETUP_REQUIRED → S-01 step 4;
 * - PERMISSION_DENIED → toast + refetch /v1/me (08 §8.6).
 */
export function RootLayout() {
  useOnlineListener();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const themes = useUiStore((s) => s.themes);
  const themeArea = useUiStore((s) => s.themeArea);
  const markSynced = useUiStore((s) => s.markSynced);
  const pushToast = useUiStore((s) => s.pushToast);
  const endSession = useSessionStore((s) => s.endSession);
  const goToStaffStep = useSessionStore((s) => s.goToStaffStep);

  useEffect(() => {
    applyTheme(themes[themeArea]);
  }, [themes, themeArea]);

  useEffect(() => onApiSuccess(({ meta }) => markSynced(meta.server_time)), [markSynced]);

  useEffect(
    () =>
      onApiError((error, event) => {
        if (event.path.startsWith('/v1/auth/')) return; // the sign-in screens handle their own errors
        const pathname = window.location.pathname;
        if (PUBLIC_PATHS.includes(pathname)) return;
        const area = areaOf(pathname);
        if (isSessionEndError(error)) {
          const end = sessionEndFrom(error);
          endSession(end);
          qc.clear();
          clearFieldData();
          navigate(sessionEndPath(end, area), { replace: true });
        } else if (error.code === 'AUTH_SECRET_CHANGE_REQUIRED') {
          if (area === 'staff') goToStaffStep('password');
          void qc.invalidateQueries({ queryKey: queryKeys.me });
          navigate(area === 'staff' ? paths.staffLogin : paths.changeSecret, { replace: true });
        } else if (error.code === 'AUTH_MFA_SETUP_REQUIRED') {
          goToStaffStep('mfa-setup');
          void qc.invalidateQueries({ queryKey: queryKeys.me });
          navigate(paths.staffLogin, { replace: true });
        } else if (error.code === 'PERMISSION_DENIED' && event.method !== 'GET') {
          pushToast({ message: error.message_ar || ui.permissionDenied, tone: 'error' });
          void qc.invalidateQueries({ queryKey: queryKeys.me });
        }
      }),
    [endSession, goToStaffStep, navigate, pushToast, qc],
  );

  return <Outlet />;
}
