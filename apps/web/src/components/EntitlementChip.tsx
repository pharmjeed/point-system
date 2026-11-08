import { BadgeCheck, Banknote } from 'lucide-react';
import type { EntitlementBadge } from '@/features/common/entitlement';
import { Icon } from './Icon';

/**
 * The entitlement badge (O-02, V2-014): text + icon + colour, never colour alone (03 §3.3), in the chip shape of
 * StatusChip. Semantic pairs from brand/tokens: success for «مشمول», warning for «يدفع X».
 */
export function EntitlementChip({ badge, size = 'md' }: { badge: EntitlementBadge; size?: 'sm' | 'md' }) {
  const included = badge.tone === 'included';
  return (
    <span
      className={size === 'sm' ? 'pt-chip pt-chip--sm' : 'pt-chip'}
      data-entitlement={badge.tone}
      style={{
        background: included ? 'var(--pt-success-subtle)' : 'var(--pt-warning-subtle)',
        color: included ? 'var(--pt-success-text)' : 'var(--pt-warning-text)',
      }}
    >
      <Icon icon={included ? BadgeCheck : Banknote} size={16} />
      <span>{badge.text}</span>
    </span>
  );
}
