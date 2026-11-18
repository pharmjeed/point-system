import type { TicketEntitlement } from '@/api/types';
import { entitlementBadge } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { formatHalalas } from '@/lib/format';

/**
 * O-02 (V2-014, DEC-502): the entitlement badge of a ticket — «مشمول» (the event is included), «مشترك {brand}»
 * (V2-033: a subscription covers the visit, the staff brand filled in), «مدفوع في التطبيق» (phase V3), or «يدفع X» while the fee is due at the handover (V1's cash/POS, DEC-210)
 * — «يدفع عند التسليم» for a viewer who does not see the fee (the intake driver, 09 §5.1). Nothing for a ticket with
 * nothing to say (a fee already collected or waived). Pure: unit-tested.
 */
export interface EntitlementBadge {
  tone: 'included' | 'pays';
  text: string;
}

/** The fee due: its amount when the viewer sees it, `null` when only the due state is visible. */
export type FeeDue = { amountHalalas: number | null } | null;

export function entitlementBadgeOf(
  entitlement: TicketEntitlement | undefined,
  due: FeeDue,
  brand = '',
): EntitlementBadge | null {
  switch (entitlement) {
    case 'event_included':
      return { tone: 'included', text: entitlementBadge.included };
    case 'subscription':
      return { tone: 'included', text: fmt(entitlementBadge.subscription, { brand }).trim() };
    case 'app_paid':
      return { tone: 'included', text: entitlementBadge.appPaid };
    default:
      if (!due) return null;
      if (due.amountHalalas === null) return { tone: 'pays', text: entitlementBadge.paysAtHandover };
      return due.amountHalalas > 0
        ? { tone: 'pays', text: fmt(entitlementBadge.pays, { amount: formatHalalas(due.amountHalalas) }) }
        : null;
  }
}

/** The fee due of a ticket detail (`payment_status = due`): the amount for staff, the state only for the driver. */
export function dueOf(t: { payment_status: string; fee_halalas?: number }): FeeDue {
  if (t.payment_status !== 'due') return null;
  return { amountHalalas: t.fee_halalas ?? null };
}
