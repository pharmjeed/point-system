import type { LucideIcon } from 'lucide-react';
import { NavLink } from 'react-router';
import { nav } from '@/i18n/ar';
import { cx } from '@/lib/cx';
import { Icon } from './Icon';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  badge?: string | number;
  /** Match the path exactly (e.g. the driver home `/d`). */
  end?: boolean;
}

export interface BottomNavProps {
  items: NavItem[];
  label?: string;
}

/**
 * Bottom navigation (03 §3.2): icon + text, active item in --pt-primary-text and weight 700.
 * Driver: exactly three destinations; staff below 1024px: the four destinations (02 §1.4).
 */
export function BottomNav({ items, label = nav.mainNav }: BottomNavProps) {
  return (
    <nav className="pt-bottomnav" aria-label={label}>
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) => cx('pt-bottomnav__item', isActive && 'is-active')}
        >
          <span className="pt-bottomnav__icon">
            <Icon icon={item.icon} />
            {item.badge !== undefined ? <span className="pt-bottomnav__badge">{item.badge}</span> : null}
          </span>
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
