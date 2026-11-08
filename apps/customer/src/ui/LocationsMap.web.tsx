/**
 * The e2e web export (V2-018, DEC-551) resolves this file instead of ./LocationsMap.tsx: react-native-maps is native
 * only (it throws when imported on web), and `mapAvailable('web', …)` is false, so C-07 never mounts a map there and
 * keeps its list — the accessible path to every location. The map itself is checked on devices (Maestro, DEC-553).
 */
import type { MapPin } from '../features/locations';

export function LocationsMap(_props: {
  pins: readonly MapPin[];
  label: string;
  onOpen: (venueId: string) => void;
}) {
  return null;
}
