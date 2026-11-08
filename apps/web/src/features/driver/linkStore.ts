import { create } from 'zustand';
import type { LinkCodeQr, WaLinkPending } from '@/api/types';

/**
 * The WhatsApp link of the tickets this driver is linking (02 D-05, D-06, D-07; 12 §7.1–§7.2), in memory for
 * the app session only — never in browser storage:
 * - the QR the driver issued: the link code and its wa.me link exist only in the reply of
 *   `POST /v1/tickets/{ticketId}/whatsapp-link` (09 §5.1 «للسائق الطالب فقط … طالما هو active»), so a reload
 *   shows «رمز جديد» instead;
 * - the method chosen in D-05 or D-07 (07 has no field for it: «طريقة الربط» is local, 02 D-05);
 * - the pending confirmation a `ticket.updated` carried (`wa_link_pending`, the creator's privileged payload):
 *   the confirmation dialog of D-07 still has the masked number when the ticket's projection no longer does
 *   (a parked ticket of its creator, docs/progress/notes/driver-gaps.md).
 * Sign-out and a session end clear it with the other field data (intakeStore `clearFieldData`).
 */
export type LinkMethod = 'direct' | 'qr';

interface LinkState {
  qr: Record<string, LinkCodeQr>;
  method: Record<string, LinkMethod>;
  pending: Record<string, WaLinkPending | null>;
  setQr: (ticketId: string, qr: LinkCodeQr | null) => void;
  setMethod: (ticketId: string, method: LinkMethod) => void;
  notePending: (ticketId: string, pending: WaLinkPending | null) => void;
  reset: () => void;
}

const without = <T>(map: Record<string, T>, key: string): Record<string, T> => {
  const { [key]: _gone, ...rest } = map;
  return rest;
};

export const useLinkStore = create<LinkState>()((set) => ({
  qr: {},
  method: {},
  pending: {},
  setQr: (ticketId, qr) => set((s) => ({ qr: qr ? { ...s.qr, [ticketId]: qr } : without(s.qr, ticketId) })),
  setMethod: (ticketId, method) => set((s) => ({ method: { ...s.method, [ticketId]: method } })),
  notePending: (ticketId, pending) => set((s) => ({ pending: { ...s.pending, [ticketId]: pending } })),
  reset: () => set({ qr: {}, method: {}, pending: {} }),
}));
