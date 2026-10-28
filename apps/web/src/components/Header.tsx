import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { nav } from '@/i18n/ar';
import { IconButton } from './IconButton';

export interface HeaderProps {
  title: string;
  /** Shows «‹ رجوع»; the arrow is mirrored so it points to the inline start in RTL. */
  onBack?: () => void;
  actions?: ReactNode;
}

/** Page header with back (02 §9.2 `Header`, D-02). */
export function Header({ title, onBack, actions }: HeaderProps) {
  return (
    <header className="pt-header">
      {onBack ? <IconButton icon={ArrowLeft} label={nav.back} directional onClick={onBack} /> : null}
      <h1 className="pt-header__title">{title}</h1>
      {actions ? <div className="ms-auto flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}
