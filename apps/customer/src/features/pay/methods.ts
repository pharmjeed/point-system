/**
 * C-18 وسائل الدفع and the saved cards of the pay sheet (V2-023, DEC-524), pure: a card is shown by its network,
 * last four digits and expiry only (the token never reaches the app).
 */
import type { CustomerPaymentMethod } from '@point/shared/customer';
import { ApiError } from '../../api/errors';
import { isolate, type Dictionary } from '../../i18n';

export interface CardRowView {
  id: string;
  title: string;
  expires: string | null;
  isDefault: boolean;
}

export function brandName(brand: string | null, dict: Dictionary): string {
  const names = dict.paymentMethods.brands as Readonly<Record<string, string>>;
  return (brand && names[brand]) || names.other || '';
}

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_m, k: string) => values[k] ?? '');

export function cardRow(c: CustomerPaymentMethod, dict: Dictionary): CardRowView {
  return {
    id: c.id,
    title: fill(dict.paymentMethods.card, {
      brand: brandName(c.brand, dict),
      last4: isolate(c.last4 ?? '••••'),
    }),
    expires:
      c.expires_month && c.expires_year
        ? fill(dict.paymentMethods.expires, {
            month: String(c.expires_month).padStart(2, '0'),
            year: String(c.expires_year % 100).padStart(2, '0'),
          })
        : null,
    isDefault: c.is_default,
  };
}

/** The default card first, then the newest (the server's order; kept here for the fake and stale lists). */
export function orderCards(cards: readonly CustomerPaymentMethod[]): CustomerPaymentMethod[] {
  return [...cards].sort(
    (a, b) => Number(b.is_default) - Number(a.is_default) || b.created_at.localeCompare(a.created_at),
  );
}

/** A card the server no longer has (removed on another device): the list is reloaded. */
export const cardGone = (e: unknown): boolean => e instanceof ApiError && e.code === 'RESOURCE_NOT_FOUND';

/** The «حفظ البطاقة» version the server asks for when the text changed (CUSTOMER_CONSENT_VERSION_STALE). */
export function consentVersionFrom(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  if (e.code !== 'CUSTOMER_CONSENT_REQUIRED' && e.code !== 'CUSTOMER_CONSENT_VERSION_STALE') return null;
  const v = (e.details as Record<string, unknown>).current_version;
  return typeof v === 'string' ? v : null;
}
