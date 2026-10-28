import { ChevronRight, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { cx } from '@/lib/cx';
import { Icon } from './Icon';

export interface ListItemProps {
  title: ReactNode;
  meta?: ReactNode;
  icon?: LucideIcon;
  /** Usually a StatusChip. */
  trailing?: ReactNode;
  /** Shows the forward chevron (mirrored in RTL so it points to the inline end). */
  chevron?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  /** Renders a router link instead of a button. */
  to?: string;
}

/** List row ≥64px: icon, title, meta, trailing element and a direction-aware chevron (03 §3.4). */
export function ListItem({ title, meta, icon, trailing, chevron, disabled, onClick, to }: ListItemProps) {
  const interactive = Boolean(onClick || to);
  const showChevron = chevron ?? interactive;
  const body = (
    <>
      {icon ? (
        <span className="pt-listitem__icon">
          <Icon icon={icon} />
        </span>
      ) : null}
      <span className="pt-listitem__body">
        <span className="pt-listitem__title">{title}</span>
        {meta ? <span className="pt-listitem__meta">{meta}</span> : null}
      </span>
      {trailing ? <span className="pt-listitem__trail">{trailing}</span> : null}
      {showChevron ? <Icon icon={ChevronRight} size={20} directional className="pt-listitem__chev" /> : null}
    </>
  );
  const className = cx('pt-listitem', disabled && 'is-disabled');
  if (to && !disabled) {
    return (
      <Link to={to} className={className}>
        {body}
      </Link>
    );
  }
  if (interactive) {
    return (
      <button type="button" className={className} disabled={disabled} onClick={onClick}>
        {body}
      </button>
    );
  }
  return <div className={className}>{body}</div>;
}
