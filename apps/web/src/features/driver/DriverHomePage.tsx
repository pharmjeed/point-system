import { BellRing } from 'lucide-react';
import { EmptyState } from '@/components';
import { d04, nav } from '@/i18n/ar';

/**
 * D-04 shell (PNT-021). The working home — intake button, current/next task, the single OfferCard — is
 * built in PNT-035/PNT-068 on GET /v1/me/home; until then the empty request state of D-04 is shown.
 */
export function DriverHomePage() {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="page-title">
      <h1 className="pt-sr" id="page-title">
        {nav.home}
      </h1>
      <h2 className="pt-section-title">{d04.offerSection}</h2>
      <EmptyState icon={BellRing} title={d04.emptyTitle} body={d04.emptyBody} />
    </section>
  );
}
