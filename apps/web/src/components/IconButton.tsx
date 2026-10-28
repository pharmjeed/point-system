import { LoaderCircle, type LucideIcon } from 'lucide-react';
import type { ButtonHTMLAttributes, Ref } from 'react';
import { cx } from '@/lib/cx';
import { Icon } from './Icon';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: LucideIcon;
  /** Mandatory Arabic accessible name (also the tooltip). */
  label: string;
  variant?: 'ghost' | 'secondary' | 'primary';
  badge?: string | number;
  loading?: boolean;
  size?: 'sm' | 'md';
  directional?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/** Icon-only button, 44×44 touch target, for close / search / refresh only (03 §3.1). */
export function IconButton({
  icon,
  label,
  variant = 'ghost',
  badge,
  loading,
  size = 'md',
  directional,
  disabled,
  className,
  type = 'button',
  ref,
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={cx('pt-iconbtn', `pt-iconbtn--${variant}`, className)}
      aria-label={label}
      title={label}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      <Icon
        icon={loading ? LoaderCircle : icon}
        size={size === 'sm' ? 20 : 24}
        spin={loading}
        directional={!loading && directional}
      />
      {badge !== undefined && badge !== '' ? <span className="pt-iconbtn__badge">{badge}</span> : null}
    </button>
  );
}
