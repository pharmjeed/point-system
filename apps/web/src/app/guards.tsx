import { useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { ApiError, displayMessage } from '@/api/errors';
import type { Me } from '@/api/types';
import { Banner, Skeleton } from '@/components';
import { useMe } from '@/hooks/useMe';
import { buttons, ui } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { useSessionStore } from '@/stores/session';
import { areaOf, canUseDriverShell, homePathFor, paths, restrictedStaffStep } from './paths';
import { isSessionEndError, sessionEndFrom, sessionEndPath } from './sessionEnd';

function FirstLoad() {
  // 02 §1.6: first load shows skeletons shaped like the content, never a full-screen spinner.
  return (
    <div className="pt-shell">
      <main className="pt-shell__main">
        <Skeleton />
        <Skeleton withAction />
      </main>
    </div>
  );
}

function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const requestId = error instanceof ApiError ? error.requestId : null;
  return (
    <div className="pt-shell">
      <Banner
        kind="error"
        message={displayMessage(error)}
        detail={requestId ? fmt(ui.requestId, { id: requestId }) : undefined}
        actionLabel={buttons.retry}
        onAction={onRetry}
      />
    </div>
  );
}

function SessionEnded({ error }: { error: ApiError }) {
  const location = useLocation();
  const endSession = useSessionStore((s) => s.endSession);
  const end = sessionEndFrom(error);
  useEffect(() => {
    endSession(sessionEndFrom(error));
  }, [error, endSession]);
  return <Navigate to={sessionEndPath(end, areaOf(location.pathname))} replace />;
}

/** Renders `children(me)` for any signed-in session, restricted ones included (D-02, S-01 steps 3–4). */
export function RequireSession({ children }: { children: (me: Me) => ReactNode }) {
  const me = useMe();
  if (me.data) return <>{children(me.data)}</>;
  if (me.error) {
    if (me.error instanceof ApiError && isSessionEndError(me.error)) return <SessionEnded error={me.error} />;
    return <LoadError error={me.error} onRetry={() => void me.refetch()} />;
  }
  return <FirstLoad />;
}

/** Driver area (D-03…D-14): drivers and supervisors with can_drive (DEC-22); PIN change first. */
export function RequireDriver({ children }: { children: (me: Me) => ReactNode }) {
  return (
    <RequireSession>
      {(me) => {
        if (me.user.role === 'driver' && me.user.must_change_secret)
          return <Navigate to={paths.changeSecret} replace />;
        if (restrictedStaffStep(me)) return <Navigate to={paths.staffLogin} replace />;
        if (!canUseDriverShell(me)) return <Navigate to={homePathFor(me)} replace />;
        return children(me);
      }}
    </RequireSession>
  );
}

/** Supervisor/admin/owner area (S-02…S-13); restricted sessions finish S-01 first. */
export function RequireStaff({ children }: { children: (me: Me) => ReactNode }) {
  return (
    <RequireSession>
      {(me) => {
        if (me.user.role === 'driver') return <Navigate to={homePathFor(me)} replace />;
        if (restrictedStaffStep(me)) return <Navigate to={paths.staffLogin} replace />;
        return children(me);
      }}
    </RequireSession>
  );
}
