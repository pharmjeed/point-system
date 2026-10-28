import { ArrowRight, Lock, SearchX } from 'lucide-react';
import { Navigate, useNavigate } from 'react-router';
import { homePathFor, paths } from '@/app/paths';
import { sessionEndText } from '@/app/sessionEnd';
import { Button, EmptyState, Icon, Skeleton } from '@/components';
import { useMe } from '@/hooks/useMe';
import { useThemeArea } from '@/hooks/useThemeArea';
import { buttons, d15, ui } from '@/i18n/ar';
import { useSessionStore } from '@/stores/session';

/** D-15 (c) — session ended or revoked (full screen, assertive). */
export function SessionEndedPage() {
  useThemeArea('driver');
  const navigate = useNavigate();
  const ended = useSessionStore((s) => s.ended);
  return (
    <div className="pt-auth">
      <main className="pt-auth__main justify-center" id="main" role="alert" aria-live="assertive">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="pt-empty__icon">
            <Icon icon={Lock} size={28} />
          </span>
          <h1 className="pt-page-title">{d15.sessionTitle}</h1>
          <p className="m-0 text-text-muted">{sessionEndText(ended)}</p>
        </div>
        <Button size="lg" onClick={() => navigate(paths.login, { replace: true })}>
          {d15.login}
        </Button>
      </main>
    </div>
  );
}

export function BootSkeleton() {
  return (
    <div className="pt-shell">
      <main className="pt-shell__main">
        <Skeleton />
      </main>
    </div>
  );
}

/** `/` — send the user to their shell, or to D-01. */
export function RootRedirect() {
  const me = useMe();
  if (me.data) return <Navigate to={homePathFor(me.data)} replace />;
  if (me.error) return <Navigate to={paths.login} replace />;
  return <BootSkeleton />;
}

export function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <div className="pt-shell">
      <main className="pt-shell__main" id="main">
        <EmptyState
          icon={SearchX}
          title={ui.notFoundPage}
          actionLabel={buttons.back}
          actionIcon={ArrowRight}
          onAction={() => navigate('/', { replace: true })}
        />
      </main>
    </div>
  );
}
