import type { CustomerPushData, CustomerPushKind } from '@point/shared/customer';

/**
 * The text of a customer push (docs/v2/01 §3, V2-016, DEC-520). What reaches the lock screen is generic by design
 * (DEC-23): the customer brand as the title, one fixed sentence as the body, and — for «استلمنا سيارتك» only, as the
 * table of docs/v2/01 §3 writes it — the venue's public name. Never a plate, a parking spot, a key slot, the handover
 * code, the customer's name or phone. `data` carries opaque ids only (the app opens C-12 from it).
 */
export interface CustomerPushContent {
  title: string;
  body: string;
  data: CustomerPushData;
}

/** A provider-neutral message: the token of one device and its content. */
export interface CustomerPushMessage extends CustomerPushContent {
  to: string;
}

export interface CustomerPushTextInput {
  kind: CustomerPushKind;
  locale: 'ar' | 'en';
  ticketId: string;
  /** BRAND_CUSTOMER_NAME_AR / _EN (canon rule 11: never a literal) */
  brand: { ar: string; en: string };
  venue: { ar: string; en: string | null } | null;
}

type Texts = Record<'ar' | 'en', (venue: string | null) => string>;

const VISIT_TEXTS: Partial<Record<CustomerPushKind, Texts>> = {
  car_received: {
    ar: (venue) => (venue ? `استلمنا سيارتك في ${venue}` : 'استلمنا سيارتك'),
    en: (venue) => (venue ? `We have your car at ${venue}` : 'We have your car'),
  },
  request_accepted: {
    ar: () => 'سائقنا في طريقه إلى سيارتك',
    en: () => 'Our driver is on the way to your car',
  },
  car_ready: {
    ar: () => 'سيارتك جاهزة عند البوابة',
    en: () => 'Your car is ready at the gate',
  },
  pickup_reminder: {
    ar: () => 'سيارتك ما زالت بانتظارك',
    en: () => 'Your car is still waiting for you',
  },
};

/** The visit kinds this release sends; the subscription kinds are reserved (V4). */
export const CUSTOMER_VISIT_PUSH_KINDS = Object.keys(VISIT_TEXTS) as CustomerPushKind[];

/** Only «استلمنا سيارتك» names the venue (docs/v2/01 §3); every other body is the same for every visit. */
const NAMES_VENUE: ReadonlySet<CustomerPushKind> = new Set(['car_received']);

export function customerPushContent(input: CustomerPushTextInput): CustomerPushContent {
  const texts = VISIT_TEXTS[input.kind];
  if (!texts) throw new Error(`customer push kind ${input.kind} is reserved`);
  const venue =
    NAMES_VENUE.has(input.kind) && input.venue
      ? input.locale === 'en'
        ? (input.venue.en ?? input.venue.ar)
        : input.venue.ar
      : null;
  return {
    title: input.locale === 'en' ? input.brand.en : input.brand.ar,
    body: texts[input.locale](venue),
    data: { type: 'visit', kind: input.kind, visit_id: input.ticketId },
  };
}
