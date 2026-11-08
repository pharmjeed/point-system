import type { LucideIcon } from 'lucide-react';
import { cx } from '@/lib/cx';

export interface IconProps {
  icon: LucideIcon;
  /** 24 by default, 20 inside medium buttons, 16 in chips (03 §2.6). */
  size?: number;
  /** Gives the icon `role="img"`; without it the icon is decorative (`aria-hidden`). */
  label?: string;
  spin?: boolean;
  /** Mirror under `dir="rtl"`: arrows, chevrons, "back" (03 §2.6, 02 §7.2). */
  directional?: boolean;
  className?: string;
}

/** Lucide icon, stroke 2, colour = currentColor (03 §2.6). */
export function Icon({ icon: Glyph, size = 24, label, spin, directional, className }: IconProps) {
  return (
    <Glyph
      size={size}
      strokeWidth={2}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      focusable={false}
      className={cx('pt-icon', directional && 'pt-icon--dir', spin && 'pt-icon--spin', className)}
    />
  );
}
