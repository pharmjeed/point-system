import type { QueryClient } from '@tanstack/react-query';
import type { Alert, OperationsBoard } from '@/api/types';
import { staffKeys, type Page } from './staffApi';

/**
 * Applies a command's reply to the cached lists at once (no optimistic guess: this is the server's answer),
 * so an acknowledged alert stops its sound without waiting for the next refresh (07 §2.7 `acknowledge`).
 * The same shape a realtime `alert.updated` will use (PNT-064/065).
 */
export function applyAlertReply(qc: QueryClient, alert: Alert): void {
  qc.setQueriesData<Page<Alert>>({ queryKey: staffKeys.alerts() }, (page) =>
    page ? { ...page, items: page.items.map((a) => (a.id === alert.id ? alert : a)) } : page,
  );
  qc.setQueriesData<OperationsBoard>({ queryKey: staffKeys.boards() }, (board) =>
    board ? { ...board, alerts: board.alerts.map((a) => (a.id === alert.id ? alert : a)) } : board,
  );
}
