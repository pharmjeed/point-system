import { LogOut } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { nav } from '@/i18n/ar';
import { cx } from '@/lib/cx';
import type { NavItem } from './BottomNav';
import { Icon } from './Icon';
import { Logo } from './Logo';

export interface SideNavProps {
  items: NavItem[];
  /** Brand name for the logo's accessible name. */
  brandName: string;
  onLogout?: () => void;
  footer?: ReactNode;
}

/**
 * Supervisor/admin navigation from 1024px (03 §3.2): horizontal lockup on top, the four destinations
 * (+ «الإدارة» when permitted), active item on --pt-primary-subtle with --pt-text (not primary-text:
 * 4.36:1 in dark, design system note).
 */
export function SideNav({ items, brandName, onLogout, footer }: SideNavProps) {
  return (
    <nav className="pt-sidenav" aria-label={nav.sideNav}>
      <div className="pt-sidenav__logo">
        <Logo variant="lockup-rtl" height={32} alt={brandName} />
      </div>
      <ul>
        {items.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.end}
              className={({ isActive }) => cx('pt-sidenav__item', isActive && 'is-active')}
            >
              <Icon icon={item.icon} />
              <span>{item.label}</span>
              {item.badge ? <span className="pt-sidenav__count">{item.badge}</span> : null}
            </NavLink>
          </li>
        ))}
      </ul>
      <div className="pt-sidenav__foot">
        {footer}
        {onLogout ? (
          <button type="button" className="pt-sidenav__item" onClick={onLogout}>
            <Icon icon={LogOut} />
            <span>{nav.logout}</span>
          </button>
        ) : null}
      </div>
    </nav>
  );
}
