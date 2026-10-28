import { BellRing, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: ReactNode;
  body?: ReactNode;
  actionLabel?: string;
  actionIcon?: LucideIcon;
  loading?: boolean;
  onAction?: () => void | Promise<unknown>;
  children?: ReactNode;
}

/** Icon + sentence + optional action (03 §3.14), e.g. «لا توجد طلبات إحضار الآن». */
export function EmptyState({
  icon = BellRing,
  title,
  body,
  actionLabel,
  actionIcon,
  loading,
  onAction,
  children,
}: EmptyStateProps) {
  return (
    <div className="pt-empty">
      <span className="pt-empty__icon">
        <Icon icon={icon} size={28} />
      </span>
      <p className="pt-empty__title">{title}</p>
      {body ? <p className="pt-empty__body">{body}</p> : null}
      {actionLabel && onAction ? (
        <Button variant="secondary" onClick={onAction} iconStart={actionIcon} loading={loading}>
          {actionLabel}
        </Button>
      ) : null}
      {children}
    </div>
  );
}
