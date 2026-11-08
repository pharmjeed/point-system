import { Construction, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { EmptyState } from '@/components';
import { ui } from '@/i18n/ar';

/** A destination that exists in the shell before its ticket builds it (02 §9.1 routes). */
export function PlaceholderPage({
  title,
  icon = Construction,
  children,
}: {
  title: string;
  icon?: LucideIcon;
  children?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="page-title">
      <h1 className="pt-page-title" id="page-title">
        {title}
      </h1>
      <EmptyState icon={icon} title={ui.placeholderTitle} body={ui.placeholderBody} />
      {children}
    </section>
  );
}
