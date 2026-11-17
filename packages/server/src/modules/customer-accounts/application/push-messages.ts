import type {
  CustomerPushData,
  CustomerPushKind,
  CustomerSubscriptionPushKind,
} from '@point/shared/customer';

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

/** The visit kinds (C-12); the subscription kinds have their own texts below (V2-031, DEC-535). */
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
    data: {
      type: 'visit',
      kind: input.kind as 'car_received' | 'request_accepted' | 'car_ready' | 'pickup_reminder',
      visit_id: input.ticketId,
    },
  };
}

export interface CustomerSubscriptionPushTextInput {
  kind: CustomerPushKind;
  locale: 'ar' | 'en';
  subscriptionId: string;
  brand: { ar: string; en: string };
  venue: { ar: string; en: string | null };
  /** the end of the current period: the renewal day of the notice */
  renewsAt: Date | null;
  /** the new price announced by the notice (DEC-531), else null */
  newPriceHalalas: number | null;
}

/** `YYYY-MM-DD` of an instant in Asia/Riyadh (UTC+3, Western digits — canon rule 10). */
function riyadhDay(d: Date): string {
  return new Date(d.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
}

/** SAR with two decimals, Western digits: 30000 → 300.00 */
const sar = (halalas: number) => (halalas / 100).toFixed(2);

/**
 * The text of a subscription push (docs/v2/01 §3, 14; V2-031, DEC-535). The lock screen gets the customer brand, the
 * venue's public name, the renewal day and — only when a renewal notice announces a new price — that price: no
 * plate, no card, no name. `data` opens C-14.
 */
export function customerSubscriptionPushContent(
  input: CustomerSubscriptionPushTextInput,
): CustomerPushContent {
  const venue = input.locale === 'en' ? (input.venue.en ?? input.venue.ar) : input.venue.ar;
  const day = input.renewsAt ? riyadhDay(input.renewsAt) : null;
  let body: string;
  switch (input.kind) {
    case 'subscription_renewal':
      body =
        input.locale === 'en'
          ? `Your subscription at ${venue} renews on ${day ?? ''}` +
            (input.newPriceHalalas !== null ? ` at the new price of SAR ${sar(input.newPriceHalalas)}` : '')
          : `يتجدد اشتراكك في ${venue} يوم ${day ?? ''}` +
            (input.newPriceHalalas !== null ? ` بالسعر الجديد ${sar(input.newPriceHalalas)} ريال` : '');
      break;
    case 'subscription_payment_failed':
      body =
        input.locale === 'en'
          ? `We could not renew your subscription at ${venue}. Update your payment method`
          : `تعذّر تجديد اشتراكك في ${venue}. حدّث وسيلة الدفع`;
      break;
    case 'subscription_expired':
      body = input.locale === 'en' ? `Your subscription at ${venue} has ended` : `انتهى اشتراكك في ${venue}`;
      break;
    // V2-036 (DEC-595): a term renewed by hand ends soon — no charge; the new price when one was announced
    case 'subscription_ending':
      body =
        input.locale === 'en'
          ? `Your subscription at ${venue} ends on ${day ?? ''}. Renew it from the app after it ends` +
            (input.newPriceHalalas !== null ? ` (new price SAR ${sar(input.newPriceHalalas)})` : '')
          : `ينتهي اشتراكك في ${venue} يوم ${day ?? ''}. يمكنك تجديده من التطبيق بعد انتهائه` +
            (input.newPriceHalalas !== null ? ` (السعر الجديد ${sar(input.newPriceHalalas)} ريال)` : '');
      break;
    // V2-036 (DEC-596): the eligibility decision
    case 'subscription_eligibility_approved':
      body =
        input.locale === 'en'
          ? `Your eligibility for the subscription at ${venue} is confirmed. Pay to activate it`
          : `تم التحقق من أهليتك للاشتراك في ${venue}. ادفع لتفعيله`;
      break;
    case 'subscription_eligibility_rejected':
      body =
        input.locale === 'en'
          ? `We could not confirm your eligibility for the subscription at ${venue}`
          : `تعذّر التحقق من أهليتك للاشتراك في ${venue}`;
      break;
    // V2-036 (DEC-599): a holiday or closure announced at the location; the subscription keeps counting
    case 'subscription_venue_closure':
      body =
        input.locale === 'en'
          ? `A closure was announced at ${venue}. Open the app for the dates`
          : `أُعلن إغلاق في ${venue}. افتح التطبيق لمعرفة التواريخ`;
      break;
    default:
      throw new Error(`customer push kind ${input.kind} is not a subscription kind`);
  }
  return {
    title: input.locale === 'en' ? input.brand.en : input.brand.ar,
    body,
    data: {
      type: 'subscription',
      kind: input.kind as CustomerSubscriptionPushKind,
      subscription_id: input.subscriptionId,
    },
  };
}
