/**
 * Web stand-in of ./LocationsMap.tsx for the store-screenshot export only (V2-052, DEC-568): react-native-maps has
 * no web build, and `mapAvailable` is false on web, so C-07 shows its list (the accessible path, DEC-506).
 */
import type { MapPin } from '../features/locations';

export function LocationsMap(_props: {
  pins: readonly MapPin[];
  label: string;
  onOpen: (venueId: string) => void;
}) {
  return null;
}
