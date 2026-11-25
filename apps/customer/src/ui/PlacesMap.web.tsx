/**
 * Web stand-in of ./PlacesMap.tsx for the one web export (e2e and store pictures, DEC-551/DEC-568):
 * react-native-maps has no web build, so the web always draws the map (`PlacesDrawnMap`, DEC-639).
 */
import type { PlaceCard } from '../features/places';
import { PlacesDrawnMap } from './PlacesDrawnMap';

export function PlacesMap(props: {
  places: readonly PlaceCard[];
  selected: string | null;
  onSelect: (id: string) => void;
  label: string;
  insets?: { top: number; bottom: number };
}) {
  return <PlacesDrawnMap {...props} />;
}
