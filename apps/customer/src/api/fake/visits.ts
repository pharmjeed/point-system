/**
 * The fake backend's visits (V2-015 C-12/C-16/C-13, DEC-516 … DEC-518): the server's rules for the app's flows in
 * development and tests — the request as the WhatsApp button's command (an early request while parking, one open
 * request), the handover code only while ready, the rating once after the delivery, and the minimal
 * `visit.updated` projection to the account's listeners. Time moves the visit along like a driver would (accepted,
 * on the way, ready, then delivered) so the live screen can be seen without a server; tests drive it by the clock.
 */
import type {
  CustomerHandoverCode,
  CustomerLocationDetail,
  CustomerVisitDetail,
  CustomerVisitRating,
  CustomerVisitSummary,
  CustomerVisitUpdated,
} from '@point/shared/customer';

type TicketStatus = CustomerVisitSummary['status'];

/** When a requested visit moves on by itself (ms after the request). */
export const FAKE_VISIT_STEPS_MS = { accepted: 15_000, onTheWay: 45_000, ready: 90_000, delivered: 270_000 };
const CODE_TTL_MS = 30 * 60_000;

export interface FakeVisit {
  ticketId: string;
  accountId: string;
  venue: CustomerLocationDetail;
  status: TicketStatus;
  plate: string | null;
  vehicleMake: string | null;
  vehicleColor: string | null;
  receivedAt: number;
  parkedAt: number | null;
  /** the parking finishes at this time (an early request converts then) */
  parksAt: number | null;
  requestedAt: number | null;
  pendingEarly: boolean;
  acceptedAt: number | null;
  startedAt: number | null;
  readyAt: number | null;
  deliveredAt: number | null;
  code: string | null;
  codeExpiresAt: number | null;
  rating: CustomerVisitRating | null;
}

export class FakeReject extends Error {
  constructor(
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const OPEN = new Set<TicketStatus>([
  'received',
  'parking',
  'parked',
  'requested',
  'assigned',
  'assigned_waiting',
  'retrieving',
  'ready',
  'reparking',
]);

/** V2-022: the visit's latest payment in the app, as the fake backend's payments know it. */
export type FakeVisitPaymentOf = (
  ticketId: string,
) => { payment_id: string; status: 'initiated' | 'paid' | 'failed'; paid_at: string | null } | null;

export function createFakeVisits(deps: {
  now: () => number;
  random: () => number;
  paymentOf?: FakeVisitPaymentOf;
}) {
  const visits = new Map<string, FakeVisit>();
  const listeners = new Map<string, Set<(e: CustomerVisitUpdated) => void>>();

  const emit = (v: FakeVisit) => {
    for (const fn of listeners.get(v.accountId) ?? [])
      fn({ ticket_id: v.ticketId, status: v.status, open: OPEN.has(v.status) });
  };

  /** Applies what the clock says happened; true when the visit changed. */
  function progress(v: FakeVisit): boolean {
    const now = deps.now();
    const before = v.status;
    if ((v.status === 'parking' || v.status === 'received') && v.parksAt !== null && now >= v.parksAt) {
      v.status = 'parked';
      v.parkedAt = v.parksAt;
      if (v.pendingEarly) {
        v.pendingEarly = false;
        v.status = 'requested';
      }
    }
    const t0 = v.requestedAt;
    if (t0 !== null && v.status !== 'delivered') {
      const at = (ms: number) => Math.max(t0, v.parkedAt ?? t0) + ms;
      if (v.status === 'requested' && now >= at(FAKE_VISIT_STEPS_MS.accepted)) {
        v.status = 'assigned';
        v.acceptedAt = at(FAKE_VISIT_STEPS_MS.accepted);
      }
      if (v.status === 'assigned' && now >= at(FAKE_VISIT_STEPS_MS.onTheWay)) {
        v.status = 'retrieving';
        v.startedAt = at(FAKE_VISIT_STEPS_MS.onTheWay);
      }
      if (v.status === 'retrieving' && now >= at(FAKE_VISIT_STEPS_MS.ready)) {
        v.status = 'ready';
        v.readyAt = at(FAKE_VISIT_STEPS_MS.ready);
        v.code = Array.from({ length: 6 }, () => Math.floor(deps.random() * 10)).join('');
        v.codeExpiresAt = v.readyAt + CODE_TTL_MS;
      }
      if (v.status === 'ready' && now >= at(FAKE_VISIT_STEPS_MS.delivered)) deliver(v);
    }
    return v.status !== before;
  }

  function deliver(v: FakeVisit) {
    v.status = 'delivered';
    v.deliveredAt = deps.now();
    v.code = null;
    v.codeExpiresAt = null;
  }

  function summary(v: FakeVisit): CustomerVisitSummary {
    return {
      ticket_id: v.ticketId,
      venue_id: v.venue.venue_id,
      venue_name_ar: v.venue.name_ar,
      venue_name_en: v.venue.name_en,
      operator_name_ar: v.venue.operator_name_ar,
      operator_name_en: v.venue.operator_name_en,
      status: v.status,
      open: OPEN.has(v.status),
      channel: 'app',
      plate_display: v.plate,
      received_at: iso(v.receivedAt)!,
      delivered_at: iso(v.deliveredAt),
      duration_min:
        v.deliveredAt === null ? null : Math.max(0, Math.floor((v.deliveredAt - v.receivedAt) / 60_000)),
      payment: paymentOf(v),
      rated: v.rating !== null,
    };
  }

  // V2-022 (DEC-521, DEC-522): paid in the app → collected / app_paid; «ادفع» while the fee is due
  function paymentOf(v: FakeVisit): CustomerVisitSummary['payment'] {
    const online = deps.paymentOf?.(v.ticketId) ?? null;
    const fee = v.venue.pay_per_visit_halalas ?? 0;
    const paid = online?.status === 'paid';
    return {
      entitlement: paid ? 'app_paid' : 'none',
      payment_status: paid ? 'collected' : fee ? 'due' : 'not_required',
      fee_halalas: fee,
      payable_in_app: !paid && fee >= 100 && OPEN.has(v.status),
      online_payment: online,
    };
  }

  function detail(v: FakeVisit): CustomerVisitDetail {
    const parking = v.status === 'received' || v.status === 'parking' || v.status === 'reparking';
    const live = v.status === 'ready' && v.code !== null && (v.codeExpiresAt ?? 0) > deps.now();
    return {
      ...summary(v),
      timeline: [
        { step: 'received', at: iso(v.receivedAt) },
        { step: 'parked', at: iso(v.parkedAt) },
        { step: 'requested', at: iso(v.requestedAt) },
        { step: 'accepted', at: iso(v.acceptedAt) },
        { step: 'on_the_way', at: iso(v.startedAt) },
        { step: 'ready', at: iso(v.readyAt) },
        { step: 'delivered', at: iso(v.deliveredAt) },
      ],
      request: {
        can_request: (v.status === 'parked' && v.requestedAt === null) || (parking && v.requestedAt === null),
        pending_early: v.pendingEarly,
        requested_at: iso(v.requestedAt),
      },
      handover: {
        method: 'app_code',
        code_available: live,
        code_expires_at: live ? iso(v.codeExpiresAt) : null,
      },
      photos: [],
      rating: v.rating,
      can_rate: v.status === 'delivered' && v.rating === null,
      vehicle_make: v.vehicleMake,
      vehicle_color: v.vehicleColor,
    };
  }

  function own(accountId: string, ticketId: string): FakeVisit {
    const v = visits.get(ticketId);
    if (!v || v.accountId !== accountId)
      throw new FakeReject('RESOURCE_NOT_FOUND', { resource: 'customer_visit' });
    if (progress(v)) emit(v);
    return v;
  }

  return {
    /** A visit of the account (the driver's intake by pass, O-01). */
    add(v: Omit<FakeVisit, 'pendingEarly' | 'rating' | 'code' | 'codeExpiresAt'>): FakeVisit {
      const visit: FakeVisit = { ...v, pendingEarly: false, rating: null, code: null, codeExpiresAt: null };
      visits.set(v.ticketId, visit);
      return visit;
    },
    list(accountId: string): CustomerVisitSummary[] {
      return [...visits.values()]
        .filter((v) => v.accountId === accountId)
        .map((v) => {
          if (progress(v)) emit(v);
          return v;
        })
        .sort((a, b) => b.receivedAt - a.receivedAt || (a.ticketId < b.ticketId ? 1 : -1))
        .map(summary);
    },
    open(accountId: string): FakeVisit | null {
      return (
        [...visits.values()]
          .filter((v) => v.accountId === accountId)
          .map((v) => {
            if (progress(v)) emit(v);
            return v;
          })
          .filter((v) => OPEN.has(v.status))
          .sort((a, b) => b.receivedAt - a.receivedAt)[0] ?? null
      );
    },
    detail: (accountId: string, ticketId: string) => detail(own(accountId, ticketId)),
    request(accountId: string, ticketId: string) {
      const v = own(accountId, ticketId);
      if (v.status === 'delivered') throw new FakeReject('TICKET_CLOSED', { ticket_status: v.status });
      if (v.requestedAt !== null)
        throw new FakeReject('RETRIEVAL_ALREADY_ACTIVE', { ticket_status: v.status });
      v.requestedAt = deps.now();
      let outcome: 'requested' | 'requested_early' = 'requested';
      if (v.status === 'parked') v.status = 'requested';
      else {
        v.pendingEarly = true;
        outcome = 'requested_early';
      }
      emit(v);
      return { outcome, visit: detail(v) };
    },
    code(accountId: string, ticketId: string): CustomerHandoverCode {
      const v = own(accountId, ticketId);
      if (v.status !== 'ready') throw new FakeReject('HANDOVER_NOT_READY', { ticket_status: v.status });
      if (!v.code || (v.codeExpiresAt ?? 0) <= deps.now())
        throw new FakeReject('HANDOVER_CODE_UNAVAILABLE', { reason: 'expired' });
      return { ticket_id: v.ticketId, code: v.code, expires_at: iso(v.codeExpiresAt)!, attempts_left: 5 };
    },
    rate(
      accountId: string,
      ticketId: string,
      body: { stars: number; note?: string | null },
    ): CustomerVisitRating {
      const v = own(accountId, ticketId);
      if (v.status !== 'delivered')
        throw new FakeReject('CUSTOMER_VISIT_NOT_DELIVERED', { ticket_status: v.status });
      if (v.rating) throw new FakeReject('CUSTOMER_VISIT_ALREADY_RATED');
      v.rating = {
        ticket_id: v.ticketId,
        stars: body.stars,
        note: body.note ?? null,
        rated_at: iso(deps.now())!,
      };
      return v.rating;
    },
    /** The driver hands the car over (tests, and the dev clock after ready). */
    deliver(ticketId: string) {
      const v = visits.get(ticketId);
      if (!v) return;
      deliver(v);
      emit(v);
    },
    hasOpen(accountId: string): boolean {
      return [...visits.values()].some((v) => v.accountId === accountId && OPEN.has(v.status));
    },
    /** Moves every visit along the clock and tells the listeners (the dev loop calls it every few seconds). */
    tick() {
      for (const v of visits.values()) if (progress(v)) emit(v);
    },
    subscribe(accountId: string, fn: (e: CustomerVisitUpdated) => void): () => void {
      let set = listeners.get(accountId);
      if (!set) listeners.set(accountId, (set = new Set()));
      set.add(fn);
      return () => set.delete(fn);
    },
    removeAccount(accountId: string) {
      for (const [id, v] of visits) if (v.accountId === accountId) visits.delete(id);
      listeners.delete(accountId);
    },
  };
}

export type FakeVisits = ReturnType<typeof createFakeVisits>;
