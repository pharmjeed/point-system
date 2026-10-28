import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '@/lib/cx';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  elevated?: boolean;
  dimmed?: boolean;
  tone?: 'danger';
  as?: 'div' | 'section' | 'article' | 'li';
  children: ReactNode;
}

/** Surface, border always (both themes, DEC-49c), radius lg, padding 16, shadow sm (03 §3.4). */
export function Card({ elevated, dimmed, tone, as: Tag = 'div', className, children, ...rest }: CardProps) {
  return (
    <Tag
      {...rest}
      className={cx(
        'pt-card',
        elevated && 'pt-card--elevated',
        dimmed && 'pt-card--dimmed',
        tone && `pt-card--${tone}`,
        className,
      )}
    >
      {children}
    </Tag>
  );
}
