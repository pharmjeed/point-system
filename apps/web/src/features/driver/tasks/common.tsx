import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SearchX } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { getTicket } from '@/api/field';
import { queryKeys } from '@/api/queryClient';
import type { TicketDetail } from '@/api/types';
import { paths } from '@/app/paths';
import { Banner, EmptyState, Header, Skeleton } from '@/components';
import { buttons, ui } from '@/i18n/ar';

/** `GET /v1/tickets/{ticketId}` — the full projection for the creator during intake or the assignee. */
export function useTicket(ticketId: string, options: { poll?: number | false } = {}) {
  return useQuery({
    queryKey: queryKeys.ticket(ticketId),
    queryFn: ({ signal }) => getTicket(ticketId, signal),
    enabled: !!ticketId,
    refetchInterval: options.poll ?? false,
    staleTime: 2000,
  });
}

/** Writes a command's ticket reply into the cache so the next screen starts from the server's version. */
export function useStoreTicket() {
  const qc = useQueryClient();
  return (ticket: TicketDetail) => qc.setQueryData(queryKeys.ticket(ticket.id), ticket);
}

/** The task screen frame: Header (back + title + an action), then the content (02 D-05 … D-11). */
export function TaskScreen({
  title,
  backTo,
  actions,
  children,
}: {
  title: ReactNode;
  backTo?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <section className="flex flex-col gap-4">
      <Header title={title} onBack={backTo ? () => navigate(backTo) : undefined} actions={actions} />
      {children}
    </section>
  );
}

export function TaskSkeleton() {
  return (
    <section className="flex flex-col gap-4">
      <Skeleton variant="line" width="60%" />
      <Skeleton />
      <Skeleton withAction />
    </section>
  );
}

/** The task or ticket is no longer this driver's (02 §1.9 «لم نجد هذا العنصر…» + «العودة»). */
export function TaskGone() {
  const navigate = useNavigate();
  return (
    <section className="flex flex-col gap-4">
      <EmptyState
        icon={SearchX}
        title={ui.notFound}
        actionLabel={buttons.back}
        onAction={() => navigate(paths.driverHome)}
      />
    </section>
  );
}

/** A command needs the server: the reason line under a disabled button (02 D-06, D-08, D-10, D-11). */
export function OfflineNote({ online, text }: { online: boolean; text: string }) {
  if (online) return null;
  return <Banner kind="offline" rounded message={text} />;
}
