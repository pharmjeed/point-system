import type { PaymentMethod, PricingMode, VenueSettings } from '@point/shared';
import type { FieldIssue } from './errors.js';

/**
 * Event pricing (13 §3, 06 `ck_events_*`): `included` ⇒ fee 0, `per_vehicle` ⇒ fee > 0, the payment methods a
 * non-empty subset of cash/pos without repeats. Changes apply to new tickets only: every ticket keeps the snapshot
 * taken at intake (DEC-43), so pricing stays editable while the event is draft or open.
 */
export interface EventPricing {
  pricing_mode: PricingMode;
  fee_halalas: number;
  allowed_payment_methods: PaymentMethod[];
}

export function pricingIssues(p: EventPricing): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (p.pricing_mode === 'included' && p.fee_halalas !== 0) {
    issues.push({
      field: 'fee_halalas',
      issue: 'must_be_zero_when_included',
      message_ar: 'الحفل المشمول لا يحمل رسومًا؛ اجعل المبلغ صفرًا.',
    });
  }
  if (p.pricing_mode === 'per_vehicle' && !(p.fee_halalas > 0)) {
    issues.push({
      field: 'fee_halalas',
      issue: 'positive_required_when_per_vehicle',
      message_ar: 'حدّد رسومًا أكبر من صفر للحفل برسوم لكل مركبة.',
    });
  }
  if (p.allowed_payment_methods.length === 0) {
    issues.push({
      field: 'allowed_payment_methods',
      issue: 'required',
      message_ar: 'اختر وسيلة تحصيل واحدة على الأقل.',
    });
  } else if (new Set(p.allowed_payment_methods).size !== p.allowed_payment_methods.length) {
    issues.push({
      field: 'allowed_payment_methods',
      issue: 'duplicate',
      message_ar: 'لا تكرر وسيلة التحصيل.',
    });
  }
  return issues;
}

/**
 * Pricing of a new event: `pricing_mode` comes from the request (required by 07), the fee and the methods default to
 * the venue settings `pricing.*` (13 §3, canon §12). The settings schema guarantees `default_fee_halalas` is 0 unless
 * `default_mode` is `per_vehicle`, so a `per_vehicle` event without a fee in a venue whose default is `included`
 * stays at 0 and is rejected (PNT-019 AC1).
 */
export function newEventPricing(
  input: { pricing_mode: PricingMode; fee_halalas?: number; allowed_payment_methods?: PaymentMethod[] },
  settings: Pick<VenueSettings, 'pricing'>,
): EventPricing {
  return {
    pricing_mode: input.pricing_mode,
    fee_halalas:
      input.fee_halalas ?? (input.pricing_mode === 'per_vehicle' ? settings.pricing.default_fee_halalas : 0),
    allowed_payment_methods: input.allowed_payment_methods ?? [...settings.pricing.allowed_methods],
  };
}

/** Pricing after a PATCH: the stored values overlaid with the fields present in the request. */
export function mergedPricing(
  current: EventPricing,
  patch: { pricing_mode?: PricingMode; fee_halalas?: number; allowed_payment_methods?: PaymentMethod[] },
): EventPricing {
  return {
    pricing_mode: patch.pricing_mode ?? current.pricing_mode,
    fee_halalas: patch.fee_halalas ?? current.fee_halalas,
    allowed_payment_methods: patch.allowed_payment_methods ?? current.allowed_payment_methods,
  };
}

/** `ends_at` before `starts_at` is rejected (both optional). */
export function scheduleIssues(startsAt: string | null | undefined, endsAt: string | null | undefined) {
  const issues: FieldIssue[] = [];
  if (startsAt && endsAt && new Date(endsAt).getTime() < new Date(startsAt).getTime()) {
    issues.push({
      field: 'ends_at',
      issue: 'before_starts_at',
      message_ar: 'وقت النهاية يسبق وقت البداية.',
    });
  }
  return issues;
}
