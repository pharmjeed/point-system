/**
 * Web stand-in of ./LocationsMap.tsx for the one web export (`export:web`: the e2e suite V2-018 and the store
 * screenshots V2-052; DEC-551 as unified in DEC-568): react-native-maps has no web build (it throws when imported),
 * and `mapAvailable('web', …)` is false, so C-07 never mounts a map there and keeps its list — the accessible path
 * to every location (DEC-506). The map itself is checked on devices (Maestro, DEC-553).
 */
import type { MapPin } from '../features/locations';

export function LocationsMap(_props: {
  pins: readonly MapPin[];
  label: string;
  onOpen: (venueId: string) => void;
}) {
  return null;
}
