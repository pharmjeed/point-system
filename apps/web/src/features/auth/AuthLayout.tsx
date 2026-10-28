import type { ReactNode } from 'react';
import { Logo } from '@/components';
import { useBrand } from '@/hooks/useMe';

/** Shared frame of D-01, D-02 (first login) and S-01: stacked logo centred, one column ≤480px. */
export function AuthLayout({
  title,
  children,
  banner,
}: {
  title: string;
  children: ReactNode;
  banner?: ReactNode;
}) {
  const brand = useBrand();
  return (
    <div className="pt-auth">
      {banner}
      <main className="pt-auth__main" id="main">
        <div className="pt-auth__logo">
          <Logo variant="stacked" height={120} alt={brand.staffNameAr} />
        </div>
        <h1 className="pt-page-title text-center">{title}</h1>
        {children}
      </main>
    </div>
  );
}
