/**
 * «اطلب السيارة» as one command for both places that offer it (V2-UX option B, DEC-581): C-06's live card and the
 * C-12 bottom sheet, each behind the swipe control (DEC-583). The same command as V2-015: `POST
 * /v1/customer/visits/{ticketId}/request` with an `Idempotency-Key` reused on a retry after a network error and
 * renewed once the server accepted it or said a request is already open (`CommandKey`), so a second swipe or a
 * retried request never asks twice. The screen shows the outcome as a banner and moves to the state the server
 * returned.
 */
import type { CustomerVisitDetail } from '@point/shared/customer';
import { ApiError } from '../api/errors';
import { NetworkError } from '../api/transport';
import type { Dictionary } from '../i18n';
import type { CommandKey } from './commandKey';

export type RequestCarResult =
  | { kind: 'requested'; visit: CustomerVisitDetail; text: string }
  /** a request is already open: nothing new was asked */
  | { kind: 'already'; text: string }
  /** no network: the request may not have reached the server; the same key is kept for the retry */
  | { kind: 'offline'; text: string }
  | { kind: 'refused'; error: unknown };

export interface RequestCarApi {
  requestVisit(
    ticketId: string,
    idempotencyKey?: string,
  ): Promise<{ outcome: 'requested' | 'requested_early'; visit: CustomerVisitDetail }>;
}

export async function requestCar(
  api: RequestCarApi,
  ticketId: string,
  key: CommandKey,
  dict: Dictionary,
): Promise<RequestCarResult> {
  try {
    const r = await api.requestVisit(ticketId, key.for(`request:${ticketId}`));
    key.reset();
    return {
      kind: 'requested',
      visit: r.visit,
      text: r.outcome === 'requested_early' ? dict.visit.requestedEarly : dict.visit.requested,
    };
  } catch (e) {
    if (e instanceof NetworkError) return { kind: 'offline', text: dict.visit.offline };
    if (e instanceof ApiError && e.code === 'RETRIEVAL_ALREADY_ACTIVE') {
      key.reset();
      return { kind: 'already', text: dict.visit.alreadyRequested };
    }
    // as V2-015: any other refusal keeps the key (the server answers the same key with the same refusal)
    return { kind: 'refused', error: e };
  }
}
