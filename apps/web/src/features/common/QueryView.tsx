import { ArrowRight, SearchX, ShieldX } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, displayMessage } from '@/api/errors';
import { Banner, EmptyState, Skeleton } from '@/components';
import { buttons, ui } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';

/**
 * The shared page states of 02 §1.6: first load = skeletons shaped like the content; a failed read =
 * Banner with «إعادة المحاولة» and «رمز المتابعة»; no permission / out of scope / not found = EmptyState
 * with «العودة».
 */
export function LoadingCards({ count = 2 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} />
      ))}
    </div>
  );
}

export function LoadError({
  error,
  onRetry,
  backTo,
}: {
  error: unknown;
  onRetry: () => void;
  backTo?: string;
}) {
  const navigate = useNavigate();
  if (error instanceof ApiError) {
    const back = backTo ? () => navigate(backTo) : () => navigate(-1);
    if (error.is('PERMISSION_DENIED')) {
      return (
        <EmptyState
          icon={ShieldX}
          title={ui.forbiddenPage}
          actionLabel={buttons.back}
          actionIcon={ArrowRight}
          onAction={back}
        />
      );
    }
    if (error.is('SCOPE_VENUE_DENIED')) {
      return (
        <EmptyState
          icon={ShieldX}
          title={ui.scopeDenied}
          actionLabel={buttons.back}
          actionIcon={ArrowRight}
          onAction={back}
        />
      );
    }
    if (error.is('RESOURCE_NOT_FOUND', 'TICKET_NOT_FOUND', 'OFFER_NOT_FOUND')) {
      return (
        <EmptyState
          icon={SearchX}
          title={ui.notFound}
          actionLabel={buttons.back}
          actionIcon={ArrowRight}
          onAction={back}
        />
      );
    }
  }
  const requestId = error instanceof ApiError ? error.requestId : null;
  return (
    <Banner
      kind="error"
      rounded
      message={displayMessage(error)}
      detail={requestId ? fmt(ui.requestId, { id: requestId }) : undefined}
      actionLabel={buttons.retry}
      onAction={onRetry}
    />
  );
}

/** Renders the first-load skeleton, the error state, or the data. */
export function QueryView<T>({
  query,
  children,
  skeleton,
  backTo,
}: {
  query: { data: T | undefined; error: unknown; isPending: boolean; refetch: () => unknown };
  children: (data: T) => ReactNode;
  skeleton?: ReactNode;
  backTo?: string;
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.error)
    return <LoadError error={query.error} onRetry={() => void query.refetch()} backTo={backTo} />;
  return <>{skeleton ?? <LoadingCards />}</>;
}
