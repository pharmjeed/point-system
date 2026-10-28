import { Car } from 'lucide-react';
import { PlaceholderPage } from '@/features/common/PlaceholderPage';
import { d12 } from '@/i18n/ar';

/** D-12 shell; the search and list arrive with PNT-069. */
export function VehiclesPage() {
  return <PlaceholderPage title={d12.title} icon={Car} />;
}
